import { afterEach, expect, test } from "vitest";
import { AudioRecorder } from "../src/AudioRecorder";

const disposers: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0).reverse()) await dispose();
});

test("captures a scheduled live source at exact audio frames without duplicating monitor sound", async () => {
  const sampleRate = 48_000;
  const context = new OfflineAudioContext(1, sampleRate / 2, sampleRate);
  const recorder = new AudioRecorder(context, { channels: 1 });
  disposers.push(() => recorder.dispose());

  const source = new ConstantSourceNode(context, { offset: 0.3 });
  source.connect(recorder.input);
  source.connect(context.destination);
  source.start(0.15);
  source.stop(0.25);

  await recorder.start({ when: 0.1 });
  const takePromise = recorder.stop({ when: 0.3 });
  const monitor = await context.startRendering();
  const take = await takePromise;

  expect(take.startTime).toBe(0.1);
  expect(take.endTime).toBe(0.3);
  expect(take.sampleRate).toBe(sampleRate);
  expect(take.channels).toHaveLength(1);
  expect(take.channels[0]).toHaveLength(sampleRate * 0.2);
  const recorded = take.channels[0];
  expect(recorded[0]).toBe(0);
  expect(recorded[sampleRate * 0.05 - 1]).toBe(0);
  expect(recorded[sampleRate * 0.05]).toBeCloseTo(0.3, 6);
  expect(recorded[sampleRate * 0.15 - 1]).toBeCloseTo(0.3, 6);
  expect(recorded[sampleRate * 0.15]).toBe(0);
  expect(monitor.getChannelData(0)[sampleRate * 0.2]).toBeCloseTo(0.3, 6);
  expect(recorder.cells.state.value).toBe("idle");
});

test("streams ordered PCM chunks without returning a full in-memory take", async () => {
  const sampleRate = 48_000;
  const context = new OfflineAudioContext(1, sampleRate / 2, sampleRate);
  const recorder = new AudioRecorder(context, { channels: 1 });
  disposers.push(() => recorder.dispose());
  const source = new ConstantSourceNode(context, { offset: 0.25 });
  source.connect(recorder.input);
  source.start(0);
  source.stop(0.4);
  const chunks: Array<{ startFrame: number; size: number; peak: number }> = [];
  await recorder.startStream(
    async (chunk) => {
      await Promise.resolve();
      chunks.push({
        startFrame: chunk.startFrame,
        size: chunk.channels[0].length,
        peak: Math.max(...chunk.channels[0]),
      });
    },
    { when: 0.1 },
  );
  expect(() => recorder.stop()).toThrow("AudioRecorder streaming take needs stopStream().");
  const pending = recorder.stopStream({ when: 0.3 });
  await context.startRendering();
  const span = await pending;
  expect(span).toEqual({ channelCount: 1, sampleRate, startFrame: 4800, endFrame: 14400, startTime: 0.1, endTime: 0.3 });
  expect(chunks.length).toBeGreaterThan(1);
  expect(
    chunks.reduce((cursor, chunk) => {
      expect(chunk.startFrame).toBe(cursor);
      expect(chunk.peak).toBeCloseTo(0.25, 6);
      return cursor + chunk.size;
    }, span.startFrame),
  ).toBe(span.endFrame);
  expect(recorder.cells.state.value).toBe("idle");
});

test("a stalled chunk writer fails instead of retaining an unbounded take", async () => {
  const context = new OfflineAudioContext(1, 48_000 * 8, 48_000);
  const recorder = new AudioRecorder(context, { channels: 1 });
  disposers.push(() => recorder.dispose());
  const source = new ConstantSourceNode(context, { offset: 0.2 });
  source.connect(recorder.input);
  source.start(0);
  await recorder.startStream(() => new Promise<void>(() => {}), { when: 0.1 });
  const pending = recorder.stopStream({ when: 7 });
  const rejected = expect(pending).rejects.toThrow("AudioRecorder stream writer fell behind.");
  await context.startRendering();
  await rejected;
  expect(recorder.cells.state.value).toBe("idle");
});

test("a failed chunk writer rejects the streamed take and releases capture", async () => {
  const context = new OfflineAudioContext(1, 48_000, 48_000);
  const recorder = new AudioRecorder(context, { channels: 1 });
  disposers.push(() => recorder.dispose());
  const source = new ConstantSourceNode(context, { offset: 0.2 });
  source.connect(recorder.input);
  source.start(0);
  await recorder.startStream(() => Promise.reject(new Error("Storage full")), { when: 0.1 });
  const rejected = expect(recorder.stopStream({ when: 0.5 })).rejects.toThrow("Storage full");
  await context.startRendering();
  await rejected;
  expect(recorder.cells.error.value).toBe("Storage full");
  expect(recorder.cells.state.value).toBe("idle");
});

