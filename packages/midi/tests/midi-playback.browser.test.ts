import { afterEach, expect, test, vi } from "vitest";
import { MidiRecorder } from "../src/web";
import { compileMidiPlaybackEvents, MidiSequence, type MidiPlaybackEvent } from "../src";

function record(messages: readonly { data: number[]; at: number }[]) {
  const input = new EventTarget();
  const pair = { contextTime: 10, performanceTime: 1000 };
  const context = { state: "running", currentTime: 10, getOutputTimestamp: () => ({ ...pair }) };
  vi.spyOn(performance, "now").mockReturnValue(1000);
  const recorder = new MidiRecorder(context as unknown as AudioContext, input as MIDIInput);
  recorder.start({ when: 10 });
  for (const message of messages) {
    const event = new Event("midimessage");
    Object.defineProperties(event, {
      data: { value: new Uint8Array(message.data) },
      timeStamp: { value: 1000 + message.at * 1000 },
    });
    input.dispatchEvent(event);
  }
  pair.contextTime = 10.1;
  pair.performanceTime = 1100;
  vi.spyOn(performance, "now").mockReturnValue(1100);
  const take = recorder.stop();
  recorder.dispose();
  return take;
}

function at(events: readonly MidiPlaybackEvent[], time: number) {
  return events.filter((event) => Math.abs(event.time - time) < 1e-8).map(({ data, noteId }) => ({ data: [...data], noteId }));
}

afterEach(() => vi.restoreAllMocks());

test("edited overlapping notes retain distinct IDs and recorded sustain controls", () => {
  const take = record([
    { data: [0x90, 60, 50], at: 0 },
    { data: [0x90, 60, 70], at: 0.01 },
    { data: [0xb0, 64, 127], at: 0.02 },
    { data: [0x80, 60, 0], at: 0.03 },
    { data: [0x80, 60, 0], at: 0.04 },
    { data: [0xb0, 64, 0], at: 0.05 },
  ]);
  expect(take.events.map((event) => event.noteId)).toEqual([
    take.notes[0].id,
    take.notes[1].id,
    undefined,
    take.notes[0].id,
    take.notes[1].id,
    undefined,
  ]);
  const sequence = new MidiSequence(take);
  sequence.updateNote(take.notes[1].id, { pitch: 62 });
  const events = compileMidiPlaybackEvents(take, sequence.getState());
  expect(events.map((event) => [...event.data])).toEqual([
    [0x90, 60, 50],
    [0x90, 62, 70],
    [0xb0, 64, 127],
    [0x80, 60, 0],
    [0x80, 62, 0],
    [0xb0, 64, 0],
  ]);
  expect(events.filter((event) => event.noteId).map((event) => event.noteId)).toEqual([
    take.notes[0].id,
    take.notes[1].id,
    take.notes[0].id,
    take.notes[1].id,
  ]);
  sequence.dispose();
});

test("equal-time note release and pedal down keep their recorded delivery order", () => {
  for (const releaseFirst of [true, false]) {
    const take = record([
      { data: [0x90, 60, 90], at: 0 },
      ...(releaseFirst
        ? [
            { data: [0x80, 60, 0], at: 0.03 },
            { data: [0xb0, 64, 127], at: 0.03 },
          ]
        : [
            { data: [0xb0, 64, 127], at: 0.03 },
            { data: [0x80, 60, 0], at: 0.03 },
          ]),
    ]);
    const sequence = new MidiSequence(take);
    sequence.updateNote(take.notes[0].id, { pitch: 62 });
    const events = compileMidiPlaybackEvents(take, sequence.getState());
    expect(at(events, 0.03).map(({ data }) => data)).toEqual(
      releaseFirst
        ? [
            [0x80, 62, 0],
            [0xb0, 64, 127],
          ]
        : [
            [0xb0, 64, 127],
            [0x80, 62, 0],
          ],
    );
    sequence.dispose();
  }
});

test("an edit-created tie follows the original event order", () => {
  const take = record([
    { data: [0x90, 60, 90], at: 0 },
    { data: [0xb0, 64, 127], at: 0.03 },
    { data: [0x80, 60, 0], at: 0.04 },
  ]);
  const sequence = new MidiSequence(take);
  sequence.updateNote(take.notes[0].id, { end: 0.03 });
  expect(at(compileMidiPlaybackEvents(take, sequence.getState()), 0.03).map(({ data }) => data)).toEqual([
    [0xb0, 64, 127],
    [0x80, 60, 0],
  ]);
  sequence.dispose();
});

test("floating-point subtraction does not break a recorded tie", () => {
  const events = compileMidiPlaybackEvents(
    {
      startTime: 10,
      events: [
        { audioTime: 10, data: new Uint8Array([0x90, 60, 90]), noteId: "a" },
        { audioTime: 10.3, data: new Uint8Array([0xb0, 64, 127]) },
        { audioTime: 10.3, data: new Uint8Array([0x80, 60, 0]), noteId: "a" },
      ],
    },
    { notes: [{ id: "a", start: 0, end: 0.3, pitch: 62, velocity: 90, channel: 0, track: 0 }], duration: 1 },
  );
  expect(at(events, 0.3).map(({ data }) => data)).toEqual([
    [0xb0, 64, 127],
    [0x80, 62, 0],
  ]);
  expect(events[1].time).toBe(events[2].time);
});

test("deleted notes stay deleted; new notes follow surviving source events at an edited tie", () => {
  const take = record([
    { data: [0x90, 60, 90], at: 0 },
    { data: [0xb0, 64, 127], at: 0.02 },
    { data: [0x80, 60, 0], at: 0.04 },
  ]);
  const sequence = new MidiSequence(take);
  sequence.setData({ duration: take.duration, notes: [{ id: "new", start: 0.02, end: 0.06, pitch: 65, velocity: 80, channel: 2, track: 0 }] });
  const events = compileMidiPlaybackEvents(take, sequence.getState());
  expect(at(events, 0.02).map(({ data }) => data)).toEqual([
    [0xb0, 64, 127],
    [0x92, 65, 80],
  ]);
  expect(events.some((event) => event.data[1] === 60)).toBe(false);
  expect(events.at(-1)?.data).toEqual(new Uint8Array([0x82, 65, 0]));
  sequence.dispose();
});

test("untagged recorded note-ons fail instead of silently losing their order", () => {
  expect(() =>
    compileMidiPlaybackEvents({ startTime: 10, events: [{ audioTime: 10, data: new Uint8Array([0x90, 60, 80]) }] }, { notes: [], duration: 1 }),
  ).toThrow("MIDI playback needs note IDs on recorded note-ons.");
});

test("playback rejects invalid notes and duplicate IDs with its public error", () => {
  const note = { id: "a", start: 0, end: 0.5, pitch: 60, velocity: 90, channel: 0, track: 0 };
  const source = { startTime: 0, events: [] };
  expect(() => compileMidiPlaybackEvents(source, { duration: 1, notes: [{ ...note, pitch: 128 }] })).toThrow(
    "MIDI playback needs finite, non-negative times and valid MIDI notes.",
  );
  expect(() => compileMidiPlaybackEvents(source, { duration: 1, notes: [note, { ...note }] })).toThrow(
    "MIDI playback needs finite, non-negative times and valid MIDI notes.",
  );
});
