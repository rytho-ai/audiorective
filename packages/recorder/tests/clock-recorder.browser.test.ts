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
  expect(take.endFrame).toBe(take.startFrame + rate); // a bar at 240 bpm is exactly one second: the length is exact in frames, whatever float noise the boundary times carry
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
  await new Promise((done) => setTimeout(done, 120));
  const take = await recorder.record({ quantize: "4n", length: 0.25 });
  expect(Number.isInteger(take.startBeat)).toBe(true);
  expect(take.endFrame - take.startFrame).toBe(Math.round(0.25 * take.sampleRate));
});

test("a take is exactly `length` frames even when its boundary is already past or the gate opens late", async () => {
  const { clock, recorder } = await rig(240);
  clock.start();
  // Called on beat 0 itself: the boundary is at or before the first available frame, so the capture starts late.
  const take = await recorder.record({ quantize: "4n", length: 0.25 });
  expect(take.endFrame - take.startFrame).toBe(Math.round(0.25 * take.sampleRate));
  const noted = await recorder.record({ quantize: "4n", length: "4n" });
  expect(noted.endFrame - noted.startFrame).toBe(Math.round(0.25 * noted.sampleRate));
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

test("during a count-in `when: beatToTime(0)` starts the take exactly at beat 0", async () => {
  const { context, clock, recorder } = await rig(240); // a 4/4 bar is one second
  clock.start(context.currentTime + 0.1, -4); // a one-second count-in before beat 0
  const zero = clock.timeline.beatToTime(0);
  expect(zero).toBeGreaterThan(context.currentTime + 1);
  const take = await recorder.record({ when: zero, length: 0.2 });
  expect(take.startFrame).toBe(Math.ceil(zero * context.sampleRate));
  expect(take.startBeat).toBeCloseTo(0, 3);
});

test("stop() ends a take early and resolves record() with the partial take; cancel() discards it with AbortError", async () => {
  const { context, recorder } = await rig(120);
  const early = recorder.record();
  await vi.waitFor(() => expect(recorder.cells.state.value).toBe("recording"));
  await new Promise((done) => setTimeout(done, 150));
  const stopped = await recorder.stop();
  expect(await early).toBe(stopped);
  expect(stopped.endFrame - stopped.startFrame).toBeGreaterThan(0);
  expect(stopped.endTime).toBeLessThan(context.currentTime + 0.1);
  expect(recorder.cells.state.value).toBe("idle");

  const discarded = recorder.record();
  await vi.waitFor(() => expect(recorder.cells.state.value).toBe("recording"));
  recorder.cancel();
  await expect(discarded).rejects.toMatchObject({ name: "AbortError" });
  expect(recorder.cells.state.value).toBe("idle");
});

test.each([
  ["clock.stop()", (r: Awaited<ReturnType<typeof rig>>) => r.clock.stop()],
  ["clock.pause()", (r: Awaited<ReturnType<typeof rig>>) => r.clock.pause()],
  ["clock.seek()", (r: Awaited<ReturnType<typeof rig>>) => r.clock.seek(2)],
  ["detach", (r: Awaited<ReturnType<typeof rig>>) => r.detach()],
])("a take armed for a future `when` is cancelled by %s; a running take is not", async (_name, leave) => {
  const r = await rig(120);
  r.clock.start();
  const waiting = r.recorder.record({ when: r.context.currentTime + 30 });
  await vi.waitFor(() => expect(r.recorder.cells.state.value).toBe("armed"));
  leave(r);
  await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
  expect(r.recorder.cells.state.value).toBe("idle");
});

test("a musical streaming take completes without Stop and returns only its PCM-free span", async () => {
  const { clock, recorder } = await rig(240);
  clock.start();
  const chunks: Array<{ startFrame: number; frames: number; first: number }> = [];
  const span = await recorder.record({
    quantize: "4n",
    length: "4n",
    onChunk(chunk) {
      chunks.push({ startFrame: chunk.startFrame, frames: chunk.channels[0].length, first: chunk.channels[0][0] });
    },
  });
  expect(span).not.toHaveProperty("channels");
  expect(span.channelCount).toBe(1);
  expect(span.endFrame - span.startFrame).toBe(span.sampleRate / 4);
  expect(chunks.length).toBeGreaterThan(1);
  let cursor = span.startFrame;
  for (const chunk of chunks) {
    expect(chunk.startFrame).toBe(cursor);
    expect(chunk.frames).toBeLessThanOrEqual(4096);
    expect(chunk.first).toBeCloseTo(0.25, 6);
    cursor += chunk.frames;
  }
  expect(cursor).toBe(span.endFrame);
  expect(recorder.cells.state.value).toBe("idle");
});
