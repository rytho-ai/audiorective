import type { BeatTiming, CancellableEvent, Sound } from "@audiorective/core";

/** What a transport hands a scheduler when it attaches (the part of a clock's `SchedulerHandle` a clip's own scheduler may use). */
export type TransportHandle = Readonly<{ refresh(): void; detach(): void }>;

/** The part of a transport window `schedule` reads. Internal to transports: `clock.attach(launcher)` passes it; applications never build one. */
export type TransportWindow = Readonly<{
  beat: { start: number; end: number };
  time: { current: number };
  own(event: CancellableEvent, when: number): void;
}>;

/** Why a transport resets its schedulers: it started, stopped, paused or jumped, or the scheduler is leaving. */
export type ResetReason = "start" | "stop" | "pause" | "seek" | "detach";

/** One change of the transport as a clock reports it: `when` is the audio time it takes effect, `beat` the beat position there. */
export type TransportChange = Readonly<{
  type: "start" | "stop" | "pause" | "resume" | "seek" | "tempo";
  when: number;
  beat: number;
}>;

/** The tempo curve of the transport a launcher follows (a clock's `timeline.bpm`). */
export type TransportTempo = Readonly<{
  readonly value: number;
  valueAtTime(time: number): number;
  setValueAtTime(value: number, time: number): unknown;
  cancelScheduledValues(time: number): unknown;
}>;

/** What a launcher learns about the clock it is attached to (a clock's `SchedulerHandle`). */
export type TransportAttachment = Readonly<{
  timeline: BeatTiming & { readonly bpm: TransportTempo };
  state: Readonly<{ readonly value: "stopped" | "playing" | "paused" }>;
  meter: Readonly<{ readonly value: readonly [number, number] }>;
  refresh(): void;
  cancelFrom(time: number): void;
  detach(): void;
}>;

/** A scheduler a launcher can be attached as: `clock.attach(launcher)`. */
export type Scheduler = {
  schedule(window: TransportWindow, timing: BeatTiming): void;
  reset?(reason: ResetReason): void;
  transport?(change: TransportChange): void;
};

/** "none" starts at once; otherwise the next boundary: "1m" a bar of `clock.meter` (4 beats in 4/4), "2m" two bars, "4n" a beat, "8n" half a beat. A call exactly on a boundary starts there, not on the next one. */
export type Quantize = "none" | `${number}m` | `${number}n`;

/** A length: seconds, or a note value ("1m" is a bar, "4n" a beat) measured at the tempo when the clip starts. */
export type ClipLength = number | Exclude<Quantize, "none">;

/**
 * A scheduler a clip can play. The launcher routes its sound into the track's output: for a `StepSequencer` it connects every lane's output to the clip's gain on the track
 * (the caller does not call `lanes.x.connect`); for another scheduler that has `connect(node)` it calls `connect` once. A scheduler with neither makes no sound of its own (it drives something else).
 * It sees windows whose beat 0 is the clip's start; the clip's `pitch` is not applied to it.
 */
export type ClipScheduler = {
  schedule(window: TransportWindow, timing: BeatTiming): void;
  reset?(reason: ResetReason): void;
  attached?(handle: TransportHandle): void | (() => void);
  connect?(destination: AudioNode): unknown;
  readonly lanes?: Readonly<Record<string, { connect(node: AudioNode): AudioNode }>>;
};

/** A clip: an AudioBuffer, or options with one of `buffer`, `sound` or `scheduler`. A buffer alone plays once. */
export type ClipSpec = AudioBuffer | ClipOptions;

/**
 * How a clip reacts: "trigger" starts it; "gate" plays while held (`release()` ends it); "toggle" stops it when launched while playing or waiting;
 * "repeat" restarts it every `repeatBeats` while held. A gate or repeat clip started without a press (by `launchScene` or a follow) has nothing to release:
 * a gate plays like a trigger, a repeat retriggers until the track is stopped or another clip replaces it.
 */
