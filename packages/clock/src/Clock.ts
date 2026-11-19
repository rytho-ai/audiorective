import { batch, type BeatTiming, type CancellableEvent, type ReadonlyCell } from "@audiorective/core";
import type { Timeline } from "./Timeline";
import type { Ruler } from "./rulers/Ruler";
import { WorkerTickSource } from "./TickSource";
import type { TickSource } from "./TickSource";
import type { CoreTickWindow, TransportState } from "./types";

export type { CancellableEvent };

export interface MissedGap {
  gapStart: number;
  gapEnd: number;
  gapDuration: number;
}

export type TickWindow<TRulers extends Record<string, Ruler<unknown, unknown>>> = CoreTickWindow & {
  rulers: { [K in keyof TRulers]: TRulers[K] extends Ruler<infer TWin, unknown> ? TWin : never };
  /** Register an event and its absolute audio start time for transport and edit cancellation. */
  own(event: CancellableEvent, when: number): void;
};

/** The part of a tick window an attached scheduler reads: the beat span to fill, the audio time now, and `own` for cancellable events. */
export interface SchedulerWindow {
  beat: { start: number; end: number };
  time: { current: number };
  own(event: CancellableEvent, when: number): void;
}

/**
 * A pattern, sequencer or generator that follows a clock's windows. `schedule` runs once per look-ahead window and registers its events
 * with `window.own`; `reset` runs when the transport jumps (`start`, `pause`, `stop`, `seek`, `destroy`) after owned events are cancelled.
 */
export interface Scheduler {
  schedule(window: SchedulerWindow, timing: BeatTiming): void;
  reset?(): void;
}

export interface ClockOptions<TRulers extends Record<string, Ruler<unknown, unknown>>> {
  timeline: Timeline<TRulers>;
  lookAhead?: number;
  tickInterval?: number;
  /** Called with every window. Optional: schedulers can instead follow the clock with `attach`. */
  onTick?: (window: TickWindow<TRulers>) => void;
  onMiss?: (gap: MissedGap) => void;
  tickSource?: TickSource;
}

/**
 * Owns the worker tick loop and the transport. Ticks run continuously from
 * construction (refreshing bpm/ruler `current` readings every tick) whether
 * or not the transport is playing; scheduling windows are only emitted
 * while playing.
 */
export class Clock<TRulers extends Record<string, Ruler<unknown, unknown>> = Record<never, never>> {
  /** Transport state. Read-only: only `start/pause/resume/stop` change it. Shared with `timeline.state`. */
  readonly state: ReadonlyCell<TransportState>;

  private readonly _timeline: Timeline<TRulers>;
  private readonly _lookAhead: number;
  private readonly _onTick: ((window: TickWindow<TRulers>) => void) | undefined;
  private readonly _schedulers = new Set<Scheduler>();
  private readonly _onMiss?: (gap: MissedGap) => void;
  private readonly _tickSource: TickSource;

  private _previousWindowEndBeat = 0;
  // The generation `_previousWindowEndBeat` belongs to. A fresh segment
  // (start/seek) has no prior emitted window to have fallen behind -- some
  // real time inevitably passes between anchoring the target beat and the
  // tick source's next callback, which would otherwise register as a
  // spurious one-tick miss on every single start/seek. Comparing generations
  // lets that first tick land exactly on the target beat with no false miss.
  private _previousWindowEndGeneration = -1;
  private _startedAt = 0;
  private _destroyed = false;
  private readonly _owned = new Map<CancellableEvent, number>();
  private _ticking = false;
  private _refillPending = false;
  private _cancelling = 0;

  constructor(options: ClockOptions<TRulers>) {
    this._timeline = options.timeline;
    this._lookAhead = options.lookAhead ?? 0.1;
    this._onTick = options.onTick;
    this._onMiss = options.onMiss;
    this._tickSource = options.tickSource ?? new WorkerTickSource((options.tickInterval ?? 0.025) * 1000);
    this.state = options.timeline.state;
    this._tickSource.start(() => this._tick());
  }

  /** The beat/time mapping this clock plays. */
  get timeline(): Timeline<TRulers> {
    return this._timeline;
  }

  /**
   * Follow this clock with a scheduler: it receives every window after `onTick`, with this clock's timeline as its timing. Several schedulers
   * share one transport and stay beat-aligned. Returns a detach function (idempotent) that calls `scheduler.reset()` and stops the windows.
   * Attaching while playing refreshes the look-ahead so the scheduler's first hits are not missed. An error thrown by a scheduler is logged
   * and does not stop the others.
   */
  attach(scheduler: Scheduler): () => void {
    if (this._destroyed) throw new Error("Clock is destroyed.");
    if (this._schedulers.has(scheduler)) throw new Error("Clock already has this scheduler attached.");
    this._schedulers.add(scheduler);
    this.refresh();
    return () => {
      if (!this._schedulers.delete(scheduler)) return;
      this._resetScheduler(scheduler);
    };
  }

