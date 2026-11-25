import { importedBundles } from "./project-persistence";
import { holdSeconds, playbackLead, smoothGain } from "./internal/playback-gain";
import { Clock, Timeline } from "@audiorective/clock";
import type { LoopRange, TickSource, TickWindow } from "@audiorective/clock";
import {
  Sampler,
  batch,
  cell,
  effect,
  readonlyCell,
  untracked,
  type Cell,
  type Readable,
  type ReadonlyCell,
  type SamplerOptions,
} from "@audiorective/core";
import { SamplerSink } from "./midi-sink";
import { AutomationBinding, AutomationCurve, audioParamTarget, type AutomationTarget } from "@audiorective/core/automation";
import { WebClapHost } from "@audiorective/host/webclap";
import { ClipLauncher, type Clip as SessionClip, type ClipSpec } from "@audiorective/launcher";
import type { WaveStretchAnchor, WaveStretchProcessor } from "@audiorective/player";
import { TrackRack } from "./track-rack";
import type { RackEffect } from "./rack-preset";
import { AudioTrackSession } from "./audio-track-session";
import { Audition, type RangeAuditionState } from "./audition";
import { ClipStretch, type PreparedClipStretch } from "./clip-stretch";
import { createWorkspaceLoop, LoopFold, type WorkspaceLoop } from "./arrangement-loop";
import { ClipScheduler } from "./clip-scheduler";
import { Mixer, type MixerStrip } from "./mixer";
import { captureDeviceState, MidiClip, Project } from "./model";
import type { TempoMap } from "./tempo-map";
import type { AudioClipGainAutomation, MediaAudioClip, PcmAudioClip, ProjectClip, ProjectTrack, TrackRouting, WebClapDevice } from "./model";
import type { BeatRange, ProjectVersion, SecondsRange } from "./project-edits";
import { audioLoopFrames } from "./clip-loop";
import { sessionFor } from "./session";

export { scheduleClipEnvelope } from "./schedule-clip-envelope";
export type { PreparedClipStretch } from "./clip-stretch";

export type { RangeAuditionState } from "./audition";
import { collectGainAutomationEdits, deviceKeys, updateRack } from "./track-reconcile";
import { assertTakeAudioTime, placeTake, type TakeAnchor } from "./take-placement";
import type { TrackRuntime } from "./track-runtime";

export type PlaybackEditStatus = "applied" | "needs-sync" | "failed" | "superseded";

/** A `Sampler` setup for one MIDI track: what it plays (`sound`), its root note, release and polyphony. */
export type TrackInstrument = Omit<SamplerOptions, "signal">;

export type WorkspaceOptions = {
  destination?: AudioNode;
  workletUrl?: string;
  /** Resolve bundle hints from opened files. Returning undefined declines the URL. */
  resolveBundle?: (device: WebClapDevice) => string | Promise<string | undefined> | undefined;
  /**
   * Sound for MIDI tracks without a plug-in, keyed by track id: each entry becomes a core `Sampler` playing that track's notes into its mixer channel, in Arrangement,
   * Session and offline renders. `sound` may be a buffer or a `SoundFactory` for page-made sounds. Not saved in the file: pass it again when opening. A track with a WebCLAP device ignores its entry.
   */
  instruments?: Readonly<Record<string, TrackInstrument>>;
  /** Initial value of `workspace.arrangement`. Default true; false for an app that only plays Session clips. */
  arrangement?: boolean;
  /** Messages produced before the workspace existed, such as file-open warnings; they precede the workspace's own. */
  warnings?: readonly string[];
  /** Hand the Project to the Workspace: `dispose()` disposes it too. Ownership ends if `workspace.project` is later replaced. Default: the caller owns it. */
  ownsProject?: boolean;
  /** @internal Drives the transport from an offline render loop instead of a timer; used by `exportAudioFallbackTo`. */
  tickSource?: TickSource;
};
const isOfflineContext = (context: BaseAudioContext): boolean => typeof OfflineAudioContext !== "undefined" && context instanceof OfflineAudioContext;

/** A borrowed transport view that can be passed directly to a player widget. */
export type WorkspacePlayer = Readonly<{
  isPlaying: Readable<boolean>;
  play(): Promise<void>;
  pause(): void;
  timeline: Readonly<{
    clock: true;
    duration: Readable<number>;
    position(): number;
    seek(seconds: number): void;
  }>;
}>;
export type { TakeAnchor } from "./take-placement";
/** One live DAW workspace over one Project. Project remains the sole persistent-data owner. */
export class Workspace {
  readonly context: AudioContext;
  readonly output: GainNode;
  readonly timeline: Timeline;
  readonly clock: Clock;
  /**
   * The Workspace's beat transport (its `clock`): `transport.timeline` maps beats and time, `transport.attach(scheduler)` follows its windows
   * and `transport.refresh()` re-queues the look-ahead. Pass it wherever a structural transport is accepted, for example the `transport`
   * option of `@audiorective/sequencer`. Play, pause, seek and tempo stay with the Workspace.
   */
  get transport(): Clock {
    return this.clock;
  }
  readonly player: WorkspacePlayer;
  /**
   * The Session view's launcher over this Workspace's audio and MIDI tracks (mirrors `cells.session`), built from the Project's Session grid, `sessionFor(project)`:
   * `session.value.tracks[trackId].clips[i]` is scene i's slot clip on that track, `null` for an empty slot, a file-backed audio clip or a MIDI clip on a track without a device or instrument,
   * so a grid reads a slot clip's state from its cells and launches it with `clip.launch()`; `launchScene(i)` launches scene i on every track and stops the tracks whose slot in it is empty.
   * Scenes added or removed change the launcher in place; a file-backed audio slot clip has no launcher clip until its audio is read. A MIDI clip loops over its
   * length through the track's first device, and notes still sounding are released when the track changes clip, stops or returns. A launched clip plays through the track's devices, effects and mixer strip and takes the track away from Arrangement
   * until it is stopped or a one-shot ends. The launcher follows `workspace.transport` (a launch made while stopped waits for `play()`; stop and
   * seek clear it) and is replaced by `sync()`, so read `session.value` inside the effect that uses it. It is built (the clips' audio copied into buffers) the first time it is read. See `sessionClip`.
   */
  readonly session: ReadonlyCell<ClipLauncher>;
  /** Mirrors `cells.auditioningClip`. */
  readonly auditioningClip: ReadonlyCell<string | null>;
  /** Mirrors `cells.auditioningRange`. */
  readonly auditioningRange: ReadonlyCell<RangeAuditionState | null>;
  private readonly topologyPending = cell(false);
  private readonly mediaError = cell<string | null>(null);
  private readonly applicationError = cell<string | null>(null);
  private readonly warningMessages = cell<readonly string[]>(Object.freeze([]));
  private readonly audition: Audition;
  readonly cells: Readonly<{
    needsSync: ReadonlyCell<boolean>;
    error: ReadonlyCell<string | null>;
    warnings: ReadonlyCell<readonly string[]>;
    session: ReadonlyCell<ClipLauncher>;
    auditioningClip: ReadonlyCell<string | null>;
    auditioningRange: ReadonlyCell<RangeAuditionState | null>;
  }>;
  private readonly stretch: ClipStretch;
  /** Built on first read of `session`, so an app that never launches clips never copies their audio into buffers. */
  private sessionLauncher?: ClipLauncher;
  /** Bumped when `sync()` replaces the launcher, so `session` readers re-run. */
  private readonly sessionRevision = cell(0);
  /** File-backed Session clips read into memory, and the ones being read. */
  private readonly sessionMedia = new WeakMap<MediaAudioClip, PcmAudioClip>();
  private readonly sessionMediaLoading = new WeakSet<MediaAudioClip>();
  /** The Project scene id of each launcher scene slot, in order. */
  private sessionSceneIds: string[] = [];
  private readonly sessionSources = new WeakMap<SessionClip, ProjectClip>();
  /** Bumped when `reconcileSession` replaces a session clip, so `sessionClip` readers re-run. */
  private readonly sessionClipEdits = cell(0);

