/**
 * Stems written by Bitwig Studio 6.1.7 (24-bit stereo, 44.1 kHz; excerpts, see fixtures/bitwig-stems/SOURCES.md) imported into a 48 kHz Workspace:
 * the clicks land on the frame the sample-rate ratio gives, every clip starts at 0 and all clips have the same length.
 * In the excerpt (44.1 kHz frames from the cut point): Click A has its click at 13230, Click B at 2205, the Master holds both; 48 kHz makes them 14400 and 2400.
 */
import { afterEach, expect, test } from "vitest";
import { Project, Workspace, importAudioFiles } from "../src";

const RATE = 48_000;
const worklet = "/@fs" + new URL("../../host/dist/webclap-worklet.js", import.meta.url).pathname.replace(/^\/@fs/, "");
const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const fixtures = {
  "Click A": new URL("./fixtures/bitwig-stems/click-a.wav", import.meta.url).href,
  "Click B": new URL("./fixtures/bitwig-stems/click-b.wav", import.meta.url).href,
  Master: new URL("./fixtures/bitwig-stems/master.wav", import.meta.url).href,
};

/** First frame of each click: a frame above 0.1 after at least 2400 frames (50 ms) of quiet. */
function clickStarts(channel: Float32Array): number[] {
  const starts: number[] = [];
  let last = -1e9;
  for (let i = 0; i < channel.length; i++)
    if (Math.abs(channel[i]) > 0.1) {
      if (i - last > 2400) starts.push(i);
      last = i;
    }
  return starts;
}

test("three Bitwig stems at 44.1 kHz land in a 48 kHz Workspace with clicks on the expected frames, one start and one length", async () => {
  const project = new Project({ bpm: 120 });
  const context = new AudioContext({ sampleRate: RATE });
  const workspace = await Workspace.create(context, project, { workletUrl: worklet });
  cleanups.push(async () => {
    workspace.dispose();
    project.dispose();
    await context.close();
  });
  const files = await Promise.all(
    Object.entries(fixtures).map(async ([name, url]) => ({ name: `${name}.wav`, bytes: new Uint8Array(await (await fetch(url)).arrayBuffer()) })),
  );
  // The excerpts are Bitwig's own header fields: 24-bit stereo at 44.1 kHz.
  for (const { bytes } of files) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const at = bytes.findIndex((_, i) => String.fromCharCode(...bytes.subarray(i, i + 4)) === "fmt ");
    expect([view.getUint16(at + 10, true), view.getUint32(at + 12, true), view.getUint16(at + 22, true)]).toEqual([2, 44_100, 24]);
  }
  const { tracks, sampleRate } = await importAudioFiles(workspace, files);
  expect(sampleRate).toBe(RATE);
  expect(tracks.map((track) => track.name)).toEqual(["Click A", "Click B", "Master"]);
  const clips = tracks.map((track) => {
    const clip = track.clips[0];
    if (clip.kind !== "audio" || !clip.channels) throw new Error("expected a PCM audio clip");
    return clip;
  });
  // 15,435 frames at 44.1 kHz are 16,800 at 48 kHz.
  expect(clips.map((clip) => clip.time)).toEqual([0, 0, 0]);
  expect(clips.map((clip) => clip.channels![0].length)).toEqual([16_800, 16_800, 16_800]);
  expect(clips.map((clip) => clip.channels!.length)).toEqual([2, 2, 2]);
  expect(clipsStarts(clips)).toEqual([[14_400], [2_400], [2_400, 14_400]]);
});

const clipsStarts = (clips: { channels?: readonly Float32Array[] }[]) => clips.map((clip) => clickStarts(clip.channels![0]));
