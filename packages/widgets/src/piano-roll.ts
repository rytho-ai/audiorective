/** Piano-roll view of borrowed MIDI state. Owns DOM/viewport only, never audio or note data.
 * Layout/renderer own appearance; this widget owns selection, note gestures and plugin lifetime.
 * Reads: ./piano-roll-types, default view, note editor, MIDI interval query, selection/styles.
 */
import { defaultPianoRollLayout, defaultPianoRollRenderer } from "./piano-roll-view";
import { createNoteEditor, MIN_NOTE_BEATS } from "./piano-roll-edit";
import { prepareGrid, snapTime } from "./snap-time";
import { createSelectionPlugin } from "./selection";
import type { TimeViewPluginContext, Unsubscribe } from "./types";
import { createPluginHost } from "./plugin-host";
import { styles } from "./style";
import { cell, readonlyCell } from "@audiorective/core";
import { visibleMidiNotes, type MidiNote } from "@audiorective/midi";
import type { PianoRollOptions, PianoRollHandle, PianoRollRenderer, PianoRollLayout, PitchRange } from "./piano-roll-types";
export type * from "./piano-roll-types";
export { pianoRollModel, type PianoRollModelOptions, type ClipPianoRollModel } from "./piano-roll-model";
const clamp = (n: number, low: number, high: number) => Math.max(low, Math.min(high, n));
const DEFAULT_VELOCITY = 100 / 127;
/** Half the width of a velocity handle: bars never sit closer than this to the lane edge. */
const VELOCITY_INSET = 7;
const VELOCITY_REACH = 9;
/** Mounts a piano-roll view into `root`; returns a handle whose `dispose` removes it. */
export function mountPianoRoll(root: HTMLElement, options: PianoRollOptions): PianoRollHandle {
  const container = document.createElement("section");
  container.className = "ar-widget ar-piano-roll";
  container.setAttribute("aria-label", options.label ?? "Piano roll");
  container.innerHTML = `<style>${styles}
 .ar-pr-layout{display:grid;grid-template-columns:54px minmax(0,1fr);min-width:0}
 .ar-pr-keys{position:relative;overflow:hidden;border-right:1px solid var(--waveform-border,#344154)}
 .ar-pr-key{position:absolute;left:0;width:100%;font:11px system-ui;padding-left:4px;border-bottom:1px solid var(--waveform-border,#344154)}
 .ar-pr-key[data-black=true]{background:color-mix(in srgb,currentColor 12%,transparent)}
 .ar-pr-surface{position:relative;touch-action:none;height:var(--piano-roll-height,240px);min-height:64px;overflow:hidden}
 .ar-pr-notes{position:absolute;inset:0}.ar-pr-window-shade{position:absolute;top:0;bottom:0;background:rgba(0,0,0,.28);pointer-events:none}.ar-pr-note[data-outside="true"]{opacity:.25!important}.ar-pr-note{position:absolute!important;min-height:0!important;padding:0 3px!important;border-radius:3px!important;overflow:hidden;white-space:nowrap;text-align:left;font-size:10px!important;background:var(--ar-accent)!important;color:var(--piano-roll-note-text,#08111d)!important}
 .ar-pr-grid{position:absolute;inset:0;pointer-events:none}.ar-pr-beat{position:absolute;top:0;height:100%;border-left:1px solid var(--waveform-border,#344154)}
 .ar-pr-velocity{position:relative;height:var(--piano-roll-velocity-height,56px);border-top:1px solid var(--waveform-border,#344154);touch-action:none;cursor:ns-resize;overflow:hidden}
 .ar-pr-velocity-track{position:absolute;left:0;right:0;top:7px;bottom:7px;pointer-events:none}
 .ar-pr-velocity-bar{position:absolute;bottom:0;width:2px;margin-left:-1px;background:color-mix(in srgb,var(--ar-accent) 55%,transparent);pointer-events:none}
 .ar-pr-velocity-bar::after{content:'';position:absolute;top:-5px;left:50%;width:10px;height:10px;margin-left:-5px;box-sizing:border-box;border-radius:50%;background:var(--ar-accent);border:2px solid var(--waveform-background,#141b25);opacity:.75}
 .ar-pr-velocity-bar[data-active=true]{width:3px;margin-left:-1.5px;background:var(--ar-accent);z-index:1}.ar-pr-velocity-bar[data-active=true]::after{top:-7px;width:14px;height:14px;margin-left:-7px;opacity:1;border-color:var(--piano-roll-note-text,#08111d);box-shadow:0 0 0 2px var(--ar-accent)}
 .ar-pr-velocity-value{position:absolute;top:2px;z-index:2;padding:0 4px;border-radius:3px;font:11px system-ui;background:var(--ar-accent);color:var(--piano-roll-note-text,#08111d);pointer-events:none;transform:translateX(-50%)}
 </style><div data-piano-layout></div>`;
  root.append(container);
  const shellRoot = container.querySelector<HTMLElement>("[data-piano-layout]")!;
  const viewport = document.createElement("div");
  viewport.className = "ar-viewport";
  viewport.dataset.testid = "piano-viewport";
  viewport.tabIndex = 0;
  viewport.setAttribute("aria-label", "Piano roll horizontal scroll");
  viewport.innerHTML =
    '<div class="ar-pr-surface" data-testid="piano-roll"><div class="ar-pr-grid"></div><div class="ar-pr-notes"></div><div class="ar-playhead" data-testid="piano-playhead" hidden></div></div>';
  const velocityLane = options.velocityLane ? document.createElement("div") : undefined;
  if (velocityLane) {
    velocityLane.className = "ar-pr-velocity";
    velocityLane.dataset.testid = "piano-velocity";
    velocityLane.setAttribute("aria-label", "Note velocity");
    if (options.onNoteEdit)
      velocityLane.title =
        "Drag a bar up or down to set velocity (1-127). Click a note first to pick one in a chord; ArrowUp/ArrowDown nudge the selected note.";
    viewport.append(velocityLane);
  }
  const surface = viewport.querySelector<HTMLElement>("[data-testid=piano-roll]")!,
    drawing = viewport.querySelector<HTMLElement>(".ar-pr-notes")!,
    lines = viewport.querySelector<HTMLElement>(".ar-pr-grid")!,
    playhead = viewport.querySelector<HTMLElement>("[data-testid=piano-playhead]")!;
  let state = options.model.getState(),
    zoom = 1,
    scale = 0,
    width = 1,
    height = 240,
    position: number | null = null,
    disposed = false;
  let grid = { beats: [...(options.grid?.beats ?? [])], downbeats: [...(options.grid?.downbeats ?? [])] };
  let snap = options.snap ?? "off",
    snapGrid = prepareGrid(grid);
  let low = 48,
    high = 72;
  for (const note of state.notes) {
    low = Math.min(low, note.pitch);
    high = Math.max(high, note.pitch);
  }
  let pitches: PitchRange = options.pitches ?? { low: Math.max(0, low - 2), high: Math.min(127, high + 2) };
  const cleanups = new Set<Unsubscribe>(),
    viewListeners = new Set<() => void>(),
    dataListeners = new Set<() => void>();
  const own = (dispose: Unsubscribe) => {
    let live = true;
    const off = () => {
      if (!live) return;
      live = false;
      cleanups.delete(off);
      dispose();
    };
    if (disposed) off();
    else cleanups.add(off);
    return off;
  };
  const listen = (target: EventTarget, type: string, fn: EventListener) => {
    target.addEventListener(type, fn);
    return own(() => target.removeEventListener(type, fn));
  };
  const timeToX = (time: number) => clamp(time, 0, state.duration) * scale;
  const snapshot = () =>
    Object.freeze({
      duration: state.duration,
      pixelsPerUnit: scale,
      pixelsPerSecond: scale,
      scrollLeft: viewport.scrollLeft,
      width: viewport.clientWidth,
      height,
    });
  let renderer: ReturnType<PianoRollRenderer> | undefined;
  let presentation: ReturnType<PianoRollLayout> | undefined;
  const pitchToY = (pitch: number) => ((pitches.high - pitch) * height) / (pitches.high - pitches.low + 1);
  const editor = createNoteEditor({
    read: () => state,
    pitches: () => pitches,
    redraw: render,
    snap: (time, alt) => snapTime(time, alt || snap === "off" ? undefined : snapGrid[snap], state.duration),
    inspect: (note) => {
      activeNoteId = note.id;
      options.onNoteClick?.(note);
      drawVelocity();
    },
    commit: options.onNoteEdit && ((edit) => commitNote("edit", () => options.onNoteEdit!(edit))),
  });
  let activeNoteId: string | undefined;
  let velocityDrag: { id: number; original: MidiNote; preview: MidiNote } | undefined;
  /** Notes as drawn, including an unreleased velocity drag. */
  const drawnNotes = (): readonly MidiNote[] => {
    const notes = editor.notes(),
      drag = velocityDrag;
    return drag ? notes.map((note) => (note.id === drag.original.id ? drag.preview : note)) : notes;
  };
  const pitchAtY = (clientY: number) => {
    const rows = pitches.high - pitches.low + 1;
    const row = Math.floor(((clientY - surface.getBoundingClientRect().top) / Math.max(1, height)) * rows);
    return clamp(pitches.high - row, pitches.low, pitches.high);
  };
  const beatAtX = (clientX: number) => (scale ? clamp((clientX - surface.getBoundingClientRect().left) / scale, 0, state.duration) : 0);
  const error = cell<Error | null>(null);
  const commitNote = (label: string, run: () => void) => {
    try {
      run();
    } catch (cause) {
      console.error(`Piano roll note ${label} failed:`, cause);
      error.value = cause instanceof Error ? cause : new Error("Piano roll note edit failed.", { cause });
    }
  };
  /** The grid line at or before `time`, so a new note lands in the cell that was clicked. */
  const gridStart = (time: number) => {
    const lines = snap === "off" ? [] : snapGrid[snap];
    let start = time;
    if (snap !== "off") start = 0;
    for (const line of lines) {
      if (line > time + 1e-9) break;
      start = line;
    }
    return start;
  };
  const velocityX = (note: MidiNote) => clamp(timeToX(note.start), VELOCITY_INSET, Math.max(VELOCITY_INSET, width - VELOCITY_INSET));
  const velocityAtY = (clientY: number) => {
    const rect = velocityLane!.getBoundingClientRect();
    // The handle's radius is kept inside the lane, so 1 and 127 sit one radius from the lane's bottom and top.
    const usable = Math.max(1, rect.height - 2 * VELOCITY_INSET);
    return clamp(Math.round((1 - (clientY - rect.top - VELOCITY_INSET) / usable) * 127), 1, 127) / 127;
  };
  const cancelVelocity = () => {
    const drag = velocityDrag;
    if (!drag) return;
    velocityDrag = undefined;
    if (velocityLane?.hasPointerCapture(drag.id)) velocityLane.releasePointerCapture(drag.id);
    render();
  };
  // The sequence reports its selection through getSelection/subscribe; the selection plugin follows a cell, so mirror it into one.
  const selection = cell(options.model.getSelection());
  const plugin = createSelectionPlugin({
    model: { cells: { selection: readonlyCell(selection) }, setSelection: (range) => options.model.setSelection(range) },
    grid: { beats: [...grid.beats], downbeats: [...grid.downbeats] },
    snap: options.snap,
    onCommit: options.onCommit,
  });
  function drawPlayhead() {
    playhead.hidden = position === null || !state.duration;
    if (position !== null) playhead.style.left = `${timeToX(position)}px`;
  }
  /** Redraws only the velocity lane, so the note elements (and a pending double-click on one) stay put. */
  const viewRange = () => ({ start: scale ? viewport.scrollLeft / scale : 0, end: scale ? (viewport.scrollLeft + viewport.clientWidth) / scale : 0 });
  function drawVelocity() {
    if (disposed || !velocityLane) return;
    const drawn = visibleMidiNotes(drawnNotes(), viewRange(), pitches);
    // The active note's bar is appended last so it sits on top in a chord.
    const ordered = [...drawn.filter((note) => note.id !== activeNoteId), ...drawn.filter((note) => note.id === activeNoteId)];
    const track = document.createElement("div");
    track.className = "ar-pr-velocity-track";
    const bars: HTMLElement[] = ordered.map((note) => {
      const bar = document.createElement("div");
      bar.className = "ar-pr-velocity-bar";
      bar.dataset.velocityNote = note.id;
      bar.dataset.active = String(note.id === activeNoteId);
      bar.style.left = `${velocityX(note)}px`;
      bar.style.height = `${note.velocity * 100}%`;
      return bar;
    });
    track.append(...bars);
    const children: HTMLElement[] = [track];
    const drag = velocityDrag;
    if (drag) {
      const label = document.createElement("div");
      label.className = "ar-pr-velocity-value";
      label.dataset.testid = "piano-velocity-value";
      label.textContent = String(Math.round(drag.preview.velocity * 127));
      label.style.left = `${clamp(velocityX(drag.preview), 14, Math.max(14, width - 14))}px`;
      children.push(label);
    }
    velocityLane.replaceChildren(...children);
  }
  function render() {
    if (disposed) return;
    const range = { start: scale ? viewport.scrollLeft / scale : 0, end: scale ? (viewport.scrollLeft + viewport.clientWidth) / scale : 0 };
    renderer?.render(
      Object.freeze({
        notes: visibleMidiNotes(drawnNotes(), range, pitches),
        duration: state.duration,
        ...(state.window ? { window: state.window } : {}),
        width,
        height,
        pitches: Object.freeze({ ...pitches }),
        viewport: snapshot(),
        timeToX,
        pitchToY,
        editable: !!options.onNoteEdit,
        onNotePointerDown: editor.pointerDown,
        onNoteClick: (note: MidiNote) => options.onNoteClick?.(note),
      }),
    );
    presentation?.render(
      Object.freeze({ duration: state.duration, height, pitches: Object.freeze({ ...pitches }), viewport: snapshot(), pitchToY, zoom, snap }),
    );
    drawVelocity();
    drawPlayhead();
    for (const fn of [...viewListeners]) fn();
  }
  function layout() {
    if (disposed) return;
    width = Math.max(1, viewport.clientWidth) * zoom;
    scale = state.duration ? width / state.duration : 0;
    surface.style.width = `${width}px`;
    if (velocityLane) velocityLane.style.width = `${width}px`;
    height = surface.clientHeight;
    const rowHeight = height / (pitches.high - pitches.low + 1);
    surface.style.backgroundImage = `repeating-linear-gradient(to bottom, var(--waveform-border,#344154) 0px, var(--waveform-border,#344154) 1px, transparent 1px, transparent ${rowHeight}px)`;
    lines.replaceChildren(
      ...grid.beats
        .filter((t) => Number.isFinite(t) && t >= 0 && t <= state.duration)
        .map((t) => {
          const el = document.createElement("div");
          el.className = "ar-pr-beat";
          el.style.left = `${timeToX(t)}px`;
          if (grid.downbeats.includes(t)) {
            el.classList.add("downbeat");
            el.style.borderLeftWidth = "2px";
          }
          return el;
        }),
    );
    render();
  }
  const plugins = createPluginHost<TimeViewPluginContext>("piano roll", ({ isActive, own }) => ({
    surface,
    timeUnit: "beats",
    get duration() {
      return state.duration;
    },
    getViewport: snapshot,
    timeToX,
    clientXToTime: (x) => (scale ? clamp((x - surface.getBoundingClientRect().left) / scale, 0, state.duration) : 0),
    scrollBy(pixels) {
      if (isActive()) {
        viewport.scrollLeft += pixels;
        render();
      }
    },
    getViewportRect: () => viewport.getBoundingClientRect(),
    mountOverlay(el) {
      if (!isActive()) throw new Error("Plugin attachment is disposed.");
      Object.assign(el.style, { position: "absolute", inset: "0", pointerEvents: "none" });
      surface.append(el);
      return own(() => el.remove());
    },
    onViewportChange(fn) {
      const cb = () => fn(snapshot());
      viewListeners.add(cb);
      return own(() => viewListeners.delete(cb));
    },
    onDataChange(fn) {
      const cb = () => fn(state.duration);
      dataListeners.add(cb);
      return own(() => dataListeners.delete(cb));
    },
    listen(target, type, fn) {
      target.addEventListener(type, fn);
      return own(() => target.removeEventListener(type, fn));
    },
    onCleanup: own,
  }));
  const handle: PianoRollHandle = {
    error: readonlyCell(error),
    setPlayhead(time) {
      if (time !== null && !Number.isFinite(time)) throw new RangeError("Playhead must be finite or null.");
      position = time;
      drawPlayhead();
    },
    setActiveNote(noteId) {
      activeNoteId = noteId ?? undefined;
      drawVelocity();
    },
    setZoom(factor) {
      if (!Number.isFinite(factor) || factor < 1 || factor > 64) throw new RangeError("Piano roll zoom must be between 1 and 64.");
      const center = scale ? (viewport.scrollLeft + viewport.clientWidth / 2) / scale : 0;
      editor.cancel();
      zoom = factor;
      layout();
      viewport.scrollLeft = timeToX(center) - viewport.clientWidth / 2;
      render();
    },
    scrollTo(time) {
      if (!Number.isFinite(time)) throw new RangeError("Piano roll scroll time must be finite.");
      viewport.scrollLeft = timeToX(time);
      render();
    },
    setPitchRange(next) {
      if (!Number.isInteger(next.low) || !Number.isInteger(next.high) || next.low < 0 || next.high > 127 || next.low > next.high)
        throw new RangeError("Piano roll pitches must satisfy 0 <= low <= high <= 127.");
      pitches = { ...next };
      layout();
    },
    getViewport: snapshot,
    attach: (extension) => plugins.attach(extension),
    setSnap(mode) {
      if (disposed) return;
      editor.cancel();
      snap = mode;
      plugin.setSnap(mode);
      render();
    },
    setGrid(next) {
      editor.cancel();
      grid = { beats: [...next.beats], downbeats: [...next.downbeats] };
      snapGrid = prepareGrid(grid);
      plugin.setGrid({ beats: [...next.beats], downbeats: [...next.downbeats] });
      layout();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      observer.disconnect();
      plugins.dispose();
      for (const fn of [...cleanups]) {
        try {
          fn();
        } catch (error) {
          console.error("Piano roll cleanup failed:", error);
        }
      }
      for (const part of [renderer, presentation]) {
        try {
          part?.dispose?.();
        } catch (error) {
          console.error("Piano roll view cleanup failed:", error);
        }
      }
      renderer = undefined;
      presentation = undefined;
      viewListeners.clear();
      dataListeners.clear();
      container.remove();
    },
  };
  const observer = new ResizeObserver(layout);
  try {
    renderer = (options.renderer ?? defaultPianoRollRenderer)(drawing);
    presentation = (options.layout ?? defaultPianoRollLayout)(shellRoot, viewport, {
      setZoom: handle.setZoom,
      scrollTo: handle.scrollTo,
      setPitchRange: handle.setPitchRange,
      setSnap: handle.setSnap,
      setGrid: handle.setGrid,
    });
    if (!shellRoot.contains(viewport)) throw new Error("Piano roll layout must mount its viewport inside the supplied root.");
    plugins.attach(plugin);
    plugins.attach(editor.plugin);
    handle.setPitchRange(pitches);
    listen(viewport, "scroll", render);
    if (options.onNoteAdd || options.onNoteDelete)
      listen(surface, "dblclick", (raw) => {
        const event = raw as MouseEvent;
        // Pointer capture retargets a real double-click to the surface, and custom renderers have no note elements, so hit-test by position.
        const pitch = pitchAtY(event.clientY);
        const beat = beatAtX(event.clientX);
        // What is drawn on top wins; a custom renderer without note elements falls back to the latest note under the pointer.
        const drawn = surface.ownerDocument
          .elementsFromPoint(event.clientX, event.clientY)
          .map((element) => (element as HTMLElement).dataset?.noteId)
          .find((id) => id !== undefined);
        const existing =
          state.notes.find((note) => note.id === drawn) ??
          state.notes.findLast((note) => note.pitch === pitch && note.start <= beat && beat < note.start + note.duration);
        if (existing) {
          activeNoteId = undefined;
          if (options.onNoteDelete) commitNote("delete", () => options.onNoteDelete!(existing));
          return;
        }
        if (!options.onNoteAdd || !state.duration || !scale) return;
        const start = Math.min(gridStart(beatAtX(event.clientX)), Math.max(0, state.duration - MIN_NOTE_BEATS));
        const added = Object.freeze({
          pitch: pitchAtY(event.clientY),
          start,
          duration: Math.min(1, state.duration - start),
          velocity: DEFAULT_VELOCITY,
        });
        commitNote("add", () => options.onNoteAdd!(added));
      });
    // A press on a note stops at the note; one that reaches the surface is on empty space.
    listen(surface, "pointerdown", () => {
      if (activeNoteId === undefined) return;
      activeNoteId = undefined;
      drawVelocity();
    });
    if (options.onNoteDelete)
      listen(viewport, "keydown", (raw) => {
        const event = raw as KeyboardEvent;
        if ((event.key !== "Delete" && event.key !== "Backspace") || event.defaultPrevented) return;
        const focused = ((event.target as Element | null)?.closest?.("[data-note-id]") as HTMLElement | null)?.dataset.noteId;
        const note = state.notes.find(({ id }) => id === (focused ?? activeNoteId));
        if (!note) return;
        // Handled here: the note's element is about to leave the DOM, so an app's own Delete shortcut must not also act on it.
        event.preventDefault();
        event.stopPropagation();
        activeNoteId = undefined;
        commitNote("delete", () => options.onNoteDelete!(note));
      });
    if (velocityLane && options.onNoteEdit) {
      listen(velocityLane, "pointerdown", (raw) => {
        const event = raw as PointerEvent;
        if (event.button !== 0 || velocityDrag || !scale) return;
        const beat = beatAtX(event.clientX);
        const px = event.clientX - velocityLane.getBoundingClientRect().left;
        const visible = state.notes.filter((note) => note.pitch >= pitches.low && note.pitch <= pitches.high);
        // Bars are matched by their drawn x (beat-0 bars are inset), so a handle is grabbed where it is seen.
        const dist = (note: MidiNote) => Math.abs(velocityX(note) - px);
        const candidates = visible.filter((note) => dist(note) <= VELOCITY_REACH);
        const nearest = candidates.length ? Math.min(...candidates.map(dist)) : undefined;
        const closest = candidates.filter((note) => dist(note) <= (nearest ?? 0) + 1e-9);
        // In a chord the bars overlap, so the active (last clicked or selected) note is the one being edited.
        let original: MidiNote | undefined = closest.find((note) => note.id === activeNoteId) ?? closest[0];
        original ??= visible.find((note) => note.start <= beat && beat < note.start + note.duration);
        if (!original) return;
        event.preventDefault();
        activeNoteId = original.id;
        velocityLane.setPointerCapture(event.pointerId);
        velocityDrag = { id: event.pointerId, original, preview: Object.freeze({ ...original, velocity: velocityAtY(event.clientY) }) };
        render();
      });
      listen(velocityLane, "pointermove", (raw) => {
        const event = raw as PointerEvent;
        if (velocityDrag?.id !== event.pointerId) return;
        velocityDrag.preview = Object.freeze({ ...velocityDrag.original, velocity: velocityAtY(event.clientY) });
        render();
      });
      listen(velocityLane, "pointerup", (raw) => {
        const event = raw as PointerEvent,
          drag = velocityDrag;
        if (drag?.id !== event.pointerId) return;
        const note = Object.freeze({ ...drag.original, velocity: velocityAtY(event.clientY) });
        velocityDrag = undefined;
        velocityLane.releasePointerCapture(drag.id);
        render();
        if (note.velocity !== drag.original.velocity)
          commitNote("edit", () => options.onNoteEdit!(Object.freeze({ kind: "velocity", previous: drag.original, note })));
      });
      for (const type of ["pointercancel", "lostpointercapture"])
        listen(velocityLane, type, (raw) => {
          if ((raw as PointerEvent).pointerId === velocityDrag?.id) cancelVelocity();
        });
      listen(surface.ownerDocument, "keydown", (raw) => {
        if ((raw as KeyboardEvent).key === "Escape" && velocityDrag) {
          raw.preventDefault();
          cancelVelocity();
        }
      });
      listen(window, "blur", cancelVelocity);
      listen(viewport, "keydown", (raw) => {
        const event = raw as KeyboardEvent;
        if ((event.key !== "ArrowUp" && event.key !== "ArrowDown") || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey)
          return;
        const focused = ((event.target as Element | null)?.closest?.("[data-note-id]") as HTMLElement | null)?.dataset.noteId;
        const previous = state.notes.find(({ id }) => id === (focused ?? activeNoteId));
        if (!previous) return;
        event.preventDefault();
        activeNoteId = previous.id;
        const step = (event.shiftKey ? 10 : 1) * (event.key === "ArrowUp" ? 1 : -1);
        const velocity = clamp(Math.round(previous.velocity * 127) + step, 1, 127) / 127;
        if (velocity === previous.velocity) return;
        const note = Object.freeze({ ...previous, velocity });
        commitNote("edit", () => options.onNoteEdit!(Object.freeze({ kind: "velocity", previous, note })));
        drawVelocity();
      });
    }
    own(
      options.model.subscribe(() => {
        selection.value = options.model.getSelection();
        const next = options.model.getState(),
          dataChanged = next.notes !== state.notes || next.duration !== state.duration || next.window !== state.window;
        state = next;
        if (dataChanged) {
          cancelVelocity();
          for (const fn of [...dataListeners]) fn();
          layout();
        }
      }),
    );
    observer.observe(viewport);
    layout();
    return handle;
  } catch (error) {
    handle.dispose();
    throw error;
  }
}
