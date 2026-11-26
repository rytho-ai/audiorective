import { effect } from "alien-signals";
import { cell, readonlyCell, untracked, type ReadonlyCell } from "./Cell";
import type { BeatTiming, CancellableEvent } from "./contracts";
import type { AutomationCurve, AutomationPoint, AutomationTarget } from "./automation";

export interface AutomationClipOptions {
  /** Exclusive destination; use audioParamTarget(param.audioParam) for a schedulable parameter. */
  target: AutomationTarget;
  /** Repeat every `length` beats. Default false. */
  loop?: boolean;
  /** Positive beats; default the curve's last point time, following edits. A finite curve may have length 0. */
  length?: number;
  /** Aborting disposes the clip and detaches it from its clock. */
  signal?: AbortSignal;
}

/** Structural clock scheduler window; applications attach the clip instead of calling schedule. */
export interface AutomationClipWindow {
  beat: { start: number; end: number };
  /** `current`: the audio-context time of the tick, in seconds. */
  time: { current: number };
  own(event: CancellableEvent, when: number): void;
}

/** Structural Clock handle, so this pure module never imports a clock or constructs audio nodes. */
export interface AutomationClipTransport {
  readonly timeline: BeatTiming & { readonly now: number };
  refresh(): void;
  detach(): void;
}

type Owned = { end: number; listeners: Array<() => void> };
const MAX_SEGMENT_SECONDS = 0.001;

function position(points: readonly AutomationPoint[], time: number): number {
  let low = 0;
  let high = points.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (points[mid]!.time <= time) low = mid + 1;
    else high = mid;
  }
  return Math.max(0, low - 1);
}

function valueAt(points: readonly AutomationPoint[], time: number): number {
  const i = position(points, time);
  const a = points[i]!;
  const b = points[i + 1];
  if (time <= a.time || !b || a.shape === "hold") return a.value;
  return a.value + ((time - a.time) / (b.time - a.time)) * (b.value - a.value);
}

function shapeAt(points: readonly AutomationPoint[], time: number): AutomationPoint["shape"] {
  const i = position(points, time);
  return time < points[0]!.time || !points[i + 1] ? "hold" : points[i]!.shape;
}

/**
 * Automation points in beats, aligned with a Clock: `clock.attach(clip)` maps curve beat 0 to transport beat 0.
 * Follows live tempo and curve edits, including inside the look-ahead. Pause, stop, seek, detach and dispose
 * cancel queued automation while holding the target's actual current value. Resume/seek continue at the clock's
 * beat. Nonlinear beat/time mappings use linear segments no longer than 1 ms, with exact knots and loop seams.
 * One clip follows one clock at a time and borrows its exclusive target; dispose before the target.
 */
export class AutomationClip {
  readonly cells: Readonly<{ attached: ReadonlyCell<boolean> }>;
  private readonly attachedStore = cell(false);
  private readonly target: AutomationTarget;
  private readonly loop: boolean;
  private readonly length: number | undefined;
  private readonly signal: AbortSignal | undefined;
  private readonly stopWatching: () => void;
  private readonly owned = new Set<Owned>();
  private handle: AutomationClipTransport | undefined;
  private lastNow = 0;
  private programmed = false;
  private complete = false;
  private disposed = false;
  private readonly onAbort = () => this.dispose();

  constructor(
    /** The curve this clip plays; edits reprogram the running automation. */
    readonly curve: AutomationCurve,
    options: AutomationClipOptions,
  ) {
    this.target = options.target;
    this.loop = options.loop ?? false;
    this.length = options.length;
    if (!this.target || typeof this.target.program !== "function" || typeof this.target.hold !== "function")
      throw new TypeError("AutomationClip target needs program and hold methods.");
    if (this.length !== undefined && (!Number.isFinite(this.length) || this.length <= 0))
      throw new RangeError("AutomationClip length must be positive finite beats.");
    untracked(() => this.clipLength(curve.value));
    this.cells = Object.freeze({ attached: readonlyCell(this.attachedStore) });
    this.stopWatching = untracked(() =>
      effect(() => {
        const points = curve.value;
        untracked(() => {
          if (!this.handle || this.disposed) return;
          this.hold(this.now());
          this.clipLength(points);
          this.handle.refresh();
        });
      }),
    );
    this.signal = options.signal;
    if (this.signal?.aborted) this.dispose();
    else this.signal?.addEventListener("abort", this.onAbort, { once: true });
  }

  private clipLength(points: readonly AutomationPoint[]): number {
    const length = this.length ?? points.at(-1)!.time;
    if (this.loop && length <= 0) throw new RangeError("AutomationClip loop needs a positive length in beats.");
    return length;
  }

  private now(): number {
    return this.handle?.timeline.now ?? this.lastNow;
  }

  private finish(event: Owned): void {
    if (!this.owned.delete(event)) return;
    for (const listener of event.listeners.splice(0)) listener();
  }

  private hold(time: number): void {
    this.complete = false;
    try {
      if (this.programmed) {
        this.target.hold(time);
        this.programmed = time > this.now();
      }
    } finally {
      for (const event of [...this.owned]) this.finish(event);
    }
  }

