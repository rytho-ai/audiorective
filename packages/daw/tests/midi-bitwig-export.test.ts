/**
 * `fixtures/midi/d-bitwig-rich-export.mid`: a Standard MIDI File that Bitwig Studio 6.1.7 exported (File > Export MIDI) from a project built with this SDK
 * (`blueprints/probes/bitwig-roundtrip-001/build-rich.mjs`). `d-bitwig-rich-expected.json` is what we wrote into that project.
 * What Bitwig does to it is Bitwig's behaviour, asserted here exactly so a change in our reading is not mistaken for it:
 * - velocity 1..63 comes back one higher, 64..127 unchanged;
 * - tempos are whole microseconds per beat, so 84 BPM becomes 84.000084 and 132 BPM 132.00013;
 * - the tempo and meter map sit in the first track, a tempo event is repeated at each change tick, and there is no conductor track;
 * - of the 19 controller and pitch-bend events in Keys, no movement survives: only three events at tick 0 are written.
 * The file is read twice, by `importMidiFile` and independently by `midi-file` (MIT).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseMidi } from "midi-file";
import { describe, expect, test } from "vitest";
import { MidiClip, Project, exportMidiFile, importMidiFile } from "../src/project";

const dir = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "midi");
const bytes = new Uint8Array(readFileSync(join(dir, "d-bitwig-rich-export.mid")));

type Expected = {
  tempos: { beat: number; bpm: number }[];
  meters: { beat: number; numerator: number; denominator: number }[];
  tracks: string[];
  notes: { track: string; beat: number; pitch: number; velocity: number; duration: number; channel: number }[];
  controllers: { track: string; beat: number; channel: number; kind: "cc" | "pitchBend"; controller?: number; value: number }[];
};
const expected: Expected = JSON.parse(readFileSync(join(dir, "d-bitwig-rich-expected.json"), "utf8"));
const PPQ = 960;
const TICK = 1 / PPQ;

/** Bitwig's velocity rule, measured over all 127 values (the Sweep track): 1..63 gain one, 64..127 are unchanged. */
const bitwigVelocity = (velocity: number) => (velocity < 64 ? velocity + 1 : velocity);

type RawNote = { track: string; tick: number; pitch: number; velocity: number; duration: number; channel: number };
/** The independent reading: absolute ticks, notes paired first-in first-out per track, channel and pitch. */
function readRaw(file: Uint8Array) {
  const parsed = parseMidi(file);
  const notes: RawNote[] = [];
  const tempos: { tick: number; track: number; usPerBeat: number }[] = [];
  const signatures: { tick: number; track: number; numerator: number; denominator: number }[] = [];
  const controls: { track: string; tick: number; channel: number; kind: string; controller?: number; value: number }[] = [];
  const names: string[] = [];
  parsed.tracks.forEach((events, index) => {
    let tick = 0;
    const name = (events.find((event) => event.type === "trackName") as { text: string } | undefined)?.text ?? `Track ${index + 1}`;
    names.push(name);
    const open = new Map<string, { tick: number; velocity: number }[]>();
    for (const event of events as any[]) {
      tick += event.deltaTime;
      const key = `${event.channel}:${event.noteNumber}`;
      if (event.type === "setTempo") tempos.push({ tick, track: index, usPerBeat: event.microsecondsPerBeat });
      else if (event.type === "timeSignature") signatures.push({ tick, track: index, numerator: event.numerator, denominator: event.denominator });
      else if (event.type === "noteOn" && event.velocity > 0) open.set(key, [...(open.get(key) ?? []), { tick, velocity: event.velocity }]);
      else if (event.type === "noteOff" || event.type === "noteOn") {
        const started = open.get(key)!.shift()!;
        notes.push({
          track: name,
          tick: started.tick,
          pitch: event.noteNumber,
          velocity: started.velocity,
          duration: tick - started.tick,
          channel: event.channel,
        });
      } else if (event.type === "controller")
        controls.push({ track: name, tick, channel: event.channel, kind: "cc", controller: event.controllerType, value: event.value });
      else if (event.type === "pitchBend") controls.push({ track: name, tick, channel: event.channel, kind: "pitchBend", value: event.value + 8192 });
    }
  });
  return { header: parsed.header, names, notes, tempos, signatures, controls };
}
const raw = readRaw(bytes);
const noteKey = (track: string, pitch: number, tick: number) => `${track}|${pitch}|${tick}`;

