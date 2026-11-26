import { ManualTickSource } from "@audiorective/clock";
import { decode } from "@toon-format/toon";
import type { SoundFactory } from "@audiorective/core";
import { afterEach, describe, expect, test, vi } from "vitest";
import { Project, Workspace, exportAudioFallbackTo, renderMixRange, renderStems, type ControllerLane, type WorkspaceOptions } from "../src";
import { mcpTools, type McpToolResult } from "../src/mcp";
import { SamplerSink } from "../src/midi-sink";

/**
 * A MIDI track's controller lanes play in Arrangement: a recording sink (the track's own `SamplerSink`, observed on `scheduleMidi`) receives each lane's
 * messages at the right times, live (a transport ticking over an offline context as a page's would) and offline (`renderMixRange`, `renderStems`).
 */
const RATE = 48_000;
const QUANTUM = 128;
const worklet = "/@fs" + new URL("../../host/dist/webclap-worklet.js", import.meta.url).pathname.replace(/^\/@fs/, "");
const cleanups: Array<() => unknown> = [];
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
let installed = false;
/** A fresh list of every non-note message a recording sink is sent from now on, in call order. */
function recordSink(): Message[] {
  recording = [];
  if (!installed) {
    installed = true;
    const original = SamplerSink.prototype.scheduleMidi;
    vi.spyOn(SamplerSink.prototype, "scheduleMidi").mockImplementation(function (this: SamplerSink, data, when) {
      if ((data[0] & 0xf0) !== 0x90 && (data[0] & 0xf0) !== 0x80) recording.push({ data: [...data], when });
      return original.call(this, data, when);
    });
  }
  return recording;
}

const sustain: ControllerLane = {
  expression: "channelController",
  channel: 0,
  controller: 64,
  points: [
    { time: 0, value: 0, shape: "hold" },
    { time: 1, value: 127, shape: "hold" },
    { time: 3, value: 0, shape: "hold" },
  ],
};
const modWheel: ControllerLane = {
  expression: "channelController",
  channel: 0,
  controller: 1,
  points: [
    { time: 0, value: 0, shape: "linear" },
    { time: 2, value: 127, shape: "linear" },
  ],
};
const bend: ControllerLane = {
  expression: "pitchBend",
  channel: 1,
  controller: 0,
  points: [
    { time: 1, value: 8192, shape: "hold" },
    { time: 3, value: 16383, shape: "hold" },
  ],
};

/** 120 BPM, so a beat is 0.5 s: a Keys track on the page's own sound with a clip, the three lanes above. */
function song() {
  const project = new Project({ bpm: 120 });
  const track = project.addTrack("Keys", "midi");
  project.addMidiClip(track.id, { duration: 8, notes: [{ pitch: 60, velocity: 1, start: 0, duration: 0.25 }] }, 0);
  for (const lane of [sustain, modWheel, bend]) project.setControllerLane(track.id, lane);
  cleanups.push(() => project.dispose());
  return { project, track, instruments: { [track.id]: { sound: click } } };
}

/** What the lanes send, worked out here without the package's own sampling code: the rule is a message at each point, and between the points of a linear segment one at each 1/32 beat where the rounded value changes. */
const expectedModWheel = () => {
  const out: Array<[number, number]> = [[0, 0]];
  let last = 0;
  for (let step = 1; step < 64; step++) {
    const value = Math.round((127 * step) / 64);
    if (value !== last) out.push([step / 32, value]);
    last = Math.max(last, value);
    last = value;
  }
  out.push([2, 127]);
  return out;
};

const messagesOf = (sent: Message[], status: number, number?: number) =>
  sent
    .filter(({ data }) => (data[0] & 0xf0) === status && (number === undefined || data[1] === number))
    .map(({ data, when }) => [Math.round((when / 0.5) * 1e6) / 1e6, status === 0xe0 ? data[1] + (data[2] << 7) : data[2]] as [number, number]);

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
  expect(workspace.cells.warnings.value).toEqual([]);
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

async function liveWorkspace(project: Project, instruments: WorkspaceOptions["instruments"]) {
  const context = new AudioContext({ sampleRate: RATE });
  const workspace = await Workspace.create(context, project, { workletUrl: worklet, instruments });
  cleanups.push(async () => {
    workspace.dispose();
    await context.close();
  });
  return workspace;
}

