import { afterEach, expect, test, vi } from "vitest";
import { AudioRecorder, toAudioBuffer } from "../src/AudioRecorder";

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

  const recording = recorder.record({ when: 0.1 });
  await vi.waitFor(() => expect(recorder.cells.startsAt.value).toBe(0.1)); // an offline context renders only what is armed
  const takePromise = recorder.stop({ when: 0.3 });
  const monitor = await context.startRendering();
  const take = await takePromise;
  expect(await recording).toBe(take);
  expect(take.startBeat).toBeNull();

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

  const first = recorder.record({ when: 0.1 });
  await vi.waitFor(() => expect(recorder.cells.startsAt.value).toBe(0.1));
  const cancelled = recorder.stop({ when: 0.15 });
  recorder.cancel();
  await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
  await expect(first).rejects.toMatchObject({ name: "AbortError" });
  expect(recorder.cells.state.value).toBe("idle");
  const next = recorder.record({ when: 0.2, length: 0.1 });
  await vi.waitFor(() => expect(recorder.cells.startsAt.value).toBe(0.2));
  const output = await context.startRendering();
  const take = await next;
  expect(take.startTime).toBe(0.2);
  expect(take.endFrame - take.startFrame).toBe(sampleRate * 0.1);
  expect(take.channels[0][sampleRate * 0.05]).toBeCloseTo(0.2, 6);
  expect(output.getChannelData(0)[sampleRate * 0.2]).toBeCloseTo(0.2, 6);
});

test("invalid commands preserve the current take and dispose is final", async () => {
  const context = new OfflineAudioContext(1, 48_000, 48_000);
  expect(() => new AudioRecorder(context, { channels: 0 })).toThrow("AudioRecorder channels must be an integer from 1 to 32.");
  const recorder = new AudioRecorder(context, { channels: 1 });
  disposers.push(() => recorder.dispose());
  await expect(recorder.record({ when: NaN })).rejects.toThrow("AudioRecorder time must be finite, non-negative seconds.");
  expect(recorder.cells.state.value).toBe("idle");
  expect(() => recorder.stop()).toThrow("AudioRecorder has no started take to stop.");
  const active = recorder.record({ when: 0.1 });
  const settled = expect(active).rejects.toThrow("AudioRecorder is disposed.");
  await expect(recorder.record()).rejects.toThrow("AudioRecorder already has an active take.");
  await vi.waitFor(() => expect(recorder.cells.startsAt.value).toBe(0.1));
  expect(() => recorder.stop({ when: 0.1 })).toThrow("AudioRecorder stop must follow its start time.");
  expect(recorder.cells.state.value).toBe("armed");
  recorder.dispose();
  await settled;
  expect(recorder.cells.state.value).toBe("disposed");
  await expect(recorder.record()).rejects.toThrow("AudioRecorder is disposed.");
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
  const take = await recorder.record({ when, length: 0.15 });
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
  const pending = recorder.record({ when: context.currentTime + 0.1, length: 0.4 });
  await vi.waitFor(() => expect(recorder.cells.startsAt.value).not.toBeNull());
  await context.close();
  await expect(pending).rejects.toThrow("AudioRecorder AudioContext closed during recording.");
  expect(recorder.cells.error.value).toBe("AudioRecorder AudioContext closed during recording.");
  expect(recorder.cells.state.value).toBe("idle");
});

test("the cells report the armed start and the capture start of a take", async () => {
  const sampleRate = 48_000;
  const context = new OfflineAudioContext(1, sampleRate, sampleRate);
  const recorder = new AudioRecorder(context, { channels: 1 });
  disposers.push(() => recorder.dispose());
  const source = new ConstantSourceNode(context, { offset: 0.1 });
  source.connect(recorder.input);
  source.start(0);
  const taken = recorder.record({ when: 0.25, length: 0.25 });
  await vi.waitFor(() => expect(recorder.cells.startsAt.value).toBe(0.25));
  expect(recorder.cells.startedAt.value).toBeNull();
  await context.startRendering();
  const take = await taken;
  expect([take.startTime, take.endTime]).toEqual([0.25, 0.5]);
  expect(recorder.cells.startsAt.value).toBeNull();
  expect(recorder.cells.startedAt.value).toBeNull();
});

test("record rejects invalid or clockless requests with one documented error each", async () => {
  const context = new OfflineAudioContext(1, 48_000, 48_000);
  const recorder = new AudioRecorder(context, { channels: 1 });
  disposers.push(() => recorder.dispose());
  await expect(recorder.record({ quantize: "1m" })).rejects.toMatchObject({
    name: "InvalidStateError",
    message: "AudioRecorder quantize needs clock.attach(recorder).",
  });
  await expect(recorder.record({ length: "4m" })).rejects.toMatchObject({
    name: "InvalidStateError",
    message: "AudioRecorder length needs clock.attach(recorder).",
  });
  await expect(recorder.record({ quantize: "1m", when: 1 })).rejects.toThrow("AudioRecorder record() takes `when` or `quantize`, not both.");
  await expect(recorder.record({ length: 0 })).rejects.toThrow("AudioRecorder length must be positive seconds or a note value.");
  await expect(recorder.record({ quantize: "bar" as never })).rejects.toThrow('AudioRecorder requires a note value such as "4n" or "1m", got "bar".');
  expect(recorder.cells.state.value).toBe("idle");
});

test("an AbortSignal discards the take with AbortError, and aborting the recorder's signal disposes it", async () => {
  const context = new OfflineAudioContext(1, 48_000, 48_000);
  const recorder = new AudioRecorder(context, { channels: 1 });
  disposers.push(() => recorder.dispose());
  const controller = new AbortController();
  const taken = recorder.record({ when: 0.1, signal: controller.signal });
  await vi.waitFor(() => expect(recorder.cells.startsAt.value).toBe(0.1));
  controller.abort();
  await expect(taken).rejects.toMatchObject({ name: "AbortError" });
  expect(recorder.cells.state.value).toBe("idle");

  const owner = new AbortController();
  const bound = new AudioRecorder(context, { channels: 1, signal: owner.signal });
  owner.abort();
  expect(bound.cells.state.value).toBe("disposed");
});

test("toAudioBuffer copies a take's PCM into an AudioBuffer", async () => {
  const context = new OfflineAudioContext(2, 100, 44_100);
  const left = Float32Array.from({ length: 100 }, (_, index) => index / 100);
  const right = Float32Array.from({ length: 100 }, (_, index) => -index / 100);
  const buffer = toAudioBuffer({ channels: [left, right], sampleRate: 44_100 }, context);
  expect([buffer.numberOfChannels, buffer.length, buffer.sampleRate]).toEqual([2, 100, 44_100]);
  expect(Array.from(buffer.getChannelData(1).slice(0, 3))).toEqual(Array.from(right.slice(0, 3)));
  expect(buffer.getChannelData(0)).not.toBe(left);
});

test("stop asked while the capture graph is still being built ends the take as soon as it starts", async () => {
  const context = new AudioContext();
  const recorder = new AudioRecorder(context, { channels: 1 });
  disposers.push(
    () => context.close(),
    () => recorder.dispose(),
  );
  await context.resume();
  const when = context.currentTime + 0.3;
  const recording = recorder.record({ when });
  const stopped = recorder.stop({ when: when + 0.1 });
  expect(recorder.cells.state.value).toBe("stopping");
  const take = await stopped;
  expect(await recording).toBe(take);
  expect(Math.abs(take.endFrame - take.startFrame - Math.ceil(0.1 * context.sampleRate))).toBeLessThanOrEqual(1);
});
