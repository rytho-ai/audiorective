import {
  applyEventTransforms,
  batch,
  cell,
  effect,
  hash01,
  readonlyCell,
  untracked,
  type BeatTiming,
  type CancellableEvent,
  type EventTransform,
  type ParamSpec,
  type ReadonlyCell,
  type SecondsOf,
  type TimedBeatEvent,
} from "@audiorective/core";
import { describePattern, parsePattern, parseSwing, parseTime, type Pattern, type Time } from "./notation";
import { assertSound, playSound, type Sound } from "./sounds";

export type { NoteName, Pattern, Time } from "./notation";
export type { Sound, SoundFactory } from "./sounds";

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

/**
 * One hit inside the transform pipeline. `beat` is where it sounds and `durationBeats` how long it lasts, in beats,
 * with offset and repeat already applied; transforms move and resize it in beats. The trigger receives its `StepHit`.
 */
export type StepEvent = TimedBeatEvent &
  Readonly<{
    laneId: string;
    /** Index of the cell that produced this hit. */
    step: number;
    /** The lane's step counter within the loop (before direction is applied). */
    count: number;
    /** Beat of the lane step boundary, before offset and repeat. */
    stepBeat: number;
    /** The lane's step length in beats. */
    rateBeats: number;
    /** The lane's swing value (0..1). */
    swing: number;
    /** Semitones. */
    pitch: number;
    /** The cell's custom values. */
    custom: Readonly<Record<string, number>>;
    /** Loops since timing beat 0: `floor(stepBeat / loopBeats)`. */
    loop: number;
    repeatIndex: number;
    repeatCount: number;
  }>;

/** One hit as the trigger receives it, after the transforms and the clamp to now: `when` and `duration` are final audio-context seconds. */
export type StepHit = SecondsOf<StepEvent>;

/** A transform over a sequencer's hits. Beat-based unless it sets `unit: "second"`. */
export type StepTransform = EventTransform<StepEvent>;

export type StepWindow = Readonly<{
  beat: { start: number; end: number };
  time: { current: number };
  own(event: CancellableEvent, when: number): void;
}>;

export type StepSequencerOptions = Readonly<{
  /**
   * Seeds the stable randomness: each step's `chance` draw and `context.randomFor` in transforms are pure functions of `seed` and the
   * step's position (lane, loop, step counter), so an edit, re-queue, seek or different tick size never changes them. Default 0;
   * pass a different number per instance or run for a different pattern.
   */
  seed?: number;
  /**
   * A sequential source in [0, 1), used for `chance` and as `context.random` instead of the stable draw. Each call advances it, so a
   * re-queue draws new numbers and pending chance steps can flip; keep it for tests that script exact draws. Default: `chance` is
   * stable from `seed`, and `context.random` is `Math.random`.
   */
  random?: () => number;
  /** Custom per-step parameters, fixed at construction. */
  params?: readonly StepParamSpec[];
  /** Transforms run in order over each window's hits. Default `defaultStepTransforms`. */
  transforms?: readonly StepTransform[];
  /**
   * Lane-record form: the context that lanes with a `sound` play into (and whose destination their `output` joins). Required when any lane
   * has a sound or `lane.sound` is set later.
   */
  context?: BaseAudioContext;
  /**
   * Lane-record form: called ahead of time for each hit that will sound, before its `hit` event listeners. May return a cleanup that runs if
   * the hit is retracted (an edit re-queues it, the transport stops or seeks, or `dispose()` runs), like a React effect cleanup. After a
   * retraction `onHit` can run again for the same hit.
   */
  onHit?: (hit: Hit) => void | (() => void);
  /**
   * Adjust or drop each hit in seconds just before it is scheduled, after `transforms`. `random(key?)` is stable for the same `seed`, lane,
   * loop, index and `key`, so a retracted and re-queued hit gets the same number. Return the hit (changed or not), or `null` to drop it.
   */
  transform?: HitTransform;
  /** Aborting the signal calls `dispose()`. */
  signal?: AbortSignal;
}>;

/** Describes a per-step number the way `<input type="range">` does. */
export type ParamRange = Readonly<{ min: number; max: number; step?: number; default: number }>;

/** One lane in the lane-record form. */
export type LaneOptions = Readonly<{
  pattern: Pattern;
  /**
   * Step length: a `Time` ("16n" is a quarter of a beat, "16n." dotted, "8t" triplet, "1m" four beats; "250ms", "2s" or a number are seconds,
   * converted to beats at the tempo at beat 0) or a `StepRate` ("1/16"). Default "16n".
   */
  rate?: Time | StepRate;
  /** 0..1 or "30%": delays every second step by that fraction of half a step. Default 0. */
  swing?: number | `${number}%`;
  /** Plays a voice per hit into `lane.output`; needs `options.context`. Without it the lane only reports hits. */
  sound?: Sound;
  /** Per-step numbers by name; each step holds one, and `hit.values` carries them. */
  params?: Readonly<Record<string, ParamRange>>;
  mute?: boolean;
  /** Called for each hit of this lane after the sequencer-level `onHit`; may return a cleanup. */
  onHit?: (hit: Hit) => void | (() => void);
}>;

