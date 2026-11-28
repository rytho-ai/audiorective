import type { BeatTiming } from "@audiorective/core";
import type { CoreTickWindow } from "../types";
import { beatsPerBar, gridPoints } from "./Ruler";
import type { GridPoint, Ruler } from "./Ruler";

export interface LinearBarRulerOptions {
  /** Positive meter numerator, counted in denominator note values per bar. */
  numerator: number;
  /** Positive meter denominator; 4 denotes a quarter note. */
  denominator: number;
}

export interface LinearBarPoint {
  /** Zero-based bar offset: bar 0 is the first bar. */
  bar: number;
  /** Quarter-note axis beats since the bar began, regardless of the meter denominator. */
  beatInBar: number;
  /** Meter numerator, counted in denominator note values per bar. */
  numerator: number;
  /** Meter denominator; 4 denotes a quarter note. */
  denominator: number;
}

export interface LinearBarWindow extends LinearBarPoint {
  /** Grid points at `division` steps per bar, aligned to bar 0 at axis beat 0. */
  grid(division: number): Generator<GridPoint>;
}

/** Bars counted forever from axis beat 0 — the timeline the app is showing. */
export class LinearBarRuler implements Ruler<LinearBarWindow, LinearBarPoint> {
  private readonly _numerator: number;
  private readonly _denominator: number;
  private readonly _beatsPerBar: number;

  constructor(options: LinearBarRulerOptions) {
    this._numerator = options.numerator;
    this._denominator = options.denominator;
    this._beatsPerBar = beatsPerBar(options.numerator, options.denominator);
  }

  /** Zero-based bar and beat-in-bar of axis `beat` for this ruler's meter. */
  at(beat: number): LinearBarPoint {
    const bar = Math.floor(beat / this._beatsPerBar);
    const beatInBar = beat - bar * this._beatsPerBar;
    return { bar, beatInBar, numerator: this._numerator, denominator: this._denominator };
  }

  /** The reading at the window's start beat plus `grid(division)` points over its beat range. */
  read(window: Pick<CoreTickWindow, "beat">, timeline: BeatTiming): LinearBarWindow {
    const point = this.at(window.beat.start);
    return {
      ...point,
      grid: (division: number) => gridPoints(window.beat.start, window.beat.end, this._beatsPerBar / division, 0, timeline),
    };
  }
}
