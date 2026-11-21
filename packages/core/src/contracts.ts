import { hash01 } from "./hash";

/** A consumer-owned audio event that a scheduler may revoke after a transport or edit change. */
export interface CancellableEvent {
  /** `time` is the audio-context time the retraction takes effect (a scheduler's `cancelFrom(time)`, or now for a transport change or refresh); an event that is already sounding may stop at it. Omitted: now. */
  cancel(time?: number): void;
  onEnded(listener: () => void): void;
}

/**
 * Pair a scheduled event with the extra scheduling it needed, so a cancel retracts both.
 * The returned event's `cancel()` cancels `event`, then runs `undo` once; later calls do nothing. `onEnded` passes through to `event`.
 * Cancelling does not run `undo` for an event that already ended on its own.
 * With `event` null (an instrument that made no sound) there is nothing to cancel: it ends when cancelled, and `undo` still runs.
 */
export function withCancel(event: CancellableEvent | null, undo: () => void): CancellableEvent {
  let cancelled = false;
  let ended = false;
  const listeners: Array<() => void> = [];
  event?.onEnded(() => {
    ended = true;
  });
  return {
    cancel() {
      if (cancelled || ended) return;
      cancelled = true;
      event?.cancel();
      try {
        undo();
      } finally {
        if (!event) for (const listener of listeners.splice(0)) listener();
      }
    },
    onEnded(listener) {
      if (event) event.onEnded(listener);
      else if (cancelled) listener();
      else listeners.push(listener);
    },
  };
}

/** Converts between beats and absolute audio-context time. */
export type BeatTiming = Readonly<{
  beatToTime(beat: number): number;
  timeToBeat(time: number): number;
}>;

/** The one field every scheduler's outgoing event has: the absolute audio-context time it sounds. */
export type ScheduledEvent = Readonly<{ when: number }>;

/** A scheduled event that also has a length and a level, such as a note or a hit. */
export type TimedEvent = ScheduledEvent & Readonly<{ duration: number; velocity: number }>;

/** The one field every event has inside a transform pipeline: the beat it sounds at, before it is mapped to audio time. */
export type BeatEvent = Readonly<{ beat: number }>;

/** A beat event that also has a length in beats and a level. Its seconds form is a `TimedEvent`. */
export type TimedBeatEvent = BeatEvent & Readonly<{ durationBeats: number; velocity: number }>;

/**
 * The seconds form of a beat event, which is what a scheduler triggers and what a `unit: "second"` transform sees:
 * `beat` becomes `when` and `durationBeats`, when present, becomes `duration`. Every other field is unchanged.
 */
export type SecondsOf<E extends BeatEvent> = Readonly<
  Omit<E, "beat" | "durationBeats"> & ScheduledEvent & (E extends { durationBeats: number } ? { duration: number } : unknown)
>;

/** The unit of the events a transform reads and returns: `"beat"` (the default) or `"second"`. */
export type EventTransformUnit = "beat" | "second";

export type EventTransformContext = Readonly<{
  /**
   * Earliest position an event may sound, in the transform's own unit: beats for a beat transform,
   * audio-context seconds for a seconds transform. `applyEventTransforms` takes it in seconds.
   */
  now: number;
  /** Beat to seconds mapping for the scheduler's transport. */
  timing: BeatTiming;
  /**
   * The scheduler's sequential random source. Each call advances a stream, so a re-queued window draws different numbers:
   * use it only where the result may change when events are rescheduled. Prefer `randomFor`.
   */
  random: () => number;
  /**
   * A number in [0, 1) that is a pure function of the event's identity (the scheduler's `keyOf`) and `key`, so the same event
   * gets the same number in every window, re-queue and seek. Pass different `key`s to draw several independent numbers for one event.
   */
  randomFor(event: object, key?: number | string): number;
}>;

/**
 * A pluggable, data-shaped step between a scheduler's computed events and the audio it triggers.
 * By default (`unit` absent or `"beat"`) it reads and returns beat events, so moves such as swing are tempo-independent
 * beat arithmetic. With `unit: "second"` it reads and returns the same events in seconds (`when`, `duration`), for
 * adjustments that are really about time, such as millisecond jitter; the result is mapped back to beats for the next transform.
 * `apply` is pure: it keeps no state across windows and never triggers or cancels audio.
 */
