import { ManualTickSource } from "@audiorective/clock";
import type { SoundFactory } from "@audiorective/core";
import { afterEach, describe, expect, test, vi } from "vitest";
import { Project, Workspace } from "../src";
import { SamplerSink } from "../src/midi-sink";
import { fillSession } from "./session-slots";

/**
 * Controllers and the Session. A Session MIDI clip sends its own controllers; the pedal a track's Arrangement pressed
 * before a Session clip took the track over must still be lifted when playback stops, pauses or seeks, because the reset follows the device, not the source of the message.
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

type Message = { data: number[]; when: number };

function recordSink(): Message[] {
  const recording: Message[] = [];
  const original = SamplerSink.prototype.scheduleMidi;
  vi.spyOn(SamplerSink.prototype, "scheduleMidi").mockImplementation(function (this: SamplerSink, data, when) {
    recording.push({ data: [...data], when });
    return original.call(this, data, when);
  });
  const noteOn = SamplerSink.prototype.noteOn;
  vi.spyOn(SamplerSink.prototype, "noteOn").mockImplementation(function (this: SamplerSink, note, options) {
    recording.push({ data: [0x90, note], when: options?.when ?? -1 });
    return noteOn.call(this, note, options);
  });
  return recording;
}

/** 120 BPM: a beat is 0.5 s. The Arrangement presses the pedal at beat 1 (0.5 s); the Session clip (one note, and a pedal event of its own) takes the track at 0.6 s. */
function song() {
  const project = new Project({ bpm: 120 });
  const track = project.addTrack("Keys", "midi");
  project.addMidiClip(
    track.id,
    { duration: 8, notes: [{ pitch: 48, velocity: 1, start: 0, duration: 0.25 }], events: [{ time: 1, data: Uint8Array.of(0xb0, 64, 127) }] },
    0,
  );
  fillSession(project, track.id, [
    { duration: 4, notes: [{ pitch: 60, velocity: 1, start: 0, duration: 0.25 }], events: [{ time: 0.25, data: Uint8Array.of(0xb0, 64, 127) }] },
  ]);
  cleanups.push(() => project.dispose());
  return { project, track, instruments: { [track.id]: { sound: click } } };
}

async function play(
  project: Project,
  instruments: Record<string, { sound: SoundFactory }>,
  seconds: number,
  actions: Array<{ at: number; run: (w: Workspace) => void }>,
) {
  const frames = Math.round(seconds * RATE);
  const context = new OfflineAudioContext(2, frames, RATE);
  const ticks = new ManualTickSource();
  const workspace = await Workspace.create(context as unknown as AudioContext, project, {
    destination: context.destination,
    tickSource: ticks,
    workletUrl: worklet,
    instruments,
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
  workspace.dispose();
}

const text = (sent: Message[]) => sent.map(({ data }) => data.join(","));
const launch = (project: Project) => (workspace: Workspace) =>
  workspace.cells.session.value.tracks[project.tracks[0]!.id]!.clips[0]!.launch({ quantize: "none" });

describe("a Session clip does not leave the pedal down", () => {
  test.each(["pause", "stop"] as const)(
    "%s lifts the pedal the Arrangement pressed before the Session clip took the track",
    async (how) => {
      const { project, instruments } = song();
      const sent = recordSink();
      let mark = 0;
      await play(project, instruments, 1.6, [
        { at: 0.6, run: launch(project) },
        {
          at: 1.0,
          run: (workspace) => {
            mark = sent.length;
            workspace[how]();
          },
        },
      ]);
      expect(text(sent.slice(0, mark))).toContain("176,64,127");
      expect(text(sent.slice(0, mark)).filter((line) => line === "144,60").length).toBeGreaterThan(0);
      // the Session clip's own pedal (a press at 0.725 s) and the Arrangement's are both put back, so the lift may arrive from each
      expect([...new Set(text(sent.slice(mark)).filter((line) => line === "176,64,0"))]).toEqual(["176,64,0"]);
      // Nothing rings on: only releases and controller rests follow the stop.
      expect(text(sent.slice(mark)).filter((line) => line.startsWith("144,"))).toEqual([]);
    },
    60_000,
  );

  test("the pedal event of a Session clip's own content is sent, and a stop lifts it", async () => {
    const { project, instruments } = song();
    project.removeClip(project.tracks[0]!.clips[0]!.id);
    const sent = recordSink();
    let mark = 0;
    await play(project, instruments, 1.4, [
      { at: 0, run: launch(project) },
      {
        at: 0.8,
        run: (workspace) => {
          mark = sent.length;
          workspace.stop();
        },
      },
    ]);
    expect(text(sent.slice(0, mark))).toContain("176,64,127");
    expect(text(sent.slice(mark)).filter((line) => line.startsWith("176,64") || line.startsWith("144,"))).toEqual(["176,64,0"]);
  }, 60_000);
});
