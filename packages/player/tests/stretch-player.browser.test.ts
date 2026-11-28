import { afterEach, expect, test, vi } from "vitest";
import { view, onChange } from "./view";
import type { PCMData } from "@audiorective/core";
import { WavePlayer } from "../src/WavePlayer";
import type { WaveStretchProcessor } from "../src/WavePlayer";

// These fakes test version ownership and transactions, not pitch preservation.
const toPcm = (buffer: AudioBuffer): PCMData => ({
  sampleRate: buffer.sampleRate,
  channels: Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c)),
});
const toBuffer = (pcm: PCMData): AudioBuffer => {
  const buffer = new AudioBuffer({ length: pcm.channels[0]!.length, numberOfChannels: pcm.channels.length, sampleRate: pcm.sampleRate });
  pcm.channels.forEach((channel, c) => buffer.copyToChannel(channel as Float32Array<ArrayBuffer>, c));
  return buffer;
};
interface Job {
  input: PCMData;
  ratio: number;
  signal?: AbortSignal;
  resolve(pcm: PCMData): void;
  reject(reason: Error): void;
}
function deferredProcessor() {
  const jobs: Job[] = [];
  const process = vi.fn(
    (input: AudioBuffer, options: { ratio: number; signal?: AbortSignal }) =>
      new Promise<AudioBuffer>((resolve, reject) => {
        // Deliberately ignore abort: the owner must reject stale publication itself.
        jobs.push({ input: toPcm(input), ...options, resolve: (pcm) => resolve(toBuffer(pcm)), reject });
      }),
  );
  return { jobs, process, dispose: vi.fn() };
}

const disposers: Array<() => void | Promise<unknown>> = [];
function fixture(stretch?: WaveStretchProcessor) {
  const context = new AudioContext();
  const player = new WavePlayer(context, { stretch });
  disposers.push(
    () => context.close(),
    () => player.dispose(),
  );
  return { context, player };
}
function source(context: AudioContext, frames = 32000, channels = 1): AudioBuffer {
  const buffer = context.createBuffer(channels, frames, 16000);
  for (let channel = 0; channel < channels; channel++) buffer.getChannelData(channel).fill(channel === 0 ? 0.25 : -0.5);
  return buffer;
}
function rendered(job: Job, value = 0.5): PCMData {
  return {
    channels: job.input.channels.map(() => new Float32Array(Math.round(job.input.channels[0].length * job.ratio)).fill(value)),
    sampleRate: job.input.sampleRate,
  };
}
afterEach(async () => {
  for (const dispose of disposers.splice(0).reverse()) await dispose();
  vi.restoreAllMocks();
});

test("every stretch renders the original source rather than compounding the current version", async () => {
  const stretch = deferredProcessor();
  const { context, player } = fixture(stretch);
  const original = source(context, 32000, 2);
  const originalSamples = [original.getChannelData(0).slice(), original.getChannelData(1).slice()];
  await player.load(original);
  const initial = player.cells.version.value!;
  const first = player.setStretch(1.5);
  expect(player.cells.version.value).toBe(initial);
  expect(view(player)).toMatchObject({ processing: true, duration: 2, stretchRatio: 1 });
  stretch.jobs[0].resolve(rendered(stretch.jobs[0], 0.75));
  await first;
  expect(player.buffer!.length).toBe(48000);
  const firstVersion = player.cells.version.value!;
  const second = player.setStretch(0.75);
  expect(player.cells.version.value).toBe(firstVersion);
  expect(stretch.jobs[1].input.sampleRate).toBe(original.sampleRate);
  expect(stretch.jobs[1].input.channels).toEqual(originalSamples);
  expect(stretch.jobs[1].input.channels[0].length).toBe(32000);
  stretch.jobs[1].resolve(rendered(stretch.jobs[1], 0.125));
  await second;
  expect(player.buffer!.length).toBe(24000);
  expect(player.sourceBuffer).toBe(original);
  expect(player.cells.version.value).toMatchObject({ revision: initial.revision + 2, sourceRevision: initial.sourceRevision, ratio: 0.75 });
  expect([original.getChannelData(0), original.getChannelData(1)]).toEqual(originalSamples);
  expect(firstVersion.buffer.length).toBe(48000);
  expect(firstVersion.ratio).toBe(1.5);
});

