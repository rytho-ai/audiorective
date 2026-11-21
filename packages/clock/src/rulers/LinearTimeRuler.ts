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
  at(_beat: number, timeline: TimelineLike): LinearTimePoint {
    return { seconds: timeline.position };
  }

  read(_window: CoreTickWindow, timeline: TimelineLike): LinearTimePoint {
    return this.at(0, timeline);
  }
}
