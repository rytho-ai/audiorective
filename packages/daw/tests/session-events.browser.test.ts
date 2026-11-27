import { ManualTickSource } from "@audiorective/clock";
import type { SoundFactory } from "@audiorective/core";
import { afterEach, describe, expect, test, vi } from "vitest";
import { Project, Workspace, renderSession, sessionFor, type ProjectMidiData } from "../src";
import { SamplerSink } from "../src/midi-sink";
import { fillSession } from "./session-slots";

/**
 * A Session MIDI clip sends its controllers, pitch bend, program changes and pressure exactly as the Arrangement does for the same content:
 * the same messages at the same times in the same order, and nothing is left held when the clip stops.
 */
const RATE = 48_000;
const QUANTUM = 128;
const worklet = "/@fs" + new URL("../../host/dist/webclap-worklet.js", import.meta.url).pathname.replace(/^\/@fs/, "");
const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const click: SoundFactory = (context) => {
  const osc = new OscillatorNode(context, { frequency: 1000 });
  const gain = new GainNode(context, { gain: 0.5 });
  osc.connect(gain);
  return { output: gain, sources: [osc], duration: 0.02 };
};

/** A call that was withdrawn before it took effect is not one the device acted on; `live` lists the rest. */
type Message = { data: number[]; when: number; withdrawn?: boolean };

/**
 * Every message a device is sent, in call order: note-ons and note-offs as `[0x90, pitch]` and `[0x80, pitch]`, the rest as raw bytes.
 * A message withdrawn before its time (a refill of the look-ahead retracts and re-sends it) is marked `withdrawn`.
 */
function recordSink(): Message[] {
  vi.restoreAllMocks();
  const recording: Message[] = [];
  const track = (sink: SamplerSink, entry: Message, event: unknown) => {
    recording.push(entry);
    const real = event as { cancel(time?: number): void; onEnded(listener: () => void): void };
    return {
      cancel(time?: number) {
        const now = (sink as unknown as { context: BaseAudioContext }).context.currentTime;
        if ((time ?? now) <= entry.when + 1e-9) entry.withdrawn = true;
        real.cancel(time);
      },
      onEnded: (listener: () => void) => real.onEnded(listener),
    };
  };
  const original = SamplerSink.prototype.scheduleMidi;
  vi.spyOn(SamplerSink.prototype, "scheduleMidi").mockImplementation(function (this: SamplerSink, data, when) {
    const event = original.call(this, data, when);
    const status = data[0] & 0xf0;
    return status === 0x80 || status === 0x90 ? event : track(this, { data: [...data], when }, event);
  });
  const noteOn = SamplerSink.prototype.noteOn;
  vi.spyOn(SamplerSink.prototype, "noteOn").mockImplementation(function (this: SamplerSink, note, options) {
    return track(this, { data: [0x90, note], when: options?.when ?? -1 }, noteOn.call(this, note, options));
  });
  const noteOff = SamplerSink.prototype.noteOff;
  vi.spyOn(SamplerSink.prototype, "noteOff").mockImplementation(function (this: SamplerSink, note, when, since) {
    return track(this, { data: [0x80, note], when: when ?? -1 }, noteOff.call(this, note, when, since));
  });
  return recording;
}

const cc = (time: number, controller: number, value: number) => ({ time, data: Uint8Array.of(0xb0, controller, value) });
/** A clip with a pedal, a mod wheel ramp, a pitch bend and a program change, four beats long. */
const content = (extra: Partial<ProjectMidiData> = {}): ProjectMidiData => ({
  duration: 4,
  notes: [
    { pitch: 60, velocity: 1, start: 0, duration: 0.5 },
    { pitch: 64, velocity: 1, start: 2, duration: 0.5 },
  ],
  events: [
    cc(0.5, 64, 127),
    cc(1, 1, 20),
    { time: 1.25, data: Uint8Array.of(0xe0, 0, 100) },
    cc(1.5, 1, 60),
    { time: 2, data: Uint8Array.of(0xc0, 7) },
    { time: 2.5, data: Uint8Array.of(0xd0, 33) },
    cc(3, 64, 0),
  ],
  ...extra,
});

