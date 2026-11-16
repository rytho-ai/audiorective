/** Authoritative immutable MIDI note/selection snapshots, independent of DOM and audio.
 * Reads: ./midi-file for parsing and ./midi-data for note validation/query. Views borrow this owner.
 */
import { batch, cell, readonlyCell, untracked, type ReadonlyCell } from "@audiorective/core";
import { isValidMidiNote, visibleMidiNotes, type MidiData, type MidiNote, type MidiRange, type ParsedMidi } from "./midi-data";
import { parseMidi } from "./midi-file";
export type MidiSequenceState = MidiData & Readonly<{ selection: MidiRange | null; revision: number }>;
/** Observable state, read-only. Each cell tracks only its own slice: a selection change does not re-run an effect reading `notes`. */
export type MidiSequenceCells = Readonly<{
  /** The whole frozen snapshot; the same object `getState()` returns. */
  state: ReadonlyCell<MidiSequenceState>;
  notes: ReadonlyCell<readonly MidiNote[]>;
  duration: ReadonlyCell<number>;
  selection: ReadonlyCell<MidiRange | null>;
  revision: ReadonlyCell<number>;
}>;
export class MidiSequence {
  /** The only store. Every commit replaces the whole snapshot in one write, so observers never see a partial change. */
  private readonly store = cell<MidiSequenceState>(Object.freeze({ notes: Object.freeze([]), duration: 0, selection: null, revision: 0 }));
  readonly cells: MidiSequenceCells = Object.freeze({
    state: readonlyCell(this.store),
    notes: readonlyCell(() => this.store.value.notes),
    duration: readonlyCell(() => this.store.value.duration),
    selection: readonlyCell(() => this.store.value.selection),
    revision: readonlyCell(() => this.store.value.revision),
  });
  /** Internal read: never subscribes a caller's effect. Public readers are tracked. */
  private get state(): MidiSequenceState {
    return untracked(() => this.store.value);
  }
  private listeners = new Set<() => void>();
  private disposed = false;
  constructor(data?: MidiData) {
    if (data) this.setData(data);
  }
  private alive() {
    if (this.disposed) throw new Error("MidiSequence is destroyed.");
  }
  getState(): MidiSequenceState {
    return this.cells.state.value;
  }
  subscribe(fn: () => void): () => void {
    this.alive();
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private commit(next: Omit<MidiSequenceState, "revision">) {
    batch(() => (this.store.value = Object.freeze({ ...next, revision: this.state.revision + 1 })));
    for (const fn of [...this.listeners]) {
      try {
        untracked(fn);
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
        if (!isValidMidiNote(n, data.duration) || ids.has(n.id))
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
    return this.cells.selection.value;
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
    return visibleMidiNotes(this.cells.notes.value, range, pitches);
  }
  destroy(): void {
    this.disposed = true;
    this.listeners.clear();
  }
}
