import { ManualTickSource } from "@audiorective/clock";
import { decode } from "@toon-format/toon";
import type { SoundFactory } from "@audiorective/core";
import { afterEach, describe, expect, test, vi } from "vitest";
import { Project, Workspace, renderMixRange, sessionFor, type ControllerLane, type WorkspaceOptions } from "../src";
import { mcpTools, type McpToolResult } from "../src/mcp";
import { SamplerSink } from "../src/midi-sink";

/**
 * Review B regressions that need a running Workspace: what stop, pause and seek leave on the instrument, the order of messages at one time, lanes over clip
 * events, lanes read back through MCP, and `open` and `auditionAudioClip`.
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

const pedalDown = lane("channelController", 64, [
  [0, 0],
  [1, 127],
]);
const modWheel = lane("channelController", 1, [[1, 90]]);
const bend = lane("pitchBend", 0, [[1, 16383]]);

describe("stop, pause and a seek leave nothing stuck down", () => {
  /** The messages sent from the moment `mark` is read until the end. */
  const after = (sent: Message[], mark: number) => sent.slice(mark).map(text);

  test.each(["pause", "stop"] as const)(
    "%s puts the pedal up, the bend at centre and the mod wheel at rest",
    async (how) => {
      const { project, instruments } = song([pedalDown, modWheel, bend]);
      const sent = recordSink();
      let mark = 0;
      await playLike(
        project,
        1.2,
        [
          {
            at: 0.8,
            run: (workspace) => {
              mark = sent.length;
              workspace[how]();
            },
          },
        ],
        { instruments },
      );
      // The pedal went down at beat 1 (0.5 s) and was still down at 0.8 s.
      expect(sent.map(text).slice(0, mark)).toContain("176,64,127");
      const reset = after(sent, mark);
      expect(reset).toContain("176,64,0");
      expect(reset).toContain("224,0,64");
      expect(reset).toContain("176,1,0");
    },
    60_000,
  );

  test("a pedal that only a clip's own events pressed is lifted too, and a controller at rest is not touched", async () => {
    const { project, instruments } = song([], [{ time: 1, data: [0xb0, 64, 127] }]);
    const sent = recordSink();
    let mark = 0;
    await playLike(
      project,
      1.2,
      [
        {
          at: 0.8,
          run: (workspace) => {
            mark = sent.length;
            workspace.pause();
          },
        },
      ],
      { instruments },
    );
    expect(after(sent, mark)).toEqual(["176,64,0"]);
  }, 60_000);

  test("a seek to a beat before a lane's first point sends the rest values, not nothing", async () => {
    const late = [lane("channelController", 64, [[4, 127]]), lane("pitchBend", 0, [[4, 16383]])];
    const { project, instruments } = song(late);
    const sent = recordSink();
    let mark = 0;
    // Start in the pedal's time (beat 5), then jump back to beat 1.
    await playLike(
      project,
      1.2,
      [
        { at: 0, run: (workspace) => workspace.seek(2.5) },
        {
          at: 0.5,
          run: (workspace) => {
            mark = sent.length;
            workspace.seek(0.5);
          },
        },
      ],
      { instruments },
    );
    expect(sent.map(text).slice(0, mark)).toContain("176,64,127");
    const back = after(sent, mark);
    expect(back.filter((line) => line === "176,64,0").length).toBeGreaterThanOrEqual(1);
    expect(back).toContain("224,0,64");
    expect(back).not.toContain("176,64,127");
  }, 60_000);

  test("an offline render that starts before a lane's first point starts at the rest value", async () => {
    const { project, instruments } = song([lane("channelController", 64, [[4, 127]])]);
    const workspace = await liveWorkspace(project, { instruments });
    const sent = recordSink();
    const range = await renderMixRange(workspace, { expectedVersion: project.cells.version.value, range: { startBeat: 0, endBeat: 2 } });
    expect(range.status).toBe("rendered");
    expect(sent.filter(({ data }) => data[0] === 0xb0 && data[1] === 64).map(({ data, when }) => [data[2], Math.round(when * 1e6) / 1e6])).toEqual([
      [0, 0],
    ]);
  }, 60_000);
});

