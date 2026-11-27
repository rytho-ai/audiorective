export type TransportState = "stopped" | "playing" | "paused";

/**
 * The window payload minus `rulers` — what a Ruler's read()/at() methods
 * receive. Kept separate from the full TickWindow to avoid a circular
 * dependency between the window shape and the rulers that enrich it.
 */
export interface CoreTickWindow {
  /** Audio-context times in seconds: when the transport started, now, and the end of the look-ahead window. */
  time: {
    /** Absolute AudioContext seconds at which the transport started. */
    started: number;
    /** Absolute AudioContext seconds at the tick that produced this window. */
    current: number;
    /** Exclusive scheduling horizon in absolute AudioContext seconds. */
    lookAheadEnd: number;
  };
  /** Quarter-note beat interval to fill, half-open [start, end). */
  beat: {
    /** Inclusive lower boundary in quarter-note beats. */
    start: number;
    /** Exclusive upper boundary in quarter-note beats. */
    end: number;
  };
  /** Transport epoch counter; changes invalidate events from an earlier epoch. */
  generation: number;
  /** Transport snapshot at this tick; position is pause-aware seconds. */
  transport: {
    /** Playback phase at this tick; stopped, playing or paused. */
    state: TransportState;
    /** Seconds the transport has played since it started (pause-aware). */
    position: number;
  };
}

/** A structural time source: anything exposing AudioContext.currentTime. */
export interface TimeSource {
  /** Monotonic audio-clock time in seconds, matching AudioContext.currentTime. */
  readonly currentTime: number;
}

/** Beats per bar and the beat unit: `[4, 4]` is four quarter beats, `[6, 8]` six eighths (3 beats on the quarter axis). */
export type TimeSignature = readonly [numerator: number, denominator: number];
