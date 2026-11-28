import { untracked } from "@audiorective/core";
import { effect } from "./detached-effect";

/** The beat-to-seconds functions of a tempo map: any object with these two methods, such as `{ beatToSeconds: (b) => (b * 60) / bpm, secondsToBeat: (s) => (s * bpm) / 60 }`. */
export interface BarRulerTempoMap {
  /** Maps quarter-note project beats to project seconds, following tempo changes. */
  beatToSeconds(beat: number): number;
  /** Maps project seconds to quarter-note project beats, following tempo changes. */
  secondsToBeat(seconds: number): number;
}

export type BarRulerOptions = Readonly<{
  /** The tempo map, or a getter for it. Read in a core effect, so `() => song.tempoMap` redraws after a tempo edit. */
  tempoMap: BarRulerTempoMap | (() => BarRulerTempoMap);
  /** `[numerator, denominator]`, or a tracked getter for it. Default `[4, 4]`. Beats are quarter notes on the tempo map; a bar is `numerator * 4 / denominator` of them. */
  signature?: readonly [number, number] | (() => readonly [number, number]);
  /** Tracked pixels per second: the scale the arrangement is laid out at. */
  pixelsPerSecond(): number;
  /** Tracked length of the axis in seconds. The ruler element is `duration * pixelsPerSecond` pixels wide. */
  duration(): number;
  /** The scrolling element the ruler sits in. With it, only the visible bars (plus a margin) are drawn and a scroll or resize redraws them; without it every bar up to `duration` is drawn. */
  viewport?: HTMLElement;
  /** Tracked playhead position in seconds, or null to hide it. */
  playhead?(): number | null;
  /** A click (not a drag) on the ruler; receives the clicked time in seconds, unsnapped. Without it the ruler is not clickable. */
  onSeek?(seconds: number): void;
  /** Smallest distance in pixels between two bar labels; labels thin out by powers of two below it. Default 56. */
  minLabelSpacing?: number;
  /** Text of a bar label from its one-based bar number. Default: the number. */
  labels?: Partial<{
    /** Formats a 1-based bar number; defaults to the decimal number itself. */
    bar(bar: number): string;
  }>;
}>;

export interface BarRulerHandle {
  /** The ruler element (a child of `root`): pass it as `ruler()` to `attachTimelineZoom`. */
  readonly element: HTMLElement;
  /** Redraw now, for example after the viewport scrolled by script without a scroll event. */
  refresh(): void;
  /** Releases resources owned by this attachment or view; safe to call twice. */
  dispose(): void;
}

const MAX_BARS = 4000;
const BEAT_MIN_PX = 7;
const BAR_LINE_MIN_PX = 4;

const styles = `
.ar-bar-ruler { position:relative; height:var(--ar-ruler-height,28px); overflow:hidden; box-sizing:border-box; user-select:none; color:var(--ar-ruler-color,color-mix(in srgb,currentColor 70%,transparent)); background:var(--ar-ruler-background,transparent); border-bottom:1px solid var(--ar-ruler-line,color-mix(in srgb,currentColor 30%,transparent)); font:var(--ar-ruler-font,10px/1 system-ui,sans-serif); font-variant-numeric:tabular-nums; }
.ar-bar-ruler[data-seek=true] { cursor:pointer; }
.ar-bar-ruler-ticks { position:absolute; inset:0; pointer-events:none; }
.ar-bar-ruler-bar,.ar-bar-ruler-beat { position:absolute; top:0; border-left:1px solid var(--ar-ruler-line,color-mix(in srgb,currentColor 30%,transparent)); }
.ar-bar-ruler-bar { height:100%; padding:4px 0 0 4px; box-sizing:border-box; white-space:nowrap; border-left-color:var(--ar-ruler-bar-line,var(--ar-ruler-line,color-mix(in srgb,currentColor 55%,transparent))); }
.ar-bar-ruler-beat { bottom:0; top:auto; height:30%; border-left-color:var(--ar-ruler-beat-line,color-mix(in srgb,currentColor 22%,transparent)); }
.ar-bar-ruler-playhead { position:absolute; top:0; height:100%; width:2px; margin-left:-1px; background:var(--ar-ruler-playhead,var(--waveform-playhead,#e5484d)); pointer-events:none; }
`;

const isTempoMap = (value: unknown): value is BarRulerTempoMap =>
  !!value && typeof (value as BarRulerTempoMap).beatToSeconds === "function" && typeof (value as BarRulerTempoMap).secondsToBeat === "function";

function validSignature(value: readonly [number, number] | undefined): value is readonly [number, number] {
  return !!value && Number.isInteger(value[0]) && value[0] > 0 && Number.isInteger(value[1]) && value[1] > 0 && (value[1] & (value[1] - 1)) === 0;
}

/**
 * Bar and beat ruler for a tempo-mapped timeline: a bar line and number per bar, beat ticks when zoomed in, labels thinned by powers of two when zoomed out.
 * Read `tempoMap`, `signature`, `pixelsPerSecond`, `duration` and `playhead` in core effects, so tracked sources redraw it. Disposing leaves the borrowed sources alone.
 */
