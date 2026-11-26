/**
 * Standard MIDI Files written by other programs (see fixtures/midi/SOURCES.md), read two ways: by `importMidiFile`, and independently by `midi-file` (MIT)
 * with the expectations computed here from the raw events. Then the imported project is exported and the re-parsed notes must equal the originals.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseMidi } from "midi-file";
import { describe, expect, test } from "vitest";
import { MidiClip, Project, exportMidiFile, importMidiFile } from "../src/project";

const dir = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "midi");

type RawNote = { start: number; end: number; pitch: number; velocity: number; channel: number };
type RawTrack = { index: number; name: string | undefined; notes: RawNote[]; hasChannelEvents: boolean };
type Raw = {
  ppq: number;
  tracks: RawTrack[];
  tempos: { tick: number; usPerBeat: number }[];
  signatures: { tick: number; numerator: number; denominator: number }[];
};

/** The independent reading: absolute ticks, notes paired first-in first-out per channel and pitch, a noteOn with velocity 0 is a noteOff. */
function read(bytes: Uint8Array): Raw {
  const file = parseMidi(bytes);
  const raw: Raw = { ppq: file.header.ticksPerBeat!, tracks: [], tempos: [], signatures: [] };
  file.tracks.forEach((events, index) => {
    let tick = 0;
    const track: RawTrack = { index, name: undefined, notes: [], hasChannelEvents: false };
    const open = new Map<string, { start: number; velocity: number }[]>();
    for (const event of events as any[]) {
      tick += event.deltaTime;
      const key = `${event.channel}:${event.noteNumber}`;
      if (event.type === "trackName" && track.name === undefined) track.name = event.text;
      else if (event.type === "setTempo") raw.tempos.push({ tick, usPerBeat: event.microsecondsPerBeat });
      else if (event.type === "timeSignature") raw.signatures.push({ tick, numerator: event.numerator, denominator: event.denominator });
      else if (event.type === "noteOn" && event.velocity > 0) {
        track.hasChannelEvents = true;
        open.set(key, [...(open.get(key) ?? []), { start: tick, velocity: event.velocity }]);
      } else if (event.type === "noteOff" || event.type === "noteOn") {
        track.hasChannelEvents = true;
        const started = open.get(key)?.shift();
        if (started)
          track.notes.push({ start: started.start, end: tick, pitch: event.noteNumber, velocity: started.velocity, channel: event.channel });
      } else if (["controller", "pitchBend", "programChange", "channelAftertouch", "noteAftertouch"].includes(event.type))
        track.hasChannelEvents = true;
    }
    raw.tracks.push(track);
  });
  return raw;
}

/**
 * Track-name rule: the text of the first trackName event with trailing NUL characters and whitespace removed (and leading whitespace), so `"Piano\0"` is `Piano`;
 * a missing or empty name is `Track <file track number from 1>`.
 */
const expectedName = (track: RawTrack) => {
  let text = track.name ?? "";
  while (text.length && (text.endsWith("\0") || text.trimEnd() !== text)) text = text.endsWith("\0") ? text.slice(0, -1) : text.trimEnd();
  return text.trimStart() || `Track ${track.index + 1}`;
};

const order = (a: RawNote, b: RawNote) => a.start - b.start || a.pitch - b.pitch || a.channel - b.channel || a.end - b.end;

const files = [
  { file: "La_Espero_-_1_piano_-_2020.mid", tracks: 2 },
  { file: "Improvised_Twelve_Bar_Blues.mid", tracks: 3 },
  { file: "O_Canada.mid", tracks: 4 },
  { file: "Internationale_orch2.mid", tracks: 1 },
  { file: "c-bitwig-export.mid", tracks: 2 },
];

/** The first clip of the track with this id, or, given a name, of the first track with that name (names repeat in real files, so the id is the safe key). */
const clipOf = (project: Project, key: string) => {
  const clip = (project.tracks.find((track) => track.id === key) ?? project.tracks.find((track) => track.name === key))!.clips[0];
  if (!(clip instanceof MidiClip)) throw new Error("expected a MIDI clip");
  return clip;
};

