/** MIDI value types, shared note validation and indexed interval queries. Times are beats (quarter notes), velocity is 0..1. */

/** One MIDI note. Times are in beats (quarter notes), so notes follow the transport's tempo. */
export type MidiNote = Readonly<{
  /** Stable identity; generated when a note is added without one. */
  id: string;
  /** MIDI note number 0-127 (60 is middle C). */
  pitch: number;
  /** 0..1 (MIDI velocity / 127). */
  velocity: number;
  /** Beats from the clip's start; 0 is its first beat (beat 2 of bar 1 is 1). */
  start: number;
  /** Length in beats (0.25 is a 16th note in 4/4). */
  duration: number;
  /** MIDI channel 0-15. Default 0. */
  channel: number;
}>;
/** A note to add: `id` and `channel` may be omitted. */
export type NoteInit = Omit<MidiNote, "id" | "channel"> & Partial<Pick<MidiNote, "id" | "channel">>;
/** A note inside `clip.edit`: every field but `id` is writable. */
export type DraftNote = { -readonly [K in keyof Omit<MidiNote, "id">]: MidiNote[K] } & { readonly id: string };
/** The draft array inside `clip.edit`: existing notes keep their `id`; `push` and `unshift` also take a new note without `id` or `channel` (as `NoteInit`), which get a generated id and channel 0. */
export type NoteDraft = DraftNote[] & {
  push(...notes: (DraftNote | NoteInit)[]): number;
  unshift(...notes: (DraftNote | NoteInit)[]): number;
};
/** A beat interval (a selection, a view window). */
export type MidiRange = Readonly<{ start: number; end: number }>;
/** Notes with the clip length they sit in, in beats. */
export type MidiData = Readonly<{ notes: readonly MidiNote[]; duration: number }>;

/** A channel message other than a note (controller, pitch bend, program change, pressure), `beat` from the file's start. */
export type MidiFileEvent = Readonly<{ beat: number; data: Uint8Array }>;
/** One track chunk of a standard MIDI file. */
export type ParsedMidiTrack = Readonly<{
  /** Position of the chunk in the file (0 is the first, often a tempo-only conductor track). */
  index: number;
  /** The track-name meta event; absent when the track has none. */
  name?: string;
  /** This track's notes (the same objects as in `ParsedMidi.notes`), channels kept. */
  notes: readonly MidiNote[];
  /** This track's controller, pitch-bend, program-change and pressure messages as raw bytes, in file order. */
  events: readonly MidiFileEvent[];
  /** Beats to this track's end-of-track. */
  end: number;
}>;

/** A standard MIDI file. */
export type ParsedMidi = Readonly<{
  /** Every note of every track, in beats from the file's start (ticks / ppq): the file's own tempo is not applied, so the notes follow the transport. */
  notes: readonly MidiNote[];
  /** Beats to the end of the last note or end-of-track. */
  duration: number;
  /** Ticks per quarter note. */
  ppq: number;
  /** The file's tempo map, for display: BPM from a beat on. */
  tempos: readonly Readonly<{ beat: number; bpm: number }>[];
  /** The file's time signatures from a beat on. */
  signatures: readonly Readonly<{ beat: number; numerator: number; denominator: number }>[];
  /** Every track chunk in file order, each with its name, notes and non-note channel messages. */
  tracks: readonly ParsedMidiTrack[];
}>;

/** What notes play into: a `Sampler` or `WebClapHost` is one; for your own synth, pass an object with these two methods. */
export interface Instrument {
  /** Start `note` (0-127) at audio-context time `options.when` (default now) with `options.velocity` 0..1 (default 1) on `options.channel` 0-15 (default 0). */
  noteOn(note: number, options?: Readonly<{ velocity?: number; when?: number; channel?: number }>): unknown;
  /** Release `note` at audio-context time `when` (default now). */
  /** `since` is when the note-on this release answers started: an instrument that tracks its voices releases only the voices that began at or before it, so a note of the same pitch another clip started later keeps sounding. */
  noteOff(note: number, when?: number, since?: number): unknown;
}

