/** Borrowed MIDI models (note times, duration, grid and playhead are in beats), replaceable appearance and widget-owned gesture contracts. */
import type { MidiData, MidiNote, MidiRange } from "@audiorective/midi";
import type { PluginTarget, SelectionCommit, SnapMode, TimeViewPluginContext, WaveformViewport } from "./types";
export type PitchRange = Readonly<{
  /** Lowest visible MIDI note number, 0..127, inclusive. */
  low: number;
  /** Highest visible MIDI note number, 0..127, inclusive. */
  high: number;
}>;
/** Piano-roll viewport; scale is in pixels per beat (`pixelsPerUnit`, also reported as `pixelsPerSecond` for plugins shared with the waveform). */
export type PianoRollViewport = WaveformViewport &
  Readonly<{
    /** Positive horizontal scale in pixels per quarter-note beat. */
    pixelsPerUnit: number;
  }>;
export interface PianoRollModel {
  /** `window` is the part of the content that plays, in beats; notes outside it are drawn dimmed. Omit it to draw everything alike. */
  getState(): MidiData &
    Readonly<{
      /** Selected half-open quarter-note beat range; null means no selection. */
      selection: MidiRange | null;
      /** Optional half-open playable range in quarter-note beats; absent draws all notes alike. */
      window?: MidiRange;
    }>;
  /** Returns the half-open quarter-note beat selection, or null when unselected. */
  getSelection(): MidiRange | null;
  /** Commits a half-open quarter-note beat selection; null clears it. */
  setSelection(range: MidiRange | null): void;
  /** Registers model-change notifications; returns a function that stops listening. */
  subscribe(listener: () => void): () => void;
}
export type PianoRollEditKind = "move" | "resize-start" | "resize-end";
/** One committed gesture. `"velocity"` comes from the velocity lane and changes only `note.velocity`. */
export type PianoRollNoteEdit = Readonly<{
  /** Committed edit operation; velocity changes only the normalized strike strength. */
  kind: PianoRollEditKind | "velocity";
  /** Note before the gesture, retaining its identifier and quarter-note beat coordinates. */
  previous: MidiNote;
  /** Note after the gesture, retaining its identifier and normalized 0..1 velocity. */
  note: MidiNote;
}>;
/** A note drawn by the user, in beats with velocity 0..1. It has no `id` until the model adds it. */
export type PianoRollNewNote = Readonly<{
  /** MIDI note number, 0..127; 60 is middle C. */
  pitch: number;
  /** Inclusive onset in quarter-note beats. */
  start: number;
  /** Positive note extent in quarter-note beats. */
  duration: number;
  /** Normalized strike strength, 0..1. */
  velocity: number;
}>;
export type PianoRollRenderFrame = Readonly<{
  /** Notes to draw, using quarter-note beats and normalized 0..1 velocity. */
  notes: readonly MidiNote[];
  /** Drawing width in CSS pixels. */
  width: number;
  /** Drawing height in CSS pixels. */
  height: number;
  /** Length of the content in beats. */
  duration: number;
  /** The part of the content that plays, in beats, when the model has one. */
  window?: MidiRange;
  /** Inclusive visible MIDI-note bounds; notes outside them are not shown. */
  pitches: PitchRange;
  /** Current scroll and scale snapshot; horizontal units are quarter-note beats. */
  viewport: PianoRollViewport;
  /** Pixel x of `time` in beats. */
  timeToX(time: number): number;
  /** Maps a MIDI note number to its vertical CSS-pixel coordinate. */
  pitchToY(pitch: number): number;
  /** Whether note gestures are enabled by the caller's edit callbacks. */
  readonly editable: boolean;
  /** Forward a note press; widget owns capture, preview, snap, cancellation and commit. */
  onNotePointerDown(note: MidiNote, event: PointerEvent, kind?: PianoRollEditKind): void;
  /** Forwards activation of a note; does not itself mutate the borrowed model. */
  onNoteClick(note: MidiNote): void;
}>;
export type PianoRollRenderer = (root: HTMLElement) => {
  /** Draws the current note frame; times are quarter-note beats and dimensions are CSS pixels. */
  render(frame: PianoRollRenderFrame): void;
  /** Releases resources owned by this attachment or view; safe to call twice. */
  dispose?(): void;
};
export type PianoRollLayoutFrame = Readonly<
  Pick<PianoRollRenderFrame, "duration" | "height" | "pitches" | "viewport" | "pitchToY"> & {
    /** Positive dimensionless horizontal zoom factor; 1 is the base scale. */
    zoom: number;
    /** Current gesture-snapping rule; "off" leaves positions unsnapped. */
    snap: SnapMode;
  }
