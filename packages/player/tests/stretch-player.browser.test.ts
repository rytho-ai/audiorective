import { afterEach, expect, test, vi } from "vitest";
import type { PCMData } from "@audiorective/core/peaks";
import { WavePlayer } from "../src/WavePlayer";
import type { WaveStretchProcessor } from "../src/WavePlayer";

// These fakes test version ownership and transactions, not pitch preservation.
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
    (input: PCMData, options: { ratio: number; signal?: AbortSignal }) =>
      new Promise<PCMData>((resolve, reject) => {
        // Deliberately ignore abort: the owner must reject stale publication itself.
        jobs.push({ input, ...options, resolve, reject });
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
  const initial = player.version!;
  const first = player.setStretch(1.5);
  expect(player.version).toBe(initial);
  expect(player.getState()).toMatchObject({ processing: true, duration: 2, stretchRatio: 1 });
  stretch.jobs[0].resolve(rendered(stretch.jobs[0], 0.75));
  await first;
  expect(player.buffer!.length).toBe(48000);
  const firstVersion = player.version!;
  const second = player.setStretch(0.75);
  expect(player.version).toBe(firstVersion);
  expect(stretch.jobs[1].input.sampleRate).toBe(original.sampleRate);
  expect(stretch.jobs[1].input.channels).toEqual(originalSamples);
  expect(stretch.jobs[1].input.channels[0].length).toBe(32000);
  stretch.jobs[1].resolve(rendered(stretch.jobs[1], 0.125));
  await second;
  expect(player.buffer!.length).toBe(24000);
  expect(player.sourceBuffer).toBe(original);
  expect(player.version).toMatchObject({ revision: initial.revision + 2, sourceRevision: initial.sourceRevision, ratio: 0.75 });
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
  const initial = player.version!;
  expect(Array.from(initial.peaks.min)).toEqual([0.25, 0.25, 0.25]);
  expect(Array.from(initial.peaks.max)).toEqual([0.25, 0.25, 0.75]);
  const snapshots: Array<{ version: NonNullable<WavePlayer["version"]>; buffer: AudioBuffer | null; state: ReturnType<WavePlayer["getState"]> }> = [];
  player.subscribe(() => {
    if (player.version) snapshots.push({ version: player.version, buffer: player.buffer, state: player.getState() });
  });
  const pending = player.setStretch(1.5);
  const output = rendered(stretch.jobs[0], 2);
  output.channels[0][output.channels[0].length - 1] = 4;
  stretch.jobs[0].resolve(output);
  await pending;
  const current = player.version!;
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
  expect(player.getSelection()).toEqual({ start: 0.4, end: 1.6 });
  expect(player.position).toBe(0.8);
  stretch.jobs[0].resolve(rendered(stretch.jobs[0]));
  await first;
  expect(player.getSelection()!.start).toBeCloseTo(0.6, 10);
  expect(player.getSelection()!.end).toBeCloseTo(2.4, 10);
  expect(player.position).toBeCloseTo(1.2, 10);
  expect(player.isLooping).toBe(true);
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
  expect(player.isPlaying).toBe(true);
  const second = player.setStretch(0.75);
  const before = player.position;
  stretch.jobs[1].resolve(rendered(stretch.jobs[1]));
  await second;
  expect(player.isPlaying).toBe(false);
  expect(player.position).toBeCloseTo(before * 0.5, 1);
  expect(player.getSelection()!.start).toBeCloseTo(0.3, 10);
  expect(player.getSelection()!.end).toBeCloseTo(1.2, 10);
});

test("processor failure retains the playable version, selection, and active playback", async () => {
  const stretch = deferredProcessor();
  const { context, player } = fixture(stretch);
  await player.load(source(context));
  player.setSelection({ start: 0.2, end: 1.8 });
  player.seek(0.4);
  await player.play();
  const version = player.version;
  const pending = player.setStretch(1.5);
  expect(player.version).toBe(version);
  expect(player.isPlaying).toBe(true);
  const rejection = expect(pending).rejects.toThrow("render failed");
  stretch.jobs[0].reject(new Error("render failed"));
  await rejection;
  expect(player.version).toBe(version);
  expect(player.buffer).toBe(version!.buffer);
  expect(player.getSelection()).toEqual({ start: 0.2, end: 1.8 });
  expect(player.isPlaying).toBe(true);
  expect(player.getState()).toMatchObject({ processing: false, error: "render failed", revision: version!.revision });
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
  const winner = player.version;
  stretch.jobs[0].resolve(rendered(stretch.jobs[0], 0.125));
  await first;
  expect(player.version).toBe(winner);
  expect(player.buffer!.length).toBe(48000);
  expect(player.buffer!.getChannelData(0)[0]).toBe(0.75);
  expect(player.getState()).toMatchObject({ processing: false, stretchRatio: 1.5, error: null });
});

