import { afterEach, expect, test, vi } from "vitest";
import { parseMidi, midiGrid, visibleMidiNotes, MidiClip } from "../src";
import { end, file, off, on, sig, tempo, track } from "./midi-fixture";
afterEach(() => vi.restoreAllMocks());
const complex = () =>
  file(
    1,
    96,
    track(sig(0, 4, 4), tempo(0, 500000), tempo(192, 1000000), sig(192, 3, 4), end(384)),
    track(on(0, 60, 50), on(48, 60, 70), off(48, 60), off(48, 60), on(0, 67, 100, 1), off(96, 67, 1), end(528)),
  );

test("format0/1 notes are in beats with 0..1 velocity, independent of the file's tempo, and reference FIFO pairing", () => {
  const zero = parseMidi(file(0, 480, track(on(0, 60, 127), off(480, 60), end(480))));
  expect(zero.notes[0]).toMatchObject({ start: 0, duration: 1, pitch: 60, velocity: 1, channel: 0 });
  expect(zero.duration).toBe(2);
  const a = parseMidi(complex());
  expect(a.notes.filter((n) => n.pitch === 60).map((n) => [n.start, n.duration, n.velocity])).toEqual([
    [0, 1, 50 / 127],
    [0.5, 1, 70 / 127],
  ]);
  expect(a.ppq).toBe(96);
  expect(a.tempos).toEqual([
    { beat: 0, bpm: 120 },
    { beat: 2, bpm: 60 },
  ]);
  expect(a.signatures).toEqual([
    { beat: 0, numerator: 4, denominator: 4 },
    { beat: 4, numerator: 3, denominator: 4 },
  ]);
  const running = parseMidi(file(0, 96, track([0, 0x90, 60, 90], [0, 64, 80], [96, 60, 0], [96, 64, 0], end())));
  expect(running.notes.map((n) => [n.pitch, n.start, n.duration, Math.round(n.velocity * 127)])).toEqual([
    [60, 0, 1, 90],
    [64, 0, 2, 80],
  ]);
  const unclosed = parseMidi(file(0, 96, track([0, 0xf0, 3, 1, 2, 0xf7], [0, 0xff, 1, 2, 65, 66], [0, 0xc0, 5], on(0, 60), end(192))));
  expect(unclosed.notes[0].duration).toBe(2);
});
test("track/channel isolation and silent tails are retained", () => {
  const p = parseMidi(
    file(1, 96, track(on(0, 60, 80, 0), on(0, 60, 90, 1), off(96, 60, 1), off(96, 60, 0), end(192)), track(on(0, 60), off(48, 60), end())),
  );
  expect(p.notes.map((n) => [n.channel, n.duration]).sort()).toEqual(
    [
      [0, 2],
      [0, 0.5],
      [1, 1],
    ].sort(),
  );
  expect(p.duration).toBe(4);
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
  expect(parseMidi(padded.subarray(5, -5)).duration).toBe(1);
});
test("denominator beats and bar boundaries follow signature changes in beats", () => {
  const p = parseMidi(file(0, 96, track(sig(0, 4, 4), tempo(0, 500000), tempo(384, 1000000), sig(0, 3, 4), end(576))));
  expect(midiGrid(p).downbeats).toEqual([0, 4, 7, 10]);
  expect(midiGrid(p).beats).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  expect(midiGrid(parseMidi(file(0, 96, track(end()))))).toEqual({ beats: [0], downbeats: [0] });
  const eighths = parseMidi(file(0, 96, track(sig(0, 6, 8), end(288))));
  expect(midiGrid(eighths).beats).toEqual([0, 0.5, 1, 1.5, 2, 2.5, 3]);
  expect(midiGrid(eighths).downbeats).toEqual([0, 3]);
});
test("long notes entering viewport and pitch filtering are not lost", () => {
  const notes = [
    { id: "long", start: 0, duration: 10, pitch: 40, velocity: 0.4, channel: 0 },
    { id: "short", start: 1, duration: 1, pitch: 60, velocity: 0.5, channel: 0 },
    { id: "late", start: 6, duration: 1, pitch: 50, velocity: 0.4, channel: 0 },
  ];
  expect(visibleMidiNotes(notes, { start: 5, end: 6.5 }).map((n) => n.id)).toEqual(["long", "late"]);
  expect(visibleMidiNotes(notes, { start: 5, end: 6.5 }, { low: 45, high: 65 }).map((n) => n.id)).toEqual(["late"]);
});
test("a clip freezes copies, fills ids and channels, and rejects invalid notes without changing committed state", () => {
  const clip = new MidiClip(parseMidi(complex()).notes);
  const before = clip.notes.value;
  expect(Object.isFrozen(before[0])).toBe(true);
  expect(() => clip.setNotes([{ pitch: 128, velocity: 0.5, start: 0, duration: 1 }])).toThrow("MidiClip note pitch must be an integer 0-127.");
  expect(() => clip.setNotes([{ pitch: 60, velocity: 90, start: 0, duration: 1 }])).toThrow("MidiClip note velocity must be 0..1.");
  expect(() => clip.setNotes([{ pitch: 60, velocity: 0.5, start: -1, duration: 1 }])).toThrow("MidiClip note start must be finite beats >= 0.");
  expect(() => clip.setNotes([{ pitch: 60, velocity: 0.5, start: 0, duration: 1, channel: 16 }])).toThrow(
    "MidiClip note channel must be an integer 0-15.",
  );
  expect(() =>
    clip.setNotes([
      { id: "x", pitch: 60, velocity: 0.5, start: 0, duration: 1 },
      { id: "x", pitch: 61, velocity: 0.5, start: 0, duration: 1 },
    ]),
  ).toThrow("MidiClip notes need unique ids.");
  expect(clip.notes.value).toBe(before);
  expect(clip.revision.value).toBe(0);
  const input = [{ pitch: 60, velocity: 0.5, start: 0, duration: 1 }];
  clip.setNotes(input);
  input[0].pitch = 1;
  expect(clip.notes.value[0]).toMatchObject({ pitch: 60, channel: 0 });
  expect(clip.notes.value[0].id).toMatch(/^note-/);
  clip.dispose();
});
test("grid bounds reject invalid and unbounded requests without hanging", () => {
  const p = parseMidi(file(0, 96, track(end())));
  expect(() => midiGrid({ ...p, duration: Number.NaN })).toThrow("valid duration");
  expect(() => midiGrid({ ...p, duration: 100001 })).toThrow("100000 points");
});