test("notifications publish coherent immutable metadata, buffer, duration and true DC/tail peaks", async () => {
  const stretch = deferredProcessor();
  const { context, player } = fixture(stretch);
  const original = source(context, 259);
  original.getChannelData(0)[258] = 0.75;
  await player.load(original);
  const initial = player.cells.version.value!;
  expect(Array.from(initial.peaks.min)).toEqual([0.25, 0.25, 0.25]);
  expect(Array.from(initial.peaks.max)).toEqual([0.25, 0.25, 0.75]);
  const snapshots: Array<{
    version: NonNullable<WavePlayer["cells"]["version"]["value"]>;
    buffer: AudioBuffer | null;
    state: ReturnType<typeof view>;
  }> = [];
  onChange(player, () => {
    if (player.cells.version.value) snapshots.push({ version: player.cells.version.value, buffer: player.buffer, state: view(player) });
  });
  const pending = player.setStretch(1.5);
  const output = rendered(stretch.jobs[0], 2);
  output.channels[0][output.channels[0].length - 1] = 4;
  stretch.jobs[0].resolve(output);
  await pending;
  const current = player.cells.version.value!;
  expect(Object.isFrozen(initial)).toBe(true);
  expect(Object.isFrozen(current)).toBe(true);
  expect(current.revision).toBe(initial.revision + 1);
  expect(current.buffer.length).toBe(389);
  expect(Array.from(current.peaks.min)).toEqual([2, 2, 2, 2]);
  expect(Array.from(current.peaks.max)).toEqual([2, 2, 2, 4]);
  expect(initial.buffer).toBe(original);
  expect(initial.peaks.frameCount).toBe(259);
  expect(snapshots.length).toBeGreaterThanOrEqual(2);
  for (const { version, buffer, state } of snapshots) {
    expect(buffer).toBe(version.buffer);
    expect(version.peaks.frameCount).toBe(buffer!.length);
    expect(version.peaks.duration).toBe(state.duration);
    expect(version.peaks.sampleRate).toBe(buffer!.sampleRate);
    expect(state.revision).toBe(version.revision);
    expect(state.stretchRatio).toBe(version.ratio);
    expect(state.duration).toBe(buffer!.duration);
  }
  expect(snapshots.filter((snapshot) => snapshot.version === current)).toHaveLength(1);
  expect(snapshots.at(-1)!.state.processing).toBe(false);
});

test("a successful commit stops playback and maps selection and held position by actual duration", async () => {
  const stretch = deferredProcessor();
  const { context, player } = fixture(stretch);
  await player.load(source(context));
  player.setSelection({ start: 0.4, end: 1.6 });
  player.setLooping(true);
  player.seek(0.8);
  const first = player.setStretch(1.5);
  expect(player.cells.selection.value).toEqual({ start: 0.4, end: 1.6 });
  expect(player.position).toBe(0.8);
  stretch.jobs[0].resolve(rendered(stretch.jobs[0]));
  await first;
  expect(player.cells.selection.value!.start).toBeCloseTo(0.6, 10);
  expect(player.cells.selection.value!.end).toBeCloseTo(2.4, 10);
  expect(player.position).toBeCloseTo(1.2, 10);
  expect(player.cells.isLooping.value).toBe(true);
  expect(player.sourceToOutput(0.8)).toBeCloseTo(1.2, 10);
  expect(player.outputToSource(1.2)).toBeCloseTo(0.8, 10);
  expect(player.sourceToOutput(-1)).toBe(0);
  expect(player.sourceToOutput(99)).toBe(3);
  expect(player.outputToSource(99)).toBe(2);
  for (const value of [NaN, Infinity, -Infinity]) {
    expect(() => player.sourceToOutput(value)).toThrow(/finite/);
    expect(() => player.outputToSource(value)).toThrow(/finite/);
  }
  await player.play();
  expect(player.cells.isPlaying.value).toBe(true);
  const second = player.setStretch(0.75);
  const before = player.position;
  stretch.jobs[1].resolve(rendered(stretch.jobs[1]));
  await second;
  expect(player.cells.isPlaying.value).toBe(false);
  expect(player.position).toBeCloseTo(before * 0.5, 1);
  expect(player.cells.selection.value!.start).toBeCloseTo(0.3, 10);
  expect(player.cells.selection.value!.end).toBeCloseTo(1.2, 10);
});