test("loading a new source resets editing and cannot be overwritten by a stale render", async () => {
  const stretch = deferredProcessor();
  const { context, player } = fixture(stretch);
  await player.load(source(context));
  const firstVersion = player.version!;
  player.setSelection({ start: 0.2, end: 1 });
  player.setLooping(true);
  player.seek(0.4);
  const pending = player.setStretch(1.5);
  const replacement = source(context, 16000);
  await player.load(replacement);
  const replacementVersion = player.version;
  expect(stretch.jobs[0].signal!.aborted).toBe(true);
  expect(player.sourceBuffer).toBe(replacement);
  expect(player.version!.sourceRevision).toBeGreaterThan(firstVersion.sourceRevision);
  expect(player.getState()).toMatchObject({
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
  expect(player.version).toBe(replacementVersion);
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
  expect(player.version).toBeNull();
  expect(player.buffer).toBeNull();
  expect(player.sourceBuffer).toBeNull();
  expect(player.getState()).toMatchObject({ processing: false, duration: 0, isPlaying: false });
  expect(context.state).not.toBe("closed");
  await expect(player.setStretch(1)).rejects.toThrow(/disposed/);
});

test("invalid ratios and incompatible processor PCM retain the complete current revision", async () => {
  const stretch = deferredProcessor();
  const { context, player } = fixture(stretch);
  await player.load(source(context));
  const version = player.version;
  for (const ratio of [0, -1, NaN, Infinity, -Infinity]) {
    await expect(player.setStretch(ratio)).rejects.toThrow(/finite and positive/);
    expect(player.version).toBe(version);
  }
  expect(stretch.process).not.toHaveBeenCalled();
  const expected = 48000;
  const invalid: PCMData[] = [
    { sampleRate: 8000, channels: [new Float32Array(expected)] },
    { sampleRate: 16000, channels: [] },
    { sampleRate: 16000, channels: [new Float32Array(expected), new Float32Array(expected)] },
    { sampleRate: 16000, channels: [new Float32Array(expected - 1)] },
    { sampleRate: 16000, channels: [new Float32Array(expected).fill(NaN)] },
    { sampleRate: 16000, channels: [new Float64Array(expected)] as unknown as Float32Array[] },
  ];
  for (const pcm of invalid) {
    const pending = player.setStretch(1.5);
    const rejection = expect(pending).rejects.toThrow();
    stretch.jobs.at(-1)!.resolve(pcm);
    await rejection;
    expect(player.version).toBe(version);
    expect(player.buffer).toBe(version!.buffer);
    expect(player.getState()).toMatchObject({ processing: false, revision: version!.revision, duration: 2 });
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
  expect(player.version!.ratio).toBe(1);
  expect(player.version!.peaks.frameCount).toBe(original.length);
  expect(player.getSelection()!.start).toBeCloseTo(0.4, 10);
  expect(player.getSelection()!.end).toBeCloseTo(1.6, 10);
  expect(player.position).toBeCloseTo(0.8, 10);
  const identity = player.version;
  stretch.jobs[1].resolve(rendered(stretch.jobs[1]));
  await stale;
  expect(player.version).toBe(identity);
});

test("identity works without a processor while other edits require a loaded source and processor", async () => {
  const { context, player } = fixture();
  expect(player.sourceToOutput(1)).toBe(0);
  expect(player.outputToSource(1)).toBe(0);
  await expect(player.setStretch(1)).rejects.toThrow("No audio source is loaded.");
  const original = source(context);
  await player.load(original);
  const version = player.version;
  await expect(player.setStretch(1.5)).rejects.toThrow("WavePlayer needs a stretch processor.");
  expect(player.version).toBe(version);
  await player.setStretch(1);
  expect(player.buffer).toBe(original);
  expect(player.version!.ratio).toBe(1);
});