  private readonly projectSource: Cell<Project>;
  /** The Project this Workspace disposes with itself, when it was handed one. */
  private ownedProject?: Project;
  private readonly options: WorkspaceOptions;
  /** Bundle URLs this workspace has loaded, by CLAP ID: already approved, so `deviceOptions` approves them again in a file saved from here. */
  private readonly loadedBundles = new Map<string, Set<string>>();
  /**
   * What another workspace needs to load the same devices and instruments: a render workspace, or this project saved and opened again.
   * Its `resolveBundle` asks this workspace's own `resolveBundle` first, then approves a bundle URL this workspace has loaded for the same CLAP ID.
   */
  get deviceOptions(): Pick<WorkspaceOptions, "workletUrl" | "resolveBundle" | "instruments"> {
    const resolve = this.options.resolveBundle;
    const loaded = this.loadedBundles;
    return {
      workletUrl: this.options.workletUrl,
      instruments: this.options.instruments,
      resolveBundle: async (device) =>
        (resolve ? await resolve(device) : undefined) ??
        (device.bundleUrl && loaded.get(device.pluginId)?.has(device.bundleUrl) ? device.bundleUrl : undefined),
    };
  }
  private readonly tracks = new Map<string, TrackRuntime>();
  private readonly scheduler: ClipScheduler;
  private readonly noteOff: Array<() => void> = [];
  private readonly midiClipPositions = new WeakMap<MidiClip, number>();
  private readonly seekPoint = cell({ seconds: 0 });
  private activeTempoMap: TempoMap;
  /**
   * Repeats a beat region on the audio clock, cutting clips at its edges and releasing held MIDI notes at the wrap. Playback before the region
   * runs into it and then repeats; a seek past its end plays on. `position` stays inside the region while it repeats.
   */
  readonly loop: WorkspaceLoop;
  /**
   * Whether the timeline plays. True (default) plays Arrangement clips wherever no Session clip holds the track; false plays only launched Session clips, so a track with nothing
   * launched is silent and clip positions on the timeline are never heard. Writable while playing: turning it off releases Arrangement sound at once, turning it on schedules it again.
   */
  readonly arrangement: Cell<boolean>;
  private stopWatchingArrangement?: () => void;
  /** How the continuous transport maps onto the arrangement. */
  private fold = new LoopFold(0, 0, null);
  /** The next loop cycle whose tempo events are not on the timeline yet. */
  private loopTempo?: { cycle: number; time: number };
  private readonly anchorLoops = new WeakMap<TakeAnchor, Readonly<{ start: number; end: number; wrapped: boolean }>>();
  private commitTail: Promise<void> = Promise.resolve();
  private automaticApply?: Promise<void>;
  private appliedProject?: Project;
  private appliedRevision = -1;
  private stopWatchingProject?: () => void;
  private applyingOwnEdit = false;
  private failedApplication?: { cause: unknown };
  private playRequest = 0;
  /** A seek into file-backed media is waiting for its chunks; the transport is held `playing` at the target until they arrive. */
  private resumingSeek = false;
  private seekResume?: Promise<void>;
  private readonly heldAnchors = new WeakSet<TakeAnchor>();
  private disposed = false;
  private readonly mixer: Mixer;

  private constructor(context: AudioContext, project: Project, options: WorkspaceOptions) {
    this.context = context;
    this.projectSource = cell(project);
    if (options.ownsProject) this.ownedProject = project;
    this.activeTempoMap = project.tempoMap;
    this.options = options;
    this.scheduler = new ClipScheduler(context, (error) => {
      this.mediaError.value = error?.message ?? null;
    });
    this.output = context.createGain();
    this.mixer = new Mixer(context, this.output, this.tracks, () => this.project);
    this.stretch = new ClipStretch(
      () => this.project,
      () => this.disposed,
    );
    this.audition = new Audition(
      context,
      this.output,
      () => this.project,
      this.scheduler,
      () => this.disposed,
    );
    if (options.destination) this.output.connect(options.destination);
    this.timeline = new Timeline({ audioContext: context, bpm: project.bpm });
    this.loop = createWorkspaceLoop(
      () => untracked(() => this.applyLoop()),
      (region) => {
        const map = untracked(() => this.project.tempoMap);
        if (map.beatToSeconds(region.endBeat) - map.beatToSeconds(region.startBeat) < 0.02)
          throw new RangeError("Workspace loop region must last at least 20 ms.");
      },
    );
    this.arrangement = cell(options.arrangement ?? true);
    this.clock = new Clock({
      timeline: this.timeline,
      lookAhead: 0.15,
      tickInterval: 0.025,
      tickSource: options.tickSource,
      onTick: (window) => this.schedule(window),
    });
    this.stopWatchingArrangement = this.arrangement.subscribe((on) => untracked(() => this.arrangementChanged(on)));
    this.session = readonlyCell(() => {
      this.sessionRevision.$();
      return untracked(() => (this.sessionLauncher ??= this.buildSession()));
    });
    this.auditioningClip = this.audition.cells.clip;
    this.auditioningRange = this.audition.cells.range;
    this.cells = Object.freeze({
      needsSync: readonlyCell(this.topologyPending),
      error: readonlyCell(() => this.applicationError.value ?? this.mediaError.value),
      warnings: readonlyCell(this.warningMessages),
      session: this.session,
      auditioningClip: this.auditioningClip,
      auditioningRange: this.auditioningRange,
    });
    this.player = Object.freeze({
      isPlaying: readonlyCell(() => this.clock.state.value === "playing"),
      play: () => this.play(),
      pause: () => this.pause(),
      timeline: Object.freeze({
        clock: true,
        duration: readonlyCell(() => {
          this.project.cells.revision.$();
          return this.duration;
        }),
        position: () => this.position,
        seek: (seconds: number) => this.seek(seconds),
      }),
    });
  }

  get project(): Project {
    return this.projectSource.value;
  }

  get warnings(): readonly string[] {
    return this.cells.warnings.value;
  }

  private warn(message: string): void {
    this.warningMessages.value = Object.freeze([...untracked(() => this.warningMessages.value), message]);
  }

  set project(project: Project) {
    if (project === this.project) return;
    if (this.ownedProject !== project) this.ownedProject = undefined;
    batch(() => {
      this.audition.stop();
      this.projectSource.value = project;
    });
  }

  static async create(context: AudioContext, project: Project, options: WorkspaceOptions = {}): Promise<Workspace> {
    const workspace = new Workspace(context, project, options);
    try {
      await workspace.sync();
      if (options.warnings?.length) workspace.warningMessages.value = Object.freeze([...options.warnings, ...workspace.warnings]);
      workspace.stopWatchingProject = effect(() => {
        const current = workspace.project;
        const revision = current.cells.revision.value;
        if (!workspace.applyingOwnEdit && (workspace.appliedProject !== current || workspace.appliedRevision !== revision))
          untracked(() => workspace.scheduleProjectEdit());
      });
      return workspace;
    } catch (error) {
      workspace.dispose();
      throw error;
    }
  }

