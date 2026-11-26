import { beforeEach, describe, expect, test, vi } from "vitest";

const fakes = vi.hoisted(() => {
  const state = {
    hosts: [] as Array<{
      loadState: ReturnType<typeof import("vitest").vi.fn>;
      saveState: ReturnType<typeof import("vitest").vi.fn>;
      dispose: ReturnType<typeof import("vitest").vi.fn>;
    }>,
    clocks: [] as Array<{ stop: ReturnType<typeof import("vitest").vi.fn>; seek: ReturnType<typeof import("vitest").vi.fn> }>,
    racks: [] as Array<{ setEffects: ReturnType<typeof import("vitest").vi.fn> }>,
    loadStateImpl: undefined as undefined | ((bytes: Uint8Array) => Promise<void>),
    rackError: undefined as undefined | Error,
    channels: [] as Array<{ dispose: ReturnType<typeof import("vitest").vi.fn> }>,
    buses: [] as Array<{ define: ReturnType<typeof import("vitest").vi.fn>; undefine: ReturnType<typeof import("vitest").vi.fn> }>,
  };
  return state;
});

vi.mock("../src/track-rack", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/track-rack")>()),
  TrackRack: class {
    effects: readonly unknown[];
    input = { connect: vi.fn() };
    output = { connect: vi.fn() };
    setEffects = vi.fn((effects: readonly unknown[]) => {
      this.effects = effects;
    });
    dispose = vi.fn();
    constructor(_context: unknown, effects: readonly unknown[]) {
      if (fakes.rackError) throw fakes.rackError;
      this.effects = effects;
      fakes.racks.push(this);
    }
  },
}));
vi.mock("@audiorective/effects", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@audiorective/effects")>()),
  Channel: class {
    input = { connect: vi.fn() };
    output = { connect: vi.fn(), disconnect: vi.fn() };
    tap = {};
    params = { gain: { value: 1 }, pan: { value: 0 }, muted: { value: false }, outputEnabled: { value: true } };
    send = vi.fn(() => ({ params: { gain: { value: 1 }, enabled: { value: true } }, dispose: vi.fn() }));
    dispose = vi.fn();
    constructor() {
      fakes.channels.push(this);
    }
  },
  SendBus: class {
    define = vi.fn();
    receive = vi.fn(() => ({ connect: vi.fn() }));
    undefine = vi.fn();
    constructor() {
      fakes.buses.push(this);
    }
  },
}));
vi.mock("@audiorective/host/webclap", () => ({
  WebClapHost: {
    load: vi.fn(async () => {
      const host = {
        descriptor: { id: "fake.synth" },
        input: {},
        output: { connect: vi.fn(), disconnect: vi.fn() },
        loadState: vi.fn(async (bytes: Uint8Array) => fakes.loadStateImpl?.(bytes)),
        saveState: vi.fn(async () => new Uint8Array([9, 9])),
        allNotesOff: vi.fn(),
        dispose: vi.fn(),
      };
      fakes.hosts.push(host);
      return host;
    }),
  },
}));
vi.mock("@audiorective/clock", async () => {
  const { cell } = await import("@audiorective/core");
  class Timeline {
    bpm = { cancelScheduledValues: vi.fn(), setValueAtTime: vi.fn() };
    timeToBeat = () => 0;
    beatToTime = () => 0;
  }
  class Clock {
    state = cell<"stopped" | "playing" | "paused">("stopped");
    stop = vi.fn(() => {
      this.state.value = "stopped";
    });
    seek = vi.fn();
    start = vi.fn();
    pause = vi.fn();
    refresh = vi.fn();
    dispose = vi.fn();
    meter = cell<readonly [number, number]>([4, 4]);
    attach = vi.fn(() => () => undefined);
    constructor() {
      fakes.clocks.push(this);
    }
  }
  return { Clock, Timeline };
});
vi.mock("@audiorective/launcher", () => ({
  ClipLauncher: class {
    tracks: Record<string, unknown>;
    dispose = vi.fn();
    constructor(specs: Record<string, unknown[]>) {
      this.tracks = Object.fromEntries(
        Object.entries(specs).map(([id, clips]) => [
          id,
          {
            clips: clips.map((spec) => (spec ? { launch: vi.fn() } : null)),
            stop: vi.fn(),
            connect: vi.fn(),
            setClip: vi.fn((_index: number, spec: unknown) => (spec ? { launch: vi.fn() } : null)),
          },
        ]),
      );
    }
  },
}));