  private _resetSchedulers(): void {
    for (const scheduler of [...this._schedulers]) this._resetScheduler(scheduler);
  }

  private _resetScheduler(scheduler: Scheduler): void {
    try {
      scheduler.reset?.();
    } catch (error) {
      console.error("Clock scheduler reset failed:", error);
    }
  }

  /**
   * Begins playback with the Web Audio shape: beat `offsetBeats` sounds at audio-context time `when`, exactly,
   * following the tempo curve from there. Always a position jump (bumps `generation`).
   *
   * - `when` defaults to now. A `when` in the past is clamped to now (like `AudioScheduledSourceNode.start`).
   * - A `when` in the future puts the transport in `"playing"` immediately; no window reaches past `offsetBeats`, so
   *   nothing is scheduled to sound before `when`, and `position` stays at its start value until `when`.
   * - `offsetBeats` defaults to 0 and may be negative (a count-in before beat 0).
   *
   * The older `start({ atBeat })` form is the same as `start(undefined, atBeat)`.
   * The V1 tempo-automation caveat applies when the start lands on/after a scheduled tempo event; see the clock design spec's ST-6.
   */
  start(when?: number, offsetBeats?: number): void;
  start(options?: { atBeat?: number }): void;
  start(whenOrOptions?: number | { atBeat?: number }, offsetBeats?: number): void {
    let when: number | undefined;
    let atBeat: number;
    if (typeof whenOrOptions === "object" && whenOrOptions !== null) {
      atBeat = whenOrOptions.atBeat ?? 0;
    } else {
      when = whenOrOptions;
      atBeat = offsetBeats ?? 0;
    }
    if (when !== undefined && !Number.isFinite(when)) throw new RangeError(`Clock start time must be finite seconds, got ${when}`);
    if (!Number.isFinite(atBeat)) throw new RangeError(`Clock start offset must be finite beats, got ${atBeat}`);
    this._refillPending = false;
    this._cancelOwned();
    this._resetSchedulers();
    // one change: effects watching `state` never see the new state with stale bookkeeping
    batch(() => this._timeline._start(atBeat, when));
    this._previousWindowEndBeat = atBeat;
    // deliberately NOT updating _previousWindowEndGeneration here: it must
    // stay stale (mismatching the just-bumped generation) so the first tick
    // recognizes this as a fresh segment and skips the miss check; _tick()
    // catches it up to the current generation once that tick has run.
    this._startedAt = Math.max(this._timeline.now, when ?? 0);
  }

  /**
   * Stops without resetting position. Unowned look-ahead audio keeps
   * sounding; events registered with a tick window are cancelled.
   *
   * A no-op unless the transport is playing. Pausing a *stopped* clock would
   * otherwise mint a resumable paused state that no `start()` ever anchored:
   * `stop()` resets `_previousWindowEndBeat` to 0 without bumping
   * `generation`, so the following `resume()` produces a segment the miss
   * check treats as continuous, and the first tick reports a spurious gap and
   * skips past beat 0 — dropping the events there.
   */
  pause(): void {
    if (this._timeline._transportState !== "playing") return;
    this._refillPending = false;
    this._cancelOwned();
    this._resetSchedulers();
    this._timeline._pause();
  }

  /**
   * Continues from the frozen position — not a position jump, `generation`
   * unchanged. A no-op unless the transport is paused, so a stray resume can't
   * rewind a running clock or start a stopped one (see `Timeline._resume`).
   */
  resume(): void {
    if (this._timeline._transportState !== "paused") return;
    this._timeline._resume();
  }

  /** Stops and resets position to beat 0. */
  stop(): void {
    this._refillPending = false;
    this._cancelOwned();
    this._resetSchedulers();
    this._timeline._stop();
    this._previousWindowEndBeat = 0;
  }

  /** Jumps to `beat`. Bumps `generation`; the next window starts exactly at `beat` (beats may re-appear). */
  seek(beat: number): void {
    this._refillPending = false;
    this._cancelOwned();
    this._resetSchedulers();
    this._timeline._seek(beat);
    this._previousWindowEndBeat = beat;
    // see start(): _previousWindowEndGeneration deliberately stays stale here too
  }

