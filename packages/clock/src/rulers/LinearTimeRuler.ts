import type { CoreTickWindow } from "../types";
import type { Ruler, TimelineLike } from "./Ruler";

export interface LinearTimePoint {
  seconds: number;
}

/**
 * Pause-aware seconds position, including the offset chosen by start/seek;
 * reads `timeline.position` directly. Not derivable from `beat` alone: pauses
 * break the beat<->wallclock correspondence (see TimelineLike.position).
 */
export class LinearTimeRuler implements Ruler<LinearTimePoint, LinearTimePoint> {
  /** Seconds position of the timeline; `beat` is ignored because pauses break the beat-to-seconds mapping. */
  at(beat: number, timeline: TimelineLike): LinearTimePoint {
    return { seconds: timeline.position };
  }

  /** Seconds position at the window; same reading as `at`. */
  read(window: Pick<CoreTickWindow, "beat">, timeline: TimelineLike): LinearTimePoint {
    return this.at(0, timeline);
  }
}
