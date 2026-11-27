import { importedBundles } from "./project-persistence";
import { chainFadeSeconds, chainLead, holdSeconds, playbackLead, smoothGain } from "./internal/playback-gain";
import { WidthPath } from "./width-path";
import { probeWidth } from "./internal/width-probe";
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
import { SamplerSink, midiVelocityByte } from "./midi-sink";
import type { MidiNote } from "@audiorective/midi";
import { AutomationBinding, AutomationCurve, audioParamTarget, type AutomationTarget } from "@audiorective/core/automation";
import { WebClapHost } from "@audiorective/host/webclap";
import { ClipLauncher, type Clip as SessionClip, type ClipSpec } from "@audiorective/launcher";
import type { WaveStretchAnchor, WaveStretchProcessor } from "@audiorective/player";
import { TrackRack } from "./track-rack";
import { AudioTrackSession } from "./audio-track-session";
import { Audition, type RangeAuditionState } from "./audition";
import { ClipStretch, renderOpenedStretches, type PreparedClipStretch } from "./clip-stretch";
import { createWorkspaceLoop, LoopFold, type WorkspaceLoop } from "./arrangement-loop";
import { ClipScheduler } from "./clip-scheduler";
import { Mixer, type MixerStrip } from "./mixer";
import { LevelMeters, type WorkspaceLevels } from "./level-meters";
import { audioChannelCount, captureDeviceParameters, captureDeviceState, MidiClip, Project } from "./model";
import { DeviceParameterLink } from "./device-parameter-link";
import { rackSlotParameters, splitRackDeviceId, tableParameters, type DeviceParameter, type DeviceParameterRecord } from "./device-parameters";
import type { TempoMap } from "./tempo-map";
import type { AudioClipGainAutomation, MediaAudioClip, PcmAudioClip, ProjectClip, ProjectTrack, WebClapDevice } from "./model";
import type { BeatRange, ProjectVersion, SecondsRange } from "./project-edits";
import { audioLoopFrames } from "./clip-loop";
import { sessionFor } from "./session";
import { sessionNotes, sessionWindow } from "./session-notes";
import { songParser } from "./song-parser";

export { scheduleClipEnvelope } from "./schedule-clip-envelope";
export type { PreparedClipStretch } from "./clip-stretch";

export type { RangeAuditionState } from "./audition";
export type { WorkspaceLevels } from "./level-meters";
import { collectGainAutomationEdits, deviceKeys, updateRack } from "./track-reconcile";
import { assertTakeAudioTime, placeTake, type TakeAnchor } from "./take-placement";
import type { TrackRuntime } from "./track-runtime";

export type PlaybackEditStatus = "applied" | "needs-sync" | "failed" | "superseded";

/** A `Sampler` setup for one MIDI track: what it plays (`sound`), its root note, release and polyphony. */
export type TrackInstrument = Omit<SamplerOptions, "signal">;

/** What building a track reads: the live Workspace's, or the staged song of `open`. */
type TrackStage = Readonly<{
  project: Project;
  options: WorkspaceOptions;
  warn: (message: string) => void;
  loaded: Map<string, Set<string>>;
}>;

/** What `workspace.open` accepts: the file's bytes, or a Blob or File. */
export type WorkspaceSource = Uint8Array | Blob;

/**
 * The options `workspace.open` takes. Those given replace the workspace's own for this song and later syncs; those left out stay.
 * `ownsProject` applies to a `Project` passed in: true hands it to the Workspace, which disposes it when a later `open` replaces it, or on `dispose()`; the default leaves it with the caller.
 * A song read from a file is always the Workspace's own.
 */
export type WorkspaceOpenOptions = Pick<WorkspaceOptions, "workletUrl" | "resolveBundle" | "instruments" | "stretch" | "warnings" | "ownsProject">;

export type WorkspaceOptions = {
  /** Audio node receiving the master output; default the AudioContext destination. */
  destination?: AudioNode;
  /** WebCLAP worklet module URL; omitted to use the host bundled worklet URL. */
  workletUrl?: string;
  /** Resolve bundle hints from opened files. Returning undefined declines the URL. */
  resolveBundle?: (device: WebClapDevice) => string | Promise<string | undefined> | undefined;
  /**
   * Sound for MIDI tracks without a plug-in, keyed by track id: each entry becomes a core `Sampler` playing that track's notes into its mixer channel, in Arrangement,
   * Session and offline renders. `sound` may be a buffer or a `SoundFactory` for page-made sounds. Not saved in the file: pass it again when opening. A track with a WebCLAP device ignores its entry.
   * A function `(track) => TrackInstrument | undefined` picks by the track's `id`, `name` or `kind` instead, so a reopened file needs no id lookup; it runs for every MIDI track without a device,
   * including tracks added before a `sync()`.
   * A sampler plays notes (velocity from the note-on) and the sustain pedal (CC64, one pedal for every channel); all-notes-off (CC120, CC123) releases at once. It ignores pitch bend, mod wheel and
   * every other controller, channel and polyphonic pressure, and program change: a track's controller lanes and clip events of those kinds only reach a WebCLAP device.
   */
  instruments?: Readonly<Record<string, TrackInstrument>> | ((track: Pick<ProjectTrack, "id" | "name" | "kind">) => TrackInstrument | undefined);
  /**
   * The stretch engine for audio clips a file stretches (an audio file of one tempo in a song of another, as Bitwig Studio writes it), typed as the
   * player's `stretch` option; `TimeStretch` from `@audiorective/effects/time-stretch` fits. At open every such clip is rendered with it, pitch preserved,
   * before the song plays; this is not an Undo step and does not change the version. Without it those clips play by varispeed (right length and position,
   * changed pitch) and `warnings` says so once. A render that fails leaves that clip on varispeed with a warning. `prepareAudioClipStretch` takes its own processor.
   */
  stretch?: WaveStretchProcessor;
  /** Initial value of `workspace.arrangement`. Default true; false for an app that only plays Session clips. */
  arrangement?: boolean;
  /** Messages produced before the workspace existed, such as file-open warnings; they precede the workspace's own. */
  warnings?: readonly string[];
  /** Hand the Project to the Workspace: `dispose()` disposes it too. Ownership ends when `workspace.open` replaces the song: the Workspace then disposes this Project. Default: the caller owns it. */
  ownsProject?: boolean;
  /** @internal Drives the transport from an offline render loop instead of a timer; used by `exportAudioFallbackTo`. */
  tickSource?: TickSource;
};
const isOfflineContext = (context: BaseAudioContext): boolean => typeof OfflineAudioContext !== "undefined" && context instanceof OfflineAudioContext;

