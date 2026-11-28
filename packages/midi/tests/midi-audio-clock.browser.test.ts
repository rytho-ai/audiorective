import { expect, test } from "vitest";
import { effect } from "@audiorective/core";
import { Clock } from "@audiorective/clock";
import { MidiRecorder } from "../src/web";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("changing tempo does not rerun an effect that only issued record", async () => {
  const context = new AudioContext();
  const clock = new Clock({ context, bpm: 120 });
  const recorder = new MidiRecorder(context, new EventTarget());
  clock.attach(recorder);
  const takes: Promise<unknown>[] = [];
  let runs = 0;
  const stop = effect(() => {
    runs++;
    if (runs <= 2) {
      const take = recorder.record();
      void take.catch(() => {});
      takes.push(take);
    }
  });
  try {
    clock.bpm.value = 90;
    expect(runs).toBe(1);
  } finally {
    stop();
    recorder.cancel();
    await Promise.allSettled(takes);
    recorder.dispose();
    clock.dispose();
    await context.close();
  }
});

test("a timed MIDI take waits for the native audio clock and captures after resume", async () => {
  const context = new AudioContext();
  await context.resume();
  const recorder = new MidiRecorder(context, new EventTarget());
  const start = context.currentTime + 0.08;
  const take = recorder.record({ when: start, length: 0.08 });
  await context.suspend();
  let settled = false;
  void take.then(
    () => (settled = true),
    () => (settled = true),
  );
  try {
    await delay(250);
    expect(context.currentTime).toBeLessThan(start);
    expect({ state: recorder.cells.state.value, startedAt: recorder.cells.startedAt.value, settled }).toEqual({
      state: "armed",
      startedAt: null,
      settled: false,
    });
    await context.resume();
    const result = await take;
    expect(context.currentTime).toBeGreaterThanOrEqual(result.endTime);
    expect(result.startTime).toBe(start);
    expect(result.endTime).toBeCloseTo(start + 0.08, 6);
  } finally {
    recorder.cancel();
    recorder.dispose();
    await context.close();
  }
});

test("transport stop still cancels a future MIDI take after its wall deadline passed while suspended", async () => {
  const context = new AudioContext();
  const clock = new Clock({ context });
  const recorder = new MidiRecorder(context, new EventTarget());
  clock.attach(recorder);
  await context.resume();
  clock.start();
  const take = recorder.record({ when: context.currentTime + 0.08, length: 0.2 });
  await context.suspend();
  void take.catch(() => {});
  try {
    await delay(120);
    clock.stop();
    await expect(take).rejects.toMatchObject({ name: "AbortError" });
  } finally {
    recorder.cancel();
    recorder.dispose();
    clock.dispose();
    await context.close();
  }
});
