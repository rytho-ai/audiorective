import { afterEach, expect, test, vi } from "vitest";
import { MidiRecorder } from "../src/web";
import { MidiSequence } from "../src";

function setup() {
  const input = new EventTarget();
  const pair = { contextTime: 10, performanceTime: 1000 };
  const clock = {
    state: "running",
    currentTime: 10.05,
    getOutputTimestamp: () => ({ ...pair }),
  };
  vi.spyOn(performance, "now").mockReturnValue(1000);
  const recorder = new MidiRecorder(clock as unknown as AudioContext, input as MIDIInput);
  function emit(data: number[], timeStamp: number) {
    const event = new Event("midimessage");
    Object.defineProperties(event, {
      data: { value: new Uint8Array(data) },
      timeStamp: { value: timeStamp },
    });
    input.dispatchEvent(event);
  }
  return { input, pair, clock, recorder, emit };
}

afterEach(() => vi.restoreAllMocks());

test("captures raw MIDI and projects paired notes into a MidiSequence-compatible take", () => {
  const { input, pair, recorder, emit } = setup();
  const otherListener = vi.fn();
  input.addEventListener("midimessage", otherListener);
  recorder.start({ when: 10.1 });
  emit([0x90, 60, 50], 1110);
  emit([0x90, 60, 70], 1120);
  emit([0x91, 60, 80], 1130);
  emit([0xb0, 64, 127], 1140); // sustain/control is retained, but note projection follows key release
  emit([0x80, 60, 0], 1150);
  emit([0x90, 60, 0], 1160); // velocity-zero note-on is note-off
  emit([0x81, 60, 0], 1170);
  pair.contextTime = 10.2;
  pair.performanceTime = 1200;
  vi.spyOn(performance, "now").mockReturnValue(1200);
  const take = recorder.stop();

  expect(take.startTime).toBe(10.1);
  expect(take.endTime).toBe(10.2);
  expect(take.events).toHaveLength(7);
  expect(take.events[3]).toMatchObject({ audioTime: 10.14, data: new Uint8Array([0xb0, 64, 127]) });
  expect(take.notes.map(({ pitch, velocity, channel, track }) => ({ pitch, velocity, channel, track }))).toEqual([
    { pitch: 60, velocity: 50, channel: 0, track: 0 },
    { pitch: 60, velocity: 70, channel: 0, track: 0 },
    { pitch: 60, velocity: 80, channel: 1, track: 0 },
  ]);
  take.notes.forEach((note, index) => {
    expect(note.start).toBeCloseTo((index + 1) / 100, 6);
    expect(note.end).toBeCloseTo((index + 5) / 100, 6);
  });
  const sequence = new MidiSequence({ notes: take.notes, duration: take.duration });
  expect(sequence.getState().notes).toHaveLength(3);
  sequence.destroy();
  expect(recorder.cells.state.value).toBe("idle");
  emit([0x90, 61, 80], 1210);
  expect(otherListener).toHaveBeenCalledTimes(8);
  recorder.destroy();
});

test("future start filters early messages; cancellation discards and a later take closes held notes", () => {
  const { pair, recorder, emit } = setup();
  recorder.start({ when: 10.2 });
  expect(() => recorder.stop()).toThrow("MidiRecorder stop must follow its start time.");
  emit([0x90, 60, 80], 1100);
  emit([0x90, 60, 80], 1210);
  recorder.cancel();
  expect(recorder.cells.state.value).toBe("idle");
  pair.contextTime = 10.3;
  pair.performanceTime = 1300;
  vi.spyOn(performance, "now").mockReturnValue(1300);
  recorder.start();
  emit([0x90, 64, 100], 1310);
  emit([0xb0, 64, 127], 1320);
  pair.contextTime = 10.4;
  pair.performanceTime = 1400;
  vi.spyOn(performance, "now").mockReturnValue(1400);
  const take = recorder.stop();
  expect(take.startTime).toBe(10.3);
  expect(take.notes).toHaveLength(1);
  expect(take.notes[0]).toMatchObject({ pitch: 64, velocity: 100, end: take.duration });
  expect(take.events).toHaveLength(2);
  recorder.destroy();
});

test("lifecycle errors leave the input borrowed and destroy is final", () => {
  const { clock, input, recorder, emit } = setup();
  const other = vi.fn();
  input.addEventListener("midimessage", other);
  expect(() => recorder.stop()).toThrow("MidiRecorder has no active take to stop.");
  clock.state = "suspended";
  expect(() => recorder.start()).toThrow("MidiRecorder needs a running AudioContext.");
  clock.state = "running";
  expect(() => recorder.start({ when: NaN })).toThrow("MidiRecorder time must be finite, non-negative seconds.");
  recorder.start();
  expect(() => recorder.start()).toThrow("MidiRecorder already has an active take.");
  recorder.destroy();
  expect(recorder.cells.state.value).toBe("destroyed");
  emit([0x90, 60, 90], 1100);
  expect(other).toHaveBeenCalledTimes(1);
  expect(() => recorder.start()).toThrow("MidiRecorder is destroyed.");
  expect(() => recorder.stop()).toThrow("MidiRecorder is destroyed.");
});

test("before an output timestamp exists, event times use a sampled performance/audio pair", () => {
  const { clock, pair, recorder, emit } = setup();
  pair.contextTime = 0;
  pair.performanceTime = 0;
  clock.currentTime = 2;
  recorder.start();
  emit([0x90, 67, 90], 1050);
  clock.currentTime = 2.1;
  vi.spyOn(performance, "now").mockReturnValue(1100);
  const take = recorder.stop();
  expect(take.startTime).toBe(2);
  expect(take.notes[0].start).toBeCloseTo(0.05, 6);
  expect(take.notes[0].end).toBeCloseTo(0.1, 6);
  recorder.destroy();
});
