/** MIDI value types, shared note validation and indexed interval queries. */
export type MidiRange = Readonly<{ start: number; end: number }>;
export type MidiNote = Readonly<{ id: string; start: number; end: number; pitch: number; velocity: number; channel: number; track: number }>;
export type MidiTempo = Readonly<{ tick: number; usPerQuarter: number }>;
export type MidiSignature = Readonly<{ tick: number; numerator: number; denominator: number }>;
export type MidiData = Readonly<{ notes: readonly MidiNote[]; duration: number }>;
/** Captured message on the AudioContext output timeline. Matched note messages carry their projected note ID. */
export type RecordedMidiEvent = Readonly<{ audioTime: number; data: Uint8Array; noteId?: string }>;
export type RecordedMidi = MidiData &
  Readonly<{
    /** Absolute positions on the borrowed AudioContext's output timeline. */
    startTime: number;
    endTime: number;
    /** Messages accepted during the take in delivery order, including controllers and program changes. */
    events: readonly RecordedMidiEvent[];
  }>;
export type ParsedMidi = MidiData & Readonly<{ ppq: number; tempos: readonly MidiTempo[]; signatures: readonly MidiSignature[]; endTick: number }>;

/** Shared note-domain check; callers retain their own error messages and duplicate-ID policy. */
export function isValidMidiNote(note: MidiNote, duration: number): boolean {
  return (
    typeof note.id === "string" &&
    !!note.id &&
    Number.isFinite(note.start) &&
    Number.isFinite(note.end) &&
    note.start >= 0 &&
    note.end >= note.start &&
    note.end <= duration &&
    Number.isInteger(note.pitch) &&
    note.pitch >= 0 &&
    note.pitch <= 127 &&
    Number.isInteger(note.velocity) &&
    note.velocity >= 0 &&
    note.velocity <= 127 &&
    Number.isInteger(note.channel) &&
    note.channel >= 0 &&
    note.channel <= 15 &&
    Number.isInteger(note.track) &&
    note.track >= 0
  );
}

const prefixes = new WeakMap<readonly MidiNote[], number[]>();
/** Inclusive intersection for display. Notes must be sorted by start and immutable. */
export function visibleMidiNotes(
  notes: readonly MidiNote[],
  range: MidiRange,
  pitches?: Readonly<{ low: number; high: number }>,
): readonly MidiNote[] {
  let ends = prefixes.get(notes);
  if (!ends) {
    let end = -Infinity;
    ends = notes.map((n) => (end = Math.max(end, n.end)));
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
    if (n.end >= range.start && (!pitches || (n.pitch >= pitches.low && n.pitch <= pitches.high))) out.push(n);
  }
  return out;
}