test("processor failure retains the playable version, selection, and active playback", async () => {
  const stretch = deferredProcessor();
  const { context, player } = fixture(stretch);
  await player.load(source(context));
  player.setSelection({ start: 0.2, end: 1.8 });
  player.seek(0.4);
  await player.play();
  const version = player.cells.version.value;
  const pending = player.setStretch(1.5);
  expect(player.cells.version.value).toBe(version);
  expect(player.cells.isPlaying.value).toBe(true);
  const rejection = expect(pending).rejects.toThrow("render failed");
  stretch.jobs[0].reject(new Error("render failed"));
  await rejection;
  expect(player.cells.version.value).toBe(version);
  expect(player.buffer).toBe(version!.buffer);
  expect(player.cells.selection.value).toEqual({ start: 0.2, end: 1.8 });
  expect(player.cells.isPlaying.value).toBe(true);
  expect(view(player)).toMatchObject({ processing: false, error: null, revision: version!.revision });
});

test("latest request wins when results resolve in reverse order and superseded signals abort", async () => {
  const stretch = deferredProcessor();
  const { context, player } = fixture(stretch);
  await player.load(source(context));
  const first = player.setStretch(0.75);
  const second = player.setStretch(1.5);
  expect(stretch.jobs[0].signal!.aborted).toBe(true);
  expect(stretch.jobs[1].signal!.aborted).toBe(false);
  stretch.jobs[1].resolve(rendered(stretch.jobs[1], 0.75));
  await second;
  const winner = player.cells.version.value;
  stretch.jobs[0].resolve(rendered(stretch.jobs[0], 0.125));
  await first;
  expect(player.cells.version.value).toBe(winner);
  expect(player.buffer!.length).toBe(48000);
  expect(player.buffer!.getChannelData(0)[0]).toBe(0.75);
  expect(view(player)).toMatchObject({ processing: false, stretchRatio: 1.5, error: null });
});

test("loading a new source resets editing and cannot be overwritten by a stale render", async () => {
  const stretch = deferredProcessor();
  const { context, player } = fixture(stretch);
  await player.load(source(context));
  const firstVersion = player.cells.version.value!;
  player.setSelection({ start: 0.2, end: 1 });
  player.setLooping(true);
  player.seek(0.4);
  const pending = player.setStretch(1.5);
  const replacement = source(context, 16000);
  await player.load(replacement);
  const replacementVersion = player.cells.version.value;
  expect(stretch.jobs[0].signal!.aborted).toBe(true);
  expect(player.sourceBuffer).toBe(replacement);
  expect(player.cells.version.value!.sourceRevision).toBeGreaterThan(firstVersion.sourceRevision);
  expect(view(player)).toMatchObject({
    duration: 1,
    sourceDuration: 1,
    selection: null,
    position: 0,
    isLooping: false,
    processing: false,
    stretchRatio: 1,
  });
  stretch.jobs[0].resolve(rendered(stretch.jobs[0]));
  await pending;
  expect(player.cells.version.value).toBe(replacementVersion);
  expect(player.buffer).toBe(replacement);
});

test("dispose aborts pending edits, ignores late success, and preserves borrowed processor/context ownership", async () => {
  const stretch = deferredProcessor();
  const { context, player } = fixture(stretch);
  await player.load(source(context));
  const pending = player.setStretch(1.5);
  player.dispose();
  player.dispose();
  expect(stretch.jobs[0].signal!.aborted).toBe(true);
  expect(stretch.dispose).not.toHaveBeenCalled();
  stretch.jobs[0].resolve(rendered(stretch.jobs[0]));
  await pending;
  expect(player.cells.version.value).toBeNull();
  expect(player.buffer).toBeNull();
  expect(player.sourceBuffer).toBeNull();
  expect(view(player)).toMatchObject({ processing: false, duration: 0, isPlaying: false });
  expect(context.state).not.toBe("closed");
  await expect(player.setStretch(1)).rejects.toThrow(/disposed/);
});