import { effect } from "@audiorective/core";
import { WebClapHost } from "@audiorective/host/webclap";
import { Project, Workspace, openWorkspace, saveWorkspace, saveWorkspaceTo, sessionFor } from "../src";
import * as projectEntry from "../src/project";
import * as runtimeEntry from "../src/runtime-entry";
import * as dawprojectEntry from "../src/dawproject";
import { saveDawProject } from "../src/dawproject";

const node = () => {
  const target: Record<string, unknown> = {
    gain: { setValueAtTime: vi.fn(), cancelScheduledValues: vi.fn(), linearRampToValueAtTime: vi.fn() },
    pan: { setValueAtTime: vi.fn() },
    disconnect: vi.fn(),
  };
  target.connect = vi.fn((next: unknown) => next ?? target);
  return target;
};
const context = () =>
  ({
    currentTime: 0,
    createGain: node,
    createStereoPanner: node,
    createBuffer: (channels: number) => ({ getChannelData: () => new Float32Array(100), numberOfChannels: channels }),
    resume: async () => undefined,
  }) as unknown as AudioContext;

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

async function setup(options: { withDevice?: boolean } = {}) {
  const project = new Project({ bpm: 120 });
  const track = project.addTrack("Keys", "midi");
  const device = options.withDevice
    ? project.addWebClapDevice(track.id, { pluginId: "fake.synth", name: "Synth", vendor: "t", version: "1", bundleUrl: "/fake.wasm" })
    : undefined;
  const workspace = await Workspace.create(context(), project);
  const clock = fakes.clocks[fakes.clocks.length - 1];
  return { project, track, device, workspace, clock };
}

beforeEach(() => {
  fakes.hosts.length = 0;
  fakes.clocks.length = 0;
  fakes.racks.length = 0;
  fakes.loadStateImpl = undefined;
  fakes.rackError = undefined;
  fakes.channels.length = 0;
  fakes.buses.length = 0;
});

