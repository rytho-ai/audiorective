import { afterEach, expect, test, vi } from "vitest";
import { AudioMediaWriter, Project, Workspace } from "../src";

const RATE = 48_000;
const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** Deterministic PCM whose every frame differs from its neighbours. */
const pattern = (frames: number) => Float32Array.from({ length: frames }, (_, i) => (((i * 7919 + 104729) % 2003) / 2003 - 0.5) * 0.9);

/** Record the samples every AudioBufferSourceNode is told to play. */
function recordPlayed() {
  const played: Float32Array[] = [];
  const start = AudioBufferSourceNode.prototype.start;
  vi.spyOn(AudioBufferSourceNode.prototype, "start").mockImplementation(function (this: AudioBufferSourceNode, when, offset = 0, duration) {
    const samples = this.buffer!.getChannelData(0);
    const from = Math.round(offset * this.buffer!.sampleRate);
    played.push(samples.slice(from, duration === undefined ? undefined : from + Math.round(duration * this.buffer!.sampleRate)));
    return start.call(this, when, offset, duration);
  });
  return played;
}

async function setup(project: Project) {
  const context = new AudioContext({ sampleRate: RATE });
  const workspace = await Workspace.create(context, project);
  cleanups.push(async () => {
    workspace.dispose();
    project.dispose();
    await context.close();
  });
  return workspace;
}

function trimmedClip() {
  const original = pattern(3 * RATE);
  const project = new Project({ bpm: 120 });
  const track = project.addTrack("Take", "audio");
  const whole = project.addAudioClip(track.id, { sampleRate: RATE, channels: [original] }, 4);
  const clip = project.setClipSourceRange(whole.id, { start: 1, end: 2 });
  return { project, clip, original };
}

test("a range plays that part of the whole recording, outside the clip's window too", async () => {
  const { project, clip, original } = trimmedClip();
  const workspace = await setup(project);
  const played = recordPlayed();
  await workspace.auditionAudioClip(clip.id, { range: { start: 0.5, end: 2.5 } });
  expect(workspace.auditioningClip.value).toBe(clip.id);
  expect(played).toHaveLength(1);
  expect(played[0]).toEqual(original.slice(RATE / 2, 2.5 * RATE));
  workspace.stopClipAudition();
  expect(workspace.auditioningClip.value).toBeNull();
});

test("without a range the clip's own window plays", async () => {
  const { project, clip, original } = trimmedClip();
  const workspace = await setup(project);
  const played = recordPlayed();
  await workspace.auditionAudioClip(clip.id);
  // The whole window plays from its first frame, however long the buffer took to build.
  expect(played[0].length).toBe(RATE);
  expect(played[0]).toEqual(original.slice(RATE, 2 * RATE));
});

test("a range of a file-backed clip plays that part of its media", async () => {
  const frames = Float32Array.from({ length: 16000 }, (_, i) => (i + 1) / 32000);
  const chunks: Uint8Array[] = [];
  const writer = new AudioMediaWriter(8000, 1, {
    write: async (bytes: Uint8Array) => void chunks.push(new Uint8Array(bytes)),
    finish: async () => new Blob(chunks as BlobPart[]),
    abort: async () => void (chunks.length = 0),
  });
  await writer.writeChunk({ startFrame: 0, channels: [frames] });
  const media = await writer.finish({ sampleRate: 8000, channelCount: 1, startFrame: 0, endFrame: 16000, startTime: 0, endTime: 2 });
  const project = new Project();
  const track = project.addTrack("Take", "audio");
  const clip = project.addAudioMediaClip(track.id, media, 0, { startFrame: 4000, frameCount: 4000 });
  const workspace = await setup(project);
  const played = recordPlayed();
  await workspace.auditionAudioClip(clip.id, { range: { start: 0.25, end: 0.75 } });
  await vi.waitFor(() => expect(played).toHaveLength(1));
  expect(played[0].length).toBe(4000);
  expect(played[0][0]).toBeCloseTo(frames[2000], 5);
  expect(played[0][3999]).toBeCloseTo(frames[5999], 5);
});

test("an invalid range throws a RangeError and leaves no audition", async () => {
  const { project, clip } = trimmedClip();
  const workspace = await setup(project);
  const message = "Workspace audition range must satisfy 0 <= start < end <= the recording's duration.";
  for (const range of [
    { start: -0.1, end: 1 },
    { start: 1, end: 1 },
    { start: 2, end: 1 },
    { start: 0, end: 3.5 },
    { start: 0, end: Number.NaN },
  ])
    await expect(workspace.auditionAudioClip(clip.id, { range })).rejects.toThrow(message);
  expect(workspace.auditioningClip.value).toBeNull();
  await expect(workspace.auditionAudioClip("nope", { range: { start: 0, end: 1 } })).rejects.toThrow("Workspace audition needs an audio clip.");
});

test("a new audition replaces the running one, and stop cancels it", async () => {
  const { project, clip } = trimmedClip();
  const other = project.addAudioClip(project.tracks[0].id, { sampleRate: RATE, channels: [pattern(RATE)] }, 10);
  const workspace = await setup(project);
  const played = recordPlayed();
  await workspace.auditionAudioClip(clip.id, { range: { start: 0, end: 1 } });
  expect(workspace.auditioningClip.value).toBe(clip.id);
  await workspace.auditionAudioClip(other.id);
  expect(workspace.auditioningClip.value).toBe(other.id);
  await workspace.auditionAudioClip(clip.id, { range: { start: 2, end: 3 } });
  expect(workspace.auditioningClip.value).toBe(clip.id);
  expect(played).toHaveLength(3);
  workspace.stopClipAudition();
  expect(workspace.auditioningClip.value).toBeNull();
});

test("editing the audited clip stops its range audition", async () => {
  const { project, clip } = trimmedClip();
  const workspace = await setup(project);
  await workspace.auditionAudioClip(clip.id, { range: { start: 0, end: 3 } });
  project.setClipSourceRange(clip.id, { start: 0, end: 1 });
  await vi.waitFor(() => expect(workspace.auditioningClip.value).toBeNull());
});
