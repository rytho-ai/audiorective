import {
  normalizeRackEffects,
  normalizeRackPreset,
  retainRackMacroTargets,
  type RackEffect,
  type RackMacroSettings,
  type RackPreset,
} from "@audiorective/effects/rack-preset";
import type { PCMData } from "@audiorective/core";
import { batch, Cell, readonlyCell, untracked } from "@audiorective/core";
import { AutomationCurve, type AutomationPoint } from "@audiorective/core/automation";
import { compileMidiPlaybackEvents, MidiSequence } from "@audiorective/midi";
import type { MidiData, MidiPlaybackEvent, RecordedMidi, RecordedMidiEvent } from "@audiorective/midi";
import { AudioMedia } from "./media";
import { TempoMap } from "./tempo-map";
import type { TempoChange } from "./tempo-map";
import { ClipTimeMap, normalizeClipAnchors, type ClipStretchAnchor } from "./clip-time-map";
import { normalizeClipEnvelope, unityClipEnvelope, type ClipEnvelope } from "./clip-envelope";

export type TrackKind = "audio" | "midi" | "bus";
export type BusRole = "submix" | "effect";
export type ProjectSend = Readonly<{ busId: string; gain: number }>;
export type TrackRouting = Readonly<{ outputBusId: string | null; sends: readonly ProjectSend[] }>;
const masterRouting: TrackRouting = Object.freeze({ outputBusId: null, sends: Object.freeze([]) });
export type MidiTimeUnit = "seconds" | "beats";
/** A message at a clip-relative time in its owning MidiClip.timeUnit. */
export type ProjectMidiEvent = Readonly<{ time: number; data: Uint8Array; noteId?: string }>;
export type ProjectAudio = Pick<PCMData, "sampleRate" | "channels">;
export type ProjectMarker = Readonly<{ time: number; name: string }>;

export type PcmAudioSource = ProjectAudio & Readonly<{ media?: never }>;
export type MediaAudioSource = Readonly<{
  sampleRate: number;
  media: AudioMedia;
  startFrame: number;
  frameCount: number;
  channels?: never;
}>;
export type AudioClipSource = PcmAudioSource | MediaAudioSource;
export type AudioClipStretch = Readonly<{ ratio: number; source: AudioClipSource; anchors?: readonly ClipStretchAnchor[] }>;
export type AudioClipGainAutomation = Readonly<{
  /** Original source seconds at the start of this clip's current window. */
  sourceStart: number;
  points: readonly AutomationPoint[];
}>;

type AudioClipOptions = { id?: string; envelope?: ClipEnvelope; stretch?: AudioClipStretch; gainAutomation?: AudioClipGainAutomation };

interface AudioClipBase {
  readonly kind: "audio";
  readonly id: string;
  /** Position on the project timeline, in seconds. */
  readonly time: number;
  readonly duration: number;
  readonly envelope?: ClipEnvelope;
  readonly gainAutomation?: AudioClipGainAutomation;
  readonly stretch?: AudioClipStretch;
}

export type PcmAudioClip = AudioClipBase & PcmAudioSource;
export type MediaAudioClip = AudioClipBase & MediaAudioSource;
export type AudioClip = PcmAudioClip | MediaAudioClip;
export const audioChannelCount = (source: AudioClipSource): number => (source.media ? source.media.channelCount : source.channels.length);
export const audioFrameCount = (source: AudioClipSource): number => (source.media ? source.frameCount : source.channels[0].length);

/** Seconds in the source before stretch, for this clip's current window. */
export function audioClipSourceDuration(clip: AudioClip): number {
  return clip.stretch ? audioFrameCount(clip.stretch.source) / clip.sampleRate : clip.duration;
}

export function audioClipTimeMap(clip: AudioClip): ClipTimeMap {
  return new ClipTimeMap(audioClipSourceDuration(clip), clip.duration, clip.stretch?.anchors ?? [], clip.sampleRate);
}

export function normalizeClipGainAutomation(automation: AudioClipGainAutomation | undefined): AudioClipGainAutomation | undefined {
  if (automation === undefined) return;
  if (
    !automation ||
    !validTime(automation.sourceStart) ||
    !Array.isArray(automation.points) ||
    Array.from(automation.points).some((point) => !point || !Number.isFinite(Math.fround(point.value)) || point.value < 0)
  )
    throw new RangeError("Audio clip gain automation needs a non-negative source start and non-negative finite gains.");
  if (!automation.points.length) return;
  return Object.freeze({ sourceStart: automation.sourceStart, points: new AutomationCurve(automation.points).value });
}

function audioSource(clip: AudioClip): AudioClipSource {
  return clip.media
    ? Object.freeze({ sampleRate: clip.sampleRate, media: clip.media, startFrame: clip.startFrame, frameCount: clip.frameCount })
    : Object.freeze({ sampleRate: clip.sampleRate, channels: clip.channels });
}

function sliceAudioSource(source: AudioClipSource, from: number, to: number): AudioClipSource {
  if (from >= to) throw new RangeError("Project audio trim needs at least one sample.");
  return source.media
    ? Object.freeze({ sampleRate: source.sampleRate, media: source.media, startFrame: source.startFrame + from, frameCount: to - from })
    : Object.freeze({ sampleRate: source.sampleRate, channels: Object.freeze(source.channels.map((channel) => channel.subarray(from, to))) });
}

function validPcm(audio: ProjectAudio): boolean {
  return (
    Number.isInteger(audio.sampleRate) &&
    audio.sampleRate > 0 &&
    audio.channels.length > 0 &&
    audio.channels.every(
      (channel) => channel instanceof Float32Array && channel.length === audio.channels[0].length && channel.every(Number.isFinite),
    )
  );
}