test("invalid ratios and incompatible processor PCM retain the complete current revision", async () => {
  const stretch = deferredProcessor();
  const { context, player } = fixture(stretch);
  await player.load(source(context));
  const version = player.cells.version.value;
  for (const ratio of [0, -1, NaN, Infinity, -Infinity]) {
    await expect(player.setStretch(ratio)).rejects.toThrow(/finite and positive/);
    expect(player.cells.version.value).toBe(version);
  }
  expect(stretch.process).not.toHaveBeenCalled();
  const expected = 48000;
  const invalid: PCMData[] = [
    { sampleRate: 8000, channels: [new Float32Array(expected)] },
    { sampleRate: 16000, channels: [new Float32Array(expected), new Float32Array(expected)] },
    { sampleRate: 16000, channels: [new Float32Array(expected - 1)] },
    { sampleRate: 16000, channels: [new Float32Array(expected).fill(NaN)] },
  ];
  for (const pcm of invalid) {
    const pending = player.setStretch(1.5);
    const rejection = expect(pending).rejects.toThrow();
    stretch.jobs.at(-1)!.resolve(pcm);
    await rejection;
    expect(player.cells.version.value).toBe(version);
    expect(player.buffer).toBe(version!.buffer);
    expect(view(player)).toMatchObject({ processing: false, revision: version!.revision, duration: 2 });
  }
});

test("ratio one cancels pending work and restores the original without asking the processor", async () => {
  const stretch = deferredProcessor();
  const { context, player } = fixture(stretch);
  const original = source(context);
  await player.load(original);
  player.setSelection({ start: 0.4, end: 1.6 });
  player.seek(0.8);
  const first = player.setStretch(1.5);
  stretch.jobs[0].resolve(rendered(stretch.jobs[0]));
  await first;
  const stale = player.setStretch(0.75);
  await player.setStretch(1);
  expect(stretch.jobs[1].signal!.aborted).toBe(true);
  expect(stretch.process).toHaveBeenCalledTimes(2);
  expect(player.buffer).toBe(original);
  expect(player.sourceBuffer).toBe(original);
  expect(player.cells.version.value!.ratio).toBe(1);
  expect(player.cells.version.value!.peaks.frameCount).toBe(original.length);
  expect(player.cells.selection.value!.start).toBeCloseTo(0.4, 10);
  expect(player.cells.selection.value!.end).toBeCloseTo(1.6, 10);
  expect(player.position).toBeCloseTo(0.8, 10);
  const identity = player.cells.version.value;
  stretch.jobs[1].resolve(rendered(stretch.jobs[1]));
  await stale;
  expect(player.cells.version.value).toBe(identity);
});

test("identity works without a processor while other edits require a loaded source and processor", async () => {
  const { context, player } = fixture();
  expect(player.sourceToOutput(1)).toBe(0);
  expect(player.outputToSource(1)).toBe(0);
  await expect(player.setStretch(1)).rejects.toThrow("No audio source is loaded.");
  const original = source(context);
  await player.load(original);
  const version = player.cells.version.value;
  await expect(player.setStretch(1.5)).rejects.toThrow("WavePlayer needs a stretch processor.");
  expect(player.cells.version.value).toBe(version);
  await player.setStretch(1);
  expect(player.buffer).toBe(original);
  expect(player.cells.version.value!.ratio).toBe(1);
});

test("every setStretch failure is one rejected promise, never cells.error, and a superseded request settles silently", async () => {
  const stretch = deferredProcessor();
  const { context, player } = fixture(stretch);
  await expect(player.setStretch(2)).rejects.toThrow("No audio source is loaded.");
  await player.load(source(context));
  await expect(player.setStretch(0)).rejects.toThrow("Stretch ratio must be finite and positive.");
  await expect(player.setStretch(Infinity)).rejects.toThrow("Stretch ratio must be finite and positive.");
  const bare = new WavePlayer(context);
  disposers.push(() => bare.dispose());
  await bare.load(source(context));
  await expect(bare.setStretch(2)).rejects.toThrow("WavePlayer needs a stretch processor.");
  const bad = player.setStretch(2);
  stretch.jobs[0].resolve({ channels: [new Float32Array(3)], sampleRate: 16000 });
  await expect(bad).rejects.toThrow("Stretch processor returned an incompatible AudioBuffer.");
  const failing = player.setStretch(2);
  stretch.jobs[1].reject(new Error("render failed"));
  await expect(failing).rejects.toThrow("render failed");
  for (const target of [player, bare]) {
    expect(target.cells.error.value).toBeNull();
    expect(target.cells.processing.value).toBe(false);
  }
  const older = player.setStretch(3);
  const newer = player.setStretch(4);
  stretch.jobs[2].reject(new Error("superseded"));
  await expect(older).resolves.toBeUndefined();
  stretch.jobs[3].resolve(rendered(stretch.jobs[3]));
  await newer;
  expect(player.cells.version.value?.ratio).toBe(4);
});
