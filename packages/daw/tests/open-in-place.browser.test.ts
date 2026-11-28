import { effect } from "@audiorective/core";
import { afterEach, describe, expect, test } from "vitest";
import { Project, Workspace, openWorkspace, saveDawProject, saveWorkspace } from "../src";

const RATE = 48_000;
const worklet = "/@fs" + new URL("../../host/dist/webclap-worklet.js", import.meta.url).pathname.replace(/^\/@fs/, "");
const bundle = "/@fs" + new URL("../../../apps/daw-demo/public/plugin/oxo-synth2.wclap", import.meta.url).pathname.replace(/^\/@fs/, "");
const pluginId = "com.oxo.music.oxosynth2";
const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const tone = (seconds: number) => ({ sampleRate: RATE, channels: [Float32Array.from({ length: RATE * seconds }, (_, i) => 0.5 * Math.sin(i / 20))] });

/** A song with `tracks` audio tracks, a tone on each, saved as `.dawproject` bytes. */
function songBytes(bpm: number, tracks: number): Uint8Array {
  const project = new Project({ bpm });
  for (let i = 0; i < tracks; i++) project.addAudioClip(project.addTrack(`T${i}`, "audio").id, tone(4), 0);
  const bytes = saveDawProject(project);
  project.dispose();
  return bytes;
}

async function running(bytes: Uint8Array, options = {}) {
  const context = new AudioContext({ sampleRate: RATE });
  const workspace = await openWorkspace(context, bytes, options);
  cleanups.push(async () => {
    workspace.dispose();
    await context.close();
  });
  await context.resume();
  return { context, workspace };
}

