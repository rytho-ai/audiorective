type RampKind = "linear" | "exponential";

interface TempoEvent {
  time: number;
  value: number;
  /** When set, the curve ramps from the previous event to this one (Web Audio semantics). */
  ramp?: RampKind;
}

/** The curve between two consecutive events: a hold at `v0`, or a ramp from `v0` to `v1` over `[t0, t1]`. */
interface Segment {
  t0: number;
  t1: number;
  v0: number;
  v1: number;
  ramp: RampKind | undefined;
}

function assertValidBpm(value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`bpm must be a finite number > 0, got ${value}`);
  }
}

/** bpm at `time` inside a segment. */
function segmentValue(seg: Segment, time: number): number {
  if (!seg.ramp || time <= seg.t0) return seg.v0;
  if (time >= seg.t1) return seg.v1;
  const u = (time - seg.t0) / (seg.t1 - seg.t0);
  return seg.ramp === "linear" ? seg.v0 + (seg.v1 - seg.v0) * u : seg.v0 * Math.pow(seg.v1 / seg.v0, u);
}

/** Exponential rate (1/s) of an exponential segment; 0 when flat. */
function expRate(seg: Segment): number {
  return Math.log(seg.v1 / seg.v0) / (seg.t1 - seg.t0);
}

/** Beats elapsed from `a` to `b` (both inside the segment, b >= a). */
function segmentBeats(seg: Segment, a: number, b: number): number {
  const d = b - a;
  if (d <= 0) return 0;
  if (!seg.ramp) return (d * seg.v0) / 60;
  const va = segmentValue(seg, a);
  if (seg.ramp === "linear") return (d * (va + segmentValue(seg, b))) / 120; // trapezoid: exact for a linear bpm
  // v(t) = va * e^(k (t - a)), so the integral is va * (e^(k d) - 1) / k; expm1 keeps k -> 0 stable
  const k = expRate(seg);
  return (va * (k === 0 ? d : Math.expm1(k * d) / k)) / 60;
}

/** Seconds needed from `a` to spend `beats` (> 0) inside the segment; inverse of `segmentBeats`. */
function segmentAdvance(seg: Segment, a: number, beats: number): number {
  const c = beats * 60;
  const va = segmentValue(seg, a);
  if (!seg.ramp) return c / va;
  if (seg.ramp === "linear") {
    // (m/2) d^2 + va d - c = 0 with m = bpm/s. Rationalised root d = 2c / (va + sqrt(va^2 + 2 m c)):
    // no cancellation for either sign of m, and it collapses to c / va when m = 0.
    const m = (seg.v1 - seg.v0) / (seg.t1 - seg.t0);
    return (2 * c) / (va + Math.sqrt(Math.max(va * va + 2 * m * c, 0)));
  }
  // c = va * expm1(k d) / k  =>  d = log1p(c k / va) / k
  const k = expRate(seg);
  return k === 0 ? c / va : Math.log1p(Math.max((c * k) / va, -1 + Number.EPSILON)) / k;
}

/**
 * Sorted event list mapping audio-clock seconds -> bpm, with the integrals
 * needed to convert between seconds and beats. Events are steps or ramps with
 * Web Audio semantics: a ramp event reaches its value at its time, starting
 * from the previous event. Pure: no time source, no signals.
 */
export class TempoCurve {
  private _events: TempoEvent[];
  private _implicitStart = true;

  constructor(initialBpm: number) {
    assertValidBpm(initialBpm);
    this._events = [{ time: 0, value: initialBpm }];
  }

  /** True until an event is set at the curve's first time: the start value is then the constructor's default, not a scheduled event. */
  get hasImplicitStart(): boolean {
    return this._implicitStart;
  }

  /** Number of scheduled events (the curve always keeps its first). */
  get eventCount(): number {
    return this._events.length;
  }

