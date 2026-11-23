import {
  assertProjectActive,
  collidesWithProjectId,
  importedBundles,
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
import { TempoMap } from "./tempo-map";
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
} from "./project-edits";

export type TrackKind = "audio" | "midi" | "bus";
export type BusRole = "submix" | "effect";
export type ProjectSend = Readonly<{ busId: string; gain: number }>;
export type TrackRouting = Readonly<{ outputBusId: string | null; sends: readonly ProjectSend[] }>;
const masterRouting: TrackRouting = Object.freeze({ outputBusId: null, sends: Object.freeze([]) });
/** A message at a clip-relative time in beats. */
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

/** What a MIDI clip holds: notes, the clip length and the non-note messages, all in beats from the clip's start. */
export type ProjectMidiData = Readonly<{ notes: readonly NoteInit[]; duration: number; events?: readonly ProjectMidiEvent[] }>;

/**
 * A MIDI clip of the project. Everything is in beats: `time` is the position in project beats, `duration` the clip length in beats, and note and
 * event times are beats from the clip's start. `midi` owns the editable notes; notes beyond `duration` are cut at playback. `duration` changes
 * only through the project's clip operations (`trimClip`, `splitClip`, ...), which replace the clip.
 */
export class MidiClip {
  readonly kind = "midi" as const;
  /** The note model: `clip.midi.notes.value`, `clip.midi.edit(draft => ...)`, `clip.midi.setNotes(notes)`. */
  readonly midi: MidiNotes;
  /** The clip length in beats. */
  readonly duration: number;
  private readonly sourceEvents: readonly ProjectMidiEvent[];

