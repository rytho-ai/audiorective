import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { effect } from "@audiorective/core";
import { Clock, ManualTickSource } from "@audiorective/clock";
import { MidiClip } from "../src";
import { MidiRecorder } from "../src/web";

/** A context whose clock is `ctx.currentTime`; a Web MIDI timestamp of T ms is context time T / 1000. */
function setup(start = 10) {
  const ctx = {
    state: "running",
    currentTime: start,
    getOutputTimestamp: () => ({ contextTime: ctx.currentTime, performanceTime: ctx.currentTime * 1000 }),
  };
  const input = new EventTarget();
  const recorder = new MidiRecorder(ctx as unknown as AudioContext, input as MIDIInput);
  const emit = (data: number[], time: number) => {
    const event = new Event("midimessage");
    Object.defineProperties(event, { data: { value: new Uint8Array(data) }, timeStamp: { value: time * 1000 } });
    input.dispatchEvent(event);
  };
  const clock = new Clock({ context: ctx, tickSource: new ManualTickSource(), bpm: 120 });
  return { ctx, input, recorder, emit, clock };
}
const settled = <T>(promise: Promise<T>) =>
  promise.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("MidiRecorder without a clock", () => {
  test("records notes in beats at 120 BPM with 0..1 velocity; held notes close at the end; outside the window is ignored", async () => {
    const { ctx, recorder, emit } = setup();
    emit([0x90, 59, 100], 10.05); // before the take starts
    const take = recorder.record({ when: 10.1 });
    expect(recorder.cells.state.value).toBe("armed");
    expect(recorder.cells.startsAt.value).toBe(10.1);
    emit([0x90, 60, 127], 10.1);
    emit([0x90, 60, 64], 10.2); // second press of the same pitch before the first release (FIFO pairing)
    emit([0xb0, 64, 127], 10.3); // controller goes to events
    emit([0x80, 60, 0], 10.35);
    emit([0x90, 60, 0], 10.4); // velocity-0 note-on is note-off
    emit([0x91, 64, 90], 10.45); // held when the take ends
    emit([0xf8], 10.46); // real-time clock bytes are not events
    ctx.currentTime = 10.6;
    const stopped = recorder.stop();
    emit([0x80, 64, 0], 10.7); // after the end: ignored
    const result = await take;
    expect(await stopped).toBe(result);
    expect(result.startBeat).toBeNull();
    expect(result.startTime).toBe(10.1);
    expect(result.endTime).toBe(10.6);
    expect(result.duration).toBeCloseTo(1, 6);
    expect(result.notes.map((n) => [n.pitch, n.channel, +n.start.toFixed(6), +n.duration.toFixed(6), +n.velocity.toFixed(6)])).toEqual([
      [60, 0, 0, 0.5, 1],
      [60, 0, 0.2, 0.4, +(64 / 127).toFixed(6)],
      [64, 1, 0.7, 0.3, +(90 / 127).toFixed(6)],
    ]);
    expect(result.events).toHaveLength(1);
    expect(result.events[0].beat).toBeCloseTo(0.4, 6);
    expect([...result.events[0].data]).toEqual([0xb0, 64, 127]);
    expect(recorder.cells.state.value).toBe("idle");
    expect(recorder.cells.startsAt.value).toBeNull();
    const clip = new MidiClip(result.notes);
    expect(clip.notes.value).toHaveLength(3);
  });

  test("a numeric length ends the take by itself", async () => {
    const { ctx, recorder, emit } = setup();
    const take = recorder.record({ length: 0.5 });
    expect(recorder.cells.state.value).toBe("recording");
    expect(recorder.cells.startedAt.value).toBe(10);
    emit([0x90, 60, 80], 10.1);
    emit([0x80, 60, 0], 10.2);
    emit([0x90, 62, 80], 10.7); // after the end
    ctx.currentTime = 10.5;
    vi.advanceTimersByTime(600);
    const result = await take;
    expect(result.duration).toBeCloseTo(1, 6);
    expect(result.notes.map((n) => n.pitch)).toEqual([60]);
  });

  test("stop() ends early with what was captured; cancel() discards and rejects AbortError", async () => {
    const { ctx, recorder, emit } = setup();
    const kept = recorder.record();
    emit([0x90, 60, 80], 10.1);
    ctx.currentTime = 10.2;
    const early = await recorder.stop();
    expect(early.notes).toHaveLength(1);
    expect(await kept).toBe(early);

    const discarded = settled(recorder.record());
    emit([0x90, 62, 80], 10.3);
    recorder.cancel();
    const outcome = await discarded;
    expect((outcome as { error: DOMException }).error).toMatchObject({ name: "AbortError" });
    expect(recorder.cells.state.value).toBe("idle");
    recorder.cancel(); // nothing active: no-op
    expect(((await settled(recorder.stop())) as { error: DOMException }).error).toMatchObject({ name: "InvalidStateError" });
  });

  test("an abort signal cancels the take; one recorder cannot record twice at once", async () => {
    const { recorder } = setup();
    const controller = new AbortController();
    const take = settled(recorder.record({ signal: controller.signal }));
    expect(((await settled(recorder.record())) as { error: Error }).error.message).toBe("MidiRecorder already has an active take.");
    controller.abort();
    expect(((await take) as { error: DOMException }).error).toMatchObject({ name: "AbortError" });
    expect(recorder.cells.state.value).toBe("idle");
  });

  test("validation", async () => {
    const { ctx, recorder } = setup();
    const error = async (options: Parameters<MidiRecorder["record"]>[0]) => ((await settled(recorder.record(options))) as { error: Error }).error;
    expect(await error({ length: -1 })).toBeInstanceOf(RangeError);
    expect(await error({ when: Number.NaN })).toBeInstanceOf(RangeError);
    expect(await error({ quantize: "1m", when: 11 })).toBeInstanceOf(RangeError);
    expect(await error({ quantize: "1m" })).toMatchObject({
      name: "InvalidStateError",
      message: "MidiRecorder quantize needs clock.attach(recorder).",
    });
    expect(await error({ length: "4m" })).toMatchObject({ name: "InvalidStateError" });
    ctx.state = "suspended";
    expect((await error({})).message).toBe("MidiRecorder needs a running AudioContext.");
    recorder.dispose();
    ctx.state = "running";
    expect((await error({})).message).toBe("MidiRecorder is disposed.");
    expect(recorder.cells.state.value).toBe("disposed");
  });

  test("dispose cancels an active take", async () => {
    const { recorder } = setup();
    const take = settled(recorder.record());
    recorder[Symbol.dispose]();
    expect(((await take) as { error: DOMException }).error).toMatchObject({ name: "AbortError" });
  });
});