describe("d-bitwig-rich-export.mid as Bitwig wrote it", () => {
  test("format 1, 960 ticks per beat, one track per project track and no conductor track", () => {
    expect(bytes.length).toBe(3195);
    expect(raw.header).toMatchObject({ format: 1, numTracks: 6, ticksPerBeat: PPQ });
    expect(raw.names).toEqual(expected.tracks);
  });

  test("the tempo and meter map is in the first track, with each tempo change written after a repeat of the previous tempo", () => {
    expect(new Set(raw.tempos.map((t) => t.track))).toEqual(new Set([0]));
    expect(new Set(raw.signatures.map((s) => s.track))).toEqual(new Set([0]));
    expect(raw.tempos.map((t) => [t.tick, t.usPerBeat])).toEqual([
      [0, 625000],
      [16 * PPQ, 625000],
      [16 * PPQ, 500000],
      [30 * PPQ, 500000],
      [30 * PPQ, 714285],
      [42 * PPQ, 714285],
      [42 * PPQ, 454545],
    ]);
    expect(raw.signatures.map((s) => [s.tick, s.numerator, s.denominator])).toEqual([
      [0, 4, 4],
      [24 * PPQ, 3, 4],
      [36 * PPQ, 6, 8],
      [42 * PPQ, 4, 4],
    ]);
  });

  test("all 352 notes are there at their ticks, with their pitch, duration and channel, drums on channel 10 included", () => {
    expect(raw.notes).toHaveLength(expected.notes.length);
    const byKey = new Map(raw.notes.map((note) => [noteKey(note.track, note.pitch, note.tick), note]));
    expect(byKey.size).toBe(raw.notes.length);
    for (const note of expected.notes) {
      const found = byKey.get(noteKey(note.track, note.pitch, Math.round(note.beat * PPQ)));
      expect(found, JSON.stringify(note)).toBeDefined();
      expect(found!.duration, JSON.stringify(note)).toBe(Math.round(note.duration * PPQ));
      expect(found!.channel).toBe(note.channel);
    }
    expect(new Set(raw.notes.filter((n) => n.track === "Drums").map((n) => n.channel))).toEqual(new Set([9]));
    expect(new Set(raw.notes.filter((n) => n.track === "Sweep").map((n) => n.channel))).toEqual(new Set([2]));
  });

  test("velocity: 1..63 are written one higher, 64..127 unchanged, for every value", () => {
    const byKey = new Map(raw.notes.map((note) => [noteKey(note.track, note.pitch, note.tick), note]));
    const sweep = expected.notes.filter((note) => note.track === "Sweep");
    expect(sweep.map((note) => note.velocity)).toEqual(Array.from({ length: 127 }, (_, i) => i + 1));
    for (const note of expected.notes)
      expect(byKey.get(noteKey(note.track, note.pitch, Math.round(note.beat * PPQ)))!.velocity, JSON.stringify(note)).toBe(
        bitwigVelocity(note.velocity),
      );
    expect(expected.notes.filter((note) => bitwigVelocity(note.velocity) !== note.velocity).length).toBe(63 + 6);
  });

  test("controllers and pitch bend: Bitwig kept none of the 19 events we wrote, only three at tick 0", () => {
    expect(expected.controllers).toHaveLength(19);
    expect(raw.controls).toEqual([
      { track: "Keys", tick: 0, channel: 0, kind: "cc", controller: 64, value: 0 },
      { track: "Keys", tick: 0, channel: 0, kind: "cc", controller: 1, value: 0 },
      { track: "Keys", tick: 0, channel: 0, kind: "pitchBend", value: 8191 },
    ]);
  });
});

