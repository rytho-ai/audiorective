import { Param } from "@audiorective/core";
import type { ParamOptions, SignalAccessor } from "@audiorective/core";
import { TempoCurve } from "./TempoCurve";

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
  private readonly _now: () => number;
  private readonly _raw: SignalAccessor<number>;
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
      this._curve.setValueAtTime(args[0], this._now());
      raw(args[0]);
    }) as SignalAccessor<number>;
  }

  setValueAtTime(value: number, time: number): this {
    this._curve.setValueAtTime(value, time);
    return this;
  }

  cancelScheduledValues(time: number): this {
    this._curve.cancelScheduledValues(time);
    return this;
  }

  cancelAndHoldAtTime(time: number): this {
    this._curve.cancelAndHoldAtTime(time);
    return this;
  }

  /** Query the curve at an arbitrary time — the AudioParam-backed sibling can never do this. */
  valueAtTime(time: number): number {
    return this._curve.valueAt(time);
  }

  /**
   * Ramp linearly in time from the previous event's value to `value` at `endTime`.
   * With no scheduled event yet, the ramp starts from the current value at the current audio time.
   */
  linearRampToValueAtTime(value: number, endTime: number): this {
    this._ramp("linear", value, endTime);
    return this;
  }

  /** Ramp exponentially in time (constant ratio per second) from the previous event's value to `value` at `endTime`. */
  exponentialRampToValueAtTime(value: number, endTime: number): this {
    this._ramp("exponential", value, endTime);
    return this;
  }

  private _ramp(kind: "linear" | "exponential", value: number, endTime: number): void {
    if (!Number.isFinite(endTime)) throw new RangeError(`TempoParam ramp end time must be finite, got ${endTime}`);
    if (this._curve.hasImplicitStart && this._curve.eventCount === 1) {
      // nothing scheduled to ramp from: start at the present, like an AudioParam
      const now = this._now();
      if (now < endTime) this._curve.setValueAtTime(this._curve.valueAt(now), now);
    }
    this._curve.rampToValueAtTime(kind, value, endTime);
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