describe("workspace automatic application", () => {
  test("coalesces a burst of edits into one application", async () => {
    const { project, track, workspace, clock } = await setup();
    const seeks = clock.seek.mock.calls.length;
    for (let index = 0; index < 5; index++) project.setTempoChanges([{ beat: 4 + index, bpm: 60 }]);
    expect(clock.seek.mock.calls.length).toBe(seeks);
    await workspace.flush();
    expect(clock.seek.mock.calls.length).toBe(seeks + 1);
    const effects = [{ id: "f", type: "filter", enabled: true, wet: 1, mode: "lowpass", frequency: 800, q: 1 }] as const;
    project.setTrackEffects(track.id, effects);
    project.setTrackVolume(track.id, 0.5);
    expect(fakes.racks[0].setEffects).not.toHaveBeenCalled();
    await workspace.flush();
    expect(fakes.racks[0].setEffects).toHaveBeenCalledTimes(1);
    workspace.dispose();
    project.dispose();
  });

  test("serializes applications; edits during an async state restore run exactly one more", async () => {
    const { project, device, workspace } = await setup({ withDevice: true });
    const gates: Array<() => void> = [];
    let active = 0;
    let overlap = false;
    fakes.loadStateImpl = () =>
      new Promise<void>((resolve) => {
        active++;
        overlap ||= active > 1;
        gates.push(() => {
          active--;
          resolve();
        });
      });
    project.setDeviceState(device!.id, new Uint8Array([1]));
    await tick();
    expect(gates).toHaveLength(1);
    project.setDeviceState(device!.id, new Uint8Array([2]));
    project.setDeviceState(device!.id, new Uint8Array([3]));
    await tick();
    expect(gates).toHaveLength(1);
    const flushed = workspace.flush();
    gates[0]();
    await tick();
    expect(gates).toHaveLength(2);
    gates[1]();
    await flushed;
    expect(fakes.hosts[0].loadState.mock.calls.map((call) => [...call[0]])).toEqual([[1], [3]]);
    expect(overlap).toBe(false);
    workspace.dispose();
    project.dispose();
  });

  test("topology change sets needsSync, leaves transport alone and sync clears it", async () => {
    const { project, workspace, clock } = await setup();
    expect(workspace.cells.needsSync.value).toBe(false);
    const stops = clock.stop.mock.calls.length;
    const added = project.addTrack("Drums", "audio");
    await workspace.flush();
    expect(workspace.cells.needsSync.value).toBe(true);
    expect(clock.stop.mock.calls.length).toBe(stops);
    // Light edits wait for sync while topology differs.
    const racks = fakes.racks.length;
    project.setTrackVolume(added.id, 0.3);
    await workspace.flush();
    expect(workspace.cells.needsSync.value).toBe(true);
    await workspace.sync();
    expect(workspace.cells.needsSync.value).toBe(false);
    expect(fakes.racks.length).toBeGreaterThan(racks);
    project.removeTrack(added.id);
    await workspace.flush();
    expect(workspace.cells.needsSync.value).toBe(true);
    await workspace.sync();
    expect(workspace.cells.needsSync.value).toBe(false);
    workspace.dispose();
    project.dispose();
  });

  test("a failed application sets the error cell, rejects flush and clears on success", async () => {
    const { project, device, workspace } = await setup({ withDevice: true });
    fakes.loadStateImpl = async () => {
      throw new Error("bad state");
    };
    project.setDeviceState(device!.id, new Uint8Array([1]));
    await expect(workspace.flush()).rejects.toThrow("bad state");
    expect(workspace.cells.error.value).toBe("bad state");
    fakes.loadStateImpl = undefined;
    project.setDeviceState(device!.id, new Uint8Array([2]));
    await expect(workspace.flush()).resolves.toBeUndefined();
    expect(workspace.cells.error.value).toBeNull();
    workspace.dispose();
    project.dispose();
  });

  test("captureStates during save does not re-apply its own edits", async () => {
    const { project, device, workspace, clock } = await setup({ withDevice: true });
    const loads = fakes.hosts[0].loadState.mock.calls.length;
    const seeks = clock.seek.mock.calls.length;
    const revision = project.cells.revision.value;
    await saveWorkspace(workspace);
    expect(project.cells.revision.value).toBeGreaterThan(revision);
    expect([...project.tracks[0].devices.find((item) => item.id === device!.id)!.state]).toEqual([9, 9]);
    await workspace.flush();
    await tick();
    expect(fakes.hosts[0].loadState.mock.calls.length).toBe(loads);
    expect(clock.seek.mock.calls.length).toBe(seeks);
    workspace.dispose();
    project.dispose();
  });

  test("a MIDI note edit refreshes Clock only while playing", async () => {
    const project = new Project({ bpm: 120 });
    const track = project.addTrack("Keys", "midi");
    const clip = project.addMidiClip(track.id, { duration: 4, notes: [] }, 0);
    const workspace = await Workspace.create(context(), project);
    const clock = fakes.clocks[fakes.clocks.length - 1];
    const refreshes = clock.refresh.mock.calls.length;
    clip.midi.setNotes([{ pitch: 60, velocity: 0.5, start: 0, duration: 1 }]);
    expect(clock.refresh.mock.calls.length).toBe(refreshes);
    clock.state.value = "playing";
    clip.midi.setNotes([{ pitch: 62, velocity: 0.5, start: 1, duration: 1 }]);
    expect(clock.refresh.mock.calls.length).toBe(refreshes + 1);
    workspace.dispose();
    project.dispose();
  });

  test("Workspace mixer writes apply immediately and Project mixer edits apply once without refreshing Arrangement", async () => {
    const { project, track, workspace, clock } = await setup();
    const masterGain = vi.mocked(workspace.output.gain.setValueAtTime);
    const strip = fakes.channels.at(-1) as unknown as { params: { gain: { value: number }; pan: { value: number } } };
    masterGain.mockClear();
    const refreshes = clock.refresh.mock.calls.length;
    workspace.setTrackVolume(track.id, 0.4);
    workspace.setTrackPan(track.id, -1);
    expect(strip.params.gain.value).toBe(0.4);
    expect(strip.params.pan.value).toBe(-1);
    await workspace.flush();
    project.setTrackVolume(track.id, 0.6);
    await workspace.flush();
    expect(strip.params.gain.value).toBe(0.6);
    expect(masterGain).not.toHaveBeenCalled();
    expect(clock.refresh.mock.calls.length).toBe(refreshes);
    workspace.dispose();
    project.dispose();
  });

  test("Workspace effect methods do not trigger a second application; a direct Project edit applies once", async () => {
    const { project, track, workspace } = await setup();
    const setEffects = fakes.racks[0].setEffects;
    const applications = setEffects.mock.calls.length;
    const filter = (frequency: number) => [{ id: "f", type: "filter", enabled: true, wet: 1, mode: "lowpass", frequency, q: 1 }] as const;
    workspace.setTrackEffects(track.id, filter(800));
    expect(setEffects.mock.calls.length).toBe(applications + 1);
    await workspace.flush();
    expect(setEffects.mock.calls.length).toBe(applications + 1);
    project.setTrackEffects(track.id, filter(1200));
    await workspace.flush();
    expect(setEffects.mock.calls.length).toBe(applications + 2);
    workspace.dispose();
    project.dispose();
  });

  test("adding and removing an empty effect bus never replaces a live instrument or stops transport", async () => {
    const { project, track, device, workspace, clock } = await setup({ withDevice: true });
    const host = workspace.host(device!.id);
    const panner = workspace.trackMixerOutput(track.id);
    const stops = clock.stop.mock.calls.length;
    const bus = project.addTrack("Return", "bus", { busRole: "effect" });
    project.setTrackRouting(track.id, { outputBusId: null, sends: [{ busId: bus.id, gain: 0.5 }] });
    await workspace.flush();
    expect(workspace.trackMixerOutput(bus.id)).toBeDefined();
    expect(workspace.cells.needsSync.value).toBe(false);
    project.removeTrack(bus.id);
    await workspace.flush();
    expect(workspace.trackMixerOutput(bus.id)).toBeUndefined();
    expect(workspace.trackMixerOutput(track.id)).toBe(panner);
    expect(workspace.host(device!.id)).toBe(host);
    expect(clock.stop.mock.calls.length).toBe(stops);
    workspace.dispose();
    project.dispose();
  });

  test("replacing the project reapplies; dispose drops pending work and flush still resolves", async () => {
    const { project, workspace, clock } = await setup();
    const other = new Project({ bpm: 90 });
    other.addTrack("Other", "audio");
    workspace.project = other;
    await workspace.flush();
    expect(workspace.cells.needsSync.value).toBe(true);
    await workspace.sync();
    project.setTempoChanges([{ beat: 1, bpm: 50 }]);
    other.setTempoChanges([{ beat: 1, bpm: 50 }]);
    workspace.dispose();
    const seeks = clock.seek.mock.calls.length;
    await expect(workspace.flush()).resolves.toBeUndefined();
    other.setTempoChanges([{ beat: 2, bpm: 50 }]);
    await tick();
    expect(clock.seek.mock.calls.length).toBe(seeks);
    await expect(workspace.sync()).rejects.toThrow("Workspace is disposed.");
    project.dispose();
    other.dispose();
  });
});

