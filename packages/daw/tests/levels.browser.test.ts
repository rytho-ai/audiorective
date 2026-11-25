import { effect } from "@audiorective/core";
import { afterEach, describe, expect, test } from "vitest";
import { Project, Workspace } from "../src";

const RATE = 48_000;
const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const sine = (seconds: number) => ({
  sampleRate: RATE,
  channels: [Float32Array.from({ length: RATE * seconds }, (_, i) => 0.5 * Math.sin((2 * Math.PI * 220 * i) / RATE))],
});

async function until(check: () => boolean, label: string, timeout = 5000) {
  const start = performance.now();
  while (!check()) {
    if (performance.now() - start > timeout) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function setup() {
  const project = new Project({ bpm: 120 });
  const track = project.addTrack("Tone", "audio");
  project.addAudioClip(track.id, sine(4), 0);
  const context = new AudioContext({ sampleRate: RATE });
  const workspace = await Workspace.create(context, project, {});
  cleanups.push(async () => {
    workspace.dispose();
    project.dispose();
    await context.close();
  });
  return { project, workspace, track };
}

describe("workspace.cells.levels", () => {
  test("starts silent, rises while a clip plays and falls to -Infinity after stop", async () => {
    const { workspace, track } = await setup();
    expect(workspace.cells.levels.value).toEqual({ master: -Infinity, tracks: {} });
    await until(() => track.id in workspace.cells.levels.value.tracks, "the track entry");
    expect(workspace.cells.levels.value.tracks[track.id]).toBe(-Infinity);
    await workspace.play();
    await until(
      () => workspace.cells.levels.value.tracks[track.id]! > -Infinity && workspace.cells.levels.value.master > -Infinity,
      "levels to rise",
    );
    // A 0.5 amplitude sine through unity gain peaks near -6 dBFS.
    const { master, tracks } = workspace.cells.levels.value;
    expect(tracks[track.id]!).toBeLessThan(0);
    expect(tracks[track.id]!).toBeGreaterThan(-10);
    expect(master).toBeLessThan(0);
    workspace.stop();
    await until(
      () => workspace.cells.levels.value.master === -Infinity && workspace.cells.levels.value.tracks[track.id] === -Infinity,
      "silence after stop",
    );
  }, 30_000);

  test("is tracked: an effect re-runs when the levels change", async () => {
    const { workspace, track } = await setup();
    const seen: unknown[] = [];
    const stop = effect(() => void seen.push(workspace.cells.levels.value));
    try {
      await workspace.play();
      await until(() => seen.length > 1 && workspace.cells.levels.value.tracks[track.id]! > -Infinity, "a tracked change");
    } finally {
      stop();
    }
    expect(Object.is(seen[0], seen[seen.length - 1])).toBe(false);
  }, 30_000);

  test("includes a track added after create once it is synced, and drops a removed one", async () => {
    const { project, workspace, track } = await setup();
    await until(() => track.id in workspace.cells.levels.value.tracks, "the first track");
    const added = project.addTrack("Later", "audio");
    await workspace.sync();
    await until(() => added.id in workspace.cells.levels.value.tracks, "the added track");
    expect(workspace.cells.levels.value.tracks[added.id]).toBe(-Infinity);
    project.removeTrack(added.id);
    await workspace.sync();
    await until(() => !(added.id in workspace.cells.levels.value.tracks), "the removed track to leave");
  }, 30_000);

  test("stops its loop on dispose", async () => {
    const { workspace } = await setup();
    await until(() => "master" in workspace.cells.levels.value, "start");
    workspace.dispose();
    const frozen = workspace.cells.levels.value;
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(workspace.cells.levels.value).toBe(frozen);
  }, 30_000);
});