function normalizeClipStretch(
  stretch: AudioClipStretch | undefined,
  sampleRate: number,
  channels: number,
  outputFrames: number,
): AudioClipStretch | undefined {
  if (!stretch) return;
  const { source, ratio } = stretch;
  if (
    !Number.isFinite(ratio) ||
    ratio <= 0 ||
    source.sampleRate !== sampleRate ||
    audioChannelCount(source) !== channels ||
    (source.media
      ? !Number.isSafeInteger(source.startFrame) ||
        !Number.isSafeInteger(source.frameCount) ||
        source.startFrame < 0 ||
        source.frameCount < 1 ||
        source.startFrame + source.frameCount > source.media.frameCount ||
        !(source.media instanceof AudioMedia) ||
        source.media.sampleRate !== sampleRate
      : !validPcm(source) || audioFrameCount(source) < 1)
  )
    throw new RangeError("Project clip stretch needs a compatible original audio window and positive ratio.");
  const anchors = normalizeClipAnchors(stretch.anchors ?? [], audioFrameCount(source), outputFrames);
  return Object.freeze({ ratio, source: snapshotAudioSource(source), ...(anchors.length ? { anchors } : {}) });
}

function snapshotAudioSource(source: AudioClipSource): AudioClipSource {
  return source.media
    ? Object.freeze({ sampleRate: source.sampleRate, media: source.media, startFrame: source.startFrame, frameCount: source.frameCount })
    : Object.freeze({ sampleRate: source.sampleRate, channels: Object.freeze(source.channels.map((channel) => channel.slice())) });
}

function snapshotAudioClip(clip: AudioClip): AudioClip {
  const stretch =
    clip.stretch && !clip.stretch.source.media ? Object.freeze({ ...clip.stretch, source: snapshotAudioSource(clip.stretch.source) }) : clip.stretch;
  if (clip.media && stretch === clip.stretch) return clip;
  return Object.freeze({
    kind: "audio",
    id: clip.id,
    time: clip.time,
    duration: clip.duration,
    ...snapshotAudioSource(clip),
    ...(clip.envelope ? { envelope: clip.envelope } : {}),
    ...(stretch ? { stretch } : {}),
    ...(clip.gainAutomation ? { gainAutomation: clip.gainAutomation } : {}),
  });
}

const midiClipTimes = new WeakMap<MidiClip, Cell<number>>();

/** One owner for editable notes and ordered events; position, duration and content share timeUnit. */
export class MidiClip {
  readonly kind = "midi" as const;
  readonly sequence: MidiSequence;
  private readonly sourceEvents: readonly ProjectMidiEvent[];

  constructor(
    readonly id: string,
    time: number,
    data: MidiData & Readonly<{ events?: readonly ProjectMidiEvent[] }>,
    readonly timeUnit: MidiTimeUnit = "seconds",
  ) {
    if (timeUnit !== "seconds" && timeUnit !== "beats") throw new RangeError("Project MIDI time unit must be seconds or beats.");
    midiClipTimes.set(this, new Cell(time));
    this.sourceEvents = Object.freeze(
      (data.events ?? []).map((event) => {
        if (!Number.isFinite(event.time) || event.time < 0 || !(event.data instanceof Uint8Array) || event.data.length === 0)
          throw new RangeError("Project MIDI events need finite non-negative times and MIDI bytes.");
        return Object.freeze({ time: event.time, data: new Uint8Array(event.data), ...(event.noteId ? { noteId: event.noteId } : {}) });
      }),
    );
    this.sequence = new MidiSequence(data);
  }

  get duration(): number {
    return this.sequence.cells.duration.value;
  }

  get time(): number {
    return midiClipTimes.get(this)!.value;
  }

  /** Copies preserve the clip's event owner when a caller edits returned bytes. */
  get events(): readonly ProjectMidiEvent[] {
    return this.sourceEvents.map((event) => ({ ...event, data: new Uint8Array(event.data) }));
  }

  playbackEvents(): readonly MidiPlaybackEvent[] {
    const source: { startTime: number; events: RecordedMidiEvent[] } = {
      startTime: 0,
      events: this.sourceEvents.map(({ time, data, noteId }) => ({ audioTime: time, data, ...(noteId ? { noteId } : {}) })),
    };
    return compileMidiPlaybackEvents(source, this.sequence.getState());
  }

  destroy(): void {
    this.sequence.destroy();
  }
}

export type ProjectClip = AudioClip | MidiClip;
export type WebClapDevice = Readonly<{
  kind: "webclap";
  id: string;
  pluginId: string;
  name: string;
  vendor: string;
  version: string;
  bundleUrl: string;
  state: Uint8Array;
}>;
export type ProjectDevice = WebClapDevice;
export type ProjectTrack = Readonly<{
  id: string;
  name: string;
  kind: TrackKind;
  busRole?: BusRole;
  routing: TrackRouting;
  volume: number;
  muted: boolean;
  solo: boolean;
  pan: number;
  volumeAutomation: readonly AutomationPoint[];
  devices: readonly ProjectDevice[];
  effects: readonly RackEffect[];
  effectMacros: readonly RackMacroSettings[];
  clips: readonly ProjectClip[];
}>;

export type ProjectOptions = Readonly<{
  title?: string;
  bpm?: number;
  signature?: readonly [number, number];
}>;

const validId = (id: string) => /^[A-Za-z_][A-Za-z0-9_.-]*$/.test(id);
const validTime = (time: number) => Number.isFinite(time) && time >= 0;