/** Public stateful readers are tracked: an effect over each re-runs, seeing the new value, when the owner changes it. */
describe("workspace addWebClapDevice", () => {
  const described = () => ({ descriptor: { id: "fake.synth", name: "Synth", vendor: "t", version: "1" }, dispose: vi.fn() }) as never;
  const gatedLoad = () => {
    let settle!: (outcome: { error?: Error }) => void;
    vi.mocked(WebClapHost.load).mockImplementationOnce(async () => described());
    vi.mocked(WebClapHost.load).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          settle = ({ error }) =>
            resolve({
              ...described(),
              input: {},
              // A host that cannot be wired into the chain fails the rebuild, as a real plug-in that breaks on connect would.
              output: {
                connect: vi.fn(() => {
                  if (error) throw error;
                }),
                disconnect: vi.fn(),
              },
              loadState: vi.fn(),
              saveState: vi.fn(),
              allNotesOff: vi.fn(),
            } as never);
        }),
    );
    return (outcome: { error?: Error }) => settle(outcome);
  };

  test("rejects when Undo removed the device while it was loading", async () => {
    const { project, track, workspace } = await setup();
    const settle = gatedLoad();
    const added = workspace.addWebClapDevice(track.id, "/fake.wasm");
    await tick();
    expect(project.undo().status).toBe("applied");
    settle({});
    await expect(added).rejects.toThrow("Workspace device was removed before it finished loading.");
    expect(project.tracks[0].devices).toEqual([]);
    workspace.dispose();
    project.dispose();
  });

  test("a failed rebuild removes only its own device and keeps an edit made meanwhile", async () => {
    const { project, track, workspace } = await setup();
    // A new track makes the structural rebuild run, and the rack of every rebuilt track fails.
    const extra = project.addTrack("Extra", "midi");
    const settle = gatedLoad();
    const added = workspace.addWebClapDevice(track.id, "/fake.wasm");
    const rejected = expect(added).rejects.toThrow("rack failed");
    await tick();
    const clip = project.edit("Add clip", () => project.addMidiClip(extra.id, { notes: [], duration: 1 }, 0));
    fakes.rackError = new Error("rack failed");
    settle({});
    await rejected;
    expect(project.tracks[0].devices).toEqual([]);
    expect(project.tracks[1].clips.map((item) => item.id)).toEqual([clip.id]);
    expect(project.cells.history.value.undo).toBe("Remove Synth");
    workspace.dispose();
    project.dispose();
  });

  test("a failed load with nothing edited since takes the Add back out of history", async () => {
    const { project, track, workspace } = await setup();
    const settle = gatedLoad();
    const added = workspace.addWebClapDevice(track.id, "/fake.wasm");
    const rejected = expect(added).rejects.toThrow("load failed");
    await tick();
    settle({ error: new Error("load failed") });
    await rejected;
    expect(project.tracks[0].devices).toEqual([]);
    expect(project.cells.history.value).toEqual({ redo: "Add Synth" });
    workspace.dispose();
    project.dispose();
  });

  test("undoing an unrelated device add does not load an empty state into a running plug-in", async () => {
    const { project, track, workspace } = await setup({ withDevice: true });
    await workspace.flush();
    const calls = () => fakes.hosts.reduce((sum, host) => sum + host.loadState.mock.calls.length, 0);
    const before = calls();
    const other = project.edit("Add B", () =>
      project.addWebClapDevice(track.id, { pluginId: "fake.synth", name: "B", vendor: "t", version: "1", bundleUrl: "/fake.wasm" }),
    );
    await workspace.flush();
    expect(other.state.length).toBe(0);
    project.undo();
    await workspace.flush();
    expect(calls()).toBe(before);
    workspace.dispose();
    project.dispose();
  });
});