/** One hit as `onHit`, `hit` events and `transform` see it. */
export type Hit = Readonly<{
  lane: string;
  /** Zero-based position (0 = first step). */
  index: number;
  /** Audio-context seconds. */
  when: number;
  /** Seconds. */
  duration: number;
  /** 0..1. */
  velocity: number;
  /** The step's per-step values by name. */
  values: Readonly<Record<string, number>>;
  /** How many times this lane has looped since beat 0. */
  loop: number;
}>;

/** A number in [0, 1) fixed by the seed, this hit and `key`. */
export type Random = (key?: number | string) => number;
/** Returns the hit to schedule, or `null` to drop it. */
export type HitTransform = (hit: Hit, random: Random) => Hit | null;

/** Dispatched on the sequencer ahead of time for each hit that will sound. */
export class HitEvent extends Event {
  readonly hit: Hit;
  constructor(hit: Hit) {
    super("hit");
    this.hit = hit;
  }
}

/** One step of a lane. Writes commit through the sequencer's cells, so a running transport hears them on the next pass. */
export type Step = {
  /** 0..1; 0 is a rest. */
  velocity: number;
  /** Per-step values by name (the lane's declared `params`). */
  readonly values: Record<string, number>;
};

/** What the transport tells a scheduler on attach (a clock's `SchedulerHandle`). */
export type TransportHandle = Readonly<{ refresh(): void; detach(): void }>;

type LaneMeta = Readonly<{ rate: Time | StepRate | undefined; sound: Sound | undefined }>;
type LaneHost = Readonly<{
  meta(id: string): LaneMeta;
  setMeta(id: string, patch: Partial<LaneMeta>): void;
  setPattern(id: string, velocities: readonly number[]): void;
  params(id: string): readonly StepParamSpec[];
  output(id: string): GainNode;
  connect(id: string, node: AudioNode): AudioNode;
  disconnect(id: string): void;
}>;

/** Delays every hit whose lane step count is odd by `swing * 0.5` lane steps. Without it, lane `swing` has no effect. */
export function stepSwing(): StepTransform {
  return {
    id: "step-swing",
    apply: (events) =>
      events.map((hit) => (hit.count % 2 === 1 && hit.swing > 0 ? { ...hit, beat: hit.beat + hit.swing * 0.5 * hit.rateBeats } : hit)),
  };
}

/**
 * Re-queue the transport's look-ahead once per committed change of `sequencer.pattern` or `sequencer.transforms`.
 * Does not run on attach, and never subscribes a calling effect. Returns a disposer; call it before the transport goes away.
 * `transport` is structural: a Clock, a Workspace clock or anything with `refresh()`. A Clock refills in a microtask shared by
 * every `refresh()` of the same task, so several edits do not re-queue several times.
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

export const defaultStepTransforms: readonly StepTransform[] = Object.freeze([stepSwing()]);

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

function buildPattern(input: StepPatternInput, specsFor: (id: string) => readonly StepParamSpec[], blankFor: (id: string) => StepCell): StepPattern {
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
    const cells = Array.from({ length: size }, (_, index) => makeCell(blankFor(lane.id), supplied[index] ?? {}, specsFor(lane.id)));
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

/** A step hit's identity, from fields that survive a transform's `{ ...hit }` copy. */
const stepKey = (hit: StepEvent): string => `${hit.laneId}:${hit.loop}:${hit.count}:${hit.repeatIndex}`;

const PARAM_RANGE_ERROR =
  "Step Sequencer lane params need nonempty names that differ from the built-in cell keys, a finite min below max, a step above 0 and a default from min to max.";
const LANE_RECORD_ERROR = "Step Sequencer lanes need nonempty names mapped to a pattern or to lane options with a pattern.";
const CONTEXT_ERROR = "Step Sequencer needs options.context for a lane with a sound.";
const CALLBACK_ERROR = "Step Sequencer onHit and transform need functions.";
const OLD_FORM_ERROR = "Step Sequencer onHit and context belong to the lane-record form: pass lanes as a record of names to patterns.";
const DISPOSED_ERROR = "Step Sequencer is disposed.";
const RATE_ERROR = "Step Sequencer needs a rate that is a StepRate or a Time, at least 1/128 of a beat long.";
const MIN_RATE_BEATS = 1 / 128;
const DEFAULT_RATE: Time = "16n";

const isStepRate = (rate: unknown): rate is StepRate => typeof rate === "string" && Object.prototype.hasOwnProperty.call(RATE_BEATS, rate);

/** Throws unless `rate` is a `StepRate` or a `Time` of at least 1/128 beat (seconds are checked against the tempo when scheduling). */
function checkRate(rate: unknown): Time | StepRate {
  if (isStepRate(rate)) return rate;
  const parsed = parseTime(rate as Time);
  if (!(parsed.value > 0) || (parsed.unit === "beats" && parsed.value < MIN_RATE_BEATS)) throw new Error(RATE_ERROR);
  return rate as Time;
}

