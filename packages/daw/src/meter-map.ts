/** A time signature that starts at a musical beat, rather than an AudioContext time. */
export type TimeSignatureChange = Readonly<{ beat: number; numerator: number; denominator: number }>;

type Segment = Readonly<{ beat: number; numerator: number; denominator: number; startBar: number; barBeats: number }>;

const EPS = 1e-9;
const validSignature = (numerator: number, denominator: number) =>
  Number.isInteger(numerator) && numerator > 0 && Number.isInteger(denominator) && denominator > 0 && (denominator & (denominator - 1)) === 0;

/**
 * Immutable bar arithmetic over the song's time signatures, in project beats (quarter notes).
 * A change starts a new bar where it sits, so a change inside a bar cuts that bar short. Bars count from 1.
 * It is independent of the tempo map: bars and beats do not depend on BPM.
 */
export class MeterMap {
  readonly initial: readonly [number, number];
  readonly changes: readonly TimeSignatureChange[];
  private readonly segments: readonly Segment[];

  constructor(initial: readonly [number, number], changes: readonly TimeSignatureChange[] = []) {
    const invalid = () => new RangeError("Project time signatures need unique positive beats, an integer numerator and a power-of-two denominator.");
    if (!validSignature(initial[0], initial[1])) throw invalid();
    const ordered = changes
      .map(({ beat, numerator, denominator }) => Object.freeze({ beat, numerator, denominator }))
      .sort((a, b) => a.beat - b.beat);
    if (
      ordered.some(
        (step, index) =>
          !Number.isFinite(step.beat) ||
          step.beat <= 0 ||
          !validSignature(step.numerator, step.denominator) ||
          (index > 0 && step.beat === ordered[index - 1].beat),
      )
    )
      throw invalid();
    this.initial = Object.freeze([initial[0], initial[1]] as [number, number]);
    this.changes = Object.freeze(ordered);
    const segments: Segment[] = [
      Object.freeze({ beat: 0, numerator: initial[0], denominator: initial[1], startBar: 1, barBeats: (initial[0] * 4) / initial[1] }),
    ];
    for (const change of ordered) {
      const last = segments[segments.length - 1];
      const bars = Math.ceil((change.beat - last.beat) / last.barBeats - EPS);
      segments.push(Object.freeze({ ...change, startBar: last.startBar + bars, barBeats: (change.numerator * 4) / change.denominator }));
    }
    this.segments = Object.freeze(segments);
    Object.freeze(this);
  }

  private at(beat: number): Segment {
    let found = this.segments[0];
    for (const segment of this.segments) {
      if (segment.beat <= beat + EPS) found = segment;
      else break;
    }
    return found;
  }

  /** The `[numerator, denominator]` in force at `beat`. */
  signatureAtBeat(beat: number): readonly [number, number] {
    if (!Number.isFinite(beat) || beat < 0) throw new RangeError("Project beat needs a finite non-negative value.");
    const { numerator, denominator } = this.at(beat);
    return [numerator, denominator];
  }

  /** Quarter-note beats in the bar that contains `beat`. */
  barBeatsAt(beat: number): number {
    if (!Number.isFinite(beat) || beat < 0) throw new RangeError("Project beat needs a finite non-negative value.");
    return this.at(beat).barBeats;
  }

  /** The bar (counting from 1) holding `beat`, with the quarter-note beats since that bar began and the bar's own start beat. */
  beatToBar(beat: number): Readonly<{ bar: number; beatInBar: number; barStart: number }> {
    if (!Number.isFinite(beat) || beat < 0) throw new RangeError("Project beat needs a finite non-negative value.");
    const segment = this.at(beat);
    const whole = Math.floor((beat - segment.beat) / segment.barBeats + EPS);
    const barStart = segment.beat + whole * segment.barBeats;
    return { bar: segment.startBar + whole, beatInBar: Math.max(0, beat - barStart), barStart };
  }

  /** The beat where bar `bar` (an integer from 1) starts. */
  barToBeat(bar: number): number {
    if (!Number.isInteger(bar) || bar < 1) throw new RangeError("Project bars count from 1 as integers.");
    let found = this.segments[0];
    for (const segment of this.segments) {
      if (segment.startBar <= bar) found = segment;
      else break;
    }
    return found.beat + (bar - found.startBar) * found.barBeats;
  }

  /** The first bar line at or after `beat`. */
  ceilToBar(beat: number): number {
    const { barStart, beatInBar, bar } = this.beatToBar(beat);
    return beatInBar > EPS ? this.barToBeat(bar + 1) : barStart;
  }
}
