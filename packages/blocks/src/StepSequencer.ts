import {
  applyEventTransforms,
  batch,
  cell,
  effect,
  readonlyCell,
  untracked,
  type BeatTiming,
  type CancellableEvent,
  type EventTransform,
  type ParamSpec,
  type ReadonlyCell,
  type TimedEvent,
} from "@audiorective/core";

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
  /** One number per declared `params` entry, and nothing else. `{}` when none are declared. */
  custom: Readonly<Record<string, number>>;
}>;

/** A caller-defined per-step number. The sequencer stores and validates it and passes it to the trigger; it never interprets it. */
export type StepParamSpec = ParamSpec;

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

export type StepCellInput = Readonly<Partial<Omit<StepCell, "custom">> & { custom?: Readonly<Record<string, number>> }>;
export type StepLaneInput = Readonly<Partial<Omit<StepLane, "cells">> & { id: string; cells?: readonly StepCellInput[] }>;
export type StepPatternInput = Readonly<{ size: number; lanes: readonly StepLaneInput[] }>;

/** One hit before the transforms run. `when` and `duration` are absolute audio-context seconds and seconds. */
export type StepHit = TimedEvent &
  Readonly<{
    laneId: string;
    /** Index of the cell that produced this hit. */
    step: number;
    /** The lane's step counter within the loop (before direction is applied). */
    count: number;
    /** Beat of the lane step boundary, before offset, repeat and any transform. */
    beat: number;
    /** The lane's step length in beats. */
    rateBeats: number;
    /** The lane's swing value (0..1). */
    swing: number;
    /** Semitones. */
    pitch: number;
    /** The cell's custom values. */
    custom: Readonly<Record<string, number>>;
    /** Loops since timing beat 0: `floor(beat / loopBeats)`. */
    loop: number;
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
  /** Custom per-step parameters, fixed at construction. */
  params?: readonly StepParamSpec[];
  /** Transforms run in order over each window's hits. Default `defaultStepTransforms`. */
  transforms?: readonly EventTransform<StepHit>[];
}>;

/** Delays every hit whose lane step count is odd by `swing * 0.5` lane steps. Without it, lane `swing` has no effect. */
export function stepSwing(): EventTransform<StepHit> {
  return {
    id: "step-swing",
    apply: (events, { timing }) =>
      events.map((hit) =>
        hit.count % 2 === 1 && hit.swing > 0
          ? { ...hit, when: hit.when + timing.beatToTime(hit.beat + hit.swing * 0.5 * hit.rateBeats) - timing.beatToTime(hit.beat) }
          : hit,
      ),
  };
}

/**
 * Re-queue the transport's look-ahead once per committed change of `sequencer.pattern` or `sequencer.transforms`.
 * Does not run on attach, and never subscribes a calling effect. Returns a disposer; call it before the transport goes away.
 * `transport` is structural: a Clock, a Workspace clock or anything with `refresh()`.
 */
export function refreshOnEdit(sequencer: Pick<StepSequencer, "pattern" | "transforms">, transport: { refresh(): void }): () => void {
  let armed = false;
  return untracked(() =>
    effect(() => {
      sequencer.pattern.$();
      sequencer.transforms.$();
      if (!armed) {
        armed = true;
        return;
      }
      untracked(() => transport.refresh());
    }),
  );
}

export const defaultStepTransforms: readonly EventTransform<StepHit>[] = Object.freeze([stepSwing()]);

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
/** The built-in cell fields as data, in display order: the one source for validation and for views. Same shape as a custom `StepParamSpec`. */
export const stepCellParams: readonly StepParamSpec[] = Object.freeze(
  [
    { id: "velocity", label: "Velocity", min: 0, max: 1, default: 0, step: 0.01 },
    { id: "offset", label: "Offset", min: -0.5, max: 0.5, default: 0, step: 0.01 },
    { id: "length", label: "Length", min: 1 / 16, max: 4, default: 1, step: 1 / 16 },
    { id: "repeat", label: "Repeat", min: 1, max: 8, default: 1, step: 1 },
    { id: "pitch", label: "Pitch", min: -24, max: 24, default: 0, step: 1 },
    { id: "chance", label: "Chance", min: 0, max: 1, default: 1, step: 0.01 },
  ].map((spec) => Object.freeze(spec)),
);
/** The twelve lane rates in display order: straight from 1/2 down to 1/64, then the triplets. */
export const stepRates: readonly StepRate[] = Object.freeze(Object.keys(RATE_BEATS) as StepRate[]);
const BUILTIN_KEYS = stepCellParams.map((spec) => spec.id) as (keyof StepCell & string)[];
const BUILTIN_CELL = Object.fromEntries(stepCellParams.map((spec) => [spec.id, spec.default])) as Omit<StepCell, "custom">;
/** Built-in fields that only take whole numbers. */
const INTEGER_KEYS: ReadonlySet<string> = new Set(["repeat", "pitch"]);