  /**
   * Revoke owned events starting at or after now, then refill from that same audio-clock boundary.
   *
   * The retraction and the boundary capture are synchronous. The refill is not: it runs as one
   * microtask after the current synchronous work, so `onTick` is never re-entered from inside the caller
   * (a callback, an effect or a launcher method that edits and refreshes). Further calls before that
   * microtask are no-ops: nothing has been refilled yet, so there is nothing new to retract, and the
   * first boundary stays the refill's start so no beat is skipped. Any transport call (`start`, `pause`,
   * `stop`, `seek`, `destroy`) cancels the pending refill; a tick that runs first performs it.
   */
  refresh(): void {
    if (this._destroyed || this._timeline._transportState !== "playing" || this._refillPending) return;
    const now = this._timeline.now;
    this._cancelOwned(true, now);
    this._previousWindowEndBeat = this._timeline._invalidate(now);
    this._refillPending = true;
    queueMicrotask(() => {
      if (this._refillPending) this._tick();
    });
  }

  /** Stops the tick loop for good (terminates the underlying worker/timer). */
  destroy(): void {
    if (this._destroyed) return;
    this._destroyed = true;
    this._refillPending = false;
    this._tickSource.stop();
    this._cancelOwned();
    this._resetSchedulers();
    this._schedulers.clear();
  }

  private _cancelOwned(fromNow = false, now = this._timeline.now): void {
    this._cancelling++;
    try {
      for (const [event, when] of [...this._owned]) {
        if (fromNow && when < now) continue;
        this._owned.delete(event);
        try {
          event.cancel();
        } catch (error) {
          console.error("Clock event cancellation failed:", error);
        }
      }
    } finally {
      this._cancelling--;
    }
  }

  private _own(event: CancellableEvent, when: number, generation: number): void {
    if (!Number.isFinite(when) || when < 0) {
      event.cancel();
      throw new RangeError("Clock owned event time must be finite, non-negative seconds.");
    }
    if (this._destroyed || this._cancelling || this._timeline._transportState !== "playing" || this._timeline.generation !== generation) {
      event.cancel();
      return;
    }
    this._owned.set(event, when);
    try {
      event.onEnded(() => this._owned.delete(event));
    } catch (error) {
      this._owned.delete(event);
      event.cancel();
      throw error;
    }
  }

  private _tick(): void {
    // a tick already in flight (posted by the worker before terminate())
    // can still arrive after destroy() -- ignore it
    if (this._destroyed) return;
    if (this._ticking) return;
    this._ticking = true;
    // this tick is the refill a pending refresh() asked for
    this._refillPending = false;
    try {
      const now = this._timeline.now;

      // reactive surfaces refresh every tick regardless of transport state
      this._timeline.bpm._refresh(now);
      this._timeline._refreshRulerCurrents(now);

      if (this._timeline._transportState !== "playing") return;

      const generation = this._timeline.generation;
      const freshSegment = generation !== this._previousWindowEndGeneration;

      let startBeat = this._previousWindowEndBeat;
      const nowBeat = this._timeline.timeToBeat(now);
      if (!freshSegment && nowBeat > startBeat) {
        // the clock fired late; those beats are gone -- Web Audio cannot schedule into the past
        this._onMiss?.({
          gapStart: startBeat,
          gapEnd: nowBeat,
          gapDuration: now - this._timeline.beatToTime(startBeat),
        });
        startBeat = nowBeat;
      }

      const endBeat = this._timeline.timeToBeat(now + this._lookAhead);
      if (endBeat > startBeat) {
        const coreWindow: CoreTickWindow = {
          time: { started: this._startedAt, current: now, lookAheadEnd: now + this._lookAhead },
          beat: { start: startBeat, end: endBeat },
          generation,
          transport: { state: this._timeline._transportState, position: this._timeline.position },
        };
        const window = {
          ...coreWindow,
          rulers: this._timeline._readWindowRulers(coreWindow),
          own: (event: CancellableEvent, when: number) => this._own(event, when, generation),
        } as TickWindow<TRulers>;
        this._onTick?.(window);
        for (const scheduler of [...this._schedulers]) {
          if (this._timeline.generation !== generation) break; // a callback moved the transport: this window is stale
          try {
            scheduler.schedule(window, this._timeline);
          } catch (error) {
            console.error("Clock scheduler failed:", error);
          }
        }
      }

      if (this._timeline.generation === generation) {
        this._previousWindowEndBeat = endBeat;
        this._previousWindowEndGeneration = generation;
      }
    } finally {
      this._ticking = false;
    }
  }
}
