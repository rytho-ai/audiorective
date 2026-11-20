import { afterEach, expect, test, vi } from "vitest";
import { Clock } from "@audiorective/clock";
import { AudioRecorder } from "../src/AudioRecorder";

const disposers: Array<() => void | Promise<unknown>> = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0).reverse()) await dispose();
});

async function rig(bpm: number) {
  const context = new AudioContext();
  const clock = new Clock({ audioContext: context, bpm });
  const recorder = new AudioRecorder(context, { channels: 1 });
  disposers.push(
    () => recorder.dispose(),
    () => clock.dispose(),
    () => context.close(),
  );
  const source = new ConstantSourceNode(context, { offset: 0.25 });
  source.connect(recorder.input);
  source.start();
  await context.resume();
  await recorder.ready;
  const detach = clock.attach(recorder);
  return { context, clock, recorder, detach };
}

test("record({ quantize: '1m', length: '1m' }) starts on a bar line and lasts one bar, to the frame", async () => {
  const { context, clock, recorder } = await rig(240); // a 4/4 bar is exactly one second
  clock.start();
  await new Promise((done) => setTimeout(done, 120));
  const taken = recorder.record({ quantize: "1m", length: "1m" });
  await vi.waitFor(() => expect(recorder.cells.startsAt.value).not.toBeNull());
  const startsAt = recorder.cells.startsAt.value!;
  expect(startsAt).toBeGreaterThan(context.currentTime);
  const take = await taken;

  expect(take.startBeat! % 4).toBe(0);
  expect(take.startBeat).toBeGreaterThan(0);
  const rate = context.sampleRate;
  expect(take.startFrame).toBe(Math.ceil(clock.timeline.beatToTime(take.startBeat!) * rate));
  expect(take.endFrame).toBe(Math.ceil(clock.timeline.beatToTime(take.startBeat! + 4) * rate));
  expect(take.startTime).toBe(startsAt);
  expect(take.endFrame - take.startFrame).toBe(rate);
  expect(take.channels[0]).toHaveLength(take.endFrame - take.startFrame);
  expect(take.channels[0][take.channels[0].length - 1]).toBeCloseTo(0.25, 6);
  expect(recorder.cells.state.value).toBe("idle");
});

test("a note-value quantize follows the beat, and a stopped clock rejects quantize", async () => {
  const { clock, recorder } = await rig(240);
  await expect(recorder.record({ quantize: "1m" })).rejects.toMatchObject({
    name: "InvalidStateError",
    message: "AudioRecorder quantize needs a playing clock.",
  });
  clock.start();
  const take = await recorder.record({ quantize: "4n", length: 0.25 });
  expect(Number.isInteger(take.startBeat)).toBe(true);
  expect(take.endFrame - take.startFrame).toBe(Math.round(0.25 * take.sampleRate));
});

test("leaving the transport before a quantized start cancels the take; a recording in progress continues", async () => {
  const { clock, recorder } = await rig(30); // a bar is eight seconds, so the boundary is far away
  clock.start();
  await new Promise((done) => setTimeout(done, 100));
  const waiting = recorder.record({ quantize: "1m" });
  await vi.waitFor(() => expect(recorder.cells.state.value).toBe("armed"));
  clock.pause();
  await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
  expect(recorder.cells.state.value).toBe("idle");

  clock.resume();
  const running = recorder.record({ length: 0.3 });
  await vi.waitFor(() => expect(recorder.cells.state.value).toBe("recording"));
  clock.stop();
  const take = await running;
  expect(take.endFrame - take.startFrame).toBeGreaterThan(0);
});

test("detaching from the clock removes the transport, and disposing the recorder detaches it", async () => {
  const { clock, recorder, detach } = await rig(240);
  clock.start();
  detach();
  await expect(recorder.record({ quantize: "1m" })).rejects.toMatchObject({ name: "InvalidStateError" });
  const reattach = clock.attach(recorder);
  recorder.dispose();
  expect(() => reattach()).not.toThrow();
});
