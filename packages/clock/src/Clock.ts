import { batch, Cell, readonlyCell, type BeatTiming, type CancellableEvent, type ReadonlyCell } from "@audiorective/core";
import { Timeline } from "./Timeline";
import type { Ruler } from "./rulers/Ruler";
import type { TempoParam } from "./TempoParam";
import { WorkerTickSource } from "./TickSource";
import type { TickSource } from "./TickSource";
import type { CoreTickWindow, TimeSignature, TimeSource, TransportState } from "./types";

export type { BeatTiming, CancellableEvent };

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

/** Why a scheduler is being reset: the transport started, stopped, paused or jumped, or the scheduler is leaving (detached, or the clock was disposed). */
export type ResetReason = "start" | "stop" | "pause" | "seek" | "detach";

export type TransportChangeType = "start" | "stop" | "pause" | "resume" | "seek" | "tempo";

/**
 * One change of the transport, reported after it is applied. `when` is the audio-context time it takes effect (`start(when)` reports that time,
 * the others now; a tempo edit reports the time from which the curve may differ, never earlier than now). `beat` is the transport's beat position at
 * `when`: where it starts, resumes, pauses or jumps to, `0` for a stop, and for a tempo change the beat the changed curve passes at `when`.
 */
export type TransportChange = Readonly<{
  type: TransportChangeType;
  when: number;
  beat: number;
}>;

/**
 * A pattern, sequencer or generator that follows a clock's windows. `schedule` runs once per look-ahead window and registers its events
 * with `window.own`; `reset` runs when the transport jumps, with the reason, after owned events are cancelled.
 */
export interface Scheduler {
  schedule(window: SchedulerWindow, timing: BeatTiming): void;
  /**
   * Called before the transport state changes, after owned events are cancelled. "start": `clock.start()` was called (the first window begins at its
   * `offsetBeats`); "stop", "pause", "seek": the transport left or jumped; "detach": the scheduler was detached or the clock disposed. `resume()` does
   * not call it. A scheduler that ignores `reason` resets on every one; one that keeps work queued while stopped keeps it on "start".
   */
  reset?(reason: ResetReason): void;
  /**
   * Optional. Called after each transport change, with the timeline and state already showing it: "start", "stop", "pause", "resume", "seek", and "tempo"
   * (the tempo curve was edited from `change.when`: re-time anything that waits on a beat). Every change is reported once, in call order; `reset` runs
   * first for the ones it covers. `stop()` on a stopped clock and `pause()` / `resume()` that do nothing report nothing.
   */
  transport?(change: TransportChange): void;
  /**
   * Optional. Called once, synchronously inside `attach`, with a handle to the transport the scheduler now follows: its timeline, state and time
   * signature are live at once, so commands issued right after `attach` can compute beats. It can re-queue its look-ahead after an edit
   * (`handle.refresh()`) or leave on its own (`handle.detach()`). May return a cleanup, which runs when the scheduler is detached or the clock is
   * disposed, after `reset`.
   */
  attached?(handle: SchedulerHandle): void | (() => void);
}

/** What a scheduler learns about the transport it was attached to. */
export interface SchedulerHandle {
  /** The beat/time mapping and tempo (`timeline.bpm`) the clock plays. */
  readonly timeline: Timeline;
  /** The transport state, the same cell as `clock.state`. */
  readonly state: ReadonlyCell<TransportState>;
  /** The clock's time signature, the same cell as `clock.meter`. */
  readonly meter: ReadonlyCell<TimeSignature>;
  /** The transport's `refresh()`: re-queue the look-ahead from now. Coalesced within one task. It retracts the events of every scheduler from now and re-emits their windows, so use it instead of `cancelFrom`, not after it. */
  refresh(): void;
  /**
   * Retract the events this scheduler registered with `window.own` whose start time is `time` (audio-context seconds) or later, and only those: other schedulers' events, `onTick` events and this
   * scheduler's earlier events stay. Each is cancelled as on a transport change (`event.cancel(time)`, an error is logged), synchronously; an event already ended is gone already. It does not re-emit any window
   * and does not move the clock's refill point: the span from `time` to the end of the last window this scheduler was given stays empty until the scheduler registers new events for it (through the
   * `own` of the most recent window, valid until the transport jumps). `time` earlier than now also cuts events that are sounding. Does nothing after detach. It does not stop `refresh()`: a later or pending
   * `refresh()` still retracts and re-emits everything from now, so a scheduler that called `cancelFrom` and then `refresh()` must not also re-register by hand.
   */
  cancelFrom(time: number): void;
  /** Detach this scheduler: the function `attach` returned. Idempotent. */
  detach(): void;
}