function toParamSpecs(params: LaneOptions["params"]): readonly StepParamSpec[] {
  if (params === undefined) return [];
  if (typeof params !== "object" || params === null) throw new Error(PARAM_RANGE_ERROR);
  return Object.entries(params).map(([id, range]) => {
    if (
      !id ||
      id === "custom" ||
      (BUILTIN_KEYS as readonly string[]).includes(id) ||
      !range ||
      !Number.isFinite(range.min) ||
      !Number.isFinite(range.max) ||
      !(range.min < range.max) ||
      !inRange(range.default, range.min, range.max) ||
      (range.step !== undefined && !(Number.isFinite(range.step) && range.step > 0))
    )
      throw new Error(PARAM_RANGE_ERROR);
    return Object.freeze({ id, min: range.min, max: range.max, default: range.default, ...(range.step !== undefined ? { step: range.step } : {}) });
  });
}

/**
 * An editable looping pattern over a borrowed beat transport.
 *
 * Two forms share one engine.
 * Lane-record form: `new StepSequencer({ kick: "X...", hat: { pattern, rate, sound } }, options)`. Every lane loops forever on its own length
 * at its own rate (polymeter), `clock.attach(sequencer)` is all the wiring a live edit needs, and hits reach `onHit`, `hit` events and an
 * optional per-lane `sound`.
 * Explicit form: `new StepSequencer({ size, lanes }, trigger, options)`. Lanes share one loop of `size` 1/16 steps, the caller's `trigger`
 * makes the sound, and edits re-queue through `refreshOnEdit` or `Workspace.attachStepSequencer`.
 * Each lane has its own length, rate, direction and swing; each cell its own velocity, offset, length, repeat, pitch, chance and caller-declared
 * custom values. Swing and any other timing plug-in run as `transforms` over each window's hits.
 */
export class StepSequencer extends EventTarget {
  private readonly data;
  private readonly heads;
  private readonly progress;
  private readonly metaCell;
  private readonly events = new Set<CancellableEvent>();
  private readonly pending = new Set<{ endsAt: number; finish(): void }>();
  private readonly handles = new Set<TransportHandle>();
  private readonly outputs = new Map<string, GainNode>();
  private readonly listeners: Array<{ type: string; listener: EventListenerOrEventListenerObject; options?: boolean | AddEventListenerOptions }> = [];
  private readonly random: () => number;
  private readonly drawChance: ((lane: string, loop: number, count: number) => number) | undefined;
  private readonly seed: number;
  private readonly blank: StepCell;
  private readonly laneParams = new Map<string, readonly StepParamSpec[]>();
  private readonly laneBlank = new Map<string, StepCell>();
  private readonly trigger: (hit: StepHit) => CancellableEvent | null;
  private readonly independent: boolean;
  private readonly onHitOption: StepSequencerOptions["onHit"];
  private readonly laneHits = new Map<string, NonNullable<LaneOptions["onHit"]>>();
  private readonly userTransform: StepTransform | undefined;
  private readonly abortSignal: AbortSignal | undefined;
  private readonly onAbort = () => this.dispose();
  private onHitHandler: ((event: HitEvent) => unknown) | null = null;
  private onHitWrapper: EventListener | null = null;
  private stopWatching: (() => void) | undefined;
  private disposed = false;
  private readonly tf;
  /** The built-in cell fields as data (same objects as `stepCellParams`), for views that edit cells. */
  readonly cellParams: readonly StepParamSpec[] = stepCellParams;
  /** The lane rates in display order (same list as `stepRates`). */
  readonly rates: readonly StepRate[] = stepRates;
  /** Explicit form: custom per-step parameters declared at construction. Empty in the lane-record form, where each lane declares its own `params`. */
  readonly params: readonly StepParamSpec[];
  /** The context lanes with a `sound` play into, when one was given. */
  readonly context: BaseAudioContext | undefined;
  /** Transforms run, in order, over each window's hits. Replace with `setTransforms`. */
  readonly transforms: ReadonlyCell<readonly StepTransform[]>;
  readonly pattern: ReadonlyCell<StepPattern>;
  /** Current cell index per lane, or `null` when stopped. */
  readonly playheads: ReadonlyCell<Readonly<Record<string, number | null>>>;
  /** 0..1 position in the loop (the longest lane's own loop in the lane-record form), or `null` when stopped. */
  readonly loopProgress: ReadonlyCell<number | null>;
  /** One live view per lane, by name: `sequencer.lanes.kick.steps[4].velocity = 0.8`. */
  readonly lanes: Readonly<Record<string, Lane>>;

