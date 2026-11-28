import { expect, test } from "vitest";
import { parseMidi, writeMidi } from "../src";
import { end, file, off, on, sig, tempo, track, vlq } from "./midi-fixture";

const name = (text: string) => [0, 0xff, 0x03, text.length, ...Array.from(text, (c) => c.charCodeAt(0))];
const cc = (delta: number, controller: number, value: number, ch = 0) => [...vlq(delta), 0xb0 | ch, controller, value];
const bend = (delta: number, lsb: number, msb: number, ch = 0) => [...vlq(delta), 0xe0 | ch, lsb, msb];
const program = (delta: number, p: number, ch = 0) => [...vlq(delta), 0xc0 | ch, p];

test("parseMidi keeps each track's name, notes, channels and non-note messages", () => {
  const parsed = parseMidi(
    file(
      1,
      480,
      track(sig(0, 4, 4), tempo(0, 500000), tempo(480 * 32, 625000), end(480 * 64)),
      track(name("Keys"), program(0, 5, 2), cc(0, 64, 127, 2), on(0, 60, 100, 2), off(480, 60, 2), cc(0, 64, 0, 2), bend(0, 0, 96, 2), end(960)),
      track(name("Drums"), on(0, 36, 90, 9), off(120, 36, 9), end(480)),
    ),
  );
  expect(parsed.tracks.map((t) => [t.index, t.name, t.notes.length, t.events.length])).toEqual([
    [0, undefined, 0, 0],
    [1, "Keys", 1, 4],
    [2, "Drums", 1, 0],
  ]);
  expect(parsed.tracks[1].notes[0]).toMatchObject({ pitch: 60, channel: 2, start: 0, duration: 1 });
  expect([...parsed.tracks[1].events[1].data]).toEqual([0xb2, 64, 127]);
  expect(parsed.tracks[1].events[3]).toMatchObject({ beat: 1 });
  expect([...parsed.tracks[1].events[3].data]).toEqual([0xe2, 0, 96]);
  expect(parsed.tracks[2].notes[0]).toMatchObject({ channel: 9, duration: 0.25 });
  expect(parsed.tracks[0].end).toBe(96);
  expect(parsed.notes).toHaveLength(2);
});

test("writeMidi round-trips notes, channels, controllers, tempo and meter through parseMidi", () => {
  const bytes = writeMidi({
    ppq: 480,
    title: "Song",
    tempos: [
      { beat: 0, bpm: 96 },
      { beat: 32, bpm: 120 },
    ],
    signatures: [
      { beat: 0, numerator: 4, denominator: 4 },
      { beat: 64, numerator: 3, denominator: 4 },
      { beat: 70, numerator: 7, denominator: 8 },
    ],
    tracks: [
      {
        name: "Keys",
        notes: [
          { pitch: 60, velocity: 0.5, start: 0, duration: 1.5, channel: 3 },
          { pitch: 64, velocity: 1, start: 1.5, duration: 0.25 },
        ],
        events: [
          { beat: 0, data: new Uint8Array([0xb3, 64, 127]) },
          { beat: 2, data: new Uint8Array([0xb3, 64, 0]) },
          { beat: 1, data: new Uint8Array([0xe3, 0x10, 0x50]) },
          { beat: 0, data: new Uint8Array([0xc3, 7]) },
        ],
        end: 8,
      },
      { name: "Empty" },
    ],
  });
  const parsed = parseMidi(bytes);
  expect(parsed.ppq).toBe(480);
  expect(parsed.tempos).toEqual([
    { beat: 0, bpm: 96 },
    { beat: 32, bpm: 120 },
  ]);
  expect(parsed.signatures).toEqual([
    { beat: 0, numerator: 4, denominator: 4 },
    { beat: 64, numerator: 3, denominator: 4 },
    { beat: 70, numerator: 7, denominator: 8 },
  ]);
  expect(parsed.tracks.map((t) => t.name)).toEqual([undefined, "Keys", "Empty"].map((n, i) => (i === 0 ? "Song" : n)));
  const keys = parsed.tracks[1];
  expect(keys.notes.map((n) => [n.pitch, n.start, n.duration, n.channel, Math.round(n.velocity * 127)])).toEqual([
    [60, 0, 1.5, 3, 64],
    [64, 1.5, 0.25, 0, 127],
  ]);
  expect(keys.events.map((e) => [e.beat, [...e.data]])).toEqual([
    [0, [0xb3, 64, 127]],
    [0, [0xc3, 7]],
    [1, [0xe3, 0x10, 0x50]],
    [2, [0xb3, 64, 0]],
  ]);
  expect(keys.end).toBe(8);
});

test("writeMidi supports running status, adjacent notes and odd PPQ values", () => {
  const input = {
    ppq: 96,
    tracks: [
      {
        notes: [
          { pitch: 60, velocity: 0.8, start: 0, duration: 1 },
          { pitch: 60, velocity: 0.8, start: 1, duration: 1 },
          { pitch: 62, velocity: 0.8, start: 1 / 3, duration: 0 },
        ],
      },
    ],
  };
  const plain = writeMidi(input);
  const running = writeMidi({ ...input, runningStatus: true });
  expect(running.length).toBeLessThan(plain.length);
  for (const bytes of [plain, running]) {
    const [a, b, c] = parseMidi(bytes).tracks[1].notes;
    expect([a.start, a.duration]).toEqual([0, 1]);
    expect([c.start, c.duration]).toEqual([1, 1]);
    expect(b.pitch).toBe(62);
    expect(b.start).toBeCloseTo(1 / 3, 9);
    expect(b.duration).toBeCloseTo(1 / 96, 9);
  }
  expect(parseMidi(writeMidi({ ppq: 1, tracks: [{ notes: [{ pitch: 1, velocity: 1, start: 2, duration: 3 }] }] })).tracks[1].notes[0]).toMatchObject({
    start: 2,
    duration: 3,
  });
  expect(parseMidi(writeMidi({ ppq: 32767, tracks: [] })).ppq).toBe(32767);
});

test("parseMidi reads running status across controllers and meta text in Latin-1", () => {
  const latin = [0, 0xff, 0x03, 4, 0x43, 0x61, 0x66, 0xe9];
  const parsed = parseMidi(file(1, 96, track(latin, [0, 0xb0, 1, 10], [10, 1, 20], [10, 1, 30], end())));
  expect(parsed.tracks[0].name).toBe("Café");
  expect(parsed.tracks[0].events.map((e) => [Math.round(e.beat * 96), e.data[2]])).toEqual([
    [0, 10],
    [10, 20],
    [20, 30],
  ]);
});

test("writeMidi rejects values a file cannot hold", () => {
  expect(() => writeMidi({ ppq: 0, tracks: [] })).toThrow(/^writeMidi ppq/);
  expect(() => writeMidi({ tracks: [], signatures: [{ beat: 0, numerator: 4, denominator: 5 }] })).toThrow(/power-of-two denominator/);
  expect(() => writeMidi({ tracks: [], tempos: [{ beat: 0, bpm: 0 }] })).toThrow(/positive BPM/);
  expect(() => writeMidi({ tracks: [{ notes: [{ pitch: 128, velocity: 1, start: 0, duration: 1 }] }] })).toThrow(/pitch/);
  expect(() => writeMidi({ tracks: [{ events: [{ beat: 0, data: new Uint8Array([0xf0, 1]) }] }] })).toThrow(/channel message/);
});