  constructor(
    readonly id: string,
    time: number,
    data: ProjectMidiData,
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
    const notes = untracked(() => this.midi.notes.value).flatMap((note) => {
      const end = Math.min(note.start + note.duration, duration);
      return note.start < duration && end > note.start ? [{ ...note, duration: end - note.start }] : [];
    });
    const events = this.sourceEvents
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
  title: string;
  masterVolume: number;
  tempoMap: TempoMap;
  tracks: readonly ProjectTrack[];
  markers: readonly ProjectMarker[];
}>;

const clipSeconds = (tempoMap: TempoMap, clip: ProjectClip, localTime = 0): number => {
  const position = clip.time + localTime;
  return clip.kind === "midi" ? tempoMap.beatToSeconds(position) : position;
};

const validTime = (time: number) => Number.isFinite(time) && time >= 0;

const HISTORY_LIMIT = 50;
let nextProjectInstance = 1;

type EditPlacement = Readonly<{ trackId: string; clip: ProjectClip; time: number; notes?: readonly MidiNote[] }>;
type EditSide = Readonly<{
  clips: ReadonlyMap<string, EditPlacement>;
  tempoMap: TempoMap;
  markers: readonly ProjectMarker[];
  automation: ReadonlyMap<string, readonly AutomationPoint[]>;
}>;
type EditEntry = {
  readonly label: string;
  readonly ids: readonly string[];
  readonly tempo: boolean;
  readonly markers: boolean;
  readonly automation: readonly string[];
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
  a === b || (!!a && !!b && a.trackId === b.trackId && a.clip === b.clip && a.time === b.time && sameNotes(a.notes, b.notes));
const clipFrameTolerance = (clip: ProjectClip) => (clip.kind === "audio" ? 1 / clip.sampleRate : 1e-9);
const trackShellKeys = ["id", "name", "kind", "busRole", "routing", "volume", "muted", "solo", "pan", "devices", "effects", "effectMacros"] as const;

/** Headless project content. AudioContext and UI state are not part of the file. */
export class Project {
  readonly bpm: number;
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
    this.store = new Cell<ProjectState>(
      Object.freeze({
        revision: 0,
        edits: 0,
        title: options.title ?? "Untitled",
        masterVolume: 1,
        tempoMap: new TempoMap(this.bpm),
        tracks: Object.freeze([]),
        markers: Object.freeze([]),
      }),
    );
    const store = this.store;
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
        return Object.freeze({ revision: state.revision, midi });
      }),
    });
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
          ...(clip instanceof MidiClip ? { notes: clip.midi.notes.value } : {}),
        });
    }
    return { clips, tempoMap: state.tempoMap, markers: state.markers, automation };
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
          if (!ids.length && !automation.length && !tempo && !markers) return { result, entry: undefined };
          const entry: EditEntry = { label: label.trim(), ids, tempo, markers, automation, before, after };
          this.pushHistory(entry);
          return { result, entry };
        } catch (error) {
          this.editing = undefined;
          for (const track of this.s.tracks)
            for (const clip of track.clips) if (clip instanceof MidiClip && before.clips.get(clip.id)?.clip !== clip) clip.dispose();
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
    const reachable = new Set<ProjectClip>(this.s.tracks.flatMap((track) => track.clips));
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
      entry.automation.every((id) => current.automation.get(id) === side.automation.get(id))
    );
  }

  /** The clips coming back need their tracks, and must not land on content that arrived after this side was captured. */
  private sideCanApply(entry: EditEntry, side: EditSide): boolean {
    const touched = new Set(entry.ids);
    const tracks = new Map(this.s.tracks.map((track) => [track.id, track]));
    return entry.ids.every((id) => {
      const placement = side.clips.get(id);
      if (!placement) return true;
      const track = tracks.get(placement.trackId);
      if (track?.kind !== placement.clip.kind) return false;
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
      const incoming = entry.ids.flatMap((id) => (side.clips.get(id)?.trackId === track.id ? [side.clips.get(id)!.clip] : []));
      if (!touchesAutomation && !incoming.length && !track.clips.some((clip) => ids.has(clip.id))) return track;
      return Object.freeze({
        ...track,
        clips: this.sortClips([...track.clips.filter((clip) => !ids.has(clip.id)), ...incoming]),
        ...(touchesAutomation ? { volumeAutomation: side.automation.get(track.id) ?? track.volumeAutomation } : {}),
      });
    });
    this.commit({
      tracks: Object.freeze(tracks),
      ...(entry.tempo ? { tempoMap: side.tempoMap } : {}),
      ...(entry.markers ? { markers: side.markers } : {}),
    });
  }

  get hasFileBackedAudio(): boolean {
    return this.store.value.tracks.some(({ clips }) => clips.some((clip) => clip.kind === "audio" && !!(clip.media || clip.stretch?.source.media)));
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

  setTempoChanges(changes: readonly TempoChange[]): void {
    assertProjectActive(this);
    const tempoMap = new TempoMap(this.bpm, changes);
    this.commit({ tempoMap });
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
    const copy = new Project({ title: state.title, bpm: this.bpm, signature: this.signature });
    const tracks = Object.freeze(
      state.tracks.map((track) =>
        Object.freeze({
          ...track,
          devices: Object.freeze(track.devices.map((device) => Object.freeze({ ...device, state: new Uint8Array(device.state) }))),
          clips: Object.freeze(
            track.clips.map((clip) =>
              clip instanceof MidiClip
                ? new MidiClip(clip.id, clip.time, { notes: clip.midi.notes.value, duration: clip.duration, events: clip.events })
                : borrowAudio
                  ? clip
                  : snapshotAudioClip(clip),
            ),
          ),
        }),
      ),
    );
    copy.commit({ masterVolume: state.masterVolume, tempoMap: state.tempoMap, markers: state.markers, tracks });
    for (const track of tracks) {
      copy.ids.add(track.id);
      for (const device of track.devices) copy.ids.add(device.id);
      for (const clip of track.clips) copy.ids.add(clip.id);
    }
    nextProjectId.set(copy, nextProjectId.get(this) ?? 1);
    const untrusted = importedBundles.get(this);
    if (untrusted) importedBundles.set(copy, new Set(untrusted));
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
    const suffix = /^(?:clip|device|track)(\d+)$/.exec(chosen);
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

  private replace(track: ProjectTrack, patch: Partial<ProjectTrack>): void {
    this.commit({ tracks: Object.freeze(this.s.tracks.map((item) => (item.id === track.id ? Object.freeze({ ...item, ...patch }) : item))) });
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
    this.commit({ tracks });
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

  /** @internal Fold a running plug-in's state into the Project. It is not an edit: the version and undo history ignore it. */
  captureDeviceState(deviceId: string, bytes: Uint8Array): void {
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
    assertProjectActive(this);
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

  addMidiClip(trackId: string, data: ProjectMidiData, time: number, options: { id?: string } = {}): MidiClip {
    assertProjectActive(this);
    const track = this.track(trackId, "midi");
    if (!validTime(time)) throw new RangeError("Project clip time must be finite and non-negative.");
    const id = this.reserve(options.id, "clip");
    try {
      const clip = new MidiClip(id, time, data);
      this.replace(track, { clips: this.sortClips([...track.clips, clip]) });
      return clip;
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
    if (clip.kind === "audio") {
      const options = { envelope: clip.envelope, stretch: clip.stretch, gainAutomation: clip.gainAutomation };
      return clip.media
        ? this.addAudioMediaClip(target, clip.media, time, { ...options, startFrame: clip.startFrame, frameCount: clip.frameCount })
        : this.addAudioClip(target, clip, time, options);
    }
    return this.addMidiClip(target, { notes: untracked(() => clip.midi.notes.value), duration: clip.duration, events: clip.events }, time);
  }

  private clipAndTrack(clipId: string): { track: ProjectTrack; clip: ProjectClip } {
    const track = this.s.tracks.find((item) => item.clips.some((clip) => clip.id === clipId));
    const clip = track?.clips.find((item) => item.id === clipId);
    if (!track || !clip) throw new Error("Project clip does not exist.");
    return { track, clip };
  }

  /** Replace the clip's playback gain and fades while borrowing the same source PCM. */
  setAudioClipEnvelope(clipId: string, settings: ClipEnvelope): AudioClip {
    assertProjectActive(this);
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
    assertProjectActive(this);
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
    assertProjectActive(this);
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
    return untracked(() => this.segmentUntracked(clip, start, end, id));
  }

  private segmentUntracked(clip: ProjectClip, start: number, end: number, id: string): ProjectClip {
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
    const notes = untracked(() => clip.midi.notes.value).flatMap((note) => {
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

  /** Keep the clip ID while removing material outside its local interval. */
  trimClip(clipId: string, start: number, end: number): ProjectClip {
    assertProjectActive(this);
    const { track, clip } = this.clipAndTrack(clipId);
    const duration = untracked(() => clip.duration);
    if (!validTime(start) || !Number.isFinite(end) || start >= end || end > duration)
      throw new RangeError("Project trim needs 0 <= start < end <= clip duration.");
    const trimmed = this.segment(clip, start, end, clip.id);
    this.replace(track, { clips: this.sortClips(track.clips.map((item) => (item.id === clipId ? trimmed : item))) });
    this.retire(clip);
    return trimmed;
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
    this.replace(track, {
      clips: this.sortClips([...track.clips.filter((item) => item.id !== clipId), left, right]),
    });
    this.retire(clip);
    return [left, right];
  }

  removeClip(clipId: string): void {
    assertProjectActive(this);
    const track = this.s.tracks.find((item) => item.clips.some((clip) => clip.id === clipId));
    const clip = track?.clips.find((item) => item.id === clipId);
    if (!track || !clip) throw new Error("Project clip does not exist.");
    this.replace(track, { clips: Object.freeze(track.clips.filter((item) => item.id !== clipId)) });
    this.ids.delete(clipId);
    this.retire(clip);
  }

  dispose(): void {
    if (!markProjectDisposed(this)) return;
    for (const track of this.s.tracks) for (const clip of track.clips) if (clip instanceof MidiClip) clip.dispose();
    const history = [...this.undoStack, ...this.redoStack];
    this.undoStack = [];
    this.redoStack = [];
    for (const entry of history)
      for (const side of [entry.before, entry.after]) for (const { clip } of side.clips.values()) if (clip instanceof MidiClip) clip.dispose();
  }
}
