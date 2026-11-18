/** A step change at a musical beat in the project, rather than an AudioContext time. */
export type TempoChange = Readonly<{ beat: number; bpm: number }>;

type Step = TempoChange & Readonly<{ seconds: number }>;

/** Immutable conversion between musical beats and project seconds. */
export class TempoMap {
  readonly initialBpm: number;
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

  bpmAtBeat(beat: number): number {
    if (!Number.isFinite(beat) || beat < 0) throw new RangeError("Project beat needs a finite non-negative value.");
    return this.at(beat, "beat").bpm;
  }

  beatToSeconds(beat: number): number {
    if (!Number.isFinite(beat) || beat < 0) throw new RangeError("Project beat needs a finite non-negative value.");
    const step = this.at(beat, "beat");
    return step.seconds + ((beat - step.beat) * 60) / step.bpm;
  }

  secondsToBeat(seconds: number): number {
    if (!Number.isFinite(seconds) || seconds < 0) throw new RangeError("Project time needs finite non-negative seconds.");
    const step = this.at(seconds, "seconds");
    return step.beat + ((seconds - step.seconds) * step.bpm) / 60;
  }

  snapSeconds(seconds: number, beats = 1): number {
    if (!Number.isFinite(beats) || beats <= 0) throw new RangeError("Project snap needs a positive beat interval.");
    return this.beatToSeconds(Math.max(0, Math.round(this.secondsToBeat(Math.max(0, seconds)) / beats) * beats));
  }
}
