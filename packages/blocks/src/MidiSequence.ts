/** Authoritative immutable MIDI note/selection snapshots, independent of DOM and audio.
 * Reads: ./midi-data for parsing and interval query. Views borrow this owner.
 */
import { parseMidi, visibleMidiNotes, type MidiData, type MidiNote, type MidiRange, type ParsedMidi } from "./midi-data";
export type MidiSequenceState = MidiData & Readonly<{ selection: MidiRange | null; revision: number }>;
export class MidiSequence {
  private state: MidiSequenceState = Object.freeze({ notes: Object.freeze([]), duration: 0, selection: null, revision: 0 });
  private listeners = new Set<() => void>();
  private disposed = false;
  constructor(data?: MidiData) {
    if (data) this.setData(data);
  }
  private alive() {
    if (this.disposed) throw new Error("MidiSequence is destroyed.");
  }
  getState(): MidiSequenceState {
    return this.state;
  }
  subscribe(fn: () => void): () => void {
    this.alive();
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private commit(next: Omit<MidiSequenceState, "revision">) {
    this.state = Object.freeze({ ...next, revision: this.state.revision + 1 });
    for (const fn of [...this.listeners]) {
      try {
        fn();
      } catch (error) {
        console.error("MidiSequence listener failed.", error);
      }
    }
  }
  load(bytes: ArrayBuffer | Uint8Array): ParsedMidi {
    this.alive();
    const parsed = parseMidi(bytes);
    this.setData(parsed);
    return parsed;
  }
  private validated(data: MidiData): readonly MidiNote[] {
    if (!Number.isFinite(data.duration) || data.duration < 0) throw new RangeError("MIDI duration must be finite and non-negative.");
    const ids = new Set<string>();
    const notes = data.notes
      .map((n) => {
        if (
          typeof n.id !== "string" ||
          !n.id ||
          ids.has(n.id) ||
          !Number.isFinite(n.start) ||
          !Number.isFinite(n.end) ||
          n.start < 0 ||
          n.end < n.start ||
          n.end > data.duration ||
          !Number.isInteger(n.pitch) ||
          n.pitch < 0 ||
          n.pitch > 127 ||
          !Number.isInteger(n.velocity) ||
          n.velocity < 0 ||
          n.velocity > 127 ||
          !Number.isInteger(n.channel) ||
          n.channel < 0 ||
          n.channel > 15 ||
          !Number.isInteger(n.track) ||
          n.track < 0
        )
          throw new RangeError("MIDI notes need unique ids, valid source seconds and integer pitch/velocity/channel/track.");
        ids.add(n.id);
        return Object.freeze({ ...n });
      })
      .sort((a, b) => a.start - b.start || a.pitch - b.pitch);
    return Object.freeze(notes);
  }
  setData(data: MidiData): void {
    this.alive();
    this.commit({ duration: data.duration, notes: this.validated(data), selection: null });
  }
  getSelection(): MidiRange | null {
    return this.state.selection;
  }
  setSelection(selection: MidiRange | null): void {
    this.alive();
    if (
      selection &&
      (!Number.isFinite(selection.start) ||
        !Number.isFinite(selection.end) ||
        selection.start < 0 ||
        selection.start >= selection.end ||
        selection.end > this.state.duration)
    )
      throw new RangeError("Selection must satisfy 0 <= start < end <= duration (finite seconds).");
    this.commit({ ...this.state, selection: selection ? Object.freeze({ ...selection }) : null });
  }
  updateNote(id: string, patch: Partial<Omit<MidiNote, "id">>): void {
    this.alive();
    const note = this.state.notes.find((n) => n.id === id);
    if (!note) throw new Error("MIDI note was not found.");
    const next = { ...note, ...patch, id },
      selection = this.state.selection;
    const duration = Math.max(this.state.duration, next.end);
    const notes = this.validated({ duration, notes: this.state.notes.map((n) => (n.id === id ? next : n)) });
    this.commit({ duration, notes, selection });
  }
  query(range: MidiRange, pitches?: Readonly<{ low: number; high: number }>): readonly MidiNote[] {
    return visibleMidiNotes(this.state.notes, range, pitches);
  }
  destroy(): void {
    this.disposed = true;
    this.listeners.clear();
  }
}
