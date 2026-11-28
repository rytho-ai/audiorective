import { Param } from "@audiorective/core";
import type { ParamOptions, SignalAccessor } from "@audiorective/core";
import { TempoCurve } from "./TempoCurve";

/** Linear ramp points per `setTargetAtTime` span (8 time constants): each ramp is a 1/16 of a time constant, under 0.05% of the swing off the true exponential. */
const TARGET_POINTS = 128;
const TARGET_SPAN = 8;

export interface TempoParamOptions extends ParamOptions<number> {
  /** Audio-clock time source used to resolve `.value = x` writes to a step time. */
  now: () => number;
}

/**
 * Standalone event-list-backed tempo curve. Mirrors SchedulableParam's
 * scheduling API surface but is not a reuse of it: it needs to evaluate and
 * integrate the curve analytically (beatToTime), which an AudioParam backing
 * can never support. Steps and linear/exponential ramps follow Web Audio semantics.
 */
export class TempoParam extends Param<number> {
  private readonly _curve: TempoCurve;
  /** Time span of events synthesized by `setTargetAtTime`/`setValueCurveAtTime`; a later event inside it cuts it there. */
  private _synthStart = Infinity;
  private _synthEnd = -Infinity;
  private readonly _now: () => number;
  private readonly _raw: SignalAccessor<number>;
  private readonly _listeners = new Set<(when: number) => void>();
  /**
   * Raw signal. Reads track like any `Param`; a write is a step at `now` on the tempo curve,
   * exactly like `.value = x`, so `$(x)` and `.value = x` cannot diverge from the curve.
   */
  declare readonly $: SignalAccessor<number>;

  constructor(options: TempoParamOptions) {
    super(options);
    this._now = options.now;
    this._curve = new TempoCurve(options.default);
    const raw = this.$;
    this._raw = raw;
    this.$ = ((...args: [] | [number]) => {
      if (args.length === 0) return raw();
      const now = this._now();
      this._cutSynthetic(now);
      this._curve.setValueAtTime(args[0], now);
      raw(args[0]);
      this._changed(now);
    }) as SignalAccessor<number>;
  }

  /** Set the tempo to `value` BPM at audio-context `time` (seconds). */
  setValueAtTime(value: number, time: number): this {
    this._cutSynthetic(time);
    this._curve.setValueAtTime(value, time);
    this._changed(time);
    return this;
  }

  /** Remove every scheduled tempo event at or after audio-context `time` (seconds). */
  cancelScheduledValues(time: number): this {
    this._cutSynthetic(time);
    this._curve.cancelScheduledValues(time);
    this._changed(time);
    return this;
  }

  /** Cancel events at or after `time` (seconds) and hold the tempo the curve has reached there. */
  cancelAndHoldAtTime(time: number): this {
    this._cutSynthetic(time);
    this._curve.cancelAndHoldAtTime(time);
    this._changed(time);
    return this;
  }

  /** Query the curve at audio-context `time` (seconds) — the AudioParam-backed sibling can never do this. */
  valueAtTime(time: number): number {
    return this._curve.valueAt(time);
  }

  /**
   * Ramp linearly in time from the previous event's value to `value` at `endTime`.
   * With no scheduled event yet, the ramp starts from the current value at the current audio time.
   */
  linearRampToValueAtTime(value: number, endTime: number): this {
    this._ramp("linear", value, endTime);
    this._changed(this._now());
    return this;
  }

  /** Ramp exponentially in time (constant ratio per second) from the previous event's value to `value` at `endTime`. */
  exponentialRampToValueAtTime(value: number, endTime: number): this {
    this._ramp("exponential", value, endTime);
    this._changed(this._now());
    return this;
  }

