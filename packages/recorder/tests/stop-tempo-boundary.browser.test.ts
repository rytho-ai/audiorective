import { expect, test, vi } from "vitest";
import { Clock } from "@audiorective/clock";
import { AudioRecorder } from "../src/AudioRecorder";

const leave = (clock: Clock, reason: "stop" | "pause" | "seek" | "start") => {
  if (reason === "stop") clock.stop();
  else if (reason === "pause") clock.pause();
  else if (reason === "seek") clock.seek(32);
  else clock.start(undefined, 32);
};

test.each(["stop", "pause", "seek", "start"] as const)(
  "a late first frame keeps its beat on a tempo ramp when the transport moves before begin arrives (reason=%s)",
  async (reason) => {
    const context = new AudioContext({ sampleRate: 48000 });
    const recorder = new AudioRecorder(context, { channels: 1 });
    const clock = new Clock({ context, bpm: 60 });
    const control = new Clock({ context, bpm: 60 });
    const source = new ConstantSourceNode(context, { offset: 0.25 });
    source.connect(recorder.input);
    source.start();
    try {
      await context.resume();
      await recorder.ready;
      clock.attach(recorder);
      const origin = context.currentTime + 0.01;
      for (const owner of [clock, control]) {
        owner.start(origin);
        owner.timeline.bpm.setValueAtTime(60, origin);
        owner.timeline.bpm.linearRampToValueAtTime(480, origin + 0.6);
      }
      const when = origin + 0.03;
      const recording = recorder.record({ when });
      // Open the native gate later than planned, so the first frame differs from the planned start.
      const gate = (recorder as unknown as { active: { capture: AudioParam } }).active.capture;
      const lateOpen = when + 0.12;
      gate.cancelScheduledValues(0);
      gate.setValueAtTime(0, context.currentTime);
      gate.setValueAtTime(1, lateOpen);
      const limit = performance.now() + 2000;
      while (context.currentTime < lateOpen + 0.3 && performance.now() < limit) {}
      expect(context.currentTime).toBeGreaterThan(lateOpen + 0.1);
      expect(recorder.cells.startedAt.value).toBeNull();

      leave(clock, reason);

      await vi.waitFor(() => expect(recorder.cells.state.value).toBe("recording"));
      const take = await recorder.stop();
      expect(await recording).toBe(take);
      expect(take.startTime).toBeGreaterThanOrEqual(lateOpen - 0.01);
      expect(take.startBeat).toBeCloseTo(control.timeline.timeToBeat(take.startTime), 3);
    } finally {
      recorder.dispose();
      clock.dispose();
      control.dispose();
      await context.close();
    }
  },
);

test.each([0.3, 0.125].flatMap((readyAt) => [false, true].map((streaming) => ({ readyAt, streaming }))))(
  "a Stop after the requested bar cancels when late preparation moves the start to a later bar (readyAt=$readyAt, streaming=$streaming)",
  async ({ readyAt, streaming }) => {
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
    clock.start(undefined, 3.8); // The next bar is beat 4, at 0.10 seconds.
    let render: Promise<AudioBuffer> | undefined;
    let writes = 0;
    try {
      const recording = streaming
        ? recorder.record({
            quantize: "1m",
            onChunk() {
              writes++;
            },
          })
        : recorder.record({ quantize: "1m" });
      void recording.catch(() => {});
      const stopped = streaming ? recorder.stop({ result: "span", when: 0.15 }) : recorder.stop({ when: 0.15 });
      void stopped.catch(() => {});
      await nativeModuleReady;
      const advanced = context.suspend(readyAt);
      render = context.startRendering();
      await advanced;
      release();
      await expect(stopped).rejects.toMatchObject({ name: "AbortError" });
      await expect(recording).rejects.toMatchObject({ name: "AbortError" });
      expect(recorder.cells.state.value).toBe("idle");
      expect(recorder.cells.startsAt.value).toBeNull();
      expect(recorder.cells.error.value).toBeNull();
      await context.resume();
      await render;
      expect(writes).toBe(0);
    } finally {
      release();
      registration.mockRestore();
      recorder.dispose();
      clock.dispose();
      if (context.state === "suspended") await context.resume();
      await render;
    }
  },
);
