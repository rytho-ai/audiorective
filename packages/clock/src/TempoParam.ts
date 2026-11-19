import { Param } from "@audiorective/core";
import type { ParamOptions, SignalAccessor } from "@audiorective/core";
import { TempoCurve } from "./TempoCurve";

export interface TempoParamOptions extends ParamOptions<number> {
  /** Audio-clock time source used to resolve `.value = x` writes to a step time. */
  now: () => number;
}

const V2_MESSAGE = (method: string) => `TempoParam.${method} is V2 (tempo ramps) — see docs/superpowers/specs/2026-07-04-clock-design.md`;

/**
 * Standalone event-list-backed tempo curve. Mirrors SchedulableParam's
 * scheduling API surface but is not a reuse of it: it needs to evaluate and
 * integrate the curve analytically (beatToTime), which an AudioParam backing
 * can never support. See the clock design spec, "TempoParam" section.
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

  linearRampToValueAtTime(_value: number, _endTime: number): this {
    throw new Error(V2_MESSAGE("linearRampToValueAtTime"));
  }

  exponentialRampToValueAtTime(_value: number, _endTime: number): this {
    throw new Error(V2_MESSAGE("exponentialRampToValueAtTime"));
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