/** Headless project content. AudioContext and UI state are not part of the file. */
export class Project {
  private _title: string;
  private _masterVolume = 1;
  readonly bpm: number;
  private _tempoMap: TempoMap;
  readonly signature: readonly [number, number];
  private _tracks: readonly ProjectTrack[] = Object.freeze([]);
  private _markers: readonly ProjectMarker[] = Object.freeze([]);
  private readonly ids = new Set<string>();
  private readonly revision = new Cell(0);
  readonly cells = Object.freeze({ revision: readonlyCell(this.revision) });
  private nextId = 1;

  private bump(): void {
    this.revision.value = untracked(() => this.revision.value) + 1;
  }

  constructor(options: ProjectOptions = {}) {
    this._title = options.title ?? "Untitled";
    this.bpm = options.bpm ?? 120;
    this.signature = Object.freeze([...(options.signature ?? [4, 4])] as [number, number]);
    if (
      !Number.isFinite(this.bpm) ||
      this.bpm <= 0 ||
      !Number.isInteger(this.signature[0]) ||
      this.signature[0] <= 0 ||
      !Number.isInteger(this.signature[1]) ||
      this.signature[1] <= 0 ||
      (this.signature[1] & (this.signature[1] - 1)) !== 0
    )
      throw new RangeError("Project needs positive BPM and a valid time signature.");
    this._tempoMap = new TempoMap(this.bpm);
  }

  get hasFileBackedAudio(): boolean {
    void this.revision.value;
    return this._tracks.some(({ clips }) => clips.some((clip) => clip.kind === "audio" && !!(clip.media || clip.stretch?.source.media)));
  }

  get tracks(): readonly ProjectTrack[] {
    void this.revision.value;
    return this._tracks;
  }

  get masterVolume(): number {
    void this.revision.value;
    return this._masterVolume;
  }

  setMasterVolume(value: number): void {
    if (!Number.isFinite(value) || value < 0) throw new RangeError("Project master volume needs a finite non-negative value.");
    if (value === this._masterVolume) return;
    this._masterVolume = value;
    this.bump();
  }

  get tempoMap(): TempoMap {
    void this.revision.value;
    return this._tempoMap;
  }

  /** Convert a clip's native position and offset to project seconds. */
  clipTimeSeconds(clip: ProjectClip, localTime = 0): number {
    const position = clip.time + localTime;
    return clip.kind === "midi" && clip.timeUnit === "beats" ? this._tempoMap.beatToSeconds(position) : position;
  }

  private sortClips(clips: ProjectClip[]): readonly ProjectClip[] {
    return Object.freeze(untracked(() => clips.sort((a, b) => this.clipTimeSeconds(a) - this.clipTimeSeconds(b))));
  }

  setTempoChanges(changes: readonly TempoChange[]): void {
    this._tempoMap = new TempoMap(this.bpm, changes);
    this._tracks = Object.freeze(this._tracks.map((track) => Object.freeze({ ...track, clips: this.sortClips([...track.clips]) })));
    this.bump();
  }

  get markers(): readonly ProjectMarker[] {
    void this.revision.value;
    return this._markers;
  }

  /** Stable content snapshot for a separate render runtime. File-backed media remains borrowed. */
  snapshot(): Project {
    const copy = new Project({ title: this._title, bpm: this.bpm, signature: this.signature });
    copy._masterVolume = this._masterVolume;
    copy._tempoMap = this._tempoMap;
    copy._markers = this._markers;
    copy._tracks = Object.freeze(
      this._tracks.map((track) =>
        Object.freeze({
          ...track,
          devices: Object.freeze(track.devices.map((device) => Object.freeze({ ...device, state: new Uint8Array(device.state) }))),
          clips: Object.freeze(
            track.clips.map((clip) =>
              clip instanceof MidiClip
                ? new MidiClip(clip.id, clip.time, { ...clip.sequence.getState(), events: clip.events }, clip.timeUnit)
                : snapshotAudioClip(clip),
            ),
          ),
        }),
      ),
    );
    for (const track of copy._tracks) {
      copy.ids.add(track.id);
      for (const device of track.devices) copy.ids.add(device.id);
      for (const clip of track.clips) copy.ids.add(clip.id);
    }
    copy.nextId = this.nextId;
    return copy;
  }

  setMarkers(markers: readonly ProjectMarker[]): void {
    if (markers.some((marker) => typeof marker.name !== "string")) throw new RangeError("Project markers need unique non-negative times and names.");
    const sorted = markers.map((marker) => Object.freeze({ time: marker.time, name: marker.name.trim() })).sort((a, b) => a.time - b.time);
    if (sorted.some((marker, index) => !validTime(marker.time) || !marker.name || (index > 0 && sorted[index - 1].time === marker.time)))
      throw new RangeError("Project markers need unique non-negative times and names.");
    this._markers = Object.freeze(sorted);
    this.bump();
  }

  get title(): string {
    void this.revision.value;
    return this._title;
  }

  setTitle(title: string): void {
    if (!title.trim()) throw new RangeError("Project title must not be empty.");
    this._title = title.trim();
    this.bump();
  }

  private reserve(id: string | undefined, prefix: string): string {
    const chosen =
      id ??
      (() => {
        let candidate: string;
        do candidate = `${prefix}${this.nextId++}`;
        while (this.ids.has(candidate));
        return candidate;
      })();
    if (!validId(chosen) || this.ids.has(chosen)) throw new Error("Project IDs must be unique XML IDs.");
    this.ids.add(chosen);
    return chosen;
  }

