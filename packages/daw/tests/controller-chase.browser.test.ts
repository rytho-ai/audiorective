import { ManualTickSource } from "@audiorective/clock";
import type { SoundFactory } from "@audiorective/core";
import { afterEach, describe, expect, test, vi } from "vitest";
import { Project, Workspace, renderMixRange, type ControllerLane, type WorkspaceOptions } from "../src";
import { SamplerSink } from "../src/midi-sink";

/**
 * Controller chase: a start, a seek, a loop wrap or the arrangement switched back on sends what the position needs (the song's own controller state), a
 * stop or pause rests only the performance controllers, and a controller held on both sides of a seek is not lifted.
 */
const RATE = 48_000;
const QUANTUM = 128;
const worklet = "/@fs" + new URL("../../host/dist/webclap-worklet.js", import.meta.url).pathname.replace(/^\/@fs/, "");
const cleanups: Array<() => unknown> = [];
let installed = false;
afterEach(async () => {
  vi.restoreAllMocks();
  installed = false;
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const click: SoundFactory = (context) => {
  const osc = new OscillatorNode(context, { frequency: 1000 });
  const gain = new GainNode(context, { gain: 0.5 });
  osc.connect(gain);
  return { output: gain, sources: [osc], duration: 0.02 };
};

type Message = { data: number[]; when: number };
let recording: Message[] = [];
/** A fresh list of every message (notes included) a recording sink is sent from now on, in call order. */
function recordSink(): Message[] {
  recording = [];
  if (!installed) {
    installed = true;
    const original = SamplerSink.prototype.scheduleMidi;
    vi.spyOn(SamplerSink.prototype, "scheduleMidi").mockImplementation(function (this: SamplerSink, data, when) {
      recording.push({ data: [...data], when });
      return original.call(this, data, when);
    });
  }
  return recording;
}
const text = (message: Message) => message.data.join(",");

const lane = (expression: ControllerLane["expression"], controller: number, points: Array<[number, number]>, channel = 0): ControllerLane => ({
  expression,
  channel,
  controller,
  points: points.map(([time, value]) => ({ time, value, shape: "hold" as const })),
});

/** 120 BPM, so a beat is 0.5 s: a Keys track on the page's own sound. */
function song(
  lanes: ControllerLane[],
  events: Array<{ time: number; data: number[] }> = [],
  notes: Array<{ pitch: number; start: number; duration: number }> = [{ pitch: 60, start: 0, duration: 0.25 }],
) {
  const project = new Project({ bpm: 120 });
  const track = project.addTrack("Keys", "midi");
  project.addMidiClip(
    track.id,
    {
      duration: 8,
      notes: notes.map((note) => ({ velocity: 1, ...note })),
      events: events.map(({ time, data }) => ({ time, data: Uint8Array.from(data) })),
    },
    0,
  );
  for (const item of lanes) project.setControllerLane(track.id, item);
  cleanups.push(() => project.dispose());
  return { project, track, instruments: { [track.id]: { sound: click } } };
}

/** Live-like render: the transport ticks every 25 ms of an offline context, with actions at given seconds. */
async function playLike(
  project: Project,
  seconds: number,
  actions: Array<{ at: number; run: (workspace: Workspace) => void }> = [],
  options: WorkspaceOptions = {},
) {
  const frames = Math.round(seconds * RATE);
  const context = new OfflineAudioContext(2, frames, RATE);
  const ticks = new ManualTickSource();
  const workspace = await Workspace.create(context as unknown as AudioContext, project, {
    destination: context.destination,
    tickSource: ticks,
    workletUrl: worklet,
    ...options,
  });
  const pending = [...actions].sort((a, b) => a.at - b.at);
  while (pending[0]?.at === 0) pending.shift()!.run(workspace);
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
    while (pending.length && pending[0].at <= stop / RATE) pending.shift()!.run(workspace);
    ticks.tick();
    await workspace.renderSettled();
    stop = next();
    suspended = stop === undefined ? undefined : context.suspend((stop - QUANTUM / 2) / RATE);
    await context.resume();
  }
  await rendering;
  workspace.dispose();
}

async function liveWorkspace(project: Project, options: WorkspaceOptions = {}) {
  const context = new AudioContext({ sampleRate: RATE });
  const workspace = await Workspace.create(context, project, { workletUrl: worklet, ...options });
  cleanups.push(async () => {
    workspace.dispose();
    await context.close();
  });
  return workspace;
}

const clipEvents = (events: Array<[number, number[]]>) => events.map(([time, data]) => ({ time, data }));
const controllers = (sent: Message[]) => sent.filter(({ data }) => (data[0] & 0xf0) !== 0x90 && (data[0] & 0xf0) !== 0x80);
const lastOf = (sent: Message[], controller: number) => sent.filter(({ data }) => data[0] === 0xb0 && data[1] === controller).at(-1)?.data[2];

describe("a seek or a start inside a song chases what the song set", () => {
  const imported = clipEvents([
    [0, [0xb0, 7, 60]],
    [0, [0xb0, 10, 20]],
  ]);

  test("a seek past the song's volume and pan leaves them at the song's values, not at the rest values", async () => {
    const { project, instruments } = song([], imported);
    const sent = recordSink();
    await playLike(project, 1.6, [{ at: 0.6, run: (workspace) => workspace.seek(2.5) }], { instruments });
    expect(lastOf(sent, 7)).toBe(60);
    expect(lastOf(sent, 10)).toBe(20);
    expect(controllers(sent).some(({ data }) => text({ data, when: 0 }) === "176,7,100" || text({ data, when: 0 }) === "176,10,64")).toBe(false);
  }, 60_000);

  test("a start at that position sends the same values", async () => {
    const { project, instruments } = song([], imported);
    const sent = recordSink();
    await playLike(project, 0.6, [{ at: 0, run: (workspace) => workspace.seek(2.5) }], { instruments });
    expect(controllers(sent).map(text)).toEqual(["176,7,60", "176,10,20"]);
  }, 60_000);

  test("live from a position and an offline render that starts there send the same messages", async () => {
    const { project, instruments } = song(
      [lane("channelController", 1, [[1, 40]]), lane("pitchBend", 0, [[3, 12000]])],
      clipEvents([
        [0, [0xb0, 101, 0]],
        [0, [0xb0, 100, 0]],
        [0, [0xb0, 6, 12]],
        [0, [0xb0, 7, 60]],
        [0, [0xc0, 9]],
        [1, [0xb0, 64, 127]],
        [2, [0xb0, 10, 20]],
      ]),
      [{ pitch: 60, start: 6, duration: 0.25 }],
    );
    const live = recordSink();
    // beat 6 is 3 s: the song's state there is the volume, pan, RPN, program, pedal and lanes set before it
    await playLike(project, 2.2, [{ at: 0, run: (workspace) => workspace.seek(3) }], { instruments });
    const liveMessages = controllers(live).map(({ data, when }) => `${data.join(",")}@${when.toFixed(5)}`);
    expect(liveMessages.length).toBeGreaterThanOrEqual(8);

    const workspace = await liveWorkspace(project, { instruments });
    const offline = recordSink();
    const range = await renderMixRange(workspace, {
      expectedVersion: project.cells.version.value,
      range: { startBeat: 6, endBeat: 10 },
      prerollSeconds: 0,
    });
    expect(range.status).toBe("rendered");
    const offlineMessages = controllers(offline).map(({ data, when }) => `${data.join(",")}@${when.toFixed(5)}`);
    expect(offlineMessages).toEqual(liveMessages.filter((line) => Number(line.split("@")[1]) < 2 - 1e-9));
  }, 90_000);

  test("switching the arrangement back on after a seek brings the device to the position's state, sending only what differs", async () => {
    const { project, instruments } = song(
      [],
      clipEvents([
        [0, [0xb0, 7, 60]],
        [0.5, [0xb0, 1, 90]],
        [3, [0xb0, 1, 0]],
      ]),
    );
    const sent = recordSink();
    let mark = 0;
    await playLike(
      project,
      1.4,
      [
        { at: 0.6, run: (workspace) => (workspace.arrangement.value = false) },
        { at: 0.7, run: (workspace) => workspace.seek(2) },
        {
          at: 0.8,
          run: (workspace) => {
            mark = sent.length;
            workspace.arrangement.value = true;
          },
        },
      ],
      { instruments },
    );
    const back = controllers(sent.slice(mark)).map(text);
    // the wheel went to 90 at beat 1 and the song set it back to 0 at beat 3, before the seek target at beat 4; the volume is where the song has it
    expect(back).toContain("176,1,0");
    expect(back).not.toContain("176,7,60");
  }, 60_000);
});

describe("only performance controllers rest", () => {
  const rpn = clipEvents([
    [0, [0xb0, 0, 3]],
    [0, [0xb0, 32, 5]],
    [0, [0xb0, 101, 0]],
    [0, [0xb0, 100, 0]],
    [0, [0xb0, 6, 12]],
    [0, [0xb0, 38, 0]],
    [0, [0xb0, 98, 1]],
    [0, [0xb0, 96, 1]],
    [0, [0xb0, 7, 60]],
    [0, [0xb0, 64, 127]],
  ]);
  test.each(["stop", "pause"] as const)(
    "%s keeps the bend range, the bank and the data controllers, and rests volume and pedal",
    async (how) => {
      const { project, instruments } = song([], rpn);
      const sent = recordSink();
      let mark = 0;
      await playLike(
        project,
        1,
        [
          {
            at: 0.4,
            run: (workspace) => {
              mark = sent.length;
              workspace[how]();
            },
          },
        ],
        { instruments },
      );
      expect(controllers(sent.slice(mark)).map(text).sort()).toEqual(["176,64,0", "176,7,100"]);
    },
    60_000,
  );

  test("a seek and the start after it send the RPN values the song needs, once, and no reset", async () => {
    const { project, instruments } = song([], rpn);
    const sent = recordSink();
    await playLike(project, 1, [{ at: 0, run: (workspace) => workspace.seek(1) }], { instruments });
    const rpnMessages = controllers(sent).filter(({ data }) => [0, 6, 32, 38, 96, 98, 100, 101].includes(data[1]));
    expect(rpnMessages.map(text)).toEqual(["176,0,3", "176,32,5", "176,101,0", "176,100,0", "176,6,12", "176,38,0", "176,98,1", "176,96,1"]);
  }, 60_000);
});

describe("a pedal held on both sides of a seek does not dip", () => {
  test("a seek inside the held region sends no pedal-up", async () => {
    const { project, instruments } = song(
      [],
      clipEvents([
        [1, [0xb0, 64, 127]],
        [6, [0xb0, 64, 0]],
      ]),
    );
    const sent = recordSink();
    let mark = 0;
    await playLike(
      project,
      1.6,
      [
        {
          at: 0.9,
          run: (workspace) => {
            mark = sent.length;
            workspace.seek(2.5);
          },
        },
      ],
      { instruments },
    );
    expect(sent.map(text).slice(0, mark)).toContain("176,64,127");
    // the song's own pedal-up at beat 6 is 0.5 s away from the seek target at beat 5; nothing comes up before it
    const after = sent.slice(mark).filter(({ when }) => when < 1.2);
    expect(after.map(text)).not.toContain("176,64,0");
  }, 60_000);

  test("a seek out of the held region lifts the pedal once", async () => {
    const { project, instruments } = song(
      [],
      clipEvents([
        [1, [0xb0, 64, 127]],
        [3, [0xb0, 64, 0]],
      ]),
    );
    const sent = recordSink();
    let mark = 0;
    await playLike(
      project,
      1.6,
      [
        {
          at: 0.9,
          run: (workspace) => {
            mark = sent.length;
            workspace.seek(2.5);
          },
        },
      ],
      { instruments },
    );
    expect(sent.slice(mark).filter((message) => text(message) === "176,64,0").length).toBe(1);
  }, 60_000);
});
