import { ManualTickSource } from "@audiorective/clock";
import { describe, expect, test } from "vitest";
import { AudioMedia, Project, Workspace } from "../src";

const RATE = 48_000;
const QUANTUM = 128;
const pattern = (frames: number) => Float32Array.from({ length: frames }, (_, i) => (((i * 7919) % 2003) / 2003 - 0.5) * 0.6);

async function render(
  project: Project,
  seconds: number,
  setup: (workspace: Workspace) => void,
  during?: (workspace: Workspace, time: number) => void,
) {
  const frames = Math.round(seconds * RATE);
  const context = new OfflineAudioContext(2, frames, RATE);
  const ticks = new ManualTickSource();
  const workspace = await Workspace.create(context as unknown as AudioContext, project, { destination: context.destination, tickSource: ticks });
  setup(workspace);
  await workspace.play();
  ticks.tick();
  await workspace.renderSettled();
  let index = 1;
  let previous = 0;
  const next = () => {
    previous = Math.max(Math.ceil((index++ * 0.025 * RATE) / QUANTUM) * QUANTUM, previous + QUANTUM);
    return previous < frames ? previous : undefined;
  };
  const suspendAt = (frame: number) => context.suspend((frame - QUANTUM / 2) / RATE);
  let stop = next();
  let suspended = stop === undefined ? undefined : suspendAt(stop);
  const rendering = context.startRendering();
  const positions: number[] = [];
  while (stop !== undefined && suspended) {
    await suspended;
    positions.push(workspace.position);
    during?.(workspace, stop / RATE);
    ticks.tick();
    await workspace.renderSettled();
    stop = next();
    suspended = stop === undefined ? undefined : suspendAt(stop);
    await context.resume();
  }
  const buffer = await rendering;
  workspace.dispose();
  return { left: buffer.getChannelData(0), positions };
}

function worst(actual: Float32Array, source: Float32Array, frameOf: (frame: number) => number, from = 0, to = actual.length) {
  const gain = actual[from + 7] / source[frameOf(from + 7)];
  expect(Math.abs(gain)).toBeGreaterThan(0.5);
  let max = 0;
  let at = -1;
  for (let frame = from; frame < to; frame++) {
    const difference = Math.abs(actual[frame] - source[frameOf(frame)] * gain);
    if (difference > max) {
      max = difference;
      at = frame;
    }
  }
  return { max, at };
}

function tempoSong() {
  const project = new Project({ bpm: 120 });
  project.setTempoChanges([{ beat: 4, bpm: 60 }]);
  const track = project.addTrack("Bed", "audio");
  return { project, track };
}