  addTrack(
    name: string,
    kind: TrackKind,
    options: { id?: string; volume?: number; muted?: boolean; solo?: boolean; pan?: number; busRole?: BusRole } = {},
  ): ProjectTrack {
    if (!name || (kind !== "audio" && kind !== "midi" && kind !== "bus") || !Number.isFinite(options.volume ?? 1) || (options.volume ?? 1) < 0)
      throw new RangeError("Project tracks need a name, kind and non-negative volume.");
    if (
      typeof (options.muted ?? false) !== "boolean" ||
      typeof (options.solo ?? false) !== "boolean" ||
      !Number.isFinite(options.pan ?? 0) ||
      Math.abs(options.pan ?? 0) > 1
    )
      throw new RangeError("Project track mixer options need boolean mute/solo and pan from -1 to 1.");
    if (options.busRole !== undefined && (kind !== "bus" || (options.busRole !== "submix" && options.busRole !== "effect")))
      throw new Error("Project bus roles need a bus track and a supported role.");
    const track: ProjectTrack = Object.freeze({
      id: this.reserve(options.id, "track"),
      name,
      kind,
      ...(kind === "bus" ? { busRole: options.busRole ?? "submix" } : {}),
      routing: masterRouting,
      volume: options.volume ?? 1,
      muted: options.muted ?? false,
      solo: options.solo ?? false,
      pan: options.pan ?? 0,
      volumeAutomation: Object.freeze([]),
      devices: Object.freeze([]),
      effects: Object.freeze([]),
      effectMacros: Object.freeze([]),
      clips: Object.freeze([]),
    });
    this._tracks = Object.freeze([...this._tracks, track]);
    this.bump();
    return track;
  }

  private track(id: string, kind: TrackKind): ProjectTrack {
    const track = this._tracks.find((item) => item.id === id);
    if (!track || track.kind !== kind) throw new Error("Project clip needs a matching track.");
    return track;
  }

  private replace(track: ProjectTrack, patch: Partial<ProjectTrack>): void {
    this._tracks = Object.freeze(this._tracks.map((item) => (item.id === track.id ? Object.freeze({ ...item, ...patch }) : item)));
    this.bump();
  }

  setTrackVolume(trackId: string, value: number): void {
    const track = this._tracks.find((item) => item.id === trackId);
    if (!track || !Number.isFinite(value) || value < 0) throw new RangeError("Project track volume needs an existing track and non-negative value.");
    this.replace(track, { volume: value });
  }

  setTrackName(trackId: string, name: string): void {
    const track = this._tracks.find((item) => item.id === trackId);
    if (!track || !name.trim()) throw new RangeError("Project track name needs an existing track and non-empty name.");
    this.replace(track, { name: name.trim() });
  }

  setTrackMuted(trackId: string, muted: boolean): void {
    const track = this._tracks.find((item) => item.id === trackId);
    if (!track || typeof muted !== "boolean") throw new RangeError("Project track mute needs an existing track and boolean value.");
    this.replace(track, { muted });
  }

  setTrackSolo(trackId: string, solo: boolean): void {
    const track = this._tracks.find((item) => item.id === trackId);
    if (!track || typeof solo !== "boolean") throw new RangeError("Project track solo needs an existing track and boolean value.");
    this.replace(track, { solo });
  }

  setTrackPan(trackId: string, pan: number): void {
    const track = this._tracks.find((item) => item.id === trackId);
    if (!track || !Number.isFinite(pan) || Math.abs(pan) > 1)
      throw new RangeError("Project track pan needs an existing track and a value from -1 to 1.");
    this.replace(track, { pan });
  }

  /** Atomically replace the dry output and post-fader sends for one track. */
  setTrackRouting(trackId: string, routing: TrackRouting): void {
    const tracks = new Map(this._tracks.map((track) => [track.id, track]));
    const track = tracks.get(trackId);
    if (!track) throw new Error("Project track routing needs an existing track.");
    const targets = routing.sends.map(({ busId }) => busId);
    if (
      new Set(targets).size !== targets.length ||
      routing.sends.some(({ gain }) => !Number.isFinite(gain) || gain < 0) ||
      [...targets, ...(routing.outputBusId === null ? [] : [routing.outputBusId])].some((id) => tracks.get(id)?.kind !== "bus")
    ) {
      throw new Error("Project routes need existing buses, unique sends and non-negative send gain.");
    }
    const visited = new Set<string>();
    function reachesSource(id: string): boolean {
      if (id === trackId) return true;
      if (visited.has(id)) return false;
      visited.add(id);
      const { outputBusId, sends } = tracks.get(id)!.routing;
      return (outputBusId !== null && reachesSource(outputBusId)) || sends.some(({ busId }) => reachesSource(busId));
    }
    if ((routing.outputBusId !== null && reachesSource(routing.outputBusId)) || targets.some(reachesSource)) {
      throw new Error("Project track routing cannot form a cycle.");
    }
    this.replace(track, {
      routing: Object.freeze({
        outputBusId: routing.outputBusId,
        sends: Object.freeze(routing.sends.map(({ busId, gain }) => Object.freeze({ busId, gain }))),
      }),
    });
  }

  /** Replace the ordered built-in inserts after the track's WebCLAP devices. */
  setTrackEffects(trackId: string, effects: readonly RackEffect[]): void {
    const track = this._tracks.find((item) => item.id === trackId);
    if (!track) throw new Error("Project effects need an existing track.");
    const checked = normalizeRackEffects(effects);
    this.replace(track, { effects: checked, effectMacros: retainRackMacroTargets(checked, track.effectMacros) });
  }

