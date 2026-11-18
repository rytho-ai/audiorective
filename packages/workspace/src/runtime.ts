import { Clock, RangeLoop, Timeline } from "@audiorective/clock";
import type { LoopRange, TickWindow } from "@audiorective/clock";
import { batch, cell, effect, readonlyCell, untracked, type Cell, type Readable } from "@audiorective/core";
import { AutomationBinding, AutomationCurve, audioParamTarget } from "@audiorective/core/automation";
import type { AutomationPoint } from "@audiorective/core/automation";
import { WebClapHost } from "@audiorective/host/webclap";
import { AudioRecorder, ClipLauncher, clipGainAt, scheduleClipEnvelope, type ClipLaunch, type ClipLauncherState, type QueuedClipLaunch, type StepSequencer, type WaveStretchProcessor } from "@audiorective/blocks";
import { EffectRack, retainRackMacroTargets, type RackEffect, type RackMacroSettings } from "@audiorective/blocks/effect-rack";
import { AudioTrackSession } from "./audio-track-session";
import { openDawProject, openDawProjectBlob, saveDawProject, saveDawProjectTo } from "./dawproject";
import { soloRouting } from "./mixer-routing";
import { createOpfsAudioMediaWriter } from "./media";
import { MidiClip, Project, audioClipSourceDuration, audioFrameCount } from "./model";
import type { TempoMap } from "./tempo-map";
import { writeStoredZip } from "./stored-zip";
import type { StoredZipEntry } from "./stored-zip";
import { wavMediaStereoPairEntry } from "./wav";
import type { AudioMedia } from "./media";
import type { AudioClip, AudioClipGainAutomation, PcmAudioClip, ProjectTrack, TrackRouting, WebClapDevice } from "./model";

export type PreparedClipStretch = Readonly<{ apply(): AudioClip }>;

type AudioHandle = {
  clipId: string;
  setGainAutomation(automation: AudioClipGainAutomation | undefined): void;
  cancel(): void;
  onEnded(listener: () => void): void;
};
type ClipAudition = { clip: AudioClip; cancel?: () => void };
type RangeAudition = { range: RangeAuditionState; tracks: readonly ProjectTrack[]; clock?: Clock };
export type RangeAuditionState = Readonly<{ start: number; end: number; trackIds: readonly string[] }>;
type AudioClipWindow = {
  start: number;
  end: number;
  stop: number;
  audioTime(seconds: number): number;
  keyPrefix: string;
};
type TrackRuntime = {
  kind: ProjectTrack["kind"];
  clips: ProjectTrack["clips"];
  deviceKeys: readonly string[];
  deviceStates: Map<string, Uint8Array>;
  gain: GainNode;
  automationGain: GainNode;
  rack: EffectRack;
  effectSettings: readonly RackEffect[];
  macroSettings: readonly RackMacroSettings[];
  automationPoints?: readonly AutomationPoint[];
  automationCurve?: AutomationCurve;
  automationBinding?: AutomationBinding;
  panner: StereoPannerNode;
  outputGate: GainNode;
  outputDestination?: AudioNode;
  sends: Map<string, { input: AudioNode; gate: GainNode }>;
  input: AudioNode;
  session?: AudioTrackSession;
  hosts: Map<string, WebClapHost>;
  midiHost?: WebClapHost;
};
const audioChunkSeconds = 2;

function collectGainAutomationEdits(
  before: ProjectTrack["clips"],
  after: ProjectTrack["clips"],
  edits: Map<string, AudioClipGainAutomation | undefined>,
): boolean {
  if (before.length !== after.length) return false;
  for (let index = 0; index < before.length; index++) {
    const old = before[index];
    const clip = after[index];
    if (old === clip) continue;
    if (old.kind !== "audio" || clip.kind !== "audio" || old.id !== clip.id ||
      old.time !== clip.time || old.duration !== clip.duration || old.sampleRate !== clip.sampleRate ||
      old.envelope !== clip.envelope || old.stretch !== clip.stretch || old.channels !== clip.channels ||
      old.media !== clip.media || (old.media && clip.media && old.startFrame !== clip.startFrame)) return false;
    edits.set(clip.id, clip.gainAutomation);
  }
  return true;
}
const deviceKeys = (track: ProjectTrack): readonly string[] =>
  track.devices.map((device) => `${device.id}\u0000${device.pluginId}\u0000${device.bundleUrl}`);
