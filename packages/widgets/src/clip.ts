import { untracked, type PCMData } from "@audiorective/core";
import { summarizePeaks } from "@audiorective/core/peaks";
import { effect } from "./detached-effect";
import type { Peaks } from "./peaks";
import { defaultRenderer } from "./renderer";
import type { WaveformPeaks } from "./types";

/** Reusable arrangement clip gestures over caller-owned elements and project data. */
export type ArrangementTimeMap = Readonly<{
  secondsToBeat(seconds: number): number;
  beatToSeconds(beat: number): number;
  snapSeconds(seconds: number): number;
}>;

export type ClipMove = Readonly<{ clipId: string; trackId: string; time: number; kind: "pointer" | "keyboard" }>;

export type ClipGestureOptions = Readonly<{
  clipId: string;
  /** Tracked native origin; undefined disables/cancels. Position or track changes cancel stale previews. */
  origin(): Readonly<{ time: number; trackId: string }> | undefined;
  /** Unit of origin.time and onMove.time; default seconds. */
  timeUnit?: "seconds" | "beats";
  timeMap: ArrangementTimeMap;
  pixelsPerSecond(): number;
  /** Return a valid destination track at the pointer location, or undefined to keep the current track. */
  trackAt(clientX: number, clientY: number): string | undefined;
  onSelect(): void;
  onOpen(): void;
  /** Called once after a completed drag or keyboard nudge. The caller owns the edit and undo history. */
  onMove(move: ClipMove): void;
}>;

export interface ClipGestureHandle {
  dispose(): void;
}

/** Move caller-owned clip DOM; live origins and cancellation do not rebuild the caller's view. */
export function attachClipGesture(element: HTMLElement, options: ClipGestureOptions): ClipGestureHandle {
  type Origin = NonNullable<ReturnType<ClipGestureOptions["origin"]>>;
  let drag: { pointerId: number; startX: number; moved: boolean; origin: Origin; seconds: number; left: string; previewLeft?: string } | undefined;
  let disposed = false;
  const toSeconds = (time: number) => (options.timeUnit === "beats" ? options.timeMap.beatToSeconds(time) : time);
  const fromSeconds = (seconds: number) => (options.timeUnit === "beats" ? options.timeMap.secondsToBeat(seconds) : seconds);
  const origin = () => {
    const value = options.origin();
    return value && Number.isFinite(value.time) && value.time >= 0 ? value : undefined;
  };
  const cleanup = (replacement?: Origin, replaced = false) => {
    const previous = drag;
    drag = undefined;
    doc.removeEventListener("keydown", escape, true);
    if (previous?.moved && element.style.left === previous.previewLeft) {
      element.style.left = replaced && replacement ? `${toSeconds(replacement.time) * options.pixelsPerSecond()}px` : previous.left;
    }
    element.classList.remove("dragging");
    if (previous && element.hasPointerCapture(previous.pointerId)) element.releasePointerCapture(previous.pointerId);
  };
  const stopOrigin = untracked(() =>
    effect(() => {
      const value = origin();
      if (drag && (!value || value.time !== drag.origin.time || value.trackId !== drag.origin.trackId)) untracked(() => cleanup(value, true));
    }),
  );
  const candidate = (x: number, alt: boolean) => {
    const seconds = Math.max(0, drag!.seconds + (x - drag!.startX) / options.pixelsPerSecond());
    return alt ? seconds : options.timeMap.snapSeconds(seconds);
  };
  const down = (event: PointerEvent) => {
    if (disposed || event.button !== 0 || drag || !origin()) return;
    event.preventDefault();
    event.stopPropagation();
    options.onSelect();
    if (disposed || !origin()) return;
    element.focus({ preventScroll: true });
    const current = origin();
    if (disposed || !current || !element.isConnected) return;
    const seconds = toSeconds(current.time);
    if (!Number.isFinite(seconds)) return;
    element.setPointerCapture(event.pointerId);
    drag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      moved: false,
      origin: { time: current.time, trackId: current.trackId },
      seconds,
      left: element.style.left,
    };
    doc.addEventListener("keydown", escape, true);
  };
  const move = (event: PointerEvent) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    if (Math.abs(event.clientX - drag.startX) > 3) drag.moved = true;
    if (!drag.moved) return;
    const seconds = candidate(event.clientX, event.altKey);
    if (!Number.isFinite(seconds)) return;
    drag.previewLeft = `${seconds * options.pixelsPerSecond()}px`;
    element.classList.add("dragging");
    element.style.left = drag.previewLeft;
  };
  const up = (event: PointerEvent) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const previous = drag;
    const moved = previous.moved || Math.abs(event.clientX - previous.startX) > 3;
    const seconds = candidate(event.clientX, event.altKey);
    const trackId = options.trackAt(event.clientX, event.clientY) ?? previous.origin.trackId;
    cleanup();
    if (!Number.isFinite(seconds)) return;
    if (moved && (seconds !== previous.seconds || trackId !== previous.origin.trackId))
      options.onMove({ clipId: options.clipId, trackId, time: fromSeconds(seconds), kind: "pointer" });
    else options.onOpen();
  };
  const cancel = (event: PointerEvent) => {
    if (drag?.pointerId === event.pointerId) cleanup();
  };
  const escape = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || !drag) return;
    event.preventDefault();
    event.stopPropagation();
    cleanup();
  };
  const keydown = (event: KeyboardEvent) => {
    if (disposed) return;
    const current = origin();
    if (!current) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      event.stopPropagation();
      options.onSelect();
      if (!disposed && origin()) options.onOpen();
      return;
    }
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    event.stopPropagation();
    cleanup();
    options.onSelect();
    const accepted = origin();
    if (disposed || !accepted) return;
    const delta = (event.key === "ArrowLeft" ? -1 : 1) * (event.shiftKey ? 4 : 1);
    const beat = Math.max(0, options.timeMap.secondsToBeat(toSeconds(accepted.time)) + delta);
    const time = fromSeconds(options.timeMap.beatToSeconds(beat));
    if (Number.isFinite(time) && time !== accepted.time)
      options.onMove({ clipId: options.clipId, trackId: accepted.trackId, time, kind: "keyboard" });
  };
  const doc = element.ownerDocument;
  element.addEventListener("pointerdown", down);
  element.addEventListener("pointermove", move);
  element.addEventListener("pointerup", up);
  element.addEventListener("pointercancel", cancel);
  element.addEventListener("lostpointercapture", cancel);
  element.addEventListener("keydown", keydown);
  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      stopOrigin();
      cleanup();
      doc.removeEventListener("keydown", escape, true);
      element.removeEventListener("pointerdown", down);
      element.removeEventListener("pointermove", move);
      element.removeEventListener("pointerup", up);
      element.removeEventListener("pointercancel", cancel);
      element.removeEventListener("lostpointercapture", cancel);
      element.removeEventListener("keydown", keydown);
    },
  };
}

