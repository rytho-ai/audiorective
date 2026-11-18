import type { RecordedAudio } from "@audiorective/blocks";
import { normalizeRackEffects, type RackEffect } from "@audiorective/blocks/effect-rack";
import { Cell, readonlyCell } from "@audiorective/core";
import type { AutomationPoint } from "@audiorective/core/automation";
import { compileMidiPlaybackEvents, MidiSequence } from "@audiorective/midi";
import type { MidiData, MidiPlaybackEvent, RecordedMidi, RecordedMidiEvent } from "@audiorective/midi";
import { AudioMedia } from "./media";
import { TempoMap } from "./tempo-map";
import type { TempoChange } from "./tempo-map";

export type TrackKind = "audio" | "midi";
export type MidiTimeUnit = "seconds" | "beats";
/** A message at a clip-relative time in its owning MidiClip.timeUnit. */
export type ProjectMidiEvent = Readonly<{ time: number; data: Uint8Array; noteId?: string }>;
export type ProjectAudio = Pick<RecordedAudio, "sampleRate" | "channels">;
export type ProjectMarker = Readonly<{ time: number; name: string }>;

interface AudioClipBase {
  readonly kind: "audio";
  readonly id: string;
  /** Position on the project timeline, in seconds. */
  readonly time: number;
  readonly sampleRate: number;
  readonly duration: number;
}

export interface PcmAudioClip extends AudioClipBase {
  readonly channels: readonly Float32Array[];
  readonly media?: never;
}

export interface MediaAudioClip extends AudioClipBase {
  /** Borrowed immutable media; edits retain a frame window into the same asset. */
  readonly media: AudioMedia;
  readonly startFrame: number;
  readonly frameCount: number;
  readonly channels?: never;
}

export type AudioClip = PcmAudioClip | MediaAudioClip;
export const audioChannelCount = (clip: AudioClip): number => (clip.media ? clip.media.channelCount : clip.channels.length);