type Action = { at: number; run: (workspace: Workspace) => void };

async function play(project: Project, seconds: number, actions: Action[] = [], after?: (workspace: Workspace) => Promise<void>) {
  const frames = Math.round(seconds * RATE);
  const context = new OfflineAudioContext(2, frames, RATE);
  const ticks = new ManualTickSource();
  const workspace = await Workspace.create(context as unknown as AudioContext, project, {
    destination: context.destination,
    tickSource: ticks,
    workletUrl: worklet,
    instruments: Object.fromEntries(project.tracks.filter((t) => t.kind === "midi").map((t) => [t.id, { sound: click }])),
    arrangement: project.tracks.some((track) => track.clips.length > 0),
  });
  const pending = [...actions].sort((a, b) => a.at - b.at);
  await workspace.play();
  ticks.tick();
  await workspace.renderSettled();
  let index = 1;
  let previous = 0;
  const next = () => {
    previous = Math.max(Math.ceil((index++ * 0.025 * RATE) / QUANTUM) * QUANTUM, previous + QUANTUM);
    return previous < frames ? previous : undefined;
  };
  let stop = next();
  let suspended = stop === undefined ? undefined : context.suspend((stop - QUANTUM / 2) / RATE);
  const rendering = context.startRendering();
  while (stop !== undefined && suspended) {
    await suspended;
    while (pending.length && pending[0]!.at <= stop / RATE) pending.shift()!.run(workspace);
    ticks.tick();
    await workspace.renderSettled();
    stop = next();
    suspended = stop === undefined ? undefined : context.suspend((stop - QUANTUM / 2) / RATE);
    await context.resume();
  }
  await rendering;
  await after?.(workspace);
  workspace.dispose();
}

const launch =
  (project: Project, scene = 0) =>
  (workspace: Workspace) =>
    workspace.cells.session.value.tracks[project.tracks[0]!.id]!.clips[scene]!.launch({ quantize: "none" });

/** The messages of one run as `data@seconds after the first note-on`, in time order (call order breaks ties). */
function relative(all: readonly Message[], until = 1.75): string[] {
  // A refill of the look-ahead (a clip taking the track over) may send a note again at the same time: the device then holds one of them, the later call.
  const isNote = ({ data }: Message) => (data[0] & 0xf0) === 0x80 || (data[0] & 0xf0) === 0x90;
  const sent = all.filter(
    (message, index) =>
      !message.withdrawn &&
      !(
        isNote(message) &&
        all.some((other, at) => at > index && !other.withdrawn && other.when === message.when && other.data.join() === message.data.join())
      ),
  );
  const origin = sent.find((m) => m.data[0] === 0x90)!.when;
  return (
    sent
      // the all-notes-off the Workspace sends on every channel when a Session clip takes the track is not clip content
      .filter(({ data }) => !((data[0] & 0xf0) === 0xb0 && data[1] === 123))
      .filter(({ when }) => when - origin < until)
      .map((message, index) => ({ ...message, index }))
      .sort((a, b) => a.when - b.when || a.index - b.index)
      .map(({ data, when }) => `${data.join(",")}@${(when - origin).toFixed(4)}`)
  );
}

function sessionProject(data: ProjectMidiData | ProjectMidiData[]) {
  const project = new Project({ bpm: 120 });
  const track = project.addTrack("Keys", "midi");
  fillSession(project, track.id, Array.isArray(data) ? data : [data]);
  cleanups.push(() => project.dispose());
  return project;
}

function arrangementProject(data: ProjectMidiData) {
  const project = new Project({ bpm: 120 });
  const track = project.addTrack("Keys", "midi");
  project.addMidiClip(track.id, data, 0);
  cleanups.push(() => project.dispose());
  return project;
}

