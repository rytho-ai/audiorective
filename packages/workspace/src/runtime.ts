import { Clock, Timeline } from "@audiorective/clock";
import type { TickWindow } from "@audiorective/clock";
import { batch, cell, effect, readonlyCell, untracked, type Cell, type ReadonlyCell, type Readable } from "@audiorective/core";
import { AutomationBinding, AutomationCurve, audioParamTarget } from "@audiorective/core/automation";
import type { AutomationPoint } from "@audiorective/core/automation";
import { WebClapHost } from "@audiorective/host/webclap";
import { AudioRecorder } from "@audiorective/blocks";
import { EffectRack, type RackEffect } from "@audiorective/blocks/effect-rack";
import { openDawProject, openDawProjectBlob, saveDawProject, saveDawProjectTo } from "./dawproject";
import { createOpfsAudioMediaWriter } from "./media";
import { MidiClip, Project } from "./model";
import type { TempoMap } from "./tempo-map";
import { writeStoredZip } from "./stored-zip";
import type { StoredZipEntry } from "./stored-zip";
import { wavMediaStereoPairEntry } from "./wav";
import type { AudioMedia } from "./media";
import type { AudioClip, ProjectTrack, WebClapDevice } from "./model";

type AudioHandle = { cancel(): void; onEnded(listener: () => void): void };
type TrackRuntime = {
  kind: ProjectTrack["kind"];
  deviceKeys: readonly string[];
  deviceStates: Map<string, Uint8Array>;
  gain: GainNode;
  automationGain: GainNode;
  rack: EffectRack;
  effectSettings: readonly RackEffect[];
  automationPoints?: readonly AutomationPoint[];
  automationCurve?: AutomationCurve;
  automationBinding?: AutomationBinding;
  panner: StereoPannerNode;
  input: AudioNode;
  hosts: Map<string, WebClapHost>;
  midiHost?: WebClapHost;
};
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
  /**
   * Observable runtime state. `needsSync` is true when the Project's track/device topology differs from the
   * loaded runtime; call `sync()` to rebuild. `error` holds the message of the latest failed application.
   * `warnings` is a frozen snapshot of non-fatal notices (unresolved devices, unreadable media, import fidelity); each change replaces it.
   */
  readonly cells: Readonly<{ needsSync: ReadonlyCell<boolean>; error: ReadonlyCell<string | null>; warnings: ReadonlyCell<readonly string[]> }>;

  private readonly projectSource: Cell<Project>;
  private readonly needsSyncSource = cell(false);
  private readonly errorSource = cell<string | null>(null);
  private readonly warningsSource = cell<readonly string[]>(Object.freeze([]));
  private readonly options: WorkspaceOptions;
  private readonly tracks = new Map<string, TrackRuntime>();
  private readonly scheduledAudio = new Map<string, AudioHandle>();
  private readonly audioBuffers = new WeakMap<AudioClip, AudioBuffer>();
  private readonly mediaBuffers = new WeakMap<AudioMedia, Map<string, Promise<AudioBuffer>>>();
  private readonly sequenceOff: Array<() => void> = [];
  private readonly seekPoint = cell({ seconds: 0 });
  private activeTempoMap: TempoMap;
  private destroyed = false;
  private stopWatching: (() => void) | undefined;
  /** Serializes automatic applications with `sync()`. */
  private chain: Promise<void> = Promise.resolve();
  /** The in-flight automatic application burst, or null when idle. */
  private pending: Promise<void> | null = null;
  private dirty = false;
  private failure: unknown = null;
  /** The Project and revision the runtime last reflected or evaluated. */
  private appliedProject: Project | undefined;
  private appliedRevision = -1;
  /** Greater than zero while the runtime writes its own edits into Project. */
  private quiet = 0;

  private constructor(context: AudioContext, project: Project, options: WorkspaceOptions) {
    this.context = context;
    this.projectSource = cell(project);
    this.activeTempoMap = project.tempoMap;
    this.options = options;
    this.output = context.createGain();
    if (options.destination) this.output.connect(options.destination);
    this.timeline = new Timeline({ audioContext: context, bpm: project.bpm });
    this.clock = new Clock({ timeline: this.timeline, lookAhead: 0.15, tickInterval: 0.025, onTick: (window) => this.schedule(window) });
    this.cells = Object.freeze({
      needsSync: readonlyCell(this.needsSyncSource),
      error: readonlyCell(this.errorSource),
      warnings: readonlyCell(this.warningsSource),
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

  /** Frozen snapshot of non-fatal notices; tracked. The same value as `cells.warnings`. */
  get warnings(): readonly string[] {
    return this.cells.warnings.value;
  }

  private addWarnings(notices: readonly string[], position: "start" | "end" = "end"): void {
    if (!notices.length) return;
    const current = untracked(() => this.warningsSource.value);
    this.warningsSource.value = Object.freeze(position === "start" ? [...notices, ...current] : [...current, ...notices]);
  }

  get project(): Project {
    return this.projectSource.value;
  }

  set project(project: Project) {
    this.projectSource.value = project;
  }

  static async create(context: AudioContext, project: Project, options: WorkspaceOptions = {}): Promise<Workspace> {
    const workspace = new Workspace(context, project, options);
    try {
      await workspace.sync();
      workspace.watch();
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
      workspace.addWarnings(opened.warnings, "start");
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
      workspace.addWarnings(opened.warnings, "start");
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

  /** Watch the Project so light edits apply automatically; started after the first sync. */
  private watch(): void {
    this.stopWatching = effect(() => {
      const project = this.projectSource.value;
      const revision = project.cells.revision.value;
      untracked(() => {
        if (this.quiet || this.destroyed) return;
        if (project !== this.appliedProject || revision !== this.appliedRevision) this.scheduleApply();
      });
    });
  }

  private revisionNow(): number {
    return untracked(() => this.project.cells.revision.value);
  }

  private markApplied(): void {
    this.appliedProject = this.project;
    this.appliedRevision = this.revisionNow();
  }

  private isCurrent(): boolean {
    return this.appliedProject === this.project && this.appliedRevision === this.revisionNow();
  }

  /** Write an edit made by the runtime itself into Project without re-applying it. */
  private runtimeEdit(edit: () => void): void {
    const current = this.isCurrent();
    this.quiet++;
    try {
      edit();
    } finally {
      this.quiet--;
    }
    if (current) this.markApplied();
  }

  private exclusive<T>(task: () => Promise<T>): Promise<T> {
    const result = this.chain.then(task);
    this.chain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private setError(error: unknown): void {
    this.failure = error;
    this.errorSource.value = error instanceof Error ? error.message : String(error);
  }

  private clearError(): void {
    this.failure = null;
    this.errorSource.value = null;
  }

  /** Coalesce edits into one application per microtask burst; later edits queue exactly one more run. */
  private scheduleApply(): void {
    if (this.destroyed) return;
    this.dirty = true;
    if (this.pending) return;
    this.pending = (async () => {
      await Promise.resolve();
      try {
        while (this.dirty && !this.destroyed) {
          this.dirty = false;
          if (this.isCurrent()) continue;
          try {
            await this.exclusive(() => this.applyLight());
          } catch (error) {
            if (!this.destroyed) this.setError(error);
          }
        }
      } finally {
        this.pending = null;
      }
    })();
  }

  /** Wait for automatic application to settle, ignoring failures. */
  private async idle(): Promise<void> {
    if (!this.destroyed && !this.isCurrent() && !this.pending) this.scheduleApply();
    while (this.pending) await this.pending;
    await this.chain;
  }

  /**
   * Resolve when every pending automatic application has finished; reject with the error of the latest
   * failed application (also in `cells.error`). After `destroy()` it resolves once in-flight work settles.
   */
  async flush(): Promise<void> {
    await this.idle();
    if (!this.destroyed && this.failure !== null) throw this.failure;
  }

  /** Rebuild runtime routing after structural Project edits and clear `cells.needsSync`. Stops transport. */
  async sync(): Promise<void> {
    if (this.destroyed) throw new Error("Workspace is destroyed.");
    await this.exclusive(() => this.rebuild());
  }

  private async rebuild(): Promise<void> {
    if (this.destroyed) throw new Error("Workspace is destroyed.");
    this.markApplied();
    try {
      await this.rebuildTracks();
      this.needsSyncSource.value = false;
      this.clearError();
    } catch (error) {
      this.needsSyncSource.value = true;
      this.setError(error);
      throw error;
    }
  }

  private async rebuildTracks(): Promise<void> {
    const position = this.position;
    this.stop();
    this.activeTempoMap = this.project.tempoMap;
    await this.captureStates();
    this.disposeTracks();
    const created: TrackRuntime[] = [];
    try {
      for (const track of this.project.tracks) {
        const gain = this.context.createGain();
        const automationGain = this.context.createGain();
        const panner = this.context.createStereoPanner();
        automationGain.connect(gain);
        gain.connect(panner).connect(this.output);
        const runtime: TrackRuntime = {
          kind: track.kind,
          deviceKeys: deviceKeys(track),
          deviceStates: new Map(track.devices.map((device) => [device.id, device.state])),
          gain,
          automationGain,
          rack: new EffectRack(this.context, track.effects),
          effectSettings: track.effects,
          panner,
          input: automationGain,
          hosts: new Map(),
        };
        created.push(runtime);
        runtime.input = runtime.rack.input;
        runtime.rack.output.connect(automationGain);
        let previous: WebClapHost | undefined;
        for (const device of track.devices) {
          const bundleUrl = (await this.options.resolveBundle?.(device)) ?? device.bundleUrl;
          if (!bundleUrl) {
            this.addWarnings([`Device ${device.name} has no WebCLAP bundle.`]);
            continue;
          }
          try {
            const host = await WebClapHost.load(this.context, { url: bundleUrl, workletUrl: this.options.workletUrl });
            if (host.descriptor?.id !== device.pluginId) {
              host.destroy();
              this.addWarnings([`Device ${device.name} has a different CLAP ID in its bundle.`]);
              continue;
            }
            if (device.state.length) await host.loadState(device.state);
            runtime.hosts.set(device.id, host);
            if (track.kind === "midi" && !runtime.midiHost) runtime.midiHost = host;
            if (previous) previous.output.connect(host.input);
            previous = host;
          } catch (error) {
            this.addWarnings([`Device ${device.name} could not load: ${String(error)}`]);
          }
        }
        if (previous) {
          previous.output.connect(runtime.rack.input);
          runtime.input = [...runtime.hosts.values()][0].input;
        }
        this.updateAutomation(runtime, track);
        this.tracks.set(track.id, runtime);
      }
      this.applyMixer();
      this.bindSequences();
      this.seek(position);
    } catch (error) {
      for (const runtime of created) {
        runtime.rack.destroy();
        for (const host of runtime.hosts.values()) host.destroy();
        runtime.automationBinding?.destroy();
        runtime.automationGain.disconnect();
        runtime.gain.disconnect();
        runtime.panner.disconnect();
      }
      this.tracks.clear();
      throw error;
    }
  }

  /**
   * Apply light Project edits in place. A topology change sets `cells.needsSync` and applies nothing,
   * so transport and loaded hosts stay untouched until the caller runs `sync()`.
   */
  private async applyLight(): Promise<void> {
    if (this.destroyed) return;
    this.markApplied();
    const position = this.position;
    const tracks = this.project.tracks;
    const sameTopology =
      tracks.length === this.tracks.size &&
      tracks.every((track) => {
        const runtime = this.tracks.get(track.id);
        const nextKeys = deviceKeys(track);
        return (
          runtime?.kind === track.kind &&
          runtime.deviceKeys.length === nextKeys.length &&
          runtime.deviceKeys.every((key, index) => key === nextKeys[index])
        );
      });
    this.needsSyncSource.value = !sameTopology;
    if (!sameTopology) {
      this.clearError();
      return;
    }
    if (this.activeTempoMap !== this.project.tempoMap) {
      this.activeTempoMap = this.project.tempoMap;
      this.seek(position);
    }
    for (const track of tracks) {
      const runtime = this.tracks.get(track.id)!;
      if (runtime.effectSettings !== track.effects) {
        runtime.rack.setEffects(track.effects);
        runtime.effectSettings = track.effects;
      }
      for (const device of track.devices) {
        if (runtime.deviceStates.get(device.id) === device.state) continue;
        const host = runtime.hosts.get(device.id);
        if (host) await host.loadState(device.state);
        if (this.destroyed) return;
        runtime.deviceStates.set(device.id, device.state);
      }
    }
    this.applyMixer();
    for (const track of tracks) this.updateAutomation(this.tracks.get(track.id)!, track);
    this.refreshArrangement();
    this.clearError();
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

  async play(): Promise<void> {
    if (this.destroyed) throw new Error("Workspace is destroyed.");
    await this.context.resume();
    const position = this.position;
    await this.prefetchMediaAt(position);
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
    this.positionAutomation(this.position, false);
    this.clock.pause();
    this.cancelAudio();
    this.panic();
  }
  stop(): void {
    batch(() => {
      this.clock.stop();
      this.seekPoint.value = { seconds: 0 };
    });
    this.positionAutomation(0, false);
    this.cancelAudio();
    this.panic();
  }
  seek(seconds: number): void {
    if (!Number.isFinite(seconds) || seconds < 0) throw new RangeError("Workspace seek needs non-negative seconds.");
    this.panic();
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
    this.panic();
    this.clock.refresh();
  }

  /** Apply clip arrangement edits without reloading track devices. */
  refreshArrangement(): void {
    if (this.destroyed) throw new Error("Workspace is destroyed.");
    this.cancelAudio();
    this.bindSequences();
    this.refresh();
  }

  private bindSequences(): void {
    for (const off of this.sequenceOff.splice(0)) off();
    for (const track of this.project.tracks)
      for (const clip of track.clips)
        if (clip instanceof MidiClip)
          this.sequenceOff.push(
            clip.sequence.subscribe(() => {
              if (this.clock.state.value === "playing") this.refresh();
            }),
          );
  }

  setTrackVolume(trackId: string, value: number): void {
    this.runtimeEdit(() => this.project.setTrackVolume(trackId, value));
    this.applyMixer();
  }

  setTrackMuted(trackId: string, muted: boolean): void {
    this.runtimeEdit(() => this.project.setTrackMuted(trackId, muted));
    this.applyMixer();
  }
  setTrackSolo(trackId: string, solo: boolean): void {
    this.runtimeEdit(() => this.project.setTrackSolo(trackId, solo));
    this.applyMixer();
  }
  setTrackPan(trackId: string, pan: number): void {
    this.runtimeEdit(() => this.project.setTrackPan(trackId, pan));
    this.applyMixer();
  }

  /** Apply a rack edit now without rebuilding WebCLAP devices or stopping transport. */
  setTrackEffects(trackId: string, effects: readonly RackEffect[]): void {
    const runtime = this.tracks.get(trackId);
    const track = this.project.tracks.find((item) => item.id === trackId);
    if (!runtime || !track) throw new Error("Workspace effects need a live track.");
    runtime.rack.setEffects(effects);
    this.runtimeEdit(() => this.project.setTrackEffects(trackId, runtime.rack.effects));
    runtime.effectSettings = this.project.tracks.find((item) => item.id === trackId)!.effects;
  }

  /** Borrow the post-insert, pre-mixer output for an analyser or display. */
  trackEffectOutput(trackId: string): AudioNode | undefined {
    return this.tracks.get(trackId)?.rack.output;
  }

  private applyMixer(): void {
    const anySolo = this.project.tracks.some((track) => track.solo);
    for (const track of this.project.tracks) {
      const runtime = this.tracks.get(track.id);
      if (!runtime) continue;
      runtime.gain.gain.setValueAtTime(track.muted || (anySolo && !track.solo) ? 0 : track.volume, this.context.currentTime);
      runtime.panner.pan.setValueAtTime(track.pan, this.context.currentTime);
    }
  }

  host(deviceId: string): WebClapHost | undefined {
    for (const track of this.tracks.values()) {
      const host = track.hosts.get(deviceId);
      if (host) return host;
    }
    return undefined;
  }

  async save(): Promise<Uint8Array> {
    if (this.destroyed) throw new Error("Workspace is destroyed.");
    await this.idle();
    await this.captureStates();
    if (this.project.tracks.some((track) => track.clips.some((clip) => clip.kind === "audio" && !!clip.media))) {
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
    await this.idle();
    await this.captureStates();
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
        ...(clips.some((clip) => clip.kind === "midi") ? ["MIDI notes and supported controllers"] : []),
        ...(this.project.markers.length ? ["markers"] : []),
        ...(this.project.tracks.some((track) => track.volumeAutomation.length) ? ["track volume automation"] : []),
      ],
      pluginDependencies: devices.map((device) => `${device.name} (${device.pluginId}) needs a matching CLAP plug-in in the receiving DAW`),
      limitations: [
        "Other DAWs may not preserve Audiorective-specific MIDI details or WebCLAP bundle locations.",
        ...(this.project.tracks.some((track) => track.effects.length)
          ? ["Audiorective built-in inserts require Audiorective or the rendered audio fallback."]
          : []),
        "Editable import in a specific DAW needs an actual open-and-save test.",
        "A separate audio fallback is needed to hear hosted plug-ins without matching CLAP binaries.",
        ...(this.project.tracks.length > 15 ? ["Audio fallback includes a mix only when a project has more than 15 tracks."] : []),
        ...untracked(() => this.warningsSource.value),
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
      await this.idle();
      await this.captureStates();
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
      this.project.tracks.flatMap((track) =>
        track.clips.flatMap((clip) => {
          if (clip.kind !== "audio" || !clip.media || position < clip.time || position >= clip.time + clip.duration) return [];
          const framesPerChunk = clip.sampleRate * 2;
          const index = Math.floor(((position - clip.time) * clip.sampleRate) / framesPerChunk);
          return [this.loadMediaBuffer(clip, index)];
        }),
      ),
    );
  }

  private async captureStates(): Promise<void> {
    for (const track of this.project.tracks)
      for (const device of track.devices) {
        const host = this.host(device.id);
        const runtime = this.tracks.get(track.id);
        if (host && runtime?.deviceStates.get(device.id) === device.state) {
          const state = await host.saveState();
          this.runtimeEdit(() => this.project.setDeviceState(device.id, state));
          runtime.deviceStates.set(
            device.id,
            this.project.tracks.find((item) => item.id === track.id)!.devices.find((item) => item.id === device.id)!.state,
          );
        }
      }
  }

  private schedule(window: TickWindow<Record<never, never>>): void {
    const map = this.activeTempoMap;
    const startSeconds = map.beatToSeconds(window.beat.start);
    const endSeconds = map.beatToSeconds(window.beat.end);
    for (const track of this.project.tracks) {
      const runtime = this.tracks.get(track.id);
      if (!runtime) continue;
      for (const clip of track.clips) {
        if (clip.kind === "midi") {
          if (!runtime.midiHost) continue;
          for (const event of clip.playbackEvents()) {
            const beat = clip.timeUnit === "beats" ? clip.time + event.time : map.secondsToBeat(clip.time + event.time);
            if (beat < window.beat.start - 1e-8 || beat >= window.beat.end - 1e-8) continue;
            const when = this.timeline.beatToTime(beat);
            window.own(runtime.midiHost.scheduleMidi(event.data, when), when);
          }
        } else if (clip.time < endSeconds && clip.time + clip.duration > startSeconds) {
          if (clip.media) {
            const framesPerChunk = clip.sampleRate * 2;
            const first = Math.floor((Math.max(0, startSeconds - clip.time) * clip.sampleRate) / framesPerChunk);
            const last = Math.min(
              Math.ceil(clip.frameCount / framesPerChunk),
              Math.ceil(((endSeconds - clip.time) * clip.sampleRate) / framesPerChunk),
            );
            for (let index = first; index < last; index++) {
              const key = `${clip.id}:${index}`;
              if (this.scheduledAudio.has(key)) continue;
              const chunkTime = clip.time + (index * framesPerChunk) / clip.sampleRate;
              const from = Math.max(chunkTime, startSeconds);
              const when = this.timeline.beatToTime(map.secondsToBeat(from));
              const handle = this.scheduleMediaAudio(clip, index, runtime.input, when, from - chunkTime);
              this.ownAudio(key, handle, window, when);
            }
          } else if (!this.scheduledAudio.has(clip.id)) {
            const from = Math.max(clip.time, startSeconds);
            const when = this.timeline.beatToTime(map.secondsToBeat(from));
            const handle = this.scheduleAudio(clip, runtime.input, when, from - clip.time);
            this.ownAudio(clip.id, handle, window, when);
          }
        }
      }
    }
  }

  private ownAudio(key: string, handle: AudioHandle, window: TickWindow<Record<never, never>>, when: number): void {
    this.scheduledAudio.set(key, handle);
    handle.onEnded(() => {
      if (this.scheduledAudio.get(key) === handle) this.scheduledAudio.delete(key);
    });
    window.own(handle, when);
  }

  private loadMediaBuffer(clip: AudioClip & { media: AudioMedia; startFrame: number; frameCount: number }, index: number): Promise<AudioBuffer> {
    const framesPerChunk = clip.sampleRate * 2;
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

  private scheduleMediaAudio(
    clip: AudioClip & { media: AudioMedia; startFrame: number; frameCount: number },
    index: number,
    destination: AudioNode,
    when: number,
    offset: number,
  ): AudioHandle {
    let cancelled = false;
    let ended = false;
    let source: AudioBufferSourceNode | undefined;
    const listeners = new Set<() => void>();
    const end = () => {
      if (ended) return;
      ended = true;
      source?.disconnect();
      for (const listener of listeners) listener();
      listeners.clear();
    };
    void this.loadMediaBuffer(clip, index)
      .then((buffer) => {
        if (cancelled) return end();
        source = this.context.createBufferSource();
        source.buffer = buffer;
        source.connect(destination);
        source.onended = end;
        const start = Math.max(when, this.context.currentTime);
        const adjustedOffset = offset + Math.max(0, start - when);
        if (adjustedOffset >= buffer.duration) return end();
        source.start(start, adjustedOffset);
        source.stop(start + buffer.duration - adjustedOffset);
      })
      .catch((error: unknown) => {
        this.addWarnings([`Audio clip ${clip.id} could not read its media: ${String(error)}`]);
        end();
      });
    return {
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

  private scheduleAudio(clip: AudioClip, destination: AudioNode, when: number, offset: number): AudioHandle {
    if (clip.media) throw new Error("Workspace expected an in-memory audio clip.");
    const source = this.context.createBufferSource();
    let buffer = this.audioBuffers.get(clip);
    if (!buffer) {
      buffer = this.context.createBuffer(clip.channels.length, clip.channels[0].length, clip.sampleRate);
      clip.channels.forEach((samples, index) => buffer!.copyToChannel(new Float32Array(samples), index));
      this.audioBuffers.set(clip, buffer);
    }
    source.buffer = buffer;
    source.connect(destination);
    let ended = false;
    const listeners = new Set<() => void>();
    source.onended = () => {
      ended = true;
      source.disconnect();
      for (const listener of listeners) listener();
      listeners.clear();
    };
    const start = Math.max(when, this.context.currentTime);
    const adjustedOffset = Math.min(clip.duration, offset + Math.max(0, start - when));
    source.start(start, adjustedOffset);
    source.stop(start + Math.max(0, clip.duration - adjustedOffset));
    return {
      cancel: () => {
        if (!ended) {
          try {
            source.stop();
          } catch {
            /* already stopped */
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

  private disposeTracks(): void {
    for (const off of this.sequenceOff.splice(0)) off();
    for (const runtime of this.tracks.values()) {
      runtime.rack.destroy();
      for (const host of runtime.hosts.values()) host.destroy();
      runtime.automationBinding?.destroy();
      runtime.automationGain.disconnect();
      runtime.gain.disconnect();
      runtime.panner.disconnect();
    }
    this.tracks.clear();
    this.scheduledAudio.clear();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.stop();
    this.destroyed = true;
    this.dirty = false;
    this.stopWatching?.();
    this.stopWatching = undefined;
    this.clock.destroy();
    this.disposeTracks();
    this.output.disconnect();
  }
}
