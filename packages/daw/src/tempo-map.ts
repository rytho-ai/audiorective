/** A step change at a musical beat in the project, rather than an AudioContext time. */
export type TempoChange = Readonly<{
  /** Project beat where the tempo starts; stored changes are positive, while setters accept 0 for the initial tempo. */
  beat: number;
  /** Positive finite tempo in quarter-note beats per minute. */
  bpm: number;
}>;

type Step = TempoChange & Readonly<{ seconds: number }>;

/**
 * Immutable conversion between musical beats and project seconds.
 *
 * This is deliberately not `@audiorective/clock`'s `TempoCurve`. They share only the
 * piecewise-constant integration:
 * - Domain: `TempoMap` is keyed by project beats (the Project model, the DAWproject codec and
 *   clip placement). `TempoCurve` is keyed by AudioContext seconds, for live transport playback.
 * - Mutability: `TempoMap` is immutable, so a Project snapshot or a file can hold one safely.
 *   `TempoCurve` is a mutable event list that is edited while playing.
 * - Layering: `daw/project` must not import `clock`, so the Node project-file tool does not
 *   load the scheduler.
 *
 * Numerical agreement with clock's tempo maths is guarded by
 * `tests/tempo-agreement.test.ts`, which feeds the same schedule to a clock `Timeline`.
 */
export class TempoMap {
  /** The tempo in quarter-note beats per minute before the first change; positive and finite. */
  readonly initialBpm: number;
  /** The tempo changes ordered by beat, each from a positive project beat on (a change at beat 0 is `initialBpm`); frozen. */
  readonly changes: readonly TempoChange[];
  private readonly steps: readonly Step[];

  constructor(initialBpm: number, changes: readonly TempoChange[] = []) {
    if (!Number.isFinite(initialBpm) || initialBpm <= 0) throw new RangeError("Project tempo needs positive finite BPM.");
    const ordered = changes.map(({ beat, bpm }) => Object.freeze({ beat, bpm })).sort((a, b) => a.beat - b.beat);
    if (
      ordered.some(
        (step, index) =>
          !Number.isFinite(step.beat) ||
          step.beat <= 0 ||
          !Number.isFinite(step.bpm) ||
          step.bpm <= 0 ||
          (index > 0 && step.beat === ordered[index - 1].beat),
      )
    )
      throw new RangeError("Project tempo changes need unique positive beats and BPM.");
    this.initialBpm = initialBpm;
    this.changes = Object.freeze(ordered);
    const steps: Step[] = [Object.freeze({ beat: 0, bpm: initialBpm, seconds: 0 })];
    for (const change of ordered) {
      const previous = steps[steps.length - 1];
      const seconds = previous.seconds + ((change.beat - previous.beat) * 60) / previous.bpm;
      if (!Number.isFinite(seconds)) throw new RangeError("Project tempo changes need unique positive beats and BPM.");
      steps.push(Object.freeze({ ...change, seconds }));
    }
    this.steps = Object.freeze(steps);
    Object.freeze(this);
  }

  private at(value: number, key: "beat" | "seconds"): Step {
    let lo = 0;
    let hi = this.steps.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.steps[mid][key] <= value) lo = mid;
      else hi = mid - 1;
    }
    return this.steps[lo];
  }

  /** The tempo in BPM in force at a project beat (0 or more); a change applies from its own beat. Throws `RangeError` for a negative or non-finite beat. */
  bpmAtBeat(beat: number): number {
    if (!Number.isFinite(beat) || beat < 0) throw new RangeError("Project beat needs a finite non-negative value.");
    return this.at(beat, "beat").bpm;
  }

  /** Project seconds (from the song start) at which a project beat (0 or more) falls, through every tempo change before it. Throws `RangeError` for a negative or non-finite beat. */
  beatToSeconds(beat: number): number {
    if (!Number.isFinite(beat) || beat < 0) throw new RangeError("Project beat needs a finite non-negative value.");
    const step = this.at(beat, "beat");
    return step.seconds + ((beat - step.beat) * 60) / step.bpm;
  }

  /** The project beat (fractional, 0 or more) at a project time in seconds from the song start; the inverse of `beatToSeconds`. Throws `RangeError` for negative or non-finite seconds. */
  secondsToBeat(seconds: number): number {
    if (!Number.isFinite(seconds) || seconds < 0) throw new RangeError("Project time needs finite non-negative seconds.");
    const step = this.at(seconds, "seconds");
    return step.beat + ((seconds - step.seconds) * step.bpm) / 60;
  }

  /** Project seconds of the nearest multiple of `beats` (default 1, a quarter note; positive) to a time in seconds, never below 0; halves round up. Throws `RangeError` for a non-positive interval. */
  snapSeconds(seconds: number, beats = 1): number {
    if (!Number.isFinite(beats) || beats <= 0) throw new RangeError("Project snap needs a positive beat interval.");
    return this.beatToSeconds(Math.max(0, Math.round(this.secondsToBeat(Math.max(0, seconds)) / beats) * beats));
  }
}