export type WorkspaceOptions = {
  destination?: AudioNode;
  workletUrl?: string;
  resolveBundle?: (device: WebClapDevice) => string | Promise<string | undefined> | undefined;
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
export type TakeAnchor = Readonly<{ audioTime: number; projectTime: number; advancing: boolean }>;
export type AudioFallbackOptions = Readonly<{
  /** Captures effects after the final clip; default one second. */
  tailSeconds?: number;
  signal?: AbortSignal;
  onProgress?: (fraction: number) => void;
}>;
export type PortabilityReport = Readonly<{
  standardContent: readonly string[];
  pluginDependencies: readonly string[];
  limitations: readonly string[];
}>;

/** One live DAW workspace over one Project. Project remains the sole persistent-data owner. */
export class Workspace {
  readonly context: AudioContext;
  readonly output: GainNode;
  readonly timeline: Timeline;
  readonly clock: Clock;
  readonly player: WorkspacePlayer;
  readonly session: Readable<ClipLauncherState>;
  private readonly topologyPending = cell(false);
  private readonly applicationError = cell<string | null>(null);
  private readonly warningMessages = cell<readonly string[]>(Object.freeze([]));
  readonly cells = Object.freeze({
    needsSync: readonlyCell(this.topologyPending),
    error: readonlyCell(this.applicationError),
    warnings: readonlyCell(this.warningMessages),
  });
  private readonly auditionSource = cell<ClipAudition | RangeAudition | null>(null);
  readonly auditioningClip = readonlyCell(() => {
    const current = this.auditionSource.value;
    return current && "clip" in current ? current.clip.id : null;
  });
  readonly auditioningRange = readonlyCell(() => {
    const current = this.auditionSource.value;
    return current && "range" in current ? current.range : null;
  });
  private readonly clipStretchJobs = new Map<string, AbortController>();
  private readonly launcher: ClipLauncher;

  private readonly projectSource: Cell<Project>;
  private readonly options: WorkspaceOptions;
  private readonly tracks = new Map<string, TrackRuntime>();
  private readonly stepSequencers = new Map<StepSequencer, () => void>();
  private readonly scheduledAudio = new Map<string, AudioHandle>();
  private readonly audioBuffers = new WeakMap<PcmAudioClip["channels"], AudioBuffer>();
  private readonly sessionAudioBuffers = new WeakMap<PcmAudioClip, AudioBuffer>();
  private readonly mediaBuffers = new WeakMap<AudioMedia, Map<string, Promise<AudioBuffer>>>();
  private readonly sequenceOff: Array<() => void> = [];
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
  private destroyed = false;

  private constructor(context: AudioContext, project: Project, options: WorkspaceOptions) {
    this.context = context;
    this.projectSource = cell(project);
    this.activeTempoMap = project.tempoMap;
    this.options = options;
    this.output = context.createGain();
    if (options.destination) this.output.connect(options.destination);
    this.timeline = new Timeline({ audioContext: context, bpm: project.bpm });
    this.clock = new Clock({ timeline: this.timeline, lookAhead: 0.15, tickInterval: 0.025, onTick: (window) => this.schedule(window) });
    this.launcher = new ClipLauncher({
      now: () => this.context.currentTime,
      timeToBeat: (time) => this.timeline.timeToBeat(time),
      beatToTime: (beat) => this.timeline.beatToTime(beat),
      schedule: (changes, when) => {
        const endsAt = new Map<string, number>();
        const transitions = changes.map(({ trackId, clipId, mode }) => {
          const buffer = clipId === null ? null : this.sessionBufferFor(this.launchableClip(trackId, clipId));
          const transition = this.tracks.get(trackId)!.session!.schedule(buffer, when, mode !== "one-shot");
          if (transition.end !== undefined) endsAt.set(trackId, transition.end);
          return transition;
        });
        return {
          commit: () => transitions.forEach((transition) => transition.commit()),
          cancel: () => transitions.forEach((transition) => transition.cancel()),
          endsAt,
        };
      },
      reset: () => {
        for (const track of this.tracks.values()) track.session?.reset();
      },
    });
    this.session = this.launcher.state;
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
    batch(() => {
      this.stopAudition();
      this.projectSource.value = project;
    });
  }

  static async create(context: AudioContext, project: Project, options: WorkspaceOptions = {}): Promise<Workspace> {
    const workspace = new Workspace(context, project, options);
    try {
      await workspace.sync();
      workspace.stopWatchingProject = effect(() => {
        const current = workspace.project;
        const revision = current.cells.revision.value;
        if (!workspace.applyingOwnEdit && (workspace.appliedProject !== current || workspace.appliedRevision !== revision))
          untracked(() => workspace.scheduleProjectEdit());
      });
      return workspace;
    } catch (error) {
      workspace.destroy();
      throw error;
    }
  }

  static async open(context: AudioContext, bytes: Uint8Array, options: WorkspaceOptions = {}): Promise<Workspace> {
    const opened = openDawProject(bytes);
    try {
      const workspace = await Workspace.create(context, opened.project, options);
      if (opened.warnings.length) workspace.warningMessages.value = Object.freeze([...opened.warnings, ...workspace.warnings]);
      return workspace;
    } catch (error) {
      opened.project.destroy();
      throw error;
    }
  }

  static async openBlob(context: AudioContext, blob: Blob, options: WorkspaceOptions = {}): Promise<Workspace> {
    const opened = await openDawProjectBlob(blob);
    try {
      const workspace = await Workspace.create(context, opened.project, options);
      if (opened.warnings.length) workspace.warningMessages.value = Object.freeze([...opened.warnings, ...workspace.warnings]);
      return workspace;
    } catch (error) {
      opened.project.destroy();
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
    if (this.destroyed) throw new Error("Workspace is destroyed.");
    if (!Number.isFinite(audioTime) || audioTime < 0) throw new RangeError("Workspace take anchor needs a finite non-negative audio time.");
    return { audioTime, projectTime: this.position, advancing: this.clock.state.value === "playing" };
  }

  /** Positive input latency moves a take earlier. Use preroll when this would cross project zero. */
  takePosition(anchor: TakeAnchor, take: Readonly<{ startTime: number }>, inputLatencySeconds = 0): number {
    if (this.destroyed) throw new Error("Workspace is destroyed.");
    if (
      ![anchor.audioTime, anchor.projectTime, take.startTime, inputLatencySeconds].every(Number.isFinite) ||
      anchor.audioTime < 0 ||
      anchor.projectTime < 0 ||
      take.startTime < 0 ||
      inputLatencySeconds < 0
    )
      throw new RangeError("Workspace take placement needs a valid anchor, take start and non-negative input latency.");
    const time = anchor.projectTime + (anchor.advancing ? take.startTime - anchor.audioTime : 0) - inputLatencySeconds;
    if (time < 0) throw new RangeError("Workspace take placement crosses project zero; use preroll or a smaller latency correction.");
    return time;
  }

  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const queued = this.commitTail.then(task);
    this.commitTail = queued.then(() => undefined, () => undefined);
    return queued;
  }

  private isCurrentProject(): boolean {
    return this.appliedProject === this.project && this.appliedRevision === untracked(() => this.project.cells.revision.value);
  }

  private recordCurrentProject(): void {
    this.appliedProject = this.project;
    this.appliedRevision = untracked(() => this.project.cells.revision.value);
  }

  private reflectProjectEdit(edit: () => void): void {
    const current = this.isCurrentProject();
    const revision = this.appliedRevision;
    this.applyingOwnEdit = true;
    try {
      edit();
    } finally {
      this.applyingOwnEdit = false;
      if (current && this.project === this.appliedProject && untracked(() => this.project.cells.revision.value) === revision + 1) {
        this.recordCurrentProject();
      } else if (!this.isCurrentProject()) {
        this.scheduleProjectEdit();
      }
    }
  }

  private scheduleProjectEdit(): void {
    if (this.destroyed || this.automaticApply) return;
    this.automaticApply = this.serialize(async () => {
      try {
        if (!this.destroyed && !this.isCurrentProject()) await this.applyProjectEdit(() => this.commitProject(false));
      } catch {
        // The caller can observe cells.error or await flush() for the cause.
      } finally {
        this.automaticApply = undefined;
        if (!this.destroyed && !this.isCurrentProject()) this.scheduleProjectEdit();
      }
    });
  }

  private async applyProjectEdit(apply: () => Promise<void>): Promise<void> {
    try {
      await apply();
      this.failedApplication = undefined;
      this.applicationError.value = null;
    } catch (cause) {
      if (!this.destroyed) {
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
    if (!this.destroyed && this.failedApplication) throw this.failedApplication.cause;
  }

  /** Explicitly rebuild the graph after structural edits. Stops transport. */
  sync(): Promise<void> {
    return this.serialize(() => this.applyProjectEdit(() => this.rebuildTracks()));
  }

  private async rebuildTracks(position = this.position): Promise<void> {
    if (this.destroyed) throw new Error("Workspace is destroyed.");
    this.recordCurrentProject();
    this.stopStaleAudition();
    this.stop();
    this.activeTempoMap = this.project.tempoMap;
    await this.captureStates();
    this.disposeTracks();
    try {
      const tracks = this.project.tracks;
      for (const track of tracks) {
        const runtime = await this.createTrack(track);
        if (this.destroyed) {
          this.disposeTrack(runtime);
          throw new Error("Workspace is destroyed.");
        }
        this.tracks.set(track.id, runtime);
      }
      if (this.project.tracks !== tracks) return await this.rebuildTracks(position);
      this.applyRouting(tracks);
      this.applyMixer();
      this.bindSequences();
      this.seek(position);
      this.topologyPending.value = false;
    } catch (error) {
      this.disposeTracks();
      if (!this.destroyed) this.topologyPending.value = true;
      throw error;
    }
  }

  private async createTrack(track: ProjectTrack): Promise<TrackRuntime> {
    const gain = this.context.createGain();
    const automationGain = this.context.createGain();
    const panner = this.context.createStereoPanner();
    const outputGate = this.context.createGain();
    automationGain.connect(gain).connect(panner).connect(outputGate);
    const runtime: TrackRuntime = {
      kind: track.kind,
      clips: track.clips,
      deviceKeys: deviceKeys(track),
      deviceStates: new Map(track.devices.map((device) => [device.id, device.state])),
      gain,
      automationGain,
      rack: new EffectRack(this.context, track.effects, track.effectMacros),
      effectSettings: track.effects,
      macroSettings: track.effectMacros,
      panner,
      outputGate,
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
            host.destroy();
            this.warn(`Device ${device.name} has a different CLAP ID in its bundle.`);
            continue;
          }
          if (device.state.length) await host.loadState(device.state);
          if (previous) previous.output.connect(host.input);
          previous = host;
          runtime.hosts.set(device.id, host);
          if (track.kind === "midi" && !runtime.midiHost) runtime.midiHost = host;
        } catch (error) {
          host?.destroy();
          this.warn(`Device ${device.name} could not load: ${String(error)}`);
        }
      }
      if (previous) {
        previous.output.connect(runtime.rack.input);
        runtime.input = [...runtime.hosts.values()][0].input;
      }
      if (track.kind === "audio") runtime.session = new AudioTrackSession(this.context, runtime.input);
      this.updateAutomation(runtime, track);
      return runtime;
    } catch (error) {
      this.disposeTrack(runtime);
      throw error;
    }
  }

  /** Apply Project edits through one entry point; clips, routing and bus edits keep unaffected devices alive. */
  commit(): Promise<void> {
    return this.serialize(() => this.applyProjectEdit(async () => {
      if (this.destroyed || !this.isCurrentProject() || this.topologyPending.value || this.failedApplication)
        await this.commitProject(true);
    }));
  }

  private async commitProject(allowRebuild: boolean): Promise<void> {
    if (this.destroyed) throw new Error("Workspace is destroyed.");
    this.recordCurrentProject();
    const project = this.project;
    const tracks = project.tracks;
    const ids = new Set(tracks.map(({ id }) => id));
    const removed = [...this.tracks].filter(([id]) => !ids.has(id));
    const compatible = removed.every(([, runtime]) => runtime.kind === "bus") && tracks.every((track) => {
      const runtime = this.tracks.get(track.id);
      if (!runtime) return track.kind === "bus" && !track.devices.length;
      const nextKeys = deviceKeys(track);
      return runtime.kind === track.kind && runtime.deviceKeys.length === nextKeys.length &&
        runtime.deviceKeys.every((key, index) => key === nextKeys[index]);
    });
    if (!compatible) {
      this.topologyPending.value = true;
      if (allowRebuild) await this.rebuildTracks();
      return;
    }

    for (const track of tracks) {
      const runtime = this.tracks.get(track.id);
      if (!runtime) continue;
      for (const device of track.devices) {
        if (runtime.deviceStates.get(device.id) === device.state) continue;
        const host = runtime.hosts.get(device.id);
        if (host) await host.loadState(device.state);
        if (this.destroyed) return;
        runtime.deviceStates.set(device.id, device.state);
        if (this.project !== project || project.tracks !== tracks) return this.commitProject(allowRebuild);
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
    if (this.destroyed || this.project !== project || project.tracks !== tracks) {
      for (const runtime of created.values()) this.disposeTrack(runtime);
      if (!this.destroyed) return this.commitProject(allowRebuild);
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
      this.updateRack(runtime, track);
      this.updateAutomation(runtime, track);
    }
    this.applyRouting(tracks);
    this.applyMixer();
    if (clipsChanged) this.stopStaleAudition();
    if (tempoChanged) this.seek(position);
    else if (refreshClips) this.refreshArrangement();
    else if (gainEdits.size)
      for (const handle of this.scheduledAudio.values())
        if (gainEdits.has(handle.clipId)) handle.setGainAutomation(gainEdits.get(handle.clipId));
    if (tempoChanged && refreshClips) this.bindSequences();
    this.topologyPending.value = false;
  }

  private updateAutomation(runtime: TrackRuntime, track: ProjectTrack): void {
    const points = track.volumeAutomation;
    if (!points.length) {
      if (!runtime.automationBinding) return;
      runtime.automationBinding?.destroy();
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

  private updateRack(runtime: TrackRuntime, track: ProjectTrack): void {
    const effectsChanged = runtime.effectSettings !== track.effects;
    if (runtime.macroSettings !== track.effectMacros) {
      const retained = effectsChanged ? retainRackMacroTargets(track.effects, runtime.macroSettings) : runtime.macroSettings;
      const valuesOnly = retained.length === track.effectMacros.length && retained.every((old, i) => {
        const macro = track.effectMacros[i];
        return old.id === macro.id && old.label === macro.label && old.targets.length === macro.targets.length &&
          old.targets.every((target, j) => target === macro.targets[j]);
      });
      if (!valuesOnly) {
        runtime.rack.setPreset({ effects: track.effects, macros: track.effectMacros });
      } else {
        if (effectsChanged) runtime.rack.setEffects(track.effects);
        for (const [i, macro] of track.effectMacros.entries()) {
          if (macro.value !== retained[i].value) runtime.rack.macro(macro.id)!.param.value = macro.value;
        }
      }
    } else if (effectsChanged) runtime.rack.setEffects(track.effects);
    runtime.effectSettings = track.effects;
    runtime.macroSettings = track.effectMacros;
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

  /** Attach a caller-owned pattern to the Workspace clock. The caller routes the instrument audio. */
  attachStepSequencer(sequence: StepSequencer): () => void {
    if (this.destroyed || this.stepSequencers.has(sequence)) throw new Error("Workspace needs a new step sequencer on a live transport.");
    let stop: (() => void) | undefined;
    const detach = () => {
      stop?.();
      if (this.stepSequencers.get(sequence) !== detach) return;
      this.stepSequencers.delete(sequence);
      sequence.reset();
    };
    this.stepSequencers.set(sequence, detach);
    stop = effect(() => {
      sequence.pattern.$();
      untracked(() => this.clock.refresh());
    });
    return detach;
  }

  /** Queue clips or return tracks to Arrangement at the next launch grid boundary. */
  launchClips(changes: readonly ClipLaunch[], quantumBeats = 1): QueuedClipLaunch {
    if (this.destroyed || this.clock.state.value !== "playing") throw new Error("Start Workspace playback before launching clips.");
    for (const { trackId, clipId } of changes) {
      if (!this.tracks.get(trackId)?.session) throw new Error("Clip Launcher requires an audio track.");
      if (clipId !== null) this.sessionBufferFor(this.launchableClip(trackId, clipId));
    }
    return this.launcher.queue(changes, quantumBeats);
  }

  cancelClipLaunch(): boolean {
    return this.launcher.cancel();
  }

  private launchableClip(trackId: string, clipId: string): PcmAudioClip {
    const clip = this.tracks.get(trackId)?.clips.find((clip) => clip.id === clipId);
    if (!clip || clip.kind !== "audio" || clip.media) throw new Error("Clip Launcher requires an in-memory audio clip on the target track.");
    return clip;
  }

  async play(): Promise<void> {
    if (this.destroyed) throw new Error("Workspace is destroyed.");
    if (this.clock.state.value === "playing") return;
    const request = ++this.playRequest;
    await this.flush();
    if (request !== this.playRequest) return;
    await this.context.resume();
    const position = this.position;
    await this.prefetchMediaAt(position);
    if (request !== this.playRequest) return;
    this.activeTempoMap = this.project.tempoMap;
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
    this.positionAutomation(this.position, false);
    this.clock.pause();
    this.launcher.reset();
    for (const sequence of this.stepSequencers.keys()) sequence.reset();
    this.cancelAudio();
    this.panic();
  }
  stop(): void {
    this.playRequest++;
    batch(() => {
      this.clock.stop();
      this.launcher.reset();
      for (const sequence of this.stepSequencers.keys()) sequence.reset();
      this.seekPoint.value = { seconds: 0 };
    });
    this.positionAutomation(0, false);
    this.cancelAudio();
    this.panic();
  }
  seek(seconds: number): void {
    if (!Number.isFinite(seconds) || seconds < 0) throw new RangeError("Workspace seek needs non-negative seconds.");
    this.playRequest++;
    this.launcher.reset();
    this.panic();
    this.cancelAudio();
    this.activeTempoMap = this.project.tempoMap;
    const beat = this.activeTempoMap.secondsToBeat(seconds);
    this.rebaseTempo(beat);
    this.clock.seek(beat);
    for (const sequence of this.stepSequencers.keys()) sequence.reset();
    // A seek to the same target still moves a paused or advancing playhead.
    this.seekPoint.value = { seconds };
    this.positionAutomation(seconds, this.clock.state.value === "playing");
    if (this.clock.state.value === "playing") this.clock.refresh();
  }
  refresh(): void {
    this.panic();
    this.clock.refresh();
  }

  /** Apply clip arrangement edits without reloading track devices. */
  refreshArrangement(): void {
    if (this.destroyed) throw new Error("Workspace is destroyed.");
    this.stopStaleAudition();
    for (const track of this.project.tracks) {
      const runtime = this.tracks.get(track.id);
      if (runtime?.kind === track.kind) runtime.clips = track.clips;
    }
    const { active, queued } = this.session.value;
    if (
      [...active, ...(queued?.changes ?? [])].some(
        ({ trackId, clipId }) => clipId !== null && !this.project.tracks.find((track) => track.id === trackId)?.clips.some((clip) => clip.id === clipId),
      )
    ) {
      this.launcher.reset();
    }
    this.cancelAudio();
    this.bindSequences();
    this.refresh();
  }

  private bindSequences(): void {
    for (const off of this.sequenceOff.splice(0)) off();
    for (const track of this.tracks.values())
      for (const clip of track.clips)
        if (clip instanceof MidiClip)
          this.sequenceOff.push(
            clip.sequence.subscribe(() => {
              if (this.clock.state.value === "playing") this.refresh();
            }),
          );
  }

  setTrackVolume(trackId: string, value: number): void {
    this.reflectProjectEdit(() => {
      this.project.setTrackVolume(trackId, value);
      this.applyMixer();
    });
  }

  setMasterVolume(value: number): void {
    this.reflectProjectEdit(() => {
      this.project.setMasterVolume(value);
      this.output.gain.setValueAtTime(this.project.masterVolume, this.context.currentTime);
    });
  }

  setTrackMuted(trackId: string, muted: boolean): void {
    this.reflectProjectEdit(() => {
      this.project.setTrackMuted(trackId, muted);
      this.applyMixer();
    });
  }
  setTrackSolo(trackId: string, solo: boolean): void {
    this.reflectProjectEdit(() => {
      this.project.setTrackSolo(trackId, solo);
      this.applyMixer();
    });
  }
  setTrackPan(trackId: string, pan: number): void {
    this.reflectProjectEdit(() => {
      this.project.setTrackPan(trackId, pan);
      this.applyMixer();
    });
  }

  /** Apply a rack edit now without rebuilding WebCLAP devices or stopping transport. */
  setTrackEffects(trackId: string, effects: readonly RackEffect[]): void {
    const runtime = this.tracks.get(trackId);
    const track = this.project.tracks.find((item) => item.id === trackId);
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
    const track = this.project.tracks.find((item) => item.id === trackId);
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
    const tracks = this.project.tracks;
    if (!this.tracks.has(trackId) || tracks.length !== this.tracks.size || tracks.some((track) => !this.tracks.has(track.id)))
      throw new Error("Commit new or removed tracks before changing live routing.");
    this.reflectProjectEdit(() => {
      this.project.setTrackRouting(trackId, routing);
      this.applyRouting(this.project.tracks);
      this.applyMixer();
    });
  }

  /** Borrow a post-fader track output for the mixer's meter, or use output for the master meter. */
  trackMixerOutput(trackId: string): AudioNode | undefined {
    return this.tracks.get(trackId)?.panner;
  }

  private applyRouting(tracks: readonly ProjectTrack[]): void {
    const inputFor = (id: string | null) => id === null ? this.output : this.tracks.get(id)!.input;
    // Remove obsolete edges first so reversing a bus chain never introduces a temporary cycle.
    for (const track of tracks) {
      const runtime = this.tracks.get(track.id)!;
      if (runtime.outputDestination !== inputFor(track.routing.outputBusId)) {
        runtime.outputGate.disconnect();
        runtime.outputDestination = undefined;
      }
      for (const [id, send] of runtime.sends) {
        if (track.routing.sends.some(({ busId }) => busId === id) && send.input === inputFor(id)) continue;
        runtime.panner.disconnect(send.gate);
        send.gate.disconnect();
        runtime.sends.delete(id);
      }
    }
    for (const track of tracks) {
      const runtime = this.tracks.get(track.id)!;
      if (!runtime.outputDestination) {
        runtime.outputDestination = inputFor(track.routing.outputBusId);
        runtime.outputGate.connect(runtime.outputDestination);
      }
      for (const { busId } of track.routing.sends) {
        if (runtime.sends.has(busId)) continue;
        const input = inputFor(busId);
        const gate = this.context.createGain();
        runtime.panner.connect(gate).connect(input);
        runtime.sends.set(busId, { input, gate });
      }
    }
  }

  private disposeRouting(runtime: TrackRuntime): void {
    runtime.panner.disconnect(runtime.outputGate);
    runtime.outputGate.disconnect();
    for (const { gate } of runtime.sends.values()) {
      runtime.panner.disconnect(gate);
      gate.disconnect();
    }
    runtime.sends.clear();
  }

  private applyMixer(): void {
    const now = this.context.currentTime;
    this.output.gain.setValueAtTime(this.project.masterVolume, now);
    const tracks = this.project.tracks;
    const solo = soloRouting(tracks);
    for (const track of tracks) {
      const runtime = this.tracks.get(track.id);
      if (!runtime) continue;
      runtime.gain.gain.setValueAtTime(track.muted || !solo.strip(track) ? 0 : track.volume, now);
      runtime.panner.pan.setValueAtTime(track.pan, now);
      runtime.outputGate.gain.setValueAtTime(solo.edge(track, track.routing.outputBusId) ? 1 : 0, now);
      for (const { busId, gain } of track.routing.sends) {
        runtime.sends.get(busId)?.gate.gain.setValueAtTime(solo.edge(track, busId) ? gain : 0, now);
      }
    }
  }

  host(deviceId: string): WebClapHost | undefined {
    for (const track of this.tracks.values()) {
      const host = track.hosts.get(deviceId);
      if (host) return host;
    }
    return undefined;
  }

  private findAudioClip(clipId: string): AudioClip | undefined {
    for (const track of this.project.tracks) {
      const clip = track.clips.find((candidate) => candidate.id === clipId);
      if (clip?.kind === "audio") return clip;
    }
  }

  private get audition(): ClipAudition | RangeAudition | null {
    return untracked(() => this.auditionSource.value);
  }

  /** Audition the current audio clip through master output independently of Arrangement. */
  async auditionAudioClip(clipId: string): Promise<void> {
    if (this.destroyed) throw new Error("Workspace is destroyed.");
    const clip = this.findAudioClip(clipId);
    if (!clip) throw new Error("Workspace audition needs an audio clip.");

    const audition: ClipAudition = { clip };
    batch(() => {
      this.stopAudition();
      this.auditionSource.value = audition;
    });
    const finish = () => {
      if (this.audition === audition) this.stopClipAudition();
    };
    try {
      await this.context.resume();
      if (this.audition !== audition) return;
      if (clip.media) await this.loadMediaBuffer(clip, 0);
      if (this.audition !== audition) return;
      if (this.findAudioClip(clipId) !== clip) return finish();

      if (clip.media) {
        let nextChunk = 0;
        const chunks = Math.ceil(clip.duration / audioChunkSeconds);
        const clock = new Clock({
          timeline: new Timeline({ audioContext: this.context }),
          lookAhead: 0.2,
          onTick: (window) => {
            const elapsed = window.time.current - window.time.started;
            if (elapsed >= clip.duration) return finish();
            nextChunk = Math.max(nextChunk, Math.floor(elapsed / audioChunkSeconds));
            while (nextChunk < chunks) {
              const when = window.time.started + nextChunk * audioChunkSeconds;
              if (when >= window.time.lookAheadEnd) break;
              const handle = this.scheduleMediaAudio(clip, nextChunk++, this.output, when, 0);
              window.own(handle, when);
              if (nextChunk === chunks) handle.onEnded(finish);
            }
          },
        });
        audition.cancel = () => clock.destroy();
        clock.start();
        // The initial chunk is already preloaded. Let later ticks stream the clip.
        clock.refresh();
      } else {
        const handle = this.scheduleAudio(clip, this.output, this.context.currentTime, 0);
        audition.cancel = () => handle.cancel();
        handle.onEnded(finish);
      }
    } catch (error) {
      if (this.audition !== audition) return;
      finish();
      throw error;
    }
  }

  stopClipAudition(): void {
    if (this.audition && "clip" in this.audition) this.stopAudition();
  }

  private stopStaleAudition(): void {
    const audition = this.audition;
    if (!audition) return;
    const stale = "clip" in audition
      ? this.findAudioClip(audition.clip.id) !== audition.clip
      : audition.tracks.some((track) => this.project.tracks.find(({ id }) => id === track.id)?.clips !== track.clips);
    if (stale) this.stopAudition();
  }

  private stopAudition(): void {
    const audition = this.audition;
    if (!audition) return;
    batch(() => {
      this.auditionSource.value = null;
      if ("clip" in audition) audition.cancel?.();
      else audition.clock?.destroy();
    });
  }

  /** Repeat one project-second range over a group of audio tracks, independently of Arrangement. */
  async auditionRange(range: LoopRange, options: { trackIds?: readonly string[] } = {}): Promise<void> {
    if (this.destroyed) throw new Error("Workspace is destroyed.");
    const { start, end } = range;
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end - start < 1 / this.context.sampleRate)
      throw new RangeError("Workspace range audition needs a non-negative range at least one audio frame long.");
    const ids = options.trackIds ? new Set(options.trackIds) : undefined;
    const tracks = this.project.tracks.filter((track) => track.kind === "audio" && (!ids || ids.has(track.id)));
    if (!tracks.length || (ids && tracks.length !== ids.size)) throw new Error("Workspace range audition needs existing audio tracks.");
    const clips = tracks.flatMap((track) => track.clips.filter((clip): clip is AudioClip =>
      clip.kind === "audio" && clip.time < end && clip.time + clip.duration > start,
    ));
    if (!clips.length) throw new Error("Workspace range audition needs audio in the selected range.");
    const state = Object.freeze({ start, end, trackIds: Object.freeze(tracks.map(({ id }) => id)) });
    const audition: RangeAudition = { range: state, tracks };
    batch(() => {
      this.stopAudition();
      this.auditionSource.value = audition;
    });
    try {
      await this.context.resume();
      if (this.audition !== audition) return;
      await Promise.all(clips.map((clip) => {
        if (!clip.media || clip.time >= start + 0.15) return undefined;
        const index = Math.floor(Math.max(0, start - clip.time) / audioChunkSeconds);
        return this.loadMediaBuffer(clip, index);
      }));
      if (this.audition !== audition) return;
      this.stopStaleAudition();
      if (this.audition !== audition) return;

      const loop = new RangeLoop(state, this.context.currentTime + 0.025);
      const timeline = new Timeline({ audioContext: this.context });
      const scheduled = new Map<string, AudioHandle>();
      const clock = new Clock({ timeline, lookAhead: 0.15, tickInterval: 0.025, onTick: (window) => {
        const audioStart = timeline.beatToTime(window.beat.start);
        for (const slice of loop.slices(audioStart, window.time.lookAheadEnd)) {
          const span: AudioClipWindow = {
            start: slice.start,
            end: slice.end,
            stop: end,
            audioTime: (time) => slice.when + (time - slice.start),
            keyPrefix: `${slice.cycle}:`,
          };
          for (const clip of clips) this.scheduleAudioClipWindow(clip, this.output, span, window, scheduled);
        }
      }});
      audition.clock = clock;
      clock.start();
      clock.refresh();
    } catch (error) {
      if (this.audition !== audition) return;
      this.stopAudition();
      throw error;
    }
  }

  stopRangeAudition(): void {
    if (this.audition && "range" in this.audition) this.stopAudition();
  }

  /** Render a clip from its retained source and defer the project mutation to the caller's undo transaction. */
  async prepareAudioClipStretch(
    clipId: string,
    ratio: number,
    processor?: WaveStretchProcessor,
    options: { signal?: AbortSignal } = {},
  ): Promise<PreparedClipStretch> {
    if (this.destroyed) throw new Error("Workspace is destroyed.");
    options.signal?.throwIfAborted();
    const clip = this.findAudioClip(clipId);
    if (!clip) throw new Error("Workspace clip stretch needs an audio clip.");
    const source = clip.stretch?.source ?? clip;
    if (!Number.isFinite(ratio) || ratio <= 0 || Math.round(audioFrameCount(source) * ratio) < 1 || !Number.isSafeInteger(Math.round(audioFrameCount(source) * ratio)))
      throw new RangeError("Workspace clip stretch ratio must produce at least one sample.");
    if (ratio !== 1 && !processor) throw new Error("Workspace clip stretch needs a processor.");

    this.clipStretchJobs.get(clipId)?.abort();
    const job = new AbortController();
    const signal = options.signal ? AbortSignal.any([options.signal, job.signal]) : job.signal;
    this.clipStretchJobs.set(clipId, job);
    const release = () => {
      signal.removeEventListener("abort", release);
      if (this.clipStretchJobs.get(clipId) === job) this.clipStretchJobs.delete(clipId);
    };
    const check = () => {
      signal.throwIfAborted();
      if (this.clipStretchJobs.get(clipId) !== job || this.destroyed)
        throw new DOMException("Audio clip stretch was cancelled.", "AbortError");
    };
    signal.addEventListener("abort", release, { once: true });
    try {
      check();
      let rendered: Awaited<ReturnType<WaveStretchProcessor["process"]>> | undefined;
      if (ratio !== 1) {
        const channels = source.media
          ? await source.media.readFrames(source.startFrame, source.frameCount)
          : source.channels.map((channel) => channel.slice());
        check();
        rendered = await processor!.process({ sampleRate: source.sampleRate, channels }, { ratio, signal });
        check();
      }
      return Object.freeze({
        apply: () => {
          try {
            check();
            return this.project.applyAudioClipStretch(clip, ratio, rendered);
          } finally {
            release();
          }
        },
      });
    } catch (error) {
      release();
      throw error;
    }
  }

  async save(): Promise<Uint8Array> {
    if (this.destroyed) throw new Error("Workspace is destroyed.");
    await this.flush();
    await this.serialize(() => this.captureStates());
    if (this.project.hasFileBackedAudio) {
      const chunks: Uint8Array[] = [];
      let length = 0;
      await saveDawProjectTo(
        this.project,
        new WritableStream({
          write: (chunk) => {
            chunks.push(chunk);
            length += chunk.length;
          },
        }),
      );
      const bytes = new Uint8Array(length);
      let at = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, at);
        at += chunk.length;
      }
      return bytes;
    }
    return saveDawProject(this.project);
  }

  /** Stream the project to a caller-owned file or other WritableStream. */
  async saveTo(destination: WritableStream<Uint8Array>): Promise<void> {
    if (this.destroyed) throw new Error("Workspace is destroyed.");
    await this.flush();
    await this.serialize(() => this.captureStates());
    await saveDawProjectTo(this.project, destination);
  }

  /** Describe what another DAW receives; an audio fallback is a separate export. */
  portabilityReport(): PortabilityReport {
    if (this.destroyed) throw new Error("Workspace is destroyed.");
    const devices = this.project.tracks.flatMap((track) => track.devices);
    const clips = this.project.tracks.flatMap((track) => track.clips);
    return {
      standardContent: [
        this.project.tempoMap.changes.length ? "DAWproject track layout and step tempo automation" : "DAWproject track layout and fixed tempo",
        ...(clips.some((clip) => clip.kind === "audio") ? ["audio clips"] : []),
        ...(clips.some((clip) => clip.kind === "audio" && (clip.envelope?.fadeIn || clip.envelope?.fadeOut)) ? ["audio clip fades"] : []),
        ...(clips.some((clip) => clip.kind === "midi") ? ["MIDI notes and supported controllers"] : []),
        ...(this.project.markers.length ? ["markers"] : []),
        ...(this.project.tracks.some((track) => track.volumeAutomation.length) ? ["track volume automation"] : []),
      ],
      pluginDependencies: devices.map((device) => `${device.name} (${device.pluginId}) needs a matching CLAP plug-in in the receiving DAW`),
      limitations: [
        "Other DAWs may not preserve Audiorective-specific MIDI details or WebCLAP bundle locations.",
        ...(clips.some((clip) => clip.kind === "audio" && clip.envelope && clip.envelope.gain !== 1)
          ? ["Audio clip gain is stored in Audiorective metadata. Use the rendered fallback to preserve it in other DAWs."]
          : []),
        ...(clips.some((clip) => clip.kind === "audio" && clip.gainAutomation)
          ? ["Audio clip gain automation is stored in Audiorective metadata. Use the rendered fallback to preserve it in other DAWs."]
          : []),
        ...(this.project.tracks.some((track) => track.effects.length) ? ["Audiorective built-in inserts require Audiorective or the rendered audio fallback."] : []),
        ...(clips.some((clip) => clip.kind === "audio" && clip.stretch)
          ? ["Time-stretched clips contain rendered audio for playback. Audiorective stores the original sources separately for re-editing."]
          : []),
        "Editable import in a specific DAW needs an actual open-and-save test.",
        "A separate audio fallback is needed to hear hosted plug-ins without matching CLAP binaries.",
        ...(this.project.tracks.length > 15 ? ["Audio fallback includes a mix only when a project has more than 15 tracks."] : []),
        ...this.warnings,
      ],
    };
  }

  /** Render mix and post-mixer track stems in real time to a companion ZIP of float32 WAVs. */
  async exportAudioFallbackTo(destination: WritableStream<Uint8Array>, options: AudioFallbackOptions = {}): Promise<void> {
    if (this.destroyed) throw new Error("Workspace is destroyed.");
    const tail = options.tailSeconds ?? 1;
    if (!Number.isFinite(tail) || tail < 0 || tail > 60) throw new RangeError("Workspace audio fallback tail must be from 0 to 60 seconds.");
    const signal = options.signal;
    const checkAbort = () => {
      if (signal?.aborted) throw new DOMException("Workspace audio fallback was cancelled.", "AbortError");
    };
    let project: Project | undefined;
    let context: AudioContext | undefined;
    let recorder: AudioRecorder | undefined;
    let mediaWriter: Awaited<ReturnType<typeof createOpfsAudioMediaWriter>> | undefined;
    let media: AudioMedia | undefined;
    let render: Workspace | undefined;
    let archiveStarted = false;
    let progressTimer: ReturnType<typeof setInterval> | undefined;
    const cancel = () => recorder?.cancel();
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      checkAbort();
      await this.flush();
      await this.serialize(() => this.captureStates());
      const renderProject = this.project.snapshot();
      project = renderProject;
      context = new AudioContext({ sampleRate: this.context.sampleRate });
      const renderContext = context;
      await context.resume();
      render = await Workspace.create(context, renderProject, { workletUrl: this.options.workletUrl, resolveBundle: this.options.resolveBundle });
      if (render.warnings.length) throw new Error(`Workspace audio fallback has unresolved devices: ${render.warnings.join(" ")}`);
      const stemTracks = renderProject.tracks.length <= 15 ? renderProject.tracks : [];
      const buses = [
        { path: "mix.wav", node: render.output },
        ...stemTracks.map((track) => ({
          path: `tracks/${track.id}.wav`,
          node: render!.tracks.get(track.id)!.panner as AudioNode,
        })),
      ];
      const channels = buses.length * 2;
      const merger = context.createChannelMerger(channels);
      for (let index = 0; index < buses.length; index++) {
        const splitter = context.createChannelSplitter(2);
        buses[index].node.connect(splitter);
        splitter.connect(merger, 0, index * 2);
        splitter.connect(merger, 1, index * 2 + 1);
      }
      recorder = new AudioRecorder(context, { channels });
      merger.connect(recorder.input);
      mediaWriter = await createOpfsAudioMediaWriter(context.sampleRate, channels);
      await recorder.ready;
      checkAbort();
      await recorder.startStream((chunk) => mediaWriter!.writeChunk(chunk));
      checkAbort();
      // Let recorder worklet startup settle before project time zero.
      await new Promise((resolve) => setTimeout(resolve, 250));
      checkAbort();
      await render.play();
      checkAbort();
      const origin = render.timeline.beatToTime(0);
      const duration = Math.max(this.duration, 0.1) + tail;
      const originFrame = Math.ceil(origin * context.sampleRate);
      const endFrame = Math.ceil((origin + duration) * context.sampleRate);
      progressTimer = setInterval(() => options.onProgress?.(Math.min(1, Math.max(0, (renderContext.currentTime - origin) / duration))), 250);
      const span = await recorder.stopStream({ when: origin + duration });
      clearInterval(progressTimer);
      progressTimer = undefined;
      checkAbort();
      if (span.dropouts?.some((gap) => gap.startFrame < endFrame && gap.endFrame > originFrame))
        throw new Error("Workspace audio fallback lost audio frames during the project; retry the export.");
      media = await mediaWriter.finish(span);
      const startFrame = originFrame - span.startFrame;
      const frameCount = endFrame - originFrame;
      if (startFrame < 0 || startFrame + frameCount > media.frameCount) throw new Error("Workspace audio fallback missed the project start or end.");
      const files: StoredZipEntry[] = buses.map((bus, index) => wavMediaStereoPairEntry(bus.path, media!, startFrame, frameCount, index));
      const manifest = new TextEncoder().encode(
        JSON.stringify(
          {
            format: "audiorective-audio-fallback",
            version: 1,
            title: renderProject.title,
            sampleRate: context.sampleRate,
            durationSeconds: (endFrame - originFrame) / context.sampleRate,
            mix: "mix.wav",
            tracks: stemTracks.map((track) => ({ id: track.id, name: track.name, path: `tracks/${track.id}.wav` })),
            stemsOmitted: renderProject.tracks.length > 15,
          },
          null,
          2,
        ),
      );
      files.push({
        path: "manifest.json",
        size: manifest.length,
        async *chunks() {
          yield manifest;
        },
      });
      checkAbort();
      archiveStarted = true;
      await writeStoredZip(files, destination, signal);
      options.onProgress?.(1);
    } catch (error) {
      if (!archiveStarted) await destination.abort(error).catch(() => undefined);
      throw error;
    } finally {
      if (progressTimer) clearInterval(progressTimer);
      signal?.removeEventListener("abort", cancel);
      cancel();
      recorder?.destroy();
      await mediaWriter?.abort();
      await media?.dispose();
      render?.destroy();
      project?.destroy();
      await context?.close();
    }
  }

  private async prefetchMediaAt(position: number): Promise<void> {
    await Promise.all(
      [...this.tracks.values()].flatMap((track) =>
        track.clips.flatMap((clip) => {
          if (clip.kind !== "audio" || !clip.media || position < clip.time || position >= clip.time + clip.duration) return [];
          const framesPerChunk = clip.sampleRate * audioChunkSeconds;
          const index = Math.floor(((position - clip.time) * clip.sampleRate) / framesPerChunk);
          return [this.loadMediaBuffer(clip, index)];
        }),
      ),
    );
  }

  private async captureStates(): Promise<void> {
    const project = this.project;
    for (const track of project.tracks)
      for (const device of track.devices) {
        const host = this.host(device.id);
        const runtime = this.tracks.get(track.id);
        if (host && runtime?.deviceStates.get(device.id) === device.state) {
          const state = await host.saveState();
          if (this.destroyed || this.project !== project) return;
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
    this.launcher.advance();
    for (const sequence of this.stepSequencers.keys()) sequence.schedule(window, this.timeline);
    const map = this.activeTempoMap;
    const span: AudioClipWindow = {
      start: map.beatToSeconds(window.beat.start),
      end: map.beatToSeconds(window.beat.end),
      stop: Infinity,
      audioTime: (seconds) => this.timeline.beatToTime(map.secondsToBeat(seconds)),
      keyPrefix: "",
    };
    for (const runtime of this.tracks.values()) {
      for (const clip of runtime.clips) {
        if (clip.kind === "midi") {
          if (!runtime.midiHost) continue;
          for (const event of clip.playbackEvents()) {
            const beat = clip.timeUnit === "beats" ? clip.time + event.time : map.secondsToBeat(clip.time + event.time);
            if (beat < window.beat.start - 1e-8 || beat >= window.beat.end - 1e-8) continue;
            const when = this.timeline.beatToTime(beat);
            window.own(runtime.midiHost.scheduleMidi(event.data, when), when);
          }
        } else {
          this.scheduleAudioClipWindow(clip, runtime.session?.arrangementInput ?? runtime.input, span, window, this.scheduledAudio);
        }
      }
    }
  }

  private scheduleAudioClipWindow(
    clip: AudioClip,
    destination: AudioNode,
    span: AudioClipWindow,
    window: TickWindow<Record<never, never>>,
    scheduled: Map<string, AudioHandle>,
  ): void {
    if (clip.time >= span.end || clip.time + clip.duration <= span.start) return;
    const own = (key: string, handle: AudioHandle, when: number) => {
      scheduled.set(key, handle);
      handle.onEnded(() => {
        if (scheduled.get(key) === handle) scheduled.delete(key);
      });
      window.own(handle, when);
    };
    if (clip.media) {
      const framesPerChunk = clip.sampleRate * audioChunkSeconds;
      const first = Math.floor((Math.max(0, span.start - clip.time) * clip.sampleRate) / framesPerChunk);
      const last = Math.min(Math.ceil(clip.frameCount / framesPerChunk), Math.ceil(((span.end - clip.time) * clip.sampleRate) / framesPerChunk));
      for (let index = first; index < last; index++) {
        const key = `${span.keyPrefix}${clip.id}:${index}`;
        if (scheduled.has(key)) continue;
        const chunkTime = clip.time + index * audioChunkSeconds;
        const from = Math.max(chunkTime, span.start);
        const when = span.audioTime(from);
        own(key, this.scheduleMediaAudio(clip, index, destination, when, from - chunkTime, span.stop - chunkTime), when);
      }
    } else {
      const key = `${span.keyPrefix}${clip.id}`;
      if (scheduled.has(key)) return;
      const from = Math.max(clip.time, span.start);
      const when = span.audioTime(from);
      own(key, this.scheduleAudio(clip, destination, when, from - clip.time, span.stop - clip.time), when);
    }
  }

  private loadMediaBuffer(clip: AudioClip & { media: AudioMedia; startFrame: number; frameCount: number }, index: number): Promise<AudioBuffer> {
    const framesPerChunk = clip.sampleRate * audioChunkSeconds;
    const offset = index * framesPerChunk;
    const count = Math.min(framesPerChunk, clip.frameCount - offset);
    if (count < 1) return Promise.reject(new RangeError("Workspace media chunk is outside the clip."));
    let cache = this.mediaBuffers.get(clip.media);
    if (!cache) this.mediaBuffers.set(clip.media, (cache = new Map()));
    const key = `${clip.startFrame + offset}:${count}`;
    const existing = cache.get(key);
    if (existing) return existing;
    const pending = clip.media
      .readFrames(clip.startFrame + offset, count)
      .then((channels) => {
        const buffer = this.context.createBuffer(channels.length, count, clip.sampleRate);
        channels.forEach((samples, channel) => buffer.copyToChannel(samples as Float32Array<ArrayBuffer>, channel));
        return buffer;
      })
      .catch((error: unknown) => {
        cache!.delete(key);
        throw error;
      });
    cache.set(key, pending);
    if (cache.size > 8) cache.delete(cache.keys().next().value!);
    return pending;
  }

  private connectClipSource(
    source: AudioBufferSourceNode,
    destination: AudioNode,
    clip: AudioClip,
    when: number,
    offset: number,
    length: number,
  ): { setAutomation(automation: AudioClipGainAutomation | undefined): void; dispose(): void } {
    let output: AudioNode = source;
    let envelopeGain: GainNode | undefined;
    if (clip.envelope) {
      envelopeGain = this.context.createGain();
      scheduleClipEnvelope(envelopeGain.gain, clip.envelope, clip.duration, { when, offset, length });
      output = source.connect(envelopeGain);
    }
    output.connect(destination);
    const secondsPerUnit = clip.duration / audioClipSourceDuration(clip);
    let gain: GainNode | undefined;
    let binding: AutomationBinding | undefined;
    let sourceStart: number | undefined;
    const setAutomation = (automation: AudioClipGainAutomation | undefined) => {
      if (!automation) {
        binding?.destroy();
        binding = undefined;
        gain?.gain.setValueAtTime(1, this.context.currentTime);
        return;
      }
      if (!(length > 0) || !(secondsPerUnit > 0)) return;
      if (binding && sourceStart === automation.sourceStart) {
        binding.curve.value = automation.points;
        return;
      }
      if (!gain) {
        gain = this.context.createGain();
        output.disconnect(destination);
        output.connect(gain).connect(destination);
      }
      binding?.destroy();
      binding = new AutomationBinding(this.context, new AutomationCurve(automation.points), audioParamTarget(gain.gain));
      sourceStart = automation.sourceStart;
      const from = sourceStart + offset / secondsPerUnit;
      const elapsed = Math.max(0, this.context.currentTime - when);
      const to = from + length / secondsPerUnit;
      binding.start({ when, from: Math.min(to, from + elapsed / secondsPerUnit), to, secondsPerUnit });
    };
    return {
      setAutomation,
      dispose() {
        binding?.destroy();
        envelopeGain?.disconnect();
        gain?.disconnect();
      },
    };
  }

  private scheduleMediaAudio(
    clip: AudioClip & { media: AudioMedia; startFrame: number; frameCount: number },
    index: number,
    destination: AudioNode,
    when: number,
    offset: number,
    endOffset = Infinity,
  ): AudioHandle {
    let cancelled = false;
    let ended = false;
    let source: AudioBufferSourceNode | undefined;
    let stage: ReturnType<Workspace["connectClipSource"]> | undefined;
    let automation = clip.gainAutomation;
    const listeners = new Set<() => void>();
    const end = () => {
      if (ended) return;
      ended = true;
      source?.disconnect();
      stage?.dispose();
      for (const listener of listeners) listener();
      listeners.clear();
    };
    void this.loadMediaBuffer(clip, index)
      .then((buffer) => {
        if (cancelled) return end();
        source = this.context.createBufferSource();
        source.buffer = buffer;
        source.onended = end;
        const start = Math.max(when, this.context.currentTime);
        const adjustedOffset = offset + Math.max(0, start - when);
        const length = Math.min(buffer.duration, endOffset) - adjustedOffset;
        if (length <= 0) return end();
        stage = this.connectClipSource(source, destination, clip, start, index * audioChunkSeconds + adjustedOffset, length);
        stage.setAutomation(automation);
        source.start(start, adjustedOffset, length);
      })
      .catch((error: unknown) => {
        this.warn(`Audio clip ${clip.id} could not read its media: ${String(error)}`);
        end();
      });
    return {
      clipId: clip.id,
      setGainAutomation: (next) => {
        automation = next;
        stage?.setAutomation(next);
      },
      cancel: () => {
        cancelled = true;
        if (source && !ended)
          try {
            source.stop();
          } catch {
            /* already stopped */
          }
        end();
      },
      onEnded: (listener) => {
        if (ended) listener();
        else listeners.add(listener);
      },
    };
  }

  private bufferFor(clip: PcmAudioClip): AudioBuffer {
    let buffer = this.audioBuffers.get(clip.channels);
    if (!buffer) {
      buffer = this.context.createBuffer(clip.channels.length, clip.channels[0].length, clip.sampleRate);
      clip.channels.forEach((samples, index) => buffer!.getChannelData(index).set(samples));
      this.audioBuffers.set(clip.channels, buffer);
    }
    return buffer;
  }

  private sessionBufferFor(clip: PcmAudioClip): AudioBuffer {
    const { envelope, gainAutomation } = clip;
    if (!envelope && !gainAutomation) return this.bufferFor(clip);
    let buffer = this.sessionAudioBuffers.get(clip);
    if (!buffer) {
      buffer = this.context.createBuffer(clip.channels.length, clip.channels[0].length, clip.sampleRate);
      const output = clip.channels.map((_, index) => buffer!.getChannelData(index));
      const curve = gainAutomation && new AutomationCurve(gainAutomation.points);
      const sourceRate = audioClipSourceDuration(clip) / clip.duration;
      for (let frame = 0; frame < buffer.length; frame++) {
        const time = frame / clip.sampleRate;
        const gain = (envelope ? clipGainAt(envelope, clip.duration, time) : 1) *
          (curve?.valueAt(gainAutomation!.sourceStart + time * sourceRate) ?? 1);
        for (let channel = 0; channel < output.length; channel++) output[channel][frame] = clip.channels[channel][frame] * gain;
      }
      this.sessionAudioBuffers.set(clip, buffer);
    }
    return buffer;
  }

  private scheduleAudio(clip: PcmAudioClip, destination: AudioNode, when: number, offset: number, endOffset = Infinity): AudioHandle {
    const source = this.context.createBufferSource();
    source.buffer = this.bufferFor(clip);
    const start = Math.max(when, this.context.currentTime);
    const adjustedOffset = Math.min(clip.duration, offset + Math.max(0, start - when));
    const length = Math.max(0, Math.min(clip.duration, endOffset) - adjustedOffset);
    const stage = this.connectClipSource(source, destination, clip, start, adjustedOffset, length);
    stage.setAutomation(clip.gainAutomation);
    let ended = false;
    const listeners = new Set<() => void>();
    const end = () => {
      if (ended) return;
      ended = true;
      source.onended = null;
      source.disconnect();
      stage.dispose();
      for (const listener of listeners) listener();
      listeners.clear();
    };
    source.onended = end;
    source.start(start, adjustedOffset, length);
    return {
      clipId: clip.id,
      setGainAutomation: (automation) => stage.setAutomation(automation),
      cancel: () => {
        if (!ended) {
          try {
            source.stop();
          } catch {
            /* already stopped */
          } finally {
            end();
          }
        }
      },
      onEnded: (listener) => {
        if (ended) listener();
        else listeners.add(listener);
      },
    };
  }

  private panic(): void {
    for (const track of this.tracks.values()) for (const host of track.hosts.values()) host.panic();
  }

  private cancelAudio(): void {
    for (const handle of this.scheduledAudio.values()) handle.cancel();
    this.scheduledAudio.clear();
  }

  private disposeTrack(runtime: TrackRuntime): void {
    runtime.session?.destroy();
    runtime.rack.destroy();
    for (const host of runtime.hosts.values()) host.destroy();
    runtime.automationBinding?.destroy();
    runtime.automationGain.disconnect();
    runtime.gain.disconnect();
    this.disposeRouting(runtime);
  }

  private disposeTracks(): void {
    for (const off of this.sequenceOff.splice(0)) off();
    for (const runtime of this.tracks.values()) this.disposeTrack(runtime);
    this.tracks.clear();
    this.scheduledAudio.clear();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.stopWatchingProject?.();
    this.stop();
    this.destroyed = true;
    this.stopAudition();
    for (const job of this.clipStretchJobs.values()) job.abort();
    this.clock.destroy();
    for (const detach of [...this.stepSequencers.values()]) detach();
    this.disposeTracks();
    this.output.disconnect();
  }
}
