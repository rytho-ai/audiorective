import { Cell, ReadonlyCell, readonlyCell, untracked } from "@audiorective/core";
import { TempoParam } from "./TempoParam";
import type { Ruler } from "./rulers/Ruler";
import type { CoreTickWindow, TimeSource, TransportState } from "./types";

interface RulerSlot<TPoint> {
  readonly current: ReadonlyCell<TPoint>;
}

interface RulerEntry {
  ruler: Ruler<unknown, unknown>;
  store: Cell<unknown>;
}

/**
 * Owns the transport anchor + tempo curve — the beat<->time mapping itself.
 * Conversions are valid even while paused or before a Clock ever ticks.
 * Beat position is never stored beyond the anchor; see the clock design
 * spec's "The core is three things" section.
 */
export class Timeline<TRulers extends Record<string, Ruler<unknown, unknown>> = Record<never, never>> {
  readonly bpm: TempoParam;
  /** Transport state: the single store for the transport. Written only by the Clock via the `_start/_pause/_resume/_stop` anchor writes. */
  readonly state: ReadonlyCell<TransportState>;

  private readonly _audioContext: TimeSource;
  private readonly _rulers = new Map<string, RulerEntry>();
  private readonly _rulersView: Record<string, RulerSlot<unknown>> = {};

  private _beatAtAnchor = 0;
  private _timeAtAnchor: number;
  private _positionAtAnchor = 0;
  private readonly _stateCell = new Cell<TransportState>("stopped");
  private _generation = 0;

  constructor(options: { audioContext: TimeSource; bpm?: number }) {
    this._audioContext = options.audioContext;
    this._timeAtAnchor = this._audioContext.currentTime;
    this.state = readonlyCell(this._stateCell);
    this.bpm = new TempoParam({ default: options.bpm ?? 120, now: () => this._audioContext.currentTime });
  }

  private _now(): number {
    return this._audioContext.currentTime;
  }

  /** @internal Raw audio-clock time, for the Clock tick loop. Timeline is the only holder of the time source. */
  get now(): number {
    return this._now();
  }

  /** Untracked read of the transport state for internal derivations (position, beat/time conversion). */
  private get _transport(): TransportState {
    return untracked(() => this._stateCell.value);
  }

  /** @internal Untracked transport read for the Clock tick loop and scheduling guards. */
  get _transportState(): TransportState {
    return this._transport;
  }

  get generation(): number {
    return this._generation;
  }

  /** Seconds position: start/seek seeds beat × 60 / BPM there; advances by real playing seconds, freezes while paused or before a future start. */
  get position(): number {
    return this._transport === "playing" ? this._positionAtAnchor + Math.max(0, this._now() - this._timeAtAnchor) : this._positionAtAnchor;
  }

  /**
   * While playing: the normal integral from the real anchor. While not
   * playing: answers "as if the transport resumed now" by substituting
   * `now` for `timeAtAnchor`.
   */
  beatToTime(beat: number): number {
    const origin = this._transport === "playing" ? this._timeAtAnchor : this._now();
    return origin + this.bpm._curveForTimeline.timeToAdvance(origin, beat - this._beatAtAnchor);
  }

  /**
   * While playing: the normal integral to `time`. While not playing, beat
   * position is frozen — returns the anchored beat regardless of `time`.
   */
  timeToBeat(time: number): number {
    if (this._transport !== "playing") return this._beatAtAnchor;
    return this._beatAtAnchor + this.bpm._curveForTimeline.beatsBetween(this._timeAtAnchor, time);
  }

  // TKey, not K: a method-level `K` collides with the `[K in keyof TRulers]`
  // mapped types below, and the .d.ts bundler resolves that collision by
  // renaming one side only -- emitting `TRulers[K$1]` inside a mapped type
  // still bound to `K`, which silently degrades every consumer's ruler
  // readings to `unknown`. Distinct names keep the emitted types correct.
  addRuler<TKey extends string, TWindow, TPoint>(key: TKey, ruler: Ruler<TWindow, TPoint>): Timeline<TRulers & Record<TKey, Ruler<TWindow, TPoint>>> {
    const now = this._now();
    const store = new Cell<TPoint>(ruler.at(this.timeToBeat(now), this));
    this._rulers.set(key, { ruler: ruler as Ruler<unknown, unknown>, store: store as Cell<unknown> });
    // the slot exposes a read-only view -- consumers read `rulers.<key>.current`
    this._rulersView[key] = { current: readonlyCell(store) as ReadonlyCell<unknown> };
    return this as unknown as Timeline<TRulers & Record<TKey, Ruler<TWindow, TPoint>>>;
  }