describe("workspace composition", () => {
  test("saveWorkspace captures device state and reopens through openWorkspace", async () => {
    const { project, device, workspace } = await setup({ withDevice: true });
    const bytes = await saveWorkspace(workspace);
    expect([...project.tracks[0].devices.find((item) => item.id === device!.id)!.state]).toEqual([9, 9]);
    const reopened = await openWorkspace(context(), bytes);
    expect(reopened.project.tracks[0].devices[0].pluginId).toBe("fake.synth");
    expect([...reopened.project.tracks[0].devices[0].state]).toEqual([9, 9]);
    reopened.dispose();
    reopened.project.dispose();
    workspace.dispose();
    project.dispose();
  });

  test("saveWorkspaceTo streams the checkpointed project", async () => {
    const { project, workspace } = await setup({ withDevice: true });
    const parts: Uint8Array[] = [];
    await saveWorkspaceTo(workspace, new WritableStream({ write: (chunk) => void parts.push(chunk) }));
    expect(parts.reduce((total, part) => total + part.length, 0)).toBeGreaterThan(0);
    workspace.dispose();
    project.dispose();
  });

  test("checkpoint rejects once the workspace is disposed", async () => {
    const { project, workspace } = await setup();
    workspace.dispose();
    await expect(workspace.checkpoint()).rejects.toThrow("Workspace is disposed.");
    await expect(saveWorkspace(workspace)).rejects.toThrow("Workspace is disposed.");
    project.dispose();
  });

  test("file warnings and options warnings lead the workspace's own warnings", async () => {
    const source = new Project();
    const track = source.addTrack("Keys", "midi");
    source.addWebClapDevice(track.id, { pluginId: "fake.synth", name: "Synth", vendor: "t", version: "1", bundleUrl: "/fake.wasm" });
    const bytes = saveDawProject(source);
    const workspace = await openWorkspace(context(), bytes, { warnings: ["caller note"] });
    expect(workspace.warnings.slice(0, 1)).toEqual(["caller note"]);
    workspace.dispose();
    workspace.project.dispose();
  });

  test("a failed open disposes the opened project", async () => {
    const source = new Project();
    source.addTrack("Keys", "midi");
    const bytes = saveDawProject(source);
    const broken = {
      ...context(),
      createGain: () => {
        throw new Error("no audio");
      },
    } as unknown as AudioContext;
    const dispose = vi.spyOn(Project.prototype, "dispose");
    try {
      await expect(openWorkspace(broken, bytes)).rejects.toThrow("no audio");
      expect(dispose).toHaveBeenCalledTimes(1);
    } finally {
      dispose.mockRestore();
    }
  });
});

