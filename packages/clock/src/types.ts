export type TransportState = "stopped" | "playing" | "paused";

/**
 * The window payload minus `rulers` — what a Ruler's read()/at() methods
 * receive. Kept separate from the full TickWindow to avoid a circular
 * dependency between the window shape and the rulers that enrich it.
 */
export interface CoreTickWindow {
  /** Audio-context times in seconds: when the transport started, now, and the end of the look-ahead window. */
  time: {
    started: number;
    current: number;
    lookAheadEnd: number;
  };
  beat: {
    start: number;
    end: number;
  };
  generation: number;
  transport: {
    state: TransportState;
    /** Seconds the transport has played since it started (pause-aware). */
    position: number;
  };
}

/** A structural time source: anything exposing AudioContext.currentTime. */
export interface TimeSource {
  readonly currentTime: number;
}

/** Beats per bar and the beat unit: `[4, 4]` is four quarter beats, `[6, 8]` six eighths (3 beats on the quarter axis). */
export type TimeSignature = readonly [numerator: number, denominator: number];