  /**
   * Approach `target` exponentially from the value in force at `startTime`: `target + (v0 - target) * e^(-(t - startTime) / timeConstant)`.
   *
   * The tempo curve integrates beats analytically, so the exponential approach is scheduled as 128 linear ramps over
   * 8 time constants (each within 0.05% of the swing of the true curve), ending exactly on `target`. The approach stops at the next
   * event already scheduled after `startTime`; an event scheduled later inside the span cuts it there, holding the value reached.
   */
  setTargetAtTime(target: number, startTime: number, timeConstant: number): this {
    if (!Number.isFinite(target) || target <= 0) throw new RangeError(`bpm must be a finite number > 0, got ${target}`);
    if (!Number.isFinite(startTime)) throw new RangeError(`TempoParam start time must be finite, got ${startTime}`);
    if (!Number.isFinite(timeConstant) || timeConstant < 0)
      throw new RangeError(`TempoParam time constant must be finite and >= 0, got ${timeConstant}`);
    this._cutSynthetic(startTime);
    const v0 = this._curve.valueAt(startTime);
    if (timeConstant === 0) {
      this._curve.setValueAtTime(target, startTime);
      this._changed(startTime);
      return this;
    }
    const limit = this._curve.nextEventTimeAfter(startTime);
    this._curve.setValueAtTime(v0, startTime);
    const end = Math.min(startTime + TARGET_SPAN * timeConstant, limit);
    const full = end === startTime + TARGET_SPAN * timeConstant;
    for (let i = 1; i <= TARGET_POINTS; i++) {
      const t = startTime + (i * TARGET_SPAN * timeConstant) / TARGET_POINTS;
      if (t >= limit) break;
      const value = full && i === TARGET_POINTS ? target : target + (v0 - target) * Math.exp(-(t - startTime) / timeConstant);
      this._curve.rampToValueAtTime("linear", value, t);
    }
    this._synthStart = startTime;
    this._synthEnd = end;
    this._changed(startTime);
    return this;
  }

  /**
   * Follow `values` (bpm) over `[startTime, startTime + duration]`, linearly interpolated between evenly spaced points like
   * `AudioParam.setValueCurveAtTime`, then hold the last value. Exact: the curve is a chain of linear ramps. Needs at least 2 values.
   */
  setValueCurveAtTime(values: Iterable<number>, startTime: number, duration: number): this {
    const points = Array.from(values);
    if (points.length < 2) throw new RangeError("TempoParam value curve needs at least 2 values.");
    if (!Number.isFinite(startTime)) throw new RangeError(`TempoParam start time must be finite, got ${startTime}`);
    if (!Number.isFinite(duration) || duration <= 0) throw new RangeError(`TempoParam value curve duration must be finite and > 0, got ${duration}`);
    for (const v of points) if (!Number.isFinite(v) || v <= 0) throw new RangeError(`bpm must be a finite number > 0, got ${v}`);
    this._cutSynthetic(startTime);
    this._curve.setValueAtTime(points[0]!, startTime);
    const last = points.length - 1;
    for (let i = 1; i <= last; i++) this._curve.rampToValueAtTime("linear", points[i]!, startTime + (i * duration) / last);
    this._synthStart = startTime;
    this._synthEnd = startTime + duration;
    this._changed(startTime);
    return this;
  }

  /** An event at `time` inside a synthesized span ends the span there: hold the value reached, drop the rest. */
  private _cutSynthetic(time: number): void {
    if (time > this._synthStart && time < this._synthEnd) {
      // just before `time`, so the cut keeps the ramp up to it and the caller's own event at `time` lands after
      this._curve.cancelAndHoldAtTime(time - 1e-9);
      this._synthEnd = time;
    }
  }

  private _ramp(kind: "linear" | "exponential", value: number, endTime: number): void {
    if (!Number.isFinite(endTime)) throw new RangeError(`TempoParam ramp end time must be finite, got ${endTime}`);
    this._cutSynthetic(endTime);
    if (this._curve.hasImplicitStart && this._curve.eventCount === 1) {
      // nothing scheduled to ramp from: start at the present, like an AudioParam
      const now = this._now();
      if (now < endTime) this._curve.setValueAtTime(this._curve.valueAt(now), now);
    }
    this._curve.rampToValueAtTime(kind, value, endTime);
  }

  /**
   * @internal Subscribe to curve edits (every scheduling call and every `.value` write, once each). The listener gets the audio time from which the
   * curve may differ, never earlier than now; the edit is already applied. Returns the unsubscribe function. Clocks use it for `transport({ type: "tempo" })`.
   */
  _onChange(listener: (when: number) => void): () => void {
    this._listeners.add(listener);
    return () => void this._listeners.delete(listener);
  }

  private _changed(time: number): void {
    if (this._listeners.size === 0) return;
    const when = Math.max(this._now(), time);
    for (const listener of [...this._listeners]) {
      try {
        listener(when);
      } catch (error) {
        console.error("TempoParam change listener failed:", error);
      }
    }
  }

  /** @internal Pushed by the Clock tick to keep `.value` reflecting the curve at `now`. */
  _refresh(now: number): void {
    this._raw(this._curve.valueAt(now));
  }

  /** @internal Timeline reads the curve directly for beat<->time integration. */
  get _curveForTimeline(): TempoCurve {
    return this._curve;
  }
}
