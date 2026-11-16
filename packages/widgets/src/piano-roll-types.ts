/** Borrowed MIDI models, replaceable appearance and widget-owned gesture contracts. */
import type { MidiData, MidiNote, MidiRange } from "@audiorective/midi";
import type { PluginAttachment, SelectionCommit, SnapMode, WaveformPlugin, WaveformViewport } from "./types";
export type PitchRange = Readonly<{ low: number; high: number }>;
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
  width: number;
  height: number;
  duration: number;
  pitches: PitchRange;
  viewport: WaveformViewport;
  timeToX(seconds: number): number;
  pitchToY(pitch: number): number;
  readonly editable: boolean;
  /** Forward a note press; widget owns capture, preview, snap, cancellation and commit. */
  onNotePointerDown(note: MidiNote, event: PointerEvent, kind?: PianoRollEditKind): void;
  onNoteClick(note: MidiNote): void;
}>;
export type PianoRollRenderer = (root: HTMLElement) => { render(frame: PianoRollRenderFrame): void; destroy?(): void };
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
  destroy?(): void;
};
export type PianoRollOptions = {
  model: PianoRollModel;
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
export interface PianoRollHandle {
  setPlayhead(seconds: number | null): void;
  setZoom(factor: number): void;
  scrollTo(seconds: number): void;
  setPitchRange(pitches: PitchRange): void;
  getViewport(): WaveformViewport;
  /** Attach a time-based overlay/interaction using the same context as waveform plugins. */
  attach(plugin: WaveformPlugin): PluginAttachment;
  setSnap(mode: SnapMode): void;
  setGrid(grid: Readonly<{ beats: readonly number[]; downbeats: readonly number[] }>): void;
  destroy(): void;
}
