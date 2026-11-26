/** Borrowed MIDI models (note times, duration, grid and playhead are in beats), replaceable appearance and widget-owned gesture contracts. */
import type { MidiData, MidiNote, MidiRange } from "@audiorective/midi";
import type { PluginTarget, SelectionCommit, SnapMode, TimeViewPluginContext, WaveformViewport } from "./types";
export type PitchRange = Readonly<{ low: number; high: number }>;
/** Piano-roll viewport; scale is in pixels per beat (`pixelsPerUnit`, also reported as `pixelsPerSecond` for plugins shared with the waveform). */
export type PianoRollViewport = WaveformViewport & Readonly<{ pixelsPerUnit: number }>;
export interface PianoRollModel {
  /** `window` is the part of the content that plays, in beats; notes outside it are drawn dimmed. Omit it to draw everything alike. */
  getState(): MidiData & Readonly<{ selection: MidiRange | null; window?: MidiRange }>;
  getSelection(): MidiRange | null;
  setSelection(range: MidiRange | null): void;
  subscribe(listener: () => void): () => void;
}
export type PianoRollEditKind = "move" | "resize-start" | "resize-end";
/** One committed gesture. `"velocity"` comes from the velocity lane and changes only `note.velocity`. */
export type PianoRollNoteEdit = Readonly<{ kind: PianoRollEditKind | "velocity"; previous: MidiNote; note: MidiNote }>;
/** A note drawn by the user, in beats with velocity 0..1. It has no `id` until the model adds it. */
export type PianoRollNewNote = Readonly<{ pitch: number; start: number; duration: number; velocity: number }>;
export type PianoRollRenderFrame = Readonly<{
  notes: readonly MidiNote[];
  width: number;
  height: number;
  /** Length of the content in beats. */
  duration: number;
  /** The part of the content that plays, in beats, when the model has one. */
  window?: MidiRange;
  pitches: PitchRange;
  viewport: PianoRollViewport;
  /** Pixel x of `time` in beats. */
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
  label?: string;
  pitches?: PitchRange;
  grid?: Readonly<{ beats: readonly number[]; downbeats: readonly number[] }>;
  snap?: SnapMode;
  renderer?: PianoRollRenderer;
  layout?: PianoRollLayout;
  /** Enables move/resize gestures. Commit once on release; update the borrowed model here. */
  onNoteEdit?: (edit: PianoRollNoteEdit) => void;
  /** Enables adding: double-click empty space. Add the note to the borrowed model here. */
  onNoteAdd?: (note: PianoRollNewNote) => void;
  /** Enables deleting: double-click a note, or press Delete or Backspace on the note last clicked. Remove it from the borrowed model here. */
  onNoteDelete?: (note: MidiNote) => void;
  /** Show a lane under the notes where dragging a bar sets velocity, reported to `onNoteEdit` as kind `"velocity"`. Default false. */
  velocityLane?: boolean;
  onNoteClick?: (note: MidiNote) => void;
  onCommit?: (commit: SelectionCommit) => void;
};
export interface PianoRollHandle extends PluginTarget<TimeViewPluginContext> {
  /** Moves the external playhead to `time` in beats, or hides it with null. */
  setPlayhead(time: number | null): void;
  /** Tell the view which note the app has selected, so Delete and a chord's velocity drag act on it. */
  setActiveNote(noteId: string | null): void;
  setZoom(factor: number): void;
  /** Scrolls so `time` (beats) is at the left edge of the view. */
  scrollTo(time: number): void;
  setPitchRange(pitches: PitchRange): void;
  getViewport(): PianoRollViewport;
  setSnap(mode: SnapMode): void;
  setGrid(grid: Readonly<{ beats: readonly number[]; downbeats: readonly number[] }>): void;
  dispose(): void;
}