describe("workspace readers are tracked", () => {
  const rows: Array<{
    name: string;
    read: (workspace: Workspace) => unknown;
    mutate: (ctx: { project: Project; workspace: Workspace; device: { id: string } }) => Promise<void>;
  }> = [
    {
      name: "warnings getter",
      read: (workspace) => workspace.warnings,
      mutate: async ({ project, workspace }) => {
        const track = project.addTrack("Orphan", "midi");
        project.addWebClapDevice(track.id, { pluginId: "x", name: "NoBundle", vendor: "t", version: "1", bundleUrl: "" });
        await workspace.sync();
      },
    },
    {
      name: "cells.warnings",
      read: (workspace) => workspace.cells.warnings.value,
      mutate: async ({ project, workspace }) => {
        const track = project.addTrack("Orphan", "midi");
        project.addWebClapDevice(track.id, { pluginId: "x", name: "NoBundle", vendor: "t", version: "1", bundleUrl: "" });
        await workspace.sync();
      },
    },
    {
      name: "cells.needsSync",
      read: (workspace) => workspace.cells.needsSync.value,
      mutate: async ({ project, workspace }) => {
        project.addTrack("Drums", "audio");
        await workspace.flush();
      },
    },
    {
      name: "cells.error",
      read: (workspace) => workspace.cells.error.value,
      mutate: async ({ project, workspace, device }) => {
        fakes.loadStateImpl = async () => {
          throw new Error("bad state");
        };
        project.setDeviceState(device.id, new Uint8Array([1]));
        await workspace.flush().catch(() => undefined);
      },
    },
  ];
  test.each(rows)("$name", async ({ read, mutate }) => {
    const { project, workspace, device } = await setup({ withDevice: true });
    const seen: unknown[] = [];
    const stop = effect(() => void seen.push(read(workspace)));
    const first = seen[0];
    await mutate({ project, workspace, device: device! });
    stop();
    expect(seen.length).toBeGreaterThan(1);
    expect(Object.is(seen[seen.length - 1], first)).toBe(false);
    workspace.dispose();
    project.dispose();
  });

  test("warnings are a frozen snapshot that replaces on every write", async () => {
    const { project, workspace } = await setup();
    const before = workspace.warnings;
    expect(Object.isFrozen(before)).toBe(true);
    const track = project.addTrack("Orphan", "midi");
    project.addWebClapDevice(track.id, { pluginId: "x", name: "NoBundle", vendor: "t", version: "1", bundleUrl: "" });
    await workspace.sync();
    expect(workspace.warnings).not.toBe(before);
    expect(workspace.warnings).toEqual(["Device NoBundle has no WebCLAP bundle."]);
    expect(before).toEqual([]);
    workspace.dispose();
    project.dispose();
  });
});

