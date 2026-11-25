/** A `PianoRollModel` over a `MidiClip`: notes follow the clip, the selection is the model's own cell.
 * Reads: @audiorective/midi note types, core cells and effects. No DOM.
 */
import { cell, readonlyCell, untracked, type Cell } from "@audiorective/core";
import { effect } from "./detached-effect";
import type { MidiClip, MidiNote, MidiRange } from "@audiorective/midi";
import type { PianoRollModel } from "./piano-roll-types";

export interface PianoRollModelOptions {
  /** Clip length in beats, or a getter for it (read untracked by `getState`, tracked by `subscribe`). Default: the end of the last note rounded up to a whole 4-beat bar, at least 4 beats. */
  duration?: number | (() => number);
  /**
   * The part of the content the clip plays, in content beats: a `{ start, end }` range or a getter for it (`null` for none). Notes entirely outside it are
   * drawn dimmed and the window is shaded; editing still edits the content. Use `{ start: clip.sourceOffset, end: clip.sourceOffset + clip.duration }`
   * for a `MidiClip` of `@audiorective/daw`. Default: no window, nothing dimmed.
   */
  window?: MidiRange | null | (() => MidiRange | null);
}
export type ClipPianoRollModel = PianoRollModel & {
  /** The selection in beats; assign it or call `setSelection`. Nothing clears it implicitly. */
  readonly selection: Cell<MidiRange | null>;
  /** Stops every `subscribe` listener. The clip is not touched. */
  dispose(): void;
};

const BAR = 4;
const endOf = (notes: readonly MidiNote[]) => notes.reduce((end, n) => Math.max(end, n.start + n.duration), 0);

/** Binds a piano roll to `clip`: `mountPianoRoll(root, { model: pianoRollModel(clip), onNoteEdit })`. */
export function pianoRollModel(clip: MidiClip, options: PianoRollModelOptions = {}): ClipPianoRollModel {
  const selection = cell<MidiRange | null>(null);
  const length = options.duration;
  const duration = (notes: readonly MidiNote[]): number =>
    typeof length === "number" ? length : typeof length === "function" ? length() : Math.max(BAR, Math.ceil(endOf(notes) / BAR) * BAR);
  const stops = new Set<() => void>();
  const windowOf = options.window;
  let last: Readonly<{ notes: readonly MidiNote[]; duration: number; selection: MidiRange | null; window?: MidiRange }> | undefined;
  let disposed = false;

  const state = () => {
    const notes = clip.notes.value,
      range = selection.value,
      beats = untracked(() => duration(notes)),
      played = untracked(() => (typeof windowOf === "function" ? windowOf() : windowOf));
    if (
      !last ||
      last.notes !== notes ||
      last.duration !== beats ||
      last.selection !== range ||
      last.window?.start !== played?.start ||
      last.window?.end !== played?.end
    )
      last = Object.freeze({
        notes,
        duration: beats,
        selection: range,
        ...(played ? { window: Object.freeze({ start: played.start, end: played.end }) } : {}),
      });
    return last;
  };
  const range = readonlyCell(selection);

  return {
    selection,
    getState: state,
    getSelection: () => range.value,
    setSelection(next) {
      selection.value = next ? Object.freeze({ start: next.start, end: next.end }) : null;
    },
    subscribe(listener) {
      if (disposed) return () => {};
      let primed = false;
      const stop = effect(() => {
        const notes = clip.notes.value;
        void selection.value;
        void duration(notes);
        if (typeof windowOf === "function") void windowOf();
        if (primed) untracked(listener);
      });
      primed = true;
      const off = () => {
        if (!stops.delete(off)) return;
        stop();
      };
      stops.add(off);
      return off;
    },
    dispose() {
      disposed = true;
      for (const off of [...stops]) off();
    },
  };
}