export type EventTransform<E extends BeatEvent = BeatEvent> = Readonly<{ id: string; params?: Readonly<Record<string, unknown>> }> &
  (
    | Readonly<{ unit?: "beat"; apply(events: readonly E[], context: EventTransformContext): readonly E[] }>
    | Readonly<{ unit: "second"; apply(events: readonly SecondsOf<E>[], context: EventTransformContext): readonly SecondsOf<E>[] }>
  );

/**
 * What a scheduler passes to `applyEventTransforms`: the context minus `randomFor`, which is built from `seed` and `keyOf`.
 * `keyOf` returns the event's stable identity (for example lane, loop and step counter) from fields that survive a transform's
 * `{ ...event }` copy; without it the event's `beat` (or `when`) is the identity, which is stable only while no earlier transform moves it.
 * `seed` defaults to 0.
 */
export type EventTransformInput = Omit<EventTransformContext, "randomFor"> & Readonly<{ seed?: number; keyOf?: (event: never) => number | string }>;

type AnyEvent = Record<string, unknown>;

function checkEvent(id: string, event: unknown, unit: EventTransformUnit): void {
  const e = event as Record<string, unknown> | null;
  const finite = (v: unknown) => typeof v === "number" && Number.isFinite(v);
  if (unit === "beat") {
    if (typeof e !== "object" || e === null || !finite(e.beat)) throw new Error(`Event transform "${id}" returned an event without a finite "beat".`);
    if ("durationBeats" in e && !(finite(e.durationBeats) && (e.durationBeats as number) > 0))
      throw new Error(`Event transform "${id}" returned an event whose "durationBeats" is not a finite number above 0.`);
  } else {
    if (typeof e !== "object" || e === null || !finite(e.when)) throw new Error(`Event transform "${id}" returned an event without a finite "when".`);
    if ("duration" in e && !(finite(e.duration) && (e.duration as number) > 0))
      throw new Error(`Event transform "${id}" returned an event whose "duration" is not a finite number above 0.`);
  }
  if ("velocity" in e && !(finite(e.velocity) && (e.velocity as number) >= 0 && (e.velocity as number) <= 1))
    throw new Error(`Event transform "${id}" returned an event whose "velocity" is not a finite number from 0 to 1.`);
}

function beatToSeconds(event: AnyEvent, timing: BeatTiming): AnyEvent {
  const { beat, durationBeats, ...rest } = event as AnyEvent & { beat: number; durationBeats?: number };
  const when = timing.beatToTime(beat);
  return "durationBeats" in event ? { ...rest, when, duration: timing.beatToTime(beat + (durationBeats as number)) - when } : { ...rest, when };
}

function secondsToBeats(event: AnyEvent, timing: BeatTiming): AnyEvent {
  const { when, duration, ...rest } = event as AnyEvent & { when: number; duration?: number };
  const beat = timing.timeToBeat(when);
  return "duration" in event ? { ...rest, beat, durationBeats: timing.timeToBeat(when + (duration as number)) - beat } : { ...rest, beat };
}

/**
 * Run `transforms` in order over beat `events` and enforce the socket rules, returning seconds events.
 * Each transform reads events in its `unit` (beats by default); events are converted through `context.timing` only where
 * the unit changes. Each output is validated and attributed to its transform `id`, and events with `velocity` 0 are dropped.
 * After the last transform the events are converted to seconds and one earlier than `context.now` (seconds) is moved to `now`.
 * `durationBeats`/`duration` and `velocity` are checked only on events that have them.
 */