const SIZE_ERROR = "Step Sequencer needs an integer size from 1 to 128.";
const LANES_ERROR = "Step Sequencer needs lanes with unique, nonempty IDs.";
const LANE_ERROR =
  "Step Sequencer lane needs steps from 1 to the pattern size, a known rate and direction, swing from 0 to 1, boolean mute and solo, and at most size cells.";
const CELL_ERROR =
  "Step Sequencer cell needs velocity and chance from 0 to 1, offset from -0.5 to 0.5, length from 1/16 to 4, an integer repeat from 1 to 8 and an integer pitch from -24 to 24.";
const PARAMS_ERROR =
  "Step Sequencer params need unique nonempty ids that differ from the built-in cell keys (and from custom), a finite min below max, and a default from min to max.";
const CUSTOM_ERROR = "Step Sequencer custom values need declared param ids and finite numbers from each param's min to max.";
const TRANSFORMS_ERROR = "Step Sequencer transforms need an array of objects that each have a nonempty string id and an apply function.";
const TARGET_ERROR = "Step Sequencer needs an existing lane and step.";
const LANE_TARGET_ERROR = "Step Sequencer needs an existing lane.";

const inRange = (value: number, min: number, max: number) => typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
const inRangeInt = (value: number, min: number, max: number) => inRange(value, min, max) && Number.isInteger(value);
const validSize = (size: number) => inRangeInt(size, 1, MAX_SIZE);

function buildParams(params: readonly StepParamSpec[] | undefined): readonly StepParamSpec[] {
  if (params === undefined) return Object.freeze([]);
  if (!Array.isArray(params)) throw new Error(PARAMS_ERROR);
  const ids = new Set<string>();
  for (const spec of params) {
    if (
      !spec ||
      typeof spec.id !== "string" ||
      !spec.id ||
      ids.has(spec.id) ||
      spec.id === "custom" ||
      (BUILTIN_KEYS as readonly string[]).includes(spec.id) ||
      !Number.isFinite(spec.min) ||
      !Number.isFinite(spec.max) ||
      !(spec.min < spec.max) ||
      !inRange(spec.default, spec.min, spec.max)
    )
      throw new Error(PARAMS_ERROR);
    ids.add(spec.id);
  }
  return Object.freeze(params.map((spec) => Object.freeze({ ...spec })));
}

function makeCell(base: StepCell, patch: StepCellInput, specs: readonly StepParamSpec[]): StepCell {
  const next: Record<string, unknown> = { ...base };
  for (const key of BUILTIN_KEYS) if (patch[key] !== undefined) next[key] = patch[key];
  for (const { id, min, max } of stepCellParams) {
    if (!(INTEGER_KEYS.has(id) ? inRangeInt : inRange)(next[id] as number, min, max)) throw new Error(CELL_ERROR);
  }
  if (patch.custom !== undefined) {
    if (typeof patch.custom !== "object" || patch.custom === null) throw new Error(CUSTOM_ERROR);
    const custom: Record<string, number> = { ...base.custom };
    for (const [id, value] of Object.entries(patch.custom)) {
      const spec = specs.find((item) => item.id === id);
      if (!spec || !inRange(value, spec.min, spec.max)) throw new Error(CUSTOM_ERROR);
      custom[id] = value;
    }
    next.custom = Object.freeze(custom);
  }
  return Object.freeze(next) as StepCell;
}

const sameCell = (a: StepCell, b: StepCell) =>
  BUILTIN_KEYS.every((key) => a[key] === b[key]) && Object.keys(a.custom).every((id) => a.custom[id] === b.custom[id]);

type LaneFields = Omit<StepLane, "id" | "cells">;

function makeLaneFields(base: LaneFields, patch: Partial<LaneFields>, size: number): LaneFields {
  const next = { ...base };
  for (const key of ["label", "steps", "rate", "direction", "swing", "mute", "solo"] as const) {
    if (patch[key] !== undefined) (next as Record<string, unknown>)[key] = patch[key];
  }
  if (
    typeof next.label !== "string" ||
    !inRangeInt(next.steps, 1, size) ||
    !stepRates.includes(next.rate) ||
    !DIRECTIONS.includes(next.direction) ||
    !inRange(next.swing, 0, 1) ||
    typeof next.mute !== "boolean" ||
    typeof next.solo !== "boolean"
  )
    throw new Error(LANE_ERROR);
  return next;
}

