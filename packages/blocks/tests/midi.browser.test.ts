import { afterEach, expect, test, vi } from "vitest";
import { parseMidi, tickToSeconds, midiGrid, visibleMidiNotes, MidiSequence } from "../src/midi";
import { end, file, off, on, sig, tempo, track } from "./midi-fixture";
const disposers: Array<() => void> = [];
afterEach(() => {
  for (const fn of disposers.splice(0).reverse()) fn();
  vi.restoreAllMocks();
});
const complex = () =>
  file(
    1,
    96,
    track(sig(0, 4, 4), tempo(0, 500000), tempo(192, 1000000), sig(192, 3, 4), end(384)),
    track(on(0, 60, 50), on(48, 60, 70), off(48, 60), off(48, 60), on(0, 67, 100, 1), off(96, 67, 1), end(528)),
  );

function owner() {
  const m = new MidiSequence();
  m.load(complex());
  disposers.push(() => m.destroy());
  return m;
}
test("format0/1 notes follow source tempo and reference FIFO pairing", () => {
  const zero = parseMidi(file(0, 480, track(on(0, 60), off(480, 60), end(480))));
  expect(zero.notes[0]).toMatchObject({ start: 0, end: 0.5, pitch: 60, velocity: 100 });
  expect(zero.duration).toBe(1);
  const a = parseMidi(complex());
  expect(a.notes.filter((n) => n.pitch === 60).map((n) => [n.start, n.end, n.velocity])).toEqual([
    [0, 0.5, 50],
    [0.25, 0.75, 70],
  ]);
  expect(tickToSeconds(a.tempos, a.ppq, 288)).toBe(2);
  const running = parseMidi(file(0, 96, track([0, 0x90, 60, 90], [0, 64, 80], [96, 60, 0], [96, 64, 0], end())));
  expect(running.notes.map((n) => [n.pitch, n.start, n.end, n.velocity])).toEqual([
    [60, 0, 0.5, 90],
    [64, 0, 1, 80],
  ]);
  const unclosed = parseMidi(file(0, 96, track([0, 0xf0, 3, 1, 2, 0xf7], [0, 0xff, 1, 2, 65, 66], [0, 0xc0, 5], on(0, 60), end(192))));
  expect(unclosed.notes[0].end).toBe(1);
});
test("track/channel isolation and silent tails are retained", () => {
  const p = parseMidi(
    file(1, 96, track(on(0, 60, 80, 0), on(0, 60, 90, 1), off(96, 60, 1), off(96, 60, 0), end(192)), track(on(0, 60), off(48, 60), end())),
  );
  expect(p.notes.map((n) => [n.track, n.channel, n.end]).sort()).toEqual(
    [
      [0, 0, 1],
      [0, 1, 0.5],
      [1, 0, 0.25],
    ].sort(),
  );
  expect(p.duration).toBe(2);
});
test("header and declared track bounds fail promptly", () => {
  for (const bytes of [
    new Uint8Array([1, 2, 3]),
    file(0, 0, track(end())),
    file(0, 96, track(on(0, 60))).slice(0, -1),
    file(0, 96, track([0, 0x90, 60])),
    file(0, 96, track([0, 60, 100])),
    file(0, 96, track([0xff, 0xff, 0xff, 0xff, 0xff])),
    file(0, 96, track(tempo(0, 0), end())),
  ])
    expect(() => parseMidi(bytes)).toThrow();
  expect(() => parseMidi(file(2, 96, track(end())))).toThrow("Only MIDI format");
  expect(() => parseMidi(file(0, 0x8001, track(end())))).toThrow("SMPTE");
});
test("Uint8Array subviews do not read bytes outside the supplied range", () => {
  const bytes = file(0, 96, track(on(0, 60), off(96, 60), end())),
    padded = new Uint8Array(bytes.length + 10);
  padded.set(bytes, 5);
  expect(parseMidi(padded.subarray(5, -5)).duration).toBe(0.5);
});
test("denominator beats and bar boundaries follow tempo/signature changes", () => {
  const p = parseMidi(file(0, 96, track(sig(0, 4, 4), tempo(0, 500000), tempo(384, 1000000), sig(0, 3, 4), end(576))));
  expect(midiGrid(p).downbeats).toEqual([0, 2, 5, 8]);
  expect(midiGrid(p).beats.slice(0, 7)).toEqual([0, 0.5, 1, 1.5, 2, 3, 4]);
  expect(midiGrid(parseMidi(file(0, 96, track(end()))))).toEqual({ beats: [0], downbeats: [0] });
});
test("long notes entering viewport and pitch filtering are not lost", () => {
  const notes = [
    { id: "long", start: 0, end: 10, pitch: 40, velocity: 50, channel: 0, track: 0 },
    { id: "short", start: 1, end: 2, pitch: 60, velocity: 60, channel: 0, track: 0 },
    { id: "late", start: 6, end: 7, pitch: 50, velocity: 50, channel: 0, track: 0 },
  ];
  expect(visibleMidiNotes(notes, { start: 5, end: 6.5 }).map((n) => n.id)).toEqual(["long", "late"]);
  expect(visibleMidiNotes(notes, { start: 5, end: 6.5 }, { low: 45, high: 65 }).map((n) => n.id)).toEqual(["late"]);
});
test("model freezes copies and invalid edits/loads do not change committed state", () => {
  const m = owner(),
    before = m.getState();
  expect(Object.isFrozen(before.notes[0])).toBe(true);
  expect(() => m.load(new Uint8Array([1]))).toThrow();
  expect(m.getState()).toBe(before);
  expect(() => m.updateNote(before.notes[0].id, { pitch: 128 })).toThrow();
  expect(m.getState()).toBe(before);
  expect(() => m.setSelection({ start: 0, end: 1000 })).toThrow();
  const input = before.notes.map((n) => ({ ...n }));
  m.setData({ notes: input, duration: before.duration });
  input[0].pitch = 1;
  expect(m.getState().notes[0].pitch).toBe(60);
});
test("note update preserves selection and publishes one coherent snapshot", () => {
  const m = owner();
  m.setSelection({ start: 0, end: 1 });
  const seen: unknown[] = [];
  m.subscribe(() => seen.push(m.getState()));
  m.updateNote(m.getState().notes[0].id, { pitch: 72 });
  expect(seen).toHaveLength(1);
  expect(m.getSelection()).toEqual({ start: 0, end: 1 });
  expect(m.getState().notes.some((n) => n.pitch === 72)).toBe(true);
});
test("a failing observer cannot prevent a peer from seeing a committed edit", () => {
  const m = owner(),
    peer = vi.fn();
  vi.spyOn(console, "error").mockImplementation(() => {});
  m.subscribe(() => {
    throw Error("consumer failure");
  });
  m.subscribe(peer);
  m.updateNote(m.getState().notes[0].id, { pitch: 73 });
  expect(peer).toHaveBeenCalledTimes(1);
  expect(m.getState().notes.some((n) => n.pitch === 73)).toBe(true);
});
test("grid bounds reject invalid and unbounded requests without hanging", () => {
  const p = parseMidi(file(0, 96, track(end())));
  expect(() => midiGrid({ ...p, ppq: 0 })).toThrow("valid PPQ");
  expect(() => midiGrid({ ...p, endTick: 100001 * 96 })).toThrow("100000 points");
});
