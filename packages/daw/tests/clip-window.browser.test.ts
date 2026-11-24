import { unzipSync } from "fflate";
import { afterEach, expect, test } from "vitest";
import { Project, Workspace, exportAudioFallbackTo, openDawProject, saveDawProject } from "../src";

const RATE = 48_000;
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** Deterministic PCM whose every frame differs from its neighbours. */
const pattern = (frames: number) => Float32Array.from({ length: frames }, (_, i) => (((i * 7919 + 104729) % 2003) / 2003 - 0.5) * 0.9);

async function stemOf(project: Project): Promise<Float32Array> {
  const context = new AudioContext({ sampleRate: RATE });
  const workspace = await Workspace.create(context, project);
  cleanups.push(async () => {
    workspace.dispose();
    project.dispose();
    await context.close();
  });
  const parts: Uint8Array[] = [];
  await exportAudioFallbackTo(workspace, new WritableStream({ write: (chunk) => void parts.push(chunk) }), { tailSeconds: 0 });
  const files = unzipSync(new Uint8Array(await new Blob(parts as BlobPart[]).arrayBuffer()));
  const bytes = files[`tracks/${project.tracks[0].id}.wav`];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return Float32Array.from({ length: (bytes.length - 44) / 8 }, (_, frame) => view.getFloat32(44 + frame * 8, true));
}

test("audio revealed after a reopen plays the original recording", async () => {
  const original = pattern(3 * RATE);
  const source = new Project({ bpm: 120 });
  const track = source.addTrack("Take", "audio");
  const whole = source.addAudioClip(track.id, { sampleRate: RATE, channels: [original] }, 0);
  const [first, rest] = source.splitClip(whole.id, 1);
  const [middle] = source.splitClip(rest.id, 1);
  source.removeClip(middle.id);
  const { project, warnings } = openDawProject(saveDawProject(source));
  source.dispose();
  expect(warnings).toEqual([]);
  project.resizeClip(first.id, { end: 2 }); // reveals the removed middle; the last piece still plays 2 to 3 s
  const stem = await stemOf(project);
  // The centred mono clip meets the stem through a constant pan gain.
  let loudest = 0;
  for (let i = 0; i < original.length; i++) if (Math.abs(original[i]) > Math.abs(original[loudest])) loudest = i;
  const gain = stem[loudest] / original[loudest];
  expect(gain).toBeGreaterThan(0.5);
  let worst = 0;
  for (let i = 0; i < original.length; i++) worst = Math.max(worst, Math.abs(stem[i] - original[i] * gain));
  expect(worst).toBeLessThan(1e-6);
});