  /** Clock scheduler contract; a single active transport owns the target timeline. */
  attached(handle: AutomationClipTransport): () => void {
    return untracked(() => {
      if (this.disposed) throw new Error("AutomationClip is disposed.");
      if (this.handle) throw new Error("AutomationClip is already attached to a clock.");
      this.handle = handle;
      this.complete = false;
      this.attachedStore.value = true;
      return () => this.clearHandle(handle);
    });
  }

  private clearHandle(handle: AutomationClipTransport): void {
    untracked(() => {
      if (this.handle !== handle) return;
      try {
        this.hold(this.now());
      } finally {
        this.lastNow = handle.timeline.now;
        this.handle = undefined;
        this.attachedStore.value = false;
      }
    });
  }

  /** Clock scheduler contract; applications use clock.attach(clip). */
  schedule(window: AutomationClipWindow, timing: BeatTiming): void {
    untracked(() => {
      if (this.disposed || !this.handle) return;
      const now = window.time.current;
      this.lastNow = now;
      for (const event of [...this.owned]) if (event.end <= now) this.finish(event);
      if (this.complete) return;
      const points = this.curve.value;
      const length = this.clipLength(points);
      const from = Math.max(0, window.beat.start, timing.timeToBeat(now));
      if (!(window.beat.end > from)) return;
      const to = this.loop ? window.beat.end : Math.min(window.beat.end, Math.max(from, length));
      const when = Math.max(now, timing.beatToTime(from));
      const values = this.points(points, timing, from, to, length);
      this.programmed = true;
      try {
        this.target.program(values, when);
      } catch (error) {
        try {
          this.hold(now);
        } catch {
          // Preserve a target's original scheduling error after best-effort cancellation.
        }
        throw error;
      }
      if (!this.loop && to >= length) this.complete = true;
      const event: Owned = { end: Math.max(when, timing.beatToTime(to)), listeners: [] };
      this.owned.add(event);
      window.own(
        {
          cancel: (time) => {
            if (this.owned.has(event)) this.hold(Math.max(time ?? this.now(), this.now()));
          },
          onEnded: (listener) => {
            if (this.owned.has(event)) event.listeners.push(listener);
            else listener();
          },
        },
        when,
      );
    });
  }

  private points(points: readonly AutomationPoint[], timing: BeatTiming, from: number, to: number, length: number): readonly AutomationPoint[] {
    if (!this.loop && from >= length) return Object.freeze([Object.freeze({ time: 0, value: valueAt(points, length), shape: "hold" as const })]);
    const start = timing.beatToTime(from);
    let pass = this.loop ? Math.floor(from / length + 1e-10) : 0;
    let base = pass * length;
    const result: AutomationPoint[] = [{ time: 0, value: valueAt(points, from - base), shape: shapeAt(points, from - base) }];
    let cursor = from;
    while (cursor < to) {
      const local = cursor - base;
      const knot = points.find((point) => base + point.time > cursor);
      const seam = this.loop ? (pass + 1) * length : Infinity;
      const boundary = Math.min(to, knot ? base + knot.time : Infinity, seam);
      const a = timing.beatToTime(cursor);
      const b = timing.beatToTime(boundary);
      if (shapeAt(points, local) === "linear") {
        const steps = Math.ceil((b - a) / MAX_SEGMENT_SECONDS);
        for (let i = 1; i < steps; i++) {
          const time = a + ((b - a) * i) / steps;
          const beat = timing.timeToBeat(time) - base;
          result.push({ time: time - start, value: valueAt(points, beat), shape: "linear" });
        }
      }
      result.push({ time: b - start, value: valueAt(points, boundary - base), shape: shapeAt(points, boundary - base) });
      cursor = boundary;
      if (cursor === seam) {
        base = ++pass * length;
        result[result.length - 1] = { ...result.at(-1)!, shape: "hold" };
        result.push({ time: b - start, value: valueAt(points, 0), shape: shapeAt(points, 0) });
      }
    }
    return Object.freeze(result.map((point) => Object.freeze(point)));
  }

  /** Clock scheduler contract: preserve actual current audio while cancelling the old mapping. */
  reset(): void {
    untracked(() => this.hold(this.now()));
  }

  /** Clock scheduler contract: a tempo edit re-times queued points from the transport. */
  transport(change: Readonly<{ type: string }>): void {
    if (change.type !== "tempo" && change.type !== "resume") return;
    untracked(() => {
      this.hold(this.now());
      this.handle?.refresh();
    });
  }

  /** Detach, cancel owned automation and stop watching curve edits; safe to call twice. */
  dispose(): void {
    untracked(() => {
      if (this.disposed) return;
      this.disposed = true;
      this.stopWatching();
      this.signal?.removeEventListener("abort", this.onAbort);
      const handle = this.handle;
      try {
        handle?.detach();
      } finally {
        if (handle) this.clearHandle(handle);
        this.hold(this.now());
      }
    });
  }

  [Symbol.dispose](): void {
    this.dispose();
  }
}
