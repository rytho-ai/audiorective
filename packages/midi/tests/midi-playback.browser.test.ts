import { expect, test } from "vitest";
import { compileMidiPlaybackEvents, type MidiNote, type MidiPlaybackEvent, type MidiPlaybackSourceEvent } from "../src";

const bytes = (...data: number[]) => new Uint8Array(data);
const ev = (beat: number, data: number[], noteId?: string): MidiPlaybackSourceEvent => ({
  beat,
  data: bytes(...data),
  ...(noteId ? { noteId } : {}),
});
const note = (id: string, start: number, duration: number, pitch: number, velocity = 90 / 127, channel = 0): MidiNote => ({
  id,
  start,
  duration,
  pitch,
  velocity,
  channel,
});
function at(events: readonly MidiPlaybackEvent[], beat: number) {
  return events.filter((event) => Math.abs(event.beat - beat) < 1e-8).map(({ data, noteId }) => ({ data: [...data], noteId }));
}

test("edited overlapping notes retain distinct IDs and recorded sustain controls", () => {
  const source = {
    events: [
      ev(0, [0x90, 60, 50], "a"),
      ev(0.02, [0x90, 60, 70], "b"),
      ev(0.04, [0xb0, 64, 127]),
      ev(0.06, [0x80, 60, 0], "a"),
      ev(0.08, [0x80, 60, 0], "b"),
      ev(0.1, [0xb0, 64, 0]),
    ],
  };
  const notes = [note("a", 0, 0.06, 60, 50 / 127), note("b", 0.02, 0.06, 62, 70 / 127)];
  const events = compileMidiPlaybackEvents(source, { notes, duration: 1 });
  expect(events.map((event) => [...event.data])).toEqual([
    [0x90, 60, 50],
    [0x90, 62, 70],
    [0xb0, 64, 127],
    [0x80, 60, 0],
    [0x80, 62, 0],
    [0xb0, 64, 0],
  ]);
  expect(events.filter((event) => event.noteId).map((event) => event.noteId)).toEqual(["a", "b", "a", "b"]);
});

test("equal-beat note release and pedal down keep their recorded delivery order", () => {
  for (const releaseFirst of [true, false]) {
    const release = ev(0.03, [0x80, 60, 0], "a");
    const pedal = ev(0.03, [0xb0, 64, 127]);
    const source = { events: [ev(0, [0x90, 60, 90], "a"), ...(releaseFirst ? [release, pedal] : [pedal, release])] };
    const events = compileMidiPlaybackEvents(source, { notes: [note("a", 0, 0.03, 62)], duration: 1 });
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
  }
});

test("an edit-created tie follows the original event order", () => {
  const source = { events: [ev(0, [0x90, 60, 90], "a"), ev(0.03, [0xb0, 64, 127]), ev(0.04, [0x80, 60, 0], "a")] };
  const events = compileMidiPlaybackEvents(source, { notes: [note("a", 0, 0.03, 60)], duration: 1 });
  expect(at(events, 0.03).map(({ data }) => data)).toEqual([
    [0xb0, 64, 127],
    [0x80, 60, 0],
  ]);
});

test("floating-point round-off does not break a tie", () => {
  const source = { events: [ev(0, [0x90, 60, 90], "a"), ev(0.1 + 0.2, [0xb0, 64, 127]), ev(0.3, [0x80, 60, 0], "a")] };
  const events = compileMidiPlaybackEvents(source, { notes: [note("a", 0, 0.3, 62)], duration: 1 });
  expect(at(events, 0.3).map(({ data }) => data)).toEqual([
    [0xb0, 64, 127],
    [0x80, 62, 0],
  ]);
  expect(events[1].beat).toBe(events[2].beat);
});

test("deleted notes stay deleted; new notes follow surviving source events at an edited tie", () => {
  const source = { events: [ev(0, [0x90, 60, 90], "a"), ev(0.02, [0xb0, 64, 127]), ev(0.04, [0x80, 60, 0], "a")] };
  const events = compileMidiPlaybackEvents(source, { notes: [note("new", 0.02, 0.04, 65, 80 / 127, 2)], duration: 1 });
  expect(at(events, 0.02).map(({ data }) => data)).toEqual([
    [0xb0, 64, 127],
    [0x92, 65, 80],
  ]);
  expect(events.some((event) => event.data[1] === 60)).toBe(false);
  expect(events.at(-1)?.data).toEqual(new Uint8Array([0x82, 65, 0]));
});

test("velocity 0..1 becomes a 1-127 data byte", () => {
  const events = compileMidiPlaybackEvents({ events: [] }, { notes: [note("a", 0, 1, 60, 1), note("b", 1, 1, 61, 0.001)], duration: 4 });
  expect(events.filter((event) => event.data[0] === 0x90).map((event) => event.data[2])).toEqual([127, 1]);
});

test("untagged recorded note-ons fail instead of silently losing their order", () => {
  expect(() => compileMidiPlaybackEvents({ events: [ev(0, [0x90, 60, 80])] }, { notes: [], duration: 1 })).toThrow(
    "MIDI playback needs note IDs on recorded note-ons.",
  );
});

test("playback rejects invalid notes and duplicate IDs with its public error", () => {
  const valid = note("a", 0, 0.5, 60);
  const source = { events: [] };
  expect(() => compileMidiPlaybackEvents(source, { duration: 1, notes: [{ ...valid, pitch: 128 }] })).toThrow(
    "MIDI playback needs finite, non-negative times and valid MIDI notes.",
  );
  expect(() => compileMidiPlaybackEvents(source, { duration: 1, notes: [valid, { ...valid }] })).toThrow(
    "MIDI playback needs finite, non-negative times and valid MIDI notes.",
  );
});

test("abutting notes that differ by float round-off still release before the next on", () => {
  const triplets = Array.from({ length: 12 }, (_, i) => note(`t${i}`, i / 3, 1 / 3, 36));
  const tenths = Array.from({ length: 30 }, (_, i) => note(`p${i}`, i * 0.1, 0.1, 36));
  for (const notes of [triplets, tenths]) {
    const events = compileMidiPlaybackEvents({ events: [] }, { notes, duration: 10 });
    expect(events.map((event) => event.data[0] & 0xf0)).toEqual(notes.flatMap(() => [0x90, 0x80]));
  }
});
