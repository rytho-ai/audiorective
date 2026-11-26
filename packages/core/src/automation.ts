import { effect, getActiveSub, setActiveSub, signal } from "alien-signals";
import type { SignalAccessor } from "./types";

/** Shape describes the segment leaving this point. Time is in caller-chosen units. */
export interface AutomationPoint {
  readonly time: number;
  readonly value: number;
  readonly shape: "linear" | "hold";
}

function pointsCopy(points: readonly AutomationPoint[]): readonly AutomationPoint[] {
  if (
    !Array.isArray(points) ||
    points.length === 0 ||
    Array.from(points).some(
      (p) => !p || !Number.isFinite(p.time) || p.time < 0 || !Number.isFinite(p.value) || (p.shape !== "linear" && p.shape !== "hold"),
    )
  ) {
    throw new RangeError("AutomationCurve needs nonempty finite points with nonnegative unique times and linear/hold shapes.");
  }
  const copy = points.map((p) => Object.freeze({ time: p.time, value: p.value, shape: p.shape })).sort((a, b) => a.time - b.time);
  if (copy.some((p, i) => i > 0 && p.time === copy[i - 1].time)) {
    throw new RangeError("AutomationCurve needs nonempty finite points with nonnegative unique times and linear/hold shapes.");
  }
  return Object.freeze(copy);
}

function segment(points: readonly AutomationPoint[], time: number): number {
  let low = 0;
  let high = points.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (points[mid].time <= time) low = mid + 1;
    else high = mid;
  }
  return Math.max(0, low - 1);
}

function sample(points: readonly AutomationPoint[], time: number): number {
  const i = segment(points, time);
  const a = points[i];
  const b = points[i + 1];
  if (time <= a.time || !b || a.shape === "hold") return a.value;
  const ratio = (time - a.time) / (b.time - a.time);
  return a.value * (1 - ratio) + b.value * ratio;
}

/** Immutable reactive snapshots through `.value`; `$` exposes the raw signal for advanced use. */
export class AutomationCurve {
  readonly $: SignalAccessor<readonly AutomationPoint[]>;

  constructor(points: readonly AutomationPoint[]) {
    const raw = signal(pointsCopy(points));
    // Raw `$(points)` writes get the same validation, sorting and freezing as `.value =`.
    this.$ = ((...args: [] | [readonly AutomationPoint[]]) => {
      if (args.length === 0) return raw();
      raw(pointsCopy(args[0]));
    }) as SignalAccessor<readonly AutomationPoint[]>;
  }

  /** The frozen points, sorted by time; assigning validates, sorts and copies them. Tracked. */
  get value(): readonly AutomationPoint[] {
    return this.$();
  }

  set value(points: readonly AutomationPoint[]) {
    this.$(points);
  }

  /** Constant before the first point and after the last; finite negative queries are allowed. */
  valueAt(time: number): number {
    if (!Number.isFinite(time)) throw new RangeError("AutomationCurve sample time must be finite.");
    return sample(this.value, time);
  }
}

/**
 * Exclusive scheduling capability. program replaces events from `when` onward;
 * points are relative seconds starting at zero. hold cancels future events while
 * preserving the value at the supplied absolute audio time. Domain adapters own fanout.
 */
export interface AutomationTarget {
  program(points: readonly AutomationPoint[], when: number): void;
  hold(time: number): void;
}

/** Explicitly targets a native timeline, including `schedulableParam.audioParam`. */
export function audioParamTarget(param: AudioParam): AutomationTarget {
  return {
    hold(time) {
      param.cancelAndHoldAtTime(time);
    },
    program(points, when) {
      param.cancelAndHoldAtTime(when);
      for (let i = 0; i < points.length; i++) {
        const p = points[i];
        if (i === 0 || points[i - 1].shape === "hold") param.setValueAtTime(p.value, when + p.time);
        else param.linearRampToValueAtTime(p.value, when + p.time);
      }
    },
  };
}

export interface AutomationStartOptions {
  /** Absolute audio seconds. A past time is clamped to now. Default: now. */
  when?: number;
  /** Curve position. Default: 0. */
  from?: number;
  /** Curve endpoint, captured at start. Default: max(from, last point time). */
  to?: number;
  /** Constant conversion from curve units to audio seconds. Default: 1. */
  secondsPerUnit?: number;
}