describe.each(files)("$file", ({ file, tracks: expectedTracks }) => {
  const bytes = new Uint8Array(readFileSync(join(dir, file)));
  const raw = read(bytes);
  const content = raw.tracks.filter((track) => track.notes.length || track.hasChannelEvents);

  test("importMidiFile agrees with an independent reading of the file", () => {
    const project = new Project({ bpm: 77 });
    const result = importMidiFile(project, bytes);
    expect(result.tracks).toHaveLength(expectedTracks);
    expect(content).toHaveLength(expectedTracks);
    expect(result.tracks.map((track) => track.name)).toEqual(content.map(expectedName));

    // Tempo and meter: the file's map replaces the song's when the file has either.
    const hasMaps = raw.tempos.length + raw.signatures.length > 0;
    expect(result.tempoMapUsed).toBe(hasMaps ? "file" : "song");
    const beat = (tick: number) => tick / raw.ppq;
    const tempoAt = (tick: number) => {
      const last = [...raw.tempos].filter((t) => t.tick <= tick).pop();
      return last ? 60_000_000 / last.usPerBeat : 120;
    };
    const signatureAt = (tick: number) => {
      const last = [...raw.signatures].filter((s) => s.tick <= tick).pop();
      return last ? [last.numerator, last.denominator] : [4, 4];
    };
    const probes = new Set<number>([0]);
    for (const { tick } of [...raw.tempos, ...raw.signatures]) for (const at of [tick - 1, tick, tick + 1]) if (at >= 0) probes.add(at);
    for (const tick of probes) {
      expect(project.tempoMap.bpmAtBeat(beat(tick)), `tempo at tick ${tick}`).toBeCloseTo(tempoAt(tick), 9);
      expect(project.meterMap.signatureAtBeat(beat(tick)), `meter at tick ${tick}`).toEqual(signatureAt(tick));
    }

    // Notes: tick to beat, pitch, velocity 0 to 1, channel (0-based), per track.
    content.forEach((track, index) => {
      const imported = [...clipOf(project, result.tracks[index].id).midi.notes.value]
        .map((note) => ({ start: note.start, end: note.start + note.duration, pitch: note.pitch, velocity: note.velocity, channel: note.channel }))
        .sort(order);
      const expected = track.notes
        .map((note) => ({ start: beat(note.start), end: beat(note.end), pitch: note.pitch, velocity: note.velocity / 127, channel: note.channel }))
        .sort(order);
      expect(imported, `notes of ${expectedName(track)}`).toHaveLength(expected.length);
      imported.forEach((note, i) => {
        expect(note.start).toBeCloseTo(expected[i].start, 9);
        expect(note.end).toBeCloseTo(expected[i].end, 9);
        expect(note.pitch).toBe(expected[i].pitch);
        expect(note.velocity).toBeCloseTo(expected[i].velocity, 9);
        expect(note.channel).toBe(expected[i].channel);
      });
    });

    // Warnings: one sentence for every track that mixes channels, nothing else.
    const warnings = content
      .filter((track) => new Set(track.notes.map((note) => note.channel)).size > 1)
      .map(
        (track) =>
          `Track ${track.index + 1} uses channels ${[...new Set(track.notes.map((note) => note.channel + 1))]
            .sort((a, b) => a - b)
            .join(", ")} together; they stay on one project track, each note keeping its channel.`,
      );
    expect(result.warnings).toEqual(warnings);
    project.dispose();
  });

  test("exporting the imported project at the file's resolution gives back the same notes", () => {
    const project = new Project({ bpm: 77 });
    importMidiFile(project, bytes);
    const again = read(exportMidiFile(project, { ppq: raw.ppq }));
    expect(again.ppq).toBe(raw.ppq);
    // Export writes a conductor track first, then one track per project track in order.
    const written = again.tracks.slice(1);
    expect(written.map(expectedName)).toEqual(content.map(expectedName));
    content.forEach((track, index) => {
      expect([...written[index].notes].sort(order)).toEqual([...track.notes].sort(order));
    });
    project.dispose();
  });
});

describe("what the fixtures cover", () => {
  const read1 = (file: string) => read(new Uint8Array(readFileSync(join(dir, file))));
  test("each feature the importer must handle is in at least one file", () => {
    const all = files.map(({ file }) => read1(file));
    expect(all.some((raw) => raw.tracks.filter((t) => t.notes.length).length >= 3)).toBe(true);
    expect(all.some((raw) => new Set(raw.tempos.map((t) => t.usPerBeat)).size > 1)).toBe(true);
    expect(all.some((raw) => new Set(raw.signatures.map((s) => `${s.numerator}/${s.denominator}`)).size > 1)).toBe(true);
    expect(all.some((raw) => raw.tracks.some((t) => t.notes.some((n) => n.channel === 9)))).toBe(true);
    expect(all.some((raw) => raw.tracks.some((t) => t.name?.endsWith("\0")))).toBe(true);
  });
});

describe("c-bitwig-export.mid (Bitwig Studio 6.1.7)", () => {
  test("holds the content the maintainer made: 100 BPM, 3/4 at beat 24, about 130 BPM at beat 32, Keys with 12 notes and Bass with 10", () => {
    const project = new Project({ bpm: 77 });
    const result = importMidiFile(project, new Uint8Array(readFileSync(join(dir, "c-bitwig-export.mid"))));
    expect(result.tempoMapUsed).toBe("file");
    expect(result.warnings).toEqual([]);
    expect(result.tracks.map((track) => track.name)).toEqual(["Keys", "Bass"]);
    expect(project.bpm).toBeCloseTo(100, 9);
    expect(project.tempoMap.bpmAtBeat(31.99)).toBeCloseTo(100, 9);
    // Bitwig writes 461538 microseconds per beat for 130 BPM.
    expect(project.tempoMap.bpmAtBeat(32)).toBeCloseTo(130, 3);
    expect(project.meterMap.signatureAtBeat(23.99)).toEqual([4, 4]);
    expect(project.meterMap.signatureAtBeat(24)).toEqual([3, 4]);
    expect(clipOf(project, "Keys").midi.notes.value).toHaveLength(12);
    expect(clipOf(project, "Bass").midi.notes.value).toHaveLength(10);
    project.dispose();
  });
});