/** Audio a clip waveform draws: the recording as PCM or as precomputed peaks (the shape `mountWaveform` takes), plus the played window. */
export type ClipWaveformSource = Readonly<{
  /** Audio that covers the window: PCM, or min/max peaks over `data.duration` seconds. */
  data: PCMData | WaveformPeaks;
  /** Seconds into `data` where the played window starts. A project clip's `channels` (or its `media.peaks(...)` of the clip's window) already begin at the window, so pass 0 there. */
  sourceOffset: number;
  /** Seconds of `data` that the clip plays, starting at `sourceOffset`. */
  duration: number;
}>;

export type ClipWaveformOptions = Readonly<{
  /** Tracked; the waveform redraws when the returned source (or anything the getter reads) changes. Undefined clears the drawing. */
  clip(): ClipWaveformSource | undefined;
}>;

const clipWaveformStyles = `
.ar-clip-waveform { --ar-accent:var(--waveform-accent,#3c99ff); position:absolute; inset:0; overflow:hidden; pointer-events:none; }
.ar-clip-waveform svg { display:block; width:100%; height:100%; }
.ar-clip-waveform .ar-peaks { stroke:var(--ar-accent); stroke-width:1; vector-effect:non-scaling-stroke; opacity:.8; }
.ar-clip-waveform .ar-center { stroke:var(--waveform-border,#344154); stroke-width:1; vector-effect:non-scaling-stroke; }
`;

const summaries = new WeakMap<Float32Array, Peaks & { framesPerPeak: number }>();
const SUMMARY_FRAMES = 128;

