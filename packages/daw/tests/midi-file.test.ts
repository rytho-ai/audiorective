import { describe, expect, test } from "vitest";
import { parseMidi } from "@audiorective/midi";
import { MidiClip, Project, exportMidiFile, importMidiFile } from "../src/project";
import { PPQ, controller, endOfTrack, noteOff, noteOn, smfFile, smfTrack, signatureAt, songFixture, ticks, tempoAt, trackName } from "./helpers/smf";

const midiClip = (project: Project, trackName: string) => {
  const clip = project.tracks.find((track) => track.name === trackName)!.clips[0];
  if (!(clip instanceof MidiClip)) throw new Error("expected a MIDI clip");
  return clip;
};

describe("importMidiFile", () => {
  test("a type 1 file becomes one MIDI track per file track with names, channels, notes in bars, controllers and the file's tempo and meter map", () => {
    const project = new Project({ bpm: 100 });
    const result = importMidiFile(project, songFixture());
    expect(result.tempoMapUsed).toBe("file");
    expect(result.tracks.map((track) => track.name)).toEqual(["Drums", "Bass", "Keys", "Strings"]);
    expect(project.tracks.map((track) => track.kind)).toEqual(["midi", "midi", "midi", "midi"]);
    // Tempo and meter come from the file; the conductor track itself is not a track.
    expect(project.bpm).toBe(96);
    expect(project.tempoMap.changes).toEqual([{ beat: 32, bpm: 120 }]);
    expect(project.signature).toEqual([4, 4]);
    expect(project.meterMap.changes).toEqual([{ beat: 64, numerator: 3, denominator: 4 }]);
    // Bars: bass at bar 9 (where the tempo changes), keys at bar 17 (where 3/4 starts).
    const bass = midiClip(project, "Bass").midi.notes.value[0];
    expect(project.meterMap.beatToBar(bass.start)).toMatchObject({ bar: 9, beatInBar: 0 });
    const keys = midiClip(project, "Keys");
    expect(keys.midi.notes.value[0]).toMatchObject({ pitch: 60, channel: 1, start: 64, duration: 3 });
    expect(project.meterMap.beatToBar(64)).toMatchObject({ bar: 17, beatInBar: 0 });
    expect(project.meterMap.beatToBar(67)).toMatchObject({ bar: 18, beatInBar: 0 });
    // Controllers and pitch bend stay in the clip as events with their raw bytes.
    expect(keys.events.map((event) => [event.time, [...event.data]])).toEqual([
      [0, [0xb1, 64, 127]],
      [2, [0xb1, 1, 50]],
      [67, [0xb1, 64, 0]],
      [67, [0xe1, 0, 96]],
    ]);
    // Drums keep channel 10 (index 9).
    expect(midiClip(project, "Drums").midi.notes.value.map((note) => [note.pitch, note.channel, note.start])).toEqual([
      [36, 9, 0],
      [38, 9, 1],
    ]);
    // The clip spans the content and ends on a bar line.
    expect(keys.duration).toBe(67);
    expect(midiClip(project, "Drums").time).toBe(0);
    project.dispose();
  });

  test("identical time signatures at one tick from two tracks import without throwing; the last one wins", () => {
    const bytes = smfFile(
      1,
      PPQ,
      smfTrack(signatureAt(0, 4, 4), signatureAt(ticks(16), 3, 4), endOfTrack()),
      smfTrack(signatureAt(0, 4, 4), signatureAt(ticks(16), 3, 4), signatureAt(0, 5, 4), noteOn(0, 60), noteOff(ticks(1), 60), endOfTrack()),
    );
    expect(parseMidi(bytes).signatures.map((s) => s.beat)).toEqual([0, 16]);
    const project = new Project({ bpm: 100 });
    expect(() => importMidiFile(project, bytes)).not.toThrow();
    expect(project.meterMap.changes).toEqual([{ beat: 16, numerator: 5, denominator: 4 }]);
    project.dispose();
  });

  test("the whole import is one undo step, including tempo and meter", () => {
    const project = new Project({ bpm: 100 });
    importMidiFile(project, songFixture());
    expect(project.cells.history.value.undo).toBe("Import MIDI file");
    expect(project.undo().status).toBe("applied");
    expect(project.tracks).toHaveLength(0);
    expect(project.bpm).toBe(100);
    expect(project.tempoMap.changes).toEqual([]);
    expect(project.meterMap.changes).toEqual([]);
    expect(project.cells.history.value.undo).toBeUndefined();
    expect(project.redo().status).toBe("applied");
    expect(project.tracks).toHaveLength(4);
    expect(project.bpm).toBe(96);
    project.dispose();
  });

  test('tempo: "song" keeps the song\'s tempo and meter map and says so', () => {
    const project = new Project({ bpm: 100, signature: [6, 8] });
    const result = importMidiFile(project, songFixture(), { tempo: "song" });
    expect(result.tempoMapUsed).toBe("song");
    expect(project.bpm).toBe(100);
    expect(project.signature).toEqual([6, 8]);
    expect(project.tempoMap.changes).toEqual([]);
    expect(result.warnings.join(" ")).toMatch(/not used/);
    expect(midiClip(project, "Keys").midi.notes.value[0].start).toBe(64);
    project.dispose();
  });

  test("a file without tempo or meter events leaves the song's map; tracks without content and unnamed tracks are handled", () => {
    const project = new Project({ bpm: 90 });
    const bytes = smfFile(0, PPQ, smfTrack(noteOn(0, 60, 100, 0), noteOn(0, 64, 100, 3), noteOff(PPQ, 60, 0), noteOff(0, 64, 3), endOfTrack()));
    const result = importMidiFile(project, bytes);
    expect(result.tempoMapUsed).toBe("song");
    expect(project.bpm).toBe(90);
    expect(result.tracks.map((track) => track.name)).toEqual(["Track 1"]);
    expect(result.warnings.some((w) => /channels 1, 4 together/.test(w))).toBe(true);
    expect(importMidiFile(project, smfFile(1, PPQ, smfTrack(tempoAt(0, 80), endOfTrack())), { tempo: "file" }).warnings.join(" ")).toMatch(
      /no track was added/,
    );
    expect(project.bpm).toBe(80);
    expect(() => importMidiFile(project, new Uint8Array([1, 2, 3]))).toThrow("Invalid MIDI file.");
    expect(() => importMidiFile(project, songFixture(), { tempo: "x" as never })).toThrow(/tempo must be/);
    project.dispose();
  });

  test("odd PPQ and a tempo at a non-zero first beat convert exactly", () => {
    const project = new Project({ bpm: 120 });
    const bytes = smfFile(
      1,
      96,
      smfTrack(tempoAt(96 * 4, 60), endOfTrack()),
      smfTrack(trackName("A"), noteOn(32, 60), noteOff(64, 60), endOfTrack()),
    );
    importMidiFile(project, bytes);
    // No tempo at tick 0 means the MIDI default of 120 BPM until beat 4.
    expect(project.bpm).toBe(120);
    expect(project.tempoMap.changes).toEqual([{ beat: 4, bpm: 60 }]);
    const note = midiClip(project, "A").midi.notes.value[0];
    expect(note.start).toBeCloseTo(1 / 3, 12);
    expect(note.duration).toBeCloseTo(2 / 3, 12);
    project.dispose();
  });
});

