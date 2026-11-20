/** Borrowed MIDI models, replaceable appearance and widget-owned gesture contracts. */
import type { MidiData, MidiNote, MidiRange } from "@audiorective/midi";
import type { PluginTarget, SelectionCommit, SnapMode, TimeViewPluginContext, WaveformViewport } from "./types";
export type PitchRange = Readonly<{ low: number; high: number }>;
/** Piano-roll viewport scale in the borrowed model's time unit. */
export type PianoRollViewport = WaveformViewport & Readonly<{ timeUnit: "seconds" | "beats"; pixelsPerUnit: number }>;
export interface PianoRollModel {
  getState(): MidiData & Readonly<{ selection: MidiRange | null }>;
  getSelection(): MidiRange | null;
  setSelection(range: MidiRange | null): void;
  subscribe(listener: () => void): () => void;
}
export type PianoRollEditKind = "move" | "resize-start" | "resize-end";
export type PianoRollNoteEdit = Readonly<{ kind: PianoRollEditKind; previous: MidiNote; note: MidiNote }>;
export type PianoRollRenderFrame = Readonly<{
  notes: readonly MidiNote[];
  timeUnit: "seconds" | "beats";
  width: number;
  height: number;
  duration: number;
  pitches: PitchRange;
  viewport: PianoRollViewport;
  timeToX(time: number): number;
  pitchToY(pitch: number): number;
  readonly editable: boolean;
  /** Forward a note press; widget owns capture, preview, snap, cancellation and commit. */
  onNotePointerDown(note: MidiNote, event: PointerEvent, kind?: PianoRollEditKind): void;
  onNoteClick(note: MidiNote): void;
}>;
export type PianoRollRenderer = (root: HTMLElement) => { render(frame: PianoRollRenderFrame): void; dispose?(): void };
export type PianoRollLayoutFrame = Readonly<
  Pick<PianoRollRenderFrame, "duration" | "height" | "pitches" | "viewport" | "pitchToY"> & { zoom: number; snap: SnapMode }
>;
export type PianoRollControls = Pick<PianoRollHandle, "setZoom" | "scrollTo" | "setPitchRange" | "setSnap" | "setGrid">;
/** Mount the supplied widget viewport inside root; own the surrounding keyboard/controls. */
export type PianoRollLayout = (
  root: HTMLElement,
  viewport: HTMLElement,
  controls: PianoRollControls,
) => {
  render(frame: PianoRollLayoutFrame): void;
  dispose?(): void;
};
export type PianoRollOptions = {
  model: PianoRollModel;
  /** Unit of the borrowed model's note times, duration, grid and playhead. Default: seconds. */
  timeUnit?: "seconds" | "beats";
  label?: string;
  pitches?: PitchRange;
  grid?: Readonly<{ beats: readonly number[]; downbeats: readonly number[] }>;
  snap?: SnapMode;
  renderer?: PianoRollRenderer;
  layout?: PianoRollLayout;
  /** Enables move/resize gestures. Commit once on release; update the borrowed model here. */
  onNoteEdit?: (edit: PianoRollNoteEdit) => void;
  onNoteClick?: (note: MidiNote) => void;
  onCommit?: (commit: SelectionCommit) => void;
};
export interface PianoRollHandle extends PluginTarget<TimeViewPluginContext> {
  setPlayhead(time: number | null): void;
  setZoom(factor: number): void;
  scrollTo(time: number): void;
  setPitchRange(pitches: PitchRange): void;
  getViewport(): PianoRollViewport;
  setSnap(mode: SnapMode): void;
  setGrid(grid: Readonly<{ beats: readonly number[]; downbeats: readonly number[] }>): void;
  dispose(): void;
}