function buildPattern(input: StepPatternInput, specs: readonly StepParamSpec[], blank: StepCell): StepPattern {
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
    const cells = Array.from({ length: size }, (_, index) => makeCell(blank, supplied[index] ?? {}, specs));
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
 * Each lane has its own length, rate, direction and swing; each cell its own velocity, offset, length, repeat, pitch, chance and caller-declared custom values.
 * Swing and any other timing plug-in run as `transforms` over each window's hits.
 */
export class StepSequencer {
  private readonly data;
  private readonly heads;
  private readonly progress;
  private readonly events = new Set<CancellableEvent>();
  private readonly random: () => number;
  private readonly blank: StepCell;
  private readonly tf;
  /** The built-in cell fields as data (same objects as `stepCellParams`), for views that edit cells. */
  readonly cellParams: readonly StepParamSpec[] = stepCellParams;
  /** The lane rates in display order (same list as `stepRates`). */
  readonly rates: readonly StepRate[] = stepRates;
  /** Custom per-step parameters declared at construction. */
  readonly params: readonly StepParamSpec[];
  /** Transforms run, in order, over each window's hits. Replace with `setTransforms`. */
  readonly transforms: ReadonlyCell<readonly EventTransform<StepHit>[]>;
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
    this.params = buildParams(options.params);
    this.blank = Object.freeze({
      ...BUILTIN_CELL,
      custom: Object.freeze(Object.fromEntries(this.params.map((spec) => [spec.id, spec.default]))),
    });
    const built = buildPattern(pattern, this.params, this.blank);
    this.random = options.random ?? Math.random;
    this.tf = cell<readonly EventTransform<StepHit>[]>(this.checkTransforms(options.transforms ?? defaultStepTransforms));
    this.transforms = readonlyCell(this.tf);
    this.data = cell<StepPattern>(built);
    this.heads = cell<Readonly<Record<string, number | null>>>(this.stopped(built));
    this.progress = cell<number | null>(null);
    this.pattern = readonlyCell(this.data);
    this.playheads = readonlyCell(this.heads);
    this.loopProgress = readonlyCell(this.progress);
  }

  private checkTransforms(list: readonly EventTransform<StepHit>[]): readonly EventTransform<StepHit>[] {
    if (!Array.isArray(list) || list.some((item) => !item || typeof item.id !== "string" || !item.id || typeof item.apply !== "function"))
      throw new Error(TRANSFORMS_ERROR);
    return Object.freeze([...list]);
  }

  /** Replace the transform list in one write. Compose with `[...defaultStepTransforms, mine]` to keep swing. */
  setTransforms(list: readonly EventTransform<StepHit>[]): void {
    untracked(() => {
      this.tf.value = this.checkTransforms(list);
    });
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
      const after = makeCell(before, patch, this.params);
      if (sameCell(after, before)) return;
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
          cells: Object.freeze(Array.from({ length: size }, (_, i) => lane.cells[i] ?? this.blank)),
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
      const planned: StepHit[] = [];
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
            const beat = loopStart + k * rate;
            const trigger = beat + cellData.offset * rate;
            for (let repeat = 0; repeat < cellData.repeat; repeat++) {
              const start = trigger + (repeat * rate) / cellData.repeat;
              planned.push({
                laneId: lane.id,
                step,
                count: k,
                beat,
                rateBeats: rate,
                swing: lane.swing,
                velocity: cellData.velocity,
                pitch: cellData.pitch,
                custom: cellData.custom,
                loop,
                when: timing.beatToTime(start),
                duration: timing.beatToTime(start + (cellData.length * rate) / cellData.repeat) - timing.beatToTime(start),
                repeatIndex: repeat,
                repeatCount: cellData.repeat,
              });
            }
          }
        }
      }
      // The scheduler, not the transforms, validates, clamps to `now`, triggers and owns every output.
      for (const hit of applyEventTransforms(planned, this.tf.value, { now, timing, random: this.random })) {
        const event = this.trigger(hit);
        if (!event) continue;
        this.events.add(event);
        event.onEnded(() => this.events.delete(event));
        window.own(event, hit.when);
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