export function mountBarRuler(root: HTMLElement, options: BarRulerOptions): BarRulerHandle {
  const tempoOf = (): BarRulerTempoMap => (typeof options.tempoMap === "function" ? options.tempoMap() : options.tempoMap);
  const signatureOf = (): readonly [number, number] | undefined =>
    typeof options.signature === "function" ? options.signature() : (options.signature ?? [4, 4]);
  const scaleOk = (pps: number, duration: number) => Number.isFinite(pps) && pps > 0 && Number.isFinite(duration) && duration >= 0;
  untracked(() => {
    if (!isTempoMap(tempoOf())) throw new TypeError("Bar ruler needs a tempo map with beatToSeconds and secondsToBeat.");
    if (!validSignature(signatureOf()))
      throw new RangeError("Bar ruler needs a time signature with a positive integer numerator and a power-of-two denominator.");
    if (!scaleOk(options.pixelsPerSecond(), options.duration()))
      throw new RangeError("Bar ruler needs a positive finite scale and a finite non-negative duration.");
  });

  const doc = root.ownerDocument;
  const { viewport, onSeek } = options;
  const minSpacing = options.minLabelSpacing ?? 56;
  const labelOf = options.labels?.bar ?? ((bar: number) => String(bar));
  const element = doc.createElement("div");
  element.className = "ar-bar-ruler";
  element.setAttribute("role", "presentation");
  if (onSeek) element.dataset.seek = "true";
  const style = doc.createElement("style");
  style.textContent = styles;
  const ticks = doc.createElement("div");
  ticks.className = "ar-bar-ruler-ticks";
  const head = doc.createElement("div");
  head.className = "ar-bar-ruler-playhead";
  head.hidden = true;
  element.append(style, ticks, head);
  root.append(element);
  let disposed = false;

  function draw(): void {
    if (disposed) return;
    const tempo = tempoOf();
    const signature = signatureOf();
    const pps = options.pixelsPerSecond();
    const duration = options.duration();
    if (!isTempoMap(tempo) || !validSignature(signature) || !scaleOk(pps, duration)) {
      ticks.replaceChildren();
      return;
    }
    const [numerator, denominator] = signature;
    const beatLength = 4 / denominator;
    const barLength = numerator * beatLength;
    element.style.width = `${duration * pps}px`;
    let from = 0;
    let to = duration;
    if (viewport) {
      const offset = element.getBoundingClientRect().left - viewport.getBoundingClientRect().left + viewport.scrollLeft;
      const margin = viewport.clientWidth / 2;
      from = Math.max(0, (viewport.scrollLeft - offset - margin) / pps);
      to = Math.min(duration, (viewport.scrollLeft - offset + viewport.clientWidth + margin) / pps);
    }
    const fragment = doc.createDocumentFragment();
    if (to >= from) {
      const first = Math.max(0, Math.floor(tempo.secondsToBeat(from) / barLength));
      const last = Math.min(Math.ceil(tempo.secondsToBeat(to) / barLength), first + MAX_BARS);
      for (let bar = first; bar <= last; bar++) {
        const x = tempo.beatToSeconds(bar * barLength) * pps;
        if (x > duration * pps + 1) break;
        const width = tempo.beatToSeconds((bar + 1) * barLength) * pps - x;
        const stride = 2 ** Math.max(0, Math.ceil(Math.log2(minSpacing / Math.max(width, 1e-6))));
        const labelled = bar % stride === 0;
        if (width >= BAR_LINE_MIN_PX || labelled) {
          const line = doc.createElement("div");
          line.className = "ar-bar-ruler-bar";
          line.dataset.bar = String(bar + 1);
          line.style.left = `${x}px`;
          if (labelled) {
            line.dataset.labelled = "true";
            line.textContent = labelOf(bar + 1);
          }
          fragment.append(line);
        }
        if (width / numerator >= BEAT_MIN_PX) {
          for (let beat = 1; beat < numerator; beat++) {
            const tick = doc.createElement("div");
            tick.className = "ar-bar-ruler-beat";
            tick.dataset.bar = String(bar + 1);
            tick.dataset.beat = String(beat + 1);
            tick.style.left = `${tempo.beatToSeconds(bar * barLength + beat * beatLength) * pps}px`;
            fragment.append(tick);
          }
        }
      }
    }
    ticks.replaceChildren(fragment);
  }

  const stopDraw = effect(draw);
  const stopHead = effect(() => {
    const time = options.playhead?.() ?? null;
    const pps = options.pixelsPerSecond();
    untracked(() => {
      head.hidden = time === null || !Number.isFinite(time) || !Number.isFinite(pps);
      if (!head.hidden) head.style.left = `${time! * pps}px`;
    });
  });

  const redraw = () => untracked(draw);
  viewport?.addEventListener("scroll", redraw, { passive: true });
  const observer = viewport && typeof ResizeObserver !== "undefined" ? new ResizeObserver(redraw) : undefined;
  if (viewport) observer?.observe(viewport);

  let press: { pointerId: number; x: number } | undefined;
  const down = (event: PointerEvent) => {
    if (event.button === 0) press = { pointerId: event.pointerId, x: event.clientX };
  };
  const up = (event: PointerEvent) => {
    const start = press;
    press = undefined;
    if (disposed || !start || start.pointerId !== event.pointerId || Math.abs(event.clientX - start.x) > 3) return;
    const pps = untracked(options.pixelsPerSecond);
    const duration = untracked(options.duration);
    const seconds = (event.clientX - element.getBoundingClientRect().left) / pps;
    if (Number.isFinite(seconds)) onSeek?.(Math.max(0, Math.min(duration, seconds)));
  };
  const cancel = () => {
    press = undefined;
  };
  if (onSeek) {
    element.addEventListener("pointerdown", down);
    element.addEventListener("pointerup", up);
    element.addEventListener("pointercancel", cancel);
  }

  return {
    element,
    refresh: redraw,
    dispose() {
      if (disposed) return;
      disposed = true;
      stopDraw();
      stopHead();
      viewport?.removeEventListener("scroll", redraw);
      observer?.disconnect();
      element.removeEventListener("pointerdown", down);
      element.removeEventListener("pointerup", up);
      element.removeEventListener("pointercancel", cancel);
      element.remove();
    },
  };
}
