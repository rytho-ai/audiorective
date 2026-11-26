import { afterEach, expect, test } from "vitest";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { Workspace, openDawProject, openWorkspace, renderMixRange, renderStems, saveWorkspace, exportAudioFallbackTo } from "../src";
import type { AudioClip } from "../src";
import { parseTree, projectXmlOf, treeDifferences } from "./helpers/xml-tree";

/**
 * A file with Ogg Vorbis, FLAC, MP3 and Opus audio (tests/fixtures/compressed-audio, SOURCES.md there) opened into a Workspace at 48 kHz: the browser
 * decodes each file, the clips play from the decoded audio, and an offline render hears every click on the frame its place in the file implies.
 * Every click is 0.5 s into a 1 s file (frame 22 050 of a 44.1 kHz file, 24 000 of a 48 kHz one); the tempo is 120 BPM.
 */
const RATE = 48_000;
const worklet = "/@fs" + new URL("../../host/dist/webclap-worklet.js", import.meta.url).pathname.replace(/^\/@fs/, "");
const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const fixture = async () =>
  new Uint8Array(await (await fetch(new URL("./fixtures/compressed-audio/compressed-audio.dawproject", import.meta.url).href)).arrayBuffer());
const audioEntries = (archive: Uint8Array) => Object.fromEntries(Object.entries(unzipSync(archive)).filter(([name]) => name.startsWith("audio/")));

async function context(): Promise<AudioContext> {
  const context = new AudioContext({ sampleRate: RATE });
  cleanups.push(() => context.close());
  return context;
}
async function opened(bytes: Uint8Array): Promise<Workspace> {
  const workspace = await openWorkspace(await context(), bytes, { workletUrl: worklet });
  cleanups.push(() => workspace.dispose());
  return workspace;
}
const peakAt = (x: Float32Array) => x.reduce((best, value, index) => (Math.abs(value) > Math.abs(x[best]) ? index : best), 0);

/** Frame of the click in each track's stem, and how far each is from the frame its place in the file implies. */
async function clickFrames(workspace: Workspace): Promise<Record<string, number>> {
  const result = await renderStems(workspace, { includeMix: false, tailSeconds: 0.5 });
  if (result.status !== "rendered") throw new Error(result.status);
  return Object.fromEntries(result.stems.map((stem) => [stem.name, peakAt(stem.audio.channels[0])]));
}

// Frame of each click on the 48 kHz timeline: the clip's start plus the click's place in the clip's window.
const expectedFrame = { Ogg: 1.5 * RATE, Flac: 1.25 * RATE, Mp3: 2.5 * RATE, Opus: 4.5 * RATE };
/**
 * The most a click may be off its frame, per format. Measured with this Chromium: 0 frames for all four. FLAC is lossless and already 48 kHz, so it
 * is exact. Ogg Vorbis (44.1 kHz, resampled to 48 kHz), MP3 (44.1 kHz, LAME gapless header) and Opus (48 kHz, pre-skip) are lossy, and the loudest
 * sample of a coded click can move by one sample under another decoder or resampler release; a delay of the codec (MP3's 1105 samples, Opus's 312)
 * would be hundreds of frames, so one frame still separates them from an unhandled delay.
 */
const tolerance = { Ogg: 1, Flac: 0, Mp3: 1, Opus: 1 };

function expectClicks(found: Record<string, number>, shift = 0): void {
  for (const [name, frame] of Object.entries(expectedFrame))
    expect(Math.abs(found[name] - (frame + shift)), `${name} click at frame ${found[name]}`).toBeLessThanOrEqual(
      tolerance[name as keyof typeof tolerance],
    );
}

test("the browser decodes every format and each click lands on the frame its place implies", async () => {
  const workspace = await opened(await fixture());
  const clips = Object.fromEntries(workspace.project.tracks.map((track) => [track.name, track.clips[0] as AudioClip | undefined]));
  for (const name of Object.keys(expectedFrame)) {
    const clip = clips[name]!;
    // Decoded and resampled to the Workspace rate: an ordinary PCM clip, as `importAudioFiles` makes.
    expect(clip.media, name).toBeUndefined();
    expect(clip.sampleRate, name).toBe(RATE);
  }
  expect([clips.Ogg!.time, clips.Ogg!.duration]).toEqual([1, 1]);
  expect(clips.Flac!.duration).toBeCloseTo(0.5, 4);
  expect(clips.Flac!.sourceOffset).toBeCloseTo(0.25, 4);
  expectClicks(await clickFrames(workspace));
  // The mix, the Session-free offline render and the audio fallback hear the decoded audio too.
  const mix = await renderMixRange(workspace, { expectedVersion: workspace.project.cells.version.value, range: { startSeconds: 0, endSeconds: 6 } });
  if (mix.status !== "rendered") throw new Error(mix.status);
  for (const [name, frame] of Object.entries(expectedFrame).filter(([name]) => name !== "Opus"))
    expect(Math.abs(peakAt(mix.audio.channels[0].subarray(frame - 2000, frame + 2000)) - 2000), name).toBeLessThanOrEqual(
      tolerance[name as keyof typeof tolerance],
    );
  const parts: Uint8Array[] = [];
  await exportAudioFallbackTo(workspace, new WritableStream({ write: (chunk) => void parts.push(chunk) }), { tailSeconds: 0.2 });
  const files = unzipSync(new Uint8Array(await new Blob(parts as BlobPart[]).arrayBuffer()));
  const stem = files["mix.wav"];
  const view = new DataView(stem.buffer, stem.byteOffset, stem.byteLength);
  const left = Float32Array.from({ length: (stem.length - 44) / 8 }, (_, frame) => view.getFloat32(44 + frame * 8, true));
  expect(Math.abs(peakAt(left.subarray(RATE, 2 * RATE)) + RATE - expectedFrame.Ogg)).toBeLessThanOrEqual(tolerance.Ogg);
  expect(Math.abs(peakAt(left.subarray(4 * RATE, 5 * RATE)) + 4 * RATE - expectedFrame.Opus)).toBeLessThanOrEqual(tolerance.Opus);
});