/** A message other than a note, at a beat from the take's start. */
export type MidiTakeEvent = Readonly<{ beat: number; data: Uint8Array }>;
/** One recorded take. */
export type MidiTake = Readonly<{
  /** Notes in beats from the take's start (at the clock's tempo; 120 BPM when no clock is attached), velocity 0..1. Notes still held at the end are closed there; anything played before the start or after the end is left out. Ready for `new MidiClip(take.notes)`. */
  notes: readonly MidiNote[];
  /** Take length in beats. */
  duration: number;
  /** The clock beat at `startTime` when the recorder was attached to a playing clock at the start, else null. */
  startBeat: number | null;
  /** AudioContext seconds of the take's start. */
  startTime: number;
  /** AudioContext seconds of the take's end. */
  endTime: number;
  /** Every other accepted message (controllers, pitch bend, program change) with its beat from the take's start. */
  events: readonly MidiTakeEvent[];
}>;

/** A beat length: "2m" two bars of `barBeats`, "4n" one beat (a quarter note), "8n" half a beat. */
export function noteBeats(value: string, barBeats: number): number {
  const m = /^(\d+(?:\.\d+)?)([mn])$/.exec(value);
  if (!m || !(Number(m[1]) > 0)) throw new RangeError(`MIDI needs a note value such as "4n" or "1m", got "${value}".`);
  return m[2] === "m" ? Number(m[1]) * barBeats : 4 / Number(m[1]);
}

/** Why a note is invalid, or null. Callers keep their own error prefix. */
export function noteProblem(note: NoteInit): string | null {
  if (!Number.isInteger(note.pitch) || note.pitch < 0 || note.pitch > 127) return "pitch must be an integer 0-127";
  if (!Number.isFinite(note.velocity) || note.velocity < 0 || note.velocity > 1) return "velocity must be 0..1";
  if (!Number.isFinite(note.start) || note.start < 0) return "start must be finite beats >= 0";
  if (!Number.isFinite(note.duration) || note.duration < 0) return "duration must be finite beats >= 0";
  if (note.channel !== undefined && (!Number.isInteger(note.channel) || note.channel < 0 || note.channel > 15))
    return "channel must be an integer 0-15";
  if (note.id !== undefined && (typeof note.id !== "string" || !note.id)) return "id must be a non-empty string";
  return null;
}

let generated = 0;
/** Validates `notes`, fills ids and channels, and returns them frozen and sorted by start then pitch. */
export function normalizeNotes(notes: readonly NoteInit[], owner: string): readonly MidiNote[] {
  const ids = new Set<string>();
  for (const n of notes) if (typeof n.id === "string" && n.id) ids.add(n.id);
  const seen = new Set<string>();
  const out = notes.map((n) => {
    const problem = noteProblem(n);
    if (problem) throw new RangeError(`${owner} note ${problem}.`);
    let id = n.id;
    if (!id) {
      do id = `note-${++generated}`;
      while (ids.has(id));
      ids.add(id);
    }
    if (seen.has(id)) throw new RangeError(`${owner} notes need unique ids.`);
    seen.add(id);
    return Object.freeze({ id, pitch: n.pitch, velocity: n.velocity, start: n.start, duration: n.duration, channel: n.channel ?? 0 });
  });
  out.sort((a, b) => a.start - b.start || a.pitch - b.pitch);
  return Object.freeze(out);
}

const prefixes = new WeakMap<readonly MidiNote[], number[]>();
/** Inclusive intersection for display, in beats. Notes must be sorted by start and immutable. */
export function visibleMidiNotes(
  notes: readonly MidiNote[],
  range: MidiRange,
  pitches?: Readonly<{ low: number; high: number }>,
): readonly MidiNote[] {
  let ends = prefixes.get(notes);
  if (!ends) {
    let end = -Infinity;
    ends = notes.map((n) => (end = Math.max(end, n.start + n.duration)));
    prefixes.set(notes, ends);
  }
  const first = (past: (i: number) => boolean) => {
    let lo = 0,
      hi = notes.length;
    while (lo < hi) {
      const m = (lo + hi) >>> 1;
      if (past(m)) hi = m;
      else lo = m + 1;
    }
    return lo;
  };
  const start = first((i) => ends![i] >= range.start),
    stop = first((i) => notes[i].start > range.end),
    out: MidiNote[] = [];
  for (let i = start; i < stop; i++) {
    const n = notes[i];
    if (n.start + n.duration >= range.start && (!pitches || (n.pitch >= pitches.low && n.pitch <= pitches.high))) out.push(n);
  }
  return out;
}
