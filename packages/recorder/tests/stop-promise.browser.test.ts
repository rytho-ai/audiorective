import { expect, test } from "vitest";
import { AudioRecorder } from "../src/AudioRecorder";

test.each([false, true].flatMap((preloaded) => [false, true].map((streaming) => ({ preloaded, streaming }))))(
  "Stop before capture starts rejects both promises and clears the take (preloaded=$preloaded, streaming=$streaming)",
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
      await expect(stopped).rejects.toMatchObject({ name: "RangeError" });
      await expect(take).rejects.toMatchObject({ name: "RangeError" });
      expect(recorder.cells.state.value).toBe("idle");
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
