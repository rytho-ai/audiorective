import { expect, test, vi } from "vitest";
import { Clock } from "@audiorective/clock";
import { AudioRecorder } from "../src/AudioRecorder";

const leave = (clock: Clock, reason: "stop" | "pause" | "seek") => {
  if (reason === "stop") clock.stop();
  else if (reason === "pause") clock.pause();
  else clock.seek(32);
};

test.each((["stop", "pause", "seek"] as const).flatMap((reason) => [false, true].map((streaming) => ({ reason, streaming }))))(
  "leaving the transport keeps audio captured while begin is queued (reason=$reason, streaming=$streaming)",
  async ({ reason, streaming }) => {
    const context = new AudioContext({ sampleRate: 48000 });
    const recorder = new AudioRecorder(context, { channels: 1 });
    const clock = new Clock({ context, bpm: 120 });
    const source = new ConstantSourceNode(context, { offset: 0.25 });
    source.connect(recorder.input);
    source.start();
    try {
      await context.resume();
      await recorder.ready;
      clock.attach(recorder);
      const clockStart = context.currentTime + 0.01;
      clock.start(clockStart);
      const when = clockStart + 0.05;
      let written = 0;
      const recording = streaming
        ? recorder.record({
            when,
            onChunk(chunk) {
              written += chunk.channels[0].length;
            },
          })
        : recorder.record({ when });
      const limit = performance.now() + 2000;
      // Keep begin/chunk messages queued on the main thread while native capture runs.
      while (context.currentTime < when + 0.25 && performance.now() < limit) {}
      expect(context.currentTime).toBeGreaterThan(when + 0.1);
      expect(recorder.cells.state.value).toBe("armed");
      expect(recorder.cells.startedAt.value).toBeNull();

      leave(clock, reason);

      expect(recorder.cells.state.value).toBe("armed");
      await vi.waitFor(() => expect(recorder.cells.state.value).toBe("recording"));
      const take = await (streaming ? recorder.stop({ result: "span" }) : recorder.stop());
      expect(await recording).toBe(take);
      expect(take.endFrame - take.startFrame).toBeGreaterThan(4800);
      if ("channels" in take) expect(take.channels[0].some((x) => Math.abs(x - 0.25) < 1e-6)).toBe(true);
      else expect(written).toBe(take.endFrame - take.startFrame);
      expect(recorder.cells.error.value).toBeNull();
      if ("startBeat" in take) expect(take.startBeat).toBeCloseTo((take.startTime - clockStart) * 2, 2);
    } finally {
      recorder.dispose();
      clock.dispose();
      await context.close();
    }
  },
);

test.each(["stop", "pause", "seek"] as const)("leaving the transport before the first frame still cancels the take (reason=%s)", async (reason) => {
  const context = new AudioContext({ sampleRate: 48000 });
  const recorder = new AudioRecorder(context, { channels: 1 });
  const clock = new Clock({ context, bpm: 120 });
  try {
    await context.resume();
    await recorder.ready;
    clock.attach(recorder);
    clock.start();
    const recording = recorder.record({ when: context.currentTime + 1 });
    leave(clock, reason);
    await expect(recording).rejects.toMatchObject({ name: "AbortError" });
    expect(recorder.cells.state.value).toBe("idle");
    expect(recorder.cells.error.value).toBeNull();
  } finally {
    recorder.dispose();
    clock.dispose();
    await context.close();
  }
});

test.each([false, true])("a Stop before the quantized boundary stays invalid when preparation finishes late (streaming=%s)", async (streaming) => {
  const context = new OfflineAudioContext(1, 144000, 48000);
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
  const clock = new Clock({ context, bpm: 120 });
  clock.attach(recorder);
  clock.start(undefined, 1);
  let render: Promise<AudioBuffer> | undefined;
  try {
    const recording = streaming ? recorder.record({ quantize: "1m", length: 0.1, onChunk() {} }) : recorder.record({ quantize: "1m", length: 0.1 });
    const stopped = streaming ? recorder.stop({ result: "span", when: 0.25 }) : recorder.stop({ when: 0.25 });
    void stopped.catch(() => {});
    await nativeModuleReady;
    const advanced = context.suspend(0.3);
    render = context.startRendering();
    await advanced;
    release();
    await expect(stopped).rejects.toThrow("AudioRecorder stop must follow its start time.");
    expect(recorder.cells.state.value).toBe("armed");
    expect(recorder.cells.error.value).toBeNull();
    await vi.waitFor(() => expect(recorder.cells.startsAt.value).toBe(1.5));
    await context.resume();
    await render;
    const take = await recording;
    expect(take.startFrame).toBe(72000);
    expect(take.endFrame).toBe(76800);
  } finally {
    release();
    registration.mockRestore();
    recorder.dispose();
    clock.dispose();
    if (context.state === "suspended") await context.resume();
    await render;
  }
});

test.each([false, true])("a past Stop during quantized preparation still means stop now (streaming=%s)", async (streaming) => {
  const context = new OfflineAudioContext(1, 144000, 48000);
  let release!: () => void;
  const registrationGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let loaded!: () => void;
  const nativeModuleReady = new Promise<void>((resolve) => {
    loaded = resolve;
  });
  const addModule = context.audioWorklet.addModule.bind(context.audioWorklet);
  const registration = vi.spyOn(context.audioWorklet, "addModule").mockImplementation(async (...args) => {
    await addModule(...args);
    loaded();
    await registrationGate;
  });
  const recorder = new AudioRecorder(context, { channels: 1 });
  const clock = new Clock({ context, bpm: 120 });
  clock.attach(recorder);
  clock.start(undefined, 1);
  let render: Promise<AudioBuffer> | undefined;
  try {
    const recording = streaming ? recorder.record({ quantize: "1m", length: 0.1, onChunk() {} }) : recorder.record({ quantize: "1m", length: 0.1 });
    void recording.catch(() => {});
    await nativeModuleReady;
    const advanced = context.suspend(0.3);
    render = context.startRendering();
    await advanced;
    const stopped = streaming ? recorder.stop({ result: "span", when: 0.1 }) : recorder.stop({ when: 0.1 });
    void stopped.catch(() => {});
    release();
    await expect(stopped).rejects.toMatchObject({ name: "AbortError" });
    await expect(recording).rejects.toMatchObject({ name: "AbortError" });
    expect(recorder.cells.state.value).toBe("idle");
    expect(recorder.cells.error.value).toBeNull();
  } finally {
    release();
    registration.mockRestore();
    recorder.dispose();
    clock.dispose();
    if (context.state === "suspended") await context.resume();
    await render;
  }
});