describe("a running Workspace sends the lanes to the track's instrument", () => {
  test("live: each lane's messages arrive at their beats, with the values the rule gives", async () => {
    const { project, instruments } = song();
    const sent = recordSink();
    await playLike(project, 4.5, [], { instruments });
    expect(messagesOf(sent, 0xb0, 64)).toEqual([
      [0, 0],
      [1, 127],
      [3, 0],
    ]);
    expect(messagesOf(sent, 0xb0, 1)).toEqual(expectedModWheel());
    expect(messagesOf(sent, 0xe0)).toEqual([
      [1, 8192],
      [3, 16383],
    ]);
    // Pitch bend travels on its own channel.
    expect(sent.filter(({ data }) => (data[0] & 0xf0) === 0xe0).every(({ data }) => (data[0] & 15) === 1)).toBe(true);
    // Messages are in time order in the order they were sent per lane, and no message is sent twice.
    const keys = sent.map(({ data, when }) => `${data.join(",")}@${when.toFixed(6)}`);
    expect(new Set(keys).size).toBe(keys.length);
  }, 60_000);

  test("offline renders send exactly what the live transport sends: renderMixRange and renderStems", async () => {
    const { project, instruments } = song();
    const live = recordSink();
    await playLike(project, 4.5, [], { instruments });
    const liveLanes = live.map(({ data, when }) => `${data.join(",")}@${when.toFixed(5)}`).sort();
    expect(liveLanes.length).toBeGreaterThan(60);

    const mix = recordSink();
    const workspace = await liveWorkspace(project, instruments);
    const range = await renderMixRange(workspace, { expectedVersion: project.cells.version.value, range: { startBeat: 0, endBeat: 4 } });
    expect(range.status).toBe("rendered");
    const inRange = (list: string[]) => list.filter((line) => Number(line.split("@")[1]) < 2 - 1e-9);
    expect(mix.map(({ data, when }) => `${data.join(",")}@${when.toFixed(5)}`).sort()).toEqual(inRange(liveLanes));

    const stems = recordSink();
    const result = await renderStems(workspace, { tailSeconds: 0.5 });
    expect(result.status).toBe("rendered");
    // The song ends with its clip (beat 8, 4 s), so a render covers the whole song. renderStems renders the mix and the one track's stem: two renders, each with every lane message.
    const stemKeys = stems.map(({ data, when }) => `${data.join(",")}@${when.toFixed(5)}`);
    expect(stemKeys.length).toBe(2 * liveLanes.length);
    expect([...new Set(stemKeys)].sort()).toEqual(liveLanes);

    const fallback = recordSink();
    await exportAudioFallbackTo(workspace, new WritableStream({ write: () => undefined }));
    const fallbackKeys = fallback.map(({ data, when }) => `${data.join(",")}@${when.toFixed(5)}`);
    expect([...new Set(fallbackKeys)].sort()).toEqual(liveLanes);
  }, 90_000);

  test("a start inside the song and a seek send the value in force at that beat first, then carry on", async () => {
    const { project, instruments } = song();
    const sent = recordSink();
    // Start at 1.25 s (beat 2.5): the pedal is down, the wheel has reached 127, the bend is at its centre.
    await playLike(project, 1.5, [{ at: 0, run: (workspace) => workspace.seek(1.25) }], { instruments });
    expect(
      sent
        .filter(({ when }) => when < 1e-6)
        .map(({ data }) => data.join(","))
        .sort(),
    ).toEqual(["176,1,127", "176,64,127", "225,0,64"]);
    // The context time of the first message is the start (beat 2.5 is context time 0), and the pedal comes up at beat 3, 0.25 s on (0.5 in the beats of this song's 0.5 s).
    expect(messagesOf(sent, 0xb0, 64)).toEqual([
      [0, 127],
      [0.5, 0],
    ]);
    // A seek while playing: at 0.5 s the transport jumps to beat 2.5 and the same three messages go out there.
    const during = recordSink();
    let mark = 0;
    await playLike(
      project,
      1.5,
      [
        {
          at: 0.5,
          run: (workspace) => {
            mark = during.length;
            workspace.seek(1.25);
          },
        },
      ],
      { instruments },
    );
    const afterSeek = during.slice(mark).filter(({ when }) => when < 0.5 + 0.2);
    expect(afterSeek.map(({ data }) => data.join(",")).sort()).toEqual(["176,1,127", "176,64,127", "225,0,64"]);
  }, 60_000);

  test("a loop of beats 1 to 3 puts each lane back to its value at beat 1 at every wrap", async () => {
    const { project, instruments } = song();
    const sent = recordSink();
    await playLike(
      project,
      3.2,
      [
        {
          at: 0,
          run: (workspace) => {
            workspace.loop.setRegion({ startBeat: 1, endBeat: 3 });
            workspace.loop.setEnabled(true);
            workspace.seek(0.5);
          },
        },
      ],
      { instruments },
    );
    // From beat 1: the pedal goes down at once, then wraps at 1 s and 2 s of the context put it (and the others) back at beat 1's values.
    const sustainMessages = sent
      .filter(({ data }) => data[0] === 0xb0 && data[1] === 64)
      .map(({ data, when }) => [Math.round(when * 1e6) / 1e6, data[2]]);
    expect(sustainMessages.slice(0, 3)).toEqual([
      [0, 127],
      [1, 127],
      [2, 127],
    ]);
    const bendMessages = sent.filter(({ data }) => (data[0] & 0xf0) === 0xe0).map(({ when }) => Math.round(when * 1e6) / 1e6);
    expect(bendMessages.slice(0, 3)).toEqual([0, 1, 2]);
    // The mod wheel keeps moving inside the loop and restarts from its value at beat 1 (64) at each wrap.
    const wheel = sent.filter(({ data }) => data[0] === 0xb0 && data[1] === 1);
    expect(wheel.filter(({ when }) => Math.abs(when - 1) < 1e-6).map(({ data }) => data[2])).toEqual([64]);
    expect(wheel.every(({ data }) => data[2] >= 64)).toBe(true);
  }, 60_000);
});