export function applyEventTransforms<E extends BeatEvent>(
  events: readonly E[],
  transforms: readonly EventTransform<E>[],
  context: EventTransformInput,
): SecondsOf<E>[] {
  const { timing } = context;
  const { seed = 0, keyOf, ...base } = context;
  const identity = (event: object): number | string => {
    if (keyOf) return (keyOf as (event: object) => number | string)(event);
    const e = event as { beat?: number; when?: number };
    return e.beat ?? e.when ?? 0;
  };
  const randomFor = (event: object, key: number | string = 0) => hash01(seed, identity(event), key);
  let unit: EventTransformUnit = "beat";
  let current: readonly AnyEvent[] = events as readonly unknown[] as readonly AnyEvent[];
  for (const transform of transforms) {
    const wanted: unknown = transform.unit ?? "beat";
    if (wanted !== "beat" && wanted !== "second") throw new Error(`Event transform "${transform.id}" has a unit other than "beat" or "second".`);
    if (wanted !== unit) {
      current = current.map((event) => (wanted === "second" ? beatToSeconds(event, timing) : secondsToBeats(event, timing)));
      unit = wanted;
    }
    const output = (transform.apply as (events: readonly AnyEvent[], context: EventTransformContext) => readonly AnyEvent[])(current, {
      ...base,
      randomFor,
      now: unit === "beat" ? timing.timeToBeat(context.now) : context.now,
    });
    if (!Array.isArray(output)) throw new Error(`Event transform "${transform.id}" must return an array of events.`);
    for (const event of output) checkEvent(transform.id, event, unit);
    current = output.filter((event) => !("velocity" in event) || (event as unknown as TimedEvent).velocity > 0);
  }
  const seconds = unit === "beat" ? current.map((event) => beatToSeconds(event, timing)) : current;
  return seconds.map((event) => ((event.when as number) < context.now ? { ...event, when: context.now } : event)) as unknown as SecondsOf<E>[];
}

/** A number in [0, 1) fixed by the seed, the event and `key`: the same event gets the same number in every window, re-queue, seek and loop pass. */
export type Random = (key?: number | string) => number;

/** The timing fields of an event a per-event `transform` may move: absolute audio seconds and the beat position, and the length in seconds and in beats. */
export type HitTiming = Readonly<{ when: number; duration: number; beat: number; durationBeats: number }>;

/**
 * Resolves what a per-event `transform` returned against the event it was given. Beats win: a changed `beat` or `durationBeats` is mapped through `timing`,
 * then any `when` / `duration` delta is added; a changed `when` or `duration` alone moves the event in seconds and updates its beats.
 * Throws `Event transform "transform" returned an event without a finite "beat"` (likewise `when`, `durationBeats`) for a bad value.
 */
export function resolveHitEdit(hit: HitTiming, result: HitTiming, timing: BeatTiming): HitTiming {
  const bad = (field: string): never => {
    throw new Error(`Event transform "transform" returned an event without a finite "${field}".`);
  };
  if (typeof result !== "object") return bad("when");
  const beatMoved = result.beat !== undefined && result.beat !== hit.beat;
  const lengthMoved = result.durationBeats !== undefined && result.durationBeats !== hit.durationBeats;
  if (beatMoved && !Number.isFinite(result.beat)) bad("beat");
  if (lengthMoved && !(Number.isFinite(result.durationBeats) && result.durationBeats > 0)) bad("durationBeats");
  const whenMoved = result.when !== hit.when;
  const durationMoved = result.duration !== hit.duration;
  let when = result.when;
  let beat = hit.beat;
  if (beatMoved) {
    when = timing.beatToTime(result.beat) + (whenMoved ? result.when - hit.when : 0);
    beat = whenMoved ? timing.timeToBeat(when) : result.beat;
  } else if (whenMoved && Number.isFinite(when)) beat = timing.timeToBeat(when);
  let duration = result.duration;
  let durationBeats = hit.durationBeats;
  if (beatMoved || lengthMoved) {
    const start = beatMoved ? result.beat : hit.beat;
    duration = timing.beatToTime(start + result.durationBeats) - timing.beatToTime(start) + (durationMoved ? result.duration - hit.duration : 0);
    durationBeats = result.durationBeats;
  }
  if (durationMoved && Number.isFinite(when) && Number.isFinite(duration))
    durationBeats = timing.timeToBeat(when + duration) - timing.timeToBeat(when);
  return { when, duration, beat, durationBeats };
}