describe("importMidiFile on the Bitwig export", () => {
  const project = new Project({ bpm: 77 });
  const result = importMidiFile(project, bytes);
  const clip = (name: string) => {
    const found = project.tracks.find((track) => track.name === name)!.clips[0];
    if (!(found instanceof MidiClip)) throw new Error("expected a MIDI clip");
    return found;
  };

  test("takes the file's tempo and meter map, names the six tracks, and warns about nothing", () => {
    expect(result.tempoMapUsed).toBe("file");
    expect(result.warnings).toEqual([]);
    expect(result.tracks.map((track) => track.name)).toEqual(expected.tracks);
    expect(project.tracks.map((track) => track.kind)).toEqual(expected.tracks.map(() => "midi"));
  });

  test("every expected note is at its beat (one tick), pitch, duration (one tick), channel and Bitwig's velocity", () => {
    const imported = new Map<string, { start: number; duration: number; velocity: number; channel: number | undefined }>();
    for (const name of expected.tracks)
      for (const note of clip(name).midi.notes.value) imported.set(noteKey(name, note.pitch, Math.round(note.start * PPQ)), note);
    expect(imported.size).toBe(expected.notes.length);
    for (const note of expected.notes) {
      const found = imported.get(noteKey(note.track, note.pitch, Math.round(note.beat * PPQ)))!;
      expect(found, JSON.stringify(note)).toBeDefined();
      expect(Math.abs(found.start - note.beat)).toBeLessThanOrEqual(TICK);
      expect(Math.abs(found.duration - note.duration)).toBeLessThanOrEqual(TICK);
      expect(found.channel).toBe(note.channel);
      expect(found.velocity).toBeCloseTo(bitwigVelocity(note.velocity) / 127, 9);
    }
  });

  test("tempo map: 96, 120, 84 and 132 BPM from beats 0, 16, 30 and 42, to the precision of whole microseconds per beat", () => {
    const at = (beat: number) => project.tempoMap.bpmAtBeat(beat);
    for (const { beat, bpm } of expected.tempos) {
      // Bitwig writes 60e6 / bpm truncated to a whole number: at most 0.00013 BPM away at these tempos.
      expect(Math.abs(at(beat) - bpm), `bpm at beat ${beat}`).toBeLessThan(0.0002);
      expect(at(beat + 5)).toBeCloseTo(at(beat), 9);
    }
    expect(at(15.999)).toBeCloseTo(96, 9);
    expect(at(29.999)).toBeCloseTo(120, 9);
    expect(at(41.999)).toBeCloseTo(60_000_000 / 714285, 9);
    expect(at(42)).toBeCloseTo(60_000_000 / 454545, 9);
    expect(at(30)).toBeCloseTo(84.000084, 5);
    expect(at(42)).toBeCloseTo(132.000132, 5);
    expect(project.bpm).toBe(96);
  });

  test("meter map: 4/4, 3/4 from bar 7 (beat 24), 6/8 from bar 11 (beat 36), 4/4 from bar 13 (beat 42)", () => {
    const meter = project.meterMap;
    for (const [beat, signature] of [
      [0, [4, 4]],
      [23.999, [4, 4]],
      [24, [3, 4]],
      [35.999, [3, 4]],
      [36, [6, 8]],
      [41.999, [6, 8]],
      [42, [4, 4]],
    ] as const)
      expect(meter.signatureAtBeat(beat), `meter at beat ${beat}`).toEqual(signature);
    expect([7, 11, 13].map((bar) => meter.barToBeat(bar))).toEqual([24, 36, 42]);
  });

  test("the Keys clip holds what Bitwig kept of the controllers: three events at beat 0", () => {
    const events = clip("Keys")
      .playbackEvents()
      .filter((event) => (event.data[0] & 0xf0) !== 0x90 && (event.data[0] & 0xf0) !== 0x80)
      .map((event) => [event.beat, ...event.data]);
    expect(events).toEqual([
      [0, 0xb0, 64, 0],
      [0, 0xb0, 1, 0],
      [0, 0xe0, 127, 63],
    ]);
  });
});