export type ClipMode = "trigger" | "gate" | "toggle" | "repeat";

/** One outcome of a clip's `follow`, picked with probability weight / sum of the weights of `next`. */
export type FollowTarget = {
  /**
   * A slot index (0 is the first clip), the track's "next" or "previous" filled slot (wrapping) or a random other clip, or "stay": nothing is launched and the clip carries on
   * (a loop keeps looping, a one-shot ends at its end). A looping clip re-arms its follow and draws again `after` later; a one-shot does not (it draws again when the clip next starts).
   */
  clip: number | "next" | "previous" | "random" | "stay";
  /** Relative, so weights summing to 100 read as percentages. Default 1. */
  weight?: number;
};

/** How a buffer clip follows the transport tempo: "repitch" plays at clock tempo / `bpm` times its natural speed (pitch moves with it); false always plays at natural speed. */
export type ClipWarp = "repitch" | false;

/** A loop: `true` repeats the whole material, a region repeats [startBeat, endBeat) of it (material beats from the first beat). */
export type LoopSetting = boolean | { startBeat: number; endBeat: number };

/** A follow action: `after` the clip's start one of `next` is picked by weight. */
export type FollowSetting = { after: ClipLength; next: readonly FollowTarget[] };

/** Every option a clip can change after construction, with defaults filled in; `null` means unset. */
export type ClipSettings = Readonly<{
  name: string;
  loop: LoopSetting;
  /** null: a buffer's own length, else endless. */
  length: ClipLength | null;
  offsetBeats: number;
  /** null: follows `launcher.quantize`. */
  quantize: Quantize | null;
  mode: ClipMode;
  repeatBeats: number;
  chance: number;
  follow: FollowSetting | null;
  legato: boolean;
  /** Tempo of a buffer's material; the clock tempo when the clip was created (or attached) for a buffer clip without `bpm`, unused otherwise. */
  bpm: number;
  warp: ClipWarp;
}>;

/** What `Clip.configure` takes: any subset of `ClipSettings`, writable so a patch can be built field by field; a nullable setting accepts `null`. */
export type ClipPatch = { -readonly [K in keyof ClipSettings]?: ClipSettings[K] } & {
  /** Buffer clips: replaces the audio. A playing clip swaps to it at once, at the same position and without a gap (so an overdubbed or punched loop takes over seamlessly); `bpm` and the other settings stay. */
  buffer?: AudioBuffer;
};

/**
 * One clip, from exactly one of `buffer`, `sound` or `scheduler`. `sound` takes a `Sound`: a buffer plays like `buffer`; a factory is one hit held for the clip's `length` (endless without one, or while it loops),
 * built with `hit.pitch` = the clip's `pitch` at its start and released over the shared 5 ms fade when the clip ends. Material is measured in beats from its first beat (a buffer's seconds x `bpm` / 60; a factory or scheduler
 * clip's beats are transport beats), and one rule relates the options: the material is [0, `length`) (a buffer's own length when `length` is not given, endless for a factory or
 * scheduler); `loop` picks the part that repeats (`true`: all of it, a region: that region of a buffer; a factory or scheduler clip loops its whole `length`); `offsetBeats` only
 * says where the first pass begins inside the material; `bpm` only converts a buffer's seconds into material beats.
 */