const midiClipTimes = new WeakMap<MidiClip, number>();

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
    midiClipTimes.set(this, time);
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
    return this.sequence.getState().duration;
  }

  get time(): number {
    return midiClipTimes.get(this)!;
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
  volume: number;
  muted: boolean;
  solo: boolean;
  pan: number;
  volumeAutomation: readonly AutomationPoint[];
  devices: readonly ProjectDevice[];
  effects: readonly RackEffect[];
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
  readonly bpm: number;
  private _tempoMap: TempoMap;
  readonly signature: readonly [number, number];
  private _tracks: readonly ProjectTrack[] = Object.freeze([]);
  private _markers: readonly ProjectMarker[] = Object.freeze([]);
  private readonly ids = new Set<string>();
  private readonly revision = new Cell(0);
  readonly cells = Object.freeze({ revision: readonlyCell(this.revision) });
  private nextId = 1;

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

  get tracks(): readonly ProjectTrack[] {
    return this._tracks;
  }

  get tempoMap(): TempoMap {
    return this._tempoMap;
  }

  /** Convert a clip's native position and offset to project seconds. */
  clipTimeSeconds(clip: ProjectClip, localTime = 0): number {
    const position = clip.time + localTime;
    return clip.kind === "midi" && clip.timeUnit === "beats" ? this._tempoMap.beatToSeconds(position) : position;
  }

  private sortClips(clips: ProjectClip[]): readonly ProjectClip[] {
    return Object.freeze(clips.sort((a, b) => this.clipTimeSeconds(a) - this.clipTimeSeconds(b)));
  }

  setTempoChanges(changes: readonly TempoChange[]): void {
    this._tempoMap = new TempoMap(this.bpm, changes);
    this._tracks = Object.freeze(this._tracks.map((track) => Object.freeze({ ...track, clips: this.sortClips([...track.clips]) })));
    this.revision.value++;
  }

  get markers(): readonly ProjectMarker[] {
    return this._markers;
  }

  /** Stable content snapshot for a separate render runtime. File-backed media remains borrowed. */
  snapshot(): Project {
    const copy = new Project({ title: this.title, bpm: this.bpm, signature: this.signature });
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
                : clip.media
                  ? clip
                  : Object.freeze({ ...clip, channels: Object.freeze(clip.channels.map((channel) => new Float32Array(channel))) }),
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
    this.revision.value++;
  }

  get title(): string {
    return this._title;
  }

  setTitle(title: string): void {
    if (!title.trim()) throw new RangeError("Project title must not be empty.");
    this._title = title.trim();
    this.revision.value++;
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
    options: { id?: string; volume?: number; muted?: boolean; solo?: boolean; pan?: number } = {},
  ): ProjectTrack {
    if (!name || (kind !== "audio" && kind !== "midi") || !Number.isFinite(options.volume ?? 1) || (options.volume ?? 1) < 0)
      throw new RangeError("Project tracks need a name, kind and non-negative volume.");
    if (
      typeof (options.muted ?? false) !== "boolean" ||
      typeof (options.solo ?? false) !== "boolean" ||
      !Number.isFinite(options.pan ?? 0) ||
      Math.abs(options.pan ?? 0) > 1
    )
      throw new RangeError("Project track mixer options need boolean mute/solo and pan from -1 to 1.");
    const track: ProjectTrack = Object.freeze({
      id: this.reserve(options.id, "track"),
      name,
      kind,
      volume: options.volume ?? 1,
      muted: options.muted ?? false,
      solo: options.solo ?? false,
      pan: options.pan ?? 0,
      volumeAutomation: Object.freeze([]),
      devices: Object.freeze([]),
      effects: Object.freeze([]),
      clips: Object.freeze([]),
    });
    this._tracks = Object.freeze([...this._tracks, track]);
    this.revision.value++;
    return track;
  }

  private track(id: string, kind: TrackKind): ProjectTrack {
    const track = this._tracks.find((item) => item.id === id);
    if (!track || track.kind !== kind) throw new Error("Project clip needs a matching track.");
    return track;
  }

  private replace(track: ProjectTrack, patch: Partial<ProjectTrack>): void {
    this._tracks = Object.freeze(this._tracks.map((item) => (item.id === track.id ? Object.freeze({ ...item, ...patch }) : item)));
    this.revision.value++;
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

  /** Replace the ordered built-in inserts after the track's WebCLAP devices. */
  setTrackEffects(trackId: string, effects: readonly RackEffect[]): void {
    const track = this._tracks.find((item) => item.id === trackId);
    if (!track) throw new Error("Project effects need an existing track.");
    this.replace(track, { effects: normalizeRackEffects(effects) });
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
    this._tracks = Object.freeze(this._tracks.filter((item) => item.id !== trackId));
    this.revision.value++;
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

  addAudioClip(trackId: string, audio: ProjectAudio, time: number, options: { id?: string } = {}): AudioClip {
    const track = this.track(trackId, "audio");
    if (
      !validTime(time) ||
      !Number.isInteger(audio.sampleRate) ||
      audio.sampleRate <= 0 ||
      audio.channels.length === 0 ||
      audio.channels.some(
        (channel) =>
          !(channel instanceof Float32Array) || channel.length !== audio.channels[0].length || channel.some((sample) => !Number.isFinite(sample)),
      )
    )
      throw new RangeError("Project audio clips need a time, sample rate and equal-length PCM channels.");
    const clip: AudioClip = Object.freeze({
      kind: "audio",
      id: this.reserve(options.id, "clip"),
      time,
      sampleRate: audio.sampleRate,
      channels: Object.freeze(audio.channels.map((channel) => new Float32Array(channel))),
      duration: audio.channels[0].length / audio.sampleRate,
    });
    this.replace(track, { clips: this.sortClips([...track.clips, clip]) });
    return clip;
  }

  /** Add file-backed PCM without copying the full take into the project model. */
  addAudioMediaClip(
    trackId: string,
    media: AudioMedia,
    time: number,
    options: { id?: string; startFrame?: number; frameCount?: number } = {},
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
    const clip: MediaAudioClip = Object.freeze({
      kind: "audio",
      id: this.reserve(options.id, "clip"),
      time,
      sampleRate: media.sampleRate,
      media,
      startFrame,
      frameCount,
      duration: frameCount / media.sampleRate,
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
    const convert = (relative: number) => beats ? this._tempoMap.secondsToBeat(time + relative) - startBeat : relative;
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
    if (clip.kind === "midi") midiClipTimes.set(clip, time);
    this._tracks = Object.freeze(
      this._tracks.map((track) => {
        if (track.id !== source.id && track.id !== target.id) return track;
        const clips = track.clips.filter((item) => item.id !== clipId);
        if (track.id === target.id) clips.push(moved);
        return Object.freeze({ ...track, clips: this.sortClips(clips) });
      }),
    );
    this.revision.value++;
  }

  duplicateClip(clipId: string, time: number, trackId?: string): ProjectClip {
    if (!validTime(time)) throw new RangeError("Project clip time must be finite and non-negative.");
    const source = this._tracks.find((item) => item.clips.some((clip) => clip.id === clipId));
    const clip = source?.clips.find((item) => item.id === clipId);
    if (!source || !clip) throw new Error("Project clip does not exist.");
    const target = trackId ?? source.id;
    if (clip.kind === "audio")
      return clip.media
        ? this.addAudioMediaClip(target, clip.media, time, { startFrame: clip.startFrame, frameCount: clip.frameCount })
        : this.addAudioClip(target, clip, time);
    return this.addMidiClip(target, { ...clip.sequence.getState(), events: clip.events }, time, { timeUnit: clip.timeUnit });
  }

  private clipAndTrack(clipId: string): { track: ProjectTrack; clip: ProjectClip } {
    const track = this._tracks.find((item) => item.clips.some((clip) => clip.id === clipId));
    const clip = track?.clips.find((item) => item.id === clipId);
    if (!track || !clip) throw new Error("Project clip does not exist.");
    return { track, clip };
  }

  /** Extract a local interval without changing the source clip. */
  private segment(clip: ProjectClip, start: number, end: number, id: string): ProjectClip {
    if (clip.kind === "audio") {
      const first = Math.round(start * clip.sampleRate);
      const last = Math.round(end * clip.sampleRate);
      if (first >= last) throw new RangeError("Project audio trim needs at least one sample.");
      if (clip.media)
        return Object.freeze({
          ...clip,
          id,
          time: clip.time + first / clip.sampleRate,
          startFrame: clip.startFrame + first,
          frameCount: last - first,
          duration: (last - first) / clip.sampleRate,
        });
      return Object.freeze({
        kind: "audio" as const,
        id,
        time: clip.time + first / clip.sampleRate,
        sampleRate: clip.sampleRate,
        channels: Object.freeze(clip.channels.map((channel) => channel.slice(first, last))),
        duration: (last - first) / clip.sampleRate,
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