  /** Lane-record form: each lane loops on its own length and rate; `clock.attach(sequencer)` follows a transport. */
  constructor(lanes: Readonly<Record<string, Pattern | LaneOptions>>, options?: StepSequencerOptions);
  /** Explicit form: shared loop of `size` 1/16 steps; `trigger` makes the sound for each hit. */
  constructor(pattern: StepPatternInput, trigger: (hit: StepHit) => CancellableEvent | null, options?: StepSequencerOptions);
  constructor(
    first: StepPatternInput | Readonly<Record<string, Pattern | LaneOptions>>,
    second?: StepSequencerOptions | ((hit: StepHit) => CancellableEvent | null),
    third: StepSequencerOptions = {},
  ) {
    super();
    const explicit = typeof second === "function";
    const options: StepSequencerOptions = (explicit ? third : second) ?? {};
    if (typeof options !== "object" || options === null) throw new Error(LANE_RECORD_ERROR);
    this.independent = !explicit;
    this.params = buildParams(options.params);
    this.blank = Object.freeze({
      ...BUILTIN_CELL,
      custom: Object.freeze(Object.fromEntries(this.params.map((spec) => [spec.id, spec.default]))),
    });
    this.seed = options.seed ?? 0;
    this.random = options.random ?? Math.random;
    const injected = options.random;
    this.drawChance = injected ? undefined : (lane, loop, count) => hash01(this.seed, "chance", lane, loop, count);
    if (
      (options.onHit !== undefined && typeof options.onHit !== "function") ||
      (options.transform !== undefined && typeof options.transform !== "function")
    )
      throw new Error(CALLBACK_ERROR);
    if (explicit && (options.onHit !== undefined || options.context !== undefined)) throw new Error(OLD_FORM_ERROR);
    this.onHitOption = options.onHit;
    this.context = options.context;
    this.abortSignal = options.signal;
    const specsFor = (id: string) => this.laneParams.get(id) ?? this.params;
    const blankFor = (id: string) => this.laneBlank.get(id) ?? this.blank;
    let built: StepPattern;
    const meta: Record<string, LaneMeta> = {};
    if (explicit) {
      this.trigger = second;
      built = buildPattern(first as StepPatternInput, specsFor, blankFor);
      for (const lane of built.lanes) meta[lane.id] = Object.freeze({ rate: undefined, sound: undefined });
    } else {
      this.trigger = (hit) => this.fire(hit);
      const record = first as Readonly<Record<string, Pattern | LaneOptions>>;
      if (typeof record !== "object" || record === null || Array.isArray(record)) throw new Error(LANE_RECORD_ERROR);
      const inputs: StepLaneInput[] = [];
      let size = 1;
      for (const [name, definition] of Object.entries(record)) {
        const lane: LaneOptions =
          typeof definition === "string" || Array.isArray(definition) ? { pattern: definition as Pattern } : (definition as LaneOptions);
        if (!name || !lane || typeof lane !== "object" || lane.pattern === undefined) throw new Error(LANE_RECORD_ERROR);
        const velocities = parsePattern(lane.pattern);
        const specs = toParamSpecs(lane.params);
        const rate = checkRate(lane.rate ?? DEFAULT_RATE);
        const swing = lane.swing === undefined ? 0 : parseSwing(lane.swing);
        if (lane.sound !== undefined) {
          assertSound(lane.sound);
          if (!this.context) throw new Error(CONTEXT_ERROR);
        }
        if (lane.onHit !== undefined) {
          if (typeof lane.onHit !== "function") throw new Error(CALLBACK_ERROR);
          this.laneHits.set(name, lane.onHit);
        }
        this.laneParams.set(name, Object.freeze(specs));
        this.laneBlank.set(
          name,
          Object.freeze({ ...BUILTIN_CELL, custom: Object.freeze(Object.fromEntries(specs.map((spec) => [spec.id, spec.default]))) }),
        );
        meta[name] = Object.freeze({ rate, sound: lane.sound });
        size = Math.max(size, velocities.length);
        inputs.push({ id: name, steps: velocities.length, swing, mute: lane.mute ?? false, cells: velocities.map((velocity) => ({ velocity })) });
      }
      built = buildPattern({ size, lanes: inputs }, specsFor, blankFor);
    }
    this.userTransform = options.transform && this.secondsTransform(options.transform);
    this.tf = cell<readonly StepTransform[]>(this.checkTransforms(options.transforms ?? defaultStepTransforms));
    this.transforms = readonlyCell(this.tf);
    this.data = cell<StepPattern>(built);
    this.metaCell = cell<Readonly<Record<string, LaneMeta>>>(Object.freeze(meta));
    this.heads = cell<Readonly<Record<string, number | null>>>(this.stopped(built));
    this.progress = cell<number | null>(null);
    this.pattern = readonlyCell(this.data);
    this.playheads = readonlyCell(this.heads);
    this.loopProgress = readonlyCell(this.progress);
    const host: LaneHost = {
      meta: (id) => this.metaCell.value[id]!,
      setMeta: (id, patch) =>
        untracked(() => {
          const all = this.metaCell.value;
          const next = { ...all[id]!, ...patch };
          if (next.rate === all[id]!.rate && next.sound === all[id]!.sound) return;
          this.metaCell.value = Object.freeze({ ...all, [id]: Object.freeze(next) });
        }),
      setPattern: (id, velocities) => this.setPattern(id, velocities),
      params: specsFor,
      output: (id) => this.outputFor(id),
      connect: (id, node) => {
        const output = this.outputFor(id);
        output.disconnect();
        output.connect(node);
        return node;
      },
      disconnect: (id) => this.outputFor(id).disconnect(),
    };
    this.lanes = Object.freeze(Object.fromEntries(built.lanes.map(({ id }) => [id, new Lane(this, id, host)])));
    for (const [name, { sound }] of Object.entries(meta)) if (sound !== undefined) this.outputFor(name);
    if (this.abortSignal) {
      if (this.abortSignal.aborted) this.dispose();
      else this.abortSignal.addEventListener("abort", this.onAbort, { once: true });
    }
  }

