import type { BeatTiming } from "@audiorective/core";
import type { SchedulerWindow } from "../src/Clock";
import { LinearBarRuler } from "../src/rulers/LinearBarRuler";
import { CycleBarRuler } from "../src/rulers/CycleBarRuler";
import { LinearTimeRuler } from "../src/rulers/LinearTimeRuler";
import { CycleTimeRuler } from "../src/rulers/CycleTimeRuler";
import type { Ruler, TimelineLike } from "../src/rulers/Ruler";
import type { CoreTickWindow } from "../src/types";

declare const window: SchedulerWindow;
declare const timing: BeatTiming;
declare const timeline: TimelineLike;
new LinearBarRuler({ numerator: 4, denominator: 4 }).read(window, timing);
new CycleBarRuler({ numerator: 4, denominator: 4, bars: 4 }).read(window, timing);
new LinearTimeRuler().read(window, timeline);
new CycleTimeRuler({ seconds: 2 }).read(window, timeline);
// @ts-expect-error Time rulers still require pause-aware position.
new LinearTimeRuler().read(window, timing);
// The custom-ruler extension point still receives the full clock tick.
const custom: Ruler<number, number> = {
  read(tick: CoreTickWindow) {
    return tick.generation;
  },
  at(beat) {
    return beat;
  },
};
void custom;
