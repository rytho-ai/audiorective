/** Reusable arrangement clip gestures over caller-owned elements and project data. */
export type ArrangementTimeMap = Readonly<{
  secondsToBeat(seconds: number): number;
  beatToSeconds(beat: number): number;
  snapSeconds(seconds: number): number;
}>;

export type ClipMove = Readonly<{ clipId: string; trackId: string; time: number; kind: "pointer" | "keyboard" }>;

export type ClipGestureOptions = Readonly<{
  clipId: string;
  trackId: string;
  /** Native clip position. onMove returns the same unit. Default: seconds. */
  time: number;
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
    if (event.button !== 0 || drag) return;
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
  element.addEventListener("pointerdown", down);
  element.addEventListener("pointermove", move);
  element.addEventListener("pointerup", up);
  element.addEventListener("pointercancel", cancel);
  element.addEventListener("lostpointercapture", cancel);
  return {
    dispose() {
      clear();
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
  const sync = () => {
    if (!slider) return;
    slider.value = String(Math.round((Math.log(options.getScale() / minimum) / Math.log(maximum / minimum)) * Number(slider.max)));
    slider.setAttribute("aria-valuetext", (options.labels?.scale ?? ((scale: number) => `${Math.round(scale)} px/s`))(options.getScale()));
  };
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
      options.onScale(zoom.scale);
      const nextRuler = options.ruler();
      if (nextRuler) viewport.scrollLeft += nextRuler.getBoundingClientRect().left + zoom.time * zoom.scale - zoom.x;
      sync();
    });
  };
  const zoomBy = (factor: number, clientX?: number) => {
    if (Number.isFinite(factor) && factor > 0) zoomTo((pending?.scale ?? options.getScale()) * factor, clientX);
  };
  const onSlider = () => {
    if (slider) zoomTo(minimum * Math.pow(maximum / minimum, Number(slider.value) / Number(slider.max)));
  };
  const onWheel = (event: WheelEvent) => {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    zoomBy(Math.exp(-event.deltaY * 0.002), event.clientX);
  };
  slider?.addEventListener("input", onSlider);
  viewport.addEventListener("wheel", onWheel, { passive: false });
  sync();
  return {
    zoomTo,
    zoomBy,
    cancel,
    dispose() {
      if (disposed) return;
      disposed = true;
      cancel();
      slider?.removeEventListener("input", onSlider);
      viewport.removeEventListener("wheel", onWheel);
    },
  };
}

/** Attach move/open behavior while the caller retains rendering and Project ownership. */
export function attachClipGesture(element: HTMLElement, options: ClipGestureOptions): ClipGestureHandle {
  let drag: { pointerId: number; startX: number; x: number; y: number; moved: boolean; time: number; left: string } | undefined;
  let disposed = false;
  const toSeconds = (time: number) => (options.timeUnit === "beats" ? options.timeMap.beatToSeconds(time) : time);
  const fromSeconds = (seconds: number) => (options.timeUnit === "beats" ? options.timeMap.secondsToBeat(seconds) : seconds);
  const startSeconds = toSeconds(options.time);

  const cleanup = () => {
    const pointerId = drag?.pointerId;
    // Only a drag moves the caller's element; give back what it had when the drag began.
    if (drag?.moved) element.style.left = drag.left;
    drag = undefined;
    element.classList.remove("dragging");
    if (pointerId !== undefined && element.hasPointerCapture(pointerId)) element.releasePointerCapture(pointerId);
  };
  const candidate = (x: number, alt: boolean) => {
    const seconds = Math.max(0, startSeconds + (x - drag!.startX) / options.pixelsPerSecond());
    return alt ? seconds : options.timeMap.snapSeconds(seconds);
  };
  const down = (event: PointerEvent) => {
    if (disposed || event.button !== 0 || drag) return;
    event.stopPropagation();
    options.onSelect();
    element.setPointerCapture(event.pointerId);
    drag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      x: event.clientX,
      y: event.clientY,
      moved: false,
      time: startSeconds,
      left: element.style.left,
    };
  };
  const move = (event: PointerEvent) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    drag.x = event.clientX;
    drag.y = event.clientY;
    if (Math.abs(event.clientX - drag.startX) > 3) drag.moved = true;
    if (!drag.moved) return;
    drag.time = candidate(event.clientX, event.altKey);
    element.classList.add("dragging");
    element.style.left = `${drag.time * options.pixelsPerSecond()}px`;
  };
  const up = (event: PointerEvent) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const wasMoved = drag.moved || Math.abs(event.clientX - drag.startX) > 3;
    const time = candidate(event.clientX, event.altKey);
    const trackId = options.trackAt(event.clientX, event.clientY) ?? options.trackId;
    cleanup();
    if (wasMoved && (time !== startSeconds || trackId !== options.trackId))
      options.onMove({ clipId: options.clipId, trackId, time: fromSeconds(time), kind: "pointer" });
    else options.onOpen();
  };
  const cancel = (event: PointerEvent) => {
    if (drag?.pointerId === event.pointerId) cleanup();
  };
  const keydown = (event: KeyboardEvent) => {
    if (disposed) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      event.stopPropagation();
      options.onSelect();
      options.onOpen();
      return;
    }
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    event.stopPropagation();
    options.onSelect();
    const delta = (event.key === "ArrowLeft" ? -1 : 1) * (event.shiftKey ? 4 : 1);
    const beat = Math.max(0, options.timeMap.secondsToBeat(startSeconds) + delta);
    const time = fromSeconds(options.timeMap.beatToSeconds(beat));
    if (time !== options.time) options.onMove({ clipId: options.clipId, trackId: options.trackId, time, kind: "keyboard" });
  };

  element.addEventListener("pointerdown", down);
  element.addEventListener("pointermove", move);
  element.addEventListener("pointerup", up);
  element.addEventListener("pointercancel", cancel);
  element.addEventListener("keydown", keydown);
  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      cleanup();
      element.removeEventListener("pointerdown", down);
      element.removeEventListener("pointermove", move);
      element.removeEventListener("pointerup", up);
      element.removeEventListener("pointercancel", cancel);
      element.removeEventListener("keydown", keydown);
    },
  };
}