export interface ClockOptions<TRulers extends Record<string, Ruler<unknown, unknown>>> {
  /** Follow an existing Timeline (borrowed, so other code can share it). Pass this or `context`, not both. */
  timeline?: Timeline<TRulers>;
  /** The AudioContext (or any `{ currentTime }`): the Clock creates and owns its own Timeline. `audioContext` is the same option under Timeline's name. */
  context?: TimeSource;
  audioContext?: TimeSource;
  /** Starting tempo of the Clock's own Timeline. Default 120. Only with `context`. */
  bpm?: number;
  /** Time signature, `clock.meter`'s starting value. Default `[4, 4]`. */
  meter?: TimeSignature;
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
  /** The time signature that bars (`"1m"`) are measured in. Default `[4, 4]`; writable. Attached schedulers read it through their handle. */
  readonly meter: Cell<TimeSignature>;

  private readonly _timeline: Timeline<TRulers>;
  private readonly _lookAhead: number;
  private readonly _onTick: ((window: TickWindow<TRulers>) => void) | undefined;
  private readonly _schedulers = new Set<Scheduler>();
  private readonly _attachCleanups = new Map<Scheduler, () => void>();
  private readonly _onMiss?: (gap: MissedGap) => void;
  private readonly _tickSource: TickSource;
  private readonly _stopTempoWatch: () => void;

  private _previousWindowEndBeat = 0;
  // The generation `_previousWindowEndBeat` belongs to. A fresh segment
  // (start/seek) has no prior emitted window to have fallen behind -- some
  // real time inevitably passes between anchoring the target beat and the
  // tick source's next callback, which would otherwise register as a
  // spurious one-tick miss on every single start/seek. Comparing generations
  // lets that first tick land exactly on the target beat with no false miss.
  private _previousWindowEndGeneration = -1;
  private _startedAt = 0;
  private _disposed = false;
  private readonly _owned = new Map<CancellableEvent, number>();
  // which scheduler's window registered an owned event; onTick events have no entry
  private readonly _owners = new Map<CancellableEvent, Scheduler>();
  private _ticking = false;
  private _refillPending = false;
  private _cancelling = 0;

  constructor(options: ClockOptions<TRulers>) {
    const source = options.context ?? options.audioContext;
    if (options.timeline && source) throw new Error("Clock takes either timeline or context, not both.");
    if (!options.timeline && !source) throw new Error("Clock needs a timeline or a context.");
    if (options.timeline && options.bpm !== undefined) throw new Error("Clock bpm only applies with context; set it on the timeline you pass.");
    this._timeline = options.timeline ?? (new Timeline({ audioContext: source!, bpm: options.bpm }) as Timeline<TRulers>);
    this._lookAhead = options.lookAhead ?? 0.1;
    this._onTick = options.onTick;
    this._onMiss = options.onMiss;
    this._tickSource = options.tickSource ?? new WorkerTickSource((options.tickInterval ?? 0.025) * 1000);
    this.state = this._timeline.state;
    const meter = options.meter ?? [4, 4];
    if (!Number.isInteger(meter[0]) || !Number.isInteger(meter[1]) || meter[0] < 1 || meter[1] < 1) {
      throw new RangeError(`Clock meter must be [numerator, denominator] positive integers, got [${meter[0]}, ${meter[1]}].`);
    }
    this.meter = new Cell<TimeSignature>(meter);
    this._stopTempoWatch = this._timeline.bpm._onChange((when) => this._notify({ type: "tempo", when, beat: this._timeline.timeToBeat(when) }));
    this._tickSource.start(() => this._tick());
  }

  /** The tempo: this clock's `timeline.bpm`. */
  get bpm(): TempoParam {
    return this._timeline.bpm;
  }

