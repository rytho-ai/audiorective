import { afterEach, expect, test } from "vitest";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { TimeStretch } from "@audiorective/effects/time-stretch";
import type { WaveStretchAnchor, WaveStretchProcessor } from "@audiorective/player";
import { Workspace, encodeWavBytes, openDawProject, openWorkspace, renderMixRange } from "../src";
import type { AudioClip } from "../src";

/**
 * Playback of audio stretched by warp markers. `b-bitwig-native` (Bitwig Studio 6.1.7, tests/fixtures/dawproject/SOURCES.md) holds 4 s of 44.1 kHz audio
 * (clicks at 0.5, 1.5, 2.5, 3.5 s) over 8 beats at 100 BPM, 4.8 s, placed at beat 1 (0.6 s): ratio 1.2. The Workspace plays at 48 kHz.
 */
const RATE = 48_000;
const SOURCE_RATE = 44_100;
const RATIO = 1.2;
const START = 0.6 * RATE;
const worklet = "/@fs" + new URL("../../host/dist/webclap-worklet.js", import.meta.url).pathname.replace(/^\/@fs/, "");
const wasmPath = import.meta.env.VITE_RUBBERBAND_WASM as string | undefined;
const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function bitwigFile(edit?: (xml: string) => string, audio?: Float32Array): Promise<Uint8Array> {
  const response = await fetch(new URL("./fixtures/dawproject/b-bitwig-native.dawproject", import.meta.url).href);
  const entries = unzipSync(new Uint8Array(await response.arrayBuffer()));
  if (edit) entries["project.xml"] = strToU8(edit(strFromU8(entries["project.xml"])));
  if (audio) entries["audio/click44.wav"] = encodeWavBytes({ sampleRate: SOURCE_RATE, channels: [audio] });
  return zipSync(entries);
}

async function open(bytes: Uint8Array, stretch?: WaveStretchProcessor) {
  const context = new AudioContext({ sampleRate: RATE });
  const workspace = await openWorkspace(context, bytes, { workletUrl: worklet, ...(stretch ? { stretch } : {}) });
  cleanups.push(async () => {
    workspace.dispose();
    await context.close();
  });
  return workspace;
}

async function mix(workspace: Workspace, seconds: number): Promise<Float32Array> {
  const result = await renderMixRange(workspace, {
    expectedVersion: workspace.project.cells.version.value,
    range: { startSeconds: 0, endSeconds: seconds },
  });
  if (result.status !== "rendered") throw new Error(result.status);
  return Float32Array.from(result.audio.channels[0]);
}

const audioClip = (workspace: Workspace) =>
  workspace.project.tracks.flatMap((track) => track.clips).find((item): item is AudioClip => item.kind === "audio")!;

function loudest(x: Float32Array, from: number, to: number): number {
  let best = 0;
  for (let i = from; i < to; i++) best = Math.max(best, Math.abs(x[i]));
  return best;
}

/** First frame of each click: a frame above `threshold` after at least 2400 frames of quiet. */
function clickStarts(x: Float32Array, threshold = 0.1): number[] {
  const starts: number[] = [];
  let last = -1e9;
  for (let i = 0; i < x.length; i++)
    if (Math.abs(x[i]) > threshold) {
      if (i - last > 2400) starts.push(i);
      last = i;
    }
  return starts;
}

/** Cycles per second over frames `[from, to)` from the rising zero crossings. */
function frequency(x: Float32Array, from: number, to: number, rate: number): number {
  let crossings = 0;
  let first = -1;
  let last = -1;
  for (let i = from + 1; i < to; i++)
    if (x[i - 1] < 0 && x[i] >= 0) {
      crossings++;
      if (first < 0) first = i;
      last = i;
    }
  return ((crossings - 1) * rate) / (last - first);
}

class FakeStretch implements WaveStretchProcessor {
  calls: Array<{ ratio: number; anchors?: readonly WaveStretchAnchor[]; frames: number; sampleRate: number }> = [];
  constructor(private readonly level = 0.3) {}
  async process(input: AudioBuffer, options: { ratio: number; anchors?: readonly WaveStretchAnchor[] }): Promise<AudioBuffer> {
    this.calls.push({ ratio: options.ratio, anchors: options.anchors, frames: input.length, sampleRate: input.sampleRate });
    const output = new AudioBuffer({
      length: Math.round(input.length * options.ratio),
      numberOfChannels: input.numberOfChannels,
      sampleRate: input.sampleRate,
    });
    for (let c = 0; c < output.numberOfChannels; c++) output.getChannelData(c).fill(this.level);
    return output;
  }
}

