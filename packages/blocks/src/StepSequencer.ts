import { batch, cell, readonlyCell, untracked, type BeatTiming, type CancellableEvent, type ReadonlyCell } from "@audiorective/core";

export type StepRate = "1/2" | "1/4" | "1/8" | "1/16" | "1/32" | "1/64" | "1/2T" | "1/4T" | "1/8T" | "1/16T" | "1/32T" | "1/64T";
export type StepDirection = "forward" | "backward" | "bounce";

/** One step of one lane. `velocity` 0 means the step is off. */
export type StepCell = Readonly<{
  /** 0..1; 0 = step off. */
  velocity: number;
  /** -0.5..0.5 of one lane step. */
  offset: number;
  /** 1/16..4 lane steps. */
  length: number;
  /** Integer 1..8: hits evenly spaced inside the step. */
  repeat: number;
  /** Integer semitones -24..24. */
  pitch: number;
  /** 0..1 probability that the step plays. */
  chance: number;
}>;

export type StepLane = Readonly<{
  id: string;
  label: string;
  /** Integer 1..size: this lane's own length (polymeter). */
  steps: number;
  rate: StepRate;
  direction: StepDirection;
  /** 0..1: delays every odd lane step by `swing * 0.5` lane steps. */
  swing: number;
  mute: boolean;
  solo: boolean;
  /** Length is `pattern.size`; cells beyond `steps` are kept but not played. */
  cells: readonly StepCell[];
}>;

/** `size` counts 1/16 steps (integer 1..128) and sets the loop length. */
export type StepPattern = Readonly<{ size: number; lanes: readonly StepLane[] }>;

export type StepCellInput = Partial<StepCell>;
export type StepLaneInput = Readonly<Partial<Omit<StepLane, "cells">> & { id: string; cells?: readonly StepCellInput[] }>;
export type StepPatternInput = Readonly<{ size: number; lanes: readonly StepLaneInput[] }>;

export type StepHit = Readonly<{
  laneId: string;
  /** Index of the cell that produced this hit. */
  step: number;
  velocity: number;
  /** Semitones. */
  pitch: number;
  /** Absolute audio-context seconds. */
  when: number;
  /** Seconds. */
  duration: number;
  repeatIndex: number;
  repeatCount: number;
}>;

export type StepWindow = Readonly<{
  beat: { start: number; end: number };
  time: { current: number };
  own(event: CancellableEvent, when: number): void;
}>;

export type StepSequencerOptions = Readonly<{
  /** Source of chance draws in [0, 1). Default `Math.random`. */
  random?: () => number;
}>;

const MAX_SIZE = 128;
const EPS = 1e-9;
const RATE_BEATS: Readonly<Record<StepRate, number>> = {
  "1/2": 2,
  "1/4": 1,
  "1/8": 0.5,
  "1/16": 0.25,
  "1/32": 0.125,
  "1/64": 0.0625,
  "1/2T": (2 * 2) / 3,
  "1/4T": 2 / 3,
  "1/8T": 1 / 3,
  "1/16T": 1 / 6,
  "1/32T": 1 / 12,
  "1/64T": 1 / 24,
};
const DIRECTIONS: readonly StepDirection[] = ["forward", "backward", "bounce"];
const DEFAULT_CELL: StepCell = Object.freeze({ velocity: 0, offset: 0, length: 1, repeat: 1, pitch: 0, chance: 1 });

const SIZE_ERROR = "Step Sequencer needs an integer size from 1 to 128.";
const LANES_ERROR = "Step Sequencer needs lanes with unique, nonempty IDs.";
const LANE_ERROR =
  "Step Sequencer lane needs steps from 1 to the pattern size, a known rate and direction, swing from 0 to 1, boolean mute and solo, and at most size cells.";
const CELL_ERROR =
  "Step Sequencer cell needs velocity and chance from 0 to 1, offset from -0.5 to 0.5, length from 1/16 to 4, an integer repeat from 1 to 8 and an integer pitch from -24 to 24.";
const TARGET_ERROR = "Step Sequencer needs an existing lane and step.";
const LANE_TARGET_ERROR = "Step Sequencer needs an existing lane.";

const inRange = (value: number, min: number, max: number) => typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
const inRangeInt = (value: number, min: number, max: number) => inRange(value, min, max) && Number.isInteger(value);
const validSize = (size: number) => inRangeInt(size, 1, MAX_SIZE);

function makeCell(base: StepCell, patch: StepCellInput): StepCell {
  const next = { ...base };
  for (const key of Object.keys(DEFAULT_CELL) as (keyof StepCell)[]) if (patch[key] !== undefined) next[key] = patch[key];
  if (
    !inRange(next.velocity, 0, 1) ||
    !inRange(next.chance, 0, 1) ||
    !inRange(next.offset, -0.5, 0.5) ||
    !inRange(next.length, 1 / 16, 4) ||
    !inRangeInt(next.repeat, 1, 8) ||
    !inRangeInt(next.pitch, -24, 24)
  )
    throw new Error(CELL_ERROR);
  return Object.freeze(next);
}

type LaneFields = Omit<StepLane, "id" | "cells">;