describe("exportMidiFile", () => {
  test("export then parse gives the same tracks, channels, notes, controllers, tempo changes and meter", () => {
    const project = new Project({ bpm: 100, title: "My Song" });
    importMidiFile(project, songFixture());
    const parsed = parseMidi(exportMidiFile(project));
    expect(parsed.tempos).toEqual([
      { beat: 0, bpm: 96 },
      { beat: 32, bpm: 120 },
    ]);
    expect(parsed.signatures).toEqual([
      { beat: 0, numerator: 4, denominator: 4 },
      { beat: 64, numerator: 3, denominator: 4 },
    ]);
    expect(parsed.tracks.map((track) => track.name)).toEqual(["My Song", "Drums", "Bass", "Keys", "Strings"]);
    const keys = parsed.tracks[3];
    expect(keys.notes.map((n) => [n.pitch, n.channel, n.start, n.duration, Math.round(n.velocity * 127)])).toEqual([[60, 1, 64, 3, 100]]);
    expect(keys.events.map((e) => [e.beat, [...e.data]])).toEqual([
      [0, [0xb1, 64, 127]],
      [2, [0xb1, 1, 50]],
      [67, [0xb1, 64, 0]],
      [67, [0xe1, 0, 96]],
    ]);
    expect(parsed.tracks[1].notes.map((n) => [n.pitch, n.channel])).toEqual([
      [36, 9],
      [38, 9],
    ]);
    // Import of the export is the same song again.
    const again = new Project({ bpm: 120 });
    importMidiFile(again, exportMidiFile(project));
    expect(again.tracks.map((track) => track.name)).toEqual(["Drums", "Bass", "Keys", "Strings"]);
    expect(again.tempoMap.changes).toEqual(project.tempoMap.changes);
    expect(midiClip(again, "Keys").midi.notes.value[0]).toMatchObject({ start: 64, duration: 3, channel: 1 });
    project.dispose();
    again.dispose();
  });

  test("windows, loops and linked clips are exported as they play", () => {
    const project = new Project({ bpm: 120 });
    const track = project.addTrack("Lead", "midi");
    project.addTrack("Audio", "audio");
    const notes = [
      { pitch: 60, velocity: 1, start: 0, duration: 1 },
      { pitch: 62, velocity: 1, start: 1, duration: 1 },
      { pitch: 64, velocity: 1, start: 2, duration: 2 },
    ];
    // A window: content beats [1, 3) play at beat 8; the last note is cut at the window edge.
    const windowed = project.addMidiClip(track.id, { notes, duration: 2, sourceOffset: 1 }, 8);
    // A loop: the first two content beats repeat over 6 beats.
    const looped = project.addMidiClip(track.id, { notes, duration: 6 }, 16);
    project.setClipLoop(looped.id, { startBeat: 0, endBeat: 2 });
    // A linked copy shares the notes and plays them again later.
    const copy = project.duplicateClip(windowed.id, 32, { linked: true });
    const parsed = parseMidi(exportMidiFile(project, { ppq: 480 }));
    expect(parsed.tracks).toHaveLength(2);
    const played = parsed.tracks[1].notes.map((n) => [n.pitch, n.start, n.duration]);
    expect(played).toEqual([
      [62, 8, 1],
      [64, 9, 1],
      [60, 16, 1],
      [62, 17, 1],
      [60, 18, 1],
      [62, 19, 1],
      [60, 20, 1],
      [62, 21, 1],
      [62, 32, 1],
      [64, 33, 1],
    ]);
    expect(parsed.tracks[1].end).toBe(copy.time + copy.duration);
    // The same events the Workspace would schedule: nothing is invented or dropped.
    const current = project.tracks.find((t) => t.id === track.id)!.clips;
    expect(current.map((clip) => clip.id)).toContain(looped.id);
    const scheduled = current.flatMap((clip) =>
      (clip as MidiClip)
        .playbackEvents()
        .filter((event) => (event.data[0] & 0xf0) === 0x90)
        .map((event) => clip.time + event.beat),
    );
    expect(parsed.tracks[1].notes.map((n) => n.start)).toEqual([...scheduled].sort((a, b) => a - b));
    project.dispose();
  });

  test("a note-off and the next note-on at one tick keep two notes, and a project without MIDI tracks exports a conductor only", () => {
    const empty = new Project({ bpm: 120 });
    expect(parseMidi(exportMidiFile(empty)).tracks).toHaveLength(1);
    const project = new Project({ bpm: 120 });
    const track = project.addTrack("T", "midi");
    project.addMidiClip(
      track.id,
      {
        notes: [
          { pitch: 60, velocity: 1, start: 0, duration: 1 },
          { pitch: 60, velocity: 1, start: 1, duration: 1 },
        ],
        duration: 2,
      },
      0,
    );
    const notes = parseMidi(exportMidiFile(project, { runningStatus: true })).tracks[1].notes;
    expect(notes.map((n) => [n.start, n.duration])).toEqual([
      [0, 1],
      [1, 1],
    ]);
    project.dispose();
    empty.dispose();
    void controller;
  });
});