describe("workspace commands do not subscribe a calling effect", () => {
  type Ctx = Awaited<ReturnType<typeof setup>> & { clipId: string };
  const settle = (promise: Promise<unknown>) => void promise.catch(() => undefined);
  const commands: Array<{ name: string; run: (ctx: Ctx) => unknown }> = [
    { name: "stop", run: (c) => c.workspace.stop() },
    { name: "auditionAudioClip", run: (c) => settle(c.workspace.auditionAudioClip(c.clipId)) },
    { name: "auditionRange", run: (c) => settle(c.workspace.auditionRange({ start: 0, end: 0.5 })) },
    { name: "prepareAudioClipStretch", run: (c) => settle(c.workspace.prepareAudioClipStretch(c.clipId, 1)) },
    { name: "setTrackVolume", run: (c) => c.workspace.setTrackVolume(c.track.id, 0.4) },
    { name: "setMasterVolume", run: (c) => c.workspace.setMasterVolume(0.4) },
    { name: "setTrackMuted", run: (c) => c.workspace.setTrackMuted(c.track.id, true) },
    { name: "setTrackSolo", run: (c) => c.workspace.setTrackSolo(c.track.id, true) },
    { name: "setTrackPan", run: (c) => c.workspace.setTrackPan(c.track.id, 0.3) },
    { name: "seek", run: (c) => c.workspace.seek(1) },
    { name: "takeAnchor", run: (c) => c.workspace.takeAnchor(1) },
    { name: "play", run: (c) => void c.workspace.play().catch(() => undefined) },
    { name: "refreshArrangement", run: (c) => c.workspace.refreshArrangement() },
  ];
  test.each(commands)("$name", async ({ run }) => {
    const base = await setup();
    const audioTrack = base.project.addTrack("Audio", "audio");
    const clip = base.project.addAudioClip(audioTrack.id, { sampleRate: 100, channels: [new Float32Array(100)] }, 0);
    const ctx: Ctx = { ...base, clipId: clip.id };
    await ctx.workspace.flush();
    let runs = 0;
    const stop = effect(() => {
      runs++;
      run(ctx);
    });
    expect(runs).toBe(1);
    await ctx.workspace.flush();
    ctx.clock.state.value = "playing";
    ctx.project.setTitle("Elsewhere");
    ctx.project.setMasterVolume(0.9);
    ctx.project.setTrackName(ctx.track.id, "Renamed");
    ctx.project.setTempoChanges([{ beat: 4, bpm: 90 }]);
    ctx.clock.state.value = "stopped";
    stop();
    expect(runs).toBe(1);
    ctx.workspace.dispose();
    ctx.project.dispose();
  });
});

describe("workspace.sessionClip is a tracked reader", () => {
  test("a view effect re-runs when the Session grid changes", async () => {
    const { workspace, project } = await setup();
    const track = project.addTrack("Audio", "audio");
    await workspace.sync();
    const session = sessionFor(project);
    const scene = session.addScene();
    const first = session.setAudioClip({ trackId: track.id, sceneId: scene.id }, { sampleRate: 100, channels: [new Float32Array(100)] });
    const seen: Array<unknown> = [];
    const stop = effect(() => void seen.push(workspace.sessionClip(track.id, first.id)));
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe(workspace.session.value.tracks[track.id]!.clips[0]);
    session.setAudioClip({ trackId: track.id, sceneId: scene.id }, { sampleRate: 100, channels: [new Float32Array(100)] });
    expect(seen.length).toBeGreaterThan(1);
    expect(workspace.sessionClip(track.id, "missing")).toBeNull();
    // A timeline clip is not a Session clip.
    const timeline = project.addAudioClip(track.id, { sampleRate: 100, channels: [new Float32Array(100)] }, 0);
    expect(workspace.sessionClip(track.id, timeline.id)).toBeNull();
    stop();
    workspace.dispose();
    project.dispose();
  });
});

describe("workspace.position is a tracked reader", () => {
  test("a widget effect re-runs when the playhead is seeked", async () => {
    const { workspace, project } = await setup();
    const seen: number[] = [];
    const stop = effect(() => void seen.push(workspace.position));
    workspace.seek(2);
    stop();
    expect(seen).toEqual([0, 2]);
    workspace.dispose();
    project.dispose();
  });
});