  /** Apply both the ordered inserts and their macro settings as one Project edit. */
  setTrackRackPreset(trackId: string, preset: RackPreset): void {
    const track = this._tracks.find((item) => item.id === trackId);
    if (!track) throw new Error("Project effects need an existing track.");
    const { effects, macros } = normalizeRackPreset(preset);
    this.replace(track, { effects, effectMacros: macros });
  }

  setTrackMacroValue(trackId: string, macroId: string, value: number): void {
    const track = this._tracks.find((item) => item.id === trackId);
    const macro = track?.effectMacros.find((item) => item.id === macroId);
    if (!track || !macro) throw new Error("Project macro needs an existing track and macro.");
    if (!Number.isFinite(value) || value < 0 || value > 1) throw new RangeError("EffectRack macro value needs a number from 0 to 1.");
    if (macro.value === value) return;
    this.replace(track, {
      effectMacros: Object.freeze(track.effectMacros.map((item) => (item === macro ? Object.freeze({ ...item, value }) : item))),
    });
  }

  removeTrack(trackId: string): void {
    const track = this._tracks.find((item) => item.id === trackId);
    if (!track) throw new Error("Project track does not exist.");
    for (const clip of track.clips) {
      this.ids.delete(clip.id);
      if (clip instanceof MidiClip) clip.destroy();
    }
    for (const device of track.devices) this.ids.delete(device.id);
    this.ids.delete(track.id);
    this._tracks = Object.freeze(
      this._tracks
        .filter((item) => item.id !== trackId)
        .map((item) => {
          const { outputBusId, sends } = item.routing;
          if (outputBusId !== trackId && !sends.some(({ busId }) => busId === trackId)) return item;
          return Object.freeze({
            ...item,
            routing: Object.freeze({
              outputBusId: outputBusId === trackId ? null : outputBusId,
              sends: Object.freeze(sends.filter(({ busId }) => busId !== trackId)),
            }),
          });
        }),
    );
    this.bump();
  }

  addWebClapDevice(trackId: string, details: Omit<WebClapDevice, "kind" | "id" | "state"> & { id?: string; state?: Uint8Array }): WebClapDevice {
    const track = this._tracks.find((item) => item.id === trackId);
    if (!track) throw new Error("Project device needs an existing track.");
    if (!details.pluginId || !details.name || typeof details.bundleUrl !== "string" || (details.state && !(details.state instanceof Uint8Array)))
      throw new Error("Project WebCLAP device needs an ID, name, bundle URL and byte state.");
    const id = this.reserve(details.id, "device");
    const device: WebClapDevice = Object.freeze({
      kind: "webclap",
      id,
      pluginId: details.pluginId,
      name: details.name,
      vendor: details.vendor,
      version: details.version,
      bundleUrl: details.bundleUrl,
      state: new Uint8Array(details.state ?? []),
    });
    this.replace(track, { devices: Object.freeze([...track.devices, device]) });
    return device;
  }

  setDeviceState(deviceId: string, bytes: Uint8Array): void {
    if (!(bytes instanceof Uint8Array)) throw new TypeError("Project device state needs bytes.");
    const track = this._tracks.find((item) => item.devices.some((device) => device.id === deviceId));
    if (!track) throw new Error("Project device needs an existing track.");
    const devices = track.devices.map((device) => (device.id === deviceId ? Object.freeze({ ...device, state: new Uint8Array(bytes) }) : device));
    this.replace(track, { devices: Object.freeze(devices) });
  }

  removeDevice(deviceId: string): void {
    const track = this._tracks.find((item) => item.devices.some((device) => device.id === deviceId));
    if (!track) throw new Error("Project device needs an existing track.");
    this.ids.delete(deviceId);
    this.replace(track, { devices: Object.freeze(track.devices.filter((device) => device.id !== deviceId)) });
  }

  setVolumeAutomation(trackId: string, points: readonly AutomationPoint[]): void {
    const track = this._tracks.find((item) => item.id === trackId);
    if (!track) throw new Error("Project automation needs an existing track.");
    const sorted = points.map((point) => Object.freeze({ ...point })).sort((a, b) => a.time - b.time);
    if (
      sorted.some(
        (point, i) =>
          !validTime(point.time) ||
          !Number.isFinite(point.value) ||
          point.value < 0 ||
          (point.shape !== "linear" && point.shape !== "hold") ||
          (i > 0 && sorted[i - 1].time === point.time),
      )
    )
      throw new RangeError("Project automation needs finite unique times and non-negative values.");
    this.replace(track, { volumeAutomation: Object.freeze(sorted) });
  }

  addAudioClip(trackId: string, audio: ProjectAudio, time: number, options: AudioClipOptions = {}): AudioClip {
    const track = this.track(trackId, "audio");
    if (!validTime(time) || !validPcm(audio)) throw new RangeError("Project audio clips need a time, sample rate and equal-length PCM channels.");
    const stretch = normalizeClipStretch(options.stretch, audio.sampleRate, audio.channels.length, audio.channels[0].length);
    const duration = audio.channels[0].length / audio.sampleRate;
    const envelope = normalizeClipEnvelope(options.envelope ?? unityClipEnvelope, duration);
    const gainAutomation = normalizeClipGainAutomation(options.gainAutomation);
    const clip: AudioClip = Object.freeze({
      kind: "audio",
      id: this.reserve(options.id, "clip"),
      time,
      sampleRate: audio.sampleRate,
      channels: Object.freeze(audio.channels.map((channel) => new Float32Array(channel))),
      duration,
      ...(stretch ? { stretch } : {}),
      ...(envelope === unityClipEnvelope ? {} : { envelope }),
      ...(gainAutomation ? { gainAutomation } : {}),
    });
    this.replace(track, { clips: this.sortClips([...track.clips, clip]) });
    return clip;
  }

