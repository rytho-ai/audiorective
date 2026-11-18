import { expect, test } from "vitest";
import { unzipSync, zipSync } from "fflate";
import { AudioMedia, Project, openDawProject, openDawProjectBlob, saveDawProject, saveDawProjectTo } from "../src";

const original = Float32Array.from({ length: 40 }, (_, index) => index / 40);
const frames = (count: number) => ({ sampleRate: 100, channels: [new Float32Array(count).fill(0.5)] });

test("retains the original PCM, carries its window through a split and reopens the rendered playback", () => {
  const project = new Project();
  const track = project.addTrack("Track", "audio");
  const clip = project.addAudioClip(track.id, { sampleRate: 100, channels: [original] }, 1, {
    envelope: { gain: 0.8, fadeIn: 0.01, fadeOut: 0.02 },
  });
  const stretched = project.applyAudioClipStretch(clip, 2, frames(80));
  expect(stretched.time).toBe(1);
  expect(stretched.duration).toBe(0.8);
  expect(stretched.envelope).toEqual({ gain: 0.8, fadeIn: 0.02, fadeOut: 0.04 });
  expect(stretched.stretch?.source.channels?.[0]).toEqual(original);
  const snapshot = project.snapshot();
  const snapshotClip = snapshot.tracks[0].clips[0];
  if (snapshotClip.kind !== "audio") throw new Error("Expected an audio clip.");
  expect(snapshotClip.stretch?.source.channels?.[0]).toEqual(original);
  expect(snapshotClip.stretch?.source.channels?.[0]).not.toBe(stretched.stretch?.source.channels?.[0]);
  snapshot.destroy();
  expect(() => project.applyAudioClipStretch(clip, 3, frames(120))).toThrow(/changed/);
  const [, tail] = project.splitClip(clip.id, 0.3);
  expect(tail).toMatchObject({ kind: "audio", time: 1.3, duration: 0.5 });
  if (tail.kind !== "audio") throw new Error("Expected an audio clip.");
  expect(tail.stretch?.source.channels?.[0]).toEqual(original.subarray(15));
  const archive = saveDawProject(project);
  const pair = openDawProject(archive).project;
  const savedTail = pair.tracks[0].clips[1];
  if (savedTail.kind !== "audio") throw new Error("Expected an audio clip.");
  expect(savedTail.stretch?.ratio).toBe(2);
  const restored = pair.applyAudioClipStretch(savedTail, 1);
  expect(restored.duration).toBe(0.25);
  expect(restored.stretch).toBeUndefined();
  expect(restored.channels?.[0]).toEqual(original.subarray(15));

  const files = unzipSync(archive);
  delete files["audiorective/state.json"];
  const portable = openDawProject(zipSync(files));
  expect(portable.project.tracks[0].clips[1].duration).toBe(0.5);
  expect(portable.project.tracks[0].clips[1]).not.toHaveProperty("stretch");
  expect(portable.warnings).toHaveLength(2);
});

test("streams the original file-backed window even when the current rendered clip is PCM", async () => {
  const bytes = new Uint8Array(original.length * 4);
  for (const [index, sample] of original.entries()) new DataView(bytes.buffer).setFloat32(index * 4, sample, true);
  const media = new AudioMedia(new Blob([bytes]), 100, 1, original.length);
  const project = new Project();
  const track = project.addTrack("Track", "audio");
  const clip = project.addAudioMediaClip(track.id, media, 0, { startFrame: 10, frameCount: 20 });
  const rendered = project.applyAudioClipStretch(clip, 2, frames(40));
  expect(rendered.media).toBeUndefined();
  expect(project.hasFileBackedAudio).toBe(true);
  const chunks: Uint8Array[] = [];
  await saveDawProjectTo(
    project,
    new WritableStream({
      write: (chunk) => {
        chunks.push(chunk);
      },
    }),
  );
  const reopened = (await openDawProjectBlob(new Blob(chunks as Uint8Array<ArrayBuffer>[]))).project;
  const stretched = reopened.tracks[0].clips[0];
  if (stretched.kind !== "audio") throw new Error("Expected an audio clip.");
  const restored = reopened.applyAudioClipStretch(stretched, 1);
  expect(restored.duration).toBe(0.2);
  expect(await restored.media?.readFrames(0, 20)).toEqual([original.subarray(10, 30)]);
});