  /**
   * The transport's current beat, read live from the audio clock (a plain getter, not tracked: read it per frame). It advances while playing, holds the paused beat,
   * is 0 when stopped, and is negative during a count-in started with `start(when, -4)`; a `start(when)` still ahead reads its start beat.
   */
  get beat(): number {
    return this._timeline.timeToBeat(this._timeline.now);
  }

  /** The beat/time mapping this clock plays. */
  get timeline(): Timeline<TRulers> {
    return this._timeline;
  }

  /**
   * Follow this clock with a scheduler: it receives every window after `onTick`, with this clock's timeline as its timing. Several schedulers
   * share one transport and stay beat-aligned. Returns a detach function (idempotent) that calls `scheduler.reset("detach")` and stops the windows. A scheduler with an
   * `attached(handle)` hook is called synchronously with its transport's `timeline`, `state` and `meter` (and `refresh()` after its own edits) and may return a cleanup
   * that runs on detach. A scheduler with a `transport(change)` hook hears every start, stop, pause, resume, seek and tempo change.
   * Attaching while playing refreshes the look-ahead so the scheduler's first hits are not missed. An error thrown by a scheduler is logged
   * and does not stop the others.
   */
  attach(scheduler: Scheduler): () => void {
    if (this._disposed) throw new Error("Clock is disposed.");
    if (this._schedulers.has(scheduler)) throw new Error("Clock already has this scheduler attached.");
    this._schedulers.add(scheduler);
    let detached = false;
    const detach = () => {
      if (!this._schedulers.delete(scheduler)) return;
      detached = true;
      this._resetScheduler(scheduler, "detach");
      this._cleanupScheduler(scheduler);
    };
    if (scheduler.attached) {
      try {
        const cleanup = scheduler.attached({
          timeline: this._timeline as unknown as Timeline,
          state: this.state,
          meter: readonlyCell(this.meter),
          refresh: () => this.refresh(),
          cancelFrom: (time: number) => {
            if (!detached) this._cancelSchedulerFrom(scheduler, time);
          },
          detach,
        });
        if (typeof cleanup === "function") this._attachCleanups.set(scheduler, cleanup);
      } catch (error) {
        this._schedulers.delete(scheduler);
        throw error;
      }
    }
    this.refresh();
    return detach;
  }

  private _cleanupScheduler(scheduler: Scheduler): void {
    const cleanup = this._attachCleanups.get(scheduler);
    if (!cleanup) return;
    this._attachCleanups.delete(scheduler);
    try {
      cleanup();
    } catch (error) {
      console.error("Clock scheduler cleanup failed:", error);
    }
  }

  private _resetSchedulers(reason: ResetReason): void {
    for (const scheduler of [...this._schedulers]) this._resetScheduler(scheduler, reason);
  }

  private _resetScheduler(scheduler: Scheduler, reason: ResetReason): void {
    try {
      scheduler.reset?.(reason);
    } catch (error) {
      console.error("Clock scheduler reset failed:", error);
    }
  }