  /** Index of the last event with event.time <= time (always >= 0). */
  private _indexAtOrBefore(time: number): number {
    let lo = 0;
    let hi = this._events.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this._events[mid]!.time <= time) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  /** The segment that starts at event `idx` (a hold after the last event). */
  private _segment(idx: number): Segment {
    const events = this._events;
    const cur = events[idx]!;
    const next = events[idx + 1];
    if (!next) return { t0: cur.time, t1: Infinity, v0: cur.value, v1: cur.value, ramp: undefined };
    return { t0: cur.time, t1: next.time, v0: cur.value, v1: next.value, ramp: next.ramp };
  }

  private _insert(value: number, time: number, ramp: RampKind | undefined): void {
    const events = this._events;
    const idx = this._indexAtOrBefore(time);
    const event: TempoEvent = ramp ? { time, value, ramp } : { time, value };
    if (events[idx]!.time === time) {
      events[idx] = event;
      return;
    }
    events.splice(idx + 1, 0, event);
  }

  setValueAtTime(value: number, time: number): void {
    assertValidBpm(value);
    if (time === this._events[0]!.time) this._implicitStart = false;
    this._insert(value, time, undefined);
  }

  /**
   * Ramp from the previous event (the last one before `endTime`) to `value` at `endTime`.
   * With no earlier event, or one at `endTime` itself, the call is a step.
   */
  rampToValueAtTime(kind: RampKind, value: number, endTime: number): void {
    assertValidBpm(value);
    const events = this._events;
    const idx = this._indexAtOrBefore(endTime);
    // an event already at `endTime` would be the ramp's start: zero length, so a step
    this._insert(value, endTime, events[idx]!.time < endTime ? kind : undefined);
  }

  cancelScheduledValues(time: number): void {
    const events = this._events;
    let idx = events.findIndex((e) => e.time >= time);
    if (idx === -1) return; // every event is before `time` -- nothing to cancel
    // the first event anchors the curve's initial value; never drop it, so
    // the curve can never end up with nothing left for valueAt to read
    if (idx === 0) idx = 1;
    events.length = idx;
  }

  /**
   * Drop events at or after `time` and hold the value in force there. A ramp in progress is cut at `time`:
   * it keeps its slope up to `time` and holds the interpolated value afterwards, like `AudioParam.cancelAndHoldAtTime`.
   */
  cancelAndHoldAtTime(time: number): void {
    const held = this.valueAt(time);
    const next = this._events.find((e) => e.time >= time);
    const ramp = next?.ramp;
    this.cancelScheduledValues(time);
    if (ramp && time > this._events[0]!.time) this._insert(held, time, ramp);
    else this.setValueAtTime(held, time);
  }

  valueAt(time: number): number {
    return segmentValue(this._segment(this._indexAtOrBefore(time)), time);
  }

  /** Beats elapsed between t0 and t1 (t1 >= t0), integrating bpm/60 per segment. */
  beatsBetween(t0: number, t1: number): number {
    if (t1 <= t0) return 0;
    let idx = this._indexAtOrBefore(t0);
    let cursor = t0;
    let beats = 0;
    while (cursor < t1) {
      const seg = this._segment(idx);
      const segEnd = Math.min(seg.t1, t1);
      beats += segmentBeats(seg, cursor, segEnd);
      cursor = segEnd;
      idx++;
    }
    return beats;
  }

  /**
   * Inverse of beatsBetween: seconds needed to advance deltaBeats starting
   * at fromTime. Walks segments consuming beats until deltaBeats is spent.
   */
  timeToAdvance(fromTime: number, deltaBeats: number): number {
    if (deltaBeats <= 0) return 0;
    let idx = this._indexAtOrBefore(fromTime);
    let cursor = fromTime;
    let remaining = deltaBeats;
    for (;;) {
      const seg = this._segment(idx);
      const segBeats = seg.t1 === Infinity ? Infinity : segmentBeats(seg, cursor, seg.t1);
      if (segBeats >= remaining) return cursor + segmentAdvance(seg, cursor, remaining) - fromTime;
      remaining -= segBeats;
      cursor = seg.t1;
      idx++;
    }
  }
}
