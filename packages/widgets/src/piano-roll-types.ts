/** Borrowed MIDI model, note-drawing frame and piano-roll view contracts. */
import type { MidiData, MidiNote, MidiRange } from "@audiorective/blocks/midi";
import type { SelectionCommit, SnapMode, WaveformViewport } from "./types";
export type PitchRange = Readonly<{ low: number; high: number }>;
export interface PianoRollModel {
  getState(): MidiData & Readonly<{ selection: MidiRange | null }>;
  getSelection(): MidiRange | null;
  setSelection(range: MidiRange | null): void;
  subscribe(listener: () => void): () => void;
}
export type PianoRollRenderFrame = Readonly<{
  notes: readonly MidiNote[];
  width: number;
  height: number;
  duration: number;
  pitches: PitchRange;
  viewport: WaveformViewport;
  timeToX(seconds: number): number;
  pitchToY(pitch: number): number;
  onNoteClick(note: MidiNote): void;
}>;
export type PianoRollRenderer = (root: HTMLElement) => { render(frame: PianoRollRenderFrame): void; destroy?(): void };
export type PianoRollOptions = {
  model: PianoRollModel;
  label?: string;
  pitches?: PitchRange;
  grid?: Readonly<{ beats: readonly number[]; downbeats: readonly number[] }>;
  snap?: SnapMode;
  renderer?: PianoRollRenderer;
  onNoteClick?: (note: MidiNote) => void;
  onCommit?: (commit: SelectionCommit) => void;
};
export interface PianoRollHandle {
  setPlayhead(seconds: number | null): void;
  setZoom(factor: number): void;
  scrollTo(seconds: number): void;
  setPitchRange(pitches: PitchRange): void;
  getViewport(): WaveformViewport;
  setSnap(mode: SnapMode): void;
  setGrid(grid: Readonly<{ beats: readonly number[]; downbeats: readonly number[] }>): void;
  destroy(): void;
}