/** Min/max per column over `[offset, offset + duration)` of the data; zero where the window leaves the data. Baseline 0 is always included, like `peakPath`. */
function windowColumns(data: ClipWaveformSource["data"], offset: number, duration: number, columns: number): Peaks {
  const min = new Float32Array(columns);
  const max = new Float32Array(columns);
  const fromBins = (bins: { min: Float32Array; max: Float32Array }, binSeconds: number) => {
    const count = bins.min.length;
    for (let c = 0; c < columns; c++) {
      const first = Math.max(0, Math.floor((offset + (duration * c) / columns) / binSeconds));
      const last = Math.min(count, Math.max(first + 1, Math.ceil((offset + (duration * (c + 1)) / columns) / binSeconds)));
      let lo = 0,
        hi = 0;
      for (let i = first; i < last; i++) {
        lo = Math.min(lo, bins.min[i]);
        hi = Math.max(hi, bins.max[i]);
      }
      min[c] = lo;
      max[c] = hi;
    }
  };
  if ("channels" in data) {
    const rate = data.sampleRate;
    const frames = data.channels[0]?.length ?? 0;
    if ((duration * rate) / columns >= SUMMARY_FRAMES * 2) {
      let cached = summaries.get(data.channels[0]);
      if (!cached) {
        const summary = summarizePeaks(data, { framesPerPeak: SUMMARY_FRAMES });
        summaries.set(data.channels[0], (cached = { min: summary.min, max: summary.max, duration: summary.duration, framesPerPeak: SUMMARY_FRAMES }));
      }
      fromBins(cached, SUMMARY_FRAMES / rate);
    } else {
      for (let c = 0; c < columns; c++) {
        const first = Math.max(0, Math.floor((offset + (duration * c) / columns) * rate));
        const last = Math.min(frames, Math.max(first + 1, Math.ceil((offset + (duration * (c + 1)) / columns) * rate)));
        let lo = 0,
          hi = 0;
        for (const channel of data.channels) {
          for (let i = first; i < last; i++) {
            const sample = channel[i];
            if (sample < lo) lo = sample;
            if (sample > hi) hi = sample;
          }
        }
        min[c] = lo;
        max[c] = hi;
      }
    }
  } else fromBins(data, data.duration / Math.max(1, data.min.length));
  return { min, max, duration };
}

/**
 * Draw only the played window of a clip's audio into a timeline clip element: no toolbar, ruler or padding, filling the element and
 * redrawing when the tracked source or the element's size changes. Colors come from the `--waveform-accent` and `--waveform-border` CSS variables.
 */
export function attachClipWaveform(element: HTMLElement, options: ClipWaveformOptions): ClipWaveformHandle {
  const container = element.ownerDocument.createElement("div");
  container.className = "ar-clip-waveform";
  container.setAttribute("aria-hidden", "true");
  const style = element.ownerDocument.createElement("style");
  style.textContent = clipWaveformStyles;
  container.append(style);
  const drawing = element.ownerDocument.createElement("div");
  drawing.style.cssText = "position:absolute;inset:0";
  container.append(drawing);
  const positioned = element.ownerDocument.defaultView?.getComputedStyle(element).position !== "static";
  if (!positioned) element.style.position = "relative";
  element.prepend(container);
  const renderer = defaultRenderer(drawing);
  let source: ClipWaveformSource | undefined;
  let disposed = false;
  const draw = () => {
    if (disposed) return;
    const ratio = element.ownerDocument.defaultView?.devicePixelRatio || 1;
    const width = Math.round(container.clientWidth * ratio);
    const height = Math.round(container.clientHeight * ratio);
    const valid =
      source && width > 0 && height > 0 && Number.isFinite(source.sourceOffset) && Number.isFinite(source.duration) && source.duration > 0;
    renderer.render(
      Object.freeze({
        peaks: valid ? windowColumns(source!.data, source!.sourceOffset, source!.duration, width) : null,
        width: Math.max(1, width),
        height: Math.max(1, height),
        pixelsPerSecond: valid ? width / source!.duration : 1,
        amplitudeZoom: 1,
      }),
    );
  };
  const resize = new ResizeObserver(draw);
  resize.observe(container);
  const stop = effect(() => {
    source = options.clip();
    untracked(draw);
  });
  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      stop();
      resize.disconnect();
      renderer.dispose?.();
      container.remove();
      if (!positioned) element.style.position = "";
    },
  };
}

export interface ClipWaveformHandle {
  dispose(): void;
}

export type ClipTrimEdge = "start" | "end";

export type ClipTrimOptions = Readonly<{
  /** Tracked origin of the clip on the timeline, in `timeUnit`; undefined disables trimming and cancels a drag. A changed origin cancels a stale drag. */
  origin(): Readonly<{ time: number; duration: number }> | undefined;
  /** Unit of origin, snap, bounds and the committed edges; default seconds. */
  timeUnit?: "seconds" | "beats";
  timeMap: ArrangementTimeMap;
  pixelsPerSecond(): number;
  /** Edges that get a handle; default both. */
  edges?: readonly ClipTrimEdge[];
  /** Round a candidate edge position (in `timeUnit`) to the grid, e.g. `project.tempoMap.snapSeconds`. Alt bypasses it while dragging. */
  snap?(time: number): number;
  /** Limits for the edges in `timeUnit`, such as the recording's extent for audio. Read at the start of each drag or key press. */
  bounds?(): Readonly<{ start?: number; end?: number }>;
  /** Called once with the edges that changed, as absolute timeline positions in `timeUnit`: the shape `project.resizeClip` takes. */
  onCommit(edges: Readonly<{ start?: number; end?: number }>): void;
}>;

