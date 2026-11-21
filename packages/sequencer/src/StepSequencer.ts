import {
  applyEventTransforms,
  assertSound,
  playSound,
  batch,
  cell,
  effect,
  hash01,
  untracked,
  type BeatTiming,
  type CancellableEvent,
  type EventTransform,
  type ParamSpec,
  type SecondsOf,
  type TimedBeatEvent,
  type Voice,
} from "@audiorective/core";
import { describePattern, parsePattern, parseSwing, parseTime, type Pattern, type Time } from "./notation";
import type { Sound } from "@audiorective/core";

export type { Pattern, Time } from "./notation";
export type { NoteName, Sound, SoundFactory, SoundHit } from "@audiorective/core";

export type StepRate = "1/2" | "1/4" | "1/8" | "1/16" | "1/32" | "1/64" | "1/2T" | "1/4T" | "1/8T" | "1/16T" | "1/32T" | "1/64T";
export type StepDirection = "forward" | "backward" | "bounce";

export type StepSequencerOptions = Readonly<{
  /**
   * Seeds the stable randomness: each step's `chance` draw and `random` in `transform` are pure functions of `seed` and the step's position
   * (lane, loop, index), so an edit, re-queue, seek or different tick size never changes them. Default 0; pass a different number per
   * instance or run for a different pattern.
   */
  seed?: number;
  /**
   * A sequential source in [0, 1), used for `chance` instead of the stable draw. Each call advances it, so a re-queue draws new numbers and
   * pending chance steps can flip; keep it for tests that script exact draws. Default: `chance` is stable from `seed`.
   */
  random?: () => number;
  /** The context that lanes with a `sound` play into (and whose destination their `output` joins). Required when any lane has a sound or `lane.sound` is set later. */
  context?: BaseAudioContext;
  /**
   * Called ahead of time for each hit that will sound, before its `hit` event listeners. May return a cleanup that runs if the hit is
   * retracted (an edit re-queues it, the transport stops or seeks, or `dispose()` runs), like a React effect cleanup. After a retraction
   * `onHit` can run again for the same hit.
   */
  onHit?: (hit: Hit) => void | (() => void);
  /**
   * Adjust or drop each hit just before it is scheduled. Move `beat` (or change `durationBeats`) for musical shifts that stay on the grid under
   * tempo changes; move `when` (or change `duration`) for millisecond nudges. If `beat` or `durationBeats` changed, `when` and `duration` are
   * recomputed from the beats through the transport's timing; if both `beat` and `when` changed, `when` is `beatToTime(beat)` plus the `when`
   * delta (likewise `duration`). `random(key?)` is stable for the same `seed`, lane, loop, index and
   * `key`, so a retracted and re-queued hit gets the same number. Return the hit (changed or not), or `null` to drop it.
   */
  transform?: HitTransform;
  /** Aborting the signal calls `dispose()`. */
  signal?: AbortSignal;
}>;

/** Describes a per-step number the way `<input type="range">` does. */
export type ParamRange = Readonly<{ min: number; max: number; step?: number; default: number }>;

/** One lane. A string or number array is the shorthand for `{ pattern }`. */
export type LaneOptions = Readonly<{
  pattern: Pattern;
  /**
   * Step length: a `Time` ("16n" is a quarter of a beat, "16n." dotted, "8t" triplet, "1m" four beats; "250ms", "2s" or a number are seconds,
   * converted to beats at the tempo at beat 0) or a `StepRate` ("1/16"). Default "16n".
   */
  rate?: Time | StepRate;
  /** 0..1 or "30%": delays every odd step (1, 3, 5 ... from each loop start) by that fraction of half a step, a fixed beat offset that follows tempo. Default 0. */
  swing?: number | `${number}%`;
  /** Order the lane walks its steps in. Default "forward". */
  direction?: StepDirection;
  /** Plays one voice per hit into `lane.output` with the hit's `velocity`, `when` and `pitch`, held for the step's length, like `Sampler.trigger`; a retracted hit's voice is dropped. Needs `options.context`. Without it the lane only reports hits. */
  sound?: Sound;
  /** Per-step numbers by name; each step holds one, and `hit.values` carries them. */
  params?: Readonly<Record<string, ParamRange>>;
  mute?: boolean;
  /** While any lane is soloed, only soloed lanes play. Default false. */
  solo?: boolean;
  /** Called for each hit of this lane after the sequencer-level `onHit`; may return a cleanup. */
  onHit?: (hit: Hit) => void | (() => void);
}>;