  /** Add file-backed PCM without copying the full take into the project model. */
  addAudioMediaClip(
    trackId: string,
    media: AudioMedia,
    time: number,
    options: AudioClipOptions & { startFrame?: number; frameCount?: number } = {},
  ): MediaAudioClip {
    const track = this.track(trackId, "audio");
    if (!(media instanceof AudioMedia)) throw new TypeError("Project media clip needs an AudioMedia asset.");
    const startFrame = options.startFrame ?? 0;
    const frameCount = options.frameCount ?? media.frameCount - startFrame;
    if (
      !validTime(time) ||
      !Number.isInteger(startFrame) ||
      !Number.isInteger(frameCount) ||
      startFrame < 0 ||
      frameCount < 1 ||
      startFrame + frameCount > media.frameCount
    )
      throw new RangeError("Project media clip needs a valid frame window and time.");
    const duration = frameCount / media.sampleRate;
    const stretch = normalizeClipStretch(options.stretch, media.sampleRate, media.channelCount, frameCount);
    const envelope = normalizeClipEnvelope(options.envelope ?? unityClipEnvelope, duration);
    const gainAutomation = normalizeClipGainAutomation(options.gainAutomation);
    const clip: MediaAudioClip = Object.freeze({
      kind: "audio",
      id: this.reserve(options.id, "clip"),
      time,
      sampleRate: media.sampleRate,
      media,
      startFrame,
      frameCount,
      duration,
      ...(stretch ? { stretch } : {}),
      ...(envelope === unityClipEnvelope ? {} : { envelope }),
      ...(gainAutomation ? { gainAutomation } : {}),
    });
    this.replace(track, { clips: this.sortClips([...track.clips, clip]) });
    return clip;
  }

  addMidiClip(
    trackId: string,
    data: MidiData & Readonly<{ events?: readonly ProjectMidiEvent[] }>,
    time: number,
    options: { id?: string; timeUnit?: MidiTimeUnit } = {},
  ): MidiClip {
    const track = this.track(trackId, "midi");
    if (!validTime(time)) throw new RangeError("Project clip time must be finite and non-negative.");
    const id = this.reserve(options.id, "clip");
    try {
      const clip = new MidiClip(id, time, data, options.timeUnit);
      this.replace(track, { clips: this.sortClips([...track.clips, clip]) });
      return clip;
    } catch (error) {
      this.ids.delete(id);
      throw error;
    }
  }

  /** A take arrives in seconds; beat placement converts notes and every captured message together. */
  addMidiTake(trackId: string, take: RecordedMidi, time: number, options: { timeUnit?: MidiTimeUnit } = {}): MidiClip {
    if (!validTime(time)) throw new RangeError("Project clip time must be finite and non-negative.");
    const beats = options.timeUnit === "beats";
    const startBeat = beats ? this._tempoMap.secondsToBeat(time) : 0;
    const convert = (relative: number) => (beats ? this._tempoMap.secondsToBeat(time + relative) - startBeat : relative);
    return this.addMidiClip(
      trackId,
      {
        notes: take.notes.map((note) => ({ ...note, start: convert(note.start), end: convert(note.end) })),
        duration: convert(take.duration),
        events: take.events.map((event) => ({ time: convert(event.audioTime - take.startTime), data: event.data, noteId: event.noteId })),
      },
      beats ? startBeat : time,
      options,
    );
  }

  moveClip(clipId: string, trackId: string, time: number): void {
    if (!validTime(time)) throw new RangeError("Project clip time must be finite and non-negative.");
    const source = this._tracks.find((item) => item.clips.some((clip) => clip.id === clipId));
    const target = this._tracks.find((item) => item.id === trackId);
    const clip = source?.clips.find((item) => item.id === clipId);
    if (!source || !target || !clip || target.kind !== clip.kind) throw new Error("Project clip needs a matching track.");
    const moved = clip.kind === "midi" ? clip : Object.freeze({ ...clip, time });
    batch(() => {
      if (clip.kind === "midi") midiClipTimes.get(clip)!.value = time;
      this._tracks = Object.freeze(
        this._tracks.map((track) => {
          if (track.id !== source.id && track.id !== target.id) return track;
          const clips = track.clips.filter((item) => item.id !== clipId);
          if (track.id === target.id) clips.push(moved);
          return Object.freeze({ ...track, clips: this.sortClips(clips) });
        }),
      );
      this.bump();
    });
  }

  duplicateClip(clipId: string, time: number, trackId?: string): ProjectClip {
    if (!validTime(time)) throw new RangeError("Project clip time must be finite and non-negative.");
    const source = this._tracks.find((item) => item.clips.some((clip) => clip.id === clipId));
    const clip = source?.clips.find((item) => item.id === clipId);
    if (!source || !clip) throw new Error("Project clip does not exist.");
    const target = trackId ?? source.id;
    if (clip.kind === "audio") {
      const options = { envelope: clip.envelope, stretch: clip.stretch, gainAutomation: clip.gainAutomation };
      return clip.media
        ? this.addAudioMediaClip(target, clip.media, time, { ...options, startFrame: clip.startFrame, frameCount: clip.frameCount })
        : this.addAudioClip(target, clip, time, options);
    }
    return this.addMidiClip(target, { ...clip.sequence.getState(), events: clip.events }, time, { timeUnit: clip.timeUnit });
  }

