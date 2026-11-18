import { beforeEach, describe, expect, test, vi } from "vitest";

const fakes = vi.hoisted(() => {
  const state = {
    hosts: [] as Array<{
      loadState: ReturnType<typeof import("vitest").vi.fn>;
      saveState: ReturnType<typeof import("vitest").vi.fn>;
      destroy: ReturnType<typeof import("vitest").vi.fn>;
    }>,
    clocks: [] as Array<{ stop: ReturnType<typeof import("vitest").vi.fn>; seek: ReturnType<typeof import("vitest").vi.fn> }>,
    racks: [] as Array<{ setEffects: ReturnType<typeof import("vitest").vi.fn> }>,
    loadStateImpl: undefined as undefined | ((bytes: Uint8Array) => Promise<void>),
  };
  return state;
});

vi.mock("@audiorective/effects/rack", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@audiorective/effects/rack")>()),
  EffectRack: class {
    effects: readonly unknown[];
    input = { connect: vi.fn() };
    output = { connect: vi.fn() };
    setEffects = vi.fn((effects: readonly unknown[]) => {
      this.effects = effects;
    });
    destroy = vi.fn();
    constructor(_context: unknown, effects: readonly unknown[]) {
      this.effects = effects;
      fakes.racks.push(this);
    }
  },
}));
vi.mock("@audiorective/host/webclap", () => ({
  WebClapHost: {
    load: vi.fn(async () => {
      const host = {
        descriptor: { id: "fake.synth" },
        input: {},
        output: { connect: vi.fn() },
        loadState: vi.fn(async (bytes: Uint8Array) => fakes.loadStateImpl?.(bytes)),
        saveState: vi.fn(async () => new Uint8Array([9, 9])),
        panic: vi.fn(),
        destroy: vi.fn(),
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
    destroy = vi.fn();
    constructor() {
      fakes.clocks.push(this);
    }
  }
  return { Clock, Timeline };
});

import { effect } from "@audiorective/core";
import { Project, Workspace, openWorkspace, saveWorkspace, saveWorkspaceTo } from "../src";
import { saveDawProject } from "../src/dawproject";

const node = () => {
  const target: Record<string, unknown> = {
    gain: { setValueAtTime: vi.fn(), cancelScheduledValues: vi.fn() },
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
    workspace.destroy();
    project.destroy();
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
    workspace.destroy();
    project.destroy();
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
    workspace.destroy();
    project.destroy();
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
    workspace.destroy();
    project.destroy();
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
    workspace.destroy();
    project.destroy();
  });

  test("Workspace mixer writes apply immediately and Project mixer edits apply once without refreshing Arrangement", async () => {
    const { project, track, workspace, clock } = await setup();
    const masterGain = vi.mocked(workspace.output.gain.setValueAtTime);
    masterGain.mockClear();
    const refreshes = clock.refresh.mock.calls.length;
    workspace.setTrackVolume(track.id, 0.4);
    workspace.setTrackPan(track.id, -1);
    expect(masterGain).toHaveBeenCalledTimes(2);
    await workspace.flush();
    expect(masterGain).toHaveBeenCalledTimes(2);
    expect(clock.refresh.mock.calls.length).toBe(refreshes);
    project.setTrackVolume(track.id, 0.6);
    await workspace.flush();
    expect(masterGain).toHaveBeenCalledTimes(3);
    expect(clock.refresh.mock.calls.length).toBe(refreshes);
    workspace.destroy();
    project.destroy();
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
    workspace.destroy();
    project.destroy();
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
    workspace.destroy();
    project.destroy();
  });

  test("replacing the project reapplies; destroy drops pending work and flush still resolves", async () => {
    const { project, workspace, clock } = await setup();
    const other = new Project({ bpm: 90 });
    other.addTrack("Other", "audio");
    workspace.project = other;
    await workspace.flush();
    expect(workspace.cells.needsSync.value).toBe(true);
    await workspace.sync();
    project.setTempoChanges([{ beat: 1, bpm: 50 }]);
    other.setTempoChanges([{ beat: 1, bpm: 50 }]);
    workspace.destroy();
    const seeks = clock.seek.mock.calls.length;
    await expect(workspace.flush()).resolves.toBeUndefined();
    other.setTempoChanges([{ beat: 2, bpm: 50 }]);
    await tick();
    expect(clock.seek.mock.calls.length).toBe(seeks);
    await expect(workspace.sync()).rejects.toThrow("Workspace is destroyed.");
    project.destroy();
    other.destroy();
  });
});

/** Public stateful readers are tracked: an effect over each re-runs, seeing the new value, when the owner changes it. */
describe("workspace composition", () => {
  test("saveWorkspace captures device state and reopens through openWorkspace", async () => {
    const { project, device, workspace } = await setup({ withDevice: true });
    const bytes = await saveWorkspace(workspace);
    expect([...project.tracks[0].devices.find((item) => item.id === device!.id)!.state]).toEqual([9, 9]);
    const reopened = await openWorkspace(context(), bytes);
    expect(reopened.project.tracks[0].devices[0].pluginId).toBe("fake.synth");
    expect([...reopened.project.tracks[0].devices[0].state]).toEqual([9, 9]);
    reopened.destroy();
    reopened.project.destroy();
    workspace.destroy();
    project.destroy();
  });

  test("saveWorkspaceTo streams the checkpointed project", async () => {
    const { project, workspace } = await setup({ withDevice: true });
    const parts: Uint8Array[] = [];
    await saveWorkspaceTo(workspace, new WritableStream({ write: (chunk) => void parts.push(chunk) }));
    expect(parts.reduce((total, part) => total + part.length, 0)).toBeGreaterThan(0);
    workspace.destroy();
    project.destroy();
  });

  test("checkpoint rejects once the workspace is destroyed", async () => {
    const { project, workspace } = await setup();
    workspace.destroy();
    await expect(workspace.checkpoint()).rejects.toThrow("Workspace is destroyed.");
    await expect(saveWorkspace(workspace)).rejects.toThrow("Workspace is destroyed.");
    project.destroy();
  });

  test("file warnings and options warnings lead the workspace's own warnings", async () => {
    const source = new Project();
    const track = source.addTrack("Keys", "midi");
    source.addWebClapDevice(track.id, { pluginId: "fake.synth", name: "Synth", vendor: "t", version: "1", bundleUrl: "/fake.wasm" });
    const bytes = saveDawProject(source);
    const workspace = await openWorkspace(context(), bytes, { warnings: ["caller note"] });
    expect(workspace.warnings.slice(0, 1)).toEqual(["caller note"]);
    workspace.destroy();
    workspace.project.destroy();
  });

  test("a failed open destroys the opened project", async () => {
    const source = new Project();
    source.addTrack("Keys", "midi");
    const bytes = saveDawProject(source);
    const broken = {
      ...context(),
      createGain: () => {
        throw new Error("no audio");
      },
    } as unknown as AudioContext;
    const destroy = vi.spyOn(Project.prototype, "destroy");
    try {
      await expect(openWorkspace(broken, bytes)).rejects.toThrow("no audio");
      expect(destroy).toHaveBeenCalledTimes(1);
    } finally {
      destroy.mockRestore();
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
    workspace.destroy();
    project.destroy();
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
    workspace.destroy();
    project.destroy();
  });
});