  get duration(): number {
    return Math.max(0, ...this.project.tracks.flatMap((track) => track.clips.map((clip) => this.project.clipTimeSeconds(clip, clip.duration))));
  }
  get position(): number {
    const { seconds } = this.seekPoint.value;
    return this.clock.state.value === "stopped"
      ? seconds
      : this.activeTempoMap.beatToSeconds(this.fold.toBeat(this.timeline.timeToBeat(this.context.currentTime)));
  }

  /** Clock tempo events are absolute AudioContext times; rebase them at each transport anchor. */
  private rebaseTempo(atBeat: number, anchorTime = this.context.currentTime): void {
    this.fold = new LoopFold(atBeat, atBeat, this.activeLoopRegion());
    this.programTempo(atBeat, anchorTime, false);
  }

  private activeLoopRegion(): BeatRange | null {
    return untracked(() => (this.loop.cells.enabled.value ? this.loop.cells.region.value : null));
  }

  /** Put the tempo from `beat` on the timeline: up to the first wrap, after which `extendLoopTempo` adds each repeat. */
  private programTempo(beat: number, anchorTime: number, keepPast: boolean): void {
    const map = this.activeTempoMap;
    const currentBpm = map.bpmAtBeat(beat);
    if (keepPast) this.timeline.bpm.cancelScheduledValues(anchorTime);
    else {
      this.timeline.bpm.cancelScheduledValues(0);
      this.timeline.bpm.setValueAtTime(currentBpm, 0);
    }
    this.timeline.bpm.setValueAtTime(currentBpm, anchorTime);
    const startSeconds = map.beatToSeconds(beat);
    const stopBeat = this.fold.region?.endBeat ?? Infinity;
    for (const change of map.changes) {
      if (change.beat <= beat || change.beat >= stopBeat) continue;
      this.timeline.bpm.setValueAtTime(change.bpm, anchorTime + map.beatToSeconds(change.beat) - startSeconds);
    }
    this.loopTempo = this.fold.region ? { cycle: 0, time: anchorTime + map.beatToSeconds(stopBeat) - startSeconds } : undefined;
    if (this.fold.wrapTransport !== null) this.extendLoopTempo(this.fold.wrapTransport);
  }

  /** Add the tempo of every repeat that starts by `throughTransport`, plus one more so a window never reads past what is programmed. */
  private extendLoopTempo(throughTransport: number): void {
    const tempo = this.loopTempo;
    const { region, wrapTransport } = this.fold;
    if (!tempo || !region || wrapTransport === null) return;
    const map = this.activeTempoMap;
    const length = region.endBeat - region.startBeat;
    const startSeconds = map.beatToSeconds(region.startBeat);
    const seconds = map.beatToSeconds(region.endBeat) - startSeconds;
    const startBpm = map.bpmAtBeat(region.startBeat);
    const inside = map.changes.filter(({ beat }) => beat > region.startBeat && beat < region.endBeat);
    const endBpm = inside.at(-1)?.bpm ?? startBpm;
    while (wrapTransport + tempo.cycle * length <= throughTransport + length) {
      if (startBpm !== endBpm || tempo.cycle === 0) this.timeline.bpm.setValueAtTime(startBpm, tempo.time);
      for (const change of inside) this.timeline.bpm.setValueAtTime(change.bpm, tempo.time + map.beatToSeconds(change.beat) - startSeconds);
      tempo.cycle++;
      tempo.time += seconds;
    }
  }

  /** The loop changed while playing: keep the audible position and refill from it under the new fold. */
  private applyLoop(): void {
    if (this.disposed || this.resumingSeek || this.clock.state.value !== "playing") return;
    const now = this.context.currentTime;
    const transport = this.timeline.timeToBeat(now);
    const beat = this.fold.toBeat(transport);
    const anchor = Math.max(now, this.timeline.beatToTime(transport));
    this.fold = new LoopFold(transport, beat, this.activeLoopRegion());
    this.programTempo(beat, anchor, true);
    // The refresh revokes everything not yet sounding; what is sounding plays on under the new stop time.
    const refilled = this.clock.refresh();
    this.scheduler.refold(this.fold.wrapTransport === null ? null : this.timeline.beatToTime(this.fold.wrapTransport));
    this.positionAutomation(this.activeTempoMap.beatToSeconds(beat), true, anchor);
    void refilled;
  }

  /** Volume automation restarts from the region's start at a wrap. */
  private programLoopAutomation(when: number): void {
    const { region } = this.fold;
    if (!region) return;
    const map = this.activeTempoMap;
    const from = map.beatToSeconds(region.startBeat);
    const to = map.beatToSeconds(region.endBeat);
    for (const runtime of this.tracks.values()) {
      const curve = runtime.automationCurve;
      if (!curve || !runtime.automationBinding) continue;
      const points = untracked(() => curve.value);
      const shape = points.findLast((point) => point.time <= from)?.shape ?? "hold";
      const run = [
        { time: 0, value: curve.valueAt(from), shape },
        ...points.filter(({ time }) => time > from && time < to).map((point) => ({ ...point, time: point.time - from })),
        { time: to - from, value: curve.valueAt(to), shape: "hold" as const },
      ];
      audioParamTarget(runtime.automationGain.gain).program(run, when);
    }
  }

  /** Capture the relationship between the audio clock and the project before arming a recorder. */
  takeAnchor(audioTime = this.context.currentTime): TakeAnchor {
    if (this.disposed) throw new Error("Workspace is disposed.");
    assertTakeAudioTime(audioTime);
    return untracked(() => {
      const advancing = this.clock.state.value === "playing";
      const anchor: TakeAnchor = { audioTime, projectTime: advancing ? this.projectTimeAt(audioTime) : this.position, advancing };
      const { region, wrapTransport } = this.fold;
      if (advancing && region && wrapTransport !== null) {
        // A take is placed by the loop that was playing when it was armed, even if the loop has changed since.
        const map = this.activeTempoMap;
        this.anchorLoops.set(anchor, {
          start: map.beatToSeconds(region.startBeat),
          end: map.beatToSeconds(region.endBeat),
          wrapped: this.timeline.timeToBeat(audioTime) >= wrapTransport,
        });
      }
      if (this.resumingSeek) this.heldAnchors.add(anchor);
      return anchor;
    });
  }

  /**
   * Project seconds at `audioTime` while the transport plays. Before the transport's start (the short lead `play()` leaves, or the moment of a seek)
   * the timeline continues backwards at the same rate, so a take that began earlier keeps its true offset.
   */
  private projectTimeAt(audioTime: number): number {
    const beat = this.timeline.timeToBeat(audioTime);
    const seconds = this.activeTempoMap.beatToSeconds(this.fold.toBeat(beat));
    const start = this.timeline.beatToTime(beat);
    return start > audioTime + 1e-7 ? seconds - (start - audioTime) : seconds;
  }

