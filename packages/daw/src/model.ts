import {
  assertProjectActive,
  collidesWithProjectId,
  importedBundles,
  preservedEntries,
  markProjectDisposed,
  nextProjectId,
  validateXmlText,
  validProjectId,
} from "./project-persistence";
import {
  normalizeRackEffects,
  normalizeRackPreset,
  retainRackMacroTargets,
  type RackEffect,
  type RackMacroSettings,
  type RackPreset,
} from "./rack-preset";
import type { PCMData } from "@audiorective/core";
import { batch, Cell, readonlyCell, ReadonlyCell, untracked } from "@audiorective/core";
import { AutomationCurve, type AutomationPoint } from "@audiorective/core/automation";
import { compileMidiPlaybackEvents, MidiClip as MidiNotes } from "@audiorective/midi";
import type { MidiNote, MidiPlaybackEvent, MidiTake, NoteInit } from "@audiorective/midi";
import { AudioMedia } from "./media";
import {
  checkArguments,
  freezeJson,
  thawJson,
  type ExtensionDefinition,
  type JsonValue,
  type ProjectExtension,
  type ProjectOperation,
  type ProjectOperations,
} from "./extensions";
import { TempoMap } from "./tempo-map";
import { rippleDelete as rippleDeleteRange } from "./ripple-delete";
import type { TempoChange } from "./tempo-map";
import { ClipTimeMap, normalizeClipAnchors, type ClipStretchAnchor } from "./clip-time-map";
import { normalizeClipEnvelope, unityClipEnvelope, type ClipEnvelope } from "./clip-envelope";
import {
  findProjectClips,
  ProjectEditFailure,
  projectOverview,
  runProjectEdits,
  type ProjectClipQuery,
  type ProjectClipSummary,
  type ProjectEditCopies,
  type ProjectEditReceipt,
  type ProjectEditRequest,
  type ProjectOverview,
  type ProjectVersion,
  type BeatRange,
  type SecondsRange,
  type TimeRange,
} from "./project-edits";
import { audioLoopFrames, audioLoopSourceFrame, loopedNotes, loopedTimes } from "./clip-loop";
import { emptySession, registerSessionReader, slotKey, splitSlotKey, type SessionScene, type SessionState } from "./session-state";

export type TrackKind = "audio" | "midi" | "bus";
export type BusRole = "submix" | "effect";
export type ProjectSend = Readonly<{ busId: string; gain: number }>;
export type TrackRouting = Readonly<{ outputBusId: string | null; sends: readonly ProjectSend[] }>;
const masterRouting: TrackRouting = Object.freeze({ outputBusId: null, sends: Object.freeze([]) });
/** A message at a clip-relative time in beats. */
export type ProjectMidiEvent = Readonly<{ time: number; data: Uint8Array; noteId?: string }>;
export type ProjectAudio = Pick<PCMData, "sampleRate" | "channels">;
export type ProjectMarker = Readonly<{
  /** Position in project seconds. */
  time: number;
  name: string;
}>;

export type PcmAudioSource = ProjectAudio & Readonly<{ media?: never }>;
export type MediaAudioSource = Readonly<{
  sampleRate: number;
  media: AudioMedia;
  startFrame: number;
  frameCount: number;
  channels?: never;
}>;
export type AudioClipSource = PcmAudioSource | MediaAudioSource;
/** Where an audio window sits inside its whole recording. */
export type AudioSourceSpan = Readonly<{
  /** Seconds into its recording where this audio begins. */
  sourceOffset: number;
  /** Total seconds of the recording this audio is a window of. */
  sourceLength: number;
}>;
/** What a caller supplies to stretch a clip. The project describes the stored source with `sourceOffset` and `sourceLength`. */
export type AudioClipStretchInit = Readonly<{ ratio: number; source: AudioClipSource; anchors?: readonly ClipStretchAnchor[] }>;
export type AudioClipStretch = Readonly<{ ratio: number; source: AudioClipSource & AudioSourceSpan; anchors?: readonly ClipStretchAnchor[] }>;
export type AudioClipGainAutomation = Readonly<{
  /**
   * Original source seconds at the start of this clip's current window. Point times are source seconds; on a looped clip they are positions
   * in the recording, so the curve repeats with every pass of the loop.
   */
  sourceStart: number;
  points: readonly AutomationPoint[];
}>;

type AudioClipOptions = {
  id?: string;
  name?: string;
  envelope?: ClipEnvelope;
  stretch?: AudioClipStretchInit;
  gainAutomation?: AudioClipGainAutomation;
};

interface AudioClipBase extends AudioSourceSpan {
  readonly kind: "audio";
  readonly id: string;
  /** Position on the project timeline, in seconds. */
  readonly time: number;
  readonly duration: number;
  readonly envelope?: ClipEnvelope;
  readonly gainAutomation?: AudioClipGainAutomation;
  readonly stretch?: AudioClipStretch;
  /** The part of the recording that repeats, in seconds of the recording (the frame `sourceOffset` uses). Set with `Project.setClipLoop`. */
  readonly loop?: SecondsRange;
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

/** The whole recording behind a PCM window, found from the window's first channel. */
const pcmRecordings = new WeakMap<Float32Array, { channels: readonly Float32Array[]; offset: number }>();
/** PCM arrays a caller hands over as a window of a recording, so `addAudioClip` keeps them instead of copying. */
const adoptedWindows = new WeakSet<Float32Array>();
const outsideRecording = () => new RangeError("Project clip edges must stay inside its recording.");

function recordingOf(source: AudioClipSource): { channels?: readonly Float32Array[]; offset: number; frames: number } {
  if (source.media) return { offset: source.startFrame, frames: source.media.frameCount };
  const entry = pcmRecordings.get(source.channels[0]);
  return entry
    ? { channels: entry.channels, offset: entry.offset, frames: entry.channels[0].length }
    : { channels: source.channels, offset: 0, frames: source.channels[0].length };
}

function recorded<S extends AudioClipSource>(source: S): S & AudioSourceSpan {
  const { offset, frames } = recordingOf(source);
  return Object.freeze(Object.assign({}, source, { sourceOffset: offset / source.sampleRate, sourceLength: frames / source.sampleRate }));
}

/**
 * Codec access to the whole recording behind a clip: `source` holds all of it, `offset` and `frames` place the clip's window in frames, and `key`
 * is the identity shared by every clip cut from that recording.
 */
export function audioRecording(source: AudioClipSource): { source: AudioClipSource; key: object; offset: number; frames: number } {
  const { channels, offset, frames } = recordingOf(source);
  return source.media
    ? {
        source: Object.freeze({ sampleRate: source.sampleRate, media: source.media, startFrame: 0, frameCount: source.media.frameCount }),
        key: source.media,
        offset,
        frames,
      }
    : { source: Object.freeze({ sampleRate: source.sampleRate, channels: channels! }), key: channels!, offset, frames };
}

/** Codec access: cut a window `[from, to)` frames out of a decoded recording, keeping the recording behind it, for `addAudioClip`. */
export function windowOfRecording(recording: ProjectAudio, from: number, to: number): ProjectAudio {
  const window = sliceAudioSource({ sampleRate: recording.sampleRate, channels: recording.channels }, from, to) as PcmAudioSource;
  adoptedWindows.add(window.channels[0]);
  return window;
}

function audioSource(clip: AudioClip): AudioClipSource & AudioSourceSpan {
  return recorded(
    clip.media
      ? Object.freeze({ sampleRate: clip.sampleRate, media: clip.media, startFrame: clip.startFrame, frameCount: clip.frameCount })
      : Object.freeze({ sampleRate: clip.sampleRate, channels: clip.channels }),
  );
}

/**
 * A window `[from, to)` in frames of this source's current audio. It may reach outside the current window while it stays inside the recording.
 * With `own`, the window is its own recording: time-stretched audio is saved as the window alone, so it never reveals more.
 */
function sliceAudioSource(source: AudioClipSource, from: number, to: number, own = false): AudioClipSource & AudioSourceSpan {
  if (from >= to) throw new RangeError("Project audio trim needs at least one sample.");
  const recording = own && !source.media ? { channels: source.channels, offset: 0, frames: source.channels[0].length } : recordingOf(source);
  const start = recording.offset + from;
  const end = recording.offset + to;
  if (start < 0 || end > recording.frames) throw outsideRecording();
  if (source.media) return recorded(Object.freeze({ sampleRate: source.sampleRate, media: source.media, startFrame: start, frameCount: to - from }));
  const channels = Object.freeze(recording.channels!.map((channel) => channel.subarray(start, end)));
  if (!own) pcmRecordings.set(channels[0], { channels: recording.channels!, offset: start });
  return recorded(Object.freeze({ sampleRate: source.sampleRate, channels }));
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
  stretch: AudioClipStretchInit | undefined,
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
  return Object.freeze({ ratio, source: recorded(snapshotAudioSource(source)), ...(anchors.length ? { anchors } : {}) });
}

/** Copy a source. With a `recordings` cache the whole recording is copied once and the copy stays a window of it. */
function snapshotAudioSource(source: AudioClipSource, recordings?: Map<readonly Float32Array[], readonly Float32Array[]>): AudioClipSource {
  if (source.media)
    return Object.freeze({ sampleRate: source.sampleRate, media: source.media, startFrame: source.startFrame, frameCount: source.frameCount });
  if (!recordings)
    return Object.freeze({ sampleRate: source.sampleRate, channels: Object.freeze(source.channels.map((channel) => channel.slice())) });
  const { channels: whole, offset } = recordingOf(source);
  let copy = recordings.get(whole!);
  if (!copy) recordings.set(whole!, (copy = Object.freeze(whole!.map((channel) => channel.slice()))));
  const frames = source.channels[0].length;
  const channels = Object.freeze(copy.map((channel) => channel.subarray(offset, offset + frames)));
  pcmRecordings.set(channels[0], { channels: copy, offset });
  return Object.freeze({ sampleRate: source.sampleRate, channels });
}

function snapshotAudioClip(clip: AudioClip, recordings: Map<readonly Float32Array[], readonly Float32Array[]>): AudioClip {
  const stretch =
    clip.stretch && !clip.stretch.source.media
      ? Object.freeze({ ...clip.stretch, source: recorded(snapshotAudioSource(clip.stretch.source, recordings)) })
      : clip.stretch;
  if (clip.media && stretch === clip.stretch) return clip;
  return Object.freeze({
    kind: "audio",
    id: clip.id,
    time: clip.time,
    duration: clip.duration,
    ...recorded(snapshotAudioSource(clip, recordings)),
    ...(clip.envelope ? { envelope: clip.envelope } : {}),
    ...(stretch ? { stretch } : {}),
    ...(clip.gainAutomation ? { gainAutomation: clip.gainAutomation } : {}),
    ...(clip.loop ? { loop: clip.loop } : {}),
  });
}

const midiClipTimes = new WeakMap<MidiClip, Cell<number>>();

function normalizeClipName(name: string | undefined): string | undefined {
  if (name === undefined) return undefined;
  if (typeof name !== "string") throw new TypeError("Project clip name must be a string.");
  validateXmlText(name);
  return name.trim() ? name : undefined;
}

/** What a MIDI clip holds: notes, the clip length and the non-note messages, all in beats from the clip's start. */
export type ProjectMidiData = Readonly<{ notes: readonly NoteInit[]; duration: number; events?: readonly ProjectMidiEvent[] }>;

/**
 * A MIDI clip of the project. Everything is in beats: `time` is the position in project beats, `duration` the clip length in beats, and note and
 * event times are beats from the clip's start. `midi` owns the editable notes; notes beyond `duration` are cut at playback. `duration` changes
 * only through the project's clip operations (`resizeClip`, `splitClip`, ...), which replace the clip.
 */
export class MidiClip {
  readonly kind = "midi" as const;
  /** The note model: `clip.midi.notes.value`, `clip.midi.edit(draft => ...)`, `clip.midi.setNotes(notes)`. */
  readonly midi: MidiNotes;
  /** The clip length in beats. */
  readonly duration: number;
  /** The part of the clip's own note time that repeats until `duration`, in beats from the clip's content start. Set with `Project.setClipLoop`. */
  readonly loop?: BeatRange;
  private readonly sourceEvents: readonly ProjectMidiEvent[];