describe("workspace loop through the audio graph", () => {
  // Beat 2 = 1 s, beat 4 = 2 s, beat 6 = 4 s, so the region lasts 3 s across a tempo change.
  const startFrame = RATE;
  const endFrame = 4 * RATE;
  const folded = (frame: number) => (frame < endFrame ? frame : startFrame + ((frame - endFrame) % (endFrame - startFrame)));

  test("repeats a region across a tempo change on the exact frames, for a clip crossing both edges", async () => {
    const { project, track } = tempoSong();
    const source = pattern(8 * RATE);
    project.addAudioClip(track.id, { sampleRate: RATE, channels: [source] }, 0);
    const { left, positions } = await render(project, 11, (workspace) => {
      workspace.loop.setRegion({ startBeat: 2, endBeat: 6 });
      workspace.loop.setEnabled(true);
    });
    const { max, at } = worst(left, source, folded);
    expect(max, `worst frame ${at}`).toBeLessThan(1e-5);
    expect(Math.max(...positions)).toBeLessThanOrEqual(4 + 1e-6);
    expect(Math.min(...positions.slice(positions.findIndex((p) => p > 3.9)))).toBeGreaterThanOrEqual(1 - 1e-6);
  }, 30_000);

  test("repeats file-backed media on the exact frames", async () => {
    const { project, track } = tempoSong();
    const source = pattern(8 * RATE);
    project.addAudioMediaClip(track.id, new AudioMedia(new Blob([source.slice().buffer]), RATE, 1, source.length), 0);
    const { left } = await render(project, 9, (workspace) => {
      workspace.loop.setRegion({ startBeat: 2, endBeat: 6 });
      workspace.loop.setEnabled(true);
    });
    const { max, at } = worst(left, source, folded);
    expect(max, `worst frame ${at}`).toBeLessThan(1e-5);
  }, 30_000);

  test("repeats volume automation with the region", async () => {
    const project = new Project({ bpm: 60 });
    const track = project.addTrack("Bed", "audio");
    project.addAudioClip(track.id, { sampleRate: RATE, channels: [new Float32Array(6 * RATE).fill(0.5)] }, 0);
    project.setVolumeAutomation(track.id, [
      { time: 1, value: 0, shape: "linear" },
      { time: 2, value: 1, shape: "hold" },
    ]);
    const { left } = await render(project, 5, (workspace) => {
      workspace.loop.setRegion({ startBeat: 1, endBeat: 2 });
      workspace.loop.setEnabled(true);
    });
    const peak = Math.max(...left.subarray(1.9 * RATE, 1.99 * RATE));
    for (const second of [2.5, 3.5]) expect(left[Math.round(second * RATE)]).toBeCloseTo(peak * (0.5 / 0.99), 1);
    expect(Math.abs(left[Math.round(3.01 * RATE)])).toBeLessThan(0.05);
  }, 30_000);

  test("turning the loop off keeps playing past the region, with the clip uncut", async () => {
    const project = new Project({ bpm: 60 });
    const track = project.addTrack("Bed", "audio");
    const source = pattern(6 * RATE);
    project.addAudioClip(track.id, { sampleRate: RATE, channels: [source] }, 0);
    let off = false;
    const { left, positions } = await render(
      project,
      5,
      (workspace) => {
        workspace.loop.setRegion({ startBeat: 1, endBeat: 2 });
        workspace.loop.setEnabled(true);
      },
      (workspace, time) => {
        if (!off && time > 2.5) {
          off = true;
          workspace.loop.setEnabled(false);
        }
      },
    );
    expect(Math.max(...positions)).toBeGreaterThan(3);
    expect(workspaceRegionKept(left)).toBe(true);
  }, 30_000);

  test("moving the region while playing keeps every sounding frame exact", async () => {
    const project = new Project({ bpm: 60 });
    const track = project.addTrack("Bed", "audio");
    const source = pattern(10 * RATE);
    project.addAudioClip(track.id, { sampleRate: RATE, channels: [source] }, 0);
    let moved = false;
    let changes = 0;
    const { left } = await render(
      project,
      8,
      (workspace) => {
        workspace.loop.setRegion({ startBeat: 1, endBeat: 2 });
        workspace.loop.setEnabled(true);
      },
      (workspace, time) => {
        // Like a ruler drag: many small region changes while the end stays ahead of the playhead.
        if (time > 0.2 && time < 0.8) {
          changes++;
          workspace.loop.setRegion({ startBeat: 1, endBeat: 2 + changes / 1000 });
        }
        if (!moved && time >= 0.8) {
          moved = true;
          workspace.loop.setRegion({ startBeat: 2, endBeat: 4 });
        }
      },
    );
    expect(changes).toBeGreaterThan(10);
    const end = 4 * RATE;
    const expected = (frame: number) => (frame < end ? frame : 2 * RATE + ((frame - end) % (2 * RATE)));
    const { max, at } = worst(left, source, expected);
    expect(max, `worst frame ${at}`).toBeLessThan(1e-5);
  }, 30_000);

  test("from past the region it plays on, and it leaves the Project alone", async () => {
    const project = new Project({ bpm: 60 });
    const track = project.addTrack("Bed", "audio");
    const source = pattern(5 * RATE);
    project.addAudioClip(track.id, { sampleRate: RATE, channels: [source] }, 0);
    const version = project.cells.version.value;
    const { positions } = await render(project, 2, (workspace) => {
      workspace.seek(3);
      workspace.loop.setRegion({ startBeat: 1, endBeat: 2 });
      workspace.loop.setEnabled(true);
    });
    expect(positions.at(-1)!).toBeGreaterThan(4.5);
    expect(project.cells.version.value).toBe(version);
    expect(project.cells.history.value).toEqual({});
  }, 30_000);

  test("places a take by the loop that was playing when it was armed", async () => {
    const project = new Project({ bpm: 60 });
    const track = project.addTrack("Bed", "audio");
    project.addAudioClip(track.id, { sampleRate: RATE, channels: [pattern(4 * RATE)] }, 0);
    const context = new OfflineAudioContext(2, RATE * 6, RATE);
    const ticks = new ManualTickSource();
    const workspace = await Workspace.create(context as unknown as AudioContext, project, { destination: context.destination, tickSource: ticks });
    workspace.loop.setRegion({ startBeat: 0, endBeat: 2 });
    workspace.loop.setEnabled(true);
    await workspace.play();
    let started = false;
    // Everything is checked while the render is suspended, so the transport cannot move between the steps.
    const whileSuspendedAt = async (seconds: number, check: (anchor: ReturnType<Workspace["takeAnchor"]>) => void) => {
      const pending = context.suspend(seconds);
      if (!started) void context.startRendering();
      started = true;
      await pending;
      check(workspace.takeAnchor(seconds));
      await context.resume();
    };
    await whileSuspendedAt(1.9, (near) => {
      expect(workspace.takePosition(near, { startTime: 2.2 })).toBeCloseTo(0.2, 2);
      workspace.loop.setEnabled(false);
      expect(workspace.takePosition(near, { startTime: 2.2 })).toBeCloseTo(0.2, 2);
      workspace.loop.setEnabled(true);
    });
    await whileSuspendedAt(4.03, (afterWrap) => {
      expect(afterWrap.projectTime).toBeCloseTo(0.03, 2);
      expect(workspace.takePosition(afterWrap, { startTime: 4.03 }, 0.05)).toBeCloseTo(1.98, 2);
    });
    workspace.dispose();
  }, 20_000);

  test("validates its region", async () => {
    const project = new Project({ bpm: 120 });
    const context = new OfflineAudioContext(2, RATE, RATE);
    const workspace = await Workspace.create(context as unknown as AudioContext, project, { tickSource: new ManualTickSource() });
    expect(() => workspace.loop.setEnabled(true)).toThrow(/needs a region/);
    expect(() => workspace.loop.setRegion({ startBeat: 2, endBeat: 1 })).toThrow(/startBeat/);
    expect(() => workspace.loop.setRegion({ startBeat: 0, endBeat: 0.001 })).toThrow(/20 ms/);
    workspace.loop.setRegion({ startBeat: 0, endBeat: 4 });
    workspace.loop.setEnabled(true);
    workspace.loop.setEnabled(false);
    expect(workspace.loop.cells.region.value).toEqual({ startBeat: 0, endBeat: 4 });
    workspace.loop.setEnabled(true);
    workspace.loop.setRegion(null);
    expect(workspace.loop.cells.enabled.value).toBe(false);
    workspace.dispose();
  });
});

const workspaceRegionKept = (left: Float32Array) => Math.max(...left.subarray(4 * RATE, 4.5 * RATE).map(Math.abs)) > 0.05;