  private checkTransforms(list: readonly StepTransform[]): readonly StepTransform[] {
    if (!Array.isArray(list) || list.some((item) => !item || typeof item.id !== "string" || !item.id || typeof item.apply !== "function"))
      throw new Error(TRANSFORMS_ERROR);
    return Object.freeze([...list]);
  }

  /** The user's `transform(hit, random)` as a seconds transform over the internal events. */
  private secondsTransform(transform: HitTransform): StepTransform {
    return {
      id: "transform",
      unit: "second",
      apply: (events, context) => {
        const out: SecondsOf<StepEvent>[] = [];
        for (const event of events) {
          const result = transform(this.publicHit(event), (key) => context.randomFor(event, key));
          if (result === null) continue;
          out.push({ ...event, when: result.when, duration: result.duration, velocity: result.velocity, custom: result.values });
        }
        return out;
      },
    };
  }

  private publicHit(hit: StepHit): Hit {
    return Object.freeze({
      lane: hit.laneId,
      index: hit.step,
      when: hit.when,
      duration: hit.duration,
      velocity: hit.velocity,
      values: hit.custom,
      loop: hit.loop,
    });
  }

  /** Replace the transform list in one write. Compose with `[...defaultStepTransforms, mine]` to keep swing. */
  setTransforms(list: readonly StepTransform[]): void {
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

  /** Lane view by name; throws for an unknown lane. */
  lane(name: string): Lane {
    const lane = Object.prototype.hasOwnProperty.call(this.lanes, name) ? this.lanes[name] : undefined;
    if (!lane) throw new Error(LANE_TARGET_ERROR);
    return lane;
  }

  /** Change fields of one cell. Unknown lane or step, and out-of-range values, throw. */
  setCell(laneId: string, step: number, patch: StepCellInput): void {
    untracked(() => {
      const pattern = this.data.value;
      const index = this.laneIndex(pattern, laneId);
      if (index < 0 || !Number.isInteger(step) || step < 0 || step >= pattern.size) throw new Error(TARGET_ERROR);
      const lane = pattern.lanes[index];
      const before = lane.cells[step];
      const after = makeCell(before, patch, this.laneParams.get(laneId) ?? this.params);
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

  /** One write: the lane's first cells take `velocities`, its length becomes their count, and the loop grows to fit. */
  private setPattern(laneId: string, velocities: readonly number[]): void {
    untracked(() => {
      const pattern = this.data.value;
      const index = this.laneIndex(pattern, laneId);
      const lane = pattern.lanes[index];
      const size = Math.max(pattern.size, velocities.length);
      const blank = this.laneBlank.get(laneId) ?? this.blank;
      const specs = this.laneParams.get(laneId) ?? this.params;
      const cells = Array.from({ length: size }, (_, i) => {
        const base = lane.cells[i] ?? blank;
        return i < velocities.length ? makeCell(base, { velocity: velocities[i] }, specs) : base;
      });
      const changed =
        size !== pattern.size ||
        lane.steps !== velocities.length ||
        cells.some((item, i) => item !== lane.cells[i] && !sameCell(item, lane.cells[i] ?? blank));
      if (!changed) return;
      const lanes = pattern.lanes.map((item, i) =>
        i === index
          ? Object.freeze({ ...lane, steps: velocities.length, cells: Object.freeze(cells) })
          : size === pattern.size
            ? item
            : Object.freeze({
                ...item,
                cells: Object.freeze(Array.from({ length: size }, (_, k) => item.cells[k] ?? this.laneBlank.get(item.id) ?? this.blank)),
              }),
      );
      this.data.value = Object.freeze({ size, lanes: Object.freeze(lanes) });
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
          cells: Object.freeze(Array.from({ length: size }, (_, i) => lane.cells[i] ?? this.laneBlank.get(lane.id) ?? this.blank)),
        }),
      );
      batch(() => {
        this.data.value = Object.freeze({ size, lanes: Object.freeze(lanes) });
      });
    });
  }

  /** The lane's step length in beats. Seconds convert at the tempo at beat 0 of `timing`. */
  private rateBeats(lane: StepLane, timing: BeatTiming): number {
    const rate = this.metaCell.value[lane.id]?.rate ?? lane.rate;
    if (isStepRate(rate)) return RATE_BEATS[rate];
    const parsed = parseTime(rate);
    if (parsed.unit === "beats") return parsed.value;
    const beatSeconds = timing.beatToTime(1) - timing.beatToTime(0);
    return beatSeconds > 0 ? parsed.value / beatSeconds : 0;
  }

  /** Register this window's hits with `window.own`. Reads `timing` for beat/time mapping; pass the Timeline the window came from. */
  schedule(window: StepWindow, timing: BeatTiming): void {
    untracked(() => {
      if (this.disposed) return;
      const pattern = this.data.value;
      const loopBeats = pattern.size * 0.25;
      const now = window.time.current;
      for (const record of [...this.pending]) if (record.endsAt <= now) record.finish();
      const soloed = pattern.lanes.some((lane) => lane.solo);
      const planned: StepEvent[] = [];
      const plan = (lane: StepLane, loop: number, count: number, step: number, beat: number, rate: number) => {
        const cellData = lane.cells[step];
        if (cellData.velocity <= 0 || !((this.drawChance ? this.drawChance(lane.id, loop, count) : this.random()) < cellData.chance)) return;
        const trigger = beat + cellData.offset * rate;
        for (let repeat = 0; repeat < cellData.repeat; repeat++) {
          const start = trigger + (repeat * rate) / cellData.repeat;
          planned.push({
            laneId: lane.id,
            step,
            count,
            stepBeat: beat,
            rateBeats: rate,
            swing: lane.swing,
            velocity: cellData.velocity,
            pitch: cellData.pitch,
            custom: cellData.custom,
            loop,
            beat: start,
            durationBeats: (cellData.length * rate) / cellData.repeat,
            repeatIndex: repeat,
            repeatCount: cellData.repeat,
          });
        }
      };
      if (this.independent) {
        // every lane loops on its own length: its step counter runs from beat 0, forever
        for (const lane of pattern.lanes) {
          if (lane.mute || (soloed && !lane.solo)) continue;
          const rate = this.rateBeats(lane, timing);
          if (!(rate >= MIN_RATE_BEATS)) continue;
          const first = Math.max(0, Math.ceil(window.beat.start / rate - EPS));
          const end = Math.ceil(window.beat.end / rate - EPS);
          for (let k = first; k < end; k++) {
            const loop = Math.floor(k / lane.steps);
            plan(lane, loop, k - loop * lane.steps, cellIndex(lane.direction, lane.steps, k), k * rate, rate);
          }
        }
      } else {
        const firstLoop = Math.floor(Math.max(0, window.beat.start) / loopBeats + EPS);
        const endLoop = Math.ceil(window.beat.end / loopBeats - EPS);
        for (let loop = firstLoop; loop < endLoop; loop++) {
          const loopStart = loop * loopBeats;
          for (const lane of pattern.lanes) {
            if (lane.mute || (soloed && !lane.solo)) continue;
            const rate = this.rateBeats(lane, timing);
            if (!(rate >= MIN_RATE_BEATS)) continue;
            const count = Math.ceil(loopBeats / rate - EPS);
            const first = Math.max(0, Math.ceil((window.beat.start - loopStart) / rate - EPS));
            const end = Math.min(count, Math.ceil((window.beat.end - loopStart) / rate - EPS));
            for (let k = first; k < end; k++) plan(lane, loop, k, cellIndex(lane.direction, lane.steps, k), loopStart + k * rate, rate);
          }
        }
      }
      // The scheduler, not the transforms, validates, converts to seconds, clamps to `now`, triggers and owns every output.
      const transforms = this.userTransform ? [...this.tf.value, this.userTransform] : this.tf.value;
      for (const hit of applyEventTransforms(planned, transforms, { now, timing, random: this.random, seed: this.seed, keyOf: stepKey })) {
        const event = this.trigger(hit);
        if (!event) continue;
        this.events.add(event);
        event.onEnded(() => this.events.delete(event));
        window.own(event, hit.when);
      }
      this.publishPosition(pattern, timing.timeToBeat(now), loopBeats, timing);
    });
  }

  /** Lane-record form: one hit's event, voice and callbacks. Returns a retractable event, or `null` when nothing could need retracting. */
  private fire(hit: StepHit): CancellableEvent | null {
    const pub = this.publicHit(hit);
    const meta = this.metaCell.value[hit.laneId]!;
    let voice: CancellableEvent | null = null;
    if (meta.sound !== undefined && this.context) {
      try {
        voice = playSound(this.context, meta.sound, this.outputFor(hit.laneId), pub);
      } catch (error) {
        console.error("Step Sequencer sound failed:", error);
      }
    }
    const cleanups: Array<() => void> = [];
    const call = (callback: ((hit: Hit) => void | (() => void)) | undefined) => {
      if (!callback) return;
      try {
        const cleanup = callback(pub);
        if (typeof cleanup === "function") cleanups.push(cleanup);
      } catch (error) {
        console.error("Step Sequencer onHit failed:", error);
      }
    };
    this.dispatchEvent(new HitEvent(pub));
    call(this.onHitOption);
    call(this.laneHits.get(hit.laneId));
    if (!voice && cleanups.length === 0) return null;
    let done = false;
    const ended: Array<() => void> = [];
    const settle = (retract: boolean) => {
      if (done) return;
      done = true;
      this.pending.delete(record);
      if (retract) {
        voice?.cancel();
        for (const cleanup of cleanups.reverse()) {
          try {
            cleanup();
          } catch (error) {
            console.error("Step Sequencer onHit cleanup failed:", error);
          }
        }
      }
      for (const listener of ended.splice(0)) listener();
    };
    const record = { endsAt: hit.when + hit.duration, finish: () => settle(false) };
    this.pending.add(record);
    return {
      cancel: () => settle(true),
      onEnded: (listener) => {
        if (done) listener();
        else ended.push(listener);
      },
    };
  }

  private outputFor(laneId: string): GainNode {
    if (!this.context) throw new Error(CONTEXT_ERROR);
    let output = this.outputs.get(laneId);
    if (!output) {
      output = new GainNode(this.context);
      output.connect(this.context.destination);
      this.outputs.set(laneId, output);
    }
    return output;
  }

  private publishPosition(pattern: StepPattern, beat: number, loopBeats: number, timing: BeatTiming): void {
    const at = Math.max(0, beat);
    const heads: Record<string, number | null> = {};
    let inLoop = (((at % loopBeats) + loopBeats) % loopBeats) / loopBeats;
    if (this.independent) {
      let longest = 0;
      for (const lane of pattern.lanes) {
        const rate = this.rateBeats(lane, timing);
        if (!(rate >= MIN_RATE_BEATS)) {
          heads[lane.id] = null;
          continue;
        }
        heads[lane.id] = cellIndex(lane.direction, lane.steps, Math.floor(at / rate + EPS));
        const own = lane.steps * rate;
        if (own > longest) {
          longest = own;
          inLoop = (((at % own) + own) % own) / own;
        }
      }
    } else {
      for (const lane of pattern.lanes) {
        const rate = this.rateBeats(lane, timing);
        const count = Math.ceil(loopBeats / rate - EPS);
        const k = Math.min(count - 1, Math.floor((inLoop * loopBeats) / rate + EPS));
        heads[lane.id] = cellIndex(lane.direction, lane.steps, k);
      }
    }
    const previous = this.heads.value;
    const same = pattern.lanes.every(({ id }) => previous[id] === heads[id]);
    batch(() => {
      if (!same) this.heads.value = Object.freeze(heads);
      this.progress.value = inLoop;
    });
  }

  /** Cancel only this pattern's events (running each hit's `onHit` cleanup) and clear its playheads. */
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

  /**
   * Called by `clock.attach(sequencer)` (or `workspace.transport.attach`) with a handle to that transport. In the lane-record form every
   * committed edit (a step, `pattern`, `rate`, `swing`, `mute`, `sound`, a transform) then calls `handle.refresh()`, which retracts the pending
   * hits and queues them again; several edits in one task re-queue once. The explicit form records the handle for `dispose()` only
   * and still re-queues through `refreshOnEdit`. Returns the cleanup the clock runs on detach.
   */
  attached(handle: TransportHandle): () => void {
    if (this.disposed) throw new Error(DISPOSED_ERROR);
    this.handles.add(handle);
    if (this.independent && !this.stopWatching) {
      let armed = false;
      this.stopWatching = untracked(() =>
        effect(() => {
          this.data.$();
          this.tf.$();
          this.metaCell.$();
          if (!armed) {
            armed = true;
            return;
          }
          untracked(() => {
            for (const each of [...this.handles]) each.refresh();
          });
        }),
      );
    }
    return () => {
      this.handles.delete(handle);
      if (this.handles.size === 0) {
        this.stopWatching?.();
        this.stopWatching = undefined;
      }
    };
  }

  /** `onhit = fn` is `addEventListener("hit", fn)`; assigning again replaces it, `null` removes it. */
  get onhit(): ((this: StepSequencer, event: HitEvent) => unknown) | null {
    return this.onHitHandler;
  }

  set onhit(handler: ((this: StepSequencer, event: HitEvent) => unknown) | null) {
    if (this.onHitWrapper) this.removeEventListener("hit", this.onHitWrapper);
    this.onHitHandler = typeof handler === "function" ? handler : null;
    this.onHitWrapper = null;
    if (this.onHitHandler) {
      const run = this.onHitHandler;
      this.onHitWrapper = (event) => void run.call(this, event as HitEvent);
      this.addEventListener("hit", this.onHitWrapper);
    }
  }

  addEventListener(type: "hit", listener: (this: StepSequencer, event: HitEvent) => unknown, options?: boolean | AddEventListenerOptions): void;
  addEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions): void;
  addEventListener(type: string, listener: unknown, options?: boolean | AddEventListenerOptions): void {
    if (this.disposed || !listener) return;
    super.addEventListener(type, listener as EventListenerOrEventListenerObject, options);
    this.listeners.push({ type, listener: listener as EventListenerOrEventListenerObject, options });
  }