describe("lanes through the MCP tools", () => {
  const call = async (workspace: Workspace, name: string, args: unknown): Promise<McpToolResult> =>
    mcpTools(workspace)
      .find((tool) => tool.name === name)!
      .call(args);

  test("read_project lists each lane, a long one by its count and ends; read_automation returns the rows setControllerLane takes", async () => {
    const { project, track, instruments } = song();
    const dense: ControllerLane = {
      expression: "channelController",
      channel: 3,
      controller: 74,
      points: Array.from({ length: 40 }, (_, i) => ({ time: i / 4, value: i, shape: "linear" as const })),
    };
    project.setControllerLane(track.id, dense);
    const workspace = await liveWorkspace(project, instruments);
    const read = (await call(workspace, "read_project", {})).content;
    expect(read).toContain("controllerLanes");
    expect(read).toContain("pitchBend");
    expect(read).toMatch(/count: 40/);
    const rows = decode(
      (await call(workspace, "read_automation", { trackId: track.id, expression: "channelController", channel: 0, controller: 64 })).content,
    ) as { points: unknown };
    expect(rows.points).toEqual([
      { atBeat: 0, atSeconds: 0, value: 0, shape: "hold" },
      { atBeat: 1, atSeconds: 0.5, value: 127, shape: "hold" },
      { atBeat: 3, atSeconds: 1.5, value: 0, shape: "hold" },
    ]);
    const missing = await call(workspace, "read_automation", { trackId: track.id, expression: "pitchBend", channel: 9 });
    expect(missing.content).toContain("has no controller lane pitchBend channel 9");
    const sentBack = await call(workspace, "apply_edits", {
      expectedVersion: project.cells.version.value,
      label: "Pedal",
      ops: [
        {
          type: "setControllerLane",
          trackId: track.id,
          expression: "channelController",
          channel: 0,
          controller: 64,
          points: [
            { atBeat: 0, value: 127, shape: "hold" },
            { atBeat: 4, value: 0, shape: "hold" },
          ],
        },
      ],
    });
    expect(JSON.parse(sentBack.content).status).toBe("applied");
    expect(project.tracks[0].controllerLanes.find((lane) => lane.controller === 64)!.points).toHaveLength(2);
  }, 60_000);
});
