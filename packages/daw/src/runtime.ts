import { Clock, Timeline } from "@audiorective/clock";
import type { LoopRange, TickWindow } from "@audiorective/clock";
import { batch, cell, effect, readonlyCell, untracked, type Cell, type Readable, type ReadonlyCell } from "@audiorective/core";
import { AutomationBinding, AutomationCurve, audioParamTarget } from "@audiorective/core/automation";
import { WebClapHost } from "@audiorective/host/webclap";
import { ClipLauncher, type Clip as SessionClip, type ClipSpec } from "@audiorective/launcher";
import type { WaveStretchAnchor, WaveStretchProcessor } from "@audiorective/player";
import { EffectRack, type RackEffect } from "@audiorective/effects/rack";
import { AudioTrackSession } from "./audio-track-session";
import { Audition, type RangeAuditionState } from "./audition";
import { ClipStretch, type PreparedClipStretch } from "./clip-stretch";
import { ClipScheduler } from "./clip-scheduler";
import { Mixer, type MixerStrip } from "./mixer";
import { MidiClip, Project } from "./model";
import type { TempoMap } from "./tempo-map";
import type { AudioClipGainAutomation, PcmAudioClip, ProjectTrack, TrackRouting, WebClapDevice } from "./model";

export { scheduleClipEnvelope } from "./schedule-clip-envelope";
export type { PreparedClipStretch } from "./clip-stretch";

export type { RangeAuditionState } from "./audition";
import { collectGainAutomationEdits, deviceKeys, updateRack } from "./track-reconcile";
import { assertTakeAudioTime, placeTake, type TakeAnchor } from "./take-placement";
import type { TrackRuntime } from "./track-runtime";