  constructor(
    readonly id: string,
    time: number,
    data: ProjectMidiData,
    loop?: BeatRange,
  ) {
    if (!Number.isFinite(data.duration) || data.duration < 0) throw new RangeError("Project MIDI duration must be finite non-negative beats.");
    midiClipTimes.set(this, new Cell(time));
    this.sourceEvents = Object.freeze(
      (data.events ?? []).map((event) => {
        if (!Number.isFinite(event.time) || event.time < 0 || !(event.data instanceof Uint8Array) || event.data.length === 0)
          throw new RangeError("Project MIDI events need finite non-negative times and MIDI bytes.");
        return Object.freeze({ time: event.time, data: new Uint8Array(event.data), ...(event.noteId ? { noteId: event.noteId } : {}) });
      }),
    );
    this.duration = data.duration;
    if (loop) this.loop = loop;
    this.midi = new MidiNotes(data.notes);
  }

  /** The position in project beats. Tracked. */
  get time(): number {
    return midiClipTimes.get(this)!.value;
  }

  /** Copies preserve the clip's event owner when a caller edits returned bytes. */
  get events(): readonly ProjectMidiEvent[] {
    return this.sourceEvents.map((event) => ({ ...event, data: new Uint8Array(event.data) }));
  }

  /** The clip's MIDI messages in order, `beat` in beats from the clip's start: notes cut at `duration`, then the non-note events inside it. */
  playbackEvents(): readonly MidiPlaybackEvent[] {
    const duration = this.duration;
    const loop = this.loop;
    const source = untracked(() => this.midi.notes.value);
    const notes = loop
      ? loopedNotes(source, loop, duration)
      : source.flatMap((note) => {
          const end = Math.min(note.start + note.duration, duration);
          return note.start < duration && end > note.start ? [{ ...note, duration: end - note.start }] : [];
        });
    const events = loop
      ? this.sourceEvents.flatMap(({ time, data, noteId }) =>
          loopedTimes(time, loop, duration).flatMap((beat, pass) =>
            pass === 0 || ((data[0] & 0xf0) !== 0x80 && (data[0] & 0xf0) !== 0x90)
              ? [{ beat, data, ...(noteId && pass === 0 ? { noteId } : {}) }]
              : [],
          ),
        )
      : this.sourceEvents
          .filter((event) => event.time <= duration)
          .map(({ time, data, noteId }) => ({ beat: time, data, ...(noteId ? { noteId } : {}) }));
    return compileMidiPlaybackEvents({ events }, { notes, duration });
  }