describe("one time, one order", () => {
  test("a note-off, then the program change, then the controllers, then the note-on", async () => {
    // The clip's first note ends at beat 1 where the second starts; a program change and two controllers (one a lane, one a clip event) are there too.
    const { project, instruments } = song(
      [lane("programChange", 0, [[1, 5]]), lane("channelController", 7, [[1, 80]])],
      [{ time: 1, data: [0xb0, 10, 20] }],
      [
        { pitch: 60, start: 0, duration: 1 },
        { pitch: 64, start: 1, duration: 0.5 },
      ],
    );
    const sent = recordSink();
    await playLike(project, 1.2, [], { instruments });
    const atOne = sent.filter(({ when }) => Math.abs(when - 0.5) < 1e-6).map(({ data }) => data[0] & 0xf0);
    expect(atOne.indexOf(0x80)).toBeGreaterThanOrEqual(0);
    expect(atOne.indexOf(0x80)).toBeLessThan(atOne.indexOf(0xc0));
    expect(atOne.indexOf(0xc0)).toBeLessThan(atOne.indexOf(0xb0));
    expect(atOne.lastIndexOf(0xb0)).toBeLessThan(atOne.indexOf(0x90));
  }, 60_000);
});

describe("a track lane replaces the clip's events for the same controller", () => {
  const clipEvents = [
    { time: 1, data: [0xb0, 1, 99] },
    { time: 1, data: [0xb0, 64, 127] },
  ];
  test("live and offline send the lane's mod wheel and the clip's pedal, never the clip's mod wheel", async () => {
    const { project, instruments } = song([lane("channelController", 1, [[0, 7]])], clipEvents);
    const live = recordSink();
    await playLike(project, 1.2, [], { instruments });
    expect(live.map(text)).toContain("176,1,7");
    expect(live.map(text)).not.toContain("176,1,99");
    expect(live.map(text)).toContain("176,64,127");

    const workspace = await liveWorkspace(project, { instruments });
    const offline = recordSink();
    await renderMixRange(workspace, { expectedVersion: project.cells.version.value, range: { startBeat: 0, endBeat: 4 } });
    expect(offline.map(text)).toContain("176,1,7");
    expect(offline.map(text)).not.toContain("176,1,99");
    expect(offline.map(text)).toContain("176,64,127");
  }, 60_000);
});

describe("lanes read through MCP can be written back", () => {
  const call = async (workspace: Workspace, name: string, args: unknown): Promise<McpToolResult> =>
    mcpTools(workspace)
      .find((tool) => tool.name === name)!
      .call(args);

  test("read_project and read_automation show no controller for a pitch bend lane, and the rows send back as a no-op", async () => {
    const { project, track, instruments } = song([
      lane("pitchBend", 0, [
        [0, 8192],
        [2, 12000],
      ]),
      lane("channelPressure", 0, [[1, 40]], 3),
      lane("channelController", 64, [[1, 127]]),
      lane("polyPressure", 60, [[1, 9]]),
    ]);
    const workspace = await liveWorkspace(project, { instruments });
    const read = decode((await call(workspace, "read_project", {})).content) as { controllerLanes: Array<Record<string, unknown>> };
    const byExpression = Object.fromEntries(read.controllerLanes.map((item) => [item.expression as string, item]));
    expect("controller" in byExpression.pitchBend).toBe(false);
    expect("controller" in byExpression.channelPressure).toBe(false);
    expect(byExpression.channelController.controller).toBe(64);
    expect(byExpression.polyPressure.controller).toBe(60);

    for (const [args, expected] of [
      [{ expression: "pitchBend", channel: 0 }, "pitchBend"],
      [{ expression: "channelPressure", channel: 3 }, "channelPressure"],
      [{ expression: "polyPressure", channel: 0, controller: 60 }, "polyPressure"],
    ] as const) {
      const rows = decode((await call(workspace, "read_automation", { trackId: track.id, ...args })).content) as Record<string, unknown> & {
        points: unknown[];
      };
      expect(rows.expression).toBe(expected);
      expect("controller" in rows).toBe(expected === "polyPressure");
      const { trackId, expression, channel, points } = rows;
      const op: Record<string, unknown> = { type: "setControllerLane", trackId, expression, channel, points };
      if ("controller" in rows) op.controller = rows.controller;
      const sentBack = JSON.parse(
        (await call(workspace, "apply_edits", { expectedVersion: project.cells.version.value, label: "Same", ops: [op] })).content,
      ) as { status: string };
      expect(sentBack.status).toBe("noop");
    }
  }, 60_000);

  test("the receipt text says changedScenes are renamed or moved scenes", async () => {
    const { project } = song([]);
    const workspace = await liveWorkspace(project);
    const description = mcpTools(workspace).find((tool) => tool.name === "apply_edits")!.description;
    expect(description).toContain("changedScenes (scenes renamed or moved in the order");
    expect(description).not.toMatch(/Reordered scenes/i);
  }, 30_000);
});