/** A borrowed transport view that can be passed directly to a player widget. */
export type WorkspacePlayer = Readonly<{
  /** Observable playback flag shared with the Workspace transport. */
  isPlaying: Readable<boolean>;
  /** Starts or resumes playback, resuming the audio context first. */
  play(): Promise<void>;
  /** Pauses playback while retaining the project position. */
  pause(): void;
  /** Borrowed timeline view in project seconds; editing and lifecycle remain with the Workspace. */
  timeline: Readonly<{
    /** Marks this as a clock-driven timeline so widgets poll its advancing position. */
    clock: true;
    /** Length of the song in seconds (where the last clip ends); changes with edits. */
    duration: Readable<number>;
    /** Returns the current project position in seconds. */
    position(): number;
    /** Seeks to a non-negative project position in seconds and refreshes scheduled playback. */
    seek(seconds: number): void;
  }>;
}>;
export type { TakeAnchor } from "./take-placement";
/** One live DAW workspace over one Project. Project remains the sole persistent-data owner. */
export class Workspace {
  readonly context: AudioContext;
  readonly output: GainNode;
  private readonly timeline: Timeline;
  private readonly clock: Clock;
  /**
   * The Workspace's beat transport: `transport.timeline` maps beats and time, `transport.attach(scheduler)` follows its windows
   * and `transport.refresh()` re-queues the look-ahead. Pass it wherever a structural transport is accepted, for example the `transport`
   * option of `@audiorective/sequencer`. Play, pause, seek and tempo stay with the Workspace.
   */
  get transport(): Clock {
    return this.clock;
  }
  /** This Workspace as a player for the widgets: play, pause, seek and the song `duration` and `position` in project seconds. Borrowed; it needs no dispose. */
  readonly player: WorkspacePlayer;
  private readonly topologyPending = cell(false);
  /** `dispose()` is stopping playback: devices are about to be disposed, so a stop sends them no controller resets. */
  private disposing = false;
  private readonly mediaError = cell<string | null>(null);
  private readonly applicationError = cell<string | null>(null);
  private readonly warningMessages = cell<readonly string[]>(Object.freeze([]));
  private readonly audition: Audition;
  /** Live state, as cells: read inside an effect or `subscribe` to follow it. */
  readonly cells: Readonly<{
    needsSync: ReadonlyCell<boolean>;
    error: ReadonlyCell<string | null>;
    warnings: ReadonlyCell<readonly string[]>;
    /**
     * The Session view's launcher over this Workspace's audio and MIDI tracks. `session.value.tracks[trackId].clips[i]` is the slot clip of scene i on that track
     * (`null` for an empty slot); launch it with `clip.launch()` or a whole scene with `launchScene(i)`. It follows `workspace.transport`, is built on first read
     * and is replaced by `sync()` and `open()`: a launcher read once and kept goes stale, so read `session.value` inside an effect (or subscribe to this cell) to follow the replacement. See `sessionClip` and docs/daw.md.
     */
    session: ReadonlyCell<ClipLauncher>;
    /** The id of the audio clip `auditionAudioClip` is playing or loading, or null. */
    auditioningClip: ReadonlyCell<string | null>;
    /** The range `auditionRange` is repeating or loading, or null. */
    auditioningRange: ReadonlyCell<RangeAuditionState | null>;
    /**
     * Post-fader peak in dBFS of the master output and of each track strip, refreshed every animation frame while the context runs; -Infinity when silent
     * (also after `stop()` and while the context is suspended). It follows track adds and removes and `sync()`. Sampling starts on the first read and ends on `dispose()`.
     * Peak hold and ballistics belong to the view.
     */
    levels: ReadonlyCell<WorkspaceLevels>;
  }>;
  private readonly stretch: ClipStretch;
  private readonly sessionCell: ReadonlyCell<ClipLauncher>;
  /** Built on first read of `cells.session`, so an app that never launches clips never copies their audio into buffers. */
  private sessionLauncher?: ClipLauncher;
  /** Bumped when `sync()` replaces the launcher, so `cells.session` readers re-run. */
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
  private options: WorkspaceOptions;
  /** Bundle URLs this workspace has loaded, by CLAP ID: already approved, so `deviceOptions` approves them again in a file saved from here. */
  private readonly loadedBundles = new Map<string, Set<string>>();
  /**
   * What another workspace needs to load the same devices and instruments: a render workspace, or this project saved and opened again.
   * Its `resolveBundle` asks this workspace's own `resolveBundle` first, then approves a bundle URL this workspace has loaded for the same CLAP ID.
   */
  get deviceOptions(): Pick<WorkspaceOptions, "workletUrl" | "resolveBundle" | "instruments" | "stretch"> {
    const resolve = this.options.resolveBundle;
    const loaded = this.loadedBundles;
    return {
      workletUrl: this.options.workletUrl,
      instruments: this.options.instruments,
      stretch: this.options.stretch,
      resolveBundle: async (device) =>
        (resolve ? await resolve(device) : undefined) ??
        (device.bundleUrl && loaded.get(device.pluginId)?.has(device.bundleUrl) ? device.bundleUrl : undefined),
    };
  }
  private readonly tracks = new Map<string, TrackRuntime>();
  private readonly scheduler: ClipScheduler;
  private readonly noteOff: Array<() => void> = [];
  private readonly midiClipPositions = new WeakMap<MidiClip, number>();
  /** The notes of each bound MIDI clip as of its last edit, so an edit while playing can tell which sounding notes it changed. */
  private readonly noteSnapshots = new WeakMap<MidiClip, readonly MidiNote[]>();
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
  /** Work waiting on a fade timer; `dispose()` runs it. */
  private readonly pending = new Set<() => void>();
  private readonly mixer: Mixer;
  private readonly levelMeters: LevelMeters;

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
    this.levelMeters = new LevelMeters(context, this.output, () => [...this.tracks].map(([id, runtime]) => [id, runtime.channel] as const));
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
    this.sessionCell = readonlyCell(() => {
      this.sessionRevision.$();
      return untracked(() => (this.sessionLauncher ??= this.buildSession()));
    });
    this.cells = Object.freeze({
      needsSync: readonlyCell(this.topologyPending),
      error: readonlyCell(() => this.applicationError.value ?? this.mediaError.value),
      warnings: readonlyCell(this.warningMessages),
      session: this.sessionCell,
      auditioningClip: this.audition.cells.clip,
      auditioningRange: this.audition.cells.range,
      levels: this.levelMeters.cell,
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

  /** The song the Workspace plays. Read-only: `open` replaces it. */
  get project(): Project {
    return this.projectSource.value;
  }

  private warn(message: string): void {
    this.warningMessages.value = Object.freeze([...untracked(() => this.warningMessages.value), message]);
  }

  /** Play a Project you already hold (a new empty song, or one built in code) on `context`. To play a `.dawproject` file, use `openWorkspace`. The caller owns the Project unless `options.ownsProject` is true. */
  static async create(context: AudioContext, project: Project, options: WorkspaceOptions = {}): Promise<Workspace> {
    // Clips the opened file stretched get their render first, so the song never plays them twice with two pitches.
    const stretchWarnings: string[] = [];
    await renderOpenedStretches(
      project,
      options.stretch,
      (message) => stretchWarnings.push(message),
      () => false,
    );
    if (stretchWarnings.length) options = { ...options, warnings: [...(options.warnings ?? []), ...stretchWarnings] };
    const workspace = new Workspace(context, project, options);
    try {
      await workspace.sync();
      if (options.warnings?.length)
        workspace.warningMessages.value = Object.freeze([...options.warnings, ...untracked(() => workspace.cells.warnings.value)]);
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

  /** Length of the song in seconds: where the last clip ends. Re-read after edits; it is `0` for an empty song. */
  get duration(): number {
    return Math.max(0, ...this.project.tracks.flatMap((track) => track.clips.map((clip) => this.project.clipTimeSeconds(clip, clip.duration))));
  }
  /** Where playback is, in project seconds from the song's start: the playhead while playing, the parked point while paused or stopped. Tracked when read in an effect. */
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

  /** Rebuild every track and device from the Project after a structural edit: stops playback, reloads, seeks back to the previous position and clears `cells.needsSync`. A failure rejects and leaves `cells.needsSync` set. */
  sync(): Promise<void> {
    return this.serialize(() => this.applyProjectEdit(() => this.rebuildTracks()));
  }

  /**
   * Add the WebCLAP plug-in at `bundleUrl` to a track: loads the bundle once to read its CLAP ID, name, vendor and version, then records the device with
   * `project.addDevice` (`bundleUrl` is stored as given) as one Undo step named `Add <name>`, and resolves once the running track has it. Playback does not stop: the plug-in is spliced into the running track.
   * Only a pending track-list change (`cells.needsSync`) runs `sync()` first, which stops playback.
   * `options.pluginId` picks one plug-in of a bundle that holds several.
   * A bundle that cannot load rejects with its error and leaves the Project unchanged; if the rebuild fails, only this device is removed again (as Undo when nothing was edited since, else as a new edit), and any other edit stays. If the device is gone from the Project when loading ends (Undo, a removal, a replaced song), it rejects with `Workspace device was removed before it finished loading.`
   */
  async addWebClapDevice(trackId: string, bundleUrl: string, options: Readonly<{ pluginId?: string }> = {}): Promise<WebClapDevice> {
    if (this.disposed) throw new Error("Workspace is disposed.");
    if (!this.project.tracks.some((track) => track.id === trackId)) throw new Error("Workspace device needs an existing track.");
    if (typeof bundleUrl !== "string" || !bundleUrl) throw new Error("Workspace device needs a bundle URL.");
    const host = await WebClapHost.load(this.context, { url: bundleUrl, pluginId: options.pluginId, workletUrl: this.options.workletUrl });
    const { id, name, vendor, version } = host.descriptor;
    host.dispose();
    if (this.disposed) throw new Error("Workspace is disposed.");
    const project = this.project;
    const device = project.edit(`Add ${name}`, () => project.addDevice(trackId, { kind: "webclap", pluginId: id, name, vendor, version, bundleUrl }));
    const added = untracked(() => project.cells.version.value);
    const present = () =>
      !this.disposed && this.project === project && project.tracks.some((track) => track.devices.some((item) => item.id === device.id));
    try {
      // A structural edit still waiting (a new track) is applied with it; otherwise the device goes into the running track.
      if (untracked(() => this.topologyPending.value)) await this.sync();
      else await this.flush();
    } catch (error) {
      if (present()) {
        // Undo only while nothing else has been edited since; otherwise take out just this device, so another edit stays.
        if (untracked(() => project.cells.version.value) === added && project.cells.history.value.undo === `Add ${name}`) project.undo();
        else project.edit(`Remove ${name}`, () => project.removeDevice(device.id));
        await this.flush().catch(() => undefined);
      }
      throw error;
    }
    if (!present()) throw new Error("Workspace device was removed before it finished loading.");
    // The stored device now carries the parameter table the running plug-in reported.
    return project.tracks.flatMap((track) => track.devices).find((item) => item.id === device.id) ?? device;
  }

  /**
   * File > New and File > Open in place: replace the song with a `.dawproject` file (bytes, Blob or File) or with a `Project` you made (an empty or in-memory song), and keep this
   * Workspace, its `cells`, `loop` and every subscription. Everything is loaded off to the side first (a file is read; devices, plug-in states and instruments are loaded), so a bad file or
   * song rejects with the error `openWorkspace` or `Workspace.create` would throw and the current song plays on untouched until the new one is ready.
   * On success playback stops at 0, `project` becomes the new Project, `cells.warnings` hold the new file's, `cells.needsSync` and `cells.error` clear, `cells.session` is rebuilt and the loop is cleared (region off: its beats belong to the old song).
   * `options` entries replace the workspace's own for this song and later syncs.
   * Ownership: a song read from a file belongs to this Workspace. A `Project` you pass belongs to you, as with `Workspace.create`, unless `options.ownsProject` is true, and then the Workspace
   * takes it over once the call succeeds and disposes it when it is replaced or the Workspace is disposed. A call that rejects leaves your `Project` alone, whatever `ownsProject` says.
   * The Workspace disposes the Project it replaces only if it owned it. Passing the Project already open throws; call `sync()` to rebuild it.
   * Edits made to the new `Project` while it loads are applied after the swap: light edits (clips, mixer, tempo) play at once, a new or removed track sets `cells.needsSync`.
   */
  async open(source: WorkspaceSource | Project, options: WorkspaceOpenOptions = {}): Promise<void> {
    if (this.disposed) throw new Error("Workspace is disposed.");
    if (source instanceof Project) {
      if (source === untracked(() => this.project))
        throw new Error("Workspace open needs a Project other than the one already open; call sync() to rebuild it.");
      return this.serialize(() => this.swapSong({ project: source, warnings: [] }, options, options.ownsProject === true, false));
    }
    const parse = songParser();
    if (!parse) throw new Error("Workspace open needs the @audiorective/daw root entry: import it once so the file reader is registered.");
    const opened = await parse(source, this.context);
    return this.serialize(() => this.swapSong(opened, options, true, true));
  }

  private async swapSong(
    opened: Readonly<{ project: Project; warnings: readonly string[] }>,
    options: WorkspaceOpenOptions,
    owns: boolean,
    /** A song this call read from a file is nobody else's: a failure disposes it. A `Project` the caller passed is theirs again. */
    disposeOnFailure: boolean,
  ): Promise<void> {
    const project = opened.project;
    const warnings = [...opened.warnings, ...(options.warnings ?? [])];
    const { warnings: _creationWarnings, ownsProject: _ownership, ...given } = options;
    const stage: TrackStage = {
      project,
      options: { ...this.options, ...Object.fromEntries(Object.entries(given).filter(([, value]) => value !== undefined)) },
      warn: (message) => warnings.push(message),
      loaded: new Map(),
    };
    const built = new Map<string, TrackRuntime>();
    let builtRevision = 0;
    try {
      await renderOpenedStretches(project, stage.options.stretch, stage.warn, () => this.disposed);
      // What the tracks below are built from: an edit after this point is applied once the song is swapped in.
      builtRevision = untracked(() => project.cells.revision.value);
      for (const track of project.tracks) {
        const runtime = await this.createTrack(track, stage);
        built.set(track.id, runtime);
        if (this.disposed) throw new Error("Workspace is disposed.");
      }
    } catch (error) {
      for (const runtime of built.values()) this.disposeTrack(runtime);
      if (disposeOnFailure) project.dispose();
      throw error;
    }
    // Everything is ready: no await from here, so the swap is one step.
    this.stop();
    this.audition.stop();
    this.stretch.abortAll();
    const old = this.ownedProject;
    batch(() => {
      this.disposeTracks();
      for (const [id, runtime] of built) this.tracks.set(id, runtime);
      this.options = stage.options;
      for (const [id, urls] of stage.loaded) {
        if (!this.loadedBundles.has(id)) this.loadedBundles.set(id, new Set());
        for (const url of urls) this.loadedBundles.get(id)!.add(url);
      }
      this.ownedProject = owns ? project : undefined;
      this.projectSource.value = project;
      this.appliedProject = project;
      this.appliedRevision = builtRevision;
      this.activeTempoMap = project.tempoMap;
      this.clock.meter.value = [...project.signature];
      // A track the Project gained while this loaded has no runtime yet: routing wires the ones built, and the edit applied after the swap reports the rest.
      const wired = (id: string | null) => id === null || built.has(id);
      this.mixer.applyRouting(
        project.tracks.filter(({ id, routing }) => built.has(id) && wired(routing.outputBusId) && routing.sends.every(({ busId }) => wired(busId))),
      );
      this.mixer.applyMixer();
      this.sessionRevision.value++;
      this.sessionClipEdits.value++;
      this.bindNotes();
      this.loop.setRegion(null);
      this.seek(0);
      this.stop();
      this.warningMessages.value = Object.freeze(warnings);
      this.mediaError.value = null;
      this.applicationError.value = null;
      this.failedApplication = undefined;
      this.topologyPending.value = false;
    });
    old?.dispose();
    if (!this.isCurrentProject()) this.scheduleProjectEdit();
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

  private liveStage(): TrackStage {
    return { project: this.project, options: this.options, warn: (message) => this.warn(message), loaded: this.loadedBundles };
  }

  /** Load a device's plug-in and restore its state; a bundle that cannot load is a warning and no host. */
  private async loadDeviceHost(device: WebClapDevice, stage: TrackStage): Promise<WebClapHost | undefined> {
    const bundleUrl = stage.options.resolveBundle
      ? await stage.options.resolveBundle(device)
      : importedBundles.get(stage.project)?.has(device.id)
        ? undefined
        : device.bundleUrl;
    if (!bundleUrl) {
      stage.warn(`Device ${device.name} has no WebCLAP bundle.`);
      return undefined;
    }
    let host: WebClapHost | undefined;
    try {
      host = await WebClapHost.load(this.context, { url: bundleUrl, pluginId: device.pluginId, workletUrl: stage.options.workletUrl });
      if (host.descriptor?.id !== device.pluginId) {
        host.dispose();
        stage.warn(`Device ${device.name} has a different CLAP ID in its bundle.`);
        return undefined;
      }
      if (!stage.loaded.has(device.pluginId)) stage.loaded.set(device.pluginId, new Set());
      stage.loaded.get(device.pluginId)!.add(bundleUrl);
      if (device.state.length) await host.loadState(device.state);
      this.reconcileParameters(stage.project, device, host);
      return host;
    } catch (error) {
      host?.dispose();
      stage.warn(`Device ${device.name} could not load: ${String(error)}`);
      return undefined;
    }
  }

  /**
   * The parameter table of a loaded plug-in against what the plug-in reports. The table is the authority: its values are written into the plug-in (after its state loaded, so a table
   * wins over the values inside the state bytes). A table that is empty or describes other parameters (a new plug-in version, a state replaced with `setDeviceState`) is made again
   * from the plug-in's report, keeping the values it already had for parameters that still exist, and stored in the Project without an Undo step.
   */
  private reconcileParameters(project: Project, device: WebClapDevice, host: WebClapHost): void {
    const infos = host.parameterInfo;
    const stored = device.parameters;
    const same =
      stored.length === infos.length &&
      !stored.some((record) => record.normalized) &&
      infos.every((info, index) => {
        const record = stored[index];
        return (
          record.id === String(info.id) &&
          record.name === info.name &&
          record.min === info.min &&
          record.max === info.max &&
          record.default === info.defaultValue &&
          record.step === info.step
        );
      });
    const table = same ? stored : hostTable(host, stored);
    for (const record of table) {
      const param = host.param(record.id);
      if (param && param.value !== record.value) param.value = record.value;
    }
    if (!same) this.captureTable(project, device.id, table);
  }

  /** Stores a parameter table in the Project as a capture (no Undo step, no new version). A table the Project cannot hold (a name with characters XML cannot carry) stays out. */
  private captureTable(project: Project, deviceId: string, table: readonly DeviceParameterRecord[]): void {
    const store = () => {
      try {
        captureDeviceParameters(project, deviceId, table);
      } catch (error) {
        this.warn(`Device parameters of ${deviceId} could not be stored: ${String(error)}`);
      }
    };
    if (project === this.project) this.reflectProjectEdit(store);
    else store();
  }

  /** Starts keeping a live device's parameter table equal to what its plug-in reports. */
  private linkDevice(runtime: TrackRuntime, project: Project, deviceId: string, host: WebClapHost): void {
    runtime.links.get(deviceId)?.dispose();
    runtime.links.set(
      deviceId,
      new DeviceParameterLink(host, (moved) => {
        if (this.disposed) return;
        const device = project.tracks.flatMap((track) => track.devices).find((item) => item.id === deviceId);
        if (!device) return;
        const table = device.parameters.map((record) => {
          const value = moved.get(record.id);
          return value === undefined || value < record.min || value > record.max ? record : { ...record, value };
        });
        this.captureTable(project, deviceId, table);
      }),
    );
  }

  /** Writes the song's parameter values into every running plug-in that does not hold them yet; a parameter edit, Undo or Redo reaches the sound here without a rebuild. */
  private applyDeviceParameters(tracks: readonly ProjectTrack[]): void {
    for (const track of tracks) {
      const runtime = this.tracks.get(track.id);
      if (runtime) for (const device of track.devices) runtime.links.get(device.id)?.apply(device.parameters);
    }
  }

  /** Connect the track's input through its hosts, in order, to its rack. Reconnects a chain that is already wired. */
  /**
   * Connect the track input through its devices into the rack, behind a gate of its own. With `fade` (a live change) the previous chain stays connected
   * while the new gate fades in and the old one out over `chainFadeSeconds`; the old edges are removed afterwards, and `later` tells the caller when.
   */
  private wireDevices(runtime: TrackRuntime, fade = false, widths?: { before: 1 | 2 | undefined; after: 1 | 2 | undefined }): void {
    const old = runtime.chain;
    const gate = this.context.createGain();
    const edges: Array<readonly [AudioNode, AudioNode]> = [];
    const link = (from: AudioNode, to: AudioNode) => {
      from.connect(to);
      edges.push([from, to]);
    };
    let previous: AudioNode = runtime.input;
    for (const host of runtime.hosts.values()) {
      link(previous, host.input);
      previous = host.output;
    }
    link(previous, gate);
    runtime.chain = { gate, edges };
    // A live change connects the new chain silent; the gate fades in when the crossfade begins.
    if (fade && old) gate.gain.value = 0;
    // The channel pans a mono input with the mono law and a stereo one with the stereo law, and follows the widest connection, so connecting a stereo chain
    // to a mono track would step its level in whatever render quantum the edit lands in. A track that changes width crosses between two ways into the strip
    // (`WidthPath`) with scheduled gains instead, so no graph edit is ever heard.
    const flip = fade && !!old && !!widths && !!widths.before && !!widths.after && widths.before !== widths.after;
    const path = flip ? this.widthPathOf(runtime) : undefined;
    const handled = path && !path.busy;
    // From mono to stereo the strip's own input is held mono while the stereo chain connects (its signal is mono, so nothing changes).
    if (handled && widths?.after === 2 && path.mode === "natural") path.pinInput(true);
    gate.connect(runtime.rack.input);
    if (!old) return;
    const keep = (edge: readonly [AudioNode, AudioNode]) => edges.some(([from, to]) => from === edge[0] && to === edge[1]);
    const release = () => {
      for (const edge of old.edges)
        if (!keep(edge)) {
          try {
            edge[0].disconnect(edge[1]);
          } catch {
            // already disconnected
          }
        }
      old.gate.disconnect();
    };
    if (!fade) return release();
    const crossfade = () => {
      // Re-read the clock right before scheduling, so a slow main thread moves the start forward instead of putting events in the past.
      const at = this.context.currentTime + chainLead;
      gate.gain.cancelScheduledValues(at);
      gate.gain.setValueAtTime(0, at);
      gate.gain.linearRampToValueAtTime(1, at + chainFadeSeconds);
      old.gate.gain.cancelScheduledValues(at);
      old.gate.gain.setValueAtTime(old.gate.gain.value, at);
      old.gate.gain.linearRampToValueAtTime(0, at + chainFadeSeconds);
      return at;
    };
    const settle = (work: () => void) => this.afterAudio(chainLead + chainFadeSeconds + 0.04, work);
    if (!handled) {
      crossfade();
      settle(release);
    } else if (widths?.after === 2) {
      // Mono to stereo: the sound moves to the stereo path while the chains cross; the strip's own input is let go once it is silent.
      path.busy = true;
      path.toStereo(crossfade(), chainFadeSeconds);
      settle(() => {
        release();
        path.pinInput(false);
        path.busy = false;
      });
    } else {
      // Stereo to mono: first the sound moves to the stereo path (the same law, so nothing changes), then the strip's own input is made mono while silent,
      // and the chains cross as the sound moves back to it.
      path.busy = true;
      const back = () => {
        path.pinInput(true);
        path.toNatural(crossfade(), chainFadeSeconds);
        settle(() => {
          release();
          path.busy = false;
          // The old stereo chain's edges may leave a render quantum after `release`; the strip's input stays mono, which is what it carries, until they are gone.
          this.afterAudio(0.06, () => {
            if (!path.busy && path.mode === "natural") path.pinInput(false);
          });
        });
      };
      if (path.mode === "natural") {
        path.toStereo(this.context.currentTime + chainLead, chainFadeSeconds);
        settle(back);
      } else back();
    }
  }

  /**
   * How many channels reach the track's strip: 2 when a plug-in or a rack effect is on the track, otherwise the width of its sources. An audio track's
   * is read from its clips; any other track's (an instrument sound, a bus) was measured in the graph (`runtime.sourceWidth`, undefined until it has been).
   */
  private channelWidth(runtime: TrackRuntime, track: ProjectTrack): 1 | 2 | undefined {
    if (runtime.hosts.size > 0 || runtime.rack.effects.length > 0) return 2;
    // Not measured (nothing was sounding): taken as mono, which is inaudible to get wrong while nothing sounds and is what the plain strip does today.
    if (track.kind !== "audio") return runtime.sourceWidth ?? 1;
    return track.clips.some((clip) => clip.kind === "audio" && audioChannelCount(clip) > 1) ? 2 : 1;
  }

  /** The track's stereo path, built on first use; undefined when this context cannot build it (the switch then plays the plain crossfade). */
  private widthPathOf(runtime: TrackRuntime): WidthPath | undefined {
    try {
      return (runtime.widthPath ??= new WidthPath(this.context, runtime.automationGain, runtime.channel));
    } catch {
      return undefined;
    }
  }

  /** Run `work` once the audio clock has advanced `seconds`: a fade is measured on that clock, which falls behind the wall clock when the machine is busy. */
  private afterAudio(seconds: number, work: () => void): void {
    const until = this.context.currentTime + seconds;
    const poll = () => {
      if (this.disposed || this.context.currentTime >= until) work();
      else this.later(10, poll);
    };
    this.later(10, poll);
  }

  /** Run `work` after `ms`, or at once when the Workspace is disposed first, so nothing waits on a timer that will never matter. */
  private later(ms: number, work: () => void): () => void {
    const run = () => {
      this.pending.delete(run);
      clearTimeout(timer);
      work();
    };
    const timer = setTimeout(run, ms);
    this.pending.add(run);
    return run;
  }

  /** Where a MIDI track plays: its first loaded device, or without devices its `instruments` sampler. */
  private pointMidi(runtime: TrackRuntime, track: ProjectTrack, instruments: WorkspaceOptions["instruments"], fade = false): void {
    // A sampler that goes keeps sounding into the old chain's gate while it fades out.
    const drop = (sampler: Sampler) => (fade ? this.afterAudio(chainLead + chainFadeSeconds + 0.03, () => sampler.dispose()) : sampler.dispose());
    if (track.kind !== "midi") return;
    const first = runtime.hosts.values().next().value;
    if (first) {
      if (runtime.sampler) {
        runtime.midi?.allNotesOff();
        drop(runtime.sampler);
        runtime.sampler = undefined;
      }
      runtime.midi = first;
      return;
    }
    if (runtime.midi && !runtime.sampler) runtime.midi = undefined;
    const instrument = track.devices.length ? undefined : typeof instruments === "function" ? instruments(track) : instruments?.[track.id];
    if (!instrument) {
      if (runtime.sampler) {
        runtime.midi?.allNotesOff();
        drop(runtime.sampler);
        runtime.sampler = undefined;
        runtime.midi = undefined;
      }
      return;
    }
    if (runtime.sampler) return;
    runtime.sampler = new Sampler(this.context, instrument);
    runtime.sampler.connect(runtime.chain!.gate);
    runtime.midi = new SamplerSink(runtime.sampler, this.context);
  }

  private async createTrack(track: ProjectTrack, stage: TrackStage = this.liveStage()): Promise<TrackRuntime> {
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
    // The track's own input: whatever feeds the track connects here, and the devices are spliced in behind it.
    const input = this.context.createGain();
    const runtime: TrackRuntime = {
      kind: track.kind,
      clips: track.clips,
      controllerLanes: track.controllerLanes,
      deviceKeys: deviceKeys(track),
      deviceStates: new Map(track.devices.map((device) => [device.id, device.state])),
      links: new Map(),
      channel: strip.channel,
      automationGain,
      rack,
      effectSettings: track.effects,
      macroSettings: track.effectMacros,
      sendName: strip.sendName,
      sends: new Map(),
      input,
      hosts: new Map(),
    };
    try {
      runtime.rack.output.connect(automationGain);
      for (const device of track.devices) {
        const host = await this.loadDeviceHost(device, stage);
        if (host) {
          runtime.hosts.set(device.id, host);
          this.linkDevice(runtime, stage.project, device.id, host);
        }
      }
      this.wireDevices(runtime);
      this.pointMidi(runtime, track, stage.options.instruments);
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
   * Make a live track's chain match `track.devices` without stopping anything: devices that went are disposed (their last state is kept for Redo),
   * new ones are loaded off to the side, then the new chain is wired in one synchronous step behind a gate that fades in over the old chain's (25 ms), and the old
   * devices are disposed after the fade. A device that leaves still sounds during the fade, except its held notes, which end at the swap.
   */
  private async applyDevices(project: Project, track: ProjectTrack, runtime: TrackRuntime): Promise<void> {
    const keys = deviceKeys(track);
    const before = new Map(runtime.deviceKeys.map((key) => [key.slice(0, key.indexOf("\u0000")), key] as const));
    const stays = new Set(track.devices.filter((device, index) => before.get(device.id) === keys[index]).map((device) => device.id));
    const leaving = [...runtime.hosts].filter(([id]) => !stays.has(id));
    // A device the Project no longer has keeps its last state in the history steps that can bring it back.
    for (const [id, host] of leaving) {
      if (track.devices.some((device) => device.id === id)) continue;
      try {
        const state = await host.saveState();
        if (!this.disposed) captureDeviceState(project, id, state, hostTable(host, []));
      } catch {
        // The device then comes back with the state its step recorded.
      }
    }
    const loaded = new Map<string, WebClapHost>();
    for (const device of track.devices) {
      if (stays.has(device.id)) continue;
      const host = await this.loadDeviceHost(device, this.liveStage());
      if (host) loaded.set(device.id, host);
    }
    if (this.disposed) {
      for (const host of loaded.values()) host.dispose();
      return;
    }
    // A track whose sources the project does not describe (an instrument sound, a bus) is asked what it carries before the swap, while the old chain still plays.
    if (track.kind !== "audio" && runtime.hosts.size === 0) {
      const measured = await probeWidth(this.context, runtime.sampler?.output ?? runtime.input);
      if (measured) runtime.sourceWidth = measured;
    }
    if (this.disposed) {
      for (const host of loaded.values()) host.dispose();
      return;
    }
    // From here no await: the swap is one step.
    const midi = runtime.midi;
    const fade = !isOfflineContext(this.context);
    const widthBefore = this.channelWidth(runtime, track);
    for (const [id, host] of leaving) {
      host.allNotesOff();
      runtime.links.get(id)?.dispose();
      runtime.links.delete(id);
      // The old chain keeps running while the new one fades in; the device is disposed once the old chain is gone.
      if (fade) this.afterAudio(chainLead + chainFadeSeconds + 0.06, () => host.dispose());
      else host.dispose();
      runtime.hosts.delete(id);
      runtime.deviceStates.delete(id);
    }
    const hosts = new Map<string, WebClapHost>();
    for (const device of track.devices) {
      const host = loaded.get(device.id) ?? runtime.hosts.get(device.id);
      if (!host) continue;
      hosts.set(device.id, host);
      if (loaded.has(device.id)) {
        runtime.deviceStates.set(device.id, device.state);
        this.linkDevice(runtime, project, device.id, host);
      }
    }
    runtime.hosts = hosts;
    runtime.deviceKeys = keys;
    this.wireDevices(runtime, fade, { before: widthBefore, after: this.channelWidth(runtime, track) });
    this.pointMidi(runtime, track, this.options.instruments, fade);
    if (runtime.midi !== midi) {
      // The track plays into another device now: sounding notes end, and its Session clips are rebuilt for the new one.
      midi?.allNotesOff();
      const slots = this.sessionLauncher?.tracks[track.id];
      if (slots) for (const clip of slots.clips) if (clip) this.sessionSources.delete(clip);
    }
    if (this.clock.state.value === "playing") void this.clock.refresh();
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
        return runtime.kind === track.kind;
      });
    if (!compatible) {
      // A track-list change waits for sync(), but the mixer and rack of the tracks that are live keep following the Project, as a fader should.
      this.mixer.applyMixer();
      for (const track of tracks) {
        const runtime = this.tracks.get(track.id);
        if (runtime?.kind === track.kind) updateRack(runtime, track);
      }
      this.applyDeviceParameters(tracks);
      this.topologyPending.value = true;
      return;
    }
    // Devices added, removed or moved on a track that stays are spliced into that track's chain; the other tracks play on.
    for (const track of tracks) {
      const runtime = this.tracks.get(track.id);
      if (!runtime) continue;
      const keys = deviceKeys(track);
      if (runtime.deviceKeys.length === keys.length && runtime.deviceKeys.every((key, index) => key === keys[index])) continue;
      await this.applyDevices(project, track, runtime);
      if (this.disposed) return;
    }

    for (const track of tracks) {
      const runtime = this.tracks.get(track.id);
      if (!runtime) continue;
      for (const device of track.devices) {
        if (runtime.deviceStates.get(device.id) === device.state) continue;
        const host = runtime.hosts.get(device.id);
        if (host && device.state.length) await host.loadState(device.state);
        if (this.disposed) return;
        runtime.deviceStates.set(device.id, device.state);
        if (host) {
          // The state brought its own parameter values: the table (or, when the state replaced it, the plug-in's report) decides again.
          this.reconcileParameters(project, device, host);
          runtime.links
            .get(device.id)
            ?.apply(project.tracks.flatMap((item) => item.devices).find((item) => item.id === device.id)?.parameters ?? [], true);
        }
        if (this.project !== project || project.tracks !== tracks) return this.applyLight();
      }
    }
    this.applyDeviceParameters(tracks);

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
    const [numerator, denominator] = project.signature;
    // Bars the clock counts (quantized launches, "1m") follow the starting signature; later changes are in the Project's meter map.
    if (this.clock.meter.value[0] !== numerator || this.clock.meter.value[1] !== denominator) this.clock.meter.value = [numerator, denominator];
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
      if (runtime.controllerLanes !== track.controllerLanes) {
        runtime.controllerLanes = track.controllerLanes;
        // The messages already queued came from the old lanes: refill the look-ahead from the new ones.
        refreshClips = true;
      }
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
    return index < 0 ? null : (this.cells.session.value.tracks[trackId]?.clips[index] ?? null);
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
        // A track returning to the Arrangement (a stop, or the end of a one-shot) is brought to the controller state the Arrangement needs at that position.
        const backAt = clip === null ? when : endsAt;
        const chased =
          backAt !== null && this.clock.state.value === "playing" && untracked(() => this.arrangement.value)
            ? this.scheduler.handBack(runtime, backAt, this.fold.toBeat(this.timeline.timeToBeat(backAt)))
            : [];
        void this.clock.refresh();
        const withdraw = () => {
          for (const release of [...releases, ...chased]) release.cancel();
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
      const scheduler = sessionNotes(this.project, clip, trackId, host);
      const [numerator, denominator] = this.project.signature;
      // Every pass plays one stretch of the content: the clip's window, or its loop (the lead-in before a loop is arrangement-only).
      const beats = sessionWindow(clip).length;
      return { scheduler, loop: true, length: `${beats / ((numerator * 4) / denominator)}m`, name: clip.id };
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
    // Slots follow the scenes in place, so clips in other scenes keep playing: removed scenes first (last to first), then the others into place, inserted or moved.
    for (let index = known.length - 1; index >= 0; index--)
      if (!wanted.includes(known[index])) {
        launcher.removeScene(index);
        known.splice(index, 1);
      }
    wanted.forEach((id, index) => {
      if (known[index] === id) return;
      const from = known.indexOf(id);
      if (from < 0) launcher.insertScene(index, { name: scenes[index].name });
      else {
        launcher.moveScene(from, index);
        known.splice(from, 1);
      }
      known.splice(index, 0, id);
    });
    scenes.forEach(({ name }, index) => launcher.scenes[index].rename(name));
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

  /** Start or resume playback from `position` (starts the audio context if needed) and resolve once it is running; does nothing if already playing. */
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
    this.scheduler.armSeekFade(when);
    this.clock.start(when, beat);
    this.positionAutomation(position, true, when);
    return this.clock.refresh();
  }
  /** Stop the sound and keep `position` where it is, so `play()` continues from there. */
  pause(): void {
    this.playRequest++;
    this.resumingSeek = false;
    untracked(() => this.positionAutomation(this.position, false));
    this.clock.pause();
    this.cancelAudio();
    this.allNotesOff();
  }
  /** Stop the sound and put `position` back at 0. */
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
  /** Move `position` to `seconds` (project seconds, 0 or more; else a RangeError). Playback, if running, carries on from there. */
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
    this.allNotesOff(false);
    this.cancelAudio(playing);
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
        let endAll = false;
        for (const clip of runtime.clips) {
          if (!(clip instanceof MidiClip)) continue;
          const time = this.midiClipPositions.get(clip) ?? clip.time;
          if (!(time <= beat && beat <= time + clip.duration) || (next.has(clip) && clip.time === time)) continue;
          // A clip that left or loops plays through its pass bookkeeping: everything ends. A clip that only moved keeps the notes it still covers.
          if (!next.has(clip) || clip.loop) endAll = true;
          else this.carryMovedNotes(runtime, clip, time, beat);
        }
        if (endAll) runtime.midi.allNotesOff();
      }
      return true;
    }
    if (collectGainAutomationEdits(runtime.clips, clips, gainEdits)) return false;
    const next = new Set(clips);
    for (const clip of runtime.clips) if (clip.kind === "audio" && !next.has(clip)) invalidatedAudio.add(clip.id);
    return true;
  }

  /**
   * `clip` moved from `from` to its current time while it plays. A note that sounds at `beat` before and after the move, at the same pitch and channel,
   * keeps sounding (the refresh that follows queues its release where the moved note ends); a sounding note the new place no longer covers ends with its
   * normal release, and a note the new place covers that did not sound before starts now with its own velocity.
   */
  private carryMovedNotes(track: TrackRuntime, clip: MidiClip, from: number, beat: number): void {
    if (!track.midi) return;
    const notes = untracked(() => clip.midi.notes.value);
    const sounding = (time: number) =>
      notes.filter((note) => {
        const start = Math.max(time, time + note.start - clip.sourceOffset);
        return start <= beat && beat < Math.min(time + clip.duration, time + note.start - clip.sourceOffset + note.duration);
      });
    const key = (note: MidiNote) => `${note.channel}:${note.pitch}`;
    const before = sounding(from);
    const after = sounding(clip.time);
    const kept = new Set(after.map(key));
    const was = new Set(before.map(key));
    for (const note of before) if (!kept.has(key(note))) track.midi.scheduleMidi([0x80 | note.channel, note.pitch, 0], this.context.currentTime);
    for (const note of after)
      if (!was.has(key(note))) track.midi.scheduleMidi([0x90 | note.channel, note.pitch, midiVelocityByte(note.velocity)], this.context.currentTime);
  }

  /** End the notes of `clip` that sound at `beat` and that an edit moved, re-pitched or removed, or shortened to before `beat`. */
  private releaseEditedNotes(track: TrackRuntime, clip: MidiClip, previous: readonly MidiNote[], next: readonly MidiNote[], beat: number): void {
    if (!track.midi) return;
    const byId = new Map(next.map((note) => [note.id, note]));
    for (const note of previous) {
      const start = clip.time + note.start - clip.sourceOffset;
      if (!(start <= beat && beat < start + note.duration)) continue;
      const edited = byId.get(note.id);
      if (edited && edited.pitch === note.pitch && edited.channel === note.channel && edited.start === note.start && start + edited.duration > beat)
        continue;
      track.midi.scheduleMidi([0x80 | note.channel, note.pitch, 0], this.context.currentTime);
    }
    // A note the edit made sound at `beat` (re-pitched, moved or lengthened over the playhead) starts now with its own velocity; the refresh
    // that follows queues its release, and only schedules note-ons that lie ahead.
    const before = new Map(previous.map((note) => [note.id, note]));
    const end = clip.time + clip.duration;
    for (const note of next) {
      const start = Math.max(clip.time, clip.time + note.start - clip.sourceOffset);
      if (!(start <= beat && beat < Math.min(end, clip.time + note.start - clip.sourceOffset + note.duration))) continue;
      const old = before.get(note.id);
      if (old && old.pitch === note.pitch && old.channel === note.channel && old.start === note.start) {
        const oldStart = clip.time + old.start - clip.sourceOffset;
        if (oldStart <= beat && beat < oldStart + old.duration) continue;
      }
      track.midi.scheduleMidi([0x90 | note.channel, note.pitch, midiVelocityByte(note.velocity)], this.context.currentTime);
    }
  }

  private bindNotes(): void {
    for (const off of this.noteOff.splice(0)) off();
    for (const track of this.tracks.values()) {
      for (const clip of track.clips) {
        if (!(clip instanceof MidiClip)) continue;
        this.midiClipPositions.set(clip, clip.time);
        this.noteSnapshots.set(
          clip,
          untracked(() => clip.midi.notes.value),
        );
        this.noteOff.push(
          clip.midi.revision.subscribe(() => {
            const previous = this.noteSnapshots.get(clip) ?? [];
            const next = untracked(() => clip.midi.notes.value);
            this.noteSnapshots.set(clip, next);
            if (this.clock.state.value !== "playing") return;
            const beat = this.fold.toBeat(this.timeline.timeToBeat(this.context.currentTime));
            if (clip.time <= beat && beat <= clip.time + clip.duration) {
              // A looped clip plays through its pass bookkeeping: end everything there. Otherwise only the sounding notes the edit changed or removed end,
              // and the refresh below re-queues the rest, so a held note an edit did not touch keeps sounding.
              if (clip.loop) track.midi?.allNotesOff();
              else this.releaseEditedNotes(track, clip, previous, next, beat);
            }
            void this.clock.refresh();
          }),
        );
      }
    }
  }

  /** The current position (0 to 1) of a track's macro as a readable value, or `undefined` for an unknown track or macro. Write it with `project.setTrackMacroValue`. */
  trackMacroValue(trackId: string, macroId: string): Readable<number> | undefined {
    return this.tracks.get(trackId)?.rack.macro(macroId)?.param;
  }

  /** The macro's native automation target for an `AutomationBinding`: the normalized curve fans out to every mapped parameter on the audio thread. */
  trackMacroAutomation(trackId: string, macroId: string): AutomationTarget | undefined {
    return this.tracks.get(trackId)?.rack.macro(macroId)?.automation;
  }

  /** Borrow the post-insert, pre-mixer output for an analyser or display. */
  trackEffectOutput(trackId: string): AudioNode | undefined {
    return this.tracks.get(trackId)?.rack.output;
  }

  /**
   * Fill `magnitudes` (linear gain) and `phases` (radians) with the response of one Filter or EQ slot of a track at `frequencies` (Hz, all the arrays the same length).
   * Returns `false`, leaving them untouched, for an unknown track or slot and for a Delay slot.
   */
  trackFilterResponse(
    trackId: string,
    slotId: string,
    frequencies: Float32Array<ArrayBuffer>,
    magnitudes: Float32Array<ArrayBuffer>,
    phases: Float32Array<ArrayBuffer>,
  ): boolean {
    return this.tracks.get(trackId)?.rack.readFilterResponse(slotId, frequencies, magnitudes, phases) ?? false;
  }

  /** Borrow a post-fader track output for the mixer's meter, or use output for the master meter. */
  trackMixerOutput(trackId: string): AudioNode | undefined {
    return this.mixer.tap(trackId);
  }

  /**
   * The parameters of a device, one row shape for a WebCLAP plug-in (its device ID) and a built-in rack effect (`rackDeviceId(trackId, slotId)`): `id`, `name`, `min`, `max`,
   * `default`, `value` and, where known, `unit`, `step` and the display `text`. The values are the song's (the Project's), which a running plug-in keeps equal to what it reports;
   * `text` is the plug-in's own display string and appears while it matches `value`. Tracked: an effect that reads it re-runs when a value changes. Change one with
   * `project.setDeviceParameter(deviceId, row.id, value)`. Throws for an unknown device. A WebCLAP device that no Workspace has loaded yet has no rows.
   */
  deviceParameters(deviceId: string): readonly DeviceParameter[] {
    const tracks = this.project.tracks;
    const device = tracks.flatMap((track) => track.devices).find((item) => item.id === deviceId);
    if (device) {
      const info = this.host(deviceId)?.parameterInfo;
      return tableParameters(device.parameters, (id) => {
        const reported = info?.find((item) => String(item.id) === id);
        const record = device.parameters.find((item) => item.id === id);
        return reported && record && reported.value === record.value ? reported.text : undefined;
      });
    }
    const at = splitRackDeviceId(deviceId);
    const slot = at && tracks.find((track) => track.id === at.trackId)?.effects.find((item) => item.id === at.slotId);
    if (!slot) throw new Error(`Workspace device "${deviceId}" does not exist; a built-in effect is addressed as "trackId:slotId".`);
    return rackSlotParameters(slot);
  }

  /** The plug-in host of a WebCLAP device by its device ID, or `undefined` when no running track has it (before `sync()`, after removal). */
  host(deviceId: string): WebClapHost | undefined {
    for (const track of this.tracks.values()) {
      const host = track.hosts.get(deviceId);
      if (host) return host;
    }
    return undefined;
  }

  /**
   * Audition the current audio clip through master output independently of Arrangement, replacing any running audition.
   * With `range` it plays that part of the clip's whole recording instead (`project.clipRecording(clipId)`), in recording seconds, raw:
   * clip fades, gain automation, stretch and loop do not apply, and the range may reach outside the clip's window. It must satisfy
   * `0 <= start < end <= recording duration`, else a RangeError.
   */
  auditionAudioClip(clipId: string, options: { range?: { start: number; end: number } } = {}): Promise<void> {
    return this.audition.auditionClip(clipId, options);
  }

  /** Stop a running `auditionAudioClip`; does nothing when none plays. */
  stopClipAudition(): void {
    this.audition.stopClip();
  }

  /** Repeat one project-second range over a group of audio tracks, independently of Arrangement. */
  auditionRange(range: LoopRange, options: { trackIds?: readonly string[] } = {}): Promise<void> {
    return this.audition.auditionRange(range, options);
  }

  /** Stop a running `auditionRange`; does nothing when none plays. */
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
    if (on) this.scheduler.requestChase();
    if (!on) {
      this.cancelAudio();
      const now = this.context.currentTime;
      for (const track of this.tracks.values()) if (!track.session?.playingAt(now)) track.midi?.allNotesOff();
    }
    void this.clock.refresh();
  }

  /**
   * Silence every held note. A stop or a pause (`reset`) then puts the pedal, bend and the other performance controllers playback moved back to rest, so nothing
   * is left sounding or stuck down. A seek does not: the run that follows chases its position and sends only what differs from where the device is.
   */
  private allNotesOff(reset = true): void {
    for (const track of this.tracks.values()) {
      for (const host of track.hosts.values()) host.allNotesOff();
      if (track.sampler) track.midi?.allNotesOff();
    }
    if (this.disposing) return;
    if (reset) this.scheduler.resetControllers(this.context.currentTime);
    else this.scheduler.forgetPedals();
  }

  private cancelAudio(crossfade = false): void {
    this.scheduler.cancelAudio(undefined, crossfade);
  }

  private disposeTrack(runtime: TrackRuntime): void {
    runtime.session?.dispose();
    runtime.rack.dispose();
    for (const link of runtime.links.values()) link.dispose();
    for (const host of runtime.hosts.values()) host.dispose();
    runtime.sampler?.dispose();
    runtime.automationBinding?.dispose();
    runtime.widthPath?.dispose();
    runtime.automationGain.disconnect();
    runtime.input.disconnect();
    runtime.chain?.gate.disconnect();
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
    // The devices go with the Workspace: there is nothing left to reset.
    this.disposing = true;
    this.stop();
    this.disposed = true;
    for (const run of [...this.pending]) run();
    this.audition.stop();
    this.stretch.abortAll();
    this.clock.dispose();
    this.levelMeters.dispose();
    this.disposeTracks();
    this.output.disconnect();
    this.ownedProject?.dispose();
    this.ownedProject = undefined;
  }
}

/** A device's parameter table from a running plug-in's report: ranges and defaults from the plug-in, values from `stored` where it still has the parameter (and the value is inside the range), else the plug-in's own. */
function hostTable(host: WebClapHost, stored: readonly DeviceParameterRecord[]): readonly DeviceParameterRecord[] {
  return host.parameterInfo.map((info) => {
    const id = String(info.id);
    const record = stored.find((item) => item.id === id);
    const live = host.param(info.id)?.value ?? info.value;
    // A row from another application's `unit="normalized"` is a fraction of this plug-in's range.
    const mapped = record?.normalized ? info.min + record.value * (info.max - info.min) : undefined;
    const wanted = (info.step === 1 && mapped !== undefined ? Math.round(mapped) : mapped) ?? record?.value ?? live;
    return {
      id,
      name: xmlSafe(info.name),
      min: info.min,
      max: info.max,
      default: info.defaultValue,
      value: Math.min(info.max, Math.max(info.min, wanted)),
      ...(info.step === 1 ? { step: 1 as const } : {}),
    };
  });
}

/** `text` with every character XML 1.0 cannot carry (control characters, unpaired surrogates, U+FFFE and U+FFFF) replaced by `?`, so a plug-in's parameter name always fits the project file. */
function xmlSafe(text: string): string {
  return Array.from(text, (char) => {
    const code = char.codePointAt(0)!;
    return code === 0x9 || code === 0xa || code === 0xd || (code >= 0x20 && code <= 0xd7ff) || (code >= 0xe000 && code <= 0xfffd) || code >= 0x10000
      ? char
      : "?";
  }).join("");
}