  get rulers(): { [K in keyof TRulers]: RulerSlot<TRulers[K] extends Ruler<unknown, infer TPoint> ? TPoint : never> } {
    return this._rulersView as never;
  }

  /** @internal Called by the Clock tick to refresh every ruler's `current` reading. */
  _refreshRulerCurrents(now: number): void {
    const beat = this.timeToBeat(now);
    for (const { ruler, store } of this._rulers.values()) {
      store.value = ruler.at(beat, this);
    }
  }

  /** @internal Builds the `rulers` object for a TickWindow. */
  _readWindowRulers(coreWindow: CoreTickWindow): { [K in keyof TRulers]: TRulers[K] extends Ruler<infer TWindow, unknown> ? TWindow : never } {
    const out: Record<string, unknown> = {};
    for (const [key, { ruler }] of this._rulers) {
      out[key] = ruler.read(coreWindow, this);
    }
    return out as never;
  }

  /**
   * @internal Anchor write for Clock.start(). Always a jump. Beat `atBeat` sounds at `when` (default and floor: now).
   * A `when` in the future leaves the transport "playing" at once with the beat frozen at `atBeat` until `when`.
   */
  _start(atBeat = 0, when?: number): void {
    const now = this._now();
    const at = when === undefined || !(when > now) ? now : when;
    this._beatAtAnchor = atBeat;
    this._timeAtAnchor = at;
    this._positionAtAnchor = (atBeat * 60) / this.bpm.valueAtTime(at);
    this._stateCell.value = "playing";
    this._generation++;
  }

  /**
   * @internal Anchor write for Clock.pause(). Freezes position; not a jump.
   *
   * Only a playing transport can pause — the mirror of `_resume()`'s guard.
   * The state write used to sit outside the guard, so pausing a stopped
   * transport left it `"paused"` and therefore resumable without any
   * `_start()` having anchored it or bumped the generation.
   */
  _pause(): void {
    if (this._transport !== "playing") return;
    const now = this._now();
    this._beatAtAnchor = this.timeToBeat(now);
    this._positionAtAnchor += Math.max(0, now - this._timeAtAnchor);
    this._timeAtAnchor = now;
    this._stateCell.value = "paused";
  }

  /**
   * @internal Anchor write for Clock.resume(). Continuous; not a jump.
   *
   * Only a paused transport can resume. Without this guard, resuming while
   * already playing moves `timeAtAnchor` to now while `beatAtAnchor` stays
   * where it was, so the derived position snaps backwards and the next windows
   * replay beats that were already scheduled. (`_pause()` has always had the
   * matching guard; this one was missing.) Resuming from stopped is likewise
   * not a transport start -- that is `_start()`, which anchors the position
   * and bumps the generation.
   */
  _resume(): void {
    if (this._transport !== "paused") return;
    this._timeAtAnchor = this._now();
    this._stateCell.value = "playing";
  }

  /** @internal Anchor write for Clock.stop(). Resets position. */
  _stop(): void {
    this._beatAtAnchor = 0;
    this._timeAtAnchor = this._now();
    this._positionAtAnchor = 0;
    this._stateCell.value = "stopped";
  }

  /** @internal Anchor write for Clock.seek(beat). Always a jump; state unchanged. */
  _seek(beat: number): void {
    const now = this._now();
    this._beatAtAnchor = beat;
    this._timeAtAnchor = now;
    this._positionAtAnchor = (beat * 60) / this.bpm.valueAtTime(now);
    this._generation++;
  }

  /** @internal Reissue from Clock's captured audio boundary without moving the heard position. */
  _invalidate(now: number): number {
    // Refresh changes event ownership, not the transport anchor. Re-anchoring
    // every small refill accumulates rounding at musical boundaries.
    this._generation++;
    return this.timeToBeat(now);
  }
}