const clipTrimStyles = `
.ar-clip-trim { position:absolute; top:0; bottom:0; width:max(2px,min(var(--ar-clip-trim-size,6px),33.333%)); z-index:2; cursor:ew-resize; touch-action:none; background:transparent; outline-offset:-2px; }
.ar-clip-trim-start { left:0; }
.ar-clip-trim-end { right:0; }
.ar-clip-trim:hover,.ar-clip-trim:focus-visible,.ar-clip-trim.dragging { background:var(--waveform-accent,#3c99ff); opacity:.6; }
`;

/**
 * Trim a timeline clip from its edges. Adds a pointer/keyboard handle to each edge of `element` (classes `ar-clip-trim`,
 * `ar-clip-trim-start`/`-end`), previews by adjusting the element's left and width, and reports one `onCommit` per finished edit. Works on the
 * same element as `attachClipGesture`: edge drags never start a move.
 */
export function attachClipTrim(element: HTMLElement, options: ClipTrimOptions): ClipTrimHandle {
  const doc = element.ownerDocument;
  const toSeconds = (time: number) => (options.timeUnit === "beats" ? options.timeMap.beatToSeconds(time) : time);
  const fromSeconds = (seconds: number) => (options.timeUnit === "beats" ? options.timeMap.secondsToBeat(seconds) : seconds);
  const origin = () => {
    const value = options.origin();
    return value && Number.isFinite(value.time) && Number.isFinite(value.duration) && value.time >= 0 && value.duration > 0 ? value : undefined;
  };
  type Drag = {
    pointerId: number;
    edge: ClipTrimEdge;
    handle: HTMLElement;
    startX: number;
    moved: boolean;
    time: number;
    duration: number;
    start: number;
    end: number;
    left: string;
    width: string;
    preview?: { left: string; width: string };
    result?: Partial<Record<ClipTrimEdge, number>>;
  };
  let drag: Drag | undefined;
  let disposed = false;
  const style = doc.createElement("style");
  style.textContent = clipTrimStyles;
  element.append(style);
  const edges = options.edges ?? ["start", "end"];
  const handles = new Map<ClipTrimEdge, HTMLElement>();

  /** Seconds positions of the clip's edges from `origin`. */
  const spanOf = (value: { time: number; duration: number }) => ({ start: toSeconds(value.time), end: toSeconds(value.time + value.duration) });
  /** Resolve a dragged edge to a valid position in seconds, or undefined when no valid position exists. */
  const resolve = (edge: ClipTrimEdge, seconds: number, span: { start: number; end: number }, snap: boolean): number | undefined => {
    let unit = fromSeconds(seconds);
    if (snap && options.snap) unit = options.snap(unit);
    const bounds = options.bounds?.() ?? {};
    if (bounds.start !== undefined) unit = Math.max(unit, bounds.start);
    if (bounds.end !== undefined) unit = Math.min(unit, bounds.end);
    unit = Math.max(unit, 0);
    let value = toSeconds(unit);
    const minimum = 1 / Math.max(options.pixelsPerSecond(), 1e-6);
    value = edge === "start" ? Math.min(value, span.end - minimum) : Math.max(value, span.start + minimum);
    return Number.isFinite(value) ? value : undefined;
  };
  const commit = (edge: ClipTrimEdge, seconds: number, current: { time: number; duration: number }) => {
    const unit = fromSeconds(seconds);
    const before = edge === "start" ? current.time : current.time + current.duration;
    if (!Number.isFinite(unit) || Math.abs(unit - before) < 1e-9) return;
    options.onCommit(edge === "start" ? { start: unit } : { end: unit });
  };
  const restore = (previous: Drag) => {
    if (previous.preview && element.style.left === previous.preview.left && element.style.width === previous.preview.width) {
      element.style.left = previous.left;
      element.style.width = previous.width;
    }
  };
  const cleanup = () => {
    const previous = drag;
    drag = undefined;
    doc.removeEventListener("keydown", escape, true);
    if (!previous) return;
    restore(previous);
    element.classList.remove("dragging");
    previous.handle.classList.remove("dragging");
    if (previous.handle.hasPointerCapture(previous.pointerId)) previous.handle.releasePointerCapture(previous.pointerId);
  };
  const stopOrigin = untracked(() =>
    effect(() => {
      const value = origin();
      if (drag && (!value || value.time !== drag.time || value.duration !== drag.duration)) untracked(cleanup);
    }),
  );
  const candidate = (event: PointerEvent): number | undefined => {
    const { edge, start, end } = drag!;
    const base = edge === "start" ? start : end;
    return resolve(edge, base + (event.clientX - drag!.startX) / options.pixelsPerSecond(), { start, end }, !event.altKey);
  };
  const escape = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || !drag) return;
    event.preventDefault();
    event.stopPropagation();
    cleanup();
  };

  const build = (edge: ClipTrimEdge) => {
    const handle = doc.createElement("div");
    handle.className = `ar-clip-trim ar-clip-trim-${edge}`;
    handle.tabIndex = 0;
    handle.setAttribute("role", "separator");
    handle.setAttribute("aria-orientation", "vertical");
    handle.setAttribute("aria-label", edge === "start" ? "Trim clip start" : "Trim clip end");
    handle.dataset.edge = edge;
    handle.addEventListener("pointerdown", (event) => {
      if (disposed || event.button !== 0 || drag) return;
      const current = origin();
      if (!current) return;
      event.preventDefault();
      event.stopPropagation();
      const span = spanOf(current);
      if (!Number.isFinite(span.start) || !Number.isFinite(span.end)) return;
      handle.setPointerCapture(event.pointerId);
      drag = {
        pointerId: event.pointerId,
        edge,
        handle,
        startX: event.clientX,
        moved: false,
        time: current.time,
        duration: current.duration,
        ...span,
        left: element.style.left,
        width: element.style.width,
      };
      doc.addEventListener("keydown", escape, true);
    });
    handle.addEventListener("pointermove", (event) => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      event.stopPropagation();
      if (Math.abs(event.clientX - drag.startX) > 3) drag.moved = true;
      if (!drag.moved) return;
      const seconds = candidate(event);
      if (seconds === undefined) return;
      const pps = options.pixelsPerSecond();
      const start = drag.edge === "start" ? seconds : drag.start;
      const end = drag.edge === "end" ? seconds : drag.end;
      drag.preview = { left: `${start * pps}px`, width: `${(end - start) * pps}px` };
      element.classList.add("dragging");
      handle.classList.add("dragging");
      element.style.left = drag.preview.left;
      element.style.width = drag.preview.width;
    });
    handle.addEventListener("pointerup", (event) => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      event.stopPropagation();
      const previous = drag;
      const seconds = previous.moved || Math.abs(event.clientX - previous.startX) > 3 ? candidate(event) : undefined;
      cleanup();
      if (seconds !== undefined) commit(previous.edge, seconds, { time: previous.time, duration: previous.duration });
    });
    const cancel = (event: PointerEvent) => {
      if (drag?.pointerId === event.pointerId) cleanup();
    };
    handle.addEventListener("pointercancel", cancel);
    handle.addEventListener("lostpointercapture", cancel);
    handle.addEventListener("keydown", (event) => {
      if (disposed) return;
      // Enter and Space belong to the clip gesture on the same element; the handle must not trigger them.
      if (event.key === "Enter" || event.key === " ") {
        event.stopPropagation();
        return;
      }
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      event.stopPropagation();
      cleanup();
      const current = origin();
      if (!current) return;
      const span = spanOf(current);
      const direction = event.key === "ArrowLeft" ? -1 : 1;
      let seconds = edge === "start" ? span.start : span.end;
      // Each step goes to the next snap position; without a snap it is 4 px. Shift takes four steps.
      for (let n = 0; n < (event.shiftKey ? 4 : 1); n++) {
        let size = 4 / options.pixelsPerSecond();
        let next = seconds + direction * size;
        for (let tries = 0; tries < 24 && options.snap; tries++) {
          const snapped = toSeconds(options.snap(fromSeconds(next)));
          if (direction * (snapped - seconds) > 1e-9) {
            next = snapped;
            break;
          }
          size *= 2;
          next = seconds + direction * size;
        }
        seconds = next;
      }
      const resolved = resolve(edge, seconds, span, false);
      if (resolved !== undefined) commit(edge, resolved, current);
    });
    element.append(handle);
    handles.set(edge, handle);
  };
  for (const edge of edges) build(edge);
  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      stopOrigin();
      cleanup();
      for (const handle of handles.values()) handle.remove();
      style.remove();
    },
  };
}

export interface ClipTrimHandle {
  dispose(): void;
}
