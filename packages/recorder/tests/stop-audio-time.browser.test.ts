import { expect, test, vi } from "vitest";
import { AudioRecorder } from "../src/AudioRecorder";

test.each([false, true].flatMap((streaming) => (["default", "now", "past"] as const).map((timing) => ({ streaming, timing }))))(
  "Stop returns captured audio with begin queued (streaming=$streaming, timing=$timing)",
  async ({ streaming, timing }) => {
    const context = new AudioContext({ sampleRate: 48000 });
    const recorder = new AudioRecorder(context, { channels: 1 });
    const source = new ConstantSourceNode(context, { offset: 0.25 });
    source.connect(recorder.input);
    source.start();
    try {
      await context.resume();
      await recorder.ready;
      const when = context.currentTime + 0.05;
      let written = 0,
        hasSignal = false;
      const recording = streaming
        ? recorder.record({
            when,
            onChunk(chunk) {
              written += chunk.channels[0].length;
              hasSignal ||= chunk.channels[0].some((x) => Math.abs(x - 0.25) < 1e-6);
            },
          })
        : recorder.record({ when });
      const limit = performance.now() + 2000;
      // Keep begin/chunk messages queued on the main thread while native capture runs.
      while (context.currentTime < when + 0.25 && performance.now() < limit) {}
      expect(context.currentTime).toBeGreaterThan(when + 0.1);
      expect(recorder.cells.state.value).toBe("armed");
      expect(recorder.cells.startedAt.value).toBeNull();
      const stoppingAt = context.currentTime;
      const options = timing === "default" ? {} : { when: timing === "now" ? stoppingAt : when - 0.02 };
      const stopped = streaming ? recorder.stop({ result: "span", ...options }) : recorder.stop(options);
      const take = await stopped;
      expect(await recording).toBe(take);
      expect(take.endFrame - take.startFrame).toBeGreaterThan(4800);
      expect(Math.abs(take.endTime - stoppingAt)).toBeLessThan(0.05);
      if ("channels" in take) expect(take.channels[0].some((x) => Math.abs(x - 0.25) < 1e-6)).toBe(true);
      else {
        expect(written).toBe(take.endFrame - take.startFrame);
        expect(hasSignal).toBe(true);
      }
      expect(recorder.cells.error.value).toBeNull();
    } finally {
      recorder.dispose();
      await context.close();
    }
  },
);

test.each([false, true])("a past Stop time is clamped to now and returns the current take (streaming=%s)", async (streaming) => {
  const context = new OfflineAudioContext(1, 48000, 48000);
  const recorder = new AudioRecorder(context, { channels: 1 });
  const source = new ConstantSourceNode(context, { offset: 0.25 });
  source.connect(recorder.input);
  source.start();
  let render: Promise<AudioBuffer> | undefined;
  try {
    await recorder.ready;
    let written = 0;
    const recording = streaming
      ? recorder.record({
          when: 0.1,
          length: 0.8,
          onChunk(chunk) {
            written += chunk.channels[0].length;
          },
        })
      : recorder.record({ when: 0.1, length: 0.8 });
    const stopped = context.suspend(0.3).then(async () => {
      await vi.waitFor(() => expect(recorder.cells.state.value).toBe("recording"));
      const done = streaming ? recorder.stop({ result: "span", when: 0.05 }) : recorder.stop({ when: 0.05 });
      await context.resume();
      return done;
    });
    render = context.startRendering();
    const take = await stopped;
    await render;
    expect(await recording).toBe(take);
    expect(take.startFrame).toBe(4800);
    expect(Math.abs(take.endTime - 0.3)).toBeLessThan(129 / 48000);
    if ("channels" in take) expect(take.channels[0][0]).toBeCloseTo(0.25, 6);
    else expect(written).toBe(take.endFrame - take.startFrame);
    expect(recorder.cells.error.value).toBeNull();
  } finally {
    recorder.dispose();
    if (context.state === "suspended") await context.resume();
    await render;
  }
});

test.each([false, true])(
  "a pending timed Stop that becomes past before graph preparation finishes cancels normally (streaming=%s)",
  async (streaming) => {
    const context = new OfflineAudioContext(1, 48000, 48000);
    let release!: () => void;
    const registrationGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let loaded!: () => void;
    const nativeModuleReady = new Promise<void>((resolve) => {
      loaded = resolve;
    });
    const addModule = context.audioWorklet.addModule.bind(context.audioWorklet);
    // Delay only the platform's module completion; use the real worklet and audio clock.
    const registration = vi.spyOn(context.audioWorklet, "addModule").mockImplementation(async (...args) => {
      await addModule(...args);
      loaded();
      await registrationGate;
    });
    const recorder = new AudioRecorder(context, { channels: 1 });
    let render: Promise<AudioBuffer> | undefined;
    try {
      let writes = 0;
      const recording = streaming
        ? recorder.record({
            when: 0.1,
            length: 0.1,
            onChunk() {
              writes++;
            },
          })
        : recorder.record({ when: 0.1, length: 0.1 });
      const stopped = streaming ? recorder.stop({ result: "span", when: 0.15 }) : recorder.stop({ when: 0.15 });
      // Observe early rejection without changing the eventual assertions below.
      void stopped.catch(() => {});
      // Initialize the native worklet scope before offline rendering; only owner readiness stays delayed.
      await nativeModuleReady;
      const advanced = context.suspend(0.3);
      render = context.startRendering();
      await advanced;
      release();
      await expect(stopped).rejects.toMatchObject({ name: "AbortError" });
      await expect(recording).rejects.toMatchObject({ name: "AbortError" });
      expect(recorder.cells.state.value).toBe("idle");
      expect(recorder.cells.error.value).toBeNull();
      await context.resume();
      await render;
      expect(writes).toBe(0);
    } finally {
      release();
      registration.mockRestore();
      recorder.dispose();
      if (context.state === "suspended") await context.resume();
      await render;
    }
  },
);