test("cancel discards a stopped take, then a second take reuses the borrowed input", async () => {
  const sampleRate = 48_000;
  const context = new OfflineAudioContext(1, sampleRate / 2, sampleRate);
  const recorder = new AudioRecorder(context, { channels: 1 });
  disposers.push(() => recorder.dispose());
  const source = new ConstantSourceNode(context, { offset: 0.2 });
  source.connect(recorder.input);
  source.connect(context.destination);
  source.start(0);
  source.stop(0.4);

  await recorder.start({ when: 0.1 });
  const cancelled = recorder.stop({ when: 0.15 });
  recorder.cancel();
  await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
  expect(recorder.cells.state.value).toBe("idle");
  await recorder.start({ when: 0.2 });
  const next = recorder.stop({ when: 0.3 });
  const output = await context.startRendering();
  const take = await next;
  expect(take.startTime).toBe(0.2);
  expect(take.endTime).toBe(0.3);
  expect(take.channels[0][sampleRate * 0.05]).toBeCloseTo(0.2, 6);
  expect(output.getChannelData(0)[sampleRate * 0.2]).toBeCloseTo(0.2, 6);
});

test("invalid commands preserve the current take and dispose is final", async () => {
  const context = new OfflineAudioContext(1, 48_000, 48_000);
  expect(() => new AudioRecorder(context, { channels: 0 })).toThrow("AudioRecorder channels must be an integer from 1 to 32.");
  const recorder = new AudioRecorder(context, { channels: 1 });
  disposers.push(() => recorder.dispose());
  await expect(recorder.start({ when: NaN })).rejects.toThrow("AudioRecorder time must be finite, non-negative seconds.");
  expect(recorder.cells.state.value).toBe("idle");
  expect(() => recorder.stop()).toThrow("AudioRecorder has no started take to stop.");
  await recorder.start({ when: 0.1 });
  await expect(recorder.start()).rejects.toThrow("AudioRecorder already has an active take.");
  expect(() => recorder.stop({ when: 0.1 })).toThrow("AudioRecorder stop must follow its start time.");
  expect(recorder.cells.state.value).toBe("armed");
  recorder.dispose();
  expect(recorder.cells.state.value).toBe("disposed");
  await expect(recorder.start()).rejects.toThrow("AudioRecorder is disposed.");
  await expect(recorder.ready).rejects.toThrow("AudioRecorder is disposed.");
});

test("real-time scheduled capture shares the playback clock to one frame", async () => {
  const context = new AudioContext();
  const recorder = new AudioRecorder(context, { channels: 1 });
  disposers.push(
    () => context.close(),
    () => recorder.dispose(),
  );
  const source = new ConstantSourceNode(context, { offset: 0.4 });
  source.connect(recorder.input);
  await context.resume();
  await recorder.ready;
  const when = context.currentTime + 0.25;
  source.start(when + 0.05);
  source.stop(when + 0.1);
  await recorder.start({ when });
  const take = await recorder.stop({ when: when + 0.15 });
  const rate = context.sampleRate;
  expect(Math.abs(take.startFrame - Math.ceil(when * rate))).toBeLessThanOrEqual(1);
  expect(Math.abs(take.endFrame - Math.ceil((when + 0.15) * rate))).toBeLessThanOrEqual(1);
  const firstSound = take.channels[0].findIndex((sample) => Math.abs(sample) > 0.2);
  expect(Math.abs(firstSound - Math.ceil((when + 0.05) * rate) + take.startFrame)).toBeLessThanOrEqual(1);
});

test("closing the caller's live context fails a pending take visibly", async () => {
  const context = new AudioContext();
  const recorder = new AudioRecorder(context, { channels: 1 });
  disposers.push(() => recorder.dispose());
  await context.resume();
  await recorder.start({ when: context.currentTime + 0.1 });
  const pending = recorder.stop({ when: context.currentTime + 0.5 });
  await context.close();
  await expect(pending).rejects.toThrow("AudioRecorder AudioContext closed during recording.");
  expect(recorder.cells.error.value).toBe("AudioRecorder AudioContext closed during recording.");
  expect(recorder.cells.state.value).toBe("idle");
});