describe("exportMidiFile after importing the Bitwig export", () => {
  const project = new Project({ bpm: 77 });
  importMidiFile(project, bytes);
  const written = readRaw(exportMidiFile(project, { ppq: PPQ }));

  test("writes every note back at the same tick, pitch, velocity, duration and channel, and the same tempo and meter map", () => {
    expect(written.header).toMatchObject({ format: 1, ticksPerBeat: PPQ });
    // Our export writes a conductor track first, then the six tracks.
    expect(written.names.slice(1)).toEqual(expected.tracks);
    const sort = (notes: RawNote[]) =>
      [...notes].sort((a, b) => a.track.localeCompare(b.track) || a.tick - b.tick || a.pitch - b.pitch || a.duration - b.duration);
    expect(sort(written.notes)).toEqual(sort(raw.notes));
    // Repeated tempo events at one tick collapse to the one that holds; the map as a function of the tick is the same.
    const lastPerTick = (events: { tick: number; usPerBeat: number }[]) => [...new Map(events.map((e) => [e.tick, e.usPerBeat])).entries()];
    const changes = (events: { tick: number; usPerBeat: number }[]) =>
      lastPerTick(events).filter(([, us], i, all) => i === 0 || us !== all[i - 1][1]);
    expect(changes(written.tempos)).toEqual(changes(raw.tempos));
    expect(written.signatures.map((s) => [s.tick, s.numerator, s.denominator])).toEqual(
      raw.signatures.map((s) => [s.tick, s.numerator, s.denominator]),
    );
  });

  test("a project built from the expected content exports the notes exactly as written, velocity included", () => {
    const built = new Project({ bpm: 96 });
    built.setTempoChanges(expected.tempos);
    built.setTimeSignatureChanges(expected.meters);
    for (const name of expected.tracks) {
      const track = built.addTrack(name, "midi");
      built.addMidiClip(
        track.id,
        {
          duration: expected.notes.filter((n) => n.track === name).reduce((end, n) => Math.max(end, Math.ceil(n.beat + n.duration)), 1),
          notes: expected.notes
            .filter((n) => n.track === name)
            .map((n) => ({ pitch: n.pitch, velocity: n.velocity / 127, start: n.beat, duration: n.duration, channel: n.channel })),
        },
        0,
      );
    }
    const out = readRaw(exportMidiFile(built, { ppq: PPQ }));
    const sort = (notes: { track: string; tick: number; pitch: number }[]) =>
      [...notes].sort((a, b) => a.track.localeCompare(b.track) || a.tick - b.tick || a.pitch - b.pitch);
    expect(sort(out.notes).map((n) => [n.track, n.tick, n.pitch, n.velocity, n.duration, n.channel])).toEqual(
      sort(
        expected.notes.map((n) => ({
          track: n.track,
          tick: Math.round(n.beat * PPQ),
          pitch: n.pitch,
          velocity: n.velocity,
          duration: Math.round(n.duration * PPQ),
          channel: n.channel,
        })),
      ).map((n: any) => [n.track, n.tick, n.pitch, n.velocity, n.duration, n.channel]),
    );
    expect(out.tempos.filter((t, i, all) => i === 0 || t.usPerBeat !== all[i - 1].usPerBeat).map((t) => [t.tick, t.usPerBeat])).toEqual([
      [0, 625000],
      [16 * PPQ, 500000],
      [30 * PPQ, 714286],
      [42 * PPQ, 454545],
    ]);
    expect(out.signatures.map((s) => [s.tick, s.numerator, s.denominator])).toEqual(
      expected.meters.map((m) => [m.beat * PPQ, m.numerator, m.denominator]),
    );
  });
});