export type WorkspaceOptions = {
  destination?: AudioNode;
  workletUrl?: string;
  resolveBundle?: (device: WebClapDevice) => string | Promise<string | undefined> | undefined;
  /** Messages produced before the workspace existed, such as file-open warnings; they precede the workspace's own. */
  warnings?: readonly string[];
  /** Hand the Project to the Workspace: `dispose()` disposes it too. Ownership ends if `workspace.project` is later replaced. Default: the caller owns it. */
  ownsProject?: boolean;
};
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
   * The Session view's launcher over this Workspace's audio tracks (mirrors `cells.session`): `session.value.tracks[trackId].clips[i]` is the i-th
   * clip of that Project track, `null` when it is not an in-memory audio clip, so a grid reads a Project clip's state from its cells and launches
   * it with `clip.launch()`. A launched clip plays through the track's devices, effects and mixer strip and takes the track away from Arrangement
   * until it is stopped or a one-shot ends. The launcher follows `workspace.transport` (a launch made while stopped waits for `play()`; stop and
   * seek clear it) and is replaced by `sync()`, so read `session.value` inside the effect that uses it. It is built (the clips' audio copied into buffers) the first time it is read. See `sessionClip`.
   */
  readonly session: ReadonlyCell<ClipLauncher>;
  /** Mirrors `cells.auditioningClip`. */
  readonly auditioningClip: ReadonlyCell<string | null>;
  /** Mirrors `cells.auditioningRange`. */
  readonly auditioningRange: ReadonlyCell<RangeAuditionState | null>;
  private readonly topologyPending = cell(false);
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
  private readonly sessionSources = new WeakMap<SessionClip, PcmAudioClip>();
  /** Bumped when `reconcileSession` replaces a session clip, so `sessionClip` readers re-run. */
  private readonly sessionClipEdits = cell(0);

  private readonly projectSource: Cell<Project>;
  /** The Project this Workspace disposes with itself, when it was handed one. */
  private ownedProject?: Project;
  private readonly options: WorkspaceOptions;
  /** What a separate render workspace needs to load the same devices. */
  get deviceOptions(): Pick<WorkspaceOptions, "workletUrl" | "resolveBundle"> {
    return { workletUrl: this.options.workletUrl, resolveBundle: this.options.resolveBundle };
  }
  private readonly tracks = new Map<string, TrackRuntime>();
  private readonly scheduler: ClipScheduler;
  private readonly noteOff: Array<() => void> = [];
  private readonly seekPoint = cell({ seconds: 0 });
  private activeTempoMap: TempoMap;
  private commitTail: Promise<void> = Promise.resolve();
  private automaticApply?: Promise<void>;
  private appliedProject?: Project;
  private appliedRevision = -1;
  private stopWatchingProject?: () => void;
  private applyingOwnEdit = false;
  private failedApplication?: { cause: unknown };
  private playRequest = 0;
  private disposed = false;
  private readonly mixer: Mixer;

  private constructor(context: AudioContext, project: Project, options: WorkspaceOptions) {
    this.context = context;
    this.projectSource = cell(project);
    if (options.ownsProject) this.ownedProject = project;
    this.activeTempoMap = project.tempoMap;
    this.options = options;
    this.scheduler = new ClipScheduler(context, (message) => this.warn(message));
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
    this.clock = new Clock({ timeline: this.timeline, lookAhead: 0.15, tickInterval: 0.025, onTick: (window) => this.schedule(window) });
    this.session = readonlyCell(() => {
      this.sessionRevision.$();
      return untracked(() => (this.sessionLauncher ??= this.buildSession()));
    });
    this.auditioningClip = this.audition.cells.clip;
    this.auditioningRange = this.audition.cells.range;
    this.cells = Object.freeze({
      needsSync: readonlyCell(this.topologyPending),
      error: readonlyCell(this.applicationError),
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
    return this.clock.state.value === "stopped" ? seconds : this.activeTempoMap.beatToSeconds(this.timeline.timeToBeat(this.context.currentTime));
  }

  /** Clock tempo events are absolute AudioContext times; rebase them at each transport anchor. */
  private rebaseTempo(atBeat: number): void {
    const now = this.context.currentTime;
    const map = this.activeTempoMap;
    const currentBpm = map.bpmAtBeat(atBeat);
    this.timeline.bpm.cancelScheduledValues(0);
    this.timeline.bpm.setValueAtTime(currentBpm, 0);
    this.timeline.bpm.setValueAtTime(currentBpm, now);
    const startSeconds = map.beatToSeconds(atBeat);
    for (const change of map.changes) {
      if (change.beat <= atBeat) continue;
      this.timeline.bpm.setValueAtTime(change.bpm, now + map.beatToSeconds(change.beat) - startSeconds);
    }
  }

  /** Capture the relationship between the audio clock and the project before arming a recorder. */
  takeAnchor(audioTime = this.context.currentTime): TakeAnchor {
    if (this.disposed) throw new Error("Workspace is disposed.");
    assertTakeAudioTime(audioTime);
    return untracked(() => ({ audioTime, projectTime: this.position, advancing: this.clock.state.value === "playing" }));
  }

  /** Positive input latency moves a take earlier. Use preroll when this would cross project zero. */
  takePosition(anchor: TakeAnchor, take: Readonly<{ startTime: number }>, inputLatencySeconds = 0): number {
    if (this.disposed) throw new Error("Workspace is disposed.");
    return placeTake(anchor, take, inputLatencySeconds);
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
    let rack: EffectRack;
    try {
      strip = this.mixer.createStrip(track.id, automationGain);
      rack = new EffectRack(this.context, track.effects, track.effectMacros);
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
        const bundleUrl = (await this.options.resolveBundle?.(device)) ?? device.bundleUrl;
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
          if (device.state.length) await host.loadState(device.state);
          if (previous) previous.output.connect(host.input);
          previous = host;
          runtime.hosts.set(device.id, host);
          if (track.kind === "midi" && !runtime.midiHost) runtime.midiHost = host;
        } catch (error) {
          host?.dispose();
          this.warn(`Device ${device.name} could not load: ${String(error)}`);
        }
      }
      if (previous) {
        previous.output.connect(runtime.rack.input);
        runtime.input = [...runtime.hosts.values()][0].input;
      }
      this.mixer.connectReceive(strip, runtime.input);
      if (track.kind === "audio") runtime.session = new AudioTrackSession(this.context, runtime.input);
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
    const gainEdits = new Map<string, AudioClipGainAutomation | undefined>();
    for (const track of tracks) {
      const runtime = this.tracks.get(track.id)!;
      if (runtime.clips !== track.clips && track.kind !== "bus") {
        clipsChanged = true;
        if (!refreshClips) refreshClips = !collectGainAutomationEdits(runtime.clips, track.clips, gainEdits);
      }
      runtime.clips = track.clips;
      updateRack(runtime, track);
      this.updateAutomation(runtime, track);
    }
    this.mixer.applyRouting(tracks);
    this.mixer.applyMixer();
    if (clipsChanged) this.audition.stopStale();
    if (tempoChanged) this.seek(position);
    else if (refreshClips) this.refreshArrangement();
    else if (gainEdits.size) this.scheduler.setGainAutomation(gainEdits);
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
      runtime.automationGain.gain.setValueAtTime(1, this.context.currentTime);
      return;
    }
    if (runtime.automationPoints === points) return;
    runtime.automationPoints = points;
    if (runtime.automationCurve) runtime.automationCurve.value = points;
    else {
      runtime.automationCurve = new AutomationCurve(points);
      runtime.automationBinding = new AutomationBinding(this.context, runtime.automationCurve, audioParamTarget(runtime.automationGain.gain));
      if (this.clock.state.value === "playing") runtime.automationBinding.start({ from: this.position });
    }
    if (this.clock.state.value !== "playing")
      runtime.automationGain.gain.setValueAtTime(runtime.automationCurve.valueAt(this.position), this.context.currentTime);
  }

  private positionAutomation(seconds: number, playing: boolean): void {
    for (const runtime of this.tracks.values()) {
      if (!runtime.automationCurve || !runtime.automationBinding) continue;
      if (playing) runtime.automationBinding.start({ from: seconds });
      else {
        runtime.automationBinding.stop();
        runtime.automationGain.gain.setValueAtTime(runtime.automationCurve.valueAt(seconds), this.context.currentTime);
      }
    }
  }

  /**
   * The Session clip of a Project audio clip: `session.value.tracks[trackId].clips[i]` for the clip's position in its track, or null when the
   * clip is unknown or not an in-memory audio clip. Session clips loop and keep their recorded speed; `clip.configure({ loop: false })` makes one a one-shot.
   * A tracked reader: it re-runs when the Project's clips change and the session clips are replaced to match.
   */
  sessionClip(trackId: string, clipId: string): SessionClip | null {
    this.sessionClipEdits.$();
    this.project.cells.revision.$();
    const index = this.project.tracks.find((track) => track.id === trackId)?.clips.findIndex((clip) => clip.id === clipId) ?? -1;
    return index < 0 ? null : (this.session.value.tracks[trackId]?.clips[index] ?? null);
  }

  /** A launcher over the audio tracks built so far; session clips play through each track's input and take it away from Arrangement while they sound. */
  private buildSession(): ClipLauncher {
    const specs: Record<string, (ClipSpec | null)[]> = {};
    for (const track of this.project.tracks)
      if (this.tracks.get(track.id)?.session) specs[track.id] = track.clips.map((clip) => this.sessionSpec(clip));
    const launcher = new ClipLauncher(specs, {
      context: this.context,
      onSchedule: ({ track, clip, when, endsAt }) => this.tracks.get(track.name)?.session?.follow(when, clip !== null, endsAt),
    });
    for (const id of Object.keys(specs)) launcher.tracks[id]!.connect(this.tracks.get(id)!.input);
    this.clock.attach(launcher);
    this.project.tracks.forEach((track) => this.recordSessionSources(launcher, track));
    return launcher;
  }

  private sessionSpec(clip: ProjectTrack["clips"][number]): ClipSpec | null {
    if (clip.kind !== "audio" || clip.media) return null;
    return { buffer: this.scheduler.sessionBufferFor(clip as PcmAudioClip), loop: true, warp: false, name: clip.id };
  }

  private recordSessionSources(launcher: ClipLauncher, track: ProjectTrack): void {
    track.clips.forEach((clip, index) => {
      const sessionClip = launcher.tracks[track.id]?.clips[index];
      if (sessionClip && clip.kind === "audio" && !clip.media) this.sessionSources.set(sessionClip, clip);
    });
  }

  /** Bring the session clips in line with the Project's clips: a clip that changed or went away is replaced or removed (stopped at once if it was playing). */
  private reconcileSession(): void {
    const launcher = this.sessionLauncher;
    if (!launcher) return;
    let replaced = false;
    for (const track of this.project.tracks) {
      const sessionTrack = launcher.tracks[track.id];
      if (!sessionTrack) continue;
      const count = Math.max(track.clips.length, sessionTrack.clips.length);
      for (let index = 0; index < count; index++) {
        const wanted = track.clips[index];
        const spec = wanted ? this.sessionSpec(wanted) : null;
        const existing = sessionTrack.clips[index] ?? null;
        const source = existing ? this.sessionSources.get(existing) : undefined;
        if ((spec === null && existing === null) || (spec !== null && existing !== null && source === wanted)) continue;
        replaced = true;
        const clip = sessionTrack.setClip(index, spec);
        if (clip && wanted?.kind === "audio" && !wanted.media) this.sessionSources.set(clip, wanted as PcmAudioClip);
      }
    }
    if (replaced) this.sessionClipEdits.value++;
  }

  async play(): Promise<void> {
    if (this.disposed) throw new Error("Workspace is disposed.");
    if (untracked(() => this.clock.state.value === "playing")) return;
    const request = ++this.playRequest;
    await this.flush();
    if (request !== this.playRequest) return;
    await this.context.resume();
    const position = this.position;
    await this.prefetchMediaAt(position);
    if (request !== this.playRequest) return;
    this.activeTempoMap = untracked(() => this.project.tempoMap);
    const beat = this.activeTempoMap.secondsToBeat(position);
    this.rebaseTempo(beat);
    // Clock's resume assumes its look-ahead tail survived pause. Workspace owns
    // and cancels that tail, so re-anchor at the frozen beat before refilling.
    this.clock.start({ atBeat: beat });
    this.positionAutomation(position, true);
    this.clock.refresh();
  }
  pause(): void {
    this.playRequest++;
    untracked(() => this.positionAutomation(this.position, false));
    this.clock.pause();
    this.cancelAudio();
    this.allNotesOff();
  }
  stop(): void {
    this.playRequest++;
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
    this.playRequest++;
    this.allNotesOff();
    this.cancelAudio();
    this.activeTempoMap = this.project.tempoMap;
    const beat = this.activeTempoMap.secondsToBeat(seconds);
    this.rebaseTempo(beat);
    this.clock.seek(beat);
    // A seek to the same target still moves a paused or advancing playhead.
    this.seekPoint.value = { seconds };
    this.positionAutomation(seconds, this.clock.state.value === "playing");
    if (this.clock.state.value === "playing") this.clock.refresh();
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
    for (const track of this.project.tracks) {
      const runtime = this.tracks.get(track.id);
      if (runtime?.kind === track.kind) runtime.clips = track.clips;
    }
    this.reconcileSession();
    this.cancelAudio();
    this.bindNotes();
    this.refresh();
  }

  private bindNotes(): void {
    for (const off of this.noteOff.splice(0)) off();
    for (const track of this.tracks.values())
      for (const clip of track.clips)
        if (clip instanceof MidiClip)
          this.noteOff.push(
            clip.midi.revision.subscribe(() => {
              if (this.clock.state.value === "playing") this.refresh();
            }),
          );
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

  private prefetchMediaAt(position: number): Promise<void> {
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
            project.setDeviceState(device.id, state);
            const installed = currentTrack()?.devices.find(({ id }) => id === device.id);
            if (installed) runtime.deviceStates.set(device.id, installed.state);
          });
        }
      }
  }

  private schedule(window: TickWindow<Record<never, never>>): void {
    this.scheduler.scheduleArrangement(this.tracks.values(), window, this.activeTempoMap, this.timeline);
  }

  private allNotesOff(): void {
    for (const track of this.tracks.values()) for (const host of track.hosts.values()) host.allNotesOff();
  }

  private cancelAudio(): void {
    this.scheduler.cancelAudio();
  }

  private disposeTrack(runtime: TrackRuntime): void {
    runtime.session?.dispose();
    runtime.rack.dispose();
    for (const host of runtime.hosts.values()) host.dispose();
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
