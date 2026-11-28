import { expect, test } from "vitest";
import { Clock } from "@audiorective/clock";
import { AudioRecorder } from "../src/AudioRecorder";

async function rig() {
  const context = new AudioContext();
  const clock = new Clock({ context });
  const recorder = new AudioRecorder(context, { channels: 1 });
  clock.attach(recorder);
  await context.resume();
  await recorder.ready;
  return {
    context,
    clock,
    recorder,
    close: async () => {
      recorder.dispose();
      clock.dispose();
      await context.close();
    },
  };
}

test("a transport start cancels a pending quantized take with AbortError and no error", async () => {
  const { clock, recorder, close } = await rig();
  try {
    clock.start();
    const take = recorder.record({ quantize: "1m", length: 0.05 });
    void take.catch(() => {});
    expect(recorder.cells.startsAt.value).not.toBeNull();
    // Re-anchor the transport far ahead, as a hold does.
    clock.start(clock.timeline.now + 2 ** 20, 0);
    await expect(take).rejects.toMatchObject({ name: "AbortError" });
    expect(recorder.cells.error.value).toBeNull();
    expect(recorder.cells.state.value).toBe("idle");
  } finally {
    await close();
  }
});

test("a take armed with an explicit when survives the transport start it was armed for", async () => {
  const { context, clock, recorder, close } = await rig();
  try {
    const when = context.currentTime + 0.2;
    const take = recorder.record({ when, length: 0.1 });
    clock.start(when);
    const result = await take;
    expect(result.endFrame - result.startFrame).toBe(Math.round(0.1 * context.sampleRate));
  } finally {
    await close();
  }
});

test("a take past its first frame keeps recording through a transport start", async () => {
  const { context, clock, recorder, close } = await rig();
  try {
    clock.start();
    const take = recorder.record({ quantize: "4n", length: 1 });
    for (let i = 0; i < 60 && recorder.cells.startedAt.value === null; i++) await new Promise((resolve) => setTimeout(resolve, 50));
    expect(recorder.cells.startedAt.value).not.toBeNull();
    clock.start(context.currentTime, 0);
    const result = await take;
    expect(result.endFrame - result.startFrame).toBe(Math.round(1 * context.sampleRate));
  } finally {
    await close();
  }
});
