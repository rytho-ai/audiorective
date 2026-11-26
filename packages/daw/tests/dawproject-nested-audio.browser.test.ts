import { afterEach, expect, test } from "vitest";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { Workspace, openDawProject, renderMixRange, saveDawProject } from "../src";
import type { AudioClip, Project } from "../src";

/**
 * Playback of an audio clip read from Bitwig's nested form. `b-bitwig-native` (Bitwig Studio 6.1.7) is a 44.1 kHz click recording with clicks at
 * 0.5, 1.5, 2.5 and 3.5 s, 8 beats long, placed at beat 1; its Warps are the identity at 120 BPM, so the file is opened with its tempo set there.
 * The clicks of the rendered 48 kHz mix must fall on the frames the clip's place implies.
 */
const RATE = 48_000;
const worklet = "/@fs" + new URL("../../host/dist/webclap-worklet.js", import.meta.url).pathname.replace(/^\/@fs/, "");
const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function bitwigFile(bpm: number): Promise<Uint8Array> {
  const response = await fetch(new URL("./fixtures/dawproject/b-bitwig-native.dawproject", import.meta.url).href);
  const entries = unzipSync(new Uint8Array(await response.arrayBuffer()));
  entries["project.xml"] = strToU8(
    strFromU8(entries["project.xml"])
      .replaceAll('value="100.000000" id="id0"', `value="${bpm}.000000" id="id0"`)
      .replace('<RealPoint value="100.000000"', `<RealPoint value="${bpm}.000000"`),
  );
  return zipSync(entries);
}

async function mixOf(project: Project, seconds: number): Promise<Float32Array> {
  const context = new AudioContext({ sampleRate: RATE });
  const workspace = await Workspace.create(context, project, { workletUrl: worklet });
  cleanups.push(async () => {
    workspace.dispose();
    await context.close();
  });
  const result = await renderMixRange(workspace, { expectedVersion: project.cells.version.value, range: { startSeconds: 0, endSeconds: seconds } });
  if (result.status !== "rendered") throw new Error(result.status);
  return Float32Array.from(result.audio.channels[0]);
}

/** The largest absolute sample in frames `[from, to)`. */
function loudest(x: Float32Array, from = 0, to = x.length): number {
  let best = 0;
  for (let i = from; i < Math.min(to, x.length); i++) best = Math.max(best, Math.abs(x[i]));
  return best;
}

/** The frame of the loudest sample within `radius` frames of `around`. */
function peakNear(x: Float32Array, around: number, radius: number): number {
  let best = Math.max(0, around - radius);
  for (let i = best; i <= Math.min(x.length - 1, around + radius); i++) if (Math.abs(x[i]) > Math.abs(x[best])) best = i;
  return best;
}

test("the clicks of a Bitwig audio clip land on the frames its place implies, at 48 kHz from a 44.1 kHz file", async () => {
  const { project, warnings } = openDawProject(await bitwigFile(120));
  cleanups.push(() => project.dispose());
  expect(warnings.join()).not.toMatch(/Audio clip/);
  const clip = project.tracks.flatMap((track) => track.clips).find((item): item is AudioClip => item.kind === "audio")!;
  // Beat 1 at 120 BPM is 0.5 s; the recording's clicks sit 0.5 s, 1.5 s, 2.5 s and 3.5 s into it.
  expect(clip.time).toBe(0.5);
  const x = await mixOf(project, 5);
  expect(loudest(x)).toBeGreaterThan(0.1);
  // The 44.1 kHz file goes through the decode path's resampler, whose impulse response peaks on a frame or a neighbour of it (measured: 0 or +1);
  // a placement error of a whole clip position, a tempo conversion or a window offset would be hundreds of frames.
  const tolerance = 2;
  const found = [1, 2, 3, 4].map((second) => peakNear(x, second * RATE, 200));
  for (const [i, frame] of found.entries())
    expect(Math.abs(frame - (i + 1) * RATE), `click ${i + 1} at frame ${frame}`).toBeLessThanOrEqual(tolerance);
  // Nothing sounds before the clip starts or after its last click has died away.
  expect(loudest(x, 0, RATE - 400)).toBeLessThan(1e-3);
});

test("the same clip moved one beat and saved plays one beat later", async () => {
  const { project } = openDawProject(await bitwigFile(120));
  cleanups.push(() => project.dispose());
  const clip = project.tracks.flatMap((track) => track.clips).find((item): item is AudioClip => item.kind === "audio")!;
  project.moveClip(clip.id, project.tracks[1].id, clip.time + 0.5);
  const reopened = openDawProject(saveDawProject(project));
  cleanups.push(() => reopened.project.dispose());
  const x = await mixOf(reopened.project, 5.5);
  const first = peakNear(x, 1.5 * RATE, 200);
  expect(Math.abs(first - 1.5 * RATE)).toBeLessThanOrEqual(2);
  expect(loudest(x, 0, RATE * 1.5 - 400)).toBeLessThan(1e-3);
});