function makeLaneFields(base: LaneFields, patch: Partial<LaneFields>, size: number): LaneFields {
  const next = { ...base };
  for (const key of ["label", "steps", "rate", "direction", "swing", "mute", "solo"] as const) {
    if (patch[key] !== undefined) (next as Record<string, unknown>)[key] = patch[key];
  }
  if (
    typeof next.label !== "string" ||
    !inRangeInt(next.steps, 1, size) ||
    !Object.hasOwn(RATE_BEATS, next.rate) ||
    !DIRECTIONS.includes(next.direction) ||
    !inRange(next.swing, 0, 1) ||
    typeof next.mute !== "boolean" ||
    typeof next.solo !== "boolean"
  )
    throw new Error(LANE_ERROR);
  return next;
}

function buildPattern(input: StepPatternInput): StepPattern {
  if (!input || !validSize(input.size)) throw new Error(SIZE_ERROR);
  const { size } = input;
  const ids = new Set<string>();
  const lanes = input.lanes.map((lane) => {
    if (!lane.id || typeof lane.id !== "string" || ids.has(lane.id)) throw new Error(LANES_ERROR);
    ids.add(lane.id);
    const supplied = lane.cells ?? [];
    if (supplied.length > size) throw new Error(LANE_ERROR);
    const fields = makeLaneFields(
      { label: lane.id, steps: size, rate: "1/16", direction: "forward", swing: 0, mute: false, solo: false },
      lane,
      size,
    );
    const cells = Array.from({ length: size }, (_, index) => makeCell(DEFAULT_CELL, supplied[index] ?? {}));
    return Object.freeze({ id: lane.id, ...fields, cells: Object.freeze(cells) });
  });
  return Object.freeze({ size, lanes: Object.freeze(lanes) });
}

/** Cell index played by lane step counter `k`. */
function cellIndex(direction: StepDirection, steps: number, k: number): number {
  if (direction === "forward") return k % steps;
  if (direction === "backward") return steps - 1 - (k % steps);
  if (steps === 1) return 0;
  const q = k % (2 * steps - 2);
  return q < steps ? q : 2 * steps - 2 - q;
}

/**
 * An editable looping pattern over a borrowed beat transport and instrument trigger.
 * Each lane has its own length, rate, direction and swing; each cell its own velocity, offset, length, repeat, pitch and chance.
 */
export class StepSequencer {
  private readonly data;
  private readonly heads;
  private readonly progress;
  private readonly events = new Set<CancellableEvent>();
  private readonly random: () => number;
  readonly pattern: ReadonlyCell<StepPattern>;
  /** Current cell index per lane, or `null` when stopped. */
  readonly playheads: ReadonlyCell<Readonly<Record<string, number | null>>>;
  /** 0..1 position in the loop, or `null` when stopped. */
  readonly loopProgress: ReadonlyCell<number | null>;

  constructor(
    pattern: StepPatternInput,
    private readonly trigger: (hit: StepHit) => CancellableEvent | null,
    options: StepSequencerOptions = {},
  ) {
    const built = buildPattern(pattern);
    this.random = options.random ?? Math.random;
    this.data = cell<StepPattern>(built);
    this.heads = cell<Readonly<Record<string, number | null>>>(this.stopped(built));
    this.progress = cell<number | null>(null);
    this.pattern = readonlyCell(this.data);
    this.playheads = readonlyCell(this.heads);
    this.loopProgress = readonlyCell(this.progress);
  }

  private stopped(pattern: StepPattern): Readonly<Record<string, number | null>> {
    return Object.freeze(Object.fromEntries(pattern.lanes.map(({ id }) => [id, null])));
  }

  private laneIndex(pattern: StepPattern, laneId: string): number {
    return pattern.lanes.findIndex(({ id }) => id === laneId);
  }

  private replaceLane(pattern: StepPattern, index: number, lane: StepLane): StepPattern {
    return Object.freeze({ ...pattern, lanes: Object.freeze(pattern.lanes.map((item, i) => (i === index ? lane : item))) });
  }

  /** Change fields of one cell. Unknown lane or step, and out-of-range values, throw. */
  setCell(laneId: string, step: number, patch: StepCellInput): void {
    untracked(() => {
      const pattern = this.data.value;
      const index = this.laneIndex(pattern, laneId);
      if (index < 0 || !Number.isInteger(step) || step < 0 || step >= pattern.size) throw new Error(TARGET_ERROR);
      const lane = pattern.lanes[index];
      const before = lane.cells[step];
      const after = makeCell(before, patch);
      if ((Object.keys(after) as (keyof StepCell)[]).every((key) => after[key] === before[key])) return;
      const cells = Object.freeze(lane.cells.map((item, i) => (i === step ? after : item)));
      this.data.value = this.replaceLane(pattern, index, Object.freeze({ ...lane, cells }));
    });
  }

  /** An off cell turns on at velocity 1; an on cell turns off. Other fields are kept. */
  toggle(laneId: string, step: number): void {
    untracked(() => {
      const pattern = this.data.value;
      const lane = pattern.lanes.find(({ id }) => id === laneId);
      if (!lane || !Number.isInteger(step) || step < 0 || step >= pattern.size) throw new Error(TARGET_ERROR);
      this.setCell(laneId, step, { velocity: lane.cells[step].velocity > 0 ? 0 : 1 });
    });
  }

