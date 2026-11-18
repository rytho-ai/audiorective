export type LoopRange = Readonly<{ start: number; end: number }>;

/** A half-open window on the source range and its matching absolute audio time. */
export type LoopSlice = Readonly<{ cycle: number; start: number; end: number; when: number }>;

/** Map one shared source interval onto a continuously advancing audio clock. */
export class RangeLoop {
  readonly range: LoopRange;
  readonly duration: number;

  constructor(
    range: LoopRange,
    readonly when: number,
  ) {
    this.duration = range.end - range.start;
    if (
      !Number.isFinite(range.start) ||
      range.start < 0 ||
      !Number.isFinite(this.duration) ||
      this.duration <= 0 ||
      !Number.isFinite(when) ||
      when < 0
    ) {
      throw new RangeError("RangeLoop needs increasing finite source seconds and a non-negative audio start.");
    }
    this.range = Object.freeze({ start: range.start, end: range.end });
  }

  /** Split the supplied scheduling window at repeat boundaries without moving the transport. */
  *slices(audioStart: number, audioEnd: number): IterableIterator<LoopSlice> {
    if (!Number.isFinite(audioStart) || !Number.isFinite(audioEnd)) throw new RangeError("RangeLoop window needs finite audio seconds.");
    const from = Math.max(audioStart, this.when);
    if (from >= audioEnd) return;
    const firstCycle = Math.floor((from - this.when) / this.duration);
    for (let cycle = firstCycle; ; cycle++) {
      const cycleStart = this.when + cycle * this.duration;
      const cycleEnd = this.when + (cycle + 1) * this.duration;
      if (cycleStart >= audioEnd) return;
      if (!Number.isSafeInteger(cycle) || cycleEnd <= cycleStart) throw new RangeError("RangeLoop period is below audio time precision.");
      const when = Math.max(from, cycleStart);
      const until = Math.min(audioEnd, cycleEnd);
      if (when >= until) continue;
      yield {
        cycle,
        when,
        start: when === cycleStart ? this.range.start : this.range.start + (when - cycleStart),
        end: until === cycleEnd ? this.range.end : this.range.start + (until - cycleStart),
      };
    }
  }
}