  /**
   * Detach from every transport (the transport keeps running), retract pending hits and run their `onHit` cleanups, release lane outputs and
   * remove event listeners. Idempotent; the sequencer ignores windows afterwards.
   */
  dispose(): void {
    if (this.disposed) return;
    for (const handle of [...this.handles]) handle.detach();
    this.disposed = true;
    this.abortSignal?.removeEventListener("abort", this.onAbort);
    this.stopWatching?.();
    this.stopWatching = undefined;
    this.handles.clear();
    this.reset();
    for (const output of this.outputs.values()) output.disconnect();
    this.outputs.clear();
    for (const { type, listener, options } of this.listeners.splice(0)) super.removeEventListener(type, listener, options);
    this.onHitHandler = null;
    this.onHitWrapper = null;
  }

  [Symbol.dispose](): void {
    this.dispose();
  }
}

/** Live view of one lane. Setters commit through the sequencer's cells, so an attached transport hears them on the next pass. */
export class Lane {
  private cache: Step[] = [];
  private view: readonly Step[] = Object.freeze([]);

  /** @internal Built by the sequencer; read `sequencer.lanes.<name>`. */
  constructor(
    private readonly owner: StepSequencer,
    readonly name: string,
    private readonly host: LaneHost,
  ) {}

  private data(): StepLane {
    return this.owner.pattern.value.lanes.find(({ id }) => id === this.name)!;
  }