  /** Positive input latency moves a take earlier. Use preroll when this would cross project zero. */
  takePosition(anchor: TakeAnchor, take: Readonly<{ startTime: number }>, inputLatencySeconds = 0): number {
    if (this.disposed) throw new Error("Workspace is disposed.");
    if (this.heldAnchors.has(anchor))
      throw new RangeError("Workspace take anchor was captured while a seek waited for media; capture it after the seek has resumed.");
    const loop = this.anchorLoops.get(anchor);
    if (!loop) return placeTake(anchor, take, inputLatencySeconds);
    // Validates the inputs; a looped take is folded below, so only its own range errors matter here.
    placeTake({ ...anchor, projectTime: Number.MAX_SAFE_INTEGER / 2 }, take, inputLatencySeconds);
    const placed = anchor.projectTime + take.startTime - anchor.audioTime - inputLatencySeconds;
    const length = loop.end - loop.start;
    if (placed >= loop.end) return loop.start + ((placed - loop.end) % length);
    // Input latency can reach back across the wrap the anchor came after.
    if (loop.wrapped && placed < loop.start) return loop.end - ((loop.start - placed) % length || length);
    return placeTake({ ...anchor, projectTime: placed, audioTime: take.startTime }, take, 0);
  }

  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const queued = this.commitTail.then(task);
    this.commitTail = queued.then(
      () => undefined,
      () => undefined,
    );
    return queued;
  }

  private isCurrentProject(): boolean {
    return untracked(() => this.appliedProject === this.project && this.appliedRevision === this.project.cells.revision.value);
  }

  private recordCurrentProject(): void {
    untracked(() => {
      this.appliedProject = this.project;
      this.appliedRevision = this.project.cells.revision.value;
    });
  }

  private reflectProjectEdit(edit: () => void): void {
    const current = this.isCurrentProject();
    const revision = this.appliedRevision;
    this.applyingOwnEdit = true;
    try {
      untracked(edit);
    } finally {
      this.applyingOwnEdit = false;
      if (current && untracked(() => this.project === this.appliedProject && this.project.cells.revision.value === revision + 1)) {
        this.recordCurrentProject();
      } else if (!this.isCurrentProject()) {
        this.scheduleProjectEdit();
      }
    }
  }

  private scheduleProjectEdit(): void {
    if (this.disposed || this.automaticApply) return;
    this.automaticApply = this.serialize(async () => {
      try {
        if (!this.disposed && !this.isCurrentProject()) await this.applyProjectEdit(() => this.applyLight());
      } catch {
        // The caller can observe cells.error or await flush() for the cause.
      } finally {
        this.automaticApply = undefined;
        if (!this.disposed && !this.isCurrentProject()) this.scheduleProjectEdit();
      }
    });
  }

  private async applyProjectEdit(apply: () => Promise<void>): Promise<void> {
    try {
      await apply();
      this.failedApplication = undefined;
      this.applicationError.value = null;
    } catch (cause) {
      if (!this.disposed) {
        this.failedApplication = { cause };
        this.applicationError.value = cause instanceof Error ? cause.message : String(cause);
      }
      throw cause;
    }
  }

  /** Wait for queued Project edits, including an explicitly requested rebuild. */
  async flush(): Promise<void> {
    for (;;) {
      const tail = this.commitTail;
      await tail;
      if (tail === this.commitTail) break;
    }
    if (!this.disposed && this.failedApplication) throw this.failedApplication.cause;
  }

  /**
   * Wait for queued edits, then report what playback does with `version`: `"applied"` is live, `"needs-sync"` waits for `sync()`,
   * `"failed"` could not be applied (see `cells.error`), and `"superseded"` means the Project has since moved to another version.
   */
  async editStatus(version: ProjectVersion): Promise<PlaybackEditStatus> {
    if (this.disposed) throw new Error("Workspace is disposed.");
    let failed = false;
    try {
      await this.flush();
    } catch {
      failed = true;
    }
    return untracked(() => {
      if (this.project.cells.version.value !== version) return "superseded";
      if (failed) return "failed";
      return this.topologyPending.value ? "needs-sync" : "applied";
    });
  }

  /** Explicitly rebuild the graph after structural edits. Stops transport. */
  sync(): Promise<void> {
    return this.serialize(() => this.applyProjectEdit(() => this.rebuildTracks()));
  }

  private async rebuildTracks(position = this.position): Promise<void> {
    if (this.disposed) throw new Error("Workspace is disposed.");
    this.recordCurrentProject();
    this.audition.stopStale();
    this.stop();
    this.activeTempoMap = this.project.tempoMap;
    this.clock.meter.value = [...this.project.signature];
    await this.captureStates();
    this.disposeTracks();
    try {
      const tracks = this.project.tracks;
      for (const track of tracks) {
        const runtime = await this.createTrack(track);
        if (this.disposed) {
          this.disposeTrack(runtime);
          throw new Error("Workspace is disposed.");
        }
        this.tracks.set(track.id, runtime);
      }
      if (this.project.tracks !== tracks) return await this.rebuildTracks(position);
      this.mixer.applyRouting(tracks);
      this.mixer.applyMixer();
      this.sessionRevision.value++;
      this.bindNotes();
      this.seek(position);
      this.topologyPending.value = false;
    } catch (error) {
      this.disposeTracks();
      if (!this.disposed) this.topologyPending.value = true;
      throw error;
    }
  }

  private async createTrack(track: ProjectTrack): Promise<TrackRuntime> {
    const automationGain = this.context.createGain();
    let strip: MixerStrip | undefined;
    let rack: TrackRack;
    try {
      strip = this.mixer.createStrip(track.id, automationGain, track);
      rack = new TrackRack(this.context, track.effects, track.effectMacros);
    } catch (error) {
      // Nothing is registered yet, so release whatever was built before the failure.
      automationGain.disconnect();
      if (strip) this.mixer.releaseStrip(strip);
      throw error;
    }
    const runtime: TrackRuntime = {
      kind: track.kind,
      clips: track.clips,
      deviceKeys: deviceKeys(track),
      deviceStates: new Map(track.devices.map((device) => [device.id, device.state])),
      channel: strip.channel,
      automationGain,
      rack,
      effectSettings: track.effects,
      macroSettings: track.effectMacros,
      sendName: strip.sendName,
      sends: new Map(),
      input: automationGain,
      hosts: new Map(),
    };
    try {
      runtime.input = runtime.rack.input;
      runtime.rack.output.connect(automationGain);
      let previous: WebClapHost | undefined;
      for (const device of track.devices) {
        const bundleUrl = this.options.resolveBundle
          ? await this.options.resolveBundle(device)
          : importedBundles.get(this.project)?.has(device.id)
            ? undefined
            : device.bundleUrl;
        if (!bundleUrl) {
          this.warn(`Device ${device.name} has no WebCLAP bundle.`);
          continue;
        }
        let host: WebClapHost | undefined;
        try {
          host = await WebClapHost.load(this.context, { url: bundleUrl, pluginId: device.pluginId, workletUrl: this.options.workletUrl });
          if (host.descriptor?.id !== device.pluginId) {
            host.dispose();
            this.warn(`Device ${device.name} has a different CLAP ID in its bundle.`);
            continue;
          }
          if (!this.loadedBundles.has(device.pluginId)) this.loadedBundles.set(device.pluginId, new Set());
          this.loadedBundles.get(device.pluginId)!.add(bundleUrl);
          if (device.state.length) await host.loadState(device.state);
          if (previous) previous.output.connect(host.input);
          previous = host;
          runtime.hosts.set(device.id, host);
          if (track.kind === "midi" && !runtime.midi) runtime.midi = host;
        } catch (error) {
          host?.dispose();
          this.warn(`Device ${device.name} could not load: ${String(error)}`);
        }
      }
      if (previous) {
        previous.output.connect(runtime.rack.input);
        runtime.input = [...runtime.hosts.values()][0].input;
      }
      // A track with a device plays the device; its instruments entry is ignored, so render workspaces sharing these options stay warning-free.
      const instrument = track.kind === "midi" && !track.devices.length ? this.options.instruments?.[track.id] : undefined;
      if (instrument) {
        runtime.sampler = new Sampler(this.context, instrument);
        runtime.sampler.connect(runtime.rack.input);
        runtime.midi = new SamplerSink(runtime.sampler, this.context);
      }
      this.mixer.connectReceive(strip, runtime.input);
      if (track.kind !== "bus") runtime.session = new AudioTrackSession(this.context, runtime.input);
      this.updateAutomation(runtime, track);
      return runtime;
    } catch (error) {
      this.disposeTrack(runtime);
      throw error;
    }
  }

  /**
   * Apply light Project edits in place; clips, routing and empty-bus edits keep every loaded device alive.
   * A track or device topology change sets `cells.needsSync` and applies nothing until the caller runs `sync()`.
   */
  private async applyLight(): Promise<void> {
    if (this.disposed) throw new Error("Workspace is disposed.");
    this.recordCurrentProject();
    const project = this.project;
    const tracks = project.tracks;
    const ids = new Set(tracks.map(({ id }) => id));
    const removed = [...this.tracks].filter(([id]) => !ids.has(id));
    const compatible =
      removed.every(([, runtime]) => runtime.kind === "bus") &&
      tracks.every((track) => {
        const runtime = this.tracks.get(track.id);
        if (!runtime) return track.kind === "bus" && !track.devices.length;
        const nextKeys = deviceKeys(track);
        return (
          runtime.kind === track.kind &&
          runtime.deviceKeys.length === nextKeys.length &&
          runtime.deviceKeys.every((key, index) => key === nextKeys[index])
        );
      });
    if (!compatible) {
      this.topologyPending.value = true;
      return;
    }

    for (const track of tracks) {
      const runtime = this.tracks.get(track.id);
      if (!runtime) continue;
      for (const device of track.devices) {
        if (runtime.deviceStates.get(device.id) === device.state) continue;
        const host = runtime.hosts.get(device.id);
        if (host) await host.loadState(device.state);
        if (this.disposed) return;
        runtime.deviceStates.set(device.id, device.state);
        if (this.project !== project || project.tracks !== tracks) return this.applyLight();
      }
    }

    const created = new Map<string, TrackRuntime>();
    try {
      for (const track of tracks) {
        if (!this.tracks.has(track.id)) created.set(track.id, await this.createTrack(track));
      }
    } catch (error) {
      for (const runtime of created.values()) this.disposeTrack(runtime);
      throw error;
    }
    if (this.disposed || this.project !== project || project.tracks !== tracks) {
      for (const runtime of created.values()) this.disposeTrack(runtime);
      if (!this.disposed) return this.applyLight();
      return;
    }
    for (const [id, runtime] of created) this.tracks.set(id, runtime);
    for (const [id, runtime] of removed) {
      if (this.tracks.get(id) !== runtime) continue;
      this.tracks.delete(id);
      this.disposeTrack(runtime);
    }
    const position = this.position;
    const tempoChanged = this.activeTempoMap !== project.tempoMap;
    let clipsChanged = false;
    let refreshClips = false;
    const invalidatedAudio = new Set<string>();
    const gainEdits = new Map<string, AudioClipGainAutomation | undefined>();
    for (const track of tracks) {
      const runtime = this.tracks.get(track.id)!;
      if (runtime.clips !== track.clips && track.kind !== "bus") {
        clipsChanged = true;
        refreshClips = this.invalidateClips(runtime, track.clips, invalidatedAudio, gainEdits) || refreshClips;
      }
      runtime.clips = track.clips;
      updateRack(runtime, track);
      this.updateAutomation(runtime, track);
    }
    this.mixer.applyRouting(tracks);
    this.mixer.applyMixer();
    if (clipsChanged) {
      this.audition.stopStale();
      this.scheduler.prune(this.tracks.values());
    }
    // Session slots change without touching the timeline.
    this.reconcileSession();
    // A loop region is in beats, so while looping the playhead keeps its beat across a tempo edit and stays in the region.
    if (tempoChanged)
      this.seek(this.fold.region && this.activeLoopRegion() ? project.tempoMap.beatToSeconds(this.activeTempoMap.secondsToBeat(position)) : position);
    else if (refreshClips) {
      this.scheduler.cancelAudio(invalidatedAudio);
      this.bindNotes();
      void this.clock.refresh();
    }
    if (gainEdits.size) this.scheduler.setGainAutomation(gainEdits);
    if (tempoChanged && refreshClips) this.bindNotes();
    this.topologyPending.value = false;
  }

  private updateAutomation(runtime: TrackRuntime, track: ProjectTrack): void {
    const points = track.volumeAutomation;
    if (!points.length) {
      if (!runtime.automationBinding) return;
      runtime.automationBinding?.dispose();
      runtime.automationBinding = undefined;
      runtime.automationCurve = undefined;
      runtime.automationPoints = undefined;
      smoothGain(this.context, runtime.automationGain.gain, 1);
      return;
    }
    if (runtime.automationPoints === points) return;
    runtime.automationPoints = points;
    if (runtime.automationCurve) {
      runtime.automationCurve.value = points;
      // The binding's own clock runs straight past a wrap, so re-anchor it and let the refill program the next wrap.
      if (this.fold.region && this.clock.state.value === "playing") {
        runtime.automationBinding?.start({ from: this.position });
        void this.clock.refresh();
      }
    } else {
      runtime.automationCurve = new AutomationCurve(points);
      runtime.automationBinding = new AutomationBinding(this.context, runtime.automationCurve, audioParamTarget(runtime.automationGain.gain));
      if (this.clock.state.value === "playing") runtime.automationBinding.start({ from: this.position });
    }
    if (this.clock.state.value !== "playing")
      runtime.automationGain.gain.setValueAtTime(runtime.automationCurve.valueAt(this.position), this.context.currentTime);
  }

  private positionAutomation(seconds: number, playing: boolean, when?: number): void {
    for (const runtime of this.tracks.values()) {
      if (!runtime.automationCurve || !runtime.automationBinding) continue;
      if (playing) runtime.automationBinding.start({ from: seconds, when });
      else {
        runtime.automationBinding.stop();
        runtime.automationGain.gain.setValueAtTime(runtime.automationCurve.valueAt(seconds), this.context.currentTime);
      }
    }
  }

  /**
   * The launcher clip of a Session slot clip, found by its id: `session.value.tracks[trackId].clips[i]` for the clip's scene, or null when the
   * clip is not a slot clip of that track, file-backed audio, or MIDI on a track without a device or instrument. Session clips loop and keep their recorded speed; `clip.configure({ loop: false })` makes one a one-shot.
   * A tracked reader: it re-runs when the Session grid changes and the launcher clips are replaced to match.
   */
  sessionClip(trackId: string, clipId: string): SessionClip | null {
    this.sessionClipEdits.$();
    this.project.cells.revision.$();
    const grid = sessionFor(this.project);
    const index = grid.scenes.findIndex((scene) => grid.clipAt({ trackId, sceneId: scene.id })?.id === clipId);
    return index < 0 ? null : (this.session.value.tracks[trackId]?.clips[index] ?? null);
  }

  /** A launcher over the audio tracks built so far; session clips play through each track's input and take it away from Arrangement while they sound. */
  private buildSession(): ClipLauncher {
    const grid = sessionFor(this.project);
    const specs: Record<string, (ClipSpec | null)[]> = {};
    for (const track of this.project.tracks)
      if (this.tracks.get(track.id)?.session)
        specs[track.id] = grid.scenes.map((scene) => {
          const clip = grid.clipAt({ trackId: track.id, sceneId: scene.id });
          return clip ? this.sessionSpec(clip, track.id) : null;
        });
    const launcher = new ClipLauncher(specs, {
      context: this.context,
      scenes: grid.scenes.map(({ name }) => ({ name })),
      // A scene launch stops the tracks whose slot in that scene is empty, as a Session view does.
      emptySlots: "stop",
      onSchedule: ({ track, clip, when, endsAt }) => {
        const runtime = this.tracks.get(track.name);
        const handle = runtime?.session?.follow(when, clip !== null, endsAt);
        if (!handle || !runtime?.midi) return handle;
        // A MIDI track hands over at `when`, to a clip or back to Arrangement: notes sounding there are released, and the look-ahead is refilled for whoever plays next.
        const host = runtime.midi;
        const releases = Array.from({ length: 16 }, (_, channel) => host.scheduleMidi([0xb0 | channel, 123, 0], when));
        void this.clock.refresh();
        const withdraw = () => {
          for (const release of releases) release.cancel();
        };
        return {
          cancel: () => {
            withdraw();
            handle.cancel?.();
          },
          reset: () => {
            withdraw();
            handle.reset?.();
          },
        };
      },
    });
    for (const id of Object.keys(specs)) launcher.tracks[id]!.connect(this.tracks.get(id)!.input);
    this.clock.attach(launcher);
    this.project.tracks.forEach((track) => this.recordSessionSources(launcher, track));
    this.sessionSceneIds = grid.scenes.map(({ id }) => id);
    return launcher;
  }

  private sessionSpec(clip: ProjectClip, trackId: string): ClipSpec | null {
    if (clip instanceof MidiClip) {
      const host = this.tracks.get(trackId)?.midi;
      if (!host || !(clip.duration > 0)) return null;
      // The project's note model is itself a clock scheduler; it plays into the track's first device and loops over the clip's length.
      clip.midi.instrument = host;
      const [numerator, denominator] = this.project.signature;
      // A looped clip repeats its notes up to the loop end. The scheduler plays from the clip's first beat, so a loop that starts later still plays the lead-in on each pass.
      const beats = clip.loop ? Math.min(clip.loop.endBeat, clip.duration) : clip.duration;
      return { scheduler: clip.midi, loop: true, length: `${beats / ((numerator * 4) / denominator)}m`, name: clip.id };
    }
    if (clip.kind !== "audio") return null;
    // A file-backed clip plays from a copy of its audio read into memory: null until it has been read, then the launcher clip arrives.
    const pcm = clip.media ? this.sessionPcm(clip) : (clip as PcmAudioClip);
    if (!pcm) return null;
    clip = pcm;
    if (clip.loop) {
      // The launcher counts a buffer's material in beats at `bpm`; 60 makes a beat one second of the recording, so the loop and the entry point are the clip's seconds.
      const plan = audioLoopFrames(clip as PcmAudioClip & { loop: SecondsRange });
      const reach = plan.entry / clip.sampleRate + clip.duration;
      const sessionLoopEnd = reach > clip.loop.startSeconds && reach < clip.loop.endSeconds ? reach : clip.loop.endSeconds;
      return {
        buffer: this.scheduler.sessionLoopBufferFor(clip as PcmAudioClip),
        // A clip shorter than its first pass never reaches the loop end, so the Session stops the loop where the Arrangement does.
        loop: { startBeat: clip.loop.startSeconds, endBeat: sessionLoopEnd },
        offsetBeats: plan.entry / clip.sampleRate,
        bpm: 60,
        warp: false,
        name: clip.id,
      };
    }
    return { buffer: this.scheduler.sessionBufferFor(clip as PcmAudioClip), loop: true, warp: false, name: clip.id };
  }

  /**
   * The in-memory audio of a file-backed Session clip: its window, or its whole recording when it loops (the loop can play any part of it). Reading is
   * asynchronous; the Session clip is replaced as soon as it is done.
   */
  private sessionPcm(clip: MediaAudioClip): PcmAudioClip | null {
    const ready = this.sessionMedia.get(clip);
    if (ready || this.sessionMediaLoading.has(clip)) return ready ?? null;
    this.sessionMediaLoading.add(clip);
    const [first, count] = clip.loop ? [0, clip.media.frameCount] : [clip.startFrame, clip.frameCount];
    void clip.media.readFrames(first, count).then(
      (channels) => {
        if (this.disposed) return;
        const { media: _media, startFrame: _start, frameCount: _count, ...rest } = clip;
        this.sessionMedia.set(clip, Object.freeze({ ...rest, channels }) as PcmAudioClip);
        this.reconcileSession();
      },
      (error) => {
        this.sessionMediaLoading.delete(clip);
        if (!this.disposed) this.mediaError.value = error instanceof Error ? error.message : String(error);
      },
    );
    return null;
  }

  private recordSessionSources(launcher: ClipLauncher, track: ProjectTrack): void {
    const grid = sessionFor(this.project);
    grid.scenes.forEach((scene, index) => {
      const clip = grid.clipAt({ trackId: track.id, sceneId: scene.id });
      const sessionClip = launcher.tracks[track.id]?.clips[index];
      if (clip && sessionClip) this.sessionSources.set(sessionClip, clip);
    });
  }

  /** Bring the session clips in line with the Project's Session grid: a clip that changed or went away is replaced or removed (stopped at once if it was playing). */
  private reconcileSession(): void {
    const launcher = this.sessionLauncher;
    if (!launcher) return;
    const grid = sessionFor(this.project);
    const scenes = grid.scenes;
    const wanted = scenes.map(({ id }) => id);
    const known = this.sessionSceneIds;
    const kept = known.filter((id) => wanted.includes(id));
    if (kept.some((id, index) => id !== wanted.filter((other) => kept.includes(other))[index])) {
      // Scenes are only added and removed, never reordered; a different order means the launcher no longer matches, so build it again.
      launcher.dispose();
      this.sessionLauncher = undefined;
      this.sessionRevision.value++;
      return;
    }
    // Slots follow the scenes in place, so clips in later scenes keep playing: removed scenes first (last to first), then inserted ones.
    for (let index = known.length - 1; index >= 0; index--)
      if (!wanted.includes(known[index])) {
        launcher.removeScene(index);
        known.splice(index, 1);
      }
    wanted.forEach((id, index) => {
      if (known[index] === id) return;
      launcher.insertScene(index, { name: scenes[index].name });
      known.splice(index, 0, id);
    });
    scenes.forEach(({ name }, index) => launcher.scenes[index]._rename(name));
    let replaced = false;
    for (const track of this.project.tracks) {
      const sessionTrack = launcher.tracks[track.id];
      if (!sessionTrack) continue;
      const count = Math.max(scenes.length, sessionTrack.clips.length);
      for (let index = 0; index < count; index++) {
        const wanted = scenes[index] ? (grid.clipAt({ trackId: track.id, sceneId: scenes[index].id }) ?? undefined) : undefined;
        const spec = wanted ? this.sessionSpec(wanted, track.id) : null;
        const existing = sessionTrack.clips[index] ?? null;
        const source = existing ? this.sessionSources.get(existing) : undefined;
        if ((spec === null && existing === null) || (spec !== null && existing !== null && source === wanted)) continue;
        replaced = true;
        const clip = sessionTrack.setClip(index, spec);
        if (clip && wanted) this.sessionSources.set(clip, wanted);
      }
    }
    if (replaced) this.sessionClipEdits.value++;
  }

  async play(): Promise<void> {
    if (this.disposed) throw new Error("Workspace is disposed.");
    if (untracked(() => this.clock.state.value === "playing")) return this.seekResume;
    const request = ++this.playRequest;
    await this.flush();
    if (request !== this.playRequest) return;
    // An offline render is started by its owner; its context cannot be resumed before then.
    if (!isOfflineContext(this.context)) await this.context.resume();
    const position = this.position;
    this.scheduler.retryFailures();
    await this.prefetchMediaAt(position);
    if (request !== this.playRequest) return;
    this.resumingSeek = false;
    await this.startArrangement(position);
  }

  private startArrangement(position: number): Promise<void> {
    this.activeTempoMap = untracked(() => this.project.tempoMap);
    const beat = this.activeTempoMap.secondsToBeat(position);
    const now = this.context.currentTime;
    const when = isOfflineContext(this.context) ? now : Math.ceil((now + playbackLead) * this.context.sampleRate) / this.context.sampleRate;
    this.rebaseTempo(beat, when);
    this.clock.start(when, beat);
    this.positionAutomation(position, true, when);
    return this.clock.refresh();
  }
  pause(): void {
    this.playRequest++;
    this.resumingSeek = false;
    untracked(() => this.positionAutomation(this.position, false));
    this.clock.pause();
    this.cancelAudio();
    this.allNotesOff();
  }
  stop(): void {
    this.playRequest++;
    this.resumingSeek = false;
    batch(() => {
      this.clock.stop();
      this.seekPoint.value = { seconds: 0 };
    });
    untracked(() => this.positionAutomation(0, false));
    this.cancelAudio();
    this.allNotesOff();
  }
  seek(seconds: number): void {
    untracked(() => this.seekUntracked(seconds));
  }
  private seekUntracked(seconds: number): void {
    if (!Number.isFinite(seconds) || seconds < 0) throw new RangeError("Workspace seek needs non-negative seconds.");
    const request = ++this.playRequest;
    const playing = this.clock.state.value === "playing";
    this.scheduler.retryFailures();
    const prefetched = playing ? this.prefetchMediaAt(seconds) : undefined;
    this.resumingSeek = !!prefetched;
    this.allNotesOff();
    this.cancelAudio();
    this.activeTempoMap = this.project.tempoMap;
    const beat = this.activeTempoMap.secondsToBeat(seconds);
    if (prefetched) {
      // Hold the transport playing at the target: a start in the far future keeps `playing` with the position frozen at `beat` and schedules
      // nothing until `startArrangement` re-anchors it once the chunks are in.
      const hold = this.context.currentTime + holdSeconds;
      this.rebaseTempo(beat, hold);
      // Schedulers get the real seek first (an armed take is cancelled, as on any seek), then the hold.
      this.clock.seek(beat);
      this.clock.start(hold, beat);
      this.seekPoint.value = { seconds };
      this.positionAutomation(seconds, false);
      const resume = prefetched.then(() => {
        if (request !== this.playRequest || this.disposed) return;
        this.resumingSeek = false;
        if (this.clock.state.value === "playing") return this.startArrangement(seconds);
      });
      this.seekResume = resume;
      void resume.finally(() => {
        if (this.seekResume === resume) this.seekResume = undefined;
      });
      return;
    }
    this.rebaseTempo(beat);
    this.clock.seek(beat);
    // A seek to the same target still moves a paused or advancing playhead.
    this.seekPoint.value = { seconds };
    this.positionAutomation(seconds, playing);
    if (playing) void this.clock.refresh();
  }
  refresh(): void {
    this.allNotesOff();
    this.clock.refresh();
  }

  /** Apply clip arrangement edits without reloading track devices. */
  refreshArrangement(): void {
    untracked(() => this.refreshArrangementUntracked());
  }
  private refreshArrangementUntracked(): void {
    if (this.disposed) throw new Error("Workspace is disposed.");
    this.audition.stopStale();
    const invalidatedAudio = new Set<string>();
    const gainEdits = new Map<string, AudioClipGainAutomation | undefined>();
    for (const track of this.project.tracks) {
      const runtime = this.tracks.get(track.id);
      if (runtime?.kind !== track.kind) continue;
      this.invalidateClips(runtime, track.clips, invalidatedAudio, gainEdits);
      runtime.clips = track.clips;
    }
    this.reconcileSession();
    this.scheduler.prune(this.tracks.values());
    this.scheduler.setGainAutomation(gainEdits);
    this.scheduler.cancelAudio(invalidatedAudio);
    this.bindNotes();
    void this.clock.refresh();
  }

  private invalidateClips(
    runtime: TrackRuntime,
    clips: ProjectTrack["clips"],
    invalidatedAudio: Set<string>,
    gainEdits: Map<string, AudioClipGainAutomation | undefined>,
  ): boolean {
    if (runtime.clips === clips) return false;
    if (runtime.kind === "midi") {
      if (runtime.midi && this.clock.state.value === "playing") {
        const next = new Set(clips);
        const beat = this.fold.toBeat(this.timeline.timeToBeat(this.context.currentTime));
        const changedPlayingClip = runtime.clips.some((clip) => {
          if (!(clip instanceof MidiClip)) return false;
          const time = this.midiClipPositions.get(clip) ?? clip.time;
          return time <= beat && beat <= time + clip.duration && (!next.has(clip) || clip.time !== time);
        });
        if (changedPlayingClip) runtime.midi.allNotesOff();
      }
      return true;
    }
    if (collectGainAutomationEdits(runtime.clips, clips, gainEdits)) return false;
    const next = new Set(clips);
    for (const clip of runtime.clips) if (clip.kind === "audio" && !next.has(clip)) invalidatedAudio.add(clip.id);
    return true;
  }

  private bindNotes(): void {
    for (const off of this.noteOff.splice(0)) off();
    for (const track of this.tracks.values()) {
      for (const clip of track.clips) {
        if (!(clip instanceof MidiClip)) continue;
        this.midiClipPositions.set(clip, clip.time);
        this.noteOff.push(
          clip.midi.revision.subscribe(() => {
            if (this.clock.state.value !== "playing") return;
            const beat = this.fold.toBeat(this.timeline.timeToBeat(this.context.currentTime));
            if (clip.time <= beat && beat <= clip.time + clip.duration) track.midi?.allNotesOff();
            void this.clock.refresh();
          }),
        );
      }
    }
  }

  setTrackVolume(trackId: string, value: number): void {
    this.reflectProjectEdit(() => {
      this.project.setTrackVolume(trackId, value);
      this.mixer.applyMixer();
    });
  }

  setMasterVolume(value: number): void {
    this.reflectProjectEdit(() => {
      this.project.setMasterVolume(value);
      this.mixer.applyMaster();
    });
  }

  setTrackMuted(trackId: string, muted: boolean): void {
    this.reflectProjectEdit(() => {
      this.project.setTrackMuted(trackId, muted);
      this.mixer.applyMixer();
    });
  }
  setTrackSolo(trackId: string, solo: boolean): void {
    this.reflectProjectEdit(() => {
      this.project.setTrackSolo(trackId, solo);
      this.mixer.applyMixer();
    });
  }
  setTrackPan(trackId: string, pan: number): void {
    this.reflectProjectEdit(() => {
      this.project.setTrackPan(trackId, pan);
      this.mixer.applyMixer();
    });
  }

  /** Apply a rack edit now without rebuilding WebCLAP devices or stopping transport. */
  setTrackEffects(trackId: string, effects: readonly RackEffect[]): void {
    const runtime = this.tracks.get(trackId);
    const track = untracked(() => this.project.tracks.find((item) => item.id === trackId));
    if (!runtime || !track) throw new Error("Workspace effects need a live track.");
    runtime.rack.setEffects(effects);
    this.reflectProjectEdit(() => {
      this.project.setTrackEffects(trackId, runtime.rack.effects);
      const current = this.project.tracks.find((item) => item.id === trackId)!;
      runtime.effectSettings = current.effects;
      runtime.macroSettings = current.effectMacros;
    });
  }

  trackMacroValue(trackId: string, macroId: string): Readable<number> | undefined {
    return this.tracks.get(trackId)?.rack.macro(macroId)?.param;
  }

  /** The macro's native automation target for an `AutomationBinding`: the normalized curve fans out to every mapped parameter on the audio thread. */
  trackMacroAutomation(trackId: string, macroId: string): AutomationTarget | undefined {
    return this.tracks.get(trackId)?.rack.macro(macroId)?.automation;
  }

  /** Apply one macro directly to the audio graph and retain its position in Project. */
  setTrackMacroValue(trackId: string, macroId: string, value: number): void {
    const runtime = this.tracks.get(trackId);
    const track = untracked(() => this.project.tracks.find((item) => item.id === trackId));
    if (!runtime || !track?.effectMacros.some(({ id }) => id === macroId) || track.effectMacros !== runtime.macroSettings)
      throw new Error("Flush the project before setting a live track macro.");
    const macro = runtime.rack.macro(macroId)!;
    batch(() => {
      macro.param.value = value;
      this.reflectProjectEdit(() => {
        this.project.setTrackMacroValue(trackId, macroId, value);
        runtime.macroSettings = this.project.tracks.find((item) => item.id === trackId)!.effectMacros;
      });
    });
  }

  /** Borrow the post-insert, pre-mixer output for an analyser or display. */
  trackEffectOutput(trackId: string): AudioNode | undefined {
    return this.tracks.get(trackId)?.rack.output;
  }

  trackFilterResponse(
    trackId: string,
    slotId: string,
    frequencies: Float32Array<ArrayBuffer>,
    magnitudes: Float32Array<ArrayBuffer>,
    phases: Float32Array<ArrayBuffer>,
  ): boolean {
    return this.tracks.get(trackId)?.rack.readFilterResponse(slotId, frequencies, magnitudes, phases) ?? false;
  }

  /** Rewire a live track without replacing its devices or invalidating transport events. */
  setTrackRouting(trackId: string, routing: TrackRouting): void {
    const tracks = untracked(() => this.project.tracks);
    if (!this.tracks.has(trackId) || tracks.length !== this.tracks.size || tracks.some((track) => !this.tracks.has(track.id)))
      throw new Error("Sync new or removed tracks before changing live routing.");
    this.reflectProjectEdit(() => {
      this.project.setTrackRouting(trackId, routing);
      this.mixer.applyRouting(this.project.tracks);
      this.mixer.applyMixer();
    });
  }

  /** Borrow a post-fader track output for the mixer's meter, or use output for the master meter. */
  trackMixerOutput(trackId: string): AudioNode | undefined {
    return this.mixer.tap(trackId);
  }

  host(deviceId: string): WebClapHost | undefined {
    for (const track of this.tracks.values()) {
      const host = track.hosts.get(deviceId);
      if (host) return host;
    }
    return undefined;
  }

  /** Audition the current audio clip through master output independently of Arrangement. */
  auditionAudioClip(clipId: string): Promise<void> {
    return this.audition.auditionClip(clipId);
  }

  stopClipAudition(): void {
    this.audition.stopClip();
  }

  /** Repeat one project-second range over a group of audio tracks, independently of Arrangement. */
  auditionRange(range: LoopRange, options: { trackIds?: readonly string[] } = {}): Promise<void> {
    return this.audition.auditionRange(range, options);
  }

  stopRangeAudition(): void {
    this.audition.stopRange();
  }

  /** Render a clip from its retained source and defer the project mutation to the caller's undo transaction. */
  prepareAudioClipStretch(
    clipId: string,
    ratio: number,
    processor?: WaveStretchProcessor,
    options: { signal?: AbortSignal; anchors?: readonly WaveStretchAnchor[] } = {},
  ): Promise<PreparedClipStretch> {
    return this.stretch.prepare(clipId, ratio, processor, options);
  }

  /**
   * Wait for queued Project edits and fold live device state into the Project, serialized with sync.
   * Returns the Project, which is then safe to hand to a file codec.
   */
  async checkpoint(): Promise<Project> {
    if (this.disposed) throw new Error("Workspace is disposed.");
    await this.flush();
    await this.serialize(() => this.captureStates());
    return this.project;
  }

  /** @internal Resolves when the audio and device messages scheduled by the transport so far are in place. An offline render awaits it while suspended. */
  renderSettled(): Promise<void> {
    return this.scheduler.settled();
  }

  private prefetchMediaAt(position: number): Promise<void> | undefined {
    return this.scheduler.prefetchMediaAt(this.tracks.values(), position);
  }

  private async captureStates(): Promise<void> {
    const project = this.project;
    for (const track of project.tracks)
      for (const device of track.devices) {
        const host = this.host(device.id);
        const runtime = this.tracks.get(track.id);
        if (host && runtime?.deviceStates.get(device.id) === device.state) {
          const state = await host.saveState();
          if (this.disposed || this.project !== project) return;
          const currentTrack = () => project.tracks.find(({ id }) => id === track.id);
          if (currentTrack()?.devices.find(({ id }) => id === device.id)?.state !== device.state) continue;
          this.reflectProjectEdit(() => {
            captureDeviceState(project, device.id, state);
            const installed = currentTrack()?.devices.find(({ id }) => id === device.id);
            if (installed) runtime.deviceStates.set(device.id, installed.state);
          });
        }
      }
  }

  private schedule(window: TickWindow<Record<never, never>>): void {
    // File-backed media is scheduled further ahead than the window, so the tempo must be on the timeline that far too.
    let through = window.beat.end;
    for (let pass = 0; pass < 8; pass++) {
      this.extendLoopTempo(through);
      const next = this.timeline.timeToBeat(window.time.lookAheadEnd + 0.35);
      if (next <= through) break;
      through = next;
    }
    if (untracked(() => this.arrangement.value))
      this.scheduler.scheduleArrangement(this.tracks.values(), window, this.activeTempoMap, this.timeline, this.fold);
    for (const wrap of this.fold.wraps(window.beat.start, window.beat.end)) this.programLoopAutomation(this.timeline.beatToTime(wrap));
  }

  /** Arrangement switched while playing: off releases its sound on tracks no Session clip holds; on refills the look-ahead. */
  private arrangementChanged(on: boolean): void {
    if (this.disposed || this.clock.state.value !== "playing") return;
    if (!on) {
      this.cancelAudio();
      const now = this.context.currentTime;
      for (const track of this.tracks.values()) if (!track.session?.playingAt(now)) track.midi?.allNotesOff();
    }
    void this.clock.refresh();
  }

  private allNotesOff(): void {
    for (const track of this.tracks.values()) {
      for (const host of track.hosts.values()) host.allNotesOff();
      if (track.sampler) track.midi?.allNotesOff();
    }
  }

  private cancelAudio(): void {
    this.scheduler.cancelAudio();
  }

  private disposeTrack(runtime: TrackRuntime): void {
    runtime.session?.dispose();
    runtime.rack.dispose();
    for (const host of runtime.hosts.values()) host.dispose();
    runtime.sampler?.dispose();
    runtime.automationBinding?.dispose();
    runtime.automationGain.disconnect();
    this.mixer.disposeStrip(runtime);
  }

  private disposeTracks(): void {
    for (const off of this.noteOff.splice(0)) off();
    this.sessionLauncher?.dispose();
    this.sessionLauncher = undefined;
    for (const runtime of this.tracks.values()) this.disposeTrack(runtime);
    this.tracks.clear();
    this.scheduler.forget();
  }

  dispose(): void {
    if (this.disposed) return;
    this.stopWatchingProject?.();
    this.stopWatchingArrangement?.();
    this.stop();
    this.disposed = true;
    this.audition.stop();
    this.stretch.abortAll();
    this.clock.dispose();
    this.disposeTracks();
    this.output.disconnect();
    this.ownedProject?.dispose();
    this.ownedProject = undefined;
  }
}
