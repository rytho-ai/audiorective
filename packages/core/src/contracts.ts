/** A consumer-owned audio event that a scheduler may revoke after a transport or edit change. */
export interface CancellableEvent {
  cancel(): void;
  onEnded(listener: () => void): void;
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

export type EventTransformContext = Readonly<{
  /** Earliest audio time an event may sound (the window's current time). */
  now: number;
  /** Beat to seconds mapping for the scheduler's transport. */
  timing: BeatTiming;
  /** The scheduler's injectable random source; the only randomness a transform may use. */
  random: () => number;
}>;

/**
 * A pluggable, data-shaped step between a scheduler's computed events and the audio it triggers.
 * `apply` is pure: it keeps no state across windows and never triggers or cancels audio.
 */
export type EventTransform<E extends ScheduledEvent = ScheduledEvent> = Readonly<{
  id: string;
  params?: Readonly<Record<string, unknown>>;
  apply(events: readonly E[], context: EventTransformContext): readonly E[];
}>;

function checkEvent(id: string, event: unknown): void {
  const e = event as Record<string, unknown> | null;
  if (typeof e !== "object" || e === null || typeof e.when !== "number" || !Number.isFinite(e.when))
    throw new Error(`Event transform "${id}" returned an event without a finite "when".`);
  if ("duration" in e && !(typeof e.duration === "number" && Number.isFinite(e.duration) && e.duration > 0))
    throw new Error(`Event transform "${id}" returned an event whose "duration" is not a finite number above 0.`);
  if ("velocity" in e && !(typeof e.velocity === "number" && Number.isFinite(e.velocity) && e.velocity >= 0 && e.velocity <= 1))
    throw new Error(`Event transform "${id}" returned an event whose "velocity" is not a finite number from 0 to 1.`);
}

/**
 * Run `transforms` in order over `events` and enforce the socket rules: each output is validated and
 * attributed to its transform `id`, events with `velocity` 0 are dropped, and an event earlier than
 * `context.now` is moved to `now`. `duration` and `velocity` are checked only on events that have them.
 */
export function applyEventTransforms<E extends ScheduledEvent>(
  events: readonly E[],
  transforms: readonly EventTransform<E>[],
  context: EventTransformContext,
): E[] {
  let current: readonly E[] = events;
  for (const transform of transforms) {
    const output = transform.apply(current, context);
    if (!Array.isArray(output)) throw new Error(`Event transform "${transform.id}" must return an array of events.`);
    for (const event of output) checkEvent(transform.id, event);
    current = output.filter((event) => !("velocity" in event) || (event as unknown as TimedEvent).velocity > 0);
  }
  return current.map((event) => (event.when < context.now ? { ...event, when: context.now } : event));
}