  /** Number of steps this lane loops over. */
  get length(): number {
    return this.data().steps;
  }

  /** The lane's pattern as text when notation can express every velocity, else as a number array. Assigning sets its length too. */
  get pattern(): Pattern {
    const lane = this.data();
    return describePattern(lane.cells.slice(0, lane.steps).map((item) => item.velocity));
  }

  set pattern(pattern: Pattern) {
    this.host.setPattern(this.name, parsePattern(pattern));
  }

  /** Step length: a `Time` or a `StepRate`. */
  get rate(): Time | StepRate {
    return this.host.meta(this.name).rate ?? this.data().rate;
  }

  set rate(rate: Time | StepRate) {
    this.host.setMeta(this.name, { rate: checkRate(rate) });
  }

  /** 0..1. Assign a number or a string like "30%". */
  get swing(): number {
    return this.data().swing;
  }

  set swing(swing: number | `${number}%`) {
    this.owner.setLane(this.name, { swing: parseSwing(swing) });
  }

  get mute(): boolean {
    return this.data().mute;
  }

  set mute(mute: boolean) {
    this.owner.setLane(this.name, { mute });
  }

  /** The voice played for each hit, or `undefined`. Setting one needs `options.context`. */
  get sound(): Sound | undefined {
    return this.host.meta(this.name).sound;
  }