test("a Blob and workspace.open decode the same way", async () => {
  const bytes = await fixture();
  const fromBlob = await openWorkspace(await context(), new Blob([bytes as Uint8Array<ArrayBuffer>]), { workletUrl: worklet });
  cleanups.push(() => fromBlob.dispose());
  expectClicks(await clickFrames(fromBlob));
  // File > Open in place: a Workspace that holds another song decodes the new file before it swaps.
  const empty = await opened(
    zipSync({
      ...unzipSync(bytes),
      "project.xml": strToU8(strFromU8(unzipSync(bytes)["project.xml"]).replace(/<Lanes id="l\d" track="t\d">.*?<\/Lanes>/gs, "")),
    }),
  );
  expect(empty.project.tracks.every((track) => track.clips.length === 0)).toBe(true);
  await empty.open(bytes);
  expectClicks(await clickFrames(empty));
  expect(empty.project.tracks.map((track) => track.clips.length)).toEqual([1, 1, 1, 1, 0]);
});

test("a file the browser cannot decode is named in the warnings and its clip stays in the file", async () => {
  const bytes = await fixture();
  const workspace = await opened(bytes);
  const broken = workspace.project.tracks.find((track) => track.name === "Broken")!;
  expect(broken.clips).toHaveLength(0);
  const warning = workspace.cells.warnings.value.find((text) => text.includes("audio/broken.ogg"));
  expect(warning).toContain('Audio file "audio/broken.ogg" that the browser could not decode');
  expect(warning).toContain("Kept in the file unchanged, not played or edited");
  // Not lost: the clip and its file are saved as they were.
  const saved = await saveWorkspace(workspace);
  expect(audioEntries(saved)["audio/broken.ogg"]).toEqual(audioEntries(bytes)["audio/broken.ogg"]);
  expect(projectXmlOf(saved)).toContain('path="audio/broken.ogg"');
  expect(projectXmlOf(saved)).toContain('name="Broken"');
  // The other four play.
  expect(Object.keys(await clickFrames(workspace)).sort()).toEqual(["Broken", "Flac", "Mp3", "Ogg", "Opus"]);
});

test("a save with no edit keeps project.xml's tree and every audio file byte for byte; an edit moves the click and keeps the files", async () => {
  const bytes = await fixture();
  const workspace = await opened(bytes);
  const unchanged = await saveWorkspace(workspace);
  expect(treeDifferences(parseTree(projectXmlOf(bytes)), parseTree(projectXmlOf(unchanged)))).toEqual([]);
  expect(audioEntries(unchanged)).toEqual(audioEntries(bytes));
  const ogg = workspace.project.tracks[0].clips[0];
  workspace.project.moveClip(ogg.id, workspace.project.tracks[0].id, ogg.time + 0.5);
  await workspace.flush();
  const edited = await saveWorkspace(workspace);
  expect(audioEntries(edited)).toEqual(audioEntries(bytes));
  const reopened = await opened(edited);
  expect(reopened.project.tracks[0].clips[0].time).toBeCloseTo(1.5, 6);
  const found = await clickFrames(reopened);
  expect(Math.abs(found.Ogg - (expectedFrame.Ogg + 0.5 * RATE))).toBeLessThanOrEqual(tolerance.Ogg);
  expect(Math.abs(found.Opus - expectedFrame.Opus)).toBeLessThanOrEqual(tolerance.Opus);
});

test("an MP3 without the encoder's gapless header plays its encoder delay: measured, not compensated", async () => {
  const entries = unzipSync(await fixture());
  entries["audio/click.mp3"] = new Uint8Array(
    await (await fetch(new URL("./fixtures/compressed-audio/click-nogapless.mp3", import.meta.url).href)).arrayBuffer(),
  );
  const found = await clickFrames(await opened(zipSync(entries)));
  const late = found.Mp3 - expectedFrame.Mp3;
  console.log(`MP3 without a LAME/Xing header: click ${late} frames late at 48 kHz`);
  // LAME's 576-sample encoder delay plus the decoder's 529, at 44.1 kHz, is 1105 samples: 1203 frames at 48 kHz. Nothing in the file says so (the
  // Audio element states 1 s), so the browser's decoder cannot trim it and neither do we; the other formats are unaffected.
  expect(Math.abs(late - (1105 * RATE) / 44_100)).toBeLessThanOrEqual(2);
  expect(Math.abs(found.Ogg - expectedFrame.Ogg)).toBeLessThanOrEqual(tolerance.Ogg);
});

test("a Workspace made over a Project that was never decoded reports the clips it cannot read instead of playing silence", async () => {
  const { project } = openDawProject(await fixture());
  cleanups.push(() => project.dispose());
  const workspace = await Workspace.create(await context(), project, { workletUrl: worklet });
  cleanups.push(() => workspace.dispose());
  await workspace.seek(1.2);
  await workspace.play();
  await expect.poll(() => String(workspace.cells.error.value ?? "")).toContain("is not decoded yet");
  workspace.stop();
});