  private _notify(change: TransportChange): void {
    if (this._disposed) return;
    for (const scheduler of [...this._schedulers]) {
      if (!scheduler.transport) continue;
      try {
        scheduler.transport(change);
      } catch (error) {
        console.error("Clock scheduler transport hook failed:", error);
      }
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
    this._resetSchedulers("start");
    // one change: effects watching `state` never see the new state with stale bookkeeping
    batch(() => this._timeline._start(atBeat, when));
    this._previousWindowEndBeat = atBeat;
    // deliberately NOT updating _previousWindowEndGeneration here: it must
    // stay stale (mismatching the just-bumped generation) so the first tick
    // recognizes this as a fresh segment and skips the miss check; _tick()
    // catches it up to the current generation once that tick has run.
    this._startedAt = Math.max(this._timeline.now, when ?? 0);
    this._notify({ type: "start", when: this._startedAt, beat: atBeat });
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
    this._resetSchedulers("pause");
    this._timeline._pause();
    this._notify({ type: "pause", when: this._timeline.now, beat: this._timeline.timeToBeat(this._timeline.now) });
  }

  /**
   * Continues from the frozen position — not a position jump, `generation`
   * unchanged. A no-op unless the transport is paused, so a stray resume can't
   * rewind a running clock or start a stopped one (see `Timeline._resume`).
   */
  resume(): void {
    if (this._timeline._transportState !== "paused") return;
    this._timeline._resume();
    this._notify({ type: "resume", when: this._timeline.now, beat: this._timeline.timeToBeat(this._timeline.now) });
  }

  /** Stops and resets position to beat 0. */
  stop(): void {
    this._refillPending = false;
    this._cancelOwned();
    this._resetSchedulers("stop");
    const wasStopped = this._timeline._transportState === "stopped";
    this._timeline._stop();
    this._previousWindowEndBeat = 0;
    if (!wasStopped) this._notify({ type: "stop", when: this._timeline.now, beat: 0 });
  }

  /** Jumps to `beat`. Bumps `generation`; the next window starts exactly at `beat` (beats may re-appear). */
  seek(beat: number): void {
    this._refillPending = false;
    this._cancelOwned();
    this._resetSchedulers("seek");
    this._timeline._seek(beat);
    this._previousWindowEndBeat = beat;
    this._notify({ type: "seek", when: this._timeline.now, beat });
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
   * `stop`, `seek`, `dispose`) cancels the pending refill; a tick that runs first performs it.
   */
  refresh(): void {
    if (this._disposed || this._timeline._transportState !== "playing" || this._refillPending) return;
    const now = this._timeline.now;
    this._refillPending = true;
    this._cancelOwned(true, now);
    if (!this._refillPending) return;
    this._previousWindowEndBeat = this._timeline._invalidate(now);
    queueMicrotask(() => {
      if (this._refillPending) this._tick();
    });
  }

  /** Stops the tick loop for good (terminates the underlying worker/timer). */
  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    this._refillPending = false;
    this._tickSource.stop();
    this._stopTempoWatch();
    this._cancelOwned();
    this._resetSchedulers("detach");
    for (const scheduler of [...this._schedulers]) this._cleanupScheduler(scheduler);
    this._schedulers.clear();
  }

  private _cancelOwned(fromNow = false, now = this._timeline.now): void {
    this._cancelling++;
    try {
      for (const [event, when] of [...this._owned]) {
        if (fromNow && when < now) continue;
        this._owned.delete(event);
        this._owners.delete(event);
        try {
          event.cancel(now);
        } catch (error) {
          console.error("Clock event cancellation failed:", error);
        }
      }
    } finally {
      this._cancelling--;
    }
  }

  private _cancelSchedulerFrom(scheduler: Scheduler, time: number): void {
    if (!this._schedulers.has(scheduler)) return;
    this._cancelling++;
    try {
      for (const [event, when] of [...this._owned]) {
        if (this._owners.get(event) !== scheduler || when < time) continue;
        this._owned.delete(event);
        this._owners.delete(event);
        try {
          event.cancel(time);
        } catch (error) {
          console.error("Clock event cancellation failed:", error);
        }
      }
    } finally {
      this._cancelling--;
    }
  }

  private _own(event: CancellableEvent, when: number, generation: number, owner?: Scheduler): void {
    if (!Number.isFinite(when) || when < 0) {
      event.cancel();
      throw new RangeError("Clock owned event time must be finite, non-negative seconds.");
    }
    if (this._disposed || this._cancelling || this._timeline._transportState !== "playing" || this._timeline.generation !== generation) {
      event.cancel();
      return;
    }
    this._owned.set(event, when);
    if (owner) this._owners.set(event, owner);
    else this._owners.delete(event);
    const forget = () => {
      this._owned.delete(event);
      this._owners.delete(event);
    };
    try {
      event.onEnded(forget);
    } catch (error) {
      forget();
      event.cancel();
      throw error;
    }
  }

  private _tick(): void {
    // a tick already in flight (posted by the worker before terminate())
    // can still arrive after dispose() -- ignore it
    if (this._disposed) return;
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
            const own = (event: CancellableEvent, when: number) => this._own(event, when, generation, scheduler);
            scheduler.schedule({ ...window, own }, this._timeline);
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