  /** Change lane fields (`label`, `steps`, `rate`, `direction`, `swing`, `mute`, `solo`) in one write. */
  setLane(laneId: string, patch: Partial<Omit<StepLane, "id" | "cells">>): void {
    untracked(() => {
      const pattern = this.data.value;
      const index = this.laneIndex(pattern, laneId);
      if (index < 0) throw new Error(LANE_TARGET_ERROR);
      const lane = pattern.lanes[index];
      const { id, cells, ...fields } = lane;
      const next = makeLaneFields(fields, patch, pattern.size);
      if ((Object.keys(next) as (keyof LaneFields)[]).every((key) => next[key] === fields[key])) return;
      this.data.value = this.replaceLane(pattern, index, Object.freeze({ id, ...next, cells }));
    });
  }

  /** Resize the loop: every lane's cells are truncated or padded with off cells, and each lane's `steps` is clamped. */
  setSize(size: number): void {
    untracked(() => {
      if (!validSize(size)) throw new Error(SIZE_ERROR);
      const pattern = this.data.value;
      if (size === pattern.size) return;
      const lanes = pattern.lanes.map((lane) =>
        Object.freeze({
          ...lane,
          steps: Math.min(lane.steps, size),
          cells: Object.freeze(Array.from({ length: size }, (_, i) => lane.cells[i] ?? DEFAULT_CELL)),
        }),
      );
      batch(() => {
        this.data.value = Object.freeze({ size, lanes: Object.freeze(lanes) });
      });
    });
  }

  /** Register this window's hits with `window.own`. Reads `timing` for beat/time mapping; pass the Timeline the window came from. */
  schedule(window: StepWindow, timing: BeatTiming): void {
    untracked(() => {
      const pattern = this.data.value;
      const loopBeats = pattern.size * 0.25;
      const now = window.time.current;
      const soloed = pattern.lanes.some((lane) => lane.solo);
      const firstLoop = Math.floor(Math.max(0, window.beat.start) / loopBeats + EPS);
      const endLoop = Math.ceil(window.beat.end / loopBeats - EPS);
      for (let loop = firstLoop; loop < endLoop; loop++) {
        const loopStart = loop * loopBeats;
        for (const lane of pattern.lanes) {
          if (lane.mute || (soloed && !lane.solo)) continue;
          const rate = RATE_BEATS[lane.rate];
          const count = Math.ceil(loopBeats / rate - EPS);
          const first = Math.max(0, Math.ceil((window.beat.start - loopStart) / rate - EPS));
          const end = Math.min(count, Math.ceil((window.beat.end - loopStart) / rate - EPS));
          for (let k = first; k < end; k++) {
            const step = cellIndex(lane.direction, lane.steps, k);
            const cellData = lane.cells[step];
            if (cellData.velocity <= 0 || !(this.random() < cellData.chance)) continue;
            const trigger = loopStart + k * rate + (k % 2 === 1 ? lane.swing * 0.5 * rate : 0) + cellData.offset * rate;
            for (let repeat = 0; repeat < cellData.repeat; repeat++) {
              const start = trigger + (repeat * rate) / cellData.repeat;
              const when = Math.max(timing.beatToTime(start), now);
              const duration = timing.beatToTime(start + (cellData.length * rate) / cellData.repeat) - timing.beatToTime(start);
              const event = this.trigger({
                laneId: lane.id,
                step,
                velocity: cellData.velocity,
                pitch: cellData.pitch,
                when,
                duration,
                repeatIndex: repeat,
                repeatCount: cellData.repeat,
              });
              if (!event) continue;
              this.events.add(event);
              event.onEnded(() => this.events.delete(event));
              window.own(event, when);
            }
          }
        }
      }
      this.publishPosition(pattern, timing.timeToBeat(now), loopBeats);
    });
  }

  private publishPosition(pattern: StepPattern, beat: number, loopBeats: number): void {
    const inLoop = (((Math.max(0, beat) % loopBeats) + loopBeats) % loopBeats) / loopBeats;
    const heads: Record<string, number | null> = {};
    for (const lane of pattern.lanes) {
      const rate = RATE_BEATS[lane.rate];
      const count = Math.ceil(loopBeats / rate - EPS);
      const k = Math.min(count - 1, Math.floor((inLoop * loopBeats) / rate + EPS));
      heads[lane.id] = cellIndex(lane.direction, lane.steps, k);
    }
    const previous = this.heads.value;
    const same = pattern.lanes.every(({ id }) => previous[id] === heads[id]);
    batch(() => {
      if (!same) this.heads.value = Object.freeze(heads);
      this.progress.value = inLoop;
    });
  }

  /** Cancel only this pattern's events and clear its playheads. */
  reset(): void {
    untracked(() => {
      for (const event of [...this.events]) event.cancel();
      this.events.clear();
      batch(() => {
        this.heads.value = this.stopped(this.data.value);
        this.progress.value = null;
      });
    });
  }
}