  private clipAndTrack(clipId: string): { track: ProjectTrack; clip: ProjectClip } {
    const track = this._tracks.find((item) => item.clips.some((clip) => clip.id === clipId));
    const clip = track?.clips.find((item) => item.id === clipId);
    if (!track || !clip) throw new Error("Project clip does not exist.");
    return { track, clip };
  }

  /** Replace the clip's playback gain and fades while borrowing the same source PCM. */
  setAudioClipEnvelope(clipId: string, settings: ClipEnvelope): AudioClip {
    const { track, clip } = this.clipAndTrack(clipId);
    if (clip.kind !== "audio") throw new Error("Project clip envelope needs an audio clip.");
    const envelope = normalizeClipEnvelope(settings, clip.duration);
    const { envelope: previous, ...audio } = clip;
    const old = previous ?? unityClipEnvelope;
    if (envelope.gain === old.gain && envelope.fadeIn === old.fadeIn && envelope.fadeOut === old.fadeOut) return clip;
    const next = Object.freeze({ ...audio, ...(envelope === unityClipEnvelope ? {} : { envelope }) });
    this.replace(track, { clips: Object.freeze(track.clips.map((item) => (item === clip ? next : item))) });
    return next;
  }

  /** Set gain automation in original source seconds. An empty curve clears it. */
  setAudioClipGainAutomation(clipId: string, points: readonly AutomationPoint[]): AudioClip {
    const { track, clip } = this.clipAndTrack(clipId);
    if (clip.kind !== "audio") throw new Error("Project clip gain automation needs an audio clip.");
    const { gainAutomation: previous, ...audio } = clip;
    const gainAutomation = normalizeClipGainAutomation({ sourceStart: previous?.sourceStart ?? 0, points });
    if (!previous && !gainAutomation) return clip;
    if (previous && gainAutomation && previous.points.length === gainAutomation.points.length) {
      const unchanged = gainAutomation.points.every((point, index) => {
        const old = previous.points[index];
        return old.time === point.time && old.value === point.value && old.shape === point.shape;
      });
      if (unchanged) return clip;
    }
    const next = Object.freeze({ ...audio, ...(gainAutomation ? { gainAutomation } : {}) });
    this.replace(track, { clips: Object.freeze(track.clips.map((item) => (item === clip ? next : item))) });
    return next;
  }

  /** Apply a prepared render only to the exact clip revision the processor borrowed. */
  applyAudioClipStretch(expected: AudioClip, ratio: number, rendered?: ProjectAudio, warp: readonly ClipStretchAnchor[] = []): AudioClip {
    const { track, clip } = this.clipAndTrack(expected.id);
    if (clip !== expected) throw new Error("Audio clip changed while rendering stretch.");
    const original = expected.stretch?.source ?? audioSource(expected);
    const outputFrames = Math.round(audioFrameCount(original) * ratio);
    const anchors = normalizeClipAnchors(warp, audioFrameCount(original), outputFrames);
    const usesRender = ratio !== 1 || anchors.length > 0;
    if (
      !Number.isFinite(ratio) ||
      ratio <= 0 ||
      (usesRender &&
        (!rendered ||
          !validPcm(rendered) ||
          rendered.sampleRate !== original.sampleRate ||
          rendered.channels.length !== audioChannelCount(original) ||
          rendered.channels[0].length < 1 ||
          rendered.channels[0].length !== outputFrames))
    )
      throw new RangeError("Project clip stretch needs a positive ratio and matching rendered audio.");
    if (!usesRender && !expected.stretch) return expected;
    const playback: AudioClipSource = !usesRender
      ? original
      : Object.freeze({
          sampleRate: rendered!.sampleRate,
          channels: Object.freeze(rendered!.channels.map((channel) => channel.slice())),
        });
    const duration = audioFrameCount(playback) / playback.sampleRate;
    const prior = expected.envelope ?? unityClipEnvelope;
    const scale = duration / expected.duration;
    const envelope = normalizeClipEnvelope({ gain: prior.gain, fadeIn: prior.fadeIn * scale, fadeOut: prior.fadeOut * scale }, duration);
    const next: AudioClip = Object.freeze({
      kind: "audio",
      id: expected.id,
      time: expected.time,
      ...playback,
      duration,
      ...(envelope === unityClipEnvelope ? {} : { envelope }),
      ...(usesRender ? { stretch: Object.freeze({ ratio, source: original, ...(anchors.length ? { anchors } : {}) }) } : {}),
      ...(expected.gainAutomation ? { gainAutomation: expected.gainAutomation } : {}),
    });
    this.replace(track, { clips: this.sortClips(track.clips.map((item) => (item === expected ? next : item))) });
    return next;
  }