/** One hit as `onHit`, `hit` events and `transform` see it. */
export type Hit = Readonly<{
  lane: string;
  /** Zero-based position (0 = first step). */
  index: number;
  /** Audio-context seconds; move it for millisecond nudges. */
  when: number;
  /** Seconds. */
  duration: number;
  /** Beat position, after offset, swing and repeat; move it to shift the hit and stay on the grid when the tempo changes. */
  beat: number;
  /** Length in beats; change it to resize the hit tempo-locked. */
  durationBeats: number;
  /** 0..1. */
  velocity: number;
  /** Semitones. */
  pitch: number;
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

/** One step of a lane. Writes validate and commit through the sequencer, so a running transport hears them on the next pass. */
export type Step = {
  /** 0..1; 0 is a rest. */
  velocity: number;
  /** -0.5..0.5 of one lane step: moves the hit earlier or later. */
  offset: number;
  /** 1/16..4 lane steps: how long the hit lasts. */
  length: number;
  /** Integer 1..8: hits evenly spaced inside the step. */
  repeat: number;
  /** Integer semitones -24..24. */
  pitch: number;
  /** 0..1 probability that the step plays. */
  chance: number;
  /** Per-step values by name (the lane's declared `params`). */
  readonly values: Record<string, number>;
};

/** What a transport tells a scheduler on attach (a clock's `SchedulerHandle`). */
export type TransportHandle = Readonly<{ refresh(): void; detach(): void }>;

/**
 * The part of a transport window `schedule` reads. Internal to transports: `clock.attach(sequencer)` and `workspace.transport.attach(sequencer)`
 * pass it; applications never build one.
 */
export type StepWindow = Readonly<{
  beat: { start: number; end: number };
  time: { current: number };
  own(event: CancellableEvent, when: number): void;
}>;

type StepCell = Readonly<{
  velocity: number;
  offset: number;
  length: number;
  repeat: number;
  pitch: number;
  chance: number;
  custom: Readonly<Record<string, number>>;
}>;
type StepCellPatch = Partial<Omit<StepCell, "custom">> & { custom?: Readonly<Record<string, number>> };

type LaneData = Readonly<{
  /** Integer 1..128: this lane's own length (polymeter). */
  steps: number;
  rate: Time | StepRate;
  direction: StepDirection;
  swing: number;
  mute: boolean;
  solo: boolean;
  sound: Sound | undefined;
  /** At least `steps` long; cells beyond `steps` are kept but not played. */
  cells: readonly StepCell[];
}>;
type LaneFields = Partial<Omit<LaneData, "cells">>;

type LaneHost = Readonly<{
  data(name: string): LaneData;
  patch(name: string, patch: LaneFields): void;
  setPattern(name: string, velocities: readonly number[]): void;
  setCell(name: string, index: number, patch: StepCellPatch): void;
  params(name: string): readonly ParamSpec[];
  playhead(name: string): number | null;
  progress(name: string): number | null;
  output(name: string): GainNode;
  connect(name: string, node: AudioNode): AudioNode;
  disconnect(name: string): void;
}>;

/** One hit inside the transform pipeline, in beats with offset, swing and repeat already applied. */
type StepEvent = TimedBeatEvent &
  Readonly<{
    laneId: string;
    step: number;
    count: number;
    pitch: number;
    custom: Readonly<Record<string, number>>;
    loop: number;
    repeatIndex: number;
    repeatCount: number;
    /** The hit's beat and length in beats as `Hit` reports them; they survive the beat-to-seconds conversion. */
    beatAt: number;
    durationBeatsAt: number;
  }>;
type StepHit = SecondsOf<StepEvent>;

const MAX_STEPS = 128;
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
/** The built-in step fields as data, in display order: the one source for validation. */
const FIELDS = [
  { id: "velocity", min: 0, max: 1, default: 0, integer: false },
  { id: "offset", min: -0.5, max: 0.5, default: 0, integer: false },
  { id: "length", min: 1 / 16, max: 4, default: 1, integer: false },
  { id: "repeat", min: 1, max: 8, default: 1, integer: true },
  { id: "pitch", min: -24, max: 24, default: 0, integer: true },
  { id: "chance", min: 0, max: 1, default: 1, integer: false },
] as const;
type FieldId = (typeof FIELDS)[number]["id"];
const FIELD_IDS = FIELDS.map((field) => field.id) as readonly FieldId[];
const BUILTIN_CELL = Object.fromEntries(FIELDS.map((field) => [field.id, field.default])) as Omit<StepCell, "custom">;

const LANE_ERROR = "Step Sequencer lane needs a length from 1 to 128, a known direction and boolean mute and solo.";
const CELL_ERROR =
  "Step Sequencer cell needs velocity and chance from 0 to 1, offset from -0.5 to 0.5, length from 1/16 to 4, an integer repeat from 1 to 8 and an integer pitch from -24 to 24.";
const CUSTOM_ERROR = "Step Sequencer custom values need declared param ids and finite numbers from each param's min to max.";
const PARAM_RANGE_ERROR =
  "Step Sequencer lane params need nonempty names that differ from the built-in step keys, a finite min below max, a step above 0 and a default from min to max.";
const LANE_RECORD_ERROR = "Step Sequencer lanes need nonempty names mapped to a pattern or to lane options with a pattern.";
const ARGUMENTS_ERROR = "Step Sequencer takes a record of lanes and an options object.";
const CONTEXT_ERROR = "Step Sequencer needs options.context for a lane with a sound.";
const CALLBACK_ERROR = "Step Sequencer onHit and transform need functions.";
const DISPOSED_ERROR = "Step Sequencer is disposed.";
const LANE_TARGET_ERROR = "Step Sequencer needs an existing lane.";
const RATE_ERROR = "Step Sequencer needs a rate that is a StepRate or a Time, at least 1/128 of a beat long.";
const MIN_RATE_BEATS = 1 / 128;
const DEFAULT_RATE: Time = "16n";

const inRange = (value: number, min: number, max: number) => typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
const inRangeInt = (value: number, min: number, max: number) => inRange(value, min, max) && Number.isInteger(value);
const isStepRate = (rate: unknown): rate is StepRate => typeof rate === "string" && Object.prototype.hasOwnProperty.call(RATE_BEATS, rate);

/** Throws unless `rate` is a `StepRate` or a `Time` of at least 1/128 beat (seconds are checked against the tempo when scheduling). */
function checkRate(rate: unknown): Time | StepRate {
  if (isStepRate(rate)) return rate;
  const parsed = parseTime(rate as Time);
  if (!(parsed.value > 0) || (parsed.unit === "beats" && parsed.value < MIN_RATE_BEATS)) throw new Error(RATE_ERROR);
  return rate as Time;
}

function toParamSpecs(params: LaneOptions["params"]): readonly ParamSpec[] {
  if (params === undefined) return [];
  if (typeof params !== "object" || params === null) throw new Error(PARAM_RANGE_ERROR);
  return Object.entries(params).map(([id, range]) => {
    if (
      !id ||
      id === "custom" ||
      (FIELD_IDS as readonly string[]).includes(id) ||
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

function makeCell(base: StepCell, patch: StepCellPatch, specs: readonly ParamSpec[]): StepCell {
  const next: Record<string, unknown> = { ...base };
  for (const id of FIELD_IDS) if (patch[id] !== undefined) next[id] = patch[id];
  for (const { id, min, max, integer } of FIELDS) {
    if (!(integer ? inRangeInt : inRange)(next[id] as number, min, max)) throw new Error(CELL_ERROR);
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
  FIELD_IDS.every((id) => a[id] === b[id]) && Object.keys(a.custom).every((id) => a.custom[id] === b.custom[id]);

function checkFields(patch: LaneFields): void {
  if (patch.steps !== undefined && !inRangeInt(patch.steps, 1, MAX_STEPS)) throw new Error(LANE_ERROR);
  if (patch.direction !== undefined && !DIRECTIONS.includes(patch.direction)) throw new Error(LANE_ERROR);
  if (patch.mute !== undefined && typeof patch.mute !== "boolean") throw new Error(LANE_ERROR);
  if (patch.solo !== undefined && typeof patch.solo !== "boolean") throw new Error(LANE_ERROR);
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

/**
 * Looping lanes of steps over a borrowed beat transport: `new StepSequencer({ kick: "X...X...", hat: { pattern: "xx", rate: "8n" } }, options)`.
 *
 * Every lane loops forever on its own length at its own rate (polymeter). `clock.attach(sequencer)` or `workspace.transport.attach(sequencer)`
 * is all the wiring a live edit needs: each committed change re-queues the transport's look-ahead. Hits reach `onHit`, `hit` events, a
 * per-lane `sound` and the optional `transform`.
 */
export class StepSequencer extends EventTarget {
  private readonly data;
  private readonly heads;
  private readonly progresses;
  private readonly events = new Set<CancellableEvent>();
  private readonly pending = new Set<{ endsAt: number; finish(): void }>();
  private readonly handles = new Set<TransportHandle>();
  private readonly outputs = new Map<string, GainNode>();
  private readonly listeners: Array<{ type: string; listener: EventListenerOrEventListenerObject; options?: boolean | AddEventListenerOptions }> = [];
  private readonly random: () => number;
  private readonly drawChance: ((lane: string, loop: number, count: number) => number) | undefined;
  private readonly seed: number;
  private readonly laneParams = new Map<string, readonly ParamSpec[]>();
  private readonly laneBlank = new Map<string, StepCell>();
  private readonly names: readonly string[];
  private readonly onHitOption: StepSequencerOptions["onHit"];
  private readonly laneHits = new Map<string, NonNullable<LaneOptions["onHit"]>>();
  private readonly userTransform: EventTransform<StepEvent> | undefined;
  private readonly abortSignal: AbortSignal | undefined;
  private readonly onAbort = () => this.dispose();
  private onHitHandler: ((event: HitEvent) => unknown) | null = null;
  private onHitWrapper: EventListener | null = null;
  private stopWatching: (() => void) | undefined;
  private disposed = false;
  /** The context lanes with a `sound` play into, when one was given. */
  readonly context: BaseAudioContext | undefined;
  /** One live view per lane, by name: `sequencer.lanes.kick.steps[4].velocity = 0.8`. */
  readonly lanes: Readonly<Record<string, Lane>>;

  constructor(lanes: Readonly<Record<string, Pattern | LaneOptions>>, options: StepSequencerOptions = {}) {
    super();
    if (typeof options !== "object" || options === null || typeof lanes !== "object" || lanes === null || Array.isArray(lanes))
      throw new Error(ARGUMENTS_ERROR);
    this.seed = options.seed ?? 0;
    this.random = options.random ?? Math.random;
    this.drawChance = options.random ? undefined : (lane, loop, count) => hash01(this.seed, "chance", lane, loop, count);
    if (
      (options.onHit !== undefined && typeof options.onHit !== "function") ||
      (options.transform !== undefined && typeof options.transform !== "function")
    )
      throw new Error(CALLBACK_ERROR);
    this.onHitOption = options.onHit;
    this.context = options.context;
    this.abortSignal = options.signal;
    const built: Record<string, LaneData> = {};
    for (const [name, definition] of Object.entries(lanes)) {
      const lane: LaneOptions =
        typeof definition === "string" || Array.isArray(definition) ? { pattern: definition as Pattern } : (definition as LaneOptions);
      if (!name || !lane || typeof lane !== "object" || lane.pattern === undefined) throw new Error(LANE_RECORD_ERROR);
      const velocities = parsePattern(lane.pattern);
      const specs = toParamSpecs(lane.params);
      const fields: LaneFields = {
        direction: lane.direction ?? "forward",
        mute: lane.mute ?? false,
        solo: lane.solo ?? false,
      };
      checkFields(fields);
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
      const blank: StepCell = Object.freeze({
        ...BUILTIN_CELL,
        custom: Object.freeze(Object.fromEntries(specs.map((spec) => [spec.id, spec.default]))),
      });
      this.laneParams.set(name, Object.freeze(specs));
      this.laneBlank.set(name, blank);
      built[name] = Object.freeze({
        steps: velocities.length,
        rate,
        direction: fields.direction!,
        swing,
        mute: fields.mute!,
        solo: fields.solo!,
        sound: lane.sound,
        cells: Object.freeze(velocities.map((velocity) => makeCell(blank, { velocity }, specs))),
      });
    }
    this.names = Object.freeze(Object.keys(built));
    this.userTransform = options.transform && this.secondsTransform(options.transform);
    this.data = cell<Readonly<Record<string, LaneData>>>(Object.freeze(built));
    this.heads = cell<Readonly<Record<string, number | null>>>(this.stopped());
    this.progresses = cell<Readonly<Record<string, number | null>>>(this.stopped());
    const host: LaneHost = {
      data: (name) => this.data.value[name]!,
      patch: (name, patch) => this.patchLane(name, patch),
      setPattern: (name, velocities) => this.setPattern(name, velocities),
      setCell: (name, index, patch) => this.setCell(name, index, patch),
      params: (name) => this.laneParams.get(name)!,
      playhead: (name) => this.heads.value[name] ?? null,
      progress: (name) => this.progresses.value[name] ?? null,
      output: (name) => this.outputFor(name),
      connect: (name, node) => {
        const output = this.outputFor(name);
        output.disconnect();
        output.connect(node);
        return node;
      },
      disconnect: (name) => this.outputFor(name).disconnect(),
    };
    this.lanes = Object.freeze(Object.fromEntries(this.names.map((name) => [name, new Lane(name, host)])));
    for (const name of this.names) if (built[name]!.sound !== undefined) this.outputFor(name);
    if (this.abortSignal) {
      if (this.abortSignal.aborted) this.dispose();
      else this.abortSignal.addEventListener("abort", this.onAbort, { once: true });
    }
  }

  /** The user's `transform(hit, random)` as a seconds transform over the internal events. */
  private secondsTransform(transform: HitTransform): EventTransform<StepEvent> {
    return {
      id: "transform",
      unit: "second",
      apply: (events, context) => {
        const out: SecondsOf<StepEvent>[] = [];
        const { timing } = context;
        const bad = (field: string): never => {
          throw new Error(`Event transform "transform" returned an event without a finite "${field}".`);
        };
        for (const event of events) {
          const hit = this.publicHit(event);
          const result = transform(hit, (key) => context.randomFor(event, key));
          if (result === null) continue;
          if (typeof result !== "object") return bad("when");
          // Beats win: a changed `beat` or `durationBeats` is mapped through the transport's timing, then any `when` / `duration` delta is added.
          const beatMoved = result.beat !== undefined && result.beat !== hit.beat;
          const lengthMoved = result.durationBeats !== undefined && result.durationBeats !== hit.durationBeats;
          if (beatMoved && !Number.isFinite(result.beat)) bad("beat");
          if (lengthMoved && !(Number.isFinite(result.durationBeats) && result.durationBeats > 0)) bad("durationBeats");
          const whenMoved = result.when !== hit.when;
          const durationMoved = result.duration !== hit.duration;
          let when = result.when;
          let beatAt = hit.beat;
          if (beatMoved) {
            when = timing.beatToTime(result.beat) + (whenMoved ? result.when - hit.when : 0);
            beatAt = whenMoved ? timing.timeToBeat(when) : result.beat;
          } else if (whenMoved && Number.isFinite(when)) beatAt = timing.timeToBeat(when);
          let duration = result.duration;
          let durationBeatsAt = hit.durationBeats;
          if (beatMoved || lengthMoved) {
            const start = beatMoved ? result.beat : hit.beat;
            duration =
              timing.beatToTime(start + result.durationBeats) - timing.beatToTime(start) + (durationMoved ? result.duration - hit.duration : 0);
            durationBeatsAt = result.durationBeats;
          }
          if (durationMoved && Number.isFinite(when) && Number.isFinite(duration))
            durationBeatsAt = timing.timeToBeat(when + duration) - timing.timeToBeat(when);
          out.push({ ...event, when, duration, velocity: result.velocity, pitch: result.pitch, custom: result.values, beatAt, durationBeatsAt });
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
      beat: hit.beatAt,
      durationBeats: hit.durationBeatsAt,
      velocity: hit.velocity,
      pitch: hit.pitch,
      values: hit.custom,
      loop: hit.loop,
    });
  }

  private stopped(): Readonly<Record<string, null>> {
    return Object.freeze(Object.fromEntries(this.names.map((name) => [name, null])));
  }

  /** Lane view by name; throws for an unknown lane. */
  lane(name: string): Lane {
    const lane = Object.prototype.hasOwnProperty.call(this.lanes, name) ? this.lanes[name] : undefined;
    if (!lane) throw new Error(LANE_TARGET_ERROR);
    return lane;
  }

  private replaceLane(name: string, lane: LaneData): void {
    this.data.value = Object.freeze({ ...this.data.value, [name]: lane });
  }

  private patchLane(name: string, patch: LaneFields): void {
    untracked(() => {
      checkFields(patch);
      const lane = this.data.value[name]!;
      const keys = Object.keys(patch) as (keyof LaneFields)[];
      if (keys.every((key) => patch[key] === lane[key])) return;
      let cells = lane.cells;
      if (patch.steps !== undefined && patch.steps > cells.length) {
        const blank = this.laneBlank.get(name)!;
        cells = Object.freeze([...cells, ...Array.from({ length: patch.steps - cells.length }, () => blank)]);
      }
      this.replaceLane(name, Object.freeze({ ...lane, ...patch, cells }));
    });
  }

  private setCell(name: string, index: number, patch: StepCellPatch): void {
    untracked(() => {
      const lane = this.data.value[name]!;
      const before = lane.cells[index]!;
      const after = makeCell(before, patch, this.laneParams.get(name)!);
      if (sameCell(after, before)) return;
      this.replaceLane(name, Object.freeze({ ...lane, cells: Object.freeze(lane.cells.map((item, i) => (i === index ? after : item))) }));
    });
  }

  /** One write: the lane's first cells take `velocities`, and its length becomes their count. */
  private setPattern(name: string, velocities: readonly number[]): void {
    untracked(() => {
      const lane = this.data.value[name]!;
      const blank = this.laneBlank.get(name)!;
      const specs = this.laneParams.get(name)!;
      const size = Math.max(lane.cells.length, velocities.length);
      const cells = Array.from({ length: size }, (_, i) => {
        const base = lane.cells[i] ?? blank;
        return i < velocities.length ? makeCell(base, { velocity: velocities[i] }, specs) : base;
      });
      const changed = lane.steps !== velocities.length || cells.some((item, i) => item !== lane.cells[i] && !sameCell(item, lane.cells[i] ?? blank));
      if (!changed) return;
      this.replaceLane(name, Object.freeze({ ...lane, steps: velocities.length, cells: Object.freeze(cells) }));
    });
  }

  /** The lane's step length in beats. Seconds convert at the tempo at beat 0 of `timing`. */
  private rateBeats(lane: LaneData, timing: BeatTiming): number {
    const { rate } = lane;
    if (isStepRate(rate)) return RATE_BEATS[rate];
    const parsed = parseTime(rate);
    if (parsed.unit === "beats") return parsed.value;
    const beatSeconds = timing.beatToTime(1) - timing.beatToTime(0);
    return beatSeconds > 0 ? parsed.value / beatSeconds : 0;
  }

  /**
   * Register this window's hits with `window.own`. Called by the transport a sequencer is attached to (`clock.attach`,
   * `workspace.transport.attach`) with the window and the Timeline it came from; applications do not call it.
   */
  schedule(window: StepWindow, timing: BeatTiming): void {
    untracked(() => {
      if (this.disposed) return;
      const lanes = this.data.value;
      const now = window.time.current;
      for (const record of [...this.pending]) if (record.endsAt <= now) record.finish();
      const soloed = this.names.some((name) => lanes[name]!.solo);
      const planned: StepEvent[] = [];
      for (const name of this.names) {
        const lane = lanes[name]!;
        if (lane.mute || (soloed && !lane.solo)) continue;
        const rate = this.rateBeats(lane, timing);
        if (!(rate >= MIN_RATE_BEATS)) continue;
        // the lane's step counter runs from beat 0, forever
        const first = Math.max(0, Math.ceil(window.beat.start / rate - EPS));
        const end = Math.ceil(window.beat.end / rate - EPS);
        for (let k = first; k < end; k++) {
          const loop = Math.floor(k / lane.steps);
          const count = k - loop * lane.steps;
          const step = cellIndex(lane.direction, lane.steps, k);
          const data = lane.cells[step]!;
          if (data.velocity <= 0 || !((this.drawChance ? this.drawChance(name, loop, count) : this.random()) < data.chance)) continue;
          const swung = count % 2 === 1 && lane.swing > 0 ? lane.swing * 0.5 * rate : 0;
          const trigger = k * rate + data.offset * rate + swung;
          for (let repeat = 0; repeat < data.repeat; repeat++) {
            planned.push({
              laneId: name,
              step,
              count,
              velocity: data.velocity,
              pitch: data.pitch,
              custom: data.custom,
              loop,
              beat: trigger + (repeat * rate) / data.repeat,
              durationBeats: (data.length * rate) / data.repeat,
              beatAt: trigger + (repeat * rate) / data.repeat,
              durationBeatsAt: (data.length * rate) / data.repeat,
              repeatIndex: repeat,
              repeatCount: data.repeat,
            });
          }
        }
      }
      // The scheduler, not the transform, validates, converts to seconds, clamps to `now`, plays and owns every output.
      const transforms = this.userTransform ? [this.userTransform] : [];
      for (const hit of applyEventTransforms(planned, transforms, { now, timing, random: this.random, seed: this.seed, keyOf: stepKey })) {
        const event = this.fire(hit);
        if (!event) continue;
        this.events.add(event);
        event.onEnded(() => this.events.delete(event));
        window.own(event, hit.when);
      }
      this.publishPosition(lanes, timing.timeToBeat(now), timing);
    });
  }

  /** One hit's event, voice and callbacks. Returns a retractable event, or `null` when nothing could need retracting. */
  private fire(hit: StepHit): CancellableEvent | null {
    const pub = this.publicHit(hit);
    const sound = this.data.value[hit.laneId]!.sound;
    let voice: Voice | null = null;
    if (sound !== undefined && this.context) {
      try {
        voice = playSound(this.context, sound, this.outputFor(hit.laneId), {
          when: pub.when,
          velocity: pub.velocity,
          pitch: pub.pitch,
          duration: pub.duration,
        });
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
        voice?.stop();
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

  private outputFor(name: string): GainNode {
    if (!this.context) throw new Error(CONTEXT_ERROR);
    let output = this.outputs.get(name);
    if (!output) {
      output = new GainNode(this.context);
      output.connect(this.context.destination);
      this.outputs.set(name, output);
    }
    return output;
  }

  private publishPosition(lanes: Readonly<Record<string, LaneData>>, beat: number, timing: BeatTiming): void {
    const at = Math.max(0, beat);
    const heads: Record<string, number | null> = {};
    const progresses: Record<string, number | null> = {};
    for (const name of this.names) {
      const lane = lanes[name]!;
      const rate = this.rateBeats(lane, timing);
      if (!(rate >= MIN_RATE_BEATS)) {
        heads[name] = null;
        progresses[name] = null;
        continue;
      }
      heads[name] = cellIndex(lane.direction, lane.steps, Math.floor(at / rate + EPS));
      const own = lane.steps * rate;
      progresses[name] = (((at % own) + own) % own) / own;
    }
    const previous = this.heads.value;
    const same = this.names.every((name) => previous[name] === heads[name]);
    batch(() => {
      if (!same) this.heads.value = Object.freeze(heads);
      this.progresses.value = Object.freeze(progresses);
    });
  }

  /**
   * Cancel only this sequencer's events (running each hit's `onHit` cleanup) and clear the playheads. Called by the transport on stop, seek and
   * detach; applications do not call it.
   */
  reset(): void {
    untracked(() => {
      for (const event of [...this.events]) event.cancel();
      this.events.clear();
      batch(() => {
        this.heads.value = this.stopped();
        this.progresses.value = this.stopped();
      });
    });
  }

  /**
   * Called by `clock.attach(sequencer)` (or `workspace.transport.attach`) with a handle to that transport. Every committed edit (a step, a
   * lane's pattern, `rate`, `swing`, `direction`, `mute`, `solo`, `sound`) then calls `handle.refresh()`, which retracts the pending hits and
   * queues them again; several edits in one task re-queue once. Returns the cleanup the transport runs on detach.
   */
  attached(handle: TransportHandle): () => void {
    if (this.disposed) throw new Error(DISPOSED_ERROR);
    this.handles.add(handle);
    if (!this.stopWatching) {
      let armed = false;
      this.stopWatching = untracked(() =>
        effect(() => {
          this.data.$();
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

/** Live view of one lane. Setters validate and commit, so an attached transport hears them on the next pass. */
export class Lane {
  private cache: Step[] = [];
  private view: readonly Step[] = Object.freeze([]);

  /** @internal Built by the sequencer; read `sequencer.lanes.<name>`. */
  constructor(
    readonly name: string,
    private readonly host: LaneHost,
  ) {}

  private data(): LaneData {
    return this.host.data(this.name);
  }

  /** Number of steps this lane loops over (integer 1..128). Growing it brings back the steps a shorter length hid. */
  get length(): number {
    return this.data().steps;
  }

  set length(length: number) {
    this.host.patch(this.name, { steps: length });
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
    return this.data().rate;
  }

  set rate(rate: Time | StepRate) {
    this.host.patch(this.name, { rate: checkRate(rate) });
  }

  /** 0..1. Assign a number or a string like "30%". */
  get swing(): number {
    return this.data().swing;
  }

  set swing(swing: number | `${number}%`) {
    this.host.patch(this.name, { swing: parseSwing(swing) });
  }

  /** The order steps are walked in: "forward", "backward", or "bounce" (up and back without repeating the ends). */
  get direction(): StepDirection {
    return this.data().direction;
  }

  set direction(direction: StepDirection) {
    this.host.patch(this.name, { direction });
  }

  get mute(): boolean {
    return this.data().mute;
  }

  set mute(mute: boolean) {
    this.host.patch(this.name, { mute });
  }

  /** While any lane is soloed, only soloed lanes play. */
  get solo(): boolean {
    return this.data().solo;
  }

  set solo(solo: boolean) {
    this.host.patch(this.name, { solo });
  }

  /** The voice played for each hit, or `undefined`. Setting one needs `options.context`. */
  get sound(): Sound | undefined {
    return this.data().sound;
  }

  set sound(sound: Sound | undefined) {
    if (sound !== undefined) {
      assertSound(sound);
      this.host.output(this.name);
    }
    this.host.patch(this.name, { sound });
  }

  /** The declared per-step params by name. */
  get params(): Readonly<Record<string, ParamRange>> {
    return Object.freeze(Object.fromEntries(this.host.params(this.name).map(({ id, ...range }) => [id, range as ParamRange])));
  }

  /** Step index (0-based) the transport is on right now, or `null` while stopped. Updates once per scheduling window. */
  get playhead(): number | null {
    return this.host.playhead(this.name);
  }

  /** 0..1 through the lane's own loop (`length` steps at `rate`), or `null` while stopped. Updates once per scheduling window. */
  get progress(): number | null {
    return this.host.progress(this.name);
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
    const { host, name } = this;
    const cellAt = () => host.data(name).cells[index]!;
    const values: Record<string, number> = {};
    for (const { id } of host.params(name)) {
      Object.defineProperty(values, id, {
        enumerable: true,
        get: () => cellAt().custom[id]!,
        set: (value: number) => host.setCell(name, index, { custom: { [id]: value } }),
      });
    }
    Object.freeze(values);
    const step: Record<string, unknown> = { values };
    for (const id of FIELD_IDS) {
      Object.defineProperty(step, id, {
        enumerable: true,
        get: () => cellAt()[id],
        set: (value: number) => host.setCell(name, index, { [id]: value }),
      });
    }
    return Object.freeze(step) as Step;
  }
}