describe("workspace.open applies what changed while it loaded", () => {
  const device = { kind: "webclap", pluginId: "slow", name: "Slow", vendor: "v", version: "1", bundleUrl: "/slow.wclap" } as const;
  /** A project whose first track holds a device that loads only when the gate opens; its second track has no device. */
  function slowProject() {
    const project = new Project({ bpm: 120 });
    const slow = project.addTrack("Slow", "midi");
    project.addDevice(slow.id, device);
    const plain = project.addTrack("Plain", "midi");
    cleanups.push(() => project.dispose());
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    return { project, plain, release, resolveBundle: async () => (await gate, undefined) };
  }
  const started = async () => {
    const project = new Project({ bpm: 120 });
    const workspace = await liveWorkspace(project);
    return { workspace };
  };
  const runtimeClips = (workspace: Workspace, trackId: string) =>
    (workspace as unknown as { tracks: Map<string, { clips: unknown }> }).tracks.get(trackId)!.clips;

  test("a clip added to the Project during the load plays after the swap", async () => {
    const { workspace } = await started();
    const { project, plain, release, resolveBundle } = slowProject();
    const opening = workspace.open(project, { resolveBundle });
    await new Promise((resolve) => setTimeout(resolve, 50));
    project.addMidiClip(plain.id, { duration: 4, notes: [{ pitch: 60, velocity: 1, start: 0, duration: 1 }] }, 0);
    release();
    await opening;
    await workspace.flush();
    expect(project.tracks.find((track) => track.id === plain.id)!.clips).toHaveLength(1);
    expect(runtimeClips(workspace, plain.id)).toBe(project.tracks.find((track) => track.id === plain.id)!.clips);
    expect(workspace.cells.needsSync.value).toBe(false);
  }, 30_000);

  test("a track added during the load sets needsSync", async () => {
    const { workspace } = await started();
    const { project, release, resolveBundle } = slowProject();
    const opening = workspace.open(project, { resolveBundle });
    await new Promise((resolve) => setTimeout(resolve, 50));
    project.addTrack("Late", "audio");
    release();
    await opening;
    await workspace.flush();
    expect(workspace.cells.needsSync.value).toBe(true);
  }, 30_000);

  test("a Project handed over with ownsProject is still the caller's when the load fails", async () => {
    const { workspace } = await started();
    const { project } = slowProject();
    await expect(
      workspace.open(project, {
        ownsProject: true,
        resolveBundle: () => {
          throw new Error("no bundle");
        },
      }),
    ).rejects.toThrow("no bundle");
    expect(() => project.addTrack("Mine", "audio")).not.toThrow();
  }, 30_000);
});

describe("auditionAudioClip", () => {
  test("plays a clip that sits in a Session slot", async () => {
    const project = new Project({ bpm: 120 });
    const track = project.addTrack("Loop", "audio");
    const session = sessionFor(project);
    const scene = session.addScene({ name: "A" });
    const clip = session.setAudioClip(
      { sceneId: scene.id, trackId: track.id },
      { sampleRate: RATE, channels: [new Float32Array(RATE / 2).fill(0.1)] },
    );
    cleanups.push(() => project.dispose());
    const workspace = await liveWorkspace(project);
    await workspace.auditionAudioClip(clip.id);
    expect(workspace.cells.auditioningClip.value).toBe(clip.id);
    workspace.stopClipAudition();
    expect(workspace.cells.auditioningClip.value).toBeNull();
  }, 30_000);
});
