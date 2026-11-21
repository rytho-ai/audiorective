import { afterEach, expect, test, vi } from "vitest";
import { AudioRecorder } from "../src/AudioRecorder";

const recorders: AudioRecorder[] = [];
afterEach(() => {
  for (const recorder of recorders.splice(0)) recorder.dispose();
});
function rig() {
  const context = new OfflineAudioContext(1, 48_000, 48_000);
  const recorder = new AudioRecorder(context, { channels: 1 });
  recorders.push(recorder);
  return { context, recorder };
}

test("buffered cancel releases idle synchronously and the next record can start in the same turn", async () => {
  const { context, recorder } = rig();
  const states: string[] = [];
  recorder.cells.state.subscribe((state) => states.push(state), { immediate: true });
  const first = recorder.record({ when: 0.1 });
  recorder.cancel();
  expect(recorder.cells.state.value).toBe("idle");
  expect(states).toEqual(["idle", "armed", "idle"]);
  const next = recorder.record({ when: 0.2, length: 0.1 });
  expect(recorder.cells.state.value).toBe("armed");
  await expect(first).rejects.toMatchObject({ name: "AbortError" });
  await vi.waitFor(() => expect(recorder.cells.startsAt.value).toBe(0.2));
  await context.startRendering();
  const take = await next;
  expect(take.startFrame).toBe(9600);
  expect(take.endFrame).toBe(14400);
});

test("a buffered second stop keeps its original error and preserves the first stop's take", async () => {
  const { context, recorder } = rig();
  const recording = recorder.record({ when: 0.1 });
  await vi.waitFor(() => expect(recorder.cells.startsAt.value).toBe(0.1));
  const firstStop = recorder.stop({ when: 0.2 });
  expect(() => recorder.stop({ when: 0.3 })).toThrow("AudioRecorder has no started take to stop.");
  await context.startRendering();
  const take = await firstStop;
  expect(await recording).toBe(take);
  expect(take.startFrame).toBe(4800);
  expect(take.endFrame).toBe(9600);
});

test("buffered natural completion preserves its capture-state sequence without a writer-finalizing phase", async () => {
  const { context, recorder } = rig();
  const states: string[] = [];
  recorder.cells.state.subscribe((state) => states.push(state), { immediate: true });
  const recording = recorder.record({ when: 0.1, length: 0.1 });
  await vi.waitFor(() => expect(recorder.cells.startsAt.value).toBe(0.1));
  await context.startRendering();
  expect((await recording).channels[0]).toHaveLength(4800);
  expect(states).toEqual(["idle", "armed", "recording", "idle"]);
});