export type ClipOptions = {
  /** Display name. Default "<track> <slot number>", e.g. "bass 2". */
  name?: string;
  /** Play until stopped or replaced, or repeat only the region [startBeat, endBeat) of the material, in material beats from its first beat. Default false: play once, then the clip is stopped. */
  loop?: LoopSetting;
  /** The material's length: where a one-shot ends and where a loop of a factory or scheduler clip wraps. A buffer uses its own duration (a shorter `length` cuts it); a factory or scheduler one-shot never ends by itself without it. A note value counts transport beats from the start, so a later tempo change moves its end in time. */
  length?: ClipLength;
  /** Where playback begins, in beats of the material (see `bpm`); 0 is its first beat (beat 2 is 1). A scheduler clip always begins at its beat 0. Default 0. */
  offsetBeats?: number;
  /** Overrides `launcher.quantize` for this clip's launch, stop and release. Not used when the clip starts through `launchScene`, which has one boundary for all its clips. */
  quantize?: Quantize;
  /** Start value of `clip.gainDb` (decibels). Default 0. */
  gainDb?: number;
  /** Start value of `clip.pitch` (semitones). Default 0. */
  pitch?: number;
  /** Default "trigger". */
  mode?: ClipMode;
  /** Interval of mode "repeat", in beats. Default 1. */
  repeatBeats?: number;
  /** Probability 0..1 that a launch of this clip happens, drawn from `launcher.seed`; a failed draw leaves what plays untouched and dispatches "skipped". Default 1. */
  chance?: number;
  /**
   * `after` the clip's start (time or note value) one of `next` is picked, by weight, and launched on this clip's track, replacing it; "stay" picks nothing.
   * A pending follow is cancelled when the clip is stopped, replaced (any launch on the track, including its own follow), the clock stops or seeks, or the clip is cancelled;
   * it is frozen by pause and continues on resume, like everything the launcher waits for (see `ClipLauncher`).
   */
  follow?: FollowSetting;
  /** Default of `launch({ legato })` for this clip. */
  legato?: boolean;
  /** Buffer clips: the tempo the buffer was recorded at, which sets its beat grid (a 4-beat loop at 120 is 2 s). Default the clock tempo when the clip is created (for a clip made before `clock.attach`, when it is attached). */
  bpm?: number;
  /** Buffer clips: how the clip follows tempo changes and ramps of the transport, scene tempo included. Default "repitch": it plays at clock tempo / `bpm` times its natural speed, so every buffer clip follows the song tempo; `false` plays at its own speed. Real-time time stretching is not offered. */
  warp?: ClipWarp;
} & ({ buffer: AudioBuffer } | { sound: Sound } | { scheduler: ClipScheduler });

/** One scene: the clips at one slot across all tracks. */
export interface SceneSpec {
  name?: string;
  /** BPM the transport changes to at the scene's boundary; warped audio clips follow it. */
  tempo?: number;
}

/** What caused a launch or stop. */
export type LaunchSource = "launch" | "scene" | "follow" | "release" | "repeat" | "stop";

/** A number in [0, 1) fixed by the seed, this request and `key`. */
export type Random = (key?: number | string) => number;

/** What a host returns from `onSchedule` to follow one change. */
export interface ScheduleHandle {
  /**
   * The change was withdrawn, replaced or reset before `when` (also when the tempo changed while it waited: the launcher then calls `onSchedule` again with the new `when`):
   * undo what the host scheduled. Never runs after `commit`.
   */
  cancel?(): void;
  /** `when` has arrived. */
  commit?(): void;
  /** The change was already underway and the launcher silenced the track: the clock stopped or seeked, the launcher was detached, or the clip was removed with `setClip`. A pause does not call it. */
  reset?(): void;
}

export interface LaunchOptions {
  /** Overrides the clip's `quantize`, then `launcher.quantize`, for this call. */
  quantize?: Quantize;
  /** Start the new clip where the playing one has reached at the boundary (its position within its loop), not at its `offsetBeats`. Default the clip's `legato`. */
  legato?: boolean;
  /**
   * `clip.launch` only: start the clip as if it had started at transport beat `at` (no quantize): a beat still ahead starts there; a beat already past starts now, from its `offsetBeats`
   * advanced by the beats elapsed since `at` (wrapped by the loop), so a take that resolved late loops in phase. It applies to buffer clips; `legato` takes precedence.
   */
  at?: number;
}

/** "queued" when a launch or stop is accepted, "started" and "ended" when it takes effect, "cancelled" when withdrawn, "skipped" when a draw or `transform` dropped it. */
export type ClipEventType = "queued" | "started" | "ended" | "cancelled" | "skipped";
