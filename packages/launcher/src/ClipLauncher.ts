import {
  assertSound,
  batch,
  cell,
  effect,
  playSound,
  readonlyCell,
  untracked,
  type BeatTiming,
  type Cell,
  type ReadonlyCell,
  type Sound,
} from "@audiorective/core";
import type {
  ClipEventType,
  ClipLength,
  ClipMode,
  ClipOptions,
  ClipScheduler,
  ClipPatch,
  ClipSettings,
  ClipSpec,
  FollowTarget,
  LaunchOptions,
  LaunchSource,
  Quantize,
  Random,
  ResetReason,
  Scheduler,
  ScheduleHandle,
  SceneSpec,
  TransportAttachment,
  TransportChange,
  TransportWindow,
} from "./types";

export * from "./types";

const EPS = 1e-7;
const FAR = 1e9;

// ---------------------------------------------------------------- helpers
function xmur(str: string): number {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (h ^= h >>> 16) >>> 0;
}
function draw(seed: number, id: string, count: number, key: string | number): number {
  let a = xmur(`${seed}|${id}|${count}|${key}`);
  a = (a + 0x6d2b79f5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
/** Length of a note value in transport beats: "4n" a beat, "8n" half a beat, "1m" a bar of the meter, "2m" two bars. */
export function noteBeats(value: string, barBeats: number): number {
  const m = /^(\d+(?:\.\d+)?)([mn])$/.exec(value);
  if (!m) throw new RangeError(`Clip Launcher requires a note value such as "4n" or "1m", got "${value}".`);
  const n = Number(m[1]);
  return m[2] === "m" ? n * barBeats : 4 / n;
}
const semis = (st: number) => 2 ** (st / 12);

// ---------------------------------------------------------------- events
/** Tells that something happened; the state itself is in the cells. "started" and "ended" are dispatched on the first clock tick at or after `when` (up to ~25 ms later), never before. */
export class ClipEvent extends Event {
  declare readonly type: ClipEventType;
  readonly track: Track;
  /** The clip queued, started, ended, cancelled or skipped; null for a queued or cancelled stop. */
  readonly clip: Clip | null;
  /** Exact audio-context time it takes effect (started, ended) or would have; use it, not `currentTime` at delivery. null only for "queued" and "cancelled" of a launch made while the clock is stopped or paused, and for "skipped" by `transform`. */
  readonly when: number | null;
  /** Material beat reached at `when`: where a "started" clip begins (its `offsetBeats`, or the legato phase), where an "ended" one is (its length, or its position when stopped); null for the other types and for a stop. Same unit as `Clip.position`. */
  readonly offsetBeats: number | null;
  constructor(type: ClipEventType, track: Track, clip: Clip | null, when: number | null, offsetBeats: number | null) {
    super(type);
    this.track = track;
    this.clip = clip;
    this.when = when;
    this.offsetBeats = offsetBeats;
  }
}

/** A launch or stop as it is about to be scheduled. */
export type LaunchRequest = Readonly<{
  track: Track;
  /** The clip that will start; null for a stop. */
  clip: Clip | null;
  /** What caused it. */
  source: LaunchSource;
  quantize: Quantize;
  /** Beat of the boundary; null while the clock is stopped or paused (the launch waits for `start` or `resume`, so there is no boundary yet and setting `beat` or `when` is ignored: change `quantize`). */
  beat: number | null;
  /** Audio-context time of that beat at the current tempo; null like `beat`. */
  when: number | null;
  legato: boolean;
}>;
/** Return the request to schedule or `null` to drop it. Change `quantize` to aim at another boundary, or `beat` for an exact one (`when` follows); the clip is fixed. */
export type LaunchTransform = (launch: LaunchRequest, random: Random) => LaunchRequest | null;
/** A launch (`clip`) or stop (`clip` null) that was just scheduled. */
export interface ScheduledChange {
  readonly track: Track;
  readonly clip: Clip | null;
  /** Audio-context time the change takes effect; the current time for quantize "none". */
  readonly when: number;
  /** Audio-context time a playing one-shot ends; null for a loop, a stop or an unknown length. */
  readonly endsAt: number | null;
}
/** A launch or stop waiting for its boundary. */
export interface QueuedChange {
  track: Track;
  /** The clip that will start; null for a stop. */
  clip: Clip | null;
  /** Audio-context time of the boundary; null while the clock is stopped or paused. Follows tempo changes. */
  when: number | null;
  /** Beat of the boundary; null while the clock is stopped or paused. */
  beat: number | null;
}
/** The chain `playChain` is playing. */
export interface SceneChain {
  /** The scene indices, in play order. */
  readonly scenes: readonly number[];
  /** The entry sounding: `scenes[index]`; -1 until the first entry starts. */
  readonly index: number;
}
export interface LauncherOptions {
  /** The context the clips play into. */
  context: BaseAudioContext;
  /** Initial value of `launcher.quantize`. Default "1m". */
  quantize?: Quantize;
  /** Seeds every random draw (`chance`, `follow`, `transform`): each is a pure function of the seed, the clip and the launch count. Default 0. */
  seed?: number;
  /** One name and tempo per scene slot. */
  scenes?: readonly SceneSpec[];
  /**
   * What a scene launch (`launchScene(index)` and each entry of `playChain`) does to a track whose slot in that scene is empty: "keep" leaves whatever it plays alone, "stop" stops it on the scene's
   * boundary, as a Session view does. Default "keep". A `launchScene` given a clip list always leaves the other tracks alone.
   */
  emptySlots?: "keep" | "stop";
  /** Runs on every launch and stop before it is queued, so one rule can rewrite or drop them. */
  transform?: LaunchTransform;
  /** Aborting the signal calls `dispose()`. */
  signal?: AbortSignal;
  /**
   * Called once per launch or stop when it is handed to the audio graph, so a host can switch other audio at the same boundary; a launch made while the clock is stopped or paused
   * is reported when it starts or resumes. A tempo change while a change waits calls the returned `cancel()` and then `onSchedule` again with the new `when`. Returns optional callbacks.
   */
  onSchedule?: (change: ScheduledChange) => ScheduleHandle | void;
}

// ---------------------------------------------------------------- internal records
type Src =
  | { kind: "buffer"; buffer: AudioBuffer }
  | { kind: "factory"; factory: Exclude<Sound, AudioBuffer> }
  | { kind: "scheduler"; sched: ClipScheduler };

/** What the launcher does to a clip's running source: a node, or a factory voice that frees itself. */
type Playing = {
  stop(when?: number): void;
  disconnect(): void;
  addEventListener(type: "ended", listener: () => void, options?: { once?: boolean }): void;
};

/** One playback of a clip: from its start until it is replaced, stopped or ends. */
type Inst = {
  id: number;
  clip: Clip;
  track: Track;
  cfg: ClipSettings; // snapshot: mode/length/offset/bpm/warp apply from the next start
  kind: Src["kind"];
  state: "scheduled" | "live" | "ended";
  startTime: number;
  startBeat: number;
  mat0: number; // material beat at anchor
  anchorTime: number;
  anchorBeat: number;
  frozen: number | null; // material position while paused
  pausedAt: number | null;
  pf: number; // pitch factor
  rate: number; // last playbackRate set
  loop: { start: number; end: number } | null; // buffer loop region in material beats
  period: number | null; // non-buffer loop period
  endMat: number | null; // material beat where a one-shot ends
  source: Playing | null;
  stopTime: number | null; // scheduled replacement/stop
  stopBeat: number | null;
  follow: { beat: number } | null;
  repeatBeat: number | null;
  replaced: Inst | null;
  handle: ScheduleHandle | null;
  /** The host's handle for the stop that is waiting for or ended this instance. */
  stopHandle: ScheduleHandle | null;
  s: number; // scheduler clips: sub-beat = beat - s
  swap: Inst | null; // pending loop-wrap swap
  /** scheduler clips: the events the clip registered with `own` and the audio time `feed` last cut them from (stop, replacement or the end of the material). */
  owned: Map<{ cancel(time?: number): void }, { when: number; cut: number | null }>;
  cutFrom: number | null;
};
type Pending = { clip: Clip | null; source: LaunchSource; quantize: Quantize; beat: number | null; legato: boolean; asIf?: boolean; chain?: number };
/** A `playChain` in progress: `entry` is the next entry to begin, at transport beat `start` (null until the transport gives the first one a beat). */
type ChainRun = { scenes: readonly number[]; entry: number; start: number | null };
type Commit = { kind: "start"; inst: Inst; when: number } | { kind: "stop"; target: Inst; when: number; beat: number };
type Item = { when: number; rank: number; seq: number; owner: Inst | null; run: () => void };

// ---------------------------------------------------------------- Scene / Track / Clip
export class Scene {
  private readonly label: Cell<string>;
  /** Tracked. */
  get name(): string {
    return this.label.value;
  }
  /** @internal Keeps the name of a scene a host mirrors in step with its own. */
  _rename(name: string): void {
    this.label.value = name;
  }
  /** Slot index; 0 is the first scene. Follows `insertScene` and `removeScene`. */
  index: number;
  /** BPM set at the scene's shared boundary when `launchScene(index)` lands; null leaves the tempo. Writable. It is not subject to `transform` or `chance`: it changes at that boundary even when `transform` delays or drops, or a draw skips, some or all clips of the scene. */
  readonly tempo: Cell<number | null>;
  constructor(index: number, spec: SceneSpec | undefined) {
    this.index = index;
    this.label = cell(spec?.name ?? `Scene ${index + 1}`);
    this.tempo = cell<number | null>(spec?.tempo ?? null);
  }
}

export class Clip {
  readonly track: Track;
  /** Slot in `track.clips`; the scene this clip belongs to. Follows `insertScene` and `removeScene`. */
  index: number;
  /** Every option with its default; replaced by `configure`. */
  readonly options: ReadonlyCell<ClipSettings>;
  /** Live volume in decibels. */
  readonly gainDb: Cell<number>;
  /** Live pitch in semitones; a buffer's playback rate follows it, a factory reads it at start, a scheduler clip ignores it. */
  readonly pitch: Cell<number>;
  /** True from the clip's start until it is replaced, stopped or ends; independent of `queued`. */
  readonly playing: ReadonlyCell<boolean>;
  /** True while a launch of this clip waits, whether or not the clip is playing now. */
  readonly queued: ReadonlyCell<boolean>;
  /** Audio-context time the waiting launch starts; null when none waits or the clock is stopped or paused. */
  readonly startsAt: ReadonlyCell<number | null>;
  /** Audio-context time the playing clip started, moved later by every pause so that `position` follows from it; null when not playing. */
  readonly startedAt: ReadonlyCell<number | null>;
  /** @internal */ readonly _opts: Cell<ClipSettings>;
  /** @internal */ readonly _playing = cell(false);
  /** @internal */ readonly _queued = cell(false);
  /** @internal */ readonly _startsAt = cell<number | null>(null);
  /** @internal */ readonly _startedAt = cell<number | null>(null);
  /** @internal */ _src: Src;
  /** @internal */ readonly _buffer: Cell<AudioBuffer | null>;
  /** @internal */ readonly _out: GainNode;
  /** @internal */ readonly _uid: string;
  /** @internal */ _count = 0;
  /** @internal */ _bpmPending: boolean;
  /** @internal */ _stop: () => void;

  /** @internal Made by `ClipLauncher` and `Track.setClip`. */
  constructor(track: Track, index: number, spec: ClipSpec, launcher: ClipLauncher) {
    this.track = track;
    this.index = index;
    this._uid = `${track.name}/${index}`;
    const o: ClipOptions = spec instanceof AudioBuffer ? { buffer: spec } : spec;
    if ("sound" in o) assertSound(o.sound);
    this._src =
      "buffer" in o
        ? { kind: "buffer", buffer: o.buffer }
        : "sound" in o
          ? o.sound instanceof AudioBuffer
            ? { kind: "buffer", buffer: o.sound }
            : { kind: "factory", factory: o.sound }
          : { kind: "scheduler", sched: o.scheduler };
    this._buffer = cell(this._src.kind === "buffer" ? this._src.buffer : null);
    this.buffer = readonlyCell(this._buffer);
    this._bpmPending = o.bpm === undefined;
    this._opts = cell<ClipSettings>({
      name: o.name ?? `${track.name} ${index + 1}`,
      loop: o.loop ?? false,
      length: o.length ?? null,
      offsetBeats: o.offsetBeats ?? 0,
      quantize: o.quantize ?? null,
      mode: o.mode ?? "trigger",
      repeatBeats: o.repeatBeats ?? 1,
      chance: o.chance ?? 1,
      follow: o.follow ?? null,
      legato: o.legato ?? false,
      bpm: o.bpm ?? launcher._tempoNow(),
      warp: o.warp ?? "repitch",
    });
    validate(this._opts.value);
    this.options = readonlyCell(this._opts);
    this.gainDb = cell(o.gainDb ?? 0);
    this.pitch = cell(o.pitch ?? 0);
    this.playing = readonlyCell(this._playing);
    this.queued = readonlyCell(this._queued);
    this.startsAt = readonlyCell(this._startsAt);
    this.startedAt = readonlyCell(this._startedAt);
    this._out = new GainNode(launcher.context);
    this._out.connect(track.output);
    const stopGain = untracked(() => effect(() => launcher._applyGain(this, this.gainDb.value)));
    const stopPitch = untracked(() => effect(() => launcher._applyPitch(this, this.pitch.value)));
    let stopScheduler: (() => void) | undefined;
    if (this._src.kind === "scheduler") {
      const sched = this._src.sched;
      for (const lane of Object.values(sched.lanes ?? {})) {
        try {
          lane.connect(this._out);
        } catch {
          /* a hit-only sequencer (no context) has no lane output to route */
        }
      }
      if (!sched.lanes) sched.connect?.(this._out);
      // live edits of a pattern re-queue just this launcher's look-ahead
      const cleanup = sched.attached?.({
        refresh: () => launcher._reseedSoon(),
        detach: () => {},
        now: () => launcher._now(),
        loopBeats: () => {
          const cfg = this._opts.value;
          return cfg.loop && cfg.length != null ? launcher._materialBeats(this, cfg) : null;
        },
      });
      if (typeof cleanup === "function") stopScheduler = cleanup;
    }
    this._stop = () => {
      stopGain();
      stopPitch();
      stopScheduler?.();
      this._out.disconnect();
    };
  }
  /** The audio of a buffer clip (null for a `sound` factory or `scheduler` clip); replace it with `configure({ buffer })`. */
  readonly buffer: ReadonlyCell<AudioBuffer | null>;
  /** Display name: `options.value.name`. */
  get name(): string {
    return this._opts.value.name;
  }
  /** `options.value.mode`. */
  get mode(): ClipMode {
    return this._opts.value.mode;
  }
  /** One pass in seconds at the current tempo (a warped buffer clip changes with it; otherwise a buffer's own length); null for an endless factory or scheduler clip. */
  get duration(): number | null {
    const L = this.lengthBeats;
    const c = this._opts.value;
    if (L == null) return null;
    return this._src.kind === "buffer" && !c.warp ? (L * 60) / c.bpm : (L * 60) / this.track.launcher._tempoNow();
  }
  /** One pass in material beats, the unit of `position`, `offsetBeats` and `loop`; null for an endless clip. */
  get lengthBeats(): number | null {
    return this.track.launcher._materialBeats(this);
  }
  /** Beats into the material now (material beats, 0 is its first beat), inside the loop region while looping; frozen while paused; null when not playing. Read it each frame, not tracked. */
  get position(): number | null {
    return untracked(() => this.track.launcher._positionOf(this));
  }
  /** Replaces the track's playing clip at the next boundary of `quantize`, and the track's waiting launch if any; the playing clip is untouched until then. Launching the clip that is playing restarts it at the boundary; it never plays twice. */
  launch(options?: LaunchOptions): void {
    untracked(() => this.track.launcher._launchClip(this, options));
  }
  /**
   * Lets go of a held clip: gate and repeat stop at the next boundary of the clip's quantize (a repeat still retriggers until then); other modes ignore it.
   * A gate released while its launch still waits cancels that launch ("cancelled"), and what plays keeps playing.
   */
  release(): void {
    untracked(() => this.track.launcher._releaseClip(this));
  }
  /**
   * Changes options after construction (`name`, `loop`, `length`, `offsetBeats`, `quantize`, `mode`, `repeatBeats`, `chance`, `follow`, `legato`, `bpm`, `warp`; `null` clears a nullable one), in one batch.
   * `quantize`, `chance`, `legato` and `name` apply to the next launch or stop (a launch already waiting keeps its boundary and its draw); `repeatBeats` to the next retrigger;
   * `follow` at once, also on a playing clip (re-armed from its start, due immediately and still quantized if the new `after` has passed; `null` cancels it);
   * `loop` at the playing buffer clip's next loop wrap (the current pass finishes first); `mode`, `length`, `offsetBeats`, `bpm` and `warp` from the clip's next start, so a playing clip keeps them.
   * Throws RangeError for `chance` outside 0..1, `repeatBeats` <= 0, or a loop with endBeat <= startBeat.
   */
  configure(patch: ClipPatch): void {
    untracked(() => {
      const { buffer, ...settings } = patch;
      if (buffer !== undefined && this._src.kind !== "buffer") throw new TypeError("Clip Launcher can only replace the buffer of a buffer clip.");
      const next = { ...this._opts.value, ...settings };
      validate(next);
      batch(() => {
        this._opts.value = next;
        if (buffer !== undefined) {
          this._src = { kind: "buffer", buffer };
          this._buffer.value = buffer;
        }
      });
      if (buffer !== undefined) this.track.launcher._swapBuffer(this);
      this.track.launcher._configured(this, settings);
    });
  }
  /** Withdraws this clip's waiting launch; a playing clip keeps playing. Returns whether one was withdrawn. */
  cancelQueued(): boolean {
    return untracked(() => this.track.launcher._cancelClipQueued(this));
  }
}

function validate(c: ClipSettings): void {
  if (!(c.chance >= 0 && c.chance <= 1)) throw new RangeError(`Clip Launcher requires chance in 0..1, got ${c.chance}.`);
  if (!(c.repeatBeats > 0)) throw new RangeError(`Clip Launcher requires repeatBeats above 0, got ${c.repeatBeats}.`);
  if (typeof c.loop === "object" && !(c.loop.endBeat > c.loop.startBeat))
    throw new RangeError("Clip Launcher requires a loop with endBeat after startBeat.");
}

/** Plays one clip at a time. */
export class Track {
  readonly name: string;
  readonly launcher: ClipLauncher;
  /** Where the track's sound arrives; joined to the context destination until `connect` reroutes it. */
  readonly output: GainNode;
  /** The clip playing on this track now, or null. */
  readonly playing: ReadonlyCell<Clip | null>;
  /** The track's waiting launch or stop, or null. */
  readonly queued: ReadonlyCell<QueuedChange | null>;
  /** @internal */ readonly _clips: (Clip | null)[] = [];
  /** @internal */ readonly _playing = cell<Clip | null>(null);
  /** @internal */ readonly _queued = cell<QueuedChange | null>(null);
  /** @internal */ pending: Pending | null = null;
  /** @internal */ commit: Commit | null = null;
  /** @internal */ cur: Inst | null = null;
  /** @internal */ insts = new Set<Inst>();

  /** @internal Made by `ClipLauncher`. */
  constructor(name: string, launcher: ClipLauncher) {
    this.name = name;
    this.launcher = launcher;
    this.output = new GainNode(launcher.context);
    this.output.connect(launcher.context.destination);
    this.playing = readonlyCell(this._playing);
    this.queued = readonlyCell(this._queued);
  }
  /** One entry per scene slot: clips[0] is the first slot (scene 1); an empty slot is null. */
  get clips(): readonly (Clip | null)[] {
    return this._clips;
  }
  /**
   * Silences the track at the next boundary of `options.quantize`, else the playing clip's `quantize`, else `launcher.quantize`; replaces its waiting launch.
   * Does nothing on an idle track.
   */
  stop(options?: LaunchOptions): void {
    untracked(() => this.launcher._stopTrack(this, options));
  }
  /** Withdraws the waiting launch or stop; what plays keeps playing. Returns whether one was withdrawn. */
  cancelQueued(): boolean {
    return untracked(() => this.launcher._cancelTrackQueued(this));
  }
  /** Puts `spec` (or nothing) in slot `index`, growing `clips` if needed. A playing or waiting clip that is replaced is stopped or withdrawn at once. */
  setClip(index: number, spec: ClipSpec | null): Clip | null {
    return untracked(() => this.launcher._setClip(this, index, spec));
  }
  /** Route the output to `node` instead of the destination, like `AudioNode.connect`. Returns `node`. */
  connect(node: AudioNode, output?: number, input?: number): AudioNode {
    this.output.disconnect();
    this.output.connect(node, output, input);
    return node;
  }
  disconnect(): void {
    this.output.disconnect();
  }
}

// ---------------------------------------------------------------- the launcher
/**
 * Tracks of clips over a borrowed clock: `new ClipLauncher({ bass: [loopA, null, loopB] }, { context })`, then `clock.attach(launcher)`.
 * A launch made while the clock is stopped waits, survives `clock.start(when, offsetBeats)` and starts exactly at `when`, on beat `offsetBeats`
 * (beat 0 by default; `when` defaults to now). Pausing freezes the launcher: the clips go silent, and on `resume()` playing clips continue from the material position they paused at, waiting
 * launches and pending follows keep their beats and happen as the transport reaches them (a launch made while paused waits for `resume()`); no event is dispatched for the pause itself. Stopping, seeking or detaching silences every clip and clears the waiting
 * changes and pending follows; `start()` while playing silences the clips but keeps the waiting ones. A waiting launch per track: launching a track replaces only that
 * track's waiting launch. A waiting boundary is fixed in beats: when the tempo changes its `when` moves (the `queued` cells and the "queued" event carry the new `when`, a host's `onSchedule` is called again after its `cancel()`).
 * Commands never subscribe a calling effect. A one-shot ends at its exact end.
 * A `scheduler` clip (a step sequencer or any clock scheduler) is played by the launcher, not attached to the clock: it sees windows whose beat 0 is the clip's start and is reset when the clip stops.
 * Its sound is routed into the track's output by the launcher, so the caller never connects it. Several pattern clips playing at once share this launcher's one scheduler on the clock:
 * a switch inside the look-ahead retracts the launcher's events from the boundary on and feeds every playing pattern clip again, so no hit is doubled or missing; other schedulers on the clock are untouched.
 * Events: "queued", "started", "ended", "cancelled" and "skipped" (`ClipEvent`).
 */
export class ClipLauncher extends EventTarget implements Scheduler {
  /** The context the clips play into. */
  readonly context: BaseAudioContext;
  /** One per key: `launcher.tracks.bass.clips[0]`. */
  readonly tracks: Readonly<Record<string, Track>>;
  /** One per slot: `launcher.scenes[0]` is the first scene. Grows and shrinks with `insertScene` and `removeScene`; a tracked read. */
  get scenes(): readonly Scene[] {
    this.sceneRevision.$();
    return this.sceneList;
  }
  private readonly sceneRevision = cell(0);
  private readonly sceneList: Scene[];
  /** Boundary used when a call and the clip give none. Writable. */
  readonly quantize: Cell<Quantize>;
  /** The playing clip of every track that has one. */
  readonly playing: ReadonlyCell<readonly Clip[]>;
  /** Every waiting launch and stop, soonest first. */
  readonly queued: ReadonlyCell<readonly QueuedChange[]>;
  /** The chain `playChain` is playing: its scenes and the index of the entry sounding (-1 until the first starts); null when no chain plays. */
  readonly chain: ReadonlyCell<SceneChain | null>;

  private readonly seed: number;
  private readonly transform?: LaunchTransform;
  private readonly onSchedule?: LauncherOptions["onSchedule"];
  private readonly emptySlots: "keep" | "stop";
  private handle: TransportAttachment | null = null;
  private lastWindow: TransportWindow | null = null;
  private lastTiming: BeatTiming | null = null;
  private lastEnd = 0;
  private inWindow = false;
  private dirtyFrom: number | null = null;
  private items: Item[] = [];
  private seq = 0;
  private instId = 0;
  private internalTempo = 0;
  private sceneTempos: Array<{ beat: number | null; tempo: number; time: number | null }> = [];
  private reseedQueued = false;
  private disposed = false;
  private readonly listeners: Array<[string, EventListenerOrEventListenerObject, boolean | AddEventListenerOptions | undefined]> = [];
  private readonly abortSignal?: AbortSignal;
  private readonly onAbort = () => this.dispose();
  private readonly chainCell = cell<SceneChain | null>(null);
  private chainRun: ChainRun | null = null;

  /** Each array is one track's scene slots; null leaves a slot empty. */
  constructor(tracks: Readonly<Record<string, readonly (ClipSpec | null)[]>>, options: LauncherOptions) {
    super();
    this.context = options.context;
    this.quantize = cell<Quantize>(options.quantize ?? "1m");
    this.seed = options.seed ?? 0;
    this.transform = options.transform;
    this.onSchedule = options.onSchedule;
    this.emptySlots = options.emptySlots ?? "keep";
    const slots = Math.max(0, ...Object.values(tracks).map((c) => c.length), options.scenes?.length ?? 0);
    this.sceneList = Array.from({ length: slots }, (_, i) => new Scene(i, options.scenes?.[i]));
    const made: Record<string, Track> = {};
    for (const [name, specs] of Object.entries(tracks)) {
      const t = new Track(name, this);
      made[name] = t;
      specs.forEach((spec, i) => t._clips.push(spec ? new Clip(t, i, spec, this) : null));
      while (t._clips.length < slots) t._clips.push(null);
    }
    this.tracks = made;
    const all = Object.values(made);
    this.playing = readonlyCell(() => all.map((t) => t._playing.value).filter((c): c is Clip => !!c));
    this.queued = readonlyCell(() =>
      all
        .map((t) => t._queued.value)
        .filter((q): q is QueuedChange => !!q)
        .sort((a, b) => (a.when ?? Infinity) - (b.when ?? Infinity)),
    );
    this.chain = readonlyCell(this.chainCell);
    this.abortSignal = options.signal;
    if (this.abortSignal?.aborted) this.dispose();
    else this.abortSignal?.addEventListener("abort", this.onAbort);
  }

  // ------------------------------------------------------------ time helpers
  private get timeline() {
    return this.handle?.timeline ?? null;
  }
  private isPlaying(): boolean {
    return !!this.handle && this.handle.state.value === "playing";
  }
  /** @internal The audio-context time now, for a scheduler clip's handle. */ _now(): number {
    return this.now();
  }
  private now(): number {
    return this.context.currentTime;
  }
  private nowBeat(): number {
    return this.timeline!.timeToBeat(this.now());
  }
  private beatTime(beat: number): number {
    return this.timeline!.beatToTime(beat);
  }
  private barBeats(): number {
    const [n, d] = this.handle ? untracked(() => this.handle!.meter.value) : [4, 4];
    return (n * 4) / d;
  }
  /** @internal */ _tempoNow(): number {
    const tl = this.timeline;
    return tl ? untracked(() => tl.bpm.value) : 120;
  }
  /** @internal The material of a clip is [0, this): a buffer's own length (a shorter `length` cuts it), `length` for a factory or scheduler, null when endless. */
  _materialBeats(clip: Clip, cfg: ClipSettings = clip._opts.value): number | null {
    const src = clip._src;
    const bufBeats = src.kind === "buffer" ? (src.buffer.duration * cfg.bpm) / 60 : null;
    if (cfg.length == null) return bufBeats;
    const beats = bufBeats != null && typeof cfg.length === "number" ? (cfg.length * cfg.bpm) / 60 : this._beats(cfg.length);
    return bufBeats == null ? beats : Math.min(beats, bufBeats);
  }
  /** @internal */ _beats(len: ClipLength, tempo = this._tempoNow()): number {
    return typeof len === "number" ? (len * tempo) / 60 : noteBeats(len, this.barBeats());
  }
  private boundary(q: Quantize, base: number): number {
    if (q === "none") return base;
    const size = noteBeats(q, this.barBeats());
    return Math.ceil(base / size - EPS) * size;
  }
  private whenOf(beat: number): number {
    return Math.max(this.beatTime(beat), this.now());
  }
  private rnd(id: string, count: number): Random {
    return (key = 0) => draw(this.seed, id, count, key);
  }
  private clipQuantize(clip: Clip | null): Quantize {
    return (clip && clip._opts.value.quantize) ?? this.quantize.value;
  }

  // ------------------------------------------------------------ cells and events
  private emit(type: ClipEventType, track: Track, clip: Clip | null, when: number | null, offsetBeats: number | null = null): void {
    this.dispatchEvent(new ClipEvent(type, track, clip, when, offsetBeats));
  }
  private syncCells(track: Track): void {
    batch(() => {
      const live = [...track.insts].filter((i) => i.state === "live");
      const playing = live.length ? live[live.length - 1]!.clip : null;
      if (track._playing.value !== playing) track._playing.value = playing;
      const c = track.commit;
      const startsFuture = c && c.kind === "start" && c.inst.state === "scheduled" ? c.inst : null;
      let q: QueuedChange | null = null;
      if (track.pending) {
        const b = track.pending.beat;
        q = { track, clip: track.pending.clip, beat: b, when: b == null ? null : this.beatTime(b) };
      } else if (startsFuture) q = { track, clip: startsFuture.clip, beat: startsFuture.startBeat, when: startsFuture.startTime };
      else if (c && c.kind === "stop" && c.when > this.now()) q = { track, clip: null, beat: c.beat, when: c.when };
      const prev = track._queued.value;
      if (!prev || !q || prev.clip !== q.clip || prev.when !== q.when || prev.beat !== q.beat) track._queued.value = q;
      for (const clip of track._clips) {
        if (!clip) continue;
        const isLive = live.some((i) => i.clip === clip);
        const waiting = (track.pending?.clip === clip ? 1 : 0) || (startsFuture?.clip === clip ? 2 : 0);
        const startsAt =
          waiting === 2 ? startsFuture!.startTime : waiting === 1 && track.pending!.beat != null ? this.beatTime(track.pending!.beat) : null;
        if (clip._playing.value !== isLive) clip._playing.value = isLive;
        if (clip._queued.value !== !!waiting) clip._queued.value = !!waiting;
        if (clip._startsAt.value !== startsAt) clip._startsAt.value = startsAt;
        if (!isLive && clip._startedAt.value !== null) clip._startedAt.value = null;
      }
    });
  }
  private syncAll(): void {
    for (const t of Object.values(this.tracks)) this.syncCells(t);
  }
  private addItem(when: number, rank: number, owner: Inst | null, run: () => void): Item {
    const it = { when, rank, seq: this.seq++, owner, run };
    this.items.push(it);
    return it;
  }
  private dropItems(owner: Inst, rank?: number): void {
    this.items = this.items.filter((i) => !(i.owner === owner && (rank === undefined || i.rank === rank)));
  }
  /** Delivers what is due: events and cell changes for starts and ends, never before their audio time. */
  private flush(): void {
    const now = this.now();
    if (!this.items.length) return;
    const due = this.items.filter((i) => i.when <= now + 1e-9).sort((a, b) => a.when - b.when || a.rank - b.rank || a.seq - b.seq);
    if (!due.length) return;
    this.items = this.items.filter((i) => !due.includes(i));
    batch(() => due.forEach((i) => i.run()));
    this.sceneTempos = this.sceneTempos.filter((s) => s.beat == null || s.time == null || s.time > now);
    if (this.timeline && this.isPlaying()) this.syncAll();
  }

  // ------------------------------------------------------------ position
  private beatAt(t: number): number {
    return this.timeline!.timeToBeat(t);
  }
  private wrap(inst: Inst, p: number): number {
    if (inst.loop) {
      const { start, end } = inst.loop;
      return p >= end ? start + ((p - start) % (end - start)) : p;
    }
    if (inst.endMat != null) return Math.min(p, inst.endMat);
    if (inst.period) return p % inst.period;
    return p;
  }
  private posOf(inst: Inst, t: number): number {
    if (inst.frozen != null) return inst.frozen;
    const adv =
      inst.kind === "buffer" && !inst.cfg.warp
        ? ((t - inst.anchorTime) * inst.cfg.bpm * inst.pf) / 60
        : (this.beatAt(t) - inst.anchorBeat) * (inst.kind === "buffer" ? inst.pf : 1);
    return this.wrap(inst, inst.mat0 + Math.max(0, adv));
  }
  /** @internal */ _positionOf(clip: Clip): number | null {
    const inst = [...clip.track.insts].find((i) => i.clip === clip && i.state === "live");
    if (!inst || !this.timeline) return null;
    return this.posOf(inst, this.now());
  }

  // ------------------------------------------------------------ commands
  /** @internal */ _launchClip(clip: Clip, options?: LaunchOptions): void {
    this.endChain();
    const track = clip.track;
    const c = clip._opts.value;
    const waiting = clip._queued.value;
    const cur = track.cur && track.cur.state !== "ended" && track.cur.stopBeat == null ? track.cur : null;
    if (c.mode === "toggle") {
      if (waiting) return void this._cancelClipQueued(clip);
      if (cur && cur.clip === clip) return this.requestStop(track, "stop", options?.quantize ?? c.quantize ?? this.quantize.value);
    }
    if (c.mode === "gate" && (waiting || (cur && cur.clip === clip))) return;
    if (options?.at !== undefined && !Number.isFinite(options.at)) throw new RangeError("Clip Launcher requires a finite beat for `at`.");
    this.request({
      track,
      clip,
      source: "launch",
      quantize: options?.at !== undefined ? "none" : (options?.quantize ?? c.quantize ?? this.quantize.value),
      legato: options?.legato ?? c.legato,
      ...(options?.at !== undefined ? { fixedBeat: options.at, asIf: true } : {}),
    });
    this.finishCommand();
  }
  /** @internal */ _releaseClip(clip: Clip): void {
    this.endChain();
    const mode = clip._opts.value.mode;
    if (mode !== "gate" && mode !== "repeat") return;
    const track = clip.track;
    if (clip._queued.value && track.pending?.clip === clip) return void this._cancelClipQueued(clip);
    if (track.commit?.kind === "start" && track.commit.inst.clip === clip && track.commit.when > this.now()) return void this._cancelClipQueued(clip);
    const cur = track.cur;
    if (cur && cur.clip === clip && cur.state !== "ended" && cur.stopBeat == null) this.requestStop(track, "release", this.clipQuantize(clip));
  }
  private requestStop(track: Track, source: "stop" | "release", quantize: Quantize): void {
    this.request({ track, clip: null, source, quantize });
    this.finishCommand();
  }
  /** @internal */ _stopTrack(track: Track, options?: LaunchOptions): void {
    this.endChain();
    const playing = track.cur && track.cur.state !== "ended" && track.cur.stopBeat == null ? track.cur.clip : null;
    this.requestStop(track, "stop", options?.quantize ?? this.clipQuantize(playing));
  }
  /** Silences every track at the next boundary of `options.quantize`, else `launcher.quantize`; the clock keeps running. */
  stopAll(options?: LaunchOptions): void {
    untracked(() => {
      this.endChain();
      const q = options?.quantize ?? this.quantize.value;
      const base = this.isPlaying() ? this.boundary(q, this.nowBeat()) : null;
      for (const t of Object.values(this.tracks)) this.request({ track: t, clip: null, source: "stop", quantize: q, fixedBeat: base });
      this.finishCommand();
    });
  }
  /**
   * Starts `clips[scene]` of every track on one shared boundary (`options.quantize`, else `launcher.quantize`; the clips' own `quantize` is not used) and, with a scene tempo, changes the tempo there;
   * a track whose slot is empty is left alone, unless the launcher was made with `emptySlots: "stop"`, which stops it at the same boundary. A clip list starts exactly those clips, one per track. A scene launch never toggles a clip off, and a gate or repeat clip started this way has no press to release (see `ClipMode`).
   */
  launchScene(scene: number | readonly Clip[], options?: LaunchOptions): void {
    untracked(() => {
      this.endChain();
      this.sceneLaunch(scene, options?.quantize ?? this.quantize.value, undefined, options?.legato);
      this.finishCommand();
    });
  }
  /**
   * Plays `scenes` (scene indices) once, in order: the first starts on the next boundary of `options.quantize` (else `launcher.quantize`), each next one on the exact beat the previous
   * one ends, and every track stops when the last one ends. A scene lasts as long as its longest clip (a bar when none has a length). Any other launch, stop or `cancelQueued` ends the chain;
   * the transport stopping, pausing or seeking ends it too. Read the position from `chain`.
   */
  playChain(scenes: readonly number[], options?: LaunchOptions): void {
    if (!scenes.length || scenes.some((scene) => !Number.isInteger(scene) || scene < 0 || scene >= this.scenes.length))
      throw new RangeError(`playChain needs scene indices from 0 to ${this.scenes.length - 1}.`);
    untracked(() => {
      this.endChain();
      const chain = Object.freeze([...scenes]);
      const q = options?.quantize ?? this.quantize.value;
      const start = this.isPlaying() ? this.boundary(q, this.nowBeat()) : null;
      this.chainRun = { scenes: chain, entry: 0, start };
      this.chainCell.value = Object.freeze({ scenes: chain, index: -1 });
      this.sceneLaunch(chain[0], q, start, options?.legato, 0);
      this.finishCommand();
    });
  }
  // `chain` tags a `playChain` entry, so ending the chain can withdraw it.
  private sceneLaunch(
    scene: number | readonly Clip[],
    q: Quantize,
    fixed: number | null | undefined,
    legato: boolean | undefined,
    chain?: number,
  ): void {
    const base = fixed !== undefined ? fixed : this.isPlaying() ? this.boundary(q, this.nowBeat()) : null;
    this.clearSceneTempos(true);
    const tracks = Object.values(this.tracks);
    const clips = typeof scene === "number" ? tracks.map((t) => t._clips[scene] ?? null) : scene;
    for (const clip of clips)
      if (clip)
        this.request({
          track: clip.track,
          clip,
          source: "scene",
          quantize: q,
          legato: legato ?? clip._opts.value.legato,
          fixedBeat: base,
          chain,
        });
    if (typeof scene === "number" && this.emptySlots === "stop")
      tracks.forEach((t, i) => {
        if (!clips[i]) this.request({ track: t, clip: null, source: "stop", quantize: q, fixedBeat: base, chain });
      });
    const tempo = typeof scene === "number" ? this.scenes[scene]?.tempo.value : null;
    if (tempo != null) this.addSceneTempo(base, tempo);
  }
  // A chain scene lasts as long as its longest clip.
  private sceneBeats(scene: number): number {
    let beats = 0;
    for (const t of Object.values(this.tracks)) {
      const clip = t._clips[scene];
      if (clip) beats = Math.max(beats, this._materialBeats(clip) ?? 0);
    }
    return beats > EPS ? beats : this.barBeats();
  }
  // When the transport reaches the beat an entry begins (it is sounding, so no track's commit can still be withdrawn), report it and queue the next entry, or every
  // track's stop, on the beat it ends. Driven by the chain's own beats, it advances through empty scenes and launches dropped by `chance` or `transform`.
  private advanceChain(): boolean {
    const run = this.chainRun;
    // Compared in time: before the transport's anchor the beat reading is clamped, so a beat test would fire before a stopped-start chain begins.
    if (!run || run.start == null || !this.isPlaying() || this.now() < this.beatTime(run.start) - 1e-9) return false;
    if (run.entry >= run.scenes.length) {
      this.endChain();
      return true;
    }
    const index = run.entry;
    const end = run.start + this.sceneBeats(run.scenes[index]);
    this.chainCell.value = Object.freeze({ scenes: run.scenes, index });
    run.entry = index + 1;
    run.start = end;
    if (run.entry < run.scenes.length) this.sceneLaunch(run.scenes[run.entry], "none", end, undefined, run.entry);
    else
      for (const t of Object.values(this.tracks))
        this.request({ track: t, clip: null, source: "stop", quantize: "none", fixedBeat: end, chain: run.entry });
    return true;
  }
  // Ends the chain and withdraws the changes it queued, so a command on one track does not leave the chain's next entry waiting on the others.
  private endChain(): void {
    if (!this.chainRun) return;
    this.chainRun = null;
    for (const t of Object.values(this.tracks))
      if (t.pending?.chain !== undefined) {
        this.withdraw(t, "cancelled");
        this.syncCells(t);
      }
    if (this.chainCell.value) this.chainCell.value = null;
  }
  /** Withdraws every waiting launch and stop, and a waiting scene tempo. Returns whether any was withdrawn. */
  cancelQueued(): boolean {
    return untracked(() => {
      this.endChain();
      let any = this.sceneTempos.some((s) => s.beat != null && s.time != null && s.time > this.now());
      this.clearSceneTempos(true);
      for (const t of Object.values(this.tracks)) any = this._cancelTrackQueued(t) || any;
      return any;
    });
  }
  /** @internal */ _cancelTrackQueued(track: Track): boolean {
    const had = this.withdraw(track, "cancelled");
    this.syncCells(track);
    this.finishCommand();
    return had;
  }
  /** @internal */ _cancelClipQueued(clip: Clip): boolean {
    const t = clip.track;
    const mine = t.pending?.clip === clip || (t.commit?.kind === "start" && t.commit.inst.clip === clip);
    return mine ? this._cancelTrackQueued(t) : false;
  }
  /**
   * Adds an empty scene slot at `index` (0 to `scenes.length`) on every track. Later scenes and their clips move one slot later and keep playing, queued or not; `scene.index`
   * and `clip.index` follow. A `playChain` in progress keeps naming the same scenes.
   */
  insertScene(index: number, spec?: SceneSpec): Scene {
    if (!Number.isInteger(index) || index < 0 || index > this.sceneList.length)
      throw new RangeError(`insertScene needs an index from 0 to ${this.sceneList.length}.`);
    return untracked(() => {
      const scene = new Scene(index, spec);
      this.sceneList.splice(index, 0, scene);
      for (const t of Object.values(this.tracks)) {
        while (t._clips.length < this.sceneList.length - 1) t._clips.push(null);
        t._clips.splice(index, 0, null);
      }
      this.renumber();
      this.sceneRevision.value++;
      this.shiftChain((i) => (i >= index ? i + 1 : i));
      return scene;
    });
  }

  /**
   * Removes the scene slot at `index` and the clips in it: a clip playing or waiting there is stopped or withdrawn at once. Later scenes and their clips move one slot earlier and
   * keep playing. A `playChain` that includes the scene ends.
   */
  removeScene(index: number): void {
    if (!Number.isInteger(index) || index < 0 || index >= this.sceneList.length)
      throw new RangeError(`removeScene needs an index from 0 to ${this.sceneList.length - 1}.`);
    untracked(() => {
      if (this.chainRun?.scenes.includes(index)) this.endChain();
      for (const t of Object.values(this.tracks)) {
        if (t._clips[index]) this._setClip(t, index, null);
        t._clips.splice(index, 1);
      }
      this.sceneList.splice(index, 1);
      this.renumber();
      this.sceneRevision.value++;
      this.shiftChain((i) => (i > index ? i - 1 : i));
    });
  }
  private renumber(): void {
    this.sceneList.forEach((scene, i) => (scene.index = i));
    for (const t of Object.values(this.tracks)) {
      t._clips.forEach((clip, i) => {
        if (clip) clip.index = i;
      });
      this.syncCells(t);
    }
  }
  private shiftChain(map: (scene: number) => number): void {
    const run = this.chainRun;
    if (!run) return;
    const scenes = Object.freeze(run.scenes.map(map));
    this.chainRun = { ...run, scenes };
    const current = this.chainCell.value;
    if (current) this.chainCell.value = Object.freeze({ scenes, index: current.index });
  }

  /** @internal */ _setClip(track: Track, index: number, spec: ClipSpec | null): Clip | null {
    const old = track._clips[index];
    if (old) {
      if (track.pending?.clip === old || (track.commit?.kind === "start" && track.commit.inst.clip === old)) this.withdraw(track, "cancelled");
      for (const inst of [...track.insts]) {
        if (inst.clip !== old) continue;
        inst.handle?.reset?.();
        inst.stopHandle?.reset?.();
        if (inst.kind === "scheduler") this.dirtyFrom = Math.min(this.dirtyFrom ?? Infinity, this.timeline ? this.nowBeat() : 0);
        this.silence(inst, "ended");
      }
      old._stop();
      this.finishCommand();
    }
    while (track._clips.length <= index) track._clips.push(null);
    const clip = spec ? new Clip(track, index, spec, this) : null;
    track._clips[index] = clip;
    if (clip && this.handle && clip._bpmPending) this.fixBpm(clip);
    this.syncCells(track);
    return clip;
  }
  private fixBpm(clip: Clip): void {
    clip._bpmPending = false;
    clip._opts.value = { ...clip._opts.value, bpm: this._tempoNow() };
  }

  // ------------------------------------------------------------ request pipeline
  private request(o: {
    track: Track;
    clip: Clip | null;
    source: LaunchSource;
    quantize: Quantize;
    legato?: boolean;
    baseBeat?: number;
    fixedBeat?: number | null;
    chance?: boolean;
    keepWaiting?: boolean;
    asIf?: boolean;
    chain?: number;
  }): void {
    const { track, clip, source } = o;
    let quantize = o.quantize;
    const idle = !clip && !track.cur && !track.pending && !(track.commit && track.commit.when > this.now());
    if (idle) return;
    const base = o.baseBeat ?? (this.isPlaying() ? this.nowBeat() : 0);
    let beat: number | null = !this.isPlaying() ? null : o.fixedBeat !== undefined ? o.fixedBeat : this.boundary(quantize, base);
    const id = clip ? clip._uid : `track:${track.name}`;
    const count = clip ? clip._count++ : 0;
    const rnd = this.rnd(id, count);
    let legato = o.legato ?? false;
    if (this.transform) {
      const req: LaunchRequest = { track, clip, source, quantize, beat, when: beat == null ? null : this.whenOf(beat), legato };
      const out = this.transform(req, rnd);
      if (!out) return void this.emit("skipped", track, clip, null);
      if (beat != null && out.beat != null && out.beat !== req.beat) beat = out.beat;
      else if (beat != null && out.quantize !== quantize) beat = this.boundary(out.quantize, base);
      quantize = out.quantize;
      legato = out.legato;
    }
    if (clip && o.chance !== false) {
      const p = clip._opts.value.chance;
      if (p < 1 && rnd("chance") >= p) return void this.emit("skipped", track, clip, beat == null ? null : this.whenOf(beat));
    }
    if (!o.keepWaiting) this.withdraw(track, "cancelled");
    track.pending = { clip, source, quantize, beat, legato, asIf: o.asIf, chain: o.chain };
    this.emit("queued", track, clip, beat == null ? null : this.beatTime(beat));
    this.syncCells(track);
    if (beat != null && beat < this.lastEnd - EPS) this.commitPending(track);
  }
  /** Withdraws the track's waiting launch or stop (also one already handed to the audio graph but not yet sounding). */
  private withdraw(track: Track, why: "cancelled"): boolean {
    let had = false;
    if (track.pending) {
      const p = track.pending;
      track.pending = null;
      had = true;
      this.emit(why, track, p.clip, p.beat == null ? null : this.beatTime(p.beat));
    }
    if (track.commit && track.commit.when > this.now() + 1e-9) {
      const c = track.commit;
      this.undoCommit(track);
      had = true;
      this.emit(why, track, c.kind === "start" ? c.inst.clip : null, c.when);
    }
    return had;
  }
  private finishCommand(): void {
    if (this.inWindow) return;
    while (this.advanceChain());
    if (this.dirtyFrom != null) {
      const from = this.dirtyFrom;
      this.dirtyFrom = null;
      this.reseed(from);
    }
    this.syncAll();
  }

  // ------------------------------------------------------------ commit: hand a boundary to the audio graph
  private commitPending(track: Track): void {
    const p = track.pending;
    if (!p || p.beat == null) return;
    track.pending = null;
    const timeB = this.beatTime(p.beat);
    const when = Math.max(timeB, this.now());
    const startBeat = when > timeB + 1e-9 ? this.beatAt(when) : p.beat;
    this.dirtyFrom = Math.min(this.dirtyFrom ?? Infinity, startBeat);
    if (!p.clip) {
      const target = track.cur;
      if (!target || target.state === "ended") return;
      this.stopAt(target, when, startBeat, "stopped");
      track.commit = { kind: "stop", target, when, beat: startBeat };
      this.notifyHost(track, null, when, null, target);
      return;
    }
    const prev = track.cur && track.cur.state !== "ended" ? track.cur : null;
    let mat0 = p.clip._opts.value.offsetBeats;
    if (p.asIf && when > timeB + 1e-9 && p.clip._src.kind === "buffer") {
      // as if started at p.beat: advance the material by what has elapsed since, at the clip's own rate
      const cfg = p.clip._opts.value;
      mat0 += (cfg.warp ? startBeat - p.beat : ((when - timeB) * cfg.bpm) / 60) * semis(p.clip.pitch.value);
    }
    if (p.legato && prev) mat0 = this.posOf(prev, when);
    const inst = this.startInst(p.clip, when, startBeat, mat0, p.legato && !!prev);
    if (prev) {
      this.stopAt(prev, when, startBeat, "replaced");
      inst.replaced = prev;
    }
    track.cur = inst;
    track.commit = { kind: "start", inst, when };
    this.notifyHost(track, p.clip, when, this.naturalEnd(inst)?.time ?? null, inst);
  }
  private notifyHost(track: Track, clip: Clip | null, when: number, endsAt: number | null, inst: Inst): void {
    const h = this.onSchedule?.({ track, clip, when, endsAt }) || null;
    if (clip) inst.handle = h;
    else inst.stopHandle = h;
  }
  private startInst(clip: Clip, when: number, startBeat: number, mat0In: number, legato: boolean): Inst {
    const track = clip.track;
    const cfg = clip._opts.value;
    const src = clip._src;
    const pf = semis(clip.pitch.value);
    const loopSetting = cfg.loop;
    const lengthBeats = this._materialBeats(clip, cfg);
    const loop =
      src.kind === "buffer" && loopSetting
        ? typeof loopSetting === "object"
          ? { start: loopSetting.startBeat, end: loopSetting.endBeat }
          : { start: 0, end: lengthBeats! }
        : null;
    const period = src.kind !== "buffer" && loopSetting && lengthBeats ? lengthBeats : null;
    const endMat = loopSetting ? null : lengthBeats;
    let mat0 = src.kind === "scheduler" && !legato ? 0 : mat0In;
    if (loop && mat0 >= loop.end) mat0 = loop.start + ((mat0 - loop.start) % (loop.end - loop.start));
    else if (endMat != null && !loopSetting && mat0 >= endMat) mat0 = legato ? mat0 % endMat : mat0;
    const inst: Inst = {
      id: this.instId++,
      clip,
      track,
      cfg,
      kind: src.kind,
      state: "scheduled",
      startTime: when,
      startBeat,
      mat0,
      anchorTime: when,
      anchorBeat: startBeat,
      frozen: null,
      pausedAt: null,
      pf,
      rate: 1,
      loop,
      period,
      endMat,
      source: null,
      stopTime: null,
      stopBeat: null,
      follow: null,
      repeatBeat: null,
      replaced: null,
      handle: null,
      stopHandle: null,
      s: startBeat - mat0,
      swap: null,
      owned: new Map(),
      cutFrom: null,
    };
    track.insts.add(inst);
    this.buildSource(inst, when);
    this.addItem(when, 1, inst, () => this.onStarted(inst));
    this.armEnd(inst);
    if (cfg.follow) inst.follow = { beat: startBeat + this._beats(cfg.follow.after) };
    if (cfg.mode === "repeat") inst.repeatBeat = startBeat + cfg.repeatBeats;
    return inst;
  }
  private rateAt(inst: Inst, t: number): number {
    return inst.pf * (inst.cfg.warp ? this.timeline!.bpm.valueAtTime(t) / inst.cfg.bpm : 1);
  }
  private buildSource(inst: Inst, when: number, matStart = inst.mat0): void {
    const src = inst.clip._src;
    if (src.kind === "buffer") {
      const node = new AudioBufferSourceNode(this.context, { buffer: src.buffer });
      inst.rate = this.rateAt(inst, when);
      node.playbackRate.value = inst.rate;
      if (inst.loop) {
        node.loop = true;
        node.loopStart = (inst.loop.start * 60) / inst.cfg.bpm;
        node.loopEnd = (inst.loop.end * 60) / inst.cfg.bpm;
      }
      node.connect(inst.clip._out);
      node.start(when, (matStart * 60) / inst.cfg.bpm);
      inst.source = node;
    } else if (src.kind === "factory") {
      // The factory sees the clip's length in seconds (Infinity while looping or endless); the launcher alone ends the voice, so a tempo change moves its end.
      const end = this.naturalEnd(inst);
      const voice = playSound(
        this.context,
        src.factory,
        inst.clip._out,
        { when, velocity: 1, pitch: inst.clip.pitch.value, duration: end ? Math.max(0, end.time - when) : Infinity },
        { hold: false },
      );
      inst.source = { stop: (at) => voice.stop(at), disconnect: () => {}, addEventListener: () => {} };
    }
  }
  /** Where a one-shot ends by itself (null for loops and endless clips), from the current anchor. */
  private naturalEnd(inst: Inst): { time: number; beat: number } | null {
    if (inst.endMat == null) return null;
    const rem = Math.max(0, inst.endMat - (inst.frozen ?? inst.mat0));
    if (inst.kind === "buffer" && !inst.cfg.warp) {
      const time = inst.anchorTime + (rem * 60) / inst.cfg.bpm / inst.pf;
      return { time, beat: this.beatAt(time) };
    }
    const beat = inst.anchorBeat + rem / (inst.kind === "buffer" ? inst.pf : 1);
    return { time: this.beatTime(beat), beat };
  }
  private armEnd(inst: Inst): void {
    this.dropItems(inst, 0);
    const nat = this.naturalEnd(inst);
    const stop = inst.stopTime;
    const time = nat && stop != null ? Math.min(nat.time, stop) : (nat?.time ?? stop);
    if (time == null) return;
    if (inst.source) {
      try {
        inst.source.stop(Math.max(time, this.now()));
      } catch {
        /* already stopped */
      }
    }
    this.addItem(time, 0, inst, () => this.onEnded(inst, time));
  }
  private stopAt(inst: Inst, when: number, beat: number, _why: "stopped" | "replaced"): void {
    inst.stopTime = when;
    inst.stopBeat = beat;
    this.armEnd(inst);
  }
  private restore(inst: Inst): void {
    inst.stopTime = null;
    inst.stopBeat = null;
    if (inst.source && !this.naturalEnd(inst)) {
      try {
        inst.source.stop(FAR);
      } catch {
        /* */
      }
    }
    this.armEnd(inst);
  }
  private onStarted(inst: Inst): void {
    if (inst.state !== "scheduled") return;
    inst.state = "live";
    inst.clip._startedAt.value = inst.startTime;
    if (inst.track.commit?.kind === "start" && inst.track.commit.inst === inst) inst.track.commit = null;
    inst.handle?.commit?.();
    this.emit("started", inst.track, inst.clip, inst.startTime, inst.mat0);
  }
  private onEnded(inst: Inst, when: number): void {
    if (inst.state === "ended") return;
    const wasLive = inst.state === "live";
    const off = this.posOf(inst, when);
    if (inst.track.commit?.kind === "stop" && inst.track.commit.target === inst) inst.track.commit = null;
    inst.stopHandle?.commit?.();
    this.disposeInst(inst);
    if (wasLive) this.emit("ended", inst.track, inst.clip, when, off);
  }
  private disposeInst(inst: Inst): void {
    inst.state = "ended";
    inst.track.insts.delete(inst);
    if (inst.track.cur === inst) inst.track.cur = null;
    this.dropItems(inst);
    const node = inst.source;
    if (node) {
      node.addEventListener("ended", () => node.disconnect(), { once: true });
    }
  }
  /** Hard stop now. */
  private silence(inst: Inst, ev: "ended" | null): void {
    if (inst.state === "ended") return;
    const wasLive = inst.state === "live";
    const off = wasLive || inst.frozen != null ? this.posOf(inst, this.now()) : null;
    try {
      inst.source?.stop();
    } catch {
      /* not started */
    }
    inst.source?.disconnect();
    if (
      inst.track.commit &&
      (("inst" in inst.track.commit && inst.track.commit.inst === inst) || ("target" in inst.track.commit && inst.track.commit.target === inst))
    )
      inst.track.commit = null;
    this.disposeInst(inst);
    if (ev && wasLive) this.emit("ended", inst.track, inst.clip, this.now(), off);
  }
  private undoCommit(track: Track): void {
    const c = track.commit;
    if (!c) return;
    track.commit = null;
    if (c.kind === "start") {
      const inst = c.inst;
      try {
        inst.source?.stop();
      } catch {
        /* */
      }
      inst.source?.disconnect();
      inst.handle?.cancel?.();
      this.disposeInst(inst);
      const prev = inst.replaced;
      if (prev && prev.state !== "ended") {
        track.cur = prev;
        this.restore(prev);
      }
    } else {
      c.target.stopHandle?.cancel?.();
      c.target.stopHandle = null;
      this.restore(c.target);
    }
    this.dirtyFrom = Math.min(this.dirtyFrom ?? Infinity, this.nowBeat());
  }

  // ------------------------------------------------------------ scene tempo
  private addSceneTempo(beat: number | null, tempo: number): void {
    const e = { beat, tempo, time: null as number | null };
    this.sceneTempos.push(e);
    if (beat != null) this.applySceneTempo(e);
  }
  private applySceneTempo(e: { beat: number | null; tempo: number; time: number | null }): void {
    const time = this.whenOf(e.beat!);
    e.time = time;
    this.internalTempo++;
    try {
      this.timeline!.bpm.setValueAtTime(e.tempo, time);
    } finally {
      this.internalTempo--;
    }
    this.retimeRates(time);
  }
  private clearSceneTempos(onlyFuture: boolean): void {
    const now = this.now();
    const keep: typeof this.sceneTempos = [];
    let from = Infinity;
    for (const e of this.sceneTempos) {
      if (onlyFuture && e.time != null && e.time <= now) keep.push(e);
      else if (e.time != null) from = Math.min(from, e.time);
    }
    this.sceneTempos = keep;
    if (from < Infinity && this.timeline) {
      this.internalTempo++;
      try {
        this.timeline.bpm.cancelScheduledValues(from);
      } finally {
        this.internalTempo--;
      }
    }
  }
  private retimeRates(from: number): void {
    for (const t of Object.values(this.tracks))
      for (const inst of t.insts) {
        if (inst.kind !== "buffer" || !inst.cfg.warp || !inst.source || inst.frozen != null) continue;
        const r = this.rateAt(inst, Math.max(from, this.now()));
        const p = (inst.source as AudioBufferSourceNode).playbackRate;
        p.cancelScheduledValues(Math.max(from, this.now()));
        p.setValueAtTime(r, Math.max(from, this.now()));
        inst.rate = r;
      }
  }

  // ------------------------------------------------------------ live option and cell edits
  /** @internal */ _applyGain(clip: Clip, db: number): void {
    const g = 10 ** (db / 20);
    clip._out.gain.setValueAtTime(g, this.context.currentTime);
  }
  /** @internal */ _applyPitch(clip: Clip, st: number): void {
    if (!this.timeline) return;
    const now = this.now();
    for (const inst of clip.track.insts) {
      if (inst.clip !== clip || inst.kind !== "buffer" || !inst.source || inst.state === "ended" || inst.frozen != null) continue;
      if (inst.state === "scheduled" && inst.startTime > now) {
        inst.pf = semis(st);
        inst.rate = this.rateAt(inst, inst.startTime);
        (inst.source as AudioBufferSourceNode).playbackRate.setValueAtTime(inst.rate, inst.startTime);
        this.armEnd(inst);
        continue;
      }
      inst.mat0 = this.posOf(inst, now);
      inst.anchorTime = now;
      inst.anchorBeat = this.beatAt(now);
      inst.pf = semis(st);
      inst.rate = this.rateAt(inst, now);
      (inst.source as AudioBufferSourceNode).playbackRate.setValueAtTime(inst.rate, now);
      this.armEnd(inst);
    }
  }
  /** @internal */ _configured(clip: Clip, patch: ClipPatch): void {
    if (!this.timeline) return;
    const now = this.now();
    for (const inst of clip.track.insts) {
      if (inst.clip !== clip || inst.state === "ended") continue;
      if ("follow" in patch) {
        const f = clip._opts.value.follow;
        inst.follow = null;
        if (f) {
          const due = inst.startBeat + this._beats(f.after);
          inst.follow = { beat: Math.max(due, this.isPlaying() ? this.nowBeat() : due) };
        }
      }
      if ("loop" in patch && inst.kind === "buffer" && inst.state === "live" && inst.frozen == null) this.swapAtWrap(inst, now);
    }
    this.syncAll();
  }
  /** @internal Replaces what a clip plays with its new buffer: a playing source hands over at the same position a moment ahead, with no gap; one not yet started is rebuilt. */
  _swapBuffer(clip: Clip): void {
    if (!this.timeline) return;
    const buf = (clip._src as { buffer: AudioBuffer }).buffer;
    const now = this.now();
    const lead = 0.02;
    for (const inst of clip.track.insts) {
      if (inst.clip !== clip || inst.state === "ended" || inst.kind !== "buffer") continue;
      const lengthBeats = this._materialBeats(clip, inst.cfg)!;
      const setting = inst.cfg.loop;
      const region = inst.loop
        ? typeof setting === "object"
          ? { start: setting.startBeat, end: setting.endBeat }
          : { start: 0, end: lengthBeats }
        : null;
      if (inst.frozen != null) {
        // paused: no source is sounding; the next resume builds from the new buffer
        inst.loop = region;
        inst.endMat = region ? null : lengthBeats;
        continue;
      }
      const t = Math.max(inst.startTime, now + lead);
      let pos = this.posOf(inst, t);
      if (region && pos >= region.end) pos = region.start + ((pos - region.start) % (region.end - region.start));
      const old = inst.source;
      inst.loop = region;
      inst.endMat = region ? null : lengthBeats;
      if (inst.state === "scheduled" && inst.startTime >= now + lead) {
        try {
          old?.stop();
          old?.disconnect();
        } catch {
          /* already stopped */
        }
        inst.source = null;
        this.buildSource(inst, inst.startTime);
        this.armEnd(inst);
        continue;
      }
      try {
        old?.stop(t);
      } catch {
        /* already stopped */
      }
      inst.source = null;
      if (inst.endMat != null && pos >= inst.endMat) {
        this.armEnd(inst);
        continue;
      }
      inst.rate = this.rateAt(inst, t);
      const node = new AudioBufferSourceNode(this.context, { buffer: buf, playbackRate: inst.rate });
      if (region) {
        node.loop = true;
        node.loopStart = (region.start * 60) / inst.cfg.bpm;
        node.loopEnd = (region.end * 60) / inst.cfg.bpm;
      }
      node.connect(clip._out);
      node.start(t, (pos * 60) / inst.cfg.bpm);
      inst.source = node;
      this.armEnd(inst);
    }
  }
  /** A new loop applies when the current pass reaches its wrap: the source is replaced there, gaplessly. */
  private swapAtWrap(inst: Inst, now: number): void {
    const next = inst.clip._opts.value.loop;
    const buf = (inst.clip._src as { buffer: AudioBuffer }).buffer;
    const bufBeats = this._materialBeats(inst.clip, inst.cfg)!;
    const pos = this.posOf(inst, now);
    const wrapAt = inst.loop ? inst.loop.end : (inst.endMat ?? bufBeats);
    const remBeats = wrapAt - pos;
    const secs = (remBeats * 60) / inst.cfg.bpm / inst.rate;
    const t = now + secs;
    const region = next ? (typeof next === "object" ? { start: next.startBeat, end: next.endBeat } : { start: 0, end: bufBeats }) : null;
    // end the old source at the wrap; start the new one there, from the new loop's start
    try {
      inst.source?.stop(t);
    } catch {
      /* */
    }
    inst.source = null;
    const node = new AudioBufferSourceNode(this.context, { buffer: buf, playbackRate: inst.rate });
    if (region) {
      node.loop = true;
      node.loopStart = (region.start * 60) / inst.cfg.bpm;
      node.loopEnd = (region.end * 60) / inst.cfg.bpm;
    }
    node.connect(inst.clip._out);
    const startMat = region ? region.start : wrapAt;
    node.start(t, (startMat * 60) / inst.cfg.bpm);
    inst.source = node;
    inst.loop = region;
    inst.cfg = { ...inst.cfg, loop: next };
    inst.endMat = next ? null : bufBeats;
    inst.mat0 = startMat;
    inst.anchorTime = t;
    inst.anchorBeat = this.beatAt(t);
    inst.pausedAt = null;
    this.armEnd(inst);
  }

  // ------------------------------------------------------------ Scheduler contract
  /** Called by `clock.attach(launcher)`; applications do not call it. */
  attached(handle: TransportAttachment): () => void {
    return untracked(() => {
      this.handle = handle;
      for (const t of Object.values(this.tracks)) for (const c of t._clips) if (c && c._bpmPending) this.fixBpm(c);
      return () => {
        if (this.handle === handle) this.handle = null;
      };
    });
  }
  /** Called by the clock it is attached to; applications do not call it. */
  schedule(window: TransportWindow, timing: BeatTiming): void {
    untracked(() => this.scheduleWindow(window, timing));
  }
  private scheduleWindow(window: TransportWindow, timing: BeatTiming): void {
    // A window that starts before the last one ended is a refresh: the clock retracted our events, so cuts already applied must be applied again.
    if (window.beat.start < this.lastEnd - EPS) this.forgetCuts();
    this.lastWindow = window;
    this.lastTiming = timing;
    this.lastEnd = window.beat.end;
    this.inWindow = true;
    try {
      this.flush();
      this.pump();
      this.feed(window.beat.start, window.beat.end, window, timing);
      this.sampleRates(window, timing);
      this.syncAll();
    } finally {
      this.inWindow = false;
      this.dirtyFrom = null;
    }
  }
  /** Commits every waiting boundary inside the part of the look-ahead already handed out; fires follows and repeats. */
  private pump(): void {
    for (let guard = 0; guard < 64; guard++) {
      let changed = false;
      for (const t of Object.values(this.tracks)) {
        if (t.pending && t.pending.beat != null && t.pending.beat < this.lastEnd - EPS) {
          this.commitPending(t);
          changed = true;
        }
      }
      for (const t of Object.values(this.tracks)) for (const inst of [...t.insts]) changed = this.tick(inst) || changed;
      for (const e of this.sceneTempos) if (e.beat != null && e.time == null && e.beat < this.lastEnd) this.applySceneTempo(e);
      changed = this.advanceChain() || changed;
      if (!changed) break;
    }
  }
  private tick(inst: Inst): boolean {
    if (inst.state === "ended" || inst.frozen != null) return false;
    let changed = false;
    const dead = (beat: number) => (inst.stopBeat != null && inst.stopBeat <= beat + EPS) || (this.naturalEnd(inst)?.beat ?? Infinity) <= beat + EPS;
    if (inst.repeatBeat != null && inst.repeatBeat < this.lastEnd - EPS) {
      const R = inst.repeatBeat;
      const p = inst.track.pending;
      const stopping = dead(R) || (p && !p.clip && p.beat != null && p.beat <= R + EPS);
      inst.repeatBeat = null;
      if (!stopping && inst.track.cur === inst) {
        // The repeat commits at once (R is inside the window); a launch waiting for a later boundary stays queued.
        const waiting = p && p.beat != null && p.beat > R + EPS ? p : null;
        this.request({
          track: inst.track,
          clip: inst.clip,
          source: "repeat",
          quantize: "none",
          baseBeat: R,
          chance: false,
          keepWaiting: true,
          legato: false,
        });
        if (waiting && !inst.track.pending) inst.track.pending = waiting;
        changed = true;
      }
    }
    if (inst.follow && inst.follow.beat < this.lastEnd - EPS) {
      const F = inst.follow.beat;
      const f = inst.cfg.follow ?? inst.clip._opts.value.follow;
      inst.follow = null;
      if (f && !dead(F) && inst.track.cur === inst) {
        const target = this.pickFollow(inst, f.next, F);
        const again = !!inst.cfg.loop;
        if (target) {
          this.request({
            track: inst.track,
            clip: target,
            source: "follow",
            quantize: this.clipQuantize(target),
            baseBeat: F,
            legato: target._opts.value.legato,
          });
          if (!(inst.stopBeat != null || inst.track.pending || inst.track.commit?.kind === "start") && again)
            inst.follow = { beat: F + this._beats(f.after) };
        } else if (again) inst.follow = { beat: F + this._beats(f.after) };
        changed = true;
      }
    }
    return changed;
  }
  private pickFollow(inst: Inst, next: readonly FollowTarget[], at: number): Clip | null {
    if (!next.length) return null;
    const rnd = this.rnd(`follow:${inst.clip._uid}`, inst.id) as Random;
    const total = next.reduce((s, n) => s + (n.weight ?? 1), 0);
    let r = rnd(Math.round(at * 1000)) * total;
    let pick = next[next.length - 1]!;
    for (const n of next) {
      r -= n.weight ?? 1;
      if (r < 0) {
        pick = n;
        break;
      }
    }
    const clips = inst.track._clips;
    const filled = clips.map((c, i) => (c ? i : -1)).filter((i) => i >= 0);
    const me = inst.clip.index;
    if (pick.clip === "stay") return null;
    if (pick.clip === "next" || pick.clip === "previous") {
      const k = filled.indexOf(me);
      const n = filled.length;
      return clips[filled[(k + (pick.clip === "next" ? 1 : n - 1)) % n]!] ?? null;
    }
    if (pick.clip === "random") {
      const others = filled.filter((i) => i !== me);
      if (!others.length) return null;
      return clips[others[Math.floor(rnd(`r${Math.round(at * 1000)}`) * others.length)!]!] ?? null;
    }
    return clips[pick.clip] ?? null;
  }
  private subWindow(inst: Inst, from: number, to: number, window: TransportWindow, timing: BeatTiming): [TransportWindow, BeatTiming] {
    const s = inst.s;
    return [
      {
        beat: { start: from - s, end: to - s },
        time: window.time,
        own: (event, when) => {
          for (const [done, entry] of inst.owned) if (entry.when < window.time.current) inst.owned.delete(done);
          inst.owned.set(event, { when, cut: null });
          window.own(event, when);
        },
      },
      { beatToTime: (b) => timing.beatToTime(b + s), timeToBeat: (t) => timing.timeToBeat(t) - s },
    ];
  }
  private endBeatOf(inst: Inst): number {
    return inst.stopBeat ?? this.naturalEnd(inst)?.beat ?? Infinity;
  }
  private feed(from: number, to: number, window: TransportWindow, timing: BeatTiming): void {
    for (const t of Object.values(this.tracks))
      for (const inst of t.insts) {
        if (inst.kind !== "scheduler" || inst.state === "ended" || inst.frozen != null) continue;
        const end = this.endBeatOf(inst);
        const a = Math.max(from, inst.startBeat);
        const b = Math.min(to, end);
        if (b - a > EPS) {
          const [w, tm] = this.subWindow(inst, a, b, window, timing);
          (inst.clip._src as { sched: Scheduler }).sched.schedule(w, tm);
        }
        // after scheduling: a refill re-registers a held note at its natural end, and the cut must still reach it
        if (end < Infinity && end <= to + EPS) this.cutOwned(inst, timing.beatToTime(end));
      }
  }
  /**
   * A scheduler clip ends at `time` (stop, replacement or the end of its material): the events it registered that reach `time` or later are retracted with that time,
   * so a note it started is cut there instead of ringing on. Other clips' events are untouched. An event may be cut again at an earlier time.
   */
  private cutOwned(inst: Inst, time: number): void {
    if (inst.cutFrom !== null && Math.abs(inst.cutFrom - time) < 1e-9) return;
    inst.cutFrom = time;
    for (const [event, entry] of [...inst.owned]) {
      // a later cut that moves the end earlier (a stop inside the look-ahead of a natural end) reaches a note again; an event is never cut twice at the same or a later time
      if (entry.when < time || (entry.cut !== null && entry.cut <= time)) continue;
      entry.cut = time;
      try {
        event.cancel(time);
      } catch (error) {
        console.error("Launcher event cancellation failed:", error);
      }
    }
  }
  /** After a command changed what plays inside the look-ahead: retract our events from `beat` on and feed the live clips again. */
  private reseed(beat: number): void {
    if (!this.handle || !this.lastWindow || !this.lastTiming || !this.isPlaying()) return;
    const anySched = [...Object.values(this.tracks)].some((t) => [...t.insts].some((i) => i.kind === "scheduler"));
    if (!anySched) return;
    this.handle.cancelFrom(this.beatTime(beat));
    this.forgetCuts();
    this.feed(beat, this.lastEnd, this.lastWindow, this.lastTiming);
  }
  private forgetCuts(): void {
    for (const t of Object.values(this.tracks)) for (const inst of t.insts) inst.cutFrom = null;
  }
  /** @internal pattern edits: coalesced re-queue of the scheduler clips from now. */
  _reseedSoon(): void {
    if (this.reseedQueued) return;
    this.reseedQueued = true;
    queueMicrotask(() => {
      this.reseedQueued = false;
      if (this.isPlaying()) this.reseed(this.nowBeat());
    });
  }
  /** Warped clips follow tempo ramps: the playback rate is sampled along the window. */
  private sampleRates(window: TransportWindow, timing: BeatTiming): void {
    const w0 = window.time.current;
    const w1 = timing.beatToTime(window.beat.end);
    const bpm = this.timeline!.bpm;
    if (bpm.valueAtTime(w0) === bpm.valueAtTime(w1) && bpm.valueAtTime((w0 + w1) / 2) === bpm.valueAtTime(w0)) return;
    for (const t of Object.values(this.tracks))
      for (const inst of t.insts) {
        if (inst.kind !== "buffer" || !inst.cfg.warp || !inst.source || inst.frozen != null || inst.state === "ended") continue;
        const p = (inst.source as AudioBufferSourceNode).playbackRate;
        for (let k = 0; k <= 5; k++) {
          const tt = Math.max(w0 + ((w1 - w0) * k) / 5, inst.startTime);
          const r = this.rateAt(inst, tt);
          p.setValueAtTime(r, tt);
          inst.rate = r;
        }
        this.armEnd(inst);
      }
  }

  /** Called by the clock before it starts, stops, pauses, seeks or detaches; applications do not call it. */
  reset(reason: ResetReason): void {
    untracked(() => this.resetFor(reason));
  }
  private resetFor(reason: ResetReason): void {
    // A chain waiting for the transport starts with it; stopping, pausing, seeking or detaching ends it.
    if (reason !== "start") this.endChain();
    const now = this.now();
    const all = Object.values(this.tracks);
    batch(() => {
      if (reason === "pause") {
        for (const t of all)
          for (const inst of [...t.insts]) {
            if (inst.state === "scheduled" && inst.startTime > now) {
              // not sounding yet: back to a waiting launch, beat kept
              const clip = inst.clip;
              try {
                inst.source?.stop();
              } catch {
                /* */
              }
              inst.source?.disconnect();
              inst.handle?.cancel?.();
              this.disposeInst(inst);
              t.commit = null;
              if (!t.pending) t.pending = { clip, source: "launch", quantize: this.clipQuantize(clip), beat: inst.startBeat, legato: false };
              continue;
            }
            inst.frozen = this.posOf(inst, now);
            inst.pausedAt = now;
            try {
              inst.source?.stop();
            } catch {
              /* */
            }
            inst.source?.disconnect();
            inst.source = null;
            inst.stopTime = null;
            inst.stopBeat = null;
            inst.state = inst.state === "scheduled" ? "live" : inst.state;
          }
        for (const t of all) {
          if (t.commit?.kind === "stop") {
            const c = t.commit;
            t.commit = null;
            c.target.stopHandle?.cancel?.();
            c.target.stopHandle = null;
            if (!t.pending && c.when > now)
              t.pending = { clip: null, source: "stop", quantize: this.clipQuantize(c.target.clip), beat: c.beat, legato: false };
          }
          t.cur = [...t.insts].pop() ?? null;
        }
        this.items = [];
      } else {
        const waiting = reason === "start";
        for (const t of all) {
          for (const inst of [...t.insts]) {
            if (waiting && inst.state === "scheduled" && inst.startTime > now && !t.pending)
              t.pending = { clip: inst.clip, source: "launch", quantize: this.clipQuantize(inst.clip), beat: null, legato: false };
            inst.handle?.reset?.();
            inst.stopHandle?.reset?.();
            this.silence(inst, "ended");
          }
          t.commit = null;
          t.cur = null;
          if (waiting) {
            if (t.pending) t.pending = { ...t.pending, beat: null };
          } else if (t.pending) {
            const p = t.pending;
            t.pending = null;
            this.emit("cancelled", t, p.clip, null);
          }
        }
        this.items = [];
        this.clearSceneTempos(false);
        if (waiting) this.sceneTempos = this.sceneTempos.map((e) => ({ ...e, beat: null, time: null }));
        for (const t of all) for (const c of t._clips) if (c?._src.kind === "scheduler") (c._src.sched as { reset?(): void }).reset?.();
        this.lastWindow = null;
        this.lastTiming = null;
      }
    });
    this.dirtyFrom = null;
    this.syncAll();
  }
  /** Called by the clock after start, stop, pause, resume, seek and tempo changes; applications do not call it. */
  transport(change: TransportChange): void {
    untracked(() => this.onTransport(change));
  }
  private onTransport(change: TransportChange): void {
    if (change.type === "tempo") {
      if (this.internalTempo > 0) return;
      this.retimeRates(change.when);
      // waiting boundaries are fixed in beats: scene tempo events and anything already handed to the graph move with the tempo
      for (const e of this.sceneTempos) {
        if (e.beat == null || e.time == null || e.time <= this.now()) continue;
        this.internalTempo++;
        try {
          this.timeline!.bpm.cancelScheduledValues(e.time);
        } finally {
          this.internalTempo--;
        }
        this.applySceneTempo(e);
      }
      for (const t of Object.values(this.tracks)) {
        const c = t.commit;
        if (!c || c.when <= this.now()) continue;
        const beat = c.kind === "start" ? c.inst.startBeat : c.beat;
        const clip = c.kind === "start" ? c.inst.clip : null;
        const legato = false;
        this.undoCommit(t);
        if (!t.pending) t.pending = { clip, source: "launch", quantize: this.clipQuantize(clip), beat, legato };
      }
      if (this.isPlaying()) {
        this.pump();
        this.finishCommand();
      }
      this.syncAll();
      return;
    }
    if (change.type === "start") {
      this.lastEnd = change.beat;
      this.lastWindow = null;
      for (const t of Object.values(this.tracks)) if (t.pending && t.pending.beat == null) t.pending = { ...t.pending, beat: change.beat };
      if (this.chainRun && this.chainRun.start == null) this.chainRun.start = change.beat;
      for (const e of this.sceneTempos) if (e.beat == null) this.addSceneTempoAt(e, change);
      // A start at "now" leaves no look-ahead: fill the first window at once, or a launch waiting on this beat would sound at the next timer tick.
      if (change.when <= this.now() && Object.values(this.tracks).some((t) => t.pending)) void this.handle?.refresh();
    } else if (change.type === "resume") {
      this.resumeAll(change);
    }
    this.syncAll();
  }
  private addSceneTempoAt(e: { beat: number | null; tempo: number; time: number | null }, change: TransportChange): void {
    e.beat = change.beat;
    this.applySceneTempo(e);
  }
  private resumeAll(change: TransportChange): void {
    const when = change.when;
    for (const t of Object.values(this.tracks)) {
      if (t.pending && t.pending.beat == null) t.pending = { ...t.pending, beat: change.beat };
      for (const inst of t.insts) {
        if (inst.frozen == null) continue;
        const pos = inst.frozen;
        inst.frozen = null;
        inst.mat0 = pos;
        inst.anchorTime = when;
        inst.anchorBeat = change.beat;
        inst.s = change.beat - pos;
        if (inst.clip._startedAt.value != null && inst.pausedAt != null) inst.clip._startedAt.value += when - inst.pausedAt;
        inst.pausedAt = null;
        if (inst.kind !== "scheduler") this.buildSource(inst, when, pos);
        else this.armEnd(inst);
        if (inst.kind !== "scheduler") this.armEnd(inst);
        inst.stopTime = null;
        inst.stopBeat = null;
      }
      t.cur = [...t.insts].pop() ?? null;
    }
    this.lastEnd = Math.max(this.lastEnd, change.beat);
    this.dirtyFrom = change.beat;
    this.finishCommand();
  }

  addEventListener(
    type: ClipEventType,
    listener: (this: ClipLauncher, event: ClipEvent) => unknown,
    options?: boolean | AddEventListenerOptions,
  ): void;
  addEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions): void;
  addEventListener(type: string, listener: unknown, options?: boolean | AddEventListenerOptions): void {
    if (this.disposed || !listener) return;
    this.listeners.push([type, listener as EventListenerOrEventListenerObject, options]);
    super.addEventListener(type, listener as EventListenerOrEventListenerObject, options);
  }
  removeEventListener(
    type: ClipEventType,
    listener: (this: ClipLauncher, event: ClipEvent) => unknown,
    options?: boolean | EventListenerOptions,
  ): void;
  removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | EventListenerOptions): void;
  removeEventListener(type: string, listener: unknown, options?: boolean | EventListenerOptions): void {
    if (!listener) return;
    const index = this.listeners.findIndex(([t, l]) => t === type && l === listener);
    if (index !== -1) this.listeners.splice(index, 1);
    super.removeEventListener(type, listener as EventListenerOrEventListenerObject, options);
  }
  /** Detaches from every clock, silences the clips and removes listeners. Idempotent. */
  dispose(): void {
    if (this.disposed) return;
    untracked(() => {
      this.disposed = true;
      this.abortSignal?.removeEventListener("abort", this.onAbort);
      this.handle?.detach();
      this.resetFor("detach");
      for (const t of Object.values(this.tracks)) {
        for (const c of t._clips) c?._stop();
        t.output.disconnect();
      }
      for (const [type, listener, options] of this.listeners.splice(0)) super.removeEventListener(type, listener, options);
    });
  }
  [Symbol.dispose](): void {
    this.dispose();
  }
}