describe("workspace observable state lives in cells", () => {
  test("session and auditions are the same read-only cells as their getters", async () => {
    const { workspace, project } = await setup();
    expect(workspace.cells.session).toBe(workspace.session);
    expect(workspace.cells.auditioningClip).toBe(workspace.auditioningClip);
    expect(workspace.cells.auditioningRange).toBe(workspace.auditioningRange);
    expect(workspace.cells.auditioningClip.value).toBeNull();
    expect(workspace.cells.auditioningRange.value).toBeNull();
    workspace.dispose();
    project.dispose();
  });
});

describe("layer placement of exports", () => {
  test("the pure project entry has no browser-storage writer", () => {
    expect("createOpfsAudioMediaWriter" in projectEntry).toBe(false);
    expect("exportAudioFallbackTo" in projectEntry).toBe(false);
    expect(typeof runtimeEntry.createOpfsAudioMediaWriter).toBe("function");
    expect(typeof runtimeEntry.exportAudioFallbackTo).toBe("function");
  });

  test("portabilityReport is a pure function of Project in the codec; Workspace has no such method", async () => {
    const { workspace, project } = await setup({ withDevice: true });
    expect("portabilityReport" in workspace).toBe(false);
    expect("exportAudioFallbackTo" in workspace).toBe(false);
    expect("portabilityReport" in runtimeEntry).toBe(false);
    const report = dawprojectEntry.portabilityReport(project, ["note"]);
    expect(report.standardContent).toContain("DAWproject track layout and fixed tempo");
    expect(report.pluginDependencies[0]).toMatch(/fake\.synth/);
    expect(report.limitations).toContain("note");
    workspace.dispose();
    project.dispose();
  });
});

describe("track creation failure", () => {
  test("a throwing TrackRack constructor releases the channel and send-bus entry", async () => {
    const project = new Project({ bpm: 120 });
    project.addTrack("Keys", "midi");
    fakes.rackError = new Error("rack failed");
    await expect(Workspace.create(context(), project)).rejects.toThrow("rack failed");
    const channel = fakes.channels.at(-1)!;
    const bus = fakes.buses.at(-1)!;
    expect(channel.dispose).toHaveBeenCalledTimes(1);
    expect(bus.define).toHaveBeenCalledTimes(1);
    expect(bus.undefine).toHaveBeenCalledWith(bus.define.mock.calls[0][0]);
    project.dispose();
  });
});

describe("project ownership", () => {
  test("a workspace opened from a file disposes the project it created", async () => {
    const source = new Project();
    source.addTrack("Keys", "midi");
    const workspace = await openWorkspace(context(), saveDawProject(source));
    const dispose = vi.spyOn(workspace.project, "dispose");
    workspace.dispose();
    expect(dispose).toHaveBeenCalledTimes(1);
    workspace.dispose();
    expect(dispose).toHaveBeenCalledTimes(1);
    source.dispose();
  });

  test("a project handed to Workspace.create stays with the caller", async () => {
    const { project, workspace } = await setup();
    const dispose = vi.spyOn(project, "dispose");
    workspace.dispose();
    expect(dispose).not.toHaveBeenCalled();
    project.dispose();
  });

  test("ownsProject hands the project over, and replacing it releases the claim", async () => {
    const owned = new Project();
    const first = await Workspace.create(context(), owned, { ownsProject: true });
    const disposeOwned = vi.spyOn(owned, "dispose");
    first.dispose();
    expect(disposeOwned).toHaveBeenCalledTimes(1);
    const original = new Project();
    const second = await Workspace.create(context(), original, { ownsProject: true });
    const replacement = new Project();
    second.project = replacement;
    const disposeOriginal = vi.spyOn(original, "dispose");
    const disposeReplacement = vi.spyOn(replacement, "dispose");
    second.dispose();
    expect(disposeOriginal).not.toHaveBeenCalled();
    expect(disposeReplacement).not.toHaveBeenCalled();
    original.dispose();
    replacement.dispose();
  });
});

describe("workspace cell aliases", () => {
  test("session, auditioningClip and auditioningRange are the same cell objects as workspace.cells", async () => {
    const { project, workspace } = await setup();
    expect(workspace.session).toBe(workspace.cells.session);
    expect(workspace.auditioningClip).toBe(workspace.cells.auditioningClip);
    expect(workspace.auditioningRange).toBe(workspace.cells.auditioningRange);
    workspace.dispose();
    project.dispose();
  });
});
