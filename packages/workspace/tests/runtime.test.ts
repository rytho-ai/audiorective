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

vi.mock("@audiorective/blocks", () => ({ AudioRecorder: class {} }));
vi.mock("@audiorective/blocks/effect-rack", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@audiorective/blocks/effect-rack")>()),
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

import { Project, Workspace } from "../src";

const node = () => {
  const target: Record<string, unknown> = {
    gain: { setValueAtTime: vi.fn() },
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
    await workspace.save();
    expect(project.cells.revision.value).toBeGreaterThan(revision);
    expect([...project.tracks[0].devices.find((item) => item.id === device!.id)!.state]).toEqual([9, 9]);
    await workspace.flush();
    await tick();
    expect(fakes.hosts[0].loadState.mock.calls.length).toBe(loads);
    expect(clock.seek.mock.calls.length).toBe(seeks);
    workspace.destroy();
    project.destroy();
  });

  test("workspace mixer and effect methods do not trigger a second application", async () => {
    const { project, track, workspace, clock } = await setup();
    const refreshes = clock.refresh.mock.calls.length;
    workspace.setTrackVolume(track.id, 0.4);
    workspace.setTrackPan(track.id, -1);
    await workspace.flush();
    expect(clock.refresh.mock.calls.length).toBe(refreshes);
    project.setTrackVolume(track.id, 0.6); // a direct Project edit does apply once
    await workspace.flush();
    expect(clock.refresh.mock.calls.length).toBe(refreshes + 1);
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
