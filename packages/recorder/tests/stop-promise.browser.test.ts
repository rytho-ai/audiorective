import { expect, test } from "vitest";
import { Clock } from "@audiorective/clock";
import { AudioRecorder } from "../src/AudioRecorder";

test.each([false, true].flatMap((preloaded) => [false, true].map((streaming) => ({ preloaded, streaming }))))(
  "Untimed Stop before capture starts cancels without publishing an error (preloaded=$preloaded, streaming=$streaming)",
  async ({ preloaded, streaming }) => {
    const context = new OfflineAudioContext(1, 24000, 48000);
    const recorder = new AudioRecorder(context, { channels: 1 });
    try {
      if (preloaded) await recorder.ready;
      let writes = 0;
      const take = streaming
        ? recorder.record({
            when: 0.2,
            onChunk() {
              writes++;
            },
          })
        : recorder.record({ when: 0.2 });
      void take.catch(() => {});
      let stopped: ReturnType<AudioRecorder["stop"]> | undefined;
      expect(() => {
        stopped = streaming ? recorder.stop({ result: "span" }) : recorder.stop();
      }).not.toThrow();
      await expect(stopped).rejects.toMatchObject({ name: "AbortError" });
      await expect(take).rejects.toMatchObject({ name: "AbortError" });
      expect(recorder.cells.state.value).toBe("idle");
      expect(recorder.cells.error.value).toBeNull();
      expect(recorder.cells.startsAt.value).toBeNull();
      expect(recorder.cells.startedAt.value).toBeNull();
      await context.startRendering();
      expect(writes).toBe(0);
    } finally {
      recorder.dispose();
    }
  },
);

test("invalid Stop calls always return rejected promises", async () => {
  const context = new OfflineAudioContext(1, 24000, 48000);
  const recorder = new AudioRecorder(context);
  try {
    let stopped: ReturnType<AudioRecorder["stop"]> | undefined;
    expect(() => {
      stopped = recorder.stop();
    }).not.toThrow();
    await expect(stopped).rejects.toThrow("AudioRecorder has no started take to stop.");
    recorder.dispose();
    expect(() => {
      stopped = recorder.stop();
    }).not.toThrow();
    await expect(stopped).rejects.toThrow("AudioRecorder is disposed.");
  } finally {
    recorder.dispose();
  }
});

test.each([false, true].flatMap((preloaded) => [false, true].map((streaming) => ({ preloaded, streaming }))))(
  "invalid explicit Stop preserves the scheduled take (preloaded=$preloaded, streaming=$streaming)",
  async ({ preloaded, streaming }) => {
    const context = new OfflineAudioContext(1, 48000, 48000);
    const recorder = new AudioRecorder(context, { channels: 1 });
    const source = new ConstantSourceNode(context, { offset: 0.25 });
    source.connect(recorder.input);
    source.start();
    try {
      if (preloaded) await recorder.ready;
      let frames = 0;
      const take = streaming
        ? recorder.record({
            when: 0.5,
            length: 0.1,
            onChunk(chunk) {
              frames += chunk.channels[0].length;
            },
          })
        : recorder.record({ when: 0.5, length: 0.1 });
      const invalidStop = streaming ? recorder.stop({ result: "span", when: 0.25 }) : recorder.stop({ when: 0.25 });
      await expect(invalidStop).rejects.toThrow("AudioRecorder stop must follow its start time.");
      expect(recorder.cells.state.value).toBe("armed");
      expect(recorder.cells.error.value).toBeNull();
      await recorder.ready;
      await Promise.resolve();
      expect(recorder.cells.startsAt.value).toBe(0.5);
      await context.startRendering();
      const captured = await take;
      expect(captured.startFrame).toBe(24000);
      expect(captured.endFrame).toBe(28800);
      if ("channels" in captured) expect(captured.channels[0][0]).toBeCloseTo(0.25, 6);
      else expect(frames).toBe(4800);
    } finally {
      recorder.dispose();
    }
  },
);

test.each([false, true])("a Stop invalidated by the prepared quantized start rejects only Stop (streaming=%s)", async (streaming) => {
  const context = new OfflineAudioContext(1, 144000, 48000);
  const recorder = new AudioRecorder(context, { channels: 1 });
  const clock = new Clock({ context, bpm: 120 });
  clock.attach(recorder);
  clock.start(undefined, 1);
  try {
    const take = streaming ? recorder.record({ quantize: "1m", length: 0.1, onChunk() {} }) : recorder.record({ quantize: "1m", length: 0.1 });
    const stopped = streaming ? recorder.stop({ result: "span", when: 0.25 }) : recorder.stop({ when: 0.25 });
    await expect(stopped).rejects.toThrow("AudioRecorder stop must follow its start time.");
    expect(recorder.cells.state.value).toBe("armed");
    expect(recorder.cells.error.value).toBeNull();
    expect(recorder.cells.startsAt.value).toBe(1.5);
    await context.startRendering();
    const captured = await take;
    expect(captured.startFrame).toBe(72000);
    expect(captured.endFrame).toBe(76800);
  } finally {
    recorder.dispose();
    clock.dispose();
  }
});

test.each([false, true])("immediate untimed Stop after record() on a live context is normal cancellation (streaming=%s)", async (streaming) => {
  const context = new AudioContext();
  const recorder = new AudioRecorder(context, { channels: 1 });
  try {
    await context.resume();
    await recorder.ready;
    const recording = streaming ? recorder.record({ onChunk() {} }) : recorder.record();
    const stopped = streaming ? recorder.stop({ result: "span" }) : recorder.stop();
    await expect(stopped).rejects.toMatchObject({ name: "AbortError" });
    await expect(recording).rejects.toMatchObject({ name: "AbortError" });
    expect(recorder.cells.state.value).toBe("idle");
    expect(recorder.cells.error.value).toBeNull();
  } finally {
    recorder.dispose();
    await context.close();
  }
});