  set sound(sound: Sound | undefined) {
    if (sound !== undefined) {
      assertSound(sound);
      this.host.output(this.name);
    }
    this.host.setMeta(this.name, { sound });
  }

  /** The declared per-step params by name. */
  get params(): Readonly<Record<string, ParamRange>> {
    return Object.freeze(Object.fromEntries(this.host.params(this.name).map(({ id, ...range }) => [id, range as ParamRange])));
  }

  /** Where the lane's voices arrive; joined to the context destination until `connect` reroutes it. Needs `options.context`. */
  get output(): GainNode {
    return this.host.output(this.name);
  }

  /** Route the output to `node` instead of the destination. Returns `node`. */
  connect(node: AudioNode): AudioNode {
    return this.host.connect(this.name, node);
  }

  /** Disconnect the output from everything. */
  disconnect(): void {
    this.host.disconnect(this.name);
  }

  /** 0-based array; steps[0] is the first step, steps[6] the seventh. Edits take effect on the next pass. */
  get steps(): readonly Step[] {
    const length = this.length;
    while (this.cache.length < length) this.cache.push(this.makeStep(this.cache.length));
    if (this.view.length !== length) this.view = Object.freeze(this.cache.slice(0, length));
    return this.view;
  }

  private makeStep(index: number): Step {
    const cellAt = () => this.data().cells[index]!;
    const values: Record<string, number> = {};
    for (const { id } of this.host.params(this.name)) {
      Object.defineProperty(values, id, {
        enumerable: true,
        get: () => cellAt().custom[id]!,
        set: (value: number) => this.owner.setCell(this.name, index, { custom: { [id]: value } }),
      });
    }
    Object.freeze(values);
    const { owner, name } = this;
    const step = {
      get velocity() {
        return cellAt().velocity;
      },
      set velocity(velocity: number) {
        owner.setCell(name, index, { velocity });
      },
      values,
    };
    return Object.freeze(step);
  }
}
