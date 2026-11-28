/** Widget-owned note gestures; previews are transient, the borrowed model commits through a callback.
 * Reads: public MIDI note types, piano-roll gesture contracts and shared time plugin context.
 * Pointer capture lives on the stable surface, so renderers can replace note DOM during a drag.
 */
import type { MidiData, MidiNote } from "@audiorective/midi";
import type { WaveformPlugin, WaveformPluginContext } from "./types";
import type { PianoRollEditKind, PianoRollNoteEdit, PitchRange } from "./piano-roll-types";
const clamp = (n: number, a: number, b: number) => Math.max(a, Math.min(b, n));
/** The shortest note a resize gesture produces, in beats (a 64th note in 4/4). */
export const MIN_NOTE_BEATS = 1 / 64;
type Gesture = {
  id: number;
  original: MidiNote;
  preview: MidiNote;
  kind: PianoRollEditKind;
  x: number;
  y: number;
  moved: boolean;
  geometry: string;
};
export function createNoteEditor(options: {
  read(): MidiData;
  pitches(): PitchRange;
  redraw(): void;
  snap(time: number, alt: boolean): number;
  inspect(note: MidiNote): void;
  commit?: (edit: PianoRollNoteEdit) => void;
}) {
  let context: WaveformPluginContext | undefined, gesture: Gesture | undefined;
  let suppressClick = false,
    clickTimer: ReturnType<typeof setTimeout> | undefined;
  const geometry = () => {
    const v = context!.getViewport(),
      p = options.pitches();
    return `${v.pixelsPerSecond}:${v.scrollLeft}:${v.width}:${v.height}:${p.low}:${p.high}`;
  };
  const release = (g: Gesture) => {
    if (context?.surface.hasPointerCapture(g.id)) context.surface.releasePointerCapture(g.id);
  };
  const cancel = () => {
    const g = gesture;
    if (!g) return;
    gesture = undefined;
    release(g);
    options.redraw();
  };
  function update(event: PointerEvent) {
    const g = gesture;
    if (!g || event.pointerId !== g.id || !context) return;
    if (g.geometry !== geometry()) {
      cancel();
      return;
    }
    if (!g.moved && Math.hypot(event.clientX - g.x, event.clientY - g.y) < 3) return;
    g.moved = true;
    const v = context.getViewport(),
      p = options.pitches(),
      original = g.original;
    const delta = v.pixelsPerSecond ? (event.clientX - g.x) / v.pixelsPerSecond : 0;
    const movedX = Math.abs(event.clientX - g.x) >= 3;
    const originalEnd = original.start + original.duration;
    let { start, pitch } = original,
      end = originalEnd;
    if (g.kind === "move") {
      start = movedX ? clamp(options.snap(original.start + delta, event.altKey), 0, Math.max(0, v.duration - original.duration)) : original.start;
      end = start + original.duration;
      pitch = clamp(original.pitch + Math.round(((g.y - event.clientY) * (p.high - p.low + 1)) / v.height), p.low, p.high);
    } else if (movedX) {
      const minimum = Math.min(MIN_NOTE_BEATS, original.duration);
      if (g.kind === "resize-start") start = clamp(options.snap(original.start + delta, event.altKey), 0, end - minimum);
      else end = clamp(options.snap(originalEnd + delta, event.altKey), start + minimum, v.duration);
    }
    g.preview = Object.freeze({ ...original, start, duration: end - start, pitch });
    options.redraw();
  }
  const plugin: WaveformPlugin = {
    attach(ctx) {
      context = ctx;
      ctx.listen(ctx.surface, "pointermove", (raw) => {
        const e = raw as PointerEvent;
        if (gesture?.id !== e.pointerId) return;
        e.preventDefault();
        e.stopPropagation();
        update(e);
      });
      ctx.listen(ctx.surface, "pointerup", (raw) => {
        const e = raw as PointerEvent,
          g = gesture;
        if (!g || g.id !== e.pointerId) return;
        e.preventDefault();
        e.stopPropagation();
        update(e);
        if (gesture !== g) return;
        gesture = undefined;
        release(g);
        suppressClick = true;
        clearTimeout(clickTimer);
        clickTimer = setTimeout(() => {
          suppressClick = false;
        }, 0);
        if (g.moved) options.redraw();
        if (!g.moved) options.inspect(g.original);
        else if (g.preview.start !== g.original.start || g.preview.duration !== g.original.duration || g.preview.pitch !== g.original.pitch) {
          // The owner's commit isolates and reports a throwing callback.
          options.commit?.(Object.freeze({ kind: g.kind, previous: g.original, note: g.preview }));
        }
      });
      ctx.listen(ctx.surface, "pointercancel", (raw) => {
        if ((raw as PointerEvent).pointerId === gesture?.id) cancel();
      });
      ctx.listen(ctx.surface, "lostpointercapture", (raw) => {
        if ((raw as PointerEvent).pointerId === gesture?.id) cancel();
      });
      ctx.listen(ctx.surface.ownerDocument, "keydown", (raw) => {
        if ((raw as KeyboardEvent).key === "Escape" && gesture) {
          raw.preventDefault();
          cancel();
        }
      });
      ctx.listen(window, "blur", cancel);
      const click = (event: Event) => {
        if (suppressClick) {
          event.preventDefault();
          event.stopImmediatePropagation();
        }
      };
      ctx.surface.addEventListener("click", click, true);
      ctx.onCleanup(() => ctx.surface.removeEventListener("click", click, true));
      window.addEventListener("scroll", cancel, true);
      ctx.onCleanup(() => window.removeEventListener("scroll", cancel, true));
      ctx.onDataChange(cancel);
      ctx.onViewportChange(() => {
        if (gesture && gesture.geometry !== geometry()) cancel();
      });
      ctx.onCleanup(() => {
        cancel();
        clearTimeout(clickTimer);
        context = undefined;
      });
    },
  };
  return {
    plugin,
    cancel,
    pointerDown(note: MidiNote, event: PointerEvent, kind?: PianoRollEditKind) {
      event.stopPropagation();
      if (!options.commit || !context || gesture || event.button !== 0 || !context.getViewport().pixelsPerSecond) return;
      const current = options.read().notes.find((n) => n.id === note.id);
      if (!current) return;
      const start = context.surface.getBoundingClientRect().left + context.timeToX(current.start),
        end = context.surface.getBoundingClientRect().left + context.timeToX(current.start + current.duration),
        edge = Math.min(6, (end - start) / 4);
      kind ??= event.clientX < start + edge ? "resize-start" : event.clientX > end - edge ? "resize-end" : "move";
      gesture = {
        id: event.pointerId,
        original: Object.freeze({ ...current }),
        preview: Object.freeze({ ...current }),
        kind,
        x: event.clientX,
        y: event.clientY,
        moved: false,
        geometry: geometry(),
      };
      context.surface.setPointerCapture(event.pointerId);
    },
    notes(): readonly MidiNote[] {
      const notes = options.read().notes,
        g = gesture;
      return g?.moved ? notes.map((n) => (n.id === g.original.id ? g.preview : n)).sort((a, b) => a.start - b.start || a.pitch - b.pitch) : notes;
    },
  };
}