describe("workspace.open", () => {
  test("replaces the song in the same Workspace and keeps bindings firing", async () => {
    const { workspace } = await running(songBytes(120, 2));
    const first = workspace.project;
    const projects: Project[] = [];
    const levels: unknown[] = [];
    const warned: unknown[] = [];
    const stops = [
      effect(() => void projects.push(workspace.project)),
      effect(() => void levels.push(workspace.cells.levels.value)),
      effect(() => void warned.push(workspace.cells.warnings.value)),
    ];
    cleanups.push(() => stops.forEach((stop) => stop()));
    const cells = workspace.cells;
    const loop = workspace.loop;

    await workspace.open(songBytes(90, 1));

    expect(workspace.cells).toBe(cells);
    expect(workspace.loop).toBe(loop);
    expect(workspace.project).not.toBe(first);
    expect(workspace.project.bpm).toBe(90);
    expect(workspace.project.tracks).toHaveLength(1);
    expect(projects.at(-1)).toBe(workspace.project);
    expect(workspace.cells.needsSync.value).toBe(false);
    expect(workspace.cells.error.value).toBeNull();
    expect(() => first.addTrack("x", "audio")).toThrow("Project is disposed.");

    const seen = levels.length;
    await workspace.play();
    await sleep(500);
    expect(levels.length).toBeGreaterThan(seen);
    const last = workspace.cells.levels.value;
    expect(Object.keys(last.tracks)).toEqual([workspace.project.tracks[0].id]);
    expect(Math.max(last.master, ...Object.values(last.tracks))).toBeGreaterThan(-Infinity);
  }, 30_000);

  test("accepts a Blob and a project the caller owns stays alive", async () => {
    const context = new AudioContext({ sampleRate: RATE });
    const own = new Project({ bpm: 100 });
    own.addTrack("A", "audio");
    const workspace = await Workspace.create(context, own, {});
    cleanups.push(async () => {
      workspace.dispose();
      own.dispose();
      await context.close();
    });
    await workspace.open(new Blob([songBytes(80, 2)]));
    expect(workspace.project.tracks).toHaveLength(2);
    expect(() => own.addTrack("still mine", "audio")).not.toThrow();
  });

  test("restores WebCLAP device state like openWorkspace", async () => {
    const project = new Project({ bpm: 120 });
    const track = project.addTrack("Synth", "midi");
    project.addDevice(track.id, { kind: "webclap", pluginId, name: "Synth", vendor: "", version: "", bundleUrl: bundle });
    const source = await Workspace.create(new AudioContext({ sampleRate: RATE }), project, { workletUrl: worklet });
    const host = source.host(project.tracks[0].devices[0].id)!;
    const info = host.parameterInfo[0];
    const edited = Math.round(info.min + (info.max - info.min) * 0.25);
    host.params[String(info.id) as `${number}`].value = edited;
    const bytes = await saveWorkspace(source);
    cleanups.push(async () => {
      source.dispose();
      project.dispose();
      await source.context.close();
    });

    const { workspace } = await running(songBytes(120, 1), { workletUrl: worklet });
    expect(workspace.cells.warnings.value).toEqual([]);
    await workspace.open(bytes, { resolveBundle: () => bundle });
    const again = workspace.host(workspace.project.tracks[0].devices[0].id)!;
    expect(again.params[String(info.id) as `${number}`].value).toBeCloseTo(edited, 4);
    // The option stays for the next sync.
    workspace.project.addTrack("More", "audio");
    await workspace.sync();
    expect(workspace.host(workspace.project.tracks[0].devices[0].id)).toBeTruthy();
  }, 40_000);

  test("a Project replaces the song with the same guarantees as a file, and ownership follows ownsProject", async () => {
    const { workspace } = await running(songBytes(120, 2));
    const first = workspace.project;
    workspace.loop.setRegion({ startBeat: 0, endBeat: 4 });
    workspace.loop.setEnabled(true);
    await workspace.play();
    await sleep(300);
    const cells = workspace.cells;
    const launcher = workspace.cells.session.value;
    const mine = new Project({ bpm: 90 });
    mine.addAudioClip(mine.addTrack("Mine", "audio").id, tone(4), 0);
    // The old song keeps playing until the new one is ready, then everything switches in one step.
    const opening = workspace.open(mine);
    expect(workspace.project).toBe(first);
    await opening;
    expect(workspace.project).toBe(mine);
    expect(workspace.cells).toBe(cells);
    expect(workspace.cells.session.value).not.toBe(launcher);
    expect(workspace.player.isPlaying.value).toBe(false);
    expect(workspace.position).toBe(0);
    expect(workspace.loop.cells.region.value).toBeNull();
    expect(workspace.loop.cells.enabled.value).toBe(false);
    expect(workspace.cells.needsSync.value).toBe(false);
    // The Workspace owned the first song, so it disposed it; the Project passed in stays with the caller.
    expect(() => first.addTrack("x", "audio")).toThrow("Project is disposed.");
    await workspace.play();
    await sleep(300);
    expect(workspace.position).toBeGreaterThan(0);
    workspace.dispose();
    expect(() => mine.addTrack("still mine", "audio")).not.toThrow();
    mine.dispose();
  }, 30_000);

  test("a Project given with ownsProject is disposed by the Workspace when the next song replaces it", async () => {
    const { workspace } = await running(songBytes(120, 1));
    const handed = new Project({ bpm: 100 });
    handed.addTrack("A", "audio");
    await workspace.open(handed, { ownsProject: true });
    const next = new Project({ bpm: 100 });
    await workspace.open(next);
    expect(() => handed.addTrack("x", "audio")).toThrow("Project is disposed.");
    next.dispose();
  }, 30_000);

  test("a bad file rejects and the current song plays on untouched", async () => {
    const { workspace } = await running(songBytes(120, 2));
    await workspace.play();
    await sleep(200);
    const project = workspace.project;
    const before = workspace.position;
    await expect(workspace.open(new Uint8Array([1, 2, 3, 4]))).rejects.toThrow();
    await expect(workspace.open(new Blob(["not a zip"]))).rejects.toThrow();
    await sleep(300);
    expect(workspace.project).toBe(project);
    expect(workspace.player.isPlaying.value).toBe(true);
    expect(workspace.position).toBeGreaterThan(before);
    expect(workspace.cells.error.value).toBeNull();
    await expect(openWorkspace(workspace.context, new Uint8Array([1, 2, 3, 4]))).rejects.toThrow();
    expect(() => project.addTrack("alive", "audio")).not.toThrow();
  }, 30_000);

  test("opening during playback stops at 0 and the new song plays", async () => {
    const { workspace } = await running(songBytes(120, 1));
    await workspace.play();
    await sleep(300);
    expect(workspace.position).toBeGreaterThan(0);
    await workspace.open(songBytes(120, 1));
    expect(workspace.player.isPlaying.value).toBe(false);
    expect(workspace.position).toBe(0);
    await workspace.play();
    await sleep(300);
    expect(workspace.player.isPlaying.value).toBe(true);
    expect(workspace.position).toBeGreaterThan(0);
  }, 30_000);

  test("the loop is cleared and its cells follow", async () => {
    const { workspace } = await running(songBytes(120, 1));
    workspace.loop.setRegion({ startBeat: 0, endBeat: 4 });
    workspace.loop.setEnabled(true);
    const enabled: boolean[] = [];
    const stop = effect(() => void enabled.push(workspace.loop.cells.enabled.value));
    cleanups.push(stop);
    await workspace.play();
    await workspace.open(songBytes(120, 1));
    expect(workspace.loop.cells.enabled.value).toBe(false);
    expect(workspace.loop.cells.region.value).toBeNull();
    expect(enabled.at(-1)).toBe(false);
    await workspace.play();
    await sleep(300);
    expect(workspace.position).toBeGreaterThan(0);
  }, 30_000);

  test("the Session launcher is rebuilt for the new song", async () => {
    const { workspace } = await running(songBytes(120, 1));
    const launcher = workspace.cells.session.value;
    const seen: unknown[] = [];
    const stop = effect(() => void seen.push(workspace.cells.session.value));
    cleanups.push(stop);
    await workspace.open(songBytes(120, 2));
    expect(workspace.cells.session.value).not.toBe(launcher);
    expect(Object.keys(workspace.cells.session.value.tracks)).toHaveLength(2);
    expect(seen.at(-1)).toBe(workspace.cells.session.value);
  });

  test("rejects on a disposed Workspace", async () => {
    const { workspace } = await running(songBytes(120, 1));
    workspace.dispose();
    await expect(workspace.open(songBytes(120, 1))).rejects.toThrow("Workspace is disposed.");
  });
});