describe("a Session clip sends the messages the Arrangement sends", () => {
  test("live Session, renderSession and the Arrangement send the same messages in the same order at the same times", async () => {
    const live = recordSink();
    const session = sessionProject(content());
    let rendered: Message[] = [];
    await play(session, 1.95, [{ at: 0.05, run: launch(session) }], async (workspace) => {
      const before = live.length;
      const result = await renderSession(workspace, { scenes: [sessionFor(session).scenes[0]!.id], tailSeconds: 0 });
      expect(result.status).toBe("rendered");
      rendered = live.splice(before);
    });
    const onArrangement = recordSink();
    await play(arrangementProject(content()), 1.95);

    const expected = relative(onArrangement);
    expect(expected).toEqual([
      "144,60@0.0000",
      "128,60@0.2500",
      "176,64,127@0.2500",
      "176,1,20@0.5000",
      "224,0,100@0.6250",
      "176,1,60@0.7500",
      "192,7@1.0000",
      "144,64@1.0000",
      "128,64@1.2500",
      "208,33@1.2500",
      "176,64,0@1.5000",
    ]);
    expect(relative(live)).toEqual(expected);
    expect(relative(rendered)).toEqual(expected);
  }, 60_000);

  test("a clip that starts inside its content carries the latest controller values to every pass and releases a held pedal at each pass end", async () => {
    // Content beat 1 is the pass start: before it the pedal went down and the mod wheel moved twice. The pedal is still down at the pass end (content beat 3).
    const data: ProjectMidiData = {
      duration: 2,
      sourceOffset: 1,
      notes: [{ pitch: 60, velocity: 1, start: 1, duration: 0.5 }],
      events: [cc(0.25, 1, 10), cc(0.5, 64, 127), cc(0.75, 1, 40), cc(1.5, 1, 90), cc(2, 64, 127)],
    };
    const live = recordSink();
    const session = sessionProject(data);
    let rendered: Message[] = [];
    await play(session, 3.2, [{ at: 0.05, run: launch(session) }], async (workspace) => {
      const before = live.length;
      const scene = sessionFor(session).scenes[0]!.id;
      const result = await renderSession(workspace, { scenes: [scene, scene, scene], tailSeconds: 0 });
      expect(result.status).toBe("rendered");
      rendered = live.splice(before);
    });
    const text = relative(
      live.filter((m) => m.data[0] !== 0x80),
      1.9,
    );
    // Pass length 2 beats = 1 s. Each pass: the carried values at its start, the ramp point, the pedal press at content beat 2, the release at the pass end.
    expect(text.slice(0, 7)).toEqual([
      "176,64,127@0.0000",
      "176,1,40@0.0000",
      "144,60@0.0000",
      "176,1,90@0.2500",
      "176,64,127@0.5000",
      "176,64,0@1.0000",
      "176,64,127@1.0000",
    ]);
    expect(relative(rendered.filter((m) => m.data[0] !== 0x80)).slice(0, 7)).toEqual(text.slice(0, 7));
  }, 60_000);

  test("stopping with the pedal, bend and pressure moved puts each back; a message still ahead is not sent", async () => {
    const live = recordSink();
    const session = sessionProject(content());
    let mark = 0;
    await play(session, 2.2, [
      { at: 0.05, run: launch(session) },
      {
        at: 0.9,
        run: (workspace) => {
          mark = live.length;
          workspace.cells.session.value.tracks[session.tracks[0]!.id]!.stop({ quantize: "none" });
        },
      },
    ]);
    const tail = live.slice(mark).map(({ data }) => data.join(","));
    // At 0.9 s the pedal is down, the mod wheel is at 20 and the bend at 100 (the second mod wheel point is 0.05 s away at 0.8 s after start); each goes back to rest.
    expect(tail).toContain("176,64,0");
    expect(tail).toContain("176,1,0");
    expect(tail).toContain("224,0,64");
    expect(live.map(({ data }) => data.join(",")).filter((line) => line === "192,7")).toEqual([]);
  }, 60_000);
});