interface Anchor {
  when: number;
  from: number;
  to: number;
  secondsPerUnit: number;
}

// Target callbacks may read other signals; those must not become curve dependencies.
function withoutTracking<T>(fn: () => T): T {
  const previous = getActiveSub();
  setActiveSub(undefined);
  try {
    return fn();
  } finally {
    setActiveSub(previous);
  }
}

/** Finite native scheduling, with reactive reprogramming and explicit ownership/cleanup. */
export class AutomationBinding {
  private _anchor?: Anchor;
  private _position = 0;
  private _disposed = false;
  private readonly _dispose: () => void;

  constructor(
    readonly context: Pick<BaseAudioContext, "currentTime">,
    readonly curve: AutomationCurve,
    private readonly target: AutomationTarget,
  ) {
    this._dispose = withoutTracking(() =>
      effect(() => {
        const points = curve.value;
        if (this._anchor) withoutTracking(() => this._program(points));
      }),
    );
  }

  /** Audio-clock position, clamped to the range; stop retains the stopped position. */
  get position(): number {
    const a = this._anchor;
    return a ? Math.min(a.to, a.from + Math.max(0, this.context.currentTime - a.when) / a.secondsPerUnit) : this._position;
  }

  /** Plays the curve from `options.from` (curve units, default 0) to `options.to` at audio time `options.when` (default now), converting units with `secondsPerUnit` (default 1). Throws when disposed or an option is not finite. */
  start(options: AutomationStartOptions = {}): void {
    if (this._disposed) throw new Error("AutomationBinding is disposed.");
    const now = this.context.currentTime;
    const from = options.from ?? 0;
    const to =
      options.to ??
      Math.max(
        from,
        withoutTracking(() => this.curve.value.at(-1)!.time),
      );
    const when = options.when ?? now;
    const secondsPerUnit = options.secondsPerUnit ?? 1;
    if (
      ![from, to, when, secondsPerUnit].every(Number.isFinite) ||
      from < 0 ||
      to < from ||
      when < 0 ||
      secondsPerUnit <= 0 ||
      !Number.isFinite(Math.max(now, when) + (to - from) * secondsPerUnit)
    ) {
      throw new RangeError("AutomationBinding needs finite nonnegative times, to >= from, and positive secondsPerUnit.");
    }
    this.stop();
    this._anchor = { when: Math.max(now, when), from, to, secondsPerUnit };
    withoutTracking(() => this._program(this.curve.value));
  }

  private _program(points: readonly AutomationPoint[]): void {
    const a = this._anchor!;
    const when = Math.max(a.when, this.context.currentTime);
    const from = Math.min(a.to, a.from + (when - a.when) / a.secondsPerUnit);
    const i = segment(points, from);
    const window: AutomationPoint[] = [{ time: 0, value: sample(points, from), shape: from < points[0].time ? "hold" : points[i].shape }];
    for (const p of points) {
      if (p.time > from && p.time < a.to) window.push({ ...p, time: (p.time - from) * a.secondsPerUnit });
    }
    if (a.to > from) window.push({ time: (a.to - from) * a.secondsPerUnit, value: sample(points, a.to), shape: "hold" });
    try {
      this.target.program(Object.freeze(window.map((p) => Object.freeze(p))), when);
    } catch (error) {
      this._position = this.position;
      this._anchor = undefined;
      // A target may have partially scheduled before failing. Preserve the original error.
      try {
        this.target.hold(this.context.currentTime);
      } catch {
        /* best-effort cleanup */
      }
      throw error;
    }
  }

  /** Cancel queued events now, including a not-yet-started run. Does not dispose the target. */
  stop(): void {
    if (!this._anchor) return;
    this._position = this.position;
    this._anchor = undefined;
    withoutTracking(() => this.target.hold(this.context.currentTime));
  }

  /** Dispose before the borrowed target/processor. Safe to call repeatedly. */
  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    this._dispose();
    this.stop();
  }
}

export { AutomationClip, type AutomationClipOptions, type AutomationClipWindow, type AutomationClipTransport } from "./AutomationClip";
