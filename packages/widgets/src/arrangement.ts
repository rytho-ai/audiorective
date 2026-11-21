import { effect, untracked } from "@audiorective/core";

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

export type TimelineZoomOptions = Readonly<{
  viewport: HTMLElement;
  /** The time-axis element inside the viewport; it may be replaced during onScale. */
  ruler(): HTMLElement | null;
  /** Tracked pixels per second; external changes synchronize the native slider and cancel pending zoom. */
  getScale(): number;
  onScale(pixelsPerSecond: number): void;
  slider?: HTMLInputElement;
  minScale?: number;
  maxScale?: number;
  /** Slider text for the current scale. Default: "<n> px/s". */
  labels?: Partial<{ scale(pixelsPerSecond: number): string }>;
}>;

export interface TimelineZoomHandle {
  zoomTo(pixelsPerSecond: number, clientX?: number): void;
  zoomBy(factor: number, clientX?: number): void;
  cancel(): void;
  dispose(): void;
}

export type TimelineRange = readonly [start: number, end: number];

export type TimeRangeGestureOptions = Readonly<{
  /** Map pointer X to project time, including any duration limits and grid snapping. */
  timeAt(clientX: number, bypassSnap: boolean): number;
  onPreview(range: TimelineRange | undefined): void;
  onSelect(range: TimelineRange): void;
}>;

/** Select a nonempty interval, with an ordered preview regardless of drag direction. */
export function attachTimeRangeGesture(element: HTMLElement, options: TimeRangeGestureOptions): ClipGestureHandle {
  let drag: { pointerId: number; startX: number; time: number } | undefined;
  let disposed = false;
  const candidate = (event: PointerEvent): TimelineRange | undefined => {
    if (!drag || Math.abs(event.clientX - drag.startX) <= 3) return;
    const from = drag.time;
    const to = options.timeAt(event.clientX, event.altKey);
    if (Number.isFinite(from) && Number.isFinite(to) && from !== to) return [Math.min(from, to), Math.max(from, to)];
  };
  const clear = () => {
    if (!drag) return;
    const { pointerId } = drag;
    drag = undefined;
    if (element.hasPointerCapture(pointerId)) element.releasePointerCapture(pointerId);
    options.onPreview(undefined);
  };
  const down = (event: PointerEvent) => {
    if (disposed || event.button !== 0 || drag) return;
    event.preventDefault();
    element.setPointerCapture(event.pointerId);
    drag = { pointerId: event.pointerId, startX: event.clientX, time: options.timeAt(event.clientX, event.altKey) };
  };
  const move = (event: PointerEvent) => {
    if (drag?.pointerId === event.pointerId) options.onPreview(candidate(event));
  };
  const up = (event: PointerEvent) => {
    if (drag?.pointerId !== event.pointerId) return;
    const range = candidate(event);
    clear();
    if (range) options.onSelect(range);
  };
  const cancel = (event: PointerEvent) => {
    if (drag?.pointerId === event.pointerId) clear();
  };
  const escape = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || !drag) return;
    event.preventDefault();
    event.stopPropagation();
    clear();
  };
  const doc = element.ownerDocument;
  doc.addEventListener("keydown", escape, true);
  element.addEventListener("pointerdown", down);
  element.addEventListener("pointermove", move);
  element.addEventListener("pointerup", up);
  element.addEventListener("pointercancel", cancel);
  element.addEventListener("lostpointercapture", cancel);
  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      clear();
      doc.removeEventListener("keydown", escape, true);
      element.removeEventListener("pointerdown", down);
      element.removeEventListener("pointermove", move);
      element.removeEventListener("pointerup", up);
      element.removeEventListener("pointercancel", cancel);
      element.removeEventListener("lostpointercapture", cancel);
    },
  };
}

/** Continuous time-axis zoom with pointer anchoring and one redraw per animation frame. */
export function attachTimelineZoom(options: TimelineZoomOptions): TimelineZoomHandle {
  const { viewport, slider } = options;
  const minimum = options.minScale ?? 2;
  const maximum = options.maxScale ?? 2000;
  if (!Number.isFinite(minimum) || !Number.isFinite(maximum) || minimum <= 0 || maximum <= minimum)
    throw new RangeError("Timeline zoom needs a positive increasing scale range.");
  let pending: { scale: number; time: number; x: number } | undefined;
  let frame: number | undefined;
  let disposed = false;
  const clamp = (value: number) => Math.max(minimum, Math.min(maximum, value));
  const sliderBounds = () => {
    const min = slider ? Number.parseFloat(slider.min) : NaN;
    const max = slider ? Number.parseFloat(slider.max) : NaN;
    return { min: Number.isFinite(min) ? min : 0, max: Number.isFinite(max) ? max : 100 };
  };
  const sync = (scale: number) => {
    if (!slider) return;
    const bounds = sliderBounds();
    const fraction = Math.log(clamp(scale) / minimum) / Math.log(maximum / minimum);
    slider.value = String(bounds.min + fraction * Math.max(0, bounds.max - bounds.min));
    slider.setAttribute("aria-valuetext", (options.labels?.scale ?? ((scale: number) => `${Math.round(scale)} px/s`))(scale));
  };
  let applying = false;
  const cancel = () => {
    if (frame !== undefined) cancelAnimationFrame(frame);
    frame = undefined;
    pending = undefined;
  };
  const zoomTo = (scale: number, clientX?: number) => {
    if (disposed || !Number.isFinite(scale)) return;
    const ruler = options.ruler();
    if (!ruler) return;
    const x = clientX ?? viewport.getBoundingClientRect().left + viewport.clientWidth / 2;
    const time = Math.max(0, (x - ruler.getBoundingClientRect().left) / options.getScale());
    pending = { scale: clamp(scale), time, x };
    if (frame !== undefined) return;
    frame = requestAnimationFrame(() => {
      frame = undefined;
      const zoom = pending;
      pending = undefined;
      if (!zoom || disposed) return;
      applying = true;
      try {
        options.onScale(zoom.scale);
      } finally {
        applying = false;
      }
      const nextRuler = options.ruler();
      if (nextRuler) viewport.scrollLeft += nextRuler.getBoundingClientRect().left + zoom.time * options.getScale() - zoom.x;
      sync(options.getScale());
    });
  };
  const zoomBy = (factor: number, clientX?: number) => {
    if (Number.isFinite(factor) && factor > 0) zoomTo((pending?.scale ?? options.getScale()) * factor, clientX);
  };
  const onSlider = () => {
    if (!slider) return;
    const bounds = sliderBounds();
    const span = bounds.max - bounds.min;
    if (span > 0) zoomTo(minimum * Math.pow(maximum / minimum, (slider.valueAsNumber - bounds.min) / span));
  };
  const onWheel = (event: WheelEvent) => {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    zoomBy(Math.exp(-event.deltaY * 0.002), event.clientX);
  };
  slider?.addEventListener("input", onSlider);
  viewport.addEventListener("wheel", onWheel, { passive: false });
  let observedScale: number | undefined;
  const stopScale = untracked(() =>
    effect(() => {
      const scale = options.getScale();
      const previous = observedScale;
      observedScale = scale;
      untracked(() => {
        if (!applying && previous !== undefined && scale !== previous) cancel();
        sync(scale);
      });
    }),
  );
  return {
    zoomTo,
    zoomBy,
    cancel,
    dispose() {
      if (disposed) return;
      disposed = true;
      stopScale();
      cancel();
      slider?.removeEventListener("input", onSlider);
      viewport.removeEventListener("wheel", onWheel);
    },
  };
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
  doc.addEventListener("keydown", escape, true);
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