>;
export type PianoRollControls = Pick<PianoRollHandle, "setZoom" | "scrollTo" | "setPitchRange" | "setSnap" | "setGrid">;
/** Mount the supplied widget viewport inside root; own the surrounding keyboard/controls. */
export type PianoRollLayout = (
  root: HTMLElement,
  viewport: HTMLElement,
  controls: PianoRollControls,
) => {
  /** Updates surrounding controls from the current beat-based viewport frame. */
  render(frame: PianoRollLayoutFrame): void;
  /** Releases resources owned by this attachment or view; safe to call twice. */
  dispose?(): void;
};
export type PianoRollOptions = {
  /** Borrowed note/selection model; widget edits are committed through caller callbacks. */
  model: PianoRollModel;
  /** Accessible editor caption; defaults to "Piano roll". */
  label?: string;
  /** Inclusive MIDI-note bounds; defaults to the content span expanded to at least 46..74 and clamped to 0..127. */
  pitches?: PitchRange;
  /** Optional quarter-note beat and downbeat positions; omitted means no supplied grid lines. */
  grid?: Readonly<{
    /** Beat-guide positions in quarter-note beats; an empty array draws no guides. */
    beats: readonly number[];
    /** Bar-boundary guide positions in quarter-note beats; an empty array draws no guides. */
    downbeats: readonly number[];
  }>;
  /** Initial gesture-snapping rule; defaults to "off". */
  snap?: SnapMode;
  /** Optional drawing factory; omitted to use the built-in note renderer. */
  renderer?: PianoRollRenderer;
  /** Optional surrounding-controls factory; omitted to use the built-in layout. */
  layout?: PianoRollLayout;
  /** Enables move/resize gestures. Commit once on release; update the borrowed model here. */
  onNoteEdit?: (edit: PianoRollNoteEdit) => void;
  /** Enables adding: double-click empty space. Add the note to the borrowed model here. */
  onNoteAdd?: (note: PianoRollNewNote) => void;
  /** Enables deleting: double-click a note, or press Delete or Backspace on the note last clicked. Remove it from the borrowed model here. */
  onNoteDelete?: (note: MidiNote) => void;
  /** Show a lane under the notes where dragging a bar sets velocity, reported to `onNoteEdit` as kind `"velocity"`. Default false. */
  velocityLane?: boolean;
  /** Optional callback after note activation; does not enable editing by itself. */
  onNoteClick?: (note: MidiNote) => void;
  /** Optional callback after selection commit; ranges use quarter-note beats. */
  onCommit?: (commit: SelectionCommit) => void;
};
export interface PianoRollHandle extends PluginTarget<TimeViewPluginContext> {
  /** Moves the external playhead to `time` in beats, or hides it with null. */
  setPlayhead(time: number | null): void;
  /** Tell the view which note the app has selected, so Delete and a chord's velocity drag act on it. */
  setActiveNote(noteId: string | null): void;
  /** Sets a positive dimensionless horizontal zoom factor, with 1 as the base scale. */
  setZoom(factor: number): void;
  /** Scrolls so `time` (beats) is at the left edge of the view. */
  scrollTo(time: number): void;
  /** Replaces the inclusive visible MIDI-note bounds, within 0..127. */
  setPitchRange(pitches: PitchRange): void;
  /** Returns the current viewport; horizontal scale and extent use quarter-note beats. */
  getViewport(): PianoRollViewport;
  /** Replaces the gesture-snapping rule; "off" disables snapping. */
  setSnap(mode: SnapMode): void;
  /** Replaces quarter-note beat and downbeat grid positions without rebuilding the widget. */
  setGrid(
    grid: Readonly<{
      /** Beat-guide positions in quarter-note beats; an empty array draws no guides. */
      beats: readonly number[];
      /** Bar-boundary guide positions in quarter-note beats; an empty array draws no guides. */
      downbeats: readonly number[];
    }>,
  ): void;
  /** Releases resources owned by this attachment or view; safe to call twice. */
  dispose(): void;
}