test("without a stretch processor the clip plays by varispeed: every click lands at frame x ratio, and the warning says how to fix the pitch", async () => {
  const workspace = await open(await bitwigFile());
  expect(audioClip(workspace).stretch?.ratio).toBeCloseTo(RATIO, 9);
  expect(workspace.warnings.filter((warning) => /time-stretched by the file's warp markers/.test(warning))).toHaveLength(1);
  expect(workspace.warnings.join("\n")).toMatch(/1 audio clip is time-stretched.*changed pitch.*stretch processor.*TimeStretch/s);
  const x = await mix(workspace, 6);
  const starts = clickStarts(x, 0.2);
  expect(starts).toHaveLength(4);
  // Source click at 0.5, 1.5, 2.5, 3.5 s of a 44.1 kHz file: 22050 + n * 44100 frames, stretched by 1.2 and played at 48 kHz, after the clip's start.
  const original = [0, 1, 2, 3].map((i) => 22_050 + i * SOURCE_RATE);
  console.log(
    `varispeed clicks at frames ${starts.join(", ")}; expected ${original.map((f) => Math.round(START + (f * RATIO * RATE) / SOURCE_RATE)).join(", ")}`,
  );
  starts.forEach((frame, i) => {
    const expected = START + (original[i] * RATIO * RATE) / SOURCE_RATE;
    expect(Math.abs(frame - expected), `click ${i + 1} at ${frame}, expected ${expected}`).toBeLessThanOrEqual(2);
  });
});

test("a stretch processor renders each stretched clip once with its ratio and anchors, before the song plays, and it is no Undo step", async () => {
  const processor = new FakeStretch();
  const bytes = await bitwigFile((xml) =>
    xml.replace(
      /<Warp time="0.0" contentTime="0.0"\/>\s*<Warp time="8.0" contentTime="4.0"\/>/,
      '<Warp time="0.0" contentTime="0.0"/><Warp time="4.0" contentTime="1.0"/><Warp time="8.0" contentTime="4.0"/>',
    ),
  );
  const workspace = await open(bytes, processor);
  expect(processor.calls).toHaveLength(1);
  expect(processor.calls[0]).toMatchObject({ frames: 176_400, sampleRate: SOURCE_RATE });
  expect(processor.calls[0].ratio).toBeCloseTo(RATIO, 9);
  expect(processor.calls[0].anchors).toEqual([{ sourceFrame: 44_100, outputFrame: 105_840 }]);
  expect(workspace.warnings.join("\n")).not.toMatch(/stretch/i);
  const clip = audioClip(workspace);
  expect(clip.channels[0]).toHaveLength(211_680);
  expect(clip.channels[0][100_000]).toBeCloseTo(0.3, 6);
  // Not an edit: the version is the one a plain open has, and there is nothing to undo.
  const plain = openDawProject(bytes).project;
  cleanups.push(() => plain.dispose());
  expect(workspace.project.cells.version.value.split(":")[1]).toBe(plain.cells.version.value.split(":")[1]);
  expect(workspace.project.cells.history.value.undo).toBeUndefined();
  // What plays is the render: a steady 0.3 where the clip sounds, no click.
  const x = await mix(workspace, 6);
  const track = workspace.project.tracks.find((item) => item.clips.some((clip) => clip.kind === "audio"))!;
  const level = 0.3 * track.volume * Math.SQRT1_2;
  expect(Math.abs(x[START + 100_000] - level)).toBeLessThan(0.002);
  expect(loudest(x, START + 5_000, START + 230_000)).toBeLessThan(level + 0.002);
  expect(Math.abs(x[START + 230_400 - 1000] - level)).toBeLessThan(0.002);
  expect(loudest(x, START + 230_400 + 2000, x.length)).toBeLessThan(0.001);
});

test("an engine failure on one clip leaves its varispeed audio and a warning that names the clip; the song still opens", async () => {
  const failing: WaveStretchProcessor = {
    process: async () => {
      throw new Error("engine broke");
    },
  };
  const workspace = await open(await bitwigFile(), failing);
  expect(workspace.warnings.some((warning) => /Audio clip "click44" could not be stretched.*engine broke.*changed pitch/s.test(warning))).toBe(true);
  expect(clickStarts(await mix(workspace, 6), 0.2)).toHaveLength(4);
});

test("workspace.open renders the stretched clips of the file it opens with the processor the workspace has", async () => {
  const processor = new FakeStretch(0.2);
  const context = new AudioContext({ sampleRate: RATE });
  const first = await bitwigFile((xml) => xml.replace('algorithm="stretch"', 'algorithm="raw"'));
  const workspace = await openWorkspace(context, first, { workletUrl: worklet, stretch: processor });
  cleanups.push(async () => {
    workspace.dispose();
    await context.close();
  });
  // An algorithm other than stretch is varispeed by intent: nothing to render, no warning.
  expect(processor.calls).toHaveLength(0);
  expect(workspace.warnings.join()).not.toMatch(/stretch processor/);
  await workspace.open(await bitwigFile());
  expect(processor.calls).toHaveLength(1);
  expect(audioClip(workspace).channels[0][100_000]).toBeCloseTo(0.2, 6);
});

test.skipIf(!wasmPath)(
  "with Rubber Band the pitch of a 440 Hz source survives the 1.2 stretch; the varispeed path lowers it by the ratio",
  { timeout: 120_000 },
  async () => {
    const sine = Float32Array.from({ length: 4 * SOURCE_RATE }, (_, i) => 0.5 * Math.sin((2 * Math.PI * 440 * i) / SOURCE_RATE));
    const bytes = await bitwigFile(undefined, sine);
    const engine = await TimeStretch.load({ wasmUrl: `/@fs${wasmPath}` });
    const stretched = await open(bytes, engine);
    expect(stretched.warnings.join()).not.toMatch(/stretch/i);
    const rendered = audioClip(stretched);
    expect(rendered.channels[0]).toHaveLength(211_680);
    const kept = frequency(await mix(stretched, 6), START + RATE, START + 4 * RATE, RATE);
    const varispeed = await open(bytes);
    const lowered = frequency(await mix(varispeed, 6), START + RATE, START + 4 * RATE, RATE);
    console.log(
      `440 Hz source, ratio 1.2: Rubber Band ${kept.toFixed(2)} Hz, varispeed ${lowered.toFixed(2)} Hz (expected ${(440 / RATIO).toFixed(2)})`,
    );
    expect(Math.abs(kept - 440) / 440).toBeLessThan(0.01);
    expect(Math.abs(lowered - 440 / RATIO) / (440 / RATIO)).toBeLessThan(0.01);
  },
);