  dispose(): void {
    this.midi.dispose();
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

/** Everything a Project persists: its structural revision plus each MIDI clip's notes, which the clip's `midi` model owns. */
export type ProjectContent = Readonly<{
  revision: number;
  midi: ReadonlyMap<string, Readonly<{ notes: readonly MidiNote[]; duration: number }>>;
}>;

export type ProjectOptions = Readonly<{
  title?: string;
  bpm?: number;
  signature?: readonly [number, number];
}>;

type ProjectState = Readonly<{
  revision: number;
  /** Counts content commits. A live device-state capture advances `revision` only. */
  edits: number;
  /** Display names by clip ID. Kept off the clip objects so that renaming never looks like an audio change to playback. */
  clipNames: ReadonlyMap<string, string>;
  title: string;
  masterVolume: number;
  tempoMap: TempoMap;
  tracks: readonly ProjectTrack[];
  markers: readonly ProjectMarker[];
  /** Extension data by extension id, kept as saved even when no definition is loaded. */
  extensions: ReadonlyMap<string, ExtensionRecord>;
  /** The Session grid: scenes and the clips in their slots. */
  session: SessionState;
}>;

/** One extension's saved data and the format version it was written with. */
export type ExtensionRecord = Readonly<{ version: number; data: JsonValue }>;

const clipSeconds = (tempoMap: TempoMap, clip: ProjectClip, localTime = 0): number => {
  const position = clip.time + localTime;
  return clip.kind === "midi" ? tempoMap.beatToSeconds(position) : position;
};

const validTime = (time: number) => Number.isFinite(time) && time >= 0;

type ClipLocation = Readonly<{ clip: ProjectClip; track: ProjectTrack }> | Readonly<{ clip: ProjectClip; key: string; track?: undefined }>;

/** The same clip placed at time 0, as a Session slot holds it. */
function atZero(clip: ProjectClip): ProjectClip {
  if (clip.kind === "midi") {
    midiClipTimes.get(clip)!.value = 0;
    return clip;
  }
  return clip.time === 0 ? clip : Object.freeze({ ...clip, time: 0 });
}

const HISTORY_LIMIT = 50;
let nextProjectInstance = 1;

/** A clip's place: on a track's timeline, or (with `sceneId`) in a Session slot of that track. */
type EditPlacement = Readonly<{
  trackId: string;
  sceneId?: string;
  clip: ProjectClip;
  time: number;
  name: string | undefined;
  notes?: readonly MidiNote[];
}>;
type EditSide = Readonly<{
  clips: ReadonlyMap<string, EditPlacement>;
  tempoMap: TempoMap;
  markers: readonly ProjectMarker[];
  automation: ReadonlyMap<string, readonly AutomationPoint[]>;
  extensions: ReadonlyMap<string, ExtensionRecord>;
  /** The Session scenes by id; slot clips are in `clips`. */
  scenes: ReadonlyMap<string, SessionScene>;
  session: SessionState;
}>;
type EditEntry = {
  readonly label: string;
  readonly ids: readonly string[];
  readonly tempo: boolean;
  readonly markers: boolean;
  readonly automation: readonly string[];
  readonly extensions: readonly string[];
  /** IDs of the scenes this edit added, removed or renamed. */
  readonly scenes: readonly string[];
  before: EditSide;
  after: EditSide;
};

/** `MidiClip.setNotes` makes a new array, so history compares notes by content. */
const sameNotes = (a: readonly MidiNote[] | undefined, b: readonly MidiNote[] | undefined): boolean =>
  a === b ||
  (!!a &&
    !!b &&
    a.length === b.length &&
    a.every((note, index) => {
      const other = b[index];
      return (
        note === other ||
        (note.id === other.id &&
          note.pitch === other.pitch &&
          note.velocity === other.velocity &&
          note.start === other.start &&
          note.duration === other.duration &&
          note.channel === other.channel)
      );
    }));
const samePlacement = (a: EditPlacement | undefined, b: EditPlacement | undefined): boolean =>
  a === b ||
  (!!a &&
    !!b &&
    a.trackId === b.trackId &&
    a.sceneId === b.sceneId &&
    a.clip === b.clip &&
    a.time === b.time &&
    a.name === b.name &&
    sameNotes(a.notes, b.notes));
const clipFrameTolerance = (clip: ProjectClip) => (clip.kind === "audio" ? 1 / clip.sampleRate : 1e-9);
const trackShellKeys = ["id", "name", "kind", "busRole", "routing", "volume", "muted", "solo", "pan", "devices", "effects", "effectMacros"] as const;

let captureDeviceHook: (project: Project, deviceId: string, bytes: Uint8Array) => void;
let borrowSnapshotHook: (project: Project) => Project;
let extensionRecordsHook: (project: Project, records?: ReadonlyMap<string, ExtensionRecord>) => ReadonlyMap<string, ExtensionRecord>;
let sessionBridgeHook: (project: Project) => SessionBridge;
let restoreScenesHook: (project: Project, scenes: readonly Readonly<{ id?: string; name?: string }>[]) => void;
let adoptSlotHook: (project: Project, clipId: string, sceneId: string) => void;

/** What `ProjectSession` needs from its Project: reads of the Session grid and the writes that keep ids, names, history and the version in step. */
export type SessionBridge = Readonly<{
  /** The grid, read tracked. */
  state(): SessionState;
  /** The grid, read untracked. */
  peek(): SessionState;
  trackKind(trackId: string): TrackKind | undefined;
  newSceneId(): string;
  /** A clip made for a slot, at time 0, with its ID reserved. */
  midi(data: ProjectMidiData, name: string | undefined): { clip: MidiClip; name: string | undefined };
  audio(audio: ProjectAudio, name: string | undefined): { clip: AudioClip; name: string | undefined };
  /** A copy of a clip with its own ID, name, loop and envelope. */
  clone(clip: ProjectClip, time: number): { clip: ProjectClip; name: string | undefined };
  /** Replace the grid. `named` clips take their names; `dropped` clips and `droppedIds` leave the project. */
  write(
    next: SessionState,
    change?: Readonly<{ named?: ReadonlyMap<string, string>; dropped?: readonly ProjectClip[]; droppedIds?: readonly string[] }>,
  ): void;
  /** Put a detached clip on a track of its kind. */
  place(trackId: string, clip: ProjectClip, name: string | undefined): void;
  clipName(clipId: string): string | undefined;
  tempoMap(): TempoMap;
}>;

/** Headless project content. AudioContext and UI state are not part of the file. */
export class Project {
  static {
    captureDeviceHook = (project, deviceId, bytes) => project.captureDevice(deviceId, bytes);
    borrowSnapshotHook = (project) => untracked(() => project.snapshotUntracked(true));
    extensionRecordsHook = (project, records) => {
      if (records) project.commit({ extensions: records }, false);
      return project.s.extensions;
    };
    sessionBridgeHook = (project) => project.sessionBridge();
    restoreScenesHook = (project, scenes) => project.restoreScenes(scenes);
    adoptSlotHook = (project, clipId, sceneId) => project.adoptSlot(clipId, sceneId);
  }

  readonly signature: readonly [number, number];
  /** The only store for observable content. Written by `commit`, read tracked by the public getters. */
  private readonly store: Cell<ProjectState>;
  private readonly ids = new Set<string>();
  /**
   * `revision` counts structural commits. `content` also re-runs for note edits made through a
   * `MidiClip.midi`, which owns its notes.
   */
  readonly cells: Readonly<{
    revision: ReadonlyCell<number>;
    /** One version across structure and individual note edits. Pass it to `applyEdits` as `expectedVersion`. */
    version: ReadonlyCell<ProjectVersion>;
    /** The labels of the next undo and redo, when there is one. */
    history: ReadonlyCell<Readonly<{ undo?: string; redo?: string }>>;
    content: ReadonlyCell<ProjectContent>;
  }>;
  private readonly historyLabels = new Cell<Readonly<{ undo?: string; redo?: string }>>(Object.freeze({}));
  private undoStack: EditEntry[] = [];
  private redoStack: EditEntry[] = [];
  private editing?: { retired: Set<MidiClip> };
  /** Note revisions spent by rolled-back edits, so a failed edit leaves the version unchanged. */
  private spentNoteRevisions = 0;
  private readonly extensionHandles = new Map<ExtensionDefinition<unknown>, ProjectExtension<unknown>>();
  private readonly operationTable = new Map<string, ProjectOperation<never, unknown>>();
  /** Named operations an app registers on this song, for its own buttons and for agents: `register`, `list`, `call`. */
  readonly operations: ProjectOperations;

  /** Untracked read of the current snapshot, for the owner's own logic. */
  private get s(): ProjectState {
    return untracked(() => this.store.value);
  }

  /** Replace part of the snapshot and advance the revision in one write. */
  private commit(patch: Partial<Omit<ProjectState, "revision" | "edits">>, isEdit = true): void {
    const current = this.s;
    this.store.value = Object.freeze({ ...current, ...patch, revision: current.revision + 1, edits: current.edits + (isEdit ? 1 : 0) });
  }

  private noteRevisions(state: ProjectState): number {
    let total = 0;
    for (const track of state.tracks) for (const clip of track.clips) if (clip instanceof MidiClip) total += clip.midi.revision.value;
    for (const clip of state.session.slots.values()) if (clip instanceof MidiClip) total += clip.midi.revision.value;
    return total;
  }

  /** A clip leaving the arrangement stays alive while an edit in progress or the history may bring it back. */
  private retire(clip: ProjectClip): void {
    if (!(clip instanceof MidiClip)) return;
    if (this.editing) this.editing.retired.add(clip);
    else clip.dispose();
  }

  constructor(options: ProjectOptions = {}) {
    validateXmlText(options.title ?? "Untitled");
    const bpm = options.bpm ?? 120;
    this.signature = Object.freeze([...(options.signature ?? [4, 4])] as [number, number]);
    if (
      !Number.isFinite(bpm) ||
      bpm <= 0 ||
      !Number.isInteger(this.signature[0]) ||
      this.signature[0] <= 0 ||
      !Number.isInteger(this.signature[1]) ||
      this.signature[1] <= 0 ||
      (this.signature[1] & (this.signature[1] - 1)) !== 0
    )
      throw new RangeError("Project needs positive BPM and a valid time signature.");
    this.store = new Cell<ProjectState>(
      Object.freeze({
        revision: 0,
        edits: 0,
        clipNames: new Map(),
        title: options.title ?? "Untitled",
        masterVolume: 1,
        tempoMap: new TempoMap(bpm),
        tracks: Object.freeze([]),
        markers: Object.freeze([]),
        extensions: new Map(),
        session: emptySession,
      }),
    );
    const store = this.store;
    registerSessionReader(this, () => untracked(() => store.value.session));
    const instance = `${(nextProjectInstance++).toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    this.cells = Object.freeze({
      revision: readonlyCell(() => store.value.revision),
      version: readonlyCell(() => {
        const state = store.value;
        return `${instance}:${state.edits}:${this.noteRevisions(state) - this.spentNoteRevisions}` as ProjectVersion;
      }),
      history: readonlyCell(this.historyLabels),
      content: readonlyCell<ProjectContent>(() => {
        const state = store.value;
        const midi = new Map<string, { notes: readonly MidiNote[]; duration: number }>();
        for (const track of state.tracks)
          for (const clip of track.clips) if (clip instanceof MidiClip) midi.set(clip.id, { notes: clip.midi.notes.value, duration: clip.duration });
        for (const clip of state.session.slots.values())
          if (clip instanceof MidiClip) midi.set(clip.id, { notes: clip.midi.notes.value, duration: clip.duration });
        return Object.freeze({ revision: state.revision, midi });
      }),
    });
    const table = this.operationTable;
    this.operations = Object.freeze({
      register: (operation: ProjectOperation<never, unknown>) => {
        assertProjectActive(this);
        if (typeof operation?.name !== "string" || typeof operation.run !== "function" || operation.input?.type !== "object")
          throw new TypeError("Project operations take an operation from defineOperation.");
        if (table.has(operation.name)) throw new Error(`Project already has an operation named "${operation.name}".`);
        table.set(operation.name, operation);
        return () => {
          if (table.get(operation.name) === operation) table.delete(operation.name);
        };
      },
      list: () => Object.freeze([...table.values()].map(({ name, description, input }) => Object.freeze({ name, description, input }))),
      call: <Result = unknown>(name: string, args: object = {}): Result => {
        assertProjectActive(this);
        const operation = table.get(name) as ProjectOperation<object, Result> | undefined;
        if (!operation) throw new Error(`Project has no operation named "${name}".`);
        checkArguments(name, operation.input, args);
        return this.edit(operation.label ?? operation.description, () => operation.run(this, args));
      },
    });
  }

  /**
   * This song's data for an app extension, created on first use: `const chain = project.extension(chainDefinition)`; `chain.value`, `chain.update((scenes) => { scenes.push(1); })`.
   * Data the file holds for it is checked with the definition's `validate`; data that fails falls back to `defaultValue()` and stays in the file until changed.
   */
  extension<T>(definition: ExtensionDefinition<T>): ProjectExtension<T> {
    assertProjectActive(this);
    const known = this.extensionHandles.get(definition as ExtensionDefinition<unknown>);
    if (known) return known as ProjectExtension<T>;
    const { id } = definition;
    const parsed = new WeakMap<ExtensionRecord, T>();
    let fallback: T | undefined;
    const read = (record: ExtensionRecord | undefined): T => {
      // Data from a newer version of the extension reads as the default; `set` refuses to overwrite it.
      if (!record || record.version > definition.version)
        return (fallback ??= freezeJson(definition.defaultValue(), `Extension "${id}" default value`) as T);
      const hit = parsed.get(record);
      if (hit !== undefined) return hit;
      let value: T;
      try {
        value = freezeJson(
          definition.validate ? definition.validate(thawJson(record.data), record.version) : record.data,
          `Extension "${id}" data`,
        ) as T;
      } catch {
        value = read(undefined);
      }
      parsed.set(record, value);
      return value;
    };
    const cell = readonlyCell(() => read(this.store.value.extensions.get(id)));
    const set = (value: T) => {
      assertProjectActive(this);
      const current = this.s.extensions.get(id);
      if (current && current.version > definition.version)
        throw new Error(
          `Extension "${id}" data was saved by its version ${current.version}; this app has version ${definition.version} and cannot change it.`,
        );
      const data = freezeJson(value, `Extension "${id}" data`);
      if (JSON.stringify(data) === JSON.stringify(untracked(() => cell.value))) return;
      const record: ExtensionRecord = Object.freeze({ version: definition.version, data });
      parsed.set(record, record.data as T);
      const extensions = new Map(this.s.extensions);
      extensions.set(id, record);
      this.commit({ extensions });
    };
    const handle: ProjectExtension<T> = Object.freeze({
      definition,
      get value() {
        return cell.value;
      },
      subscribe: cell.subscribe.bind(cell),
      set,
      update: (recipe: (draft: never) => unknown) => {
        const draft = thawJson(untracked(() => cell.value));
        const returned = recipe(draft as never);
        set((returned === undefined ? draft : returned) as T);
      },
    }) as ProjectExtension<T>;
    this.extensionHandles.set(definition as ExtensionDefinition<unknown>, handle as unknown as ProjectExtension<unknown>);
    return handle;
  }

  private sessionBridge(): SessionBridge {
    return Object.freeze({
      state: () => this.store.value.session,
      peek: () => this.s.session,
      trackKind: (trackId: string) => this.s.tracks.find((track) => track.id === trackId)?.kind,
      newSceneId: () => this.reserve(undefined, "scene"),
      midi: (data: ProjectMidiData, name: string | undefined) => this.buildMidiClip(data, 0, { name }),
      audio: (audio: ProjectAudio, name: string | undefined) => this.buildAudioClip(audio, 0, { name }),
      clone: (clip: ProjectClip, time: number) => untracked(() => this.cloneClip(clip, time)),
      write: (
        next: SessionState,
        change: Readonly<{ named?: ReadonlyMap<string, string>; dropped?: readonly ProjectClip[]; droppedIds?: readonly string[] }> = {},
      ) => {
        const dropped = change.dropped ?? [];
        for (const clip of dropped) {
          this.ids.delete(clip.id);
          this.retire(clip);
        }
        for (const id of change.droppedIds ?? []) this.ids.delete(id);
        const names = new Map(this.s.clipNames);
        for (const clip of dropped) names.delete(clip.id);
        for (const [id, name] of change.named ?? []) names.set(id, name);
        this.commit({ session: next, clipNames: names });
      },
      place: (trackId: string, clip: ProjectClip, name: string | undefined) => {
        const track = this.s.tracks.find((item) => item.id === trackId)!;
        this.replace(track, { clips: this.sortClips([...track.clips, clip]) }, this.namedClip(clip.id, name));
      },
      clipName: (clipId: string) => this.s.clipNames.get(clipId),
      tempoMap: () => this.s.tempoMap,
    });
  }

  /** Opening a file: the saved scenes, empty, with their IDs reserved. Not an Undo step. */
  private restoreScenes(scenes: readonly Readonly<{ id?: string; name?: string }>[]): void {
    const made: SessionScene[] = [];
    for (const [index, scene] of scenes.entries()) {
      const id = this.reserve(scene.id, "scene");
      const name = scene.name ?? `Scene ${index + 1}`;
      validateXmlText(name);
      made.push(Object.freeze({ id, name }));
    }
    this.commit({ session: Object.freeze({ scenes: Object.freeze(made), slots: new Map() }) }, false);
  }

  /** Opening a file: a clip read onto the timeline moves into a slot of its track. Not an Undo step. */
  private adoptSlot(clipId: string, sceneId: string): void {
    const { track, clip } = this.clipAndTrack(clipId);
    const session = this.s.session;
    this.commit(
      {
        tracks: Object.freeze(
          this.s.tracks.map((item) =>
            item.id === track.id ? Object.freeze({ ...item, clips: Object.freeze(item.clips.filter((c) => c !== clip)) }) : item,
          ),
        ),
        session: Object.freeze({ scenes: session.scenes, slots: new Map(session.slots).set(slotKey(sceneId, track.id), atZero(clip)) }),
      },
      false,
    );
  }

  /** A copy of `clip` at `time` with its own ID, name, loop and envelope, not placed anywhere. */
  private cloneClip(clip: ProjectClip, time: number): { clip: ProjectClip; name: string | undefined } {
    const name = this.s.clipNames.get(clip.id);
    if (clip.kind === "audio") {
      const options = { name, envelope: clip.envelope, stretch: clip.stretch, gainAutomation: clip.gainAutomation };
      const built = clip.media
        ? this.buildMediaClip(clip.media, time, { ...options, startFrame: clip.startFrame, frameCount: clip.frameCount })
        : this.buildAudioClip(clip, time, options);
      if (!clip.loop) return built;
      return { clip: Object.freeze({ ...built.clip, duration: clip.duration, loop: Object.freeze({ ...clip.loop }) }), name };
    }
    const id = this.reserve(undefined, "clip");
    const loop = clip.loop && Object.freeze({ ...clip.loop });
    return { clip: new MidiClip(id, time, { notes: clip.midi.notes.value, duration: clip.duration, events: clip.events }, loop), name };
  }

  /** Read a compact, JSON-serializable view and the version it describes. */
  overview(): ProjectOverview {
    return projectOverview(this, this.cells.version.value);
  }

  /** Return the named marker by chronological occurrence, starting at 1. */
  findMarker(query: Readonly<{ name: string; occurrence?: number }>): ProjectMarker | undefined {
    const occurrence = query.occurrence ?? 1;
    if (!Number.isInteger(occurrence) || occurrence < 1) throw new RangeError("Project marker occurrence must be a positive integer.");
    return this.markers.filter((marker) => marker.name === query.name)[occurrence - 1];
  }

  /** Match clips by exact track and half-open beat range; the default relation is `"overlaps"`. */
  findClips(query: ProjectClipQuery = {}): readonly ProjectClipSummary[] {
    return findProjectClips(this, query);
  }

  /**
   * Apply JSON-serializable operations in order as one undoable edit. A stale `expectedVersion` returns `conflict`;
   * a step that cannot run returns `rejected` with its `opIndex`. Either way the Project is left as it was.
   */
  applyEdits(request: ProjectEditRequest): ProjectEditReceipt {
    assertProjectActive(this);
    const version = untracked(() => this.cells.version.value);
    if (!request || typeof request !== "object")
      return { status: "rejected", version, code: "invalid-request", reason: "applyEdits needs { expectedVersion, label, ops }." };
    if (request.expectedVersion !== version)
      return { status: "conflict", version, reason: "The project changed since this version was read. Read it again and rebuild the edit." };
    if (typeof request.label !== "string" || !request.label.trim())
      return { status: "rejected", version, code: "invalid-request", reason: "applyEdits needs a non-empty label." };
    try {
      // A rehearsal on a borrowed copy finds a failing step before any listener of this Project can observe it.
      const rehearsal = untracked(() => this.snapshotUntracked(true));
      try {
        rehearsal.runEdit(request.label, () => runProjectEdits(rehearsal, request.ops));
      } finally {
        rehearsal.dispose();
      }
      let copies: ProjectEditCopies = {};
      if (this.editing) {
        // Inside an open edit the ops join its Undo step; the rehearsal above already proved they apply.
        copies = runProjectEdits(this, request.ops);
        return this.appliedReceipt(undefined, "after", copies);
      }
      const entry = this.runEdit(request.label, () => {
        copies = runProjectEdits(this, request.ops);
      }).entry;
      return this.appliedReceipt(entry, "after", copies);
    } catch (error) {
      if (error instanceof ProjectEditFailure)
        return {
          status: "rejected",
          version,
          code: error.code,
          reason: error.message,
          ...(error.opIndex === undefined ? {} : { opIndex: error.opIndex }),
        };
      throw error;
    }
  }

  /**
   * Group synchronous calls to this Project's clip, note, tempo, marker and volume-automation methods into one undoable edit.
   * If `action` throws, every step is rolled back and the error is rethrown.
   */
  edit<T>(label: string, action: () => T): T {
    assertProjectActive(this);
    if (this.editing) {
      // Inside an open edit (an operation or another edit) the steps join that edit's Undo step.
      const result = action();
      if (typeof (result as { then?: unknown } | null | undefined)?.then === "function") {
        (result as unknown as Promise<unknown>).then(undefined, () => undefined);
        throw new TypeError("Project edit action must be synchronous.");
      }
      return result;
    }
    return this.runEdit(label, action).result;
  }

  /**
   * Undo the latest edit as one step. Returns `conflict` and changes nothing if something it touched has changed since.
   * With `expectedVersion`, any later change to the Project is a conflict.
   */
  undo(options: Readonly<{ expectedVersion?: ProjectVersion }> = {}): ProjectEditReceipt {
    return this.stepHistory("undo", options.expectedVersion);
  }

  /** Redo the latest undone edit, under the same conflict rules as `undo`. */
  redo(options: Readonly<{ expectedVersion?: ProjectVersion }> = {}): ProjectEditReceipt {
    return this.stepHistory("redo", options.expectedVersion);
  }

  /** Forget undo and redo, for example after loading unrelated content into this Project. */
  clearHistory(): void {
    assertProjectActive(this);
    if (this.editing) throw new Error("Project history cannot change during an edit.");
    const dropped = [...this.undoStack, ...this.redoStack];
    this.undoStack = [];
    this.redoStack = [];
    this.releaseClips(dropped);
    this.publishHistory();
  }

  private publishHistory(): void {
    const undo = this.undoStack.at(-1)?.label;
    const redo = this.redoStack.at(-1)?.label;
    this.historyLabels.value = Object.freeze({ ...(undo === undefined ? {} : { undo }), ...(redo === undefined ? {} : { redo }) });
  }

  private captureSide(): EditSide {
    const state = this.s;
    const clips = new Map<string, EditPlacement>();
    const automation = new Map<string, readonly AutomationPoint[]>();
    for (const track of state.tracks) {
      automation.set(track.id, track.volumeAutomation);
      for (const clip of track.clips)
        clips.set(clip.id, {
          trackId: track.id,
          clip,
          time: clip.time,
          name: state.clipNames.get(clip.id),
          ...(clip instanceof MidiClip ? { notes: clip.midi.notes.value } : {}),
        });
    }
    for (const [key, clip] of state.session.slots) {
      const { sceneId, trackId } = splitSlotKey(key);
      clips.set(clip.id, {
        trackId,
        sceneId,
        clip,
        time: clip.time,
        name: state.clipNames.get(clip.id),
        ...(clip instanceof MidiClip ? { notes: clip.midi.notes.value } : {}),
      });
    }
    const scenes = new Map(state.session.scenes.map((scene) => [scene.id, scene] as const));
    return { clips, tempoMap: state.tempoMap, markers: state.markers, automation, extensions: state.extensions, scenes, session: state.session };
  }

  private runEdit<T>(label: string, action: () => T): { result: T; entry: EditEntry | undefined } {
    if (this.editing) throw new Error("Project edits cannot be nested.");
    if (typeof label !== "string" || !label.trim()) throw new RangeError("Project edit needs a non-empty label.");
    return untracked(() =>
      batch(() => {
        const previous = this.s;
        const previousIds = new Set(this.ids);
        const previousNextId = nextProjectId.get(this);
        const previousRevisions = this.noteRevisions(previous);
        const before = this.captureSide();
        const editing = { retired: new Set<MidiClip>() };
        this.editing = editing;
        try {
          const result = action();
          if (typeof (result as { then?: unknown } | null | undefined)?.then === "function") {
            (result as unknown as Promise<unknown>).then(undefined, () => undefined);
            throw new TypeError("Project edit action must be synchronous.");
          }
          this.assertEditScope(previous);
          this.editing = undefined;
          const after = this.captureSide();
          for (const clip of editing.retired) if (before.clips.get(clip.id)?.clip !== clip && after.clips.get(clip.id)?.clip !== clip) clip.dispose();
          const ids = [...new Set([...before.clips.keys(), ...after.clips.keys()])].filter(
            (id) => !samePlacement(before.clips.get(id), after.clips.get(id)),
          );
          const automation = [...after.automation.keys()].filter((id) => before.automation.get(id) !== after.automation.get(id));
          const tempo = before.tempoMap !== after.tempoMap;
          const markers = before.markers !== after.markers;
          const extensions = [...new Set([...before.extensions.keys(), ...after.extensions.keys()])].filter(
            (id) => before.extensions.get(id) !== after.extensions.get(id),
          );
          const scenes = [...new Set([...before.scenes.keys(), ...after.scenes.keys()])].filter(
            (id) => before.scenes.get(id) !== after.scenes.get(id),
          );
          if (!ids.length && !automation.length && !tempo && !markers && !extensions.length && !scenes.length) return { result, entry: undefined };
          const entry: EditEntry = { label: label.trim(), ids, tempo, markers, automation, extensions, scenes, before, after };
          this.pushHistory(entry);
          return { result, entry };
        } catch (error) {
          this.editing = undefined;
          for (const track of this.s.tracks)
            for (const clip of track.clips) if (clip instanceof MidiClip && before.clips.get(clip.id)?.clip !== clip) clip.dispose();
          for (const clip of this.s.session.slots.values()) if (clip instanceof MidiClip && before.clips.get(clip.id)?.clip !== clip) clip.dispose();
          for (const clip of editing.retired) if (!before.clips.has(clip.id) || before.clips.get(clip.id)!.clip !== clip) clip.dispose();
          for (const { clip, time, notes } of before.clips.values()) {
            if (!(clip instanceof MidiClip)) continue;
            midiClipTimes.get(clip)!.value = time;
            if (!sameNotes(clip.midi.notes.value, notes)) clip.midi.setNotes(notes!);
          }
          this.store.value = previous;
          this.ids.clear();
          for (const id of previousIds) this.ids.add(id);
          if (previousNextId === undefined) nextProjectId.delete(this);
          else nextProjectId.set(this, previousNextId);
          this.spentNoteRevisions += this.noteRevisions(previous) - previousRevisions;
          throw error;
        }
      }),
    );
  }

  private assertEditScope(previous: ProjectState): void {
    const state = this.s;
    const unchanged =
      state.title === previous.title &&
      state.masterVolume === previous.masterVolume &&
      state.tracks.length === previous.tracks.length &&
      state.tracks.every((track, index) => trackShellKeys.every((key) => track[key] === previous.tracks[index][key]));
    if (!unchanged) throw new Error("Project edit covers clips, notes, tempo, markers and volume automation only.");
  }

  private pushHistory(entry: EditEntry): void {
    const dropped = this.redoStack;
    this.redoStack = [];
    this.undoStack.push(entry);
    if (this.undoStack.length > HISTORY_LIMIT) dropped.push(this.undoStack.shift()!);
    this.releaseClips(dropped);
    this.publishHistory();
  }

  /** Dispose MIDI clips held only by history entries that were just dropped. */
  private releaseClips(dropped: readonly EditEntry[]): void {
    const reachable = new Set<ProjectClip>([...this.s.tracks.flatMap((track) => track.clips), ...this.s.session.slots.values()]);
    for (const entry of [...this.undoStack, ...this.redoStack])
      for (const side of [entry.before, entry.after]) for (const { clip } of side.clips.values()) reachable.add(clip);
    for (const entry of dropped)
      for (const side of [entry.before, entry.after])
        for (const { clip } of side.clips.values()) if (clip instanceof MidiClip && !reachable.has(clip)) clip.dispose();
  }

  private appliedReceipt(entry: EditEntry | undefined, side: "before" | "after", copies: ProjectEditCopies = {}): ProjectEditReceipt {
    const version = untracked(() => this.cells.version.value);
    if (!entry) return { status: "applied", version, created: [], changed: [], removed: [], copies };
    const target = entry[side];
    const source = side === "after" ? entry.before : entry.after;
    return {
      status: "applied",
      version,
      created: entry.ids.filter((id) => target.clips.has(id) && !source.clips.has(id)),
      changed: entry.ids.filter((id) => target.clips.has(id) && source.clips.has(id)),
      removed: entry.ids.filter((id) => !target.clips.has(id)),
      copies,
    };
  }

  private stepHistory(kind: "undo" | "redo", expectedVersion: ProjectVersion | undefined): ProjectEditReceipt {
    assertProjectActive(this);
    const version = untracked(() => this.cells.version.value);
    if (this.editing) throw new Error("Project history cannot change during an edit.");
    if (expectedVersion !== undefined && expectedVersion !== version)
      return { status: "conflict", version, reason: "The project changed since this version was read." };
    const stack = kind === "undo" ? this.undoStack : this.redoStack;
    const entry = stack.at(-1);
    if (!entry) return { status: "rejected", version, code: kind === "undo" ? "nothing-to-undo" : "nothing-to-redo", reason: `Nothing to ${kind}.` };
    const from = kind === "undo" ? "after" : "before";
    const to = kind === "undo" ? "before" : "after";
    if (!this.sideIsCurrent(entry, entry[from]) || !this.sideCanApply(entry, entry[to]))
      return { status: "conflict", version, reason: `A later change touched what "${entry.label}" edited, so it was left in place.` };
    untracked(() =>
      batch(() => {
        this.applySide(entry, entry[to]);
        entry[to] = this.captureSide();
        stack.pop();
        (kind === "undo" ? this.redoStack : this.undoStack).push(entry);
        this.publishHistory();
      }),
    );
    return this.appliedReceipt(entry, to);
  }

  private sideIsCurrent(entry: EditEntry, side: EditSide): boolean {
    const current = this.captureSide();
    return (
      entry.ids.every((id) => samePlacement(current.clips.get(id), side.clips.get(id))) &&
      (!entry.tempo || current.tempoMap === side.tempoMap) &&
      (!entry.markers || current.markers === side.markers) &&
      entry.automation.every((id) => current.automation.get(id) === side.automation.get(id)) &&
      entry.extensions.every((id) => current.extensions.get(id) === side.extensions.get(id)) &&
      entry.scenes.every((id) => current.scenes.get(id) === side.scenes.get(id))
    );
  }

  /** The clips coming back need their tracks, and must not land on content that arrived after this side was captured. */
  private sideCanApply(entry: EditEntry, side: EditSide): boolean {
    const touched = new Set(entry.ids);
    const tracks = new Map(this.s.tracks.map((track) => [track.id, track]));
    const current = this.s.session.scenes;
    // A scene or clip coming back keeps its ID only if nothing else has taken it since.
    const here = new Set(current.map((scene) => scene.id));
    if (entry.scenes.some((id) => side.scenes.has(id) && !here.has(id) && this.ids.has(id))) return false;
    const live = new Set(this.s.session.slots.values());
    const present = new Set([...live].map((clip) => clip.id));
    for (const track of this.s.tracks) for (const clip of track.clips) present.add(clip.id);
    return entry.ids.every((id) => {
      const placement = side.clips.get(id);
      if (!placement) return true;
      if (!present.has(id) && this.ids.has(id)) return false;
      const track = tracks.get(placement.trackId);
      if (track?.kind !== placement.clip.kind) return false;
      // A slot clip has no neighbours: the Session grid holds one clip per slot, and its scene must be there or come back with this step.
      if (placement.sceneId !== undefined)
        return here.has(placement.sceneId) ? true : entry.scenes.includes(placement.sceneId) && side.scenes.has(placement.sceneId);
      const { clip, time } = placement;
      const tolerance = clipFrameTolerance(clip);
      return track.clips.every(
        (other) =>
          touched.has(other.id) ||
          side.clips.get(other.id)?.clip === other ||
          other.time >= time + clip.duration - tolerance ||
          other.time + other.duration <= time + tolerance,
      );
    });
  }

  private applySide(entry: EditEntry, side: EditSide): void {
    const ids = new Set(entry.ids);
    // A name or note change leaves the arrangement array alone, so playback and auditions do not see a clip edit.
    const moved = new Set(
      entry.ids.filter((id) => {
        const placement = side.clips.get(id);
        return placement?.clip instanceof MidiClip && placement.clip.time !== placement.time;
      }),
    );
    for (const id of ids) {
      const placement = side.clips.get(id);
      if (placement?.clip instanceof MidiClip) {
        midiClipTimes.get(placement.clip)!.value = placement.time;
        if (!sameNotes(placement.clip.midi.notes.value, placement.notes)) placement.clip.midi.setNotes(placement.notes!);
      }
      if (placement) this.ids.add(id);
      else this.ids.delete(id);
    }
    const tracks = this.s.tracks.map((track) => {
      const touchesAutomation = entry.automation.includes(track.id);
      const incoming = entry.ids.flatMap((id) => {
        const placement = side.clips.get(id);
        return placement?.trackId === track.id && placement.sceneId === undefined ? [placement.clip] : [];
      });
      const outgoing = track.clips.filter((clip) => ids.has(clip.id));
      const sameClips = outgoing.length === incoming.length && outgoing.every((clip) => incoming.includes(clip) && !moved.has(clip.id));
      if (!touchesAutomation && sameClips) return track;
      return Object.freeze({
        ...track,
        clips: sameClips ? track.clips : this.sortClips([...track.clips.filter((clip) => !ids.has(clip.id)), ...incoming]),
        ...(touchesAutomation ? { volumeAutomation: side.automation.get(track.id) ?? track.volumeAutomation } : {}),
      });
    });
    const clipNames = new Map(this.s.clipNames);
    for (const id of ids) {
      const name = side.clips.get(id)?.name;
      if (name === undefined) clipNames.delete(id);
      else clipNames.set(id, name);
    }
    let session: SessionState | undefined;
    const slotted = [...ids].some((id) => entry.before.clips.get(id)?.sceneId !== undefined || entry.after.clips.get(id)?.sceneId !== undefined);
    if (entry.scenes.length || slotted) {
      const now = this.s.session;
      const touchedScenes = new Set(entry.scenes);
      // Scenes this step did not touch stay as they are; the ones it did come from `side`, each after the scene that precedes it there.
      const scenes = now.scenes.filter((scene) => !touchedScenes.has(scene.id));
      for (const [index, scene] of side.session.scenes.entries()) {
        if (!touchedScenes.has(scene.id)) continue;
        const before = side.session.scenes[index - 1];
        scenes.splice(before ? scenes.findIndex((other) => other.id === before.id) + 1 : 0, 0, scene);
      }
      const slots = new Map([...now.slots].filter(([, clip]) => !ids.has(clip.id)));
      for (const id of ids) {
        const placement = side.clips.get(id);
        if (placement?.sceneId !== undefined) slots.set(slotKey(placement.sceneId, placement.trackId), placement.clip);
      }
      for (const id of entry.scenes) {
        if (touchedScenes.has(id) && !side.scenes.has(id)) this.ids.delete(id);
        else if (side.scenes.has(id)) this.ids.add(id);
      }
      const dropped = new Set(scenes.map(({ id }) => id));
      for (const key of [...slots.keys()]) if (!dropped.has(splitSlotKey(key).sceneId)) slots.delete(key);
      session = Object.freeze({ scenes: Object.freeze(scenes), slots });
    }
    this.commit({
      clipNames,
      tracks: Object.freeze(tracks),
      ...(session ? { session } : {}),
      ...(entry.tempo ? { tempoMap: side.tempoMap } : {}),
      ...(entry.markers ? { markers: side.markers } : {}),
      ...(entry.extensions.length ? { extensions: this.withExtensions(entry.extensions, side.extensions) } : {}),
    });
  }

  private withExtensions(ids: readonly string[], from: ReadonlyMap<string, ExtensionRecord>): ReadonlyMap<string, ExtensionRecord> {
    const extensions = new Map(this.s.extensions);
    for (const id of ids) {
      const record = from.get(id);
      if (record) extensions.set(id, record);
      else extensions.delete(id);
    }
    return extensions;
  }

  get hasFileBackedAudio(): boolean {
    const fileBacked = (clip: ProjectClip) => clip.kind === "audio" && !!(clip.media || clip.stretch?.source.media);
    const state = this.store.value;
    return state.tracks.some(({ clips }) => clips.some(fileBacked)) || [...state.session.slots.values()].some(fileBacked);
  }

  get tracks(): readonly ProjectTrack[] {
    return this.store.value.tracks;
  }

  get masterVolume(): number {
    return this.store.value.masterVolume;
  }

  setMasterVolume(value: number): void {
    assertProjectActive(this);
    if (!Number.isFinite(value) || value < 0) throw new RangeError("Project master volume needs a finite non-negative value.");
    if (value === this.s.masterVolume) return;
    this.commit({ masterVolume: value });
  }

  get tempoMap(): TempoMap {
    return this.store.value.tempoMap;
  }

  /** Convert a clip's native position and offset (seconds for audio, beats for MIDI) to project seconds. Tracks tempo changes. */
  clipTimeSeconds(clip: ProjectClip, localTime = 0): number {
    return clipSeconds(this.store.value.tempoMap, clip, localTime);
  }

  /** A track holds one clip kind, so the native position (seconds for audio, beats for MIDI) orders it. */
  private sortClips(clips: ProjectClip[]): readonly ProjectClip[] {
    return Object.freeze(untracked(() => clips.sort((a, b) => a.time - b.time)));
  }

  /** The tempo at beat 0. Tracked. */
  get bpm(): number {
    return this.store.value.tempoMap.initialBpm;
  }

  /** Replace the tempo map. A change at beat 0 sets the starting tempo; without one the starting tempo stays. */
  setTempoChanges(changes: readonly TempoChange[]): void {
    assertProjectActive(this);
    const starts = changes.filter(({ beat }) => beat === 0);
    if (starts.length > 1) throw new RangeError("Project tempo changes need unique positive beats and BPM.");
    const bpm = starts[0]?.bpm ?? this.s.tempoMap.initialBpm;
    if (starts.length && (!Number.isFinite(bpm) || bpm < 1)) throw new RangeError("Project BPM must be a finite number of at least 1.");
    this.commit({
      tempoMap: new TempoMap(
        bpm,
        changes.filter(({ beat }) => beat !== 0),
      ),
    });
  }

  get markers(): readonly ProjectMarker[] {
    return this.store.value.markers;
  }

  /** Stable content snapshot for a separate render runtime. File-backed media remains borrowed. */
  snapshot(): Project {
    return untracked(() => this.snapshotUntracked());
  }

  private snapshotUntracked(borrowAudio = false): Project {
    assertProjectActive(this);
    const state = this.s;
    const copy = new Project({ title: state.title, bpm: state.tempoMap.initialBpm, signature: this.signature });
    const recordings = new Map<readonly Float32Array[], readonly Float32Array[]>();
    const tracks = Object.freeze(
      state.tracks.map((track) =>
        Object.freeze({
          ...track,
          devices: Object.freeze(track.devices.map((device) => Object.freeze({ ...device, state: new Uint8Array(device.state) }))),
          clips: Object.freeze(
            track.clips.map((clip) =>
              clip instanceof MidiClip
                ? new MidiClip(clip.id, clip.time, { notes: clip.midi.notes.value, duration: clip.duration, events: clip.events }, clip.loop)
                : borrowAudio
                  ? clip
                  : snapshotAudioClip(clip, recordings),
            ),
          ),
        }),
      ),
    );
    const slots = new Map<string, ProjectClip>();
    for (const [key, clip] of state.session.slots)
      slots.set(
        key,
        clip instanceof MidiClip
          ? new MidiClip(clip.id, clip.time, { notes: clip.midi.notes.value, duration: clip.duration, events: clip.events }, clip.loop)
          : borrowAudio
            ? clip
            : snapshotAudioClip(clip, recordings),
      );
    copy.commit({
      masterVolume: state.masterVolume,
      tempoMap: state.tempoMap,
      markers: state.markers,
      clipNames: state.clipNames,
      tracks,
      extensions: state.extensions,
      session: slots.size || state.session.scenes.length ? Object.freeze({ scenes: state.session.scenes, slots }) : emptySession,
    });
    for (const scene of state.session.scenes) copy.ids.add(scene.id);
    for (const clip of slots.values()) copy.ids.add(clip.id);
    for (const track of tracks) {
      copy.ids.add(track.id);
      for (const device of track.devices) copy.ids.add(device.id);
      for (const clip of track.clips) copy.ids.add(clip.id);
    }
    nextProjectId.set(copy, nextProjectId.get(this) ?? 1);
    const untrusted = importedBundles.get(this);
    if (untrusted) importedBundles.set(copy, new Set(untrusted));
    const preserved = preservedEntries.get(this);
    if (preserved) preservedEntries.set(copy, preserved);
    return copy;
  }

  setMarkers(markers: readonly ProjectMarker[]): void {
    assertProjectActive(this);
    if (markers.some((marker) => typeof marker.name !== "string")) throw new RangeError("Project markers need unique non-negative times and names.");
    for (const marker of markers) validateXmlText(marker.name);
    const sorted = markers.map((marker) => Object.freeze({ time: marker.time, name: marker.name.trim() })).sort((a, b) => a.time - b.time);
    if (sorted.some((marker, index) => !validTime(marker.time) || !marker.name || (index > 0 && sorted[index - 1].time === marker.time)))
      throw new RangeError("Project markers need unique non-negative times and names.");
    this.commit({ markers: Object.freeze(sorted) });
  }

  get title(): string {
    return this.store.value.title;
  }

  setTitle(title: string): void {
    assertProjectActive(this);
    validateXmlText(title);
    if (!title.trim()) throw new RangeError("Project title must not be empty.");
    this.commit({ title: title.trim() });
  }

  private reserve(id: string | undefined, prefix: string): string {
    const chosen =
      id ??
      (() => {
        let candidate: string;
        let next = nextProjectId.get(this) ?? 1;
        do candidate = `${prefix}${next++}`;
        while (collidesWithProjectId(candidate, this.ids));
        nextProjectId.set(this, next);
        return candidate;
      })();
    if (!validProjectId(chosen) || collidesWithProjectId(chosen, this.ids)) throw new Error("Project IDs must be unique XML IDs.");
    const suffix = /^(?:clip|device|track|scene)(\d+)$/.exec(chosen);
    const number = suffix && Number(suffix[1]);
    if (number && Number.isSafeInteger(number + 1)) nextProjectId.set(this, Math.max(number + 1, nextProjectId.get(this) ?? 1));
    this.ids.add(chosen);
    return chosen;
  }

  addTrack(
    name: string,
    kind: TrackKind,
    options: { id?: string; volume?: number; muted?: boolean; solo?: boolean; pan?: number; busRole?: BusRole } = {},
  ): ProjectTrack {
    assertProjectActive(this);
    validateXmlText(name);
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
    this.commit({ tracks: Object.freeze([...this.s.tracks, track]) });
    return track;
  }

  private track(id: string, kind: TrackKind): ProjectTrack {
    const track = this.s.tracks.find((item) => item.id === id);
    if (!track || track.kind !== kind) throw new Error("Project clip needs a matching track.");
    return track;
  }

  private replace(track: ProjectTrack, patch: Partial<ProjectTrack>, state: Partial<Pick<ProjectState, "clipNames">> = {}): void {
    this.commit({
      ...state,
      tracks: Object.freeze(this.s.tracks.map((item) => (item.id === track.id ? Object.freeze({ ...item, ...patch }) : item))),
    });
  }

  setTrackVolume(trackId: string, value: number): void {
    assertProjectActive(this);
    const track = this.s.tracks.find((item) => item.id === trackId);
    if (!track || !Number.isFinite(value) || value < 0) throw new RangeError("Project track volume needs an existing track and non-negative value.");
    this.replace(track, { volume: value });
  }

  setTrackName(trackId: string, name: string): void {
    assertProjectActive(this);
    validateXmlText(name);
    const track = this.s.tracks.find((item) => item.id === trackId);
    if (!track || !name.trim()) throw new RangeError("Project track name needs an existing track and non-empty name.");
    this.replace(track, { name: name.trim() });
  }

  setTrackMuted(trackId: string, muted: boolean): void {
    assertProjectActive(this);
    const track = this.s.tracks.find((item) => item.id === trackId);
    if (!track || typeof muted !== "boolean") throw new RangeError("Project track mute needs an existing track and boolean value.");
    this.replace(track, { muted });
  }

  setTrackSolo(trackId: string, solo: boolean): void {
    assertProjectActive(this);
    const track = this.s.tracks.find((item) => item.id === trackId);
    if (!track || typeof solo !== "boolean") throw new RangeError("Project track solo needs an existing track and boolean value.");
    this.replace(track, { solo });
  }

  setTrackPan(trackId: string, pan: number): void {
    assertProjectActive(this);
    const track = this.s.tracks.find((item) => item.id === trackId);
    if (!track || !Number.isFinite(pan) || Math.abs(pan) > 1)
      throw new RangeError("Project track pan needs an existing track and a value from -1 to 1.");
    this.replace(track, { pan });
  }

  /** Atomically replace the dry output and post-fader sends for one track. */
  setTrackRouting(trackId: string, routing: TrackRouting): void {
    assertProjectActive(this);
    const tracks = new Map(this.s.tracks.map((track) => [track.id, track]));
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
    assertProjectActive(this);
    const track = this.s.tracks.find((item) => item.id === trackId);
    if (!track) throw new Error("Project effects need an existing track.");
    const checked = normalizeRackEffects(effects);
    this.replace(track, { effects: checked, effectMacros: retainRackMacroTargets(checked, track.effectMacros) });
  }

  /** Apply both the ordered inserts and their macro settings as one Project edit. */
  setTrackRackPreset(trackId: string, preset: RackPreset): void {
    assertProjectActive(this);
    const track = this.s.tracks.find((item) => item.id === trackId);
    if (!track) throw new Error("Project effects need an existing track.");
    const { effects, macros } = normalizeRackPreset(preset);
    this.replace(track, { effects, effectMacros: macros });
  }

  setTrackMacroValue(trackId: string, macroId: string, value: number): void {
    assertProjectActive(this);
    const track = this.s.tracks.find((item) => item.id === trackId);
    const macro = track?.effectMacros.find((item) => item.id === macroId);
    if (!track || !macro) throw new Error("Project macro needs an existing track and macro.");
    if (!Number.isFinite(value) || value < 0 || value > 1) throw new RangeError("TrackRack macro value needs a number from 0 to 1.");
    if (macro.value === value) return;
    this.replace(track, {
      effectMacros: Object.freeze(track.effectMacros.map((item) => (item === macro ? Object.freeze({ ...item, value }) : item))),
    });
  }

  removeTrack(trackId: string): void {
    assertProjectActive(this);
    const track = this.s.tracks.find((item) => item.id === trackId);
    if (!track) throw new Error("Project track does not exist.");
    for (const clip of track.clips) {
      this.ids.delete(clip.id);
      this.retire(clip);
    }
    const slotted = [...this.s.session.slots].filter(([key]) => splitSlotKey(key).trackId === trackId);
    for (const [, clip] of slotted) {
      this.ids.delete(clip.id);
      this.retire(clip);
    }
    for (const device of track.devices) {
      this.ids.delete(device.id);
      importedBundles.get(this)?.delete(device.id);
    }
    this.ids.delete(track.id);
    const tracks = Object.freeze(
      this.s.tracks
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
    const session = this.s.session;
    const slots = slotted.length ? new Map([...session.slots].filter(([key]) => splitSlotKey(key).trackId !== trackId)) : session.slots;
    this.commit({
      tracks,
      ...(slotted.length ? { session: Object.freeze({ scenes: session.scenes, slots }) } : {}),
      ...this.unnamedClips([...track.clips, ...slotted.map(([, clip]) => clip)].map(({ id }) => id)),
    });
  }

  addWebClapDevice(trackId: string, details: Omit<WebClapDevice, "kind" | "id" | "state"> & { id?: string; state?: Uint8Array }): WebClapDevice {
    assertProjectActive(this);
    const track = this.s.tracks.find((item) => item.id === trackId);
    if (!track) throw new Error("Project device needs an existing track.");
    if (!details.pluginId || !details.name || typeof details.bundleUrl !== "string" || (details.state && !(details.state instanceof Uint8Array)))
      throw new Error("Project WebCLAP device needs an ID, name, bundle URL and byte state.");
    for (const value of [details.pluginId, details.name, details.vendor ?? "", details.version ?? ""]) validateXmlText(value);
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
    assertProjectActive(this);
    if (!(bytes instanceof Uint8Array)) throw new TypeError("Project device state needs bytes.");
    const track = this.s.tracks.find((item) => item.devices.some((device) => device.id === deviceId));
    if (!track) throw new Error("Project device needs an existing track.");
    const devices = track.devices.map((device) => (device.id === deviceId ? Object.freeze({ ...device, state: new Uint8Array(bytes) }) : device));
    this.replace(track, { devices: Object.freeze(devices) });
  }

  /** Fold a running plug-in's state into the Project. It is not an edit: the version and undo history ignore it. Reached through `captureDeviceState`. */
  private captureDevice(deviceId: string, bytes: Uint8Array): void {
    assertProjectActive(this);
    const track = this.s.tracks.find((item) => item.devices.some((device) => device.id === deviceId));
    if (!track) throw new Error("Project device needs an existing track.");
    const devices = track.devices.map((device) => (device.id === deviceId ? Object.freeze({ ...device, state: new Uint8Array(bytes) }) : device));
    this.commit(
      { tracks: Object.freeze(this.s.tracks.map((item) => (item === track ? Object.freeze({ ...item, devices: Object.freeze(devices) }) : item))) },
      false,
    );
  }

  removeDevice(deviceId: string): void {
    assertProjectActive(this);
    const track = this.s.tracks.find((item) => item.devices.some((device) => device.id === deviceId));
    if (!track) throw new Error("Project device needs an existing track.");
    this.ids.delete(deviceId);
    importedBundles.get(this)?.delete(deviceId);
    this.replace(track, { devices: Object.freeze(track.devices.filter((device) => device.id !== deviceId)) });
  }

  setVolumeAutomation(trackId: string, points: readonly AutomationPoint[]): void {
    assertProjectActive(this);
    const track = this.s.tracks.find((item) => item.id === trackId);
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
    assertProjectActive(this);
    const track = this.track(trackId, "audio");
    const { clip, name } = this.buildAudioClip(audio, time, options);
    this.replace(track, { clips: this.sortClips([...track.clips, clip]) }, this.namedClip(clip.id, name));
    return clip;
  }

  /** An audio clip that is not placed anywhere yet; its ID is reserved. */
  private buildAudioClip(audio: ProjectAudio, time: number, options: AudioClipOptions): { clip: AudioClip; name: string | undefined } {
    if (!validTime(time) || !validPcm(audio)) throw new RangeError("Project audio clips need a time, sample rate and equal-length PCM channels.");
    const stretch = normalizeClipStretch(options.stretch, audio.sampleRate, audio.channels.length, audio.channels[0].length);
    const duration = audio.channels[0].length / audio.sampleRate;
    const envelope = normalizeClipEnvelope(options.envelope ?? unityClipEnvelope, duration);
    const gainAutomation = normalizeClipGainAutomation(options.gainAutomation);
    const name = normalizeClipName(options.name);
    const adopted = adoptedWindows.has(audio.channels[0]);
    adoptedWindows.delete(audio.channels[0]);
    const channels = adopted ? Object.freeze([...audio.channels]) : Object.freeze(audio.channels.map((channel) => new Float32Array(channel)));
    if (!adopted) pcmRecordings.set(channels[0], { channels, offset: 0 });
    const clip: AudioClip = Object.freeze({
      kind: "audio",
      id: this.reserve(options.id, "clip"),
      time,
      ...recorded({ sampleRate: audio.sampleRate, channels }),
      duration,
      ...(stretch ? { stretch } : {}),
      ...(envelope === unityClipEnvelope ? {} : { envelope }),
      ...(gainAutomation ? { gainAutomation } : {}),
    });
    return { clip, name };
  }

  /** Add file-backed PCM without copying the full take into the project model. */
  addAudioMediaClip(
    trackId: string,
    media: AudioMedia,
    time: number,
    options: AudioClipOptions & { startFrame?: number; frameCount?: number } = {},
  ): MediaAudioClip {
    assertProjectActive(this);
    const track = this.track(trackId, "audio");
    const { clip, name } = this.buildMediaClip(media, time, options);
    this.replace(track, { clips: this.sortClips([...track.clips, clip]) }, this.namedClip(clip.id, name));
    return clip;
  }

  private buildMediaClip(
    media: AudioMedia,
    time: number,
    options: AudioClipOptions & { startFrame?: number; frameCount?: number },
  ): { clip: MediaAudioClip; name: string | undefined } {
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
    const name = normalizeClipName(options.name);
    const clip: MediaAudioClip = Object.freeze({
      kind: "audio",
      id: this.reserve(options.id, "clip"),
      time,
      sampleRate: media.sampleRate,
      media,
      startFrame,
      frameCount,
      sourceOffset: startFrame / media.sampleRate,
      sourceLength: media.frameCount / media.sampleRate,
      duration,
      ...(stretch ? { stretch } : {}),
      ...(envelope === unityClipEnvelope ? {} : { envelope }),
      ...(gainAutomation ? { gainAutomation } : {}),
    });
    return { clip, name };
  }

  addMidiClip(trackId: string, data: ProjectMidiData, time: number, options: { id?: string; name?: string } = {}): MidiClip {
    assertProjectActive(this);
    const track = this.track(trackId, "midi");
    const { clip, name } = this.buildMidiClip(data, time, options);
    this.replace(track, { clips: this.sortClips([...track.clips, clip]) }, this.namedClip(clip.id, name));
    return clip;
  }

  /** A MIDI clip that is not placed anywhere yet; its ID is reserved. */
  private buildMidiClip(data: ProjectMidiData, time: number, options: { id?: string; name?: string }): { clip: MidiClip; name: string | undefined } {
    if (!validTime(time)) throw new RangeError("Project clip time must be finite and non-negative.");
    const name = normalizeClipName(options.name);
    const id = this.reserve(options.id, "clip");
    try {
      return { clip: new MidiClip(id, time, data), name };
    } catch (error) {
      this.ids.delete(id);
      throw error;
    }
  }

  /** Adds a recorded take as a clip: its notes, duration and non-note messages are already beats from its start. `time` is the clip position in project beats, default the take's `startBeat` (0 when it has none). */
  addMidiTake(trackId: string, take: MidiTake, time: number = take.startBeat ?? 0): MidiClip {
    assertProjectActive(this);
    if (!validTime(time)) throw new RangeError("Project clip time must be finite and non-negative.");
    return this.addMidiClip(
      trackId,
      { notes: take.notes, duration: take.duration, events: take.events.map((event) => ({ time: event.beat, data: event.data })) },
      time,
    );
  }

  moveClip(clipId: string, trackId: string, time: number): void {
    assertProjectActive(this);
    if (!validTime(time)) throw new RangeError("Project clip time must be finite and non-negative.");
    const source = this.s.tracks.find((item) => item.clips.some((clip) => clip.id === clipId));
    const target = this.s.tracks.find((item) => item.id === trackId);
    const clip = source?.clips.find((item) => item.id === clipId);
    if (!source || !target || !clip || target.kind !== clip.kind) throw new Error("Project clip needs a matching track.");
    const moved = clip.kind === "midi" ? clip : Object.freeze({ ...clip, time });
    batch(() => {
      if (clip.kind === "midi") midiClipTimes.get(clip)!.value = time;
      this.commit({
        tracks: Object.freeze(
          this.s.tracks.map((track) => {
            if (track.id !== source.id && track.id !== target.id) return track;
            const clips = track.clips.filter((item) => item.id !== clipId);
            if (track.id === target.id) clips.push(moved);
            return Object.freeze({ ...track, clips: this.sortClips(clips) });
          }),
        ),
      });
    });
  }

  duplicateClip(clipId: string, time: number, trackId?: string): ProjectClip {
    assertProjectActive(this);
    return untracked(() => this.duplicateClipUntracked(clipId, time, trackId));
  }

  private duplicateClipUntracked(clipId: string, time: number, trackId?: string): ProjectClip {
    if (!validTime(time)) throw new RangeError("Project clip time must be finite and non-negative.");
    const source = this.s.tracks.find((item) => item.clips.some((clip) => clip.id === clipId));
    const clip = source?.clips.find((item) => item.id === clipId);
    if (!source || !clip) throw new Error("Project clip does not exist.");
    const target = trackId ?? source.id;
    const name = this.s.clipNames.get(clipId);
    if (clip.kind === "audio") {
      const options = { name, envelope: clip.envelope, stretch: clip.stretch, gainAutomation: clip.gainAutomation };
      const copy = clip.media
        ? this.addAudioMediaClip(target, clip.media, time, { ...options, startFrame: clip.startFrame, frameCount: clip.frameCount })
        : this.addAudioClip(target, clip, time, options);
      return clip.loop ? this.looped(copy, clip.loop, clip.duration) : copy;
    }
    const copy = this.addMidiClip(target, { notes: untracked(() => clip.midi.notes.value), duration: clip.duration, events: clip.events }, time, {
      name,
    });
    return clip.loop ? this.looped(copy, clip.loop, clip.duration) : copy;
  }

  /** `clip` replaced by a copy with `loop` and `duration`. The copy keeps the clip's ID, position and everything but the loop. */
  private looped(clip: ProjectClip, loop: BeatRange | SecondsRange | undefined, duration: number): ProjectClip {
    const where = this.locate(clip.id);
    let next: ProjectClip;
    if (clip.kind === "audio") {
      const { loop: _previous, ...audio } = clip;
      next = Object.freeze({ ...audio, duration, ...(loop ? { loop: Object.freeze({ ...(loop as SecondsRange) }) } : {}) });
    } else
      next = new MidiClip(
        clip.id,
        clip.time,
        { notes: untracked(() => clip.midi.notes.value), duration, events: clip.events },
        loop && Object.freeze({ ...(loop as BeatRange) }),
      );
    this.replaceClip(where, next);
    this.retire(clip);
    return next;
  }

  /**
   * Remove an audio clip's loop. The clip plays its recording straight on from `sourceOffset`, so it is cut to the audio the recording holds from
   * there (`end <= sourceLength`) and its window is cut to the clip's length; a clip shorter than that keeps its length.
   */
  private unloopedAudio(clip: AudioClip): void {
    const where = this.locate(clip.id);
    const rate = clip.sampleRate;
    const recording = recordingOf(clip);
    const frames = Math.min(Math.round(clip.duration * rate), recording.frames - recording.offset);
    const duration = frames / rate;
    const old = clip.envelope ?? unityClipEnvelope;
    const envelope = normalizeClipEnvelope(
      {
        gain: old.gain,
        fadeIn: Math.min(old.fadeIn, duration),
        fadeOut: frames === Math.round(clip.duration * rate) ? Math.min(old.fadeOut, duration) : 0,
      },
      duration,
    );
    const next: AudioClip = Object.freeze({
      kind: "audio" as const,
      id: clip.id,
      time: clip.time,
      ...sliceAudioSource(clip, 0, frames),
      duration,
      ...(envelope === unityClipEnvelope ? {} : { envelope }),
      ...(clip.gainAutomation ? { gainAutomation: clip.gainAutomation } : {}),
    });
    this.replaceClip(where, next);
  }

  /**
   * Repeat part of a clip's content until the clip ends, or stop repeating with `null`. A MIDI clip takes beats in its own note time from its
   * content start (`{ startBeat, endBeat }`, any positive end); an audio clip takes seconds of its recording (`{ startSeconds, endSeconds }`,
   * ending inside the recording), the frame `sourceOffset` is in. The clip plays from its start to the loop end, then repeats the loop; a
   * `resizeClip` right edge may then reach past the content. It replaces the clip, so Undo restores it.
   */
  setClipLoop(clipId: string, loop: BeatRange | SecondsRange | null): void {
    assertProjectActive(this);
    const { clip } = this.locate(clipId);
    if (loop === null) {
      if (clip.kind === "audio" && clip.loop) this.unloopedAudio(clip);
      else if (clip.loop) this.looped(clip, undefined, clip.duration);
      return;
    }
    const isMidi = clip.kind === "midi";
    const raw = (loop ?? {}) as Partial<BeatRange & SecondsRange>;
    const start = isMidi ? raw.startBeat : raw.startSeconds;
    const end = isMidi ? raw.endBeat : raw.endSeconds;
    if (typeof start !== "number" || typeof end !== "number")
      throw new RangeError("Project clip loop needs { startBeat, endBeat } for MIDI and { startSeconds, endSeconds } for audio.");
    if (!(start >= 0 && start < end && Number.isFinite(end)) || (clip.kind === "audio" && (end > clip.sourceLength + 1e-9 || clip.stretch)))
      throw new RangeError("Project clip loop needs 0 <= start < end inside the clip's content.");
    const current = clip.loop as Partial<BeatRange & SecondsRange> | undefined;
    if (current && (isMidi ? current.startBeat === start && current.endBeat === end : current.startSeconds === start && current.endSeconds === end))
      return;
    this.looped(clip, isMidi ? { startBeat: start, endBeat: end } : { startSeconds: start, endSeconds: end }, clip.duration);
  }

  /** A clip on the timeline or in a Session slot, by ID. */
  private locate(clipId: string): ClipLocation {
    const track = this.s.tracks.find((item) => item.clips.some((clip) => clip.id === clipId));
    const clip = track?.clips.find((item) => item.id === clipId);
    if (track && clip) return { track, clip };
    for (const [key, slotClip] of this.s.session.slots) if (slotClip.id === clipId) return { clip: slotClip, key };
    throw new Error("Project clip does not exist.");
  }

  /** Swap `where`'s clip for `next` in place, on the timeline (kept in time order) or in its slot. */
  private replaceClip(where: ClipLocation, next: ProjectClip, order = true): void {
    if (where.track) {
      const { track, clip } = where;
      const swapped = track.clips.map((item) => (item === clip ? next : item));
      this.replace(track, { clips: order ? this.sortClips(swapped) : Object.freeze(swapped) });
      return;
    }
    const session = this.s.session;
    this.commit({ session: Object.freeze({ scenes: session.scenes, slots: new Map(session.slots).set(where.key, next) }) });
  }

  /** Timeline clips only. */
  private clipAndTrack(clipId: string): { track: ProjectTrack; clip: ProjectClip } {
    const track = this.s.tracks.find((item) => item.clips.some((clip) => clip.id === clipId));
    const clip = track?.clips.find((item) => item.id === clipId);
    if (!track || !clip) throw new Error("Project clip does not exist.");
    return { track, clip };
  }

  /** A clip's display name. Names are not unique: several clips may share one. */
  clipName(clipId: string): string | undefined {
    return this.store.value.clipNames.get(clipId);
  }

  /** Set a clip's display name. It lives beside the clip, so playback and open editors are untouched. */
  setClipName(clipId: string, name: string): void {
    assertProjectActive(this);
    const normalized = normalizeClipName(name);
    if (normalized === undefined) throw new RangeError("Project clip name must not be empty.");
    this.locate(clipId);
    if (this.s.clipNames.get(clipId) === normalized) return;
    this.commit(this.namedClip(clipId, normalized));
  }

  private namedClip(clipId: string, name: string | undefined): Partial<Pick<ProjectState, "clipNames">> {
    if (name === undefined) return {};
    return { clipNames: new Map(this.s.clipNames).set(clipId, name) };
  }

  private unnamedClips(clipIds: readonly string[]): Partial<Pick<ProjectState, "clipNames">> {
    const names = this.s.clipNames;
    if (!clipIds.some((id) => names.has(id))) return {};
    const next = new Map(names);
    for (const id of clipIds) next.delete(id);
    return { clipNames: next };
  }

  /** Replace the clip's playback gain and fades while borrowing the same source PCM. */
  setAudioClipEnvelope(clipId: string, settings: ClipEnvelope): AudioClip {
    assertProjectActive(this);
    const where = this.locate(clipId);
    const { clip } = where;
    if (clip.kind !== "audio") throw new Error("Project clip envelope needs an audio clip.");
    const envelope = normalizeClipEnvelope(settings, clip.duration);
    const { envelope: previous, ...audio } = clip;
    const old = previous ?? unityClipEnvelope;
    if (envelope.gain === old.gain && envelope.fadeIn === old.fadeIn && envelope.fadeOut === old.fadeOut) return clip;
    const next = Object.freeze({ ...audio, ...(envelope === unityClipEnvelope ? {} : { envelope }) });
    this.replaceClip(where, next, false);
    return next;
  }

  /** Set gain automation in original source seconds. An empty curve clears it. */
  setAudioClipGainAutomation(clipId: string, points: readonly AutomationPoint[]): AudioClip {
    assertProjectActive(this);
    const where = this.locate(clipId);
    const { clip } = where;
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
    this.replaceClip(where, next, false);
    return next;
  }

  /** Apply a prepared render only to the exact clip revision the processor borrowed. */
  applyAudioClipStretch(expected: AudioClip, ratio: number, rendered?: ProjectAudio, warp: readonly ClipStretchAnchor[] = []): AudioClip {
    assertProjectActive(this);
    const where = this.locate(expected.id);
    if (where.clip !== expected) throw new Error("Audio clip changed while rendering stretch.");
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
    const playback: AudioClipSource & AudioSourceSpan = !usesRender
      ? original
      : recorded(
          Object.freeze({
            sampleRate: rendered!.sampleRate,
            channels: Object.freeze(rendered!.channels.map((channel) => channel.slice())),
          }),
        );
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
    this.replaceClip(where, next);
    return next;
  }

  /**
   * The looped audio clip's piece `[start, end)` of local seconds; `end` may pass the clip's end. The piece starts where the loop's playback
   * is at `start`, so a trimmed clip plays what it played before, and keeps the loop.
   */
  private loopedAudioSegment(clip: AudioClip, loop: SecondsRange, start: number, end: number, id: string): AudioClip {
    const rate = clip.sampleRate;
    const first = Math.round(start * rate);
    const last = Math.round(end * rate);
    if (first >= last) throw new RangeError("Project audio trim needs at least one sample.");
    const duration = (last - first) / rate;
    const old = clip.envelope ?? unityClipEnvelope;
    const envelope = normalizeClipEnvelope(
      {
        gain: old.gain,
        fadeIn: first === 0 ? Math.min(old.fadeIn, duration) : 0,
        fadeOut: last === Math.round(clip.duration * rate) ? Math.min(old.fadeOut, duration) : 0,
      },
      duration,
    );
    const recording = recordingOf(clip);
    const plan = audioLoopFrames({ loop, sampleRate: rate, sourceOffset: clip.sourceOffset });
    const own = Math.round(clip.sourceOffset * rate);
    const from = first === 0 ? own : audioLoopSourceFrame(plan, first);
    if (from < 0) throw outsideRecording();
    // The window runs to the end of the recording, so the loop can play any part of it.
    const playback = sliceAudioSource(clip, from - own, recording.frames - recording.offset);
    let gainAutomation = clip.gainAutomation;
    if (gainAutomation && from !== own) {
      // Points are in recording seconds, so the window's new start moves `sourceStart` by the recording distance.
      const sourceStart = gainAutomation.sourceStart + (from - own) / rate;
      gainAutomation =
        sourceStart >= 0
          ? Object.freeze({ sourceStart, points: gainAutomation.points })
          : Object.freeze({
              sourceStart: 0,
              points: Object.freeze(gainAutomation.points.map((point) => Object.freeze({ ...point, time: point.time - sourceStart }))),
            });
    }
    return Object.freeze({
      kind: "audio" as const,
      id,
      time: clip.time + first / rate,
      ...playback,
      duration,
      loop,
      ...(envelope === unityClipEnvelope ? {} : { envelope }),
      ...(gainAutomation ? { gainAutomation } : {}),
    });
  }

  /** Extract a local interval without changing the source clip. */
  private segment(clip: ProjectClip, start: number, end: number, id: string): ProjectClip {
    return untracked(() => this.segmentUntracked(clip, start, end, id));
  }

  private segmentUntracked(clip: ProjectClip, start: number, end: number, id: string): ProjectClip {
    if (clip.kind === "audio" && clip.loop) return this.loopedAudioSegment(clip, clip.loop, start, end, id);
    if (clip.kind === "midi" && clip.loop && start <= 0) {
      // The start stays or moves earlier, so the notes and the loop only shift: the repeats still come from the loop's notes.
      const events = clip.events.map((event) => ({ ...event, time: event.time - start }));
      const notes = untracked(() => clip.midi.notes.value).map((note) => ({ ...note, start: note.start - start }));
      const loop = { startBeat: clip.loop.startBeat - start, endBeat: clip.loop.endBeat - start };
      return new MidiClip(id, clip.time + start, { duration: end - start, notes, events }, loop);
    }
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
      const playback = sliceAudioSource(clip, first, last, !!clip.stretch);
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
          source: sliceAudioSource(source, sourceFrom, sourceTo, true),
          ...(anchors?.length ? { anchors: Object.freeze(anchors) } : {}),
        });
      }
      let gainAutomation: AudioClipGainAutomation | undefined;
      if (clip.gainAutomation) {
        const sourceStart = clip.gainAutomation.sourceStart + sourceFirst / clip.sampleRate;
        // A window that reaches before the automation's origin keeps a non-negative start by moving the points instead.
        gainAutomation =
          sourceStart >= 0
            ? Object.freeze({ sourceStart, points: clip.gainAutomation.points })
            : Object.freeze({
                sourceStart: 0,
                points: Object.freeze(clip.gainAutomation.points.map((point) => Object.freeze({ ...point, time: point.time - sourceStart }))),
              });
      }
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
    // A looped clip is cut from what it plays, so the pieces keep the repeats as plain notes.
    const played = clip.loop
      ? loopedNotes(
          untracked(() => clip.midi.notes.value),
          clip.loop,
          clip.duration,
        )
      : untracked(() => clip.midi.notes.value);
    const notes = played.flatMap((note) => {
      const from = Math.max(start, note.start);
      const to = Math.min(end, note.start + note.duration);
      return to > from ? [{ ...note, start: from - start, duration: to - from }] : [];
    });
    const playback = clip.playbackEvents();
    const priorControls = new Map<string, Uint8Array>();
    const sustainAtEnd = new Map<number, number>();
    for (const event of playback) {
      const data = event.data;
      if ((data[0] & 0xf0) !== 0xb0 || data.length < 3 || data[1] >= 120) continue;
      if (event.beat < start) priorControls.set(`${data[0] & 15}:${data[1]}`, data);
      if (event.beat < end && data[1] === 64) sustainAtEnd.set(data[0] & 15, data[2]);
    }
    for (const event of playback)
      if (event.beat === start && (event.data[0] & 0xf0) === 0xb0 && event.data.length >= 3)
        priorControls.delete(`${event.data[0] & 15}:${event.data[1]}`);
    const events: ProjectMidiEvent[] = [
      ...[...priorControls.values()].map((data) => ({ time: 0, data })),
      ...playback.flatMap((event) =>
        event.beat >= start && event.beat < end
          ? [{ time: event.beat - start, data: event.data, ...(event.noteId ? { noteId: event.noteId } : {}) }]
          : [],
      ),
      ...[...sustainAtEnd].flatMap(([channel, value]) => (value >= 64 ? [{ time: end - start, data: new Uint8Array([0xb0 | channel, 64, 0]) }] : [])),
    ];
    return new MidiClip(id, clip.time + start, { duration: end - start, notes, events });
  }

  /**
   * Move a clip's edges, keeping its ID and name. Edges are absolute timeline positions in the clip's unit (seconds for audio, beats for MIDI);
   * an omitted edge stays. Audio stays aligned in time and can reveal any part of its recording; MIDI can extend into empty space.
   */
  resizeClip(clipId: string, edges: { start?: number; end?: number }): ProjectClip {
    assertProjectActive(this);
    const where = this.locate(clipId);
    const { clip } = where;
    let resized = untracked(() => this.resizeUntracked(clip, edges ?? {}));
    // A slot clip has no place on the timeline: trimming its start keeps it at 0.
    if (!where.track) resized = atZero(resized);
    this.replaceClip(where, resized);
    this.retire(clip);
    return resized;
  }

  private resizeUntracked(clip: ProjectClip, edges: { start?: number; end?: number }): ProjectClip {
    const { start, end } = edges;
    if ((start !== undefined && !Number.isFinite(start)) || (end !== undefined && !Number.isFinite(end))) throw outsideRecording();
    if (clip.kind === "audio") {
      const rate = clip.sampleRate;
      const frames = Math.round(clip.duration * rate);
      let first = start === undefined ? 0 : Math.round((start - clip.time) * rate);
      const last = end === undefined ? frames : Math.round((end - clip.time) * rate);
      if (first >= last) throw outsideRecording();
      if (clip.stretch) {
        if (first < 0 || last > frames) throw new RangeError("Project cannot extend a time-stretched clip; set its ratio to 1 first.");
      } else if (!clip.loop) {
        const recording = recordingOf(clip);
        if (recording.offset + first < 0 || recording.offset + last > recording.frames) throw outsideRecording();
      }
      // An edge dragged to 0 on a clip off the sample grid rounds onto it, never before the timeline's start.
      const timelineFirst = -Math.floor(clip.time * rate + 1e-6);
      let snapToZero = false;
      if (first < timelineFirst) {
        if (start !== undefined && start >= -1e-9) [first, snapToZero] = [timelineFirst, true];
        else throw new RangeError("Project clips cannot start before 0.");
      }
      const resized = this.segment(clip, first / rate, last / rate, clip.id);
      // Less than a sample from 0: place it at 0, so an edge dragged to the start lands there.
      return snapToZero && resized.time < 1 / rate ? Object.freeze({ ...(resized as AudioClip), time: 0 }) : resized;
    }
    const from = start === undefined ? 0 : start - clip.time;
    const to = end === undefined ? clip.duration : end - clip.time;
    if (clip.time + from < 0 || from >= to) throw new RangeError("Project MIDI clip edges need 0 <= start < end.");
    return this.segment(clip, from, to, clip.id);
  }

  /** Split at a local time; the left side keeps the original ID. */
  splitClip(clipId: string, offset: number): readonly [ProjectClip, ProjectClip] {
    assertProjectActive(this);
    const { track, clip } = this.clipAndTrack(clipId);
    const duration = untracked(() => clip.duration);
    if (!Number.isFinite(offset) || offset <= 0 || offset >= duration) throw new RangeError("Project split needs a time inside the clip.");
    const rightId = this.reserve(undefined, "clip");
    let left: ProjectClip | undefined;
    let right: ProjectClip | undefined;
    try {
      left = this.segment(clip, 0, offset, clip.id);
      right = this.segment(clip, offset, duration, rightId);
    } catch (error) {
      if (left instanceof MidiClip) left.dispose();
      if (right instanceof MidiClip) right.dispose();
      this.ids.delete(rightId);
      throw error;
    }
    this.replace(
      track,
      { clips: this.sortClips([...track.clips.filter((item) => item.id !== clipId), left, right]) },
      this.namedClip(rightId, this.s.clipNames.get(clipId)),
    );
    this.retire(clip);
    return [left, right];
  }

  /**
   * Remove a half-open range from the whole song. Clips after it move earlier by its length (audio by seconds, MIDI by beats), clips across it
   * are trimmed or split, and markers, tempo changes and track volume automation follow. `crossfade` (`true` for 5 ms, `false` or omitted for none, or seconds) overlaps the audio pieces that
   * meet at the range's start, centred on the join. It is atomic: inside `project.edit` it joins that Undo step, on its own it is one Undo step
   * labelled "Ripple delete" that a failure rolls back entirely.
   */
  rippleDelete(range: TimeRange, options?: { crossfade?: boolean | number }): void {
    assertProjectActive(this);
    // Many steps: an edit rolls all of them back if one fails, whether or not the caller opened one.
    this.edit("Ripple delete", () => untracked(() => rippleDeleteRange(this, range, options)));
  }

  removeClip(clipId: string): void {
    assertProjectActive(this);
    const track = this.s.tracks.find((item) => item.clips.some((clip) => clip.id === clipId));
    const clip = track?.clips.find((item) => item.id === clipId);
    if (!track || !clip) throw new Error("Project clip does not exist.");
    this.replace(track, { clips: Object.freeze(track.clips.filter((item) => item.id !== clipId)) }, this.unnamedClips([clipId]));
    this.ids.delete(clipId);
    this.retire(clip);
  }

  dispose(): void {
    if (!markProjectDisposed(this)) return;
    for (const track of this.s.tracks) for (const clip of track.clips) if (clip instanceof MidiClip) clip.dispose();
    for (const clip of this.s.session.slots.values()) if (clip instanceof MidiClip) clip.dispose();
    const history = [...this.undoStack, ...this.redoStack];
    this.undoStack = [];
    this.redoStack = [];
    for (const entry of history)
      for (const side of [entry.before, entry.after]) for (const { clip } of side.clips.values()) if (clip instanceof MidiClip) clip.dispose();
  }
}

/**
 * Runtime-only: store live plug-in state without counting it as an edit. Not exported from `@audiorective/daw`; an app without a Workspace
 * uses `project.setDeviceState`.
 */
/** A copy for rendering that shares the audio instead of copying it: renders read audio and never write it. */
export function renderSnapshot(project: Project): Project {
  return borrowSnapshotHook(project);
}

/** Codec access to the extension records: read them, or replace them without an Undo step when a file is opened. */
export function extensionRecords(project: Project, records?: ReadonlyMap<string, ExtensionRecord>): ReadonlyMap<string, ExtensionRecord> {
  return extensionRecordsHook(project, records);
}

/** `ProjectSession`'s access to its Project. */
export function sessionBridge(project: Project): SessionBridge {
  return sessionBridgeHook(project);
}

/** Codec access to the Session: restore the scenes of a file, then move each read clip into its slot. */
export function restoreScenes(project: Project, scenes: readonly Readonly<{ id?: string; name?: string }>[]): void {
  restoreScenesHook(project, scenes);
}
export function adoptSlotClip(project: Project, clipId: string, sceneId: string): void {
  adoptSlotHook(project, clipId, sceneId);
}

export function captureDeviceState(project: Project, deviceId: string, bytes: Uint8Array): void {
  captureDeviceHook(project, deviceId, bytes);
}