describe("MidiRecorder on a clock", () => {
  test("a quantized take starts on the next bar line and reports its beat; notes are relative to the take at the clock's tempo", async () => {
    const { ctx, recorder, emit, clock } = setup();
    clock.attach(recorder);
    clock.start(10); // beat b is at 10 + b / 2
    ctx.currentTime = 10.3; // beat 0.6
    const take = recorder.record({ quantize: "1m", length: "1m" });
    await Promise.resolve();
    expect(recorder.cells.state.value).toBe("armed");
    expect(recorder.cells.startsAt.value).toBeCloseTo(12, 6); // beat 4
    emit([0x90, 60, 100], 11.5); // before the take: ignored
    ctx.currentTime = 12;
    vi.advanceTimersByTime(1800);
    expect(recorder.cells.state.value).toBe("recording");
    expect(recorder.cells.startedAt.value).toBeCloseTo(12, 6);
    emit([0x90, 62, 100], 12.25); // beat 4.5
    emit([0x80, 62, 0], 12.75); // beat 5.5
    emit([0x90, 64, 100], 13.5); // beat 7, held at the end
    emit([0x90, 65, 100], 14.5); // after the end: ignored
    ctx.currentTime = 14;
    vi.advanceTimersByTime(2100);
    const result = await take;
    expect(result.startBeat).toBeCloseTo(4, 6);
    expect(result.startTime).toBeCloseTo(12, 6);
    expect(result.endTime).toBeCloseTo(14, 6);
    expect(result.duration).toBeCloseTo(4, 6);
    expect(result.notes.map((n) => [n.pitch, +n.start.toFixed(6), +n.duration.toFixed(6)])).toEqual([
      [62, 0.5, 1],
      [64, 3, 1],
    ]);
    clock.dispose();
  });

  test("a call exactly on a boundary starts there", async () => {
    const { ctx, recorder, clock } = setup();
    clock.attach(recorder);
    clock.start(10);
    ctx.currentTime = 12; // beat 4
    const take = recorder.record({ quantize: "1m", length: 1 });
    await Promise.resolve();
    expect(recorder.cells.startsAt.value ?? recorder.cells.startedAt.value).toBeCloseTo(12, 6);
    ctx.currentTime = 13;
    vi.advanceTimersByTime(1100);
    expect((await take).startBeat).toBeCloseTo(4, 6);
    clock.dispose();
  });

  test("a quantized start needs a playing clock; leaving the transport before the start cancels the take", async () => {
    const { ctx, recorder, clock } = setup();
    clock.attach(recorder);
    const idle = (await settled(recorder.record({ quantize: "1m" }))) as { error: DOMException };
    expect(idle.error).toMatchObject({ name: "InvalidStateError", message: "MidiRecorder quantize needs a playing clock." });
    clock.start(10);
    ctx.currentTime = 10.3;
    const take = settled(recorder.record({ quantize: "1m" }));
    expect(recorder.cells.state.value).toBe("armed");
    clock.stop();
    expect(((await take) as { error: DOMException }).error).toMatchObject({ name: "AbortError" });
    clock.dispose();
  });

  test("a take that is already recording survives a transport stop; the clock's bpm sets beats when it is not playing", async () => {
    const { ctx, recorder, emit, clock } = setup();
    clock.attach(recorder);
    clock.bpm.value = 60;
    const take = recorder.record({ when: 10 });
    emit([0x90, 60, 100], 10);
    emit([0x80, 60, 0], 11);
    ctx.currentTime = 12;
    const result = await recorder.stop();
    expect(result.startBeat).toBeNull();
    expect(result.notes[0].duration).toBeCloseTo(1, 6); // 1 s at 60 bpm
    expect(result.duration).toBeCloseTo(2, 6);
    await take;
    clock.dispose();
  });

  test("cells.state is tracked", async () => {
    const { ctx, recorder } = setup();
    const states: string[] = [];
    const stop = effect(() => void states.push(recorder.cells.state.value));
    const take = recorder.record();
    ctx.currentTime = 10.1;
    await recorder.stop();
    await take;
    recorder.dispose();
    stop();
    expect(states).toEqual(["idle", "recording", "idle", "disposed"]);
  });
});