  /** Extract a local interval without changing the source clip. */
  private segment(clip: ProjectClip, start: number, end: number, id: string): ProjectClip {
    if (clip.kind === "audio") {
      const first = Math.round(start * clip.sampleRate);
      const last = Math.round(end * clip.sampleRate);
      if (first >= last) throw new RangeError("Project audio trim needs at least one sample.");
      const duration = (last - first) / clip.sampleRate;
      const endFrame = Math.round(clip.duration * clip.sampleRate);
      const old = clip.envelope ?? unityClipEnvelope;
      const envelope = normalizeClipEnvelope(
        {
          gain: old.gain,
          fadeIn: first === 0 ? Math.min(old.fadeIn, duration) : 0,
          fadeOut: last === endFrame ? Math.min(old.fadeOut, duration) : 0,
        },
        duration,
      );
      const playback = sliceAudioSource(clip, first, last);
      let stretch: AudioClipStretch | undefined;
      let sourceFirst = first;
      if (clip.stretch) {
        const source = clip.stretch.source;
        const frames = audioFrameCount(source);
        const map = audioClipTimeMap(clip);
        const sr = clip.sampleRate;
        const sourceFrom = Math.min(frames - 1, Math.round(map.outputToSource(first / sr) * sr));
        const sourceTo = Math.min(frames, Math.max(sourceFrom + 1, Math.round(map.outputToSource(last / sr) * sr)));
        sourceFirst = sourceFrom;
        const anchors = clip.stretch.anchors
          ?.filter((point) => point.sourceFrame > sourceFrom && point.sourceFrame < sourceTo && point.outputFrame > first && point.outputFrame < last)
          .map((point) => Object.freeze({ sourceFrame: point.sourceFrame - sourceFrom, outputFrame: point.outputFrame - first }));
        const ratio = clip.stretch.anchors?.length ? (last - first) / (sourceTo - sourceFrom) : clip.stretch.ratio;
        stretch = Object.freeze({
          ratio,
          source: sliceAudioSource(source, sourceFrom, sourceTo),
          ...(anchors?.length ? { anchors: Object.freeze(anchors) } : {}),
        });
      }
      const gainAutomation =
        clip.gainAutomation &&
        Object.freeze({ sourceStart: clip.gainAutomation.sourceStart + sourceFirst / clip.sampleRate, points: clip.gainAutomation.points });
      return Object.freeze({
        kind: "audio" as const,
        id,
        time: clip.time + first / clip.sampleRate,
        ...playback,
        duration,
        ...(envelope === unityClipEnvelope ? {} : { envelope }),
        ...(stretch ? { stretch } : {}),
        ...(gainAutomation ? { gainAutomation } : {}),
      });
    }
    const notes = clip.sequence.getState().notes.flatMap((note) => {
      const from = Math.max(start, note.start);
      const to = Math.min(end, note.end);
      return to > from ? [{ ...note, start: from - start, end: to - start }] : [];
    });
    const playback = clip.playbackEvents();
    const priorControls = new Map<string, Uint8Array>();
    const sustainAtEnd = new Map<number, number>();
    for (const event of playback) {
      const data = event.data;
      if ((data[0] & 0xf0) !== 0xb0 || data.length < 3 || data[1] >= 120) continue;
      if (event.time < start) priorControls.set(`${data[0] & 15}:${data[1]}`, data);
      if (event.time < end && data[1] === 64) sustainAtEnd.set(data[0] & 15, data[2]);
    }
    for (const event of playback)
      if (event.time === start && (event.data[0] & 0xf0) === 0xb0 && event.data.length >= 3)
        priorControls.delete(`${event.data[0] & 15}:${event.data[1]}`);
    const events: ProjectMidiEvent[] = [
      ...[...priorControls.values()].map((data) => ({ time: 0, data })),
      ...playback.flatMap((event) =>
        event.time >= start && event.time < end
          ? [{ time: event.time - start, data: event.data, ...(event.noteId ? { noteId: event.noteId } : {}) }]
          : [],
      ),
      ...[...sustainAtEnd].flatMap(([channel, value]) => (value >= 64 ? [{ time: end - start, data: new Uint8Array([0xb0 | channel, 64, 0]) }] : [])),
    ];
    return new MidiClip(id, clip.time + start, { duration: end - start, notes, events }, clip.timeUnit);
  }

  /** Keep the clip ID while removing material outside its local interval. */
  trimClip(clipId: string, start: number, end: number): ProjectClip {
    const { track, clip } = this.clipAndTrack(clipId);
    if (!validTime(start) || !Number.isFinite(end) || start >= end || end > clip.duration)
      throw new RangeError("Project trim needs 0 <= start < end <= clip duration.");
    const trimmed = this.segment(clip, start, end, clip.id);
    this.replace(track, { clips: this.sortClips(track.clips.map((item) => (item.id === clipId ? trimmed : item))) });
    if (clip instanceof MidiClip) clip.destroy();
    return trimmed;
  }

  /** Split at a local time; the left side keeps the original ID. */
  splitClip(clipId: string, offset: number): readonly [ProjectClip, ProjectClip] {
    const { track, clip } = this.clipAndTrack(clipId);
    if (!Number.isFinite(offset) || offset <= 0 || offset >= clip.duration) throw new RangeError("Project split needs a time inside the clip.");
    const rightId = this.reserve(undefined, "clip");
    let left: ProjectClip | undefined;
    let right: ProjectClip | undefined;
    try {
      left = this.segment(clip, 0, offset, clip.id);
      right = this.segment(clip, offset, clip.duration, rightId);
    } catch (error) {
      if (left instanceof MidiClip) left.destroy();
      if (right instanceof MidiClip) right.destroy();
      this.ids.delete(rightId);
      throw error;
    }
    this.replace(track, {
      clips: this.sortClips([...track.clips.filter((item) => item.id !== clipId), left, right]),
    });
    if (clip instanceof MidiClip) clip.destroy();
    return [left, right];
  }

  removeClip(clipId: string): void {
    const track = this._tracks.find((item) => item.clips.some((clip) => clip.id === clipId));
    const clip = track?.clips.find((item) => item.id === clipId);
    if (!track || !clip) throw new Error("Project clip does not exist.");
    this.replace(track, { clips: Object.freeze(track.clips.filter((item) => item.id !== clipId)) });
    this.ids.delete(clipId);
    if (clip instanceof MidiClip) clip.destroy();
  }

  destroy(): void {
    for (const track of this._tracks) for (const clip of track.clips) if (clip instanceof MidiClip) clip.destroy();
  }
}
