import {
  assertProjectActive,
  collidesWithProjectId,
  importedBundles,
  keptContent,
  preservedEntries,
  markProjectDisposed,
  nextProjectId,
  validateXmlText,
  validProjectId,
} from "./project-persistence";
import {
  snapParameterValue,
  mergeParameterValues,
  rackSlotParameters,
  rackDeviceId,
  sameParameterTables,
  splitRackDeviceId,
  withRackParameter,
  type DeviceParameterRecord,
} from "./device-parameters";
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
import { controllerLaneKey, normalizeControllerLane, type ControllerLane } from "./controller-lane";
import { compileMidiPlaybackEvents, controllerStateKey, MidiClip as MidiNotes } from "@audiorective/midi";
import type { MidiNote, MidiPlaybackEvent, MidiTake, NoteInit } from "@audiorective/midi";
import { AudioMedia } from "./media";
import {
  checkArguments,
  freezeJson,
  thawJson,
  type ExtensionDefinition,
  type ExtensionSummary,
  type JsonValue,
  type ProjectExtension,
  type ProjectOperation,
  type ProjectOperations,
} from "./extensions";
import { TempoMap } from "./tempo-map";
import { MeterMap, type TimeSignatureChange } from "./meter-map";
import { rippleDelete as rippleDeleteRange } from "./ripple-delete";
import type { TempoChange } from "./tempo-map";
import { ClipTimeMap, normalizeClipAnchors, type ClipStretchAnchor } from "./clip-time-map";
import { normalizeClipEnvelope, unityClipEnvelope, type ClipEnvelope } from "./clip-envelope";
import {
  findProjectClips,
  ProjectEditConflict,
  ProjectEditFailure,
  projectOverview,
  runProjectEdits,
  type ProjectClipQuery,
  type ProjectClipSummary,
  type ProjectEditRun,
  type ProjectEditReceipt,
  type ProjectEditSongPart,
  type ProjectEditRequest,
  type ProjectOverview,
  type ProjectVersion,
  type BeatRange,
  type SecondsRange,
  type TimeRange,
} from "./project-edits";
import { audioLoopFrames, audioLoopSourceFrame, midiContentAt, midiPasses } from "./clip-loop";
import { emptySession, registerSessionReader, slotKey, splitSlotKey, type SessionScene, type SessionState } from "./session-state";

export type TrackKind = "audio" | "midi" | "bus";
export type BusRole = "submix" | "effect";
export type ProjectSend = Readonly<{
  /** Opaque ID of the destination bus track; routes must not form cycles. */
  busId: string;
  /** Finite post-fader send gain, 0..∞ linear with 1 for unity. */
  gain: number;
}>;
export type TrackRouting = Readonly<{
  /** Opaque destination bus ID, or null to route directly to the master. */
  outputBusId: string | null;
  /** Post-fader sends to distinct bus tracks; empty for no sends and cycles are rejected. */
  sends: readonly ProjectSend[];
}>;
const masterRouting: TrackRouting = Object.freeze({ outputBusId: null, sends: Object.freeze([]) });
/** A MIDI message in content beats, before the clip window is applied. */
export type ProjectMidiEvent = Readonly<{
  /** Non-negative position in MIDI content beats, before applying the clip source offset or loop. */
  time: number;
  /** Non-empty MIDI message bytes copied on input; velocity bytes use MIDI wire units. */
  data: Uint8Array;
  /** Opaque associated note ID when provided; omitted for unassociated events and later loop passes. */
  noteId?: string;
}>;
export type ProjectAudio = Pick<PCMData, "sampleRate" | "channels">;
export type ProjectMarker = Readonly<{
  /** Position in project seconds. */
  time: number;
  name: string;
}>;

export type PcmAudioSource = ProjectAudio &
  Readonly<{
    /** Excluded in this union branch; omit this field. */
    media?: never;
  }>;
export type MediaAudioSource = Readonly<{
  /** Positive integer sample rate in hertz, matching the backing media. */
  sampleRate: number;
  /** File-backed recording from which the clip reads its frame window. */
  media: AudioMedia;
  /** Inclusive zero-based sample frame per channel in the backing recording. */
  startFrame: number;
  /** Positive sample frame count per channel; the window must fit the backing media. */
  frameCount: number;
  /** Excluded in this union branch; omit this field. */
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
export type AudioClipStretchInit = Readonly<{
  /** Positive finite output-duration/source-duration ratio; 1 leaves the overall duration unchanged. */
  ratio: number;
  /** Original audio window before stretching, retained so later stretches do not compound processing. */
  source: AudioClipSource;
  /** Interior source/output sample-frame anchors; omitted for a uniform stretch with implicit endpoints. */
  anchors?: readonly ClipStretchAnchor[];
}>;
export type AudioClipStretch = Readonly<{
  /** Positive finite output-duration/source-duration ratio; 1 leaves the overall duration unchanged. */
  ratio: number;
  /** Original audio window with its offset and total length in recording seconds. */
  source: AudioClipSource & AudioSourceSpan;
  /** Interior source/output sample-frame anchors; omitted for a uniform stretch with implicit endpoints. */
  anchors?: readonly ClipStretchAnchor[];
}>;
export type AudioClipGainAutomation = Readonly<{
  /**
   * Original source seconds at the start of this clip's current window. Point times are source seconds; on a looped clip they are positions
   * in the recording, so the curve repeats with every pass of the loop.
   */
  sourceStart: number;
  /** Gain curve in original recording seconds with finite linear gains 0..∞; an empty list clears automation. */
  points: readonly AutomationPoint[];
}>;

export type AudioClipOptions = {
  /** Opaque unique clip ID; omitted to allocate a new project ID. */
  id?: string;
  /** Optional display name; omitted or blank to leave the clip unnamed. */
  name?: string;
  /** Clip gain and fades in seconds; omitted for unity gain and no fades. */
  envelope?: ClipEnvelope;
  /** Original source and stretch map; omitted for unstretched audio. */
  stretch?: AudioClipStretchInit;
  /** Gain curve in original recording seconds; omitted for no clip gain automation. */
  gainAutomation?: AudioClipGainAutomation;
};

export interface AudioClipBase extends AudioSourceSpan {
  readonly kind: "audio";
  readonly id: string;
  /** Position on the project timeline, in seconds. */
  readonly time: number;
  /** Length on the project timeline, in seconds (after any stretch); greater than 0. */
  readonly duration: number;
  /** Clip gain and edge fades in seconds; omitted for unity gain and no fades. */
  readonly envelope?: ClipEnvelope;
  /** Gain curve in original recording seconds; omitted for no clip gain automation. */
  readonly gainAutomation?: AudioClipGainAutomation;
  /** Original source and stretch map; omitted for unstretched audio. */
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

/** The `ClipTimeMap` between the clip's recording window and its place on the timeline, in clip-local seconds (0 is the clip's start); it includes stretch anchors, and without a stretch it is the identity. */
export function audioClipTimeMap(clip: AudioClip): ClipTimeMap {
  return new ClipTimeMap(audioClipSourceDuration(clip), clip.duration, clip.stretch?.anchors ?? [], clip.sampleRate);
}

/** The curve with its last point's `shape` set to `"hold"`: nothing follows it, so it has no shape of its own (a DAWproject file cannot carry one either). Frozen. */
function holdAtEnd(points: readonly AutomationPoint[]): readonly AutomationPoint[] {
  const last = points.at(-1);
  return Object.freeze(last && last.shape !== "hold" ? [...points.slice(0, -1), Object.freeze({ ...last, shape: "hold" as const })] : points);
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
  return Object.freeze({ sourceStart: automation.sourceStart, points: holdAtEnd(new AutomationCurve(automation.points).value) });
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

function audioMediaSource(clip: MediaAudioClip): MediaAudioSource {
  return Object.freeze({ sampleRate: clip.sampleRate, media: clip.media, startFrame: clip.startFrame, frameCount: clip.frameCount });
}

/**
 * Runtime access: the part `[start, end)` seconds of the whole recording behind `clip`, as a clip that plays it from time 0 with no fades,
 * stretch or loop. Throws a RangeError unless `0 <= start < end <= recording duration`.
 */
export function recordingWindow(clip: AudioClip, start: number, end: number): AudioClip {
  const { source, frames } = audioRecording(clip.media ? audioMediaSource(clip) : { sampleRate: clip.sampleRate, channels: clip.channels });
  const rate = clip.sampleRate;
  const first = Math.round(start * rate);
  const last = Math.round(end * rate);
  if (!Number.isFinite(start) || !Number.isFinite(end) || first < 0 || first >= last || last > frames)
    throw new RangeError("Workspace audition range must satisfy 0 <= start < end <= the recording's duration.");
  const window = sliceAudioSource(source, first, last, true);
  return Object.freeze({ kind: "audio" as const, id: clip.id, time: 0, duration: (last - first) / rate, ...window }) as AudioClip;
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

/**
 * The backing buffers of audio that only stands in for a stretch's render: the varispeed audio a reader gives a clip it could not render. Pieces cut
 * from such a clip share its buffer; a copy of one is marked by `copyVarispeed`. A save stores no render for a clip that plays this audio.
 */
const varispeedBuffers = new WeakSet<object>();

/** Codec access: `clip` plays stand-in varispeed audio, not a render. */
export function markVarispeed(clip: AudioClip): void {
  for (const channel of clip.channels ?? []) varispeedBuffers.add(channel.buffer);
}

/** Codec access: whether `clip` plays stand-in varispeed audio, not a render. */
export const isVarispeed = (clip: AudioClip): boolean => !!clip.channels && varispeedBuffers.has(clip.channels[0].buffer);

/** A copy of a clip plays the same stand-in audio, so it is marked like the clip. */
function copyVarispeed(from: AudioClip, to: AudioClip): void {
  if (isVarispeed(from)) markVarispeed(to);
}

/** A copy of a clip shares the original window of its stretch instead of copying it, so the copy still names the original recording. */
function sharedStretch(stretch: AudioClipStretch | undefined): AudioClipStretch | undefined {
  if (stretch && !stretch.source.media) adoptedWindows.add(stretch.source.channels[0]);
  return stretch;
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
  // A window the codec cut out of a recording (`windowOfRecording`) stays a window of it, so a save names the recording's own file.
  const adopted = !source.media && adoptedWindows.has(source.channels[0]);
  if (adopted) adoptedWindows.delete(source.channels[0]);
  return Object.freeze({ ratio, source: recorded(adopted ? source : snapshotAudioSource(source)), ...(anchors.length ? { anchors } : {}) });
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
  const copy: AudioClip = Object.freeze({
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
  copyVarispeed(clip, copy);
  return copy;
}

const midiClipTimes = new WeakMap<MidiClip, Cell<number>>();
/** How many live clips hold each note list: linked clips share one. */
const noteOwners = new WeakMap<MidiNotes, number>();
/** The non-note messages of a note list, shared by every clip placing it (a DAWproject `reference` points at the whole timeline). */
const sharedEvents = new WeakMap<MidiNotes, readonly ProjectMidiEvent[]>();

function normalizeClipName(name: string | undefined): string | undefined {
  if (name === undefined) return undefined;
  if (typeof name !== "string") throw new TypeError("Project clip name must be a string.");
  validateXmlText(name);
  return name.trim() ? name : undefined;
}

/**
 * What a MIDI clip holds: notes and non-note messages in content beats, the clip length and `sourceOffset`, the content beat where the clip's start sits
 * (default 0, may be negative: empty content before the first note).
 */
export type ProjectMidiData = Readonly<{
  /** MIDI notes placed in non-negative content beats, independent of the clip timeline position. */
  notes: readonly NoteInit[];
  /** Non-negative finite clip-window duration in beats, independent of the content length; 0 is empty. */
  duration: number;
  /** Non-note MIDI messages in content beats; omitted for no extra messages. */
  events?: readonly ProjectMidiEvent[];
  /** Content beat at the clip start; default 0, with negative values allowing empty lead-in. */
  sourceOffset?: number;
}>;

/**
 * A MIDI clip of the project. Everything is in beats: `time` is the position in project beats, `duration` the clip length in beats, and note and
 * event times are content beats. `midi` owns the editable content; the clip plays the window of it from `sourceOffset` to `sourceOffset + duration`
 * (or the loop), cutting notes that cross the edges at playback only. `time`, `duration`, `sourceOffset` and `loop` change only through the project's
 * clip operations (`resizeClip`, `splitClip`, `setClipSourceRange`, ...), which replace the clip.
 */
export class MidiClip {
  /** Always `"midi"`; tells a MIDI clip from an audio clip (`"audio"`). */
  readonly kind = "midi" as const;
  /** The note model: `clip.midi.notes.value`, `clip.midi.edit(draft => ...)`, `clip.midi.setNotes(notes)`. */
  readonly midi: MidiNotes;
  /** The clip length in beats. */
  readonly duration: number;
  /** The content beat where the clip's start sits: the clip plays content `[sourceOffset, sourceOffset + duration)`. 0 for a new clip; may be negative. */
  readonly sourceOffset: number;
  /** The part of the content that repeats until `duration`, in content beats. Set with `Project.setClipLoop`. */
  readonly loop?: BeatRange;
  private readonly sourceEvents: readonly ProjectMidiEvent[];
  private released = false;

  /** `shared` makes this clip another placement of that note list (`data.notes` and `data.events` are then ignored: the group shares both): edits to either clip are edits to both. */
  constructor(
    /** The clip's unique ID within its Project (for example `"clip-3"`); never reused after the clip is removed. */
    readonly id: string,
    time: number,
    data: ProjectMidiData,
    loop?: BeatRange,
    shared?: MidiNotes,
  ) {
    if (!Number.isFinite(data.duration) || data.duration < 0) throw new RangeError("Project MIDI duration must be finite non-negative beats.");
    midiClipTimes.set(this, new Cell(time));
    this.sourceEvents = shared
      ? (sharedEvents.get(shared) ?? Object.freeze([]))
      : Object.freeze(
          (data.events ?? []).map((event) => {
            if (!Number.isFinite(event.time) || event.time < 0 || !(event.data instanceof Uint8Array) || event.data.length === 0)
              throw new RangeError("Project MIDI events need finite non-negative times and MIDI bytes.");
            return Object.freeze({ time: event.time, data: new Uint8Array(event.data), ...(event.noteId ? { noteId: event.noteId } : {}) });
          }),
        );
    const offset = data.sourceOffset ?? 0;
    if (!Number.isFinite(offset)) throw new RangeError("Project MIDI sourceOffset must be a finite number of beats.");
    this.duration = data.duration;
    this.sourceOffset = offset;
    if (loop) this.loop = loop;
    this.midi = shared ?? new MidiNotes(data.notes);
    if (!shared) sharedEvents.set(this.midi, this.sourceEvents);
    noteOwners.set(this.midi, (noteOwners.get(this.midi) ?? 0) + 1);
  }

  /** The position in project beats. Tracked. */
  get time(): number {
    return midiClipTimes.get(this)!.value;
  }

  /** Copies preserve the clip's event owner when a caller edits returned bytes. */
  get events(): readonly ProjectMidiEvent[] {
    return this.sourceEvents.map((event) => ({ ...event, data: new Uint8Array(event.data) }));
  }

  /**
   * The clip's MIDI messages in order, `beat` in beats from the clip's start: the window `[sourceOffset, sourceOffset + duration)` of the content (or its
   * loop passes). A note crossing a window edge is shortened, the latest controller, bend, pressure and program values before the window are carried to its start and to each loop pass start (bank select, program change, controllers, then bend and pressure), and a sustain
   * pedal still down at a pass end is released there, whether or not the content goes on. The stored notes are not changed.
   */
  playbackEvents(): readonly MidiPlaybackEvent[] {
    const source = untracked(() => this.midi.notes.value);
    const notes: MidiNote[] = [];
    const events: { beat: number; data: Uint8Array; noteId?: string }[] = [];
    const isNote = (data: Uint8Array) => (data[0] & 0xf0) === 0x80 || (data[0] & 0xf0) === 0x90;
    for (const pass of midiPasses(this.sourceOffset, this.loop, this.duration)) {
      for (const note of source) {
        if (note.start >= pass.to || (!pass.first && note.start < pass.from)) continue;
        const start = Math.max(note.start, pass.from);
        const end = Math.min(note.start + note.duration, pass.to);
        if (end > start)
          notes.push({
            ...note,
            ...(pass.pass ? { id: `${note.id}@${pass.pass}` } : {}),
            start: pass.local + start - pass.from,
            duration: end - start,
          });
      }
      const priors = new Map<string, { data: Uint8Array; time: number; order: number }>();
      let order = 0;
      const sustain = new Map<number, number>();
      const passEvents: { beat: number; data: Uint8Array; noteId?: string }[] = [];
      const replaced = new Set<string>();
      for (const { time, data, noteId } of this.sourceEvents) {
        if ((data[0] & 0xf0) === 0xb0 && data.length >= 3 && data[1] < 120 && (time < pass.to || (pass.clipped && time <= pass.to)) && data[1] === 64)
          sustain.set(data[0] & 15, data[2]);
        const key = controllerStateKey(data);
        if (key !== undefined) {
          if (time < pass.from) {
            const held = priors.get(key);
            if (!held || time >= held.time) priors.set(key, { data, time, order: order++ });
          } else if (time === pass.from) replaced.add(key);
        }
        const inside = time >= pass.from && (time < pass.to || (pass.clipped && time <= pass.to));
        if (!inside || (pass.pass > 0 && isNote(data))) continue;
        passEvents.push({ beat: pass.local + time - pass.from, data, ...(noteId && pass.pass === 0 ? { noteId } : {}) });
      }
      // The state in force at the pass start goes first: bank select, program change, controllers, then bend and pressure.
      const group = (data: Uint8Array) => {
        const status = data[0] & 0xf0;
        return status === 0xb0 ? (data[1] === 0 || data[1] === 32 ? 0 : 2) : status === 0xc0 ? 1 : 3;
      };
      const carried = [...priors]
        .filter(([key]) => !replaced.has(key))
        .map(([, held]) => held)
        .sort((x, y) => group(x.data) - group(y.data) || x.time - y.time || x.order - y.order)
        .map(({ data }) => data);
      for (const data of carried) events.push({ beat: pass.local, data });
      events.push(...passEvents);
      for (const [channel, value] of sustain)
        if (value >= 64) events.push({ beat: pass.local + pass.to - pass.from, data: new Uint8Array([0xb0 | channel, 64, 0]) });
    }
    return compileMidiPlaybackEvents({ events }, { notes, duration: this.duration });
  }

  /** Releases this placement; the shared notes are disposed with the last clip that holds them. */
  /** Release the Project's MIDI clips and history. Safe to call twice; the Project is unusable afterwards. */
  dispose(): void {
    if (this.released) return;
    this.released = true;
    const owners = (noteOwners.get(this.midi) ?? 1) - 1;
    noteOwners.set(this.midi, owners);
    if (owners <= 0) this.midi.dispose();
  }
}

export type ProjectClip = AudioClip | MidiClip;
export type WebClapDevice = Readonly<{
  kind: "webclap";
  id: string;
  /** Plug-in identifier used to select the plug-in inside its WebCLAP bundle. */
  pluginId: string;
  name: string;
  /** Plug-in vendor metadata stored in the project. */
  vendor: string;
  /** Plug-in version metadata, independent of the project revision. */
  version: string;
  /** Bundle location hint resolved when opening; an empty hint needs an app-supplied resolver. */
  bundleUrl: string;
  /** Opaque plug-in state bytes; an empty array uses the plug-in initial state. */
  state: Uint8Array;
  /**
   * The device's parameter table: id, name, range, default and the value the song sets, for every parameter the plug-in reported. It is empty until a Workspace has loaded the plug-in
   * once (or a file carried it). The table is the authority for these values: the Workspace applies it after loading `state`, and keeps it equal to what the plug-in reports. Set a
   * value with `project.setDeviceParameter`.
   */
  parameters: readonly DeviceParameterRecord[];
}>;
export type ProjectDevice = WebClapDevice;
/** What `project.addDevice` takes: a device without the parts the Project assigns; `id`, `state` and `parameters` are optional. */
export type NewDevice = Omit<WebClapDevice, "id" | "state" | "parameters"> & {
  /** Opaque unique device ID; omitted to allocate a new project ID. */
  id?: string;
  /** Opaque plug-in state bytes copied into the project; omitted for an empty initial state. */
  state?: Uint8Array;
  /** Initial parameter table; omitted for an empty table populated when the plug-in is loaded. */
  parameters?: readonly DeviceParameterRecord[];
};
export type ProjectTrack = Readonly<{
  id: string;
  name: string;
  /** Track role: audio clips, MIDI clips, or a routing bus without clips. */
  kind: TrackKind;
  /** Bus purpose, submix or effect; defaults to submix for buses and is absent on other tracks. */
  busRole?: BusRole;
  /** Main output and post-fader sends; new tracks go to the master with no sends. */
  routing: TrackRouting;
  /** Finite linear gain, 0..∞ with 1 for unity; new tracks start at 1. */
  volume: number;
  /** Silences this track even when soloed; new tracks start false. */
  muted: boolean;
  /** Selects this track and its audible routing paths while any solo is active; new tracks start false. */
  solo: boolean;
  /** Stereo position -1..1, left to right; new tracks start centred at 0. */
  pan: number;
  /** Track gain points in project seconds with linear gains 0..∞; empty for no automation. */
  volumeAutomation: readonly AutomationPoint[];
  /**
   * MIDI controller movement of a MIDI track (sustain, mod wheel, any controller, pitch bend, pressure, program), one lane per (expression, channel,
   * controller), points in project beats. It plays in Arrangement alongside the track's clips; empty for other tracks. Set with `setControllerLane`.
   */
  controllerLanes: readonly ControllerLane[];
  /** Ordered WebCLAP device chain; empty when no plug-ins are assigned. */
  devices: readonly ProjectDevice[];
  /** Ordered built-in insert settings; empty for a dry rack. */
  effects: readonly RackEffect[];
  /** Normalized macro controls and their insert-parameter mappings; empty for none. */
  effectMacros: readonly RackMacroSettings[];
  /** Arrangement clips in their own units: audio in project seconds, MIDI in project beats; excludes Session slots. */
  clips: readonly ProjectClip[];
}>;

/** Everything a Project persists: its structural revision plus each MIDI clip's notes, which the clip's `midi` model owns. */
export type ProjectContent = Readonly<{
  /** Structural revision counter, including live device-state captures. */
  revision: number;
  /** Each MIDI clip's notes by clip ID, with the clip's `duration` in beats. */
  midi: ReadonlyMap<
    string,
    Readonly<{
      /** Frozen note snapshots in content beats, keyed by their owning clip ID. */
      notes: readonly MidiNote[];
      /** Saved MIDI clip-window duration in beats. */
      duration: number;
    }>
  >;
}>;

export type ProjectOptions = Readonly<{
  /** Initial song title; default Untitled. */
  title?: string;
  /** Initial positive finite tempo in quarter-note beats per minute; default 120. */
  bpm?: number;
  /** Initial numerator and power-of-two denominator; default [4, 4], with MeterMap bars counted from 1. */
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
  meterMap: MeterMap;
  tracks: readonly ProjectTrack[];
  markers: readonly ProjectMarker[];
  /** Extension data by extension id, kept as saved even when no definition is loaded. */
  extensions: ReadonlyMap<string, ExtensionRecord>;
  /** The Session grid: scenes and the clips in their slots. */
  session: SessionState;
}>;

/** One extension's saved data and the format version it was written with. */
export type ExtensionRecord = Readonly<{
  /** Positive integer format version used when the extension data was saved. */
  version: number;
  /** Frozen JSON payload preserved even when the app has no definition for the extension. */
  data: JsonValue;
}>;

const clipSeconds = (tempoMap: TempoMap, clip: ProjectClip, localTime = 0): number => {
  const position = clip.time + localTime;
  return clip.kind === "midi" ? tempoMap.beatToSeconds(position) : position;
};

const validTime = (time: number) => Number.isFinite(time) && time >= 0;

/** The same content (shared `midi`) under another window: a new position, `sourceOffset` or length. */
function midiWindow(clip: MidiClip, id: string, change: Readonly<{ time?: number; sourceOffset?: number; duration?: number }>): MidiClip {
  return new MidiClip(
    id,
    change.time ?? clip.time,
    { notes: [], duration: change.duration ?? clip.duration, sourceOffset: change.sourceOffset ?? clip.sourceOffset },
    clip.loop,
    clip.midi,
  );
}

/** The part `[from, to)` of a MIDI clip in local beats as a clip of its own: independent copies of the content, the loop kept, the window where it plays. */
function midiPiece(clip: MidiClip, id: string, from: number, to: number): MidiClip {
  return new MidiClip(
    id,
    clip.time + from,
    {
      notes: untracked(() => clip.midi.notes.value),
      events: clip.events,
      duration: to - from,
      sourceOffset: from === 0 ? clip.sourceOffset : midiContentAt(clip.sourceOffset, clip.loop, from),
    },
    clip.loop,
  );
}

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
  meterMap: MeterMap;
  markers: readonly ProjectMarker[];
  automation: ReadonlyMap<string, readonly AutomationPoint[]>;
  extensions: ReadonlyMap<string, ExtensionRecord>;
  /** The Session scenes by id; slot clips are in `clips`. */
  scenes: ReadonlyMap<string, SessionScene>;
  session: SessionState;
  /** Each track's device list, by track ID. */
  devices: ReadonlyMap<string, readonly ProjectDevice[]>;
  /** The tracks in order, by ID. Clips, devices and volume automation are tracked in the maps above; this holds the rest of a track for one that comes back. */
  tracks: ReadonlyMap<string, ProjectTrack>;
  routing: ReadonlyMap<string, TrackRouting>;
  title: string;
  masterVolume: number;
}>;
type EditEntry = {
  readonly label: string;
  readonly ids: readonly string[];
  readonly tempo: boolean;
  readonly meter: boolean;
  readonly markers: boolean;
  readonly automation: readonly string[];
  readonly extensions: readonly string[];
  /** IDs of the scenes this edit added, removed or renamed. */
  readonly scenes: readonly string[];
  /** IDs of the tracks whose device list (devices added, removed, moved or given another state) this edit changed. */
  readonly devices: readonly string[];
  /** IDs of the tracks this edit added or removed. */
  readonly tracks: readonly string[];
  /** IDs of the tracks that stay and whose routing changed. */
  readonly routing: readonly string[];
  /** For each track that stays, the mixer keys (name, volume, mute, solo, pan, inserts, macros) this edit changed; undo and redo touch only those keys. */
  readonly shells: ReadonlyMap<string, readonly TrackShellKey[]>;
  readonly title: boolean;
  readonly masterVolume: boolean;
  /** IDs of the devices this edit gave another state; every other device keeps the state it has now when the step is applied. */
  readonly deviceStates: ReadonlySet<string>;
  /** For each device this edit changed parameter values of, the IDs of those parameters; every other parameter keeps the value it has now when the step is applied. */
  readonly deviceParameters: ReadonlyMap<string, readonly string[]>;
  before: EditSide;
  after: EditSide;
};

/**
 * The scenes a reorder moved: among the scenes both sides have, those whose predecessor differs (the moved scene and the two that now follow its old and new gaps),
 * so undo puts each back after its own neighbour and leaves scenes it did not touch alone. Empty when the shared scenes keep their order.
 */
function movedScenes(before: readonly SessionScene[], after: readonly SessionScene[]): string[] {
  const inAfter = new Set(after.map((scene) => scene.id));
  const inBefore = new Set(before.map((scene) => scene.id));
  const was = before.filter((scene) => inAfter.has(scene.id)).map((scene) => scene.id);
  const now = after.filter((scene) => inBefore.has(scene.id)).map((scene) => scene.id);
  if (was.every((id, index) => id === now[index])) return [];
  return now.filter((id, index) => was[was.indexOf(id) - 1] !== now[index - 1]);
}

/** Whether the scenes present in both lists come in the same order. */
function sameSceneOrder(a: readonly SessionScene[], b: readonly SessionScene[]): boolean {
  const inB = new Set(b.map((scene) => scene.id));
  const inA = new Set(a.map((scene) => scene.id));
  const left = a.filter((scene) => inB.has(scene.id));
  const right = b.filter((scene) => inA.has(scene.id));
  return left.every((scene, index) => scene.id === right[index].id);
}

/** Whether two device lists hold the same devices in the same order; `withState` also compares each device's saved state bytes and parameter values. */
function sameDevices(a: readonly ProjectDevice[], b: readonly ProjectDevice[], withState: boolean): boolean {
  return (
    a === b ||
    (a.length === b.length &&
      a.every((device, index) => {
        const other = b[index];
        return (
          device === other ||
          (device.id === other.id &&
            device.pluginId === other.pluginId &&
            device.bundleUrl === other.bundleUrl &&
            device.name === other.name &&
            device.vendor === other.vendor &&
            device.version === other.version &&
            (!withState ||
              (device.state.length === other.state.length &&
                device.state.every((byte, i) => byte === other.state[i]) &&
                sameParameterTables(device.parameters, other.parameters))))
        );
      }))
  );
}

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
/** Whether two plain data values have the same content (key order included, which the Project's own normalisers keep stable). */
const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
/** The mixer-facing fields of a track that an edit records for Undo (routing has its own record). */
const trackShellKeys = ["name", "volume", "muted", "solo", "pan", "effects", "effectMacros"] as const;
/** A shell field, or one controller lane of the track (`lane:` + its `controllerLaneKey`): lanes are recorded one by one, so an edit to one lane does not conflict with a later change to another. */
type TrackShellKey = (typeof trackShellKeys)[number] | `lane:${string}` | `rack:${string}`;
/** The shell key of one parameter of one rack effect slot (`rack:` + slot ID + `:` + parameter ID; parameter IDs hold no `:`). */
const rackKey = (slotId: string, parameterId: string): TrackShellKey => `rack:${slotId}:${parameterId}`;
const splitRackKey = (key: string) => {
  const at = key.lastIndexOf(":");
  return { slotId: key.slice(5, at), parameterId: key.slice(at + 1) };
};
const rackValue = (track: ProjectTrack | undefined, key: string): number | undefined => {
  const { slotId, parameterId } = splitRackKey(key);
  const slot = track?.effects.find((item) => item.id === slotId);
  return slot && rackSlotParameters(slot).find((item) => item.id === parameterId)?.value;
};
const laneOf = (track: ProjectTrack, key: string) => track.controllerLanes.find((lane) => controllerLaneKey(lane) === key);
/** The shell keys of `now` that differ from `was`: changed fields, and the lanes added, removed or replaced. */
const changedShellKeys = (was: ProjectTrack, now: ProjectTrack, rackSet?: ReadonlySet<TrackShellKey>): TrackShellKey[] => {
  const keys: TrackShellKey[] = trackShellKeys.filter((key) => was[key] !== now[key]);
  // Parameter values of rack effects that `setDeviceParameter` set are recorded one by one, so a later change to another parameter of the rack does not conflict.
  // A change of the rack that is anything else (slots added, moved, retyped, or a whole-rack replace) stays under `effects`.
  const rack = was.effects !== now.effects && rackSet?.size ? rackParameterKeys(was, now) : undefined;
  if (rack && rack.every((key) => rackSet!.has(key))) keys.splice(keys.indexOf("effects"), 1, ...rack);
  if (was.controllerLanes !== now.controllerLanes)
    for (const key of new Set([...was.controllerLanes, ...now.controllerLanes].map(controllerLaneKey)))
      if (laneOf(was, key) !== laneOf(now, key)) keys.push(`lane:${key}`);
  return keys;
};
/** The rack parameter keys `now` differs from `was` in when that is the only difference between their effects, else `undefined`. */
const rackParameterKeys = (was: ProjectTrack, now: ProjectTrack): TrackShellKey[] | undefined => {
  if (was.effects.length !== now.effects.length) return undefined;
  const keys: TrackShellKey[] = [];
  try {
    for (const [index, before] of was.effects.entries()) {
      const after = now.effects[index];
      if (before === after) continue;
      if (before.id !== after.id || before.type !== after.type) return undefined;
      const wasRows = rackSlotParameters(before);
      const nowRows = rackSlotParameters(after);
      if (wasRows.length !== nowRows.length) return undefined;
      let rebuilt = before;
      for (const [row, next] of nowRows.entries()) {
        if (wasRows[row].id !== next.id) return undefined;
        if (wasRows[row].value === next.value) continue;
        keys.push(rackKey(before.id, next.id));
        rebuilt = withRackParameter(rebuilt, next.id, next.value);
      }
      if (!sameJson(rebuilt, after)) return undefined;
    }
  } catch {
    return undefined;
  }
  return keys;
};
/** Whether `a` and `b` hold the same value for every one of `keys`; false when either track is missing. */
const sameShellKeys = (a: ProjectTrack | undefined, b: ProjectTrack | undefined, keys: readonly TrackShellKey[]) =>
  !!a &&
  !!b &&
  keys.every((key) =>
    key.startsWith("rack:")
      ? rackValue(a, key) === rackValue(b, key)
      : key.startsWith("lane:")
        ? laneOf(a, key.slice(5)) === laneOf(b, key.slice(5))
        : a[key as keyof ProjectTrack] === b[key as keyof ProjectTrack],
  );
/** `track` with the fields and lanes `keys` name taken from `shell`; a lane `shell` lacks is removed, a new one is added after the others. */
const withShellKeys = (track: ProjectTrack, shell: ProjectTrack, keys: readonly TrackShellKey[]): ProjectTrack => {
  let lanes = track.controllerLanes;
  let effects = track.effects;
  const fields: Record<string, unknown> = {};
  for (const key of keys) {
    if (key.startsWith("rack:")) {
      const { slotId, parameterId } = splitRackKey(key);
      const value = rackValue(shell, key);
      if (value !== undefined)
        effects = Object.freeze(effects.map((slot) => (slot.id === slotId ? withRackParameter(slot, parameterId, value) : slot)));
      continue;
    }
    if (!key.startsWith("lane:")) {
      fields[key] = shell[key as keyof ProjectTrack];
      continue;
    }
    const name = key.slice(5);
    const next = laneOf(shell, name);
    const at = lanes.findIndex((lane) => controllerLaneKey(lane) === name);
    const list = [...lanes];
    if (!next) list.splice(at, at < 0 ? 0 : 1);
    else if (at < 0) list.push(next);
    else list[at] = next;
    lanes = Object.freeze(list);
  }
  return Object.freeze({ ...track, effects, ...fields, controllerLanes: lanes });
};

/** Validates and copies a device's parameter table: unique non-empty IDs, finite ranges with `min <= max`, and a value inside the range. */
function checkedParameters(table: readonly DeviceParameterRecord[] | undefined): readonly DeviceParameterRecord[] {
  if (table === undefined) return Object.freeze([]);
  const invalid = () => new Error("Project WebCLAP device parameters need unique IDs, names and finite ranges with the value inside.");
  if (!Array.isArray(table)) throw invalid();
  const ids = new Set<string>();
  return Object.freeze(
    table.map((item) => {
      if (
        !item ||
        typeof item.id !== "string" ||
        !item.id ||
        ids.has(item.id) ||
        typeof item.name !== "string" ||
        ![item.min, item.max, item.default, item.value].every(Number.isFinite) ||
        item.min > item.max ||
        item.value < item.min ||
        item.value > item.max ||
        (item.step !== undefined && item.step !== 1) ||
        (item.normalized !== undefined && (item.normalized !== true || item.min !== 0 || item.max !== 1))
      )
        throw invalid();
      validateXmlText(item.name);
      ids.add(item.id);
      return Object.freeze({
        id: item.id,
        name: item.name,
        min: item.min,
        max: item.max,
        default: item.default,
        value: item.value,
        ...(item.step === undefined ? {} : { step: item.step }),
        ...(item.normalized === true ? { normalized: true as const } : {}),
      });
    }),
  );
}

let captureDeviceHook: (
  project: Project,
  deviceId: string,
  capture: Readonly<{ state?: Uint8Array; parameters?: readonly DeviceParameterRecord[] }>,
) => void;
let borrowSnapshotHook: (project: Project) => Project;
let extensionRecordsHook: (project: Project, records?: ReadonlyMap<string, ExtensionRecord>) => ReadonlyMap<string, ExtensionRecord>;
let sessionBridgeHook: (project: Project) => SessionBridge;
let restoreScenesHook: (project: Project, scenes: readonly Readonly<{ id?: string; name?: string }>[]) => void;
let adoptSlotHook: (project: Project, clipId: string, sceneId: string) => void;
let adoptRenderHook: (project: Project, expected: AudioClip, rendered: ProjectAudio) => void;

/** What `ProjectSession` needs from its Project: reads of the Session grid and the writes that keep ids, names, history and the version in step. */
export type SessionBridge = Readonly<{
  /** The grid, read tracked. */
  state(): SessionState;
  /** The grid, read untracked. */
  peek(): SessionState;
  /** Returns the role of an opaque track ID, or undefined if it is absent. */
  trackKind(trackId: string): TrackKind | undefined;
  /** Reserves and returns a fresh opaque project-wide scene ID. */
  newSceneId(): string;
  /** A clip made for a slot, at time 0, with its ID reserved. */
  midi(
    data: ProjectMidiData,
    name: string | undefined,
  ): {
    /** Detached MIDI clip at project beat 0, with its project ID reserved. */
    clip: MidiClip;
    /** Optional display name to store separately; undefined leaves the clip unnamed. */
    name: string | undefined;
  };
  /** Builds a detached audio clip at project second 0 with a reserved ID and optional name. */
  audio(
    audio: ProjectAudio,
    name: string | undefined,
  ): {
    /** Detached audio clip at project second 0, with its project ID reserved. */
    clip: AudioClip;
    /** Optional display name to store separately; undefined leaves the clip unnamed. */
    name: string | undefined;
  };
  /** A copy of a clip with its own ID, name, loop and envelope; `linked` makes a MIDI copy share the source's notes. */
  clone(
    clip: ProjectClip,
    time: number,
    linked?: boolean,
  ): {
    /** Detached copy with a new ID at the requested project time, in its audio or MIDI unit. */
    clip: ProjectClip;
    /** Optional copied display name; undefined when the source is unnamed. */
    name: string | undefined;
  };
  /** A clip on the timeline or in a slot, by ID. */
  find(clipId: string): ProjectClip | undefined;
  /** Replace the grid. `named` clips take their names; `dropped` clips and `droppedIds` leave the project. */
  write(
    next: SessionState,
    change?: Readonly<{
      /** Display names keyed by opaque clip ID; omitted when no names change. */
      named?: ReadonlyMap<string, string>;
      /** Clips removed from the grid and project ownership; omitted when none are removed. */
      dropped?: readonly ProjectClip[];
      /** Additional opaque clip IDs to remove; omitted when none are removed. */
      droppedIds?: readonly string[];
    }>,
  ): void;
  /** Put a detached clip on a track of its kind. */
  place(trackId: string, clip: ProjectClip, name: string | undefined): void;
  /** Returns a clip display name, or undefined when it has no stored name. */
  clipName(clipId: string): string | undefined;
  /** Returns the current map between project beats and project seconds. */
  tempoMap(): TempoMap;
}>;

/** Headless project content. AudioContext and UI state are not part of the file. */
export class Project {
  static {
    captureDeviceHook = (project, deviceId, capture) => project.captureDevice(deviceId, capture);
    borrowSnapshotHook = (project) => untracked(() => project.snapshotUntracked(true));
    extensionRecordsHook = (project, records) => {
      if (records) project.commit({ extensions: records }, false);
      return project.s.extensions;
    };
    sessionBridgeHook = (project) => project.sessionBridge();
    restoreScenesHook = (project, scenes) => project.restoreScenes(scenes);
    adoptSlotHook = (project, clipId, sceneId) => project.adoptSlot(clipId, sceneId);
    adoptRenderHook = (project, expected, rendered) => project.adoptRenderedStretch(expected, rendered);
  }

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
  private editing?: { retired: Set<MidiClip>; rack: Map<string, Set<TrackShellKey>> };
  /** The read-only operation running now; any Project change while it runs throws. */
  private queryName: string | undefined;
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
    if (this.queryName !== undefined) throw new Error(`Operation "${this.queryName}" is read-only and cannot change the project.`);
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
    const signature = Object.freeze([...(options.signature ?? [4, 4])] as [number, number]);
    if (
      !Number.isFinite(bpm) ||
      bpm <= 0 ||
      !Number.isInteger(signature[0]) ||
      signature[0] <= 0 ||
      !Number.isInteger(signature[1]) ||
      signature[1] <= 0 ||
      (signature[1] & (signature[1] - 1)) !== 0
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
        meterMap: new MeterMap(signature),
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
      list: () =>
        Object.freeze(
          [...table.values()].map(({ name, description, input, readOnly }) =>
            Object.freeze({ name, description, input, readOnly: readOnly === true }),
          ),
        ),
      call: <Result = unknown>(name: string, args: object = {}): Result => {
        assertProjectActive(this);
        const operation = table.get(name) as ProjectOperation<object, Result> | undefined;
        if (!operation) throw new Error(`Project has no operation named "${name}".`);
        checkArguments(name, operation.input, args);
        if (operation.readOnly === true) return this.runQuery(name, () => operation.run(this, args));
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

  /** Run a read-only operation: every Project change inside it throws, and so does a write through `clip.midi` (refused before it changes anything). */
  private runQuery<T>(name: string, action: () => T): T {
    const outer = this.queryName;
    if (outer === undefined) this.queryName = name;
    // Direct writes through `clip.midi` throw before they change anything; the version check below stays as the backstop.
    const guard = () => {
      throw new Error(`Operation "${this.queryName ?? name}" is read-only and cannot change the project.`);
    };
    const guarded = new Map<MidiNotes, (() => void) | null>();
    const watchNotes = (clip: ProjectClip) => {
      if (clip instanceof MidiClip && !guarded.has(clip.midi)) guarded.set(clip.midi, clip.midi.setWriteGuard(guard));
    };
    for (const track of this.s.tracks) for (const clip of track.clips) watchNotes(clip);
    for (const clip of this.s.session.slots.values()) watchNotes(clip);
    try {
      const before = untracked(() => this.cells.version.value);
      const result = untracked(action);
      if (typeof (result as { then?: unknown } | null | undefined)?.then === "function") {
        (result as unknown as Promise<unknown>).then(undefined, () => undefined);
        throw new TypeError(`Operation "${name}" must be synchronous.`);
      }
      if (untracked(() => this.cells.version.value) !== before)
        throw new Error(`Operation "${name}" is read-only but changed the project (a note edit made outside Project methods).`);
      return result;
    } finally {
      this.queryName = outer;
      for (const [notes, previous] of guarded) notes.setWriteGuard(previous);
    }
  }

  /**
   * The agent-facing view (`summary`) of each extension this song has opened with `project.extension` and whose definition has one, in the order they were opened.
   * It is JSON, frozen, and tracked by an effect through each extension's data; a summary that is not JSON throws. Extensions without a `summary` are left out.
   */
  extensionSummaries(): readonly ExtensionSummary[] {
    assertProjectActive(this);
    return Object.freeze(
      [...this.extensionHandles.values()].flatMap((handle) => {
        const { id, summary } = handle.definition;
        if (!summary) return [];
        return [Object.freeze({ id, summary: freezeJson(summary(handle.value), `Extension "${id}" summary`) })];
      }),
    );
  }

  private sessionBridge(): SessionBridge {
    return Object.freeze({
      state: () => this.store.value.session,
      peek: () => this.s.session,
      trackKind: (trackId: string) => this.s.tracks.find((track) => track.id === trackId)?.kind,
      newSceneId: () => this.reserve(undefined, "scene"),
      midi: (data: ProjectMidiData, name: string | undefined) => this.buildMidiClip(data, 0, { name }),
      audio: (audio: ProjectAudio, name: string | undefined) => this.buildAudioClip(audio, 0, { name }),
      clone: (clip: ProjectClip, time: number, linked = false) => untracked(() => this.cloneClip(clip, time, linked)),
      find: (clipId: string) => this.findClip(clipId),
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
  private cloneClip(clip: ProjectClip, time: number, linked = false): { clip: ProjectClip; name: string | undefined } {
    const name = this.s.clipNames.get(clip.id);
    if (clip.kind === "audio") {
      if (linked) throw new Error("Project can link only MIDI clips; an audio clip cannot share content.");
      const options = { name, envelope: clip.envelope, stretch: sharedStretch(clip.stretch), gainAutomation: clip.gainAutomation };
      const built = clip.media
        ? this.buildMediaClip(clip.media, time, { ...options, startFrame: clip.startFrame, frameCount: clip.frameCount })
        : this.buildAudioClip(clip, time, options);
      if (!clip.loop) return built;
      return { clip: Object.freeze({ ...built.clip, duration: clip.duration, loop: Object.freeze({ ...clip.loop }) }), name };
    }
    const id = this.reserve(undefined, "clip");
    const loop = clip.loop && Object.freeze({ ...clip.loop });
    return {
      clip: new MidiClip(
        id,
        time,
        { notes: clip.midi.notes.value, duration: clip.duration, events: clip.events, sourceOffset: clip.sourceOffset },
        loop,
        linked ? clip.midi : undefined,
      ),
      name,
    };
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
      let run: ProjectEditRun = { copies: {}, createdNotes: [], createdTracks: [], createdScenes: [], deviceParameters: [] };
      if (this.editing) {
        // Inside an open edit the ops join its Undo step; the rehearsal above already proved they apply.
        run = runProjectEdits(this, request.ops);
        return this.appliedReceipt(undefined, "after", run);
      }
      const entry = this.runEdit(request.label, () => {
        run = runProjectEdits(this, request.ops);
      }).entry;
      return this.appliedReceipt(entry, "after", run);
    } catch (error) {
      if (error instanceof ProjectEditConflict) return { status: "conflict", version, reason: error.message };
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
    const devices = new Map(state.tracks.map((track) => [track.id, track.devices] as const));
    return {
      clips,
      tempoMap: state.tempoMap,
      meterMap: state.meterMap,
      markers: state.markers,
      automation,
      extensions: state.extensions,
      scenes,
      session: state.session,
      devices,
      tracks: new Map(state.tracks.map((track) => [track.id, track] as const)),
      routing: new Map(state.tracks.map((track) => [track.id, track.routing] as const)),
      title: state.title,
      masterVolume: state.masterVolume,
    };
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
        const editing = { retired: new Set<MidiClip>(), rack: new Map<string, Set<TrackShellKey>>() };
        this.editing = editing;
        try {
          const result = action();
          if (typeof (result as { then?: unknown } | null | undefined)?.then === "function") {
            (result as unknown as Promise<unknown>).then(undefined, () => undefined);
            throw new TypeError("Project edit action must be synchronous.");
          }
          this.editing = undefined;
          const after = this.captureSide();
          for (const clip of editing.retired) if (before.clips.get(clip.id)?.clip !== clip && after.clips.get(clip.id)?.clip !== clip) clip.dispose();
          const ids = [...new Set([...before.clips.keys(), ...after.clips.keys()])].filter(
            (id) => !samePlacement(before.clips.get(id), after.clips.get(id)),
          );
          const trackIds = [...new Set([...before.tracks.keys(), ...after.tracks.keys()])].filter(
            (id) => before.tracks.has(id) !== after.tracks.has(id),
          );
          const routing = [...after.routing.keys()].filter((id) => before.routing.has(id) && before.routing.get(id) !== after.routing.get(id));
          const automation = [...after.automation.keys()].filter(
            (id) => before.automation.has(id) && before.automation.get(id) !== after.automation.get(id),
          );
          const shells = new Map<string, readonly TrackShellKey[]>();
          for (const [id, now] of after.tracks) {
            const was = before.tracks.get(id);
            const keys = was ? changedShellKeys(was, now, editing.rack.get(id)) : [];
            if (keys.length) shells.set(id, keys);
          }
          const title = before.title !== after.title;
          const masterVolume = before.masterVolume !== after.masterVolume;
          const tempo = before.tempoMap !== after.tempoMap;
          const meter = before.meterMap !== after.meterMap;
          const markers = before.markers !== after.markers;
          const extensions = [...new Set([...before.extensions.keys(), ...after.extensions.keys()])].filter(
            (id) => before.extensions.get(id) !== after.extensions.get(id),
          );
          const scenes = [
            ...new Set([
              ...[...before.scenes.keys(), ...after.scenes.keys()].filter((id) => before.scenes.get(id) !== after.scenes.get(id)),
              ...movedScenes(before.session.scenes, after.session.scenes),
            ]),
          ];
          const devices = [...before.devices.keys()].filter((id) => {
            const now = after.devices.get(id);
            return now !== undefined && !sameDevices(before.devices.get(id)!, now, true);
          });
          if (
            !ids.length &&
            !automation.length &&
            !tempo &&
            !meter &&
            !markers &&
            !extensions.length &&
            !scenes.length &&
            !devices.length &&
            !trackIds.length &&
            !routing.length &&
            !shells.size &&
            !title &&
            !masterVolume
          ) {
            keptContent.commit(this, undefined);
            return { result, entry: undefined };
          }
          const deviceStates = new Set<string>();
          const deviceParameters = new Map<string, readonly string[]>();
          for (const [trackId, list] of before.devices) {
            const next = after.devices.get(trackId) ?? [];
            for (const device of list) {
              const other = next.find((item) => item.id === device.id);
              if (!other) continue;
              // A table that came or went with the state (setDeviceState empties it) belongs to the state bytes: the step puts both back.
              if (!sameDevices([{ ...device, parameters: other.parameters }], [other], true) || device.parameters.length !== other.parameters.length)
                deviceStates.add(device.id);
              const changed = other.parameters
                .filter((item) => device.parameters.find(({ id }) => id === item.id)?.value !== item.value)
                .map(({ id }) => id);
              if (changed.length) deviceParameters.set(device.id, Object.freeze(changed));
            }
          }
          const entry: EditEntry = {
            label: label.trim(),
            ids,
            tempo,
            meter,
            markers,
            automation,
            extensions,
            scenes,
            devices,
            tracks: trackIds,
            routing,
            shells,
            title,
            masterVolume,
            deviceStates,
            deviceParameters,
            before,
            after,
          };
          this.pushHistory(entry);
          keptContent.commit(this, entry);
          return { result, entry };
        } catch (error) {
          this.editing = undefined;
          keptContent.discard(this);
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

  private appliedReceipt(
    entry: EditEntry | undefined,
    side: "before" | "after",
    run: ProjectEditRun = { copies: {}, createdNotes: [], createdTracks: [], createdScenes: [], deviceParameters: [] },
  ): ProjectEditReceipt {
    const { copies, createdNotes, createdTracks, createdScenes, deviceParameters } = run;
    const version = untracked(() => this.cells.version.value);
    const none = { changedTracks: [], removedTracks: [], changedScenes: [], removedScenes: [], song: [] };
    if (!entry)
      return {
        status: "applied",
        version,
        created: [],
        createdNotes,
        createdTracks,
        createdScenes,
        deviceParameters,
        changed: [],
        removed: [],
        ...none,
        copies,
      };
    const target = entry[side];
    const source = side === "after" ? entry.before : entry.after;
    const removedTracks = entry.tracks.filter((id) => !target.tracks.has(id));
    const addedTracks = new Set(entry.tracks.filter((id) => target.tracks.has(id)));
    const changedTracks = [...new Set([...entry.shells.keys(), ...entry.routing, ...entry.devices, ...entry.automation])].filter(
      (id) => target.tracks.has(id) && !addedTracks.has(id),
    );
    const song: ProjectEditSongPart[] = [];
    if (entry.tempo) song.push("tempo");
    if (entry.meter) song.push("timeSignature");
    if (entry.markers) song.push("markers");
    if (entry.title) song.push("title");
    if (entry.masterVolume) song.push("masterVolume");
    return {
      status: "applied",
      version,
      created: entry.ids.filter((id) => target.clips.has(id) && !source.clips.has(id)),
      createdNotes,
      createdTracks,
      createdScenes,
      deviceParameters,
      changed: entry.ids.filter((id) => target.clips.has(id) && source.clips.has(id)),
      removed: entry.ids.filter((id) => !target.clips.has(id)),
      changedTracks,
      removedTracks,
      changedScenes: entry.scenes.filter((id) => target.scenes.has(id) && source.scenes.has(id)),
      removedScenes: entry.scenes.filter((id) => !target.scenes.has(id)),
      song,
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
    if (!this.sideIsCurrent(entry, entry[from]) || !this.sharersUnchanged(entry, entry[to]) || !this.sideCanApply(entry, entry[to]))
      return { status: "conflict", version, reason: `A later change touched what "${entry.label}" edited, so it was left in place.` };
    untracked(() =>
      batch(() => {
        this.applySide(entry, entry[to]);
        entry[to] = this.captureSide();
        keptContent.step(this, entry, kind === "redo");
        stack.pop();
        (kind === "undo" ? this.redoStack : this.undoStack).push(entry);
        this.publishHistory();
      }),
    );
    return this.appliedReceipt(entry, to);
  }

  /**
   * Clips outside `entry.ids` that share a note list with a touched clip are not part of the entry, but applying `side` rewrites that list.
   * They must still hold the notes `side` captured for them, or the step would overwrite a later edit.
   */
  private sharersUnchanged(entry: EditEntry, side: EditSide): boolean {
    const touched = new Set(entry.ids);
    const lists = new Set<MidiNotes>();
    for (const id of touched) {
      const clip = side.clips.get(id)?.clip;
      if (clip instanceof MidiClip) lists.add(clip.midi);
    }
    if (!lists.size) return true;
    for (const [id, placement] of side.clips) {
      const clip = placement.clip;
      if (touched.has(id) || !(clip instanceof MidiClip) || !lists.has(clip.midi)) continue;
      if (
        !sameNotes(
          untracked(() => clip.midi.notes.value),
          placement.notes,
        )
      )
        return false;
    }
    return true;
  }

  private sideIsCurrent(entry: EditEntry, side: EditSide): boolean {
    const current = this.captureSide();
    return (
      entry.ids.every((id) => samePlacement(current.clips.get(id), side.clips.get(id))) &&
      (!entry.tempo || current.tempoMap === side.tempoMap) &&
      (!entry.meter || current.meterMap === side.meterMap) &&
      (!entry.markers || current.markers === side.markers) &&
      entry.automation.every((id) => current.automation.get(id) === side.automation.get(id)) &&
      entry.routing.every((id) => current.routing.get(id) === side.routing.get(id)) &&
      [...entry.shells].every(([id, keys]) => sameShellKeys(current.tracks.get(id), side.tracks.get(id), keys)) &&
      (!entry.title || current.title === side.title) &&
      (!entry.masterVolume || current.masterVolume === side.masterVolume) &&
      entry.tracks.every((id) => {
        const there = current.tracks.get(id);
        if (!there) return !side.tracks.has(id);
        if (!side.tracks.has(id)) return false;
        // A track this step is about to take away must hold nothing a later change put there.
        return (
          [...current.clips.values()].every((placement) => placement.trackId !== id || entry.ids.includes(placement.clip.id)) &&
          sameDevices(current.devices.get(id) ?? [], side.devices.get(id) ?? [], false) &&
          [...current.tracks.values()].every(
            (other) =>
              other.id === id ||
              entry.tracks.includes(other.id) ||
              entry.routing.includes(other.id) ||
              (other.routing.outputBusId !== id && !other.routing.sends.some(({ busId }) => busId === id)),
          )
        );
      }) &&
      entry.extensions.every((id) => current.extensions.get(id) === side.extensions.get(id)) &&
      entry.scenes.every((id) => current.scenes.get(id) === side.scenes.get(id)) &&
      // A scene moved outside history leaves the order this step captured; undoing would put it back over that move.
      (!entry.scenes.length || sameSceneOrder(current.session.scenes, side.session.scenes)) &&
      // A plug-in's saved state refreshes while it runs, so only the list of devices must match.
      entry.devices.every((id) => {
        const now = current.devices.get(id);
        const there = side.devices.get(id);
        return now !== undefined && there !== undefined && sameDevices(now, there, false);
      }) &&
      // A parameter this step set must still hold the value the step left; one the plug-in moved by itself since belongs to someone else's change.
      [...entry.deviceParameters].every(([deviceId, ids]) => {
        const find = (devices: ReadonlyMap<string, readonly ProjectDevice[]>) =>
          [...devices.values()].flat().find((device) => device.id === deviceId);
        const now = find(current.devices);
        const there = find(side.devices);
        return (
          !now ||
          !there ||
          ids.every((id) => now.parameters.find((item) => item.id === id)?.value === there.parameters.find((item) => item.id === id)?.value)
        );
      })
    );
  }

  /** The clips coming back need their tracks, and must not land on content that arrived after this side was captured. */
  private sideCanApply(entry: EditEntry, side: EditSide): boolean {
    const touched = new Set(entry.ids);
    const tracks = new Map(this.s.tracks.map((track) => [track.id, track]));
    // A track coming back keeps its ID and its devices' IDs only if nothing else has taken them since, and the buses it uses must exist.
    for (const id of entry.tracks) {
      const shell = side.tracks.get(id);
      if (!shell || tracks.has(id)) continue;
      if (this.ids.has(id) || (side.devices.get(id) ?? []).some((device) => this.ids.has(device.id))) return false;
      tracks.set(id, Object.freeze({ ...shell, clips: Object.freeze([]) }));
    }
    for (const id of entry.tracks) if (!side.tracks.has(id)) tracks.delete(id);
    for (const id of entry.shells.keys()) if (!tracks.has(id)) return false;
    for (const id of new Set([...entry.tracks, ...entry.routing])) {
      const routing = side.routing.get(id);
      if (!routing || !tracks.has(id)) continue;
      if ((routing.outputBusId !== null && !tracks.has(routing.outputBusId)) || routing.sends.some(({ busId }) => !tracks.has(busId))) return false;
    }
    const current = this.s.session.scenes;
    // A scene or clip coming back keeps its ID only if nothing else has taken it since.
    const here = new Set(current.map((scene) => scene.id));
    if (entry.scenes.some((id) => side.scenes.has(id) && !here.has(id) && this.ids.has(id))) return false;
    // A device coming back needs its track, and keeps its ID only if no other device took it since.
    for (const id of entry.devices) {
      const track = tracks.get(id);
      if (!track) return false;
      const keep = new Set(track.devices.map((device) => device.id));
      if ((side.devices.get(id) ?? []).some((device) => !keep.has(device.id) && this.ids.has(device.id))) return false;
    }
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
    let present: readonly ProjectTrack[] = this.s.tracks;
    if (entry.tracks.length) {
      const wanted = new Set(entry.tracks);
      const next = present.filter((track) => !wanted.has(track.id) || side.tracks.has(track.id));
      for (const track of present)
        if (wanted.has(track.id) && !side.tracks.has(track.id)) {
          this.ids.delete(track.id);
          for (const device of track.devices) this.ids.delete(device.id);
        }
      const order = [...side.tracks.keys()];
      for (const [index, id] of order.entries()) {
        if (!wanted.has(id) || next.some((track) => track.id === id)) continue;
        const shell = side.tracks.get(id)!;
        const devices = side.devices.get(id) ?? shell.devices;
        const restored: ProjectTrack = Object.freeze({
          ...shell,
          devices,
          volumeAutomation: side.automation.get(id) ?? shell.volumeAutomation,
          clips: Object.freeze([]),
        });
        const before = order[index - 1];
        next.splice(before === undefined ? 0 : next.findIndex((track) => track.id === before) + 1, 0, restored);
        this.ids.add(id);
        for (const device of devices) this.ids.add(device.id);
      }
      present = next;
    }
    const tracks = present.map((track) => {
      const touchesAutomation = entry.automation.includes(track.id);
      const incomingRouting = entry.routing.includes(track.id) ? side.routing.get(track.id) : undefined;
      const incomingDevices = entry.devices.includes(track.id) ? side.devices.get(track.id) : undefined;
      // A plug-in's saved state and parameter table keep refreshing while it runs: only a device this step added, removed or gave another state takes the side's bytes,
      // and a device that stays takes back only the parameters this step set.
      const devices = incomingDevices?.map((device) => {
        const now = track.devices.find((other) => other.id === device.id);
        if (!now || !entry.before.devices.get(track.id)?.some((other) => other.id === device.id)) return device;
        const state = entry.deviceStates.has(device.id) ? device.state : now.state;
        const parameters = entry.deviceStates.has(device.id)
          ? device.parameters
          : mergeParameterValues(now.parameters, device.parameters, entry.deviceParameters.get(device.id) ?? []);
        if (state === device.state && parameters === device.parameters) return device;
        return Object.freeze({ ...device, state, parameters });
      });
      if (devices) {
        for (const device of track.devices) this.ids.delete(device.id);
        for (const device of devices) this.ids.add(device.id);
      }
      const incoming = entry.ids.flatMap((id) => {
        const placement = side.clips.get(id);
        return placement?.trackId === track.id && placement.sceneId === undefined ? [placement.clip] : [];
      });
      const outgoing = track.clips.filter((clip) => ids.has(clip.id));
      const sameClips = outgoing.length === incoming.length && outgoing.every((clip) => incoming.includes(clip) && !moved.has(clip.id));
      const shellKeys = entry.shells.get(track.id);
      const shell = shellKeys ? side.tracks.get(track.id) : undefined;
      if (!touchesAutomation && sameClips && !devices && !incomingRouting && !shell) return track;
      return Object.freeze({
        ...(shell && shellKeys ? withShellKeys(track, shell, shellKeys) : track),
        ...(devices ? { devices } : {}),
        ...(incomingRouting ? { routing: incomingRouting } : {}),
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
      ...(entry.title ? { title: side.title } : {}),
      ...(entry.masterVolume ? { masterVolume: side.masterVolume } : {}),
      ...(entry.tempo ? { tempoMap: side.tempoMap } : {}),
      ...(entry.meter ? { meterMap: side.meterMap } : {}),
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

  /**
   * True when any clip (timeline or Session slot) plays from a file-backed `AudioMedia` (a long take on disk, a clip read from a `.dawproject`) instead of in-memory PCM. Tracked.
   * Such a song cannot be written by `saveDawProject` (it throws): save it with `saveDawProjectTo` (or `saveWorkspaceTo`), which streams the audio, or `saveWorkspace`, which reads it into bytes.
   */
  get hasFileBackedAudio(): boolean {
    const fileBacked = (clip: ProjectClip) => clip.kind === "audio" && !!(clip.media || clip.stretch?.source.media);
    const state = this.store.value;
    return state.tracks.some(({ clips }) => clips.some(fileBacked)) || [...state.session.slots.values()].some(fileBacked);
  }

  /** The tracks in order, each with its clips (timeline only), mixer settings and devices. Tracked. */
  get tracks(): readonly ProjectTrack[] {
    return this.store.value.tracks;
  }

  /** The master level as linear gain: 0 or more, default 1 (unity). Tracked. */
  get masterVolume(): number {
    return this.store.value.masterVolume;
  }

  /** Set the master level as linear gain: a finite number, 0 or more (1 is unity). Inside `project.edit` it joins that Undo step and the version; outside it makes neither. */
  setMasterVolume(volume: number): void {
    assertProjectActive(this);
    if (!Number.isFinite(volume) || volume < 0) throw new RangeError("Project master volume needs a finite non-negative value.");
    if (volume === this.s.masterVolume) return;
    this.commit({ masterVolume: volume }, this.valueWriteIsEdit);
  }

  /** Beat to seconds conversion for the current tempo changes. Tracked. */
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

  /** The time signature at beat 0. Tracked. */
  get signature(): readonly [number, number] {
    return this.store.value.meterMap.initial;
  }

  /** The time signatures and bar arithmetic (`beatToBar`, `barToBeat`). Tracked. */
  get meterMap(): MeterMap {
    return this.store.value.meterMap;
  }

  /** Replace the time signature changes. Each is `{ beat, numerator, denominator }`: beat 0 or more (unique), an integer numerator and a power-of-two denominator. A change at beat 0 sets the starting signature; without one the starting signature stays. A change starts a new bar where it sits. */
  setTimeSignatureChanges(changes: readonly TimeSignatureChange[]): void {
    assertProjectActive(this);
    const starts = changes.filter(({ beat }) => beat === 0);
    if (starts.length > 1)
      throw new RangeError("Project time signatures need unique positive beats, an integer numerator and a power-of-two denominator.");
    const initial = starts.length ? ([starts[0].numerator, starts[0].denominator] as const) : this.s.meterMap.initial;
    const meterMap = new MeterMap(
      initial,
      changes.filter(({ beat }) => beat !== 0),
    );
    const now = this.s.meterMap;
    if (now.initial[0] === meterMap.initial[0] && now.initial[1] === meterMap.initial[1] && sameJson(now.changes, meterMap.changes)) return;
    this.commit({ meterMap });
  }

  /** Replace the tempo changes. Each is `{ beat, bpm }`: beat 0 or more (unique), `bpm` at least 1. A change at beat 0 sets the starting tempo; without one the starting tempo stays. */
  setTempoChanges(changes: readonly TempoChange[]): void {
    assertProjectActive(this);
    const starts = changes.filter(({ beat }) => beat === 0);
    if (starts.length > 1) throw new RangeError("Project tempo changes need unique positive beats and BPM.");
    const bpm = starts[0]?.bpm ?? this.s.tempoMap.initialBpm;
    if (starts.length && (!Number.isFinite(bpm) || bpm < 1)) throw new RangeError("Project BPM must be a finite number of at least 1.");
    const tempoMap = new TempoMap(
      bpm,
      changes.filter(({ beat }) => beat !== 0),
    );
    if (this.s.tempoMap.initialBpm === tempoMap.initialBpm && sameJson(this.s.tempoMap.changes, tempoMap.changes)) return;
    this.commit({ tempoMap });
  }

  /** The markers in time order; each `time` is in project seconds from 0. Tracked. */
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
    const copy = new Project({ title: state.title, bpm: state.tempoMap.initialBpm, signature: state.meterMap.initial });
    const recordings = new Map<readonly Float32Array[], readonly Float32Array[]>();
    // Linked clips stay linked in the copy.
    const shares = new Map<MidiNotes, MidiNotes>();
    const mirror = (clip: MidiClip): MidiClip => {
      const shared = shares.get(clip.midi);
      const next = new MidiClip(
        clip.id,
        clip.time,
        { notes: clip.midi.notes.value, duration: clip.duration, events: clip.events, sourceOffset: clip.sourceOffset },
        clip.loop,
        shared,
      );
      if (!shared) shares.set(clip.midi, next.midi);
      return next;
    };
    const tracks = Object.freeze(
      state.tracks.map((track) =>
        Object.freeze({
          ...track,
          devices: Object.freeze(track.devices.map((device) => Object.freeze({ ...device, state: new Uint8Array(device.state) }))),
          clips: Object.freeze(
            track.clips.map((clip) => (clip instanceof MidiClip ? mirror(clip) : borrowAudio ? clip : snapshotAudioClip(clip, recordings))),
          ),
        }),
      ),
    );
    const slots = new Map<string, ProjectClip>();
    for (const [key, clip] of state.session.slots)
      slots.set(key, clip instanceof MidiClip ? mirror(clip) : borrowAudio ? clip : snapshotAudioClip(clip, recordings));
    copy.commit({
      masterVolume: state.masterVolume,
      tempoMap: state.tempoMap,
      meterMap: state.meterMap,
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

  /** Replace all markers. Each has a `time` in project seconds (0 or more, unique) and a non-empty `name`; the list is stored sorted by time. */
  setMarkers(markers: readonly ProjectMarker[]): void {
    assertProjectActive(this);
    if (markers.some((marker) => typeof marker.name !== "string")) throw new RangeError("Project markers need unique non-negative times and names.");
    for (const marker of markers) validateXmlText(marker.name);
    const sorted = markers.map((marker) => Object.freeze({ time: marker.time, name: marker.name.trim() })).sort((a, b) => a.time - b.time);
    if (sorted.some((marker, index) => !validTime(marker.time) || !marker.name || (index > 0 && sorted[index - 1].time === marker.time)))
      throw new RangeError("Project markers need unique non-negative times and names.");
    if (sameJson(this.s.markers, sorted)) return;
    this.commit({ markers: Object.freeze(sorted) });
  }

  /** The song title: a non-empty string. Tracked. */
  get title(): string {
    return this.store.value.title;
  }

  /** Set the song title: a non-empty string after trimming, XML-safe characters only. */
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

  /** Add a track at the end. `volume` is linear gain, 0 or more (default 1); `pan` is -1 to 1 (default 0); `muted` and `solo` default false; `busRole` (bus tracks only) defaults to "submix"; `id` defaults to `trackN`. */
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
      controllerLanes: Object.freeze([]),
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

  private replace(track: ProjectTrack, patch: Partial<ProjectTrack>, state: Partial<Pick<ProjectState, "clipNames">> = {}, isEdit = true): void {
    this.commit(
      {
        ...state,
        tracks: Object.freeze(this.s.tracks.map((item) => (item.id === track.id ? Object.freeze({ ...item, ...patch }) : item))),
      },
      isEdit,
    );
  }

  /** Whether a mixer value write counts as a song edit: only inside `project.edit` or `applyEdits`. A direct write advances `revision` but not the song version. */
  private get valueWriteIsEdit(): boolean {
    return this.editing !== undefined;
  }

  /** Set a track's level as linear gain: a finite number, 0 or more (default 1 is unity; there is no upper limit). Called outside `project.edit` it makes no Undo step and no new `cells.version`; inside one it is part of that edit. */
  setTrackVolume(trackId: string, volume: number): void {
    assertProjectActive(this);
    const track = this.s.tracks.find((item) => item.id === trackId);
    if (!track || !Number.isFinite(volume) || volume < 0)
      throw new RangeError("Project track volume needs an existing track and non-negative value.");
    this.replace(track, { volume }, {}, this.valueWriteIsEdit);
  }

  /** Rename a track: a non-empty string after trimming, XML-safe characters only. Names need not be unique. */
  setTrackName(trackId: string, name: string): void {
    assertProjectActive(this);
    validateXmlText(name);
    const track = this.s.tracks.find((item) => item.id === trackId);
    if (!track || !name.trim()) throw new RangeError("Project track name needs an existing track and non-empty name.");
    this.replace(track, { name: name.trim() });
  }

  /** Mute or unmute a track. Mute wins over solo. Default unmuted. Outside `project.edit` it makes no Undo step and no new `cells.version`. */
  setTrackMuted(trackId: string, muted: boolean): void {
    assertProjectActive(this);
    const track = this.s.tracks.find((item) => item.id === trackId);
    if (!track || typeof muted !== "boolean") throw new RangeError("Project track mute needs an existing track and boolean value.");
    this.replace(track, { muted }, {}, this.valueWriteIsEdit);
  }

  /** Solo or unsolo a track; while any track is soloed the others are silent. Default off. Outside `project.edit` it makes no Undo step and no new `cells.version`. */
  setTrackSolo(trackId: string, solo: boolean): void {
    assertProjectActive(this);
    const track = this.s.tracks.find((item) => item.id === trackId);
    if (!track || typeof solo !== "boolean") throw new RangeError("Project track solo needs an existing track and boolean value.");
    this.replace(track, { solo }, {}, this.valueWriteIsEdit);
  }

  /** Set a track's stereo position from -1 (left) to 1 (right); 0 is centre, the default. Outside `project.edit` it makes no Undo step and no new `cells.version`. */
  setTrackPan(trackId: string, pan: number): void {
    assertProjectActive(this);
    const track = this.s.tracks.find((item) => item.id === trackId);
    if (!track || !Number.isFinite(pan) || Math.abs(pan) > 1)
      throw new RangeError("Project track pan needs an existing track and a value from -1 to 1.");
    this.replace(track, { pan }, {}, this.valueWriteIsEdit);
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
    const next = Object.freeze({
      outputBusId: routing.outputBusId,
      sends: Object.freeze(routing.sends.map(({ busId, gain }) => Object.freeze({ busId, gain }))),
    });
    if (sameJson(track.routing, next)) return;
    this.replace(track, { routing: next });
  }

  /** Replace the ordered inserts (built-in filter, delay, EQ, or app-defined custom effects) after the track's WebCLAP devices. */
  setTrackEffects(trackId: string, effects: readonly RackEffect[]): void {
    this.writeTrackEffects(trackId, effects, true);
  }

  private writeTrackEffects(trackId: string, effects: readonly RackEffect[], isEdit: boolean): void {
    assertProjectActive(this);
    const track = this.s.tracks.find((item) => item.id === trackId);
    if (!track) throw new Error("Project effects need an existing track.");
    const checked = normalizeRackEffects(effects);
    const effectMacros = retainRackMacroTargets(checked, track.effectMacros);
    if (sameJson(track.effects, checked) && sameJson(track.effectMacros, effectMacros)) return;
    this.replace(track, { effects: checked, effectMacros }, {}, isEdit);
  }

  /** Apply both the ordered inserts and their macro settings as one Project edit. */
  setTrackRackPreset(trackId: string, preset: RackPreset): void {
    assertProjectActive(this);
    const track = this.s.tracks.find((item) => item.id === trackId);
    if (!track) throw new Error("Project effects need an existing track.");
    const { effects, macros } = normalizeRackPreset(preset);
    this.replace(track, { effects, effectMacros: macros });
  }

  /** Set one rack macro of a track to a value from 0 to 1; its mapped effect parameters follow. Outside `project.edit` it makes no Undo step and no new `cells.version`. */
  setTrackMacroValue(trackId: string, macroId: string, value: number): void {
    assertProjectActive(this);
    const track = this.s.tracks.find((item) => item.id === trackId);
    const macro = track?.effectMacros.find((item) => item.id === macroId);
    if (!track || !macro) throw new Error("Project macro needs an existing track and macro.");
    if (!Number.isFinite(value) || value < 0 || value > 1) throw new RangeError("TrackRack macro value needs a number from 0 to 1.");
    if (macro.value === value) return;
    this.replace(
      track,
      { effectMacros: Object.freeze(track.effectMacros.map((item) => (item === macro ? Object.freeze({ ...item, value }) : item))) },
      {},
      this.valueWriteIsEdit,
    );
  }

  /** Remove a track with its clips, Session slot clips and devices; routes that pointed at a removed bus are cleared. Inside `project.edit` it joins that Undo step. */
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
      // Inside an edit the track may come back with Undo, and its devices are still imported ones then.
      if (!this.editing) importedBundles.get(this)?.delete(device.id);
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

  /**
   * Add a device to the end of a track's device chain. `device.kind` says which kind: `"webclap"` is a WebCLAP plug-in, with `bundleUrl` where the bundle loads from,
   * `state` the plug-in's saved bytes (default empty) and `id` defaulting to `deviceN`. Returns the stored device.
   */
  addDevice(trackId: string, device: NewDevice): ProjectDevice {
    assertProjectActive(this);
    const track = this.s.tracks.find((item) => item.id === trackId);
    if (!track) throw new Error("Project device needs an existing track.");
    const details = device;
    if (details?.kind !== "webclap") throw new Error('Project device needs a kind of "webclap".');
    if (!details.pluginId || !details.name || typeof details.bundleUrl !== "string" || (details.state && !(details.state instanceof Uint8Array)))
      throw new Error("Project WebCLAP device needs an ID, name, bundle URL and byte state.");
    for (const value of [details.pluginId, details.name, details.vendor ?? "", details.version ?? ""]) validateXmlText(value);
    const id = this.reserve(details.id, "device");
    importedBundles.get(this)?.delete(id);
    const stored: WebClapDevice = Object.freeze({
      kind: "webclap",
      id,
      pluginId: details.pluginId,
      name: details.name,
      vendor: details.vendor,
      version: details.version,
      bundleUrl: details.bundleUrl,
      state: new Uint8Array(details.state ?? []),
      parameters: checkedParameters(details.parameters),
    });
    this.replace(track, { devices: Object.freeze([...track.devices, stored]) });
    return stored;
  }

  /**
   * Replace a device's saved plug-in state with `bytes` (the plug-in's own binary format). The state carries the plug-in's own parameter values, so the device's parameter
   * table is emptied: a running Workspace loads the bytes and fills the table again from what the plug-in then reports. Set one parameter with `setDeviceParameter` instead.
   */
  setDeviceState(deviceId: string, bytes: Uint8Array): void {
    assertProjectActive(this);
    if (!(bytes instanceof Uint8Array)) throw new TypeError("Project device state needs bytes.");
    const track = this.s.tracks.find((item) => item.devices.some((device) => device.id === deviceId));
    if (!track) throw new Error("Project device needs an existing track.");
    const current = track.devices.find((device) => device.id === deviceId)!;
    if (current.state.length === bytes.length && current.state.every((byte, index) => byte === bytes[index])) return;
    const devices = track.devices.map((device) =>
      device.id === deviceId ? Object.freeze({ ...device, state: new Uint8Array(bytes), parameters: Object.freeze([]) }) : device,
    );
    this.replace(track, { devices: Object.freeze(devices) });
  }

  /**
   * Fold a running plug-in's state and parameter table into the Project. It is not an edit: the version and undo history ignore it. Reached through `captureDeviceState`.
   * A `parameters` table replaces the stored one only when its parameters (IDs, names, ranges) differ or a value differs; `state` is optional.
   */
  private captureDevice(deviceId: string, capture: Readonly<{ state?: Uint8Array; parameters?: readonly DeviceParameterRecord[] }>): void {
    assertProjectActive(this);
    const track = this.s.tracks.find((item) => item.devices.some((device) => device.id === deviceId));
    const state = capture.state && new Uint8Array(capture.state);
    const parameters = capture.parameters && checkedParameters(capture.parameters);
    if (!track) {
      // A device Undo or an edit just took away: its last state and parameters go into the history steps that bring it back.
      for (const entry of [...this.undoStack, ...this.redoStack])
        for (const side of [entry.before, entry.after])
          for (const [trackId, list] of side.devices)
            if (list.some((device) => device.id === deviceId))
              (side.devices as Map<string, readonly ProjectDevice[]>).set(
                trackId,
                Object.freeze(
                  list.map((device) =>
                    device.id === deviceId
                      ? Object.freeze({ ...device, ...(state ? { state } : {}), ...(parameters ? { parameters } : {}) })
                      : device,
                  ),
                ),
              );
      return;
    }
    if (parameters && !state) {
      const current = track.devices.find((device) => device.id === deviceId)!;
      if (sameParameterTables(current.parameters, parameters)) return;
    }
    const devices = track.devices.map((device) =>
      device.id === deviceId ? Object.freeze({ ...device, ...(state ? { state } : {}), ...(parameters ? { parameters } : {}) }) : device,
    );
    this.commit(
      { tracks: Object.freeze(this.s.tracks.map((item) => (item === track ? Object.freeze({ ...item, devices: Object.freeze(devices) }) : item))) },
      false,
    );
  }

  /**
   * Set one parameter of a device to `value`, in the parameter's own units and range (`workspace.deviceParameters(deviceId)` lists the IDs, ranges and values). `deviceId` is a
   * WebCLAP device's ID or, for a built-in rack effect, `rackDeviceId(trackId, slotId)`; a rack effect parameter writes the same Project data `setTrackEffects` does. The value is
   * song content: it is saved, joins the Undo step and version of the surrounding `project.edit` or `applyEdits` (called directly it makes no step and no new `cells.version`) and a running Workspace applies it without a rebuild. Setting the value it
   * already has changes nothing. A stepped parameter (`step: 1`) snaps the value to the nearest whole step from `min` (a tie goes up), so `53.9` applies as `54`; the method returns the value applied. Throws for an unknown device or parameter, a value outside the range, a WebCLAP device whose
   * parameter table is still empty (no Workspace has loaded it yet) and a rack parameter that a macro drives (set the macro with `setTrackMacroValue`).
   */
  setDeviceParameter(deviceId: string, parameterId: string, value: number): number {
    assertProjectActive(this);
    const track = this.s.tracks.find((item) => item.devices.some((device) => device.id === deviceId));
    if (track) {
      const device = track.devices.find((item) => item.id === deviceId)!;
      const record = device.parameters.find((item) => item.id === parameterId);
      if (!record) {
        throw new Error(
          device.parameters.length
            ? `Project device "${deviceId}" has no parameter "${parameterId}".`
            : `Project device "${deviceId}" has no parameter table yet; a Workspace lists it once the plug-in has loaded.`,
        );
      }
      value = snapParameterValue(record, value);
      if (record.value === value) return value;
      const parameters = device.parameters.map((item) => (item === record ? Object.freeze({ ...item, value }) : item));
      this.replace(
        track,
        {
          devices: Object.freeze(
            track.devices.map((item) => (item === device ? Object.freeze({ ...item, parameters: Object.freeze(parameters) }) : item)),
          ),
        },
        {},
        this.valueWriteIsEdit,
      );
      return value;
    }
    const at = splitRackDeviceId(deviceId);
    const owner = at && this.s.tracks.find((item) => item.id === at.trackId);
    const slot = owner?.effects.find((item) => item.id === at!.slotId);
    if (!owner || !slot) {
      const hint = this.s.tracks.flatMap((item) => item.effects.filter(({ id }) => id === deviceId).map(({ id }) => rackDeviceId(item.id, id)));
      throw new Error(
        `Project device "${deviceId}" does not exist${hint.length ? `; a built-in effect is addressed as ${hint.map((id) => `"${id}"`).join(" or ")}` : ""}.`,
      );
    }
    const macro = owner.effectMacros.find(({ targets }) => targets.some((target) => target.slotId === slot.id && target.parameter === parameterId));
    if (macro) throw new Error(`Project effect parameter "${parameterId}" is driven by macro "${macro.id}"; set the macro with setTrackMacroValue.`);
    this.writeTrackEffects(
      owner.id,
      owner.effects.map((item) => (item === slot ? withRackParameter(slot, parameterId, value) : item)),
      this.valueWriteIsEdit,
    );
    // Recorded after the write so a value that changed nothing leaves no key; Undo of this parameter compares and restores only it.
    const marks = this.editing?.rack;
    if (marks && owner.effects !== this.s.tracks.find((item) => item.id === owner.id)?.effects) {
      const keys = marks.get(owner.id) ?? new Set<TrackShellKey>();
      keys.add(rackKey(slot.id, parameterId));
      marks.set(owner.id, keys);
    }
    const row = rackSlotParameters(withRackParameter(slot, parameterId, value)).find(({ id }) => id === parameterId)!;
    return row.value;
  }

  /** Remove a device from its track's chain; the devices after it move up one place. */
  removeDevice(deviceId: string): void {
    assertProjectActive(this);
    const track = this.s.tracks.find((item) => item.devices.some((device) => device.id === deviceId));
    if (!track) throw new Error("Project device needs an existing track.");
    this.ids.delete(deviceId);
    // Inside an edit the device may come back with Undo, and it is still an imported one then.
    if (!this.editing) importedBundles.get(this)?.delete(deviceId);
    this.replace(track, { devices: Object.freeze(track.devices.filter((device) => device.id !== deviceId)) });
  }

  /** Put a device at position `index` of its track's chain (0 is first; the others shift). The same position is no change. Inside `project.edit` it is part of that Undo step. */
  moveDevice(deviceId: string, index: number): void {
    assertProjectActive(this);
    const track = this.s.tracks.find((item) => item.devices.some((device) => device.id === deviceId));
    if (!track) throw new Error("Project device needs an existing track.");
    if (!Number.isInteger(index) || index < 0 || index >= track.devices.length)
      throw new RangeError(`Project moveDevice needs a position from 0 to ${track.devices.length - 1}.`);
    const from = track.devices.findIndex((device) => device.id === deviceId);
    if (from === index) return;
    const devices = track.devices.filter((device) => device.id !== deviceId);
    devices.splice(index, 0, track.devices[from]);
    this.replace(track, { devices: Object.freeze(devices) });
  }

  /** Replace a track's volume automation. Each point has a `time` in project seconds (0 or more, unique), a linear-gain `value` (0 or more) and a `shape` of "linear" (ramp to the next point) or "hold" (keep the value until the next point); the last point's shape is stored as "hold". An empty list clears it. */
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
    const next = holdAtEnd(sorted);
    if (sameJson(track.volumeAutomation, next)) return;
    this.replace(track, { volumeAutomation: next });
  }

  /**
   * Replace one MIDI controller lane of a MIDI track: the lane `{ expression, channel, controller }` takes `points` (project beats, 0 or more; integer values in the
   * controller's range, 0 to 127 or 0 to 16383 for `pitchBend`; shape `"linear"` or `"hold"`). An empty `points` removes the lane; a lane that does not exist yet is
   * added after the others. See `ControllerLane` for the units and the step rule.
   */
  setControllerLane(trackId: string, lane: ControllerLane): void {
    assertProjectActive(this);
    const track = this.s.tracks.find((item) => item.id === trackId);
    if (!track) throw new Error("Project controller lane needs an existing track.");
    if (track.kind !== "midi") throw new Error("Project controller lane needs a MIDI track.");
    const next = normalizeControllerLane(lane, true);
    const key = controllerLaneKey(next);
    const at = track.controllerLanes.findIndex((item) => controllerLaneKey(item) === key);
    const lanes = [...track.controllerLanes];
    if (!next.points.length) {
      if (at < 0) return;
      lanes.splice(at, 1);
    } else if (at < 0) lanes.push(next);
    else {
      if (sameJson(track.controllerLanes[at], next)) return;
      lanes[at] = next;
    }
    this.replace(track, { controllerLanes: Object.freeze(lanes) });
  }

  /** Add an in-memory audio clip to an audio track at `time` in project seconds (0 or more). `audio.channels` are PCM at `audio.sampleRate`; `options` sets name, envelope, stretch and gain automation. */
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

  /** Add file-backed PCM without copying the full take into the project model, at `time` in project seconds (0 or more). */
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

  /** `linkedTo` is a MIDI clip (on the timeline or in a Session slot) whose notes the new clip shares (as `duplicateClip(..., { linked: true })` does); `data.notes` is then ignored. */
  addMidiClip(trackId: string, data: ProjectMidiData, time: number, options: { id?: string; name?: string; linkedTo?: string } = {}): MidiClip {
    assertProjectActive(this);
    const track = this.track(trackId, "midi");
    const { clip, name } = this.buildMidiClip(data, time, options);
    this.replace(track, { clips: this.sortClips([...track.clips, clip]) }, this.namedClip(clip.id, name));
    return clip;
  }

  /** A MIDI clip that is not placed anywhere yet; its ID is reserved. */
  private buildMidiClip(
    data: ProjectMidiData,
    time: number,
    options: { id?: string; name?: string; linkedTo?: string },
  ): { clip: MidiClip; name: string | undefined } {
    if (!validTime(time)) throw new RangeError("Project clip time must be finite and non-negative.");
    const name = normalizeClipName(options.name);
    let shared: MidiNotes | undefined;
    if (options.linkedTo !== undefined) {
      const source = this.findClip(options.linkedTo);
      if (!source) throw new Error("Project clip does not exist.");
      if (!(source instanceof MidiClip)) throw new Error("Project can link only MIDI clips; an audio clip cannot share content.");
      shared = source.midi;
    }
    const id = this.reserve(options.id, "clip");
    try {
      return { clip: new MidiClip(id, time, data, undefined, shared), name };
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

  /** Move a timeline clip to a track of the same kind at `time`, in the clip's own unit (seconds for audio, beats for MIDI; 0 or more). */
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

  /**
   * A copy of a timeline clip at `time` (the clip's own unit: seconds for audio, beats for MIDI; 0 or more), on the same track or on `options.trackId`.
   * The copy is independent; with `linked: true` it shares the source's MIDI notes instead, so `clip.midi.edit` or `setNotes` on any linked clip
   * changes all of them (one Undo step inside `project.edit`). Only MIDI clips link; `linkedClips` lists a clip's group and `makeClipUnique` leaves it.
   */
  duplicateClip(clipId: string, time: number, options: Readonly<{ trackId?: string; linked?: boolean }> = {}): ProjectClip {
    assertProjectActive(this);
    return untracked(() => this.duplicateClipUntracked(clipId, time, options.trackId, options.linked === true));
  }

  private duplicateClipUntracked(clipId: string, time: number, trackId: string | undefined, linked: boolean): ProjectClip {
    if (!validTime(time)) throw new RangeError("Project clip time must be finite and non-negative.");
    const source = this.s.tracks.find((item) => item.clips.some((clip) => clip.id === clipId));
    const clip = source?.clips.find((item) => item.id === clipId);
    if (!source || !clip) throw new Error("Project clip does not exist.");
    const target = trackId ?? source.id;
    const name = this.s.clipNames.get(clipId);
    if (clip.kind === "audio") {
      if (linked) throw new Error("Project can link only MIDI clips; an audio clip cannot share content.");
      const options = { name, envelope: clip.envelope, stretch: sharedStretch(clip.stretch), gainAutomation: clip.gainAutomation };
      const copy = clip.media
        ? this.addAudioMediaClip(target, clip.media, time, { ...options, startFrame: clip.startFrame, frameCount: clip.frameCount })
        : this.addAudioClip(target, clip, time, options);
      copyVarispeed(clip, copy);
      return clip.loop ? this.looped(copy, clip.loop, clip.duration) : copy;
    }
    const copy = this.addMidiClip(
      target,
      { notes: untracked(() => clip.midi.notes.value), duration: clip.duration, events: clip.events, sourceOffset: clip.sourceOffset },
      time,
      {
        name,
        ...(linked ? { linkedTo: clipId } : {}),
      },
    );
    return clip.loop ? this.looped(copy, clip.loop, clip.duration) : copy;
  }

  /**
   * The other clips that share this clip's MIDI notes, timeline clips first in track and time order, then Session slot clips in scene and track order;
   * empty when it is not linked. Works for a timeline or slot clip ID. Tracked.
   */
  linkedClips(clipId: string): readonly ProjectClip[] {
    const clips = [...this.tracks.flatMap((track) => track.clips), ...this.slotClipsInOrder()];
    const clip = clips.find((item) => item.id === clipId);
    if (!(clip instanceof MidiClip)) return Object.freeze([]);
    return Object.freeze(clips.filter((other): other is MidiClip => other instanceof MidiClip && other !== clip && other.midi === clip.midi));
  }

  /** Slot clips in scene order, then track order. Tracked. */
  private slotClipsInOrder(): readonly ProjectClip[] {
    const { scenes, slots } = this.store.value.session;
    return scenes.flatMap((scene) => this.store.value.tracks.flatMap((track) => slots.get(slotKey(scene.id, track.id)) ?? []));
  }

  /**
   * Give a linked clip its own copy of the notes it has now; the clips left in its group stay linked to each other. Returns the clip
   * (replaced by a new object with the same ID, like `setClipLoop`), unchanged if it is not linked. Inside `project.edit` it is part of that Undo step.
   */
  makeClipUnique(clipId: string): ProjectClip {
    assertProjectActive(this);
    const where = this.locate(clipId);
    const { clip } = where;
    if (!(clip instanceof MidiClip) || !untracked(() => this.linkedClips(clipId)).length) return clip;
    const next = new MidiClip(
      clip.id,
      clip.time,
      { notes: untracked(() => clip.midi.notes.value), duration: clip.duration, events: clip.events, sourceOffset: clip.sourceOffset },
      clip.loop,
    );
    this.replaceClip(where, next);
    this.retire(clip);
    return next;
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
        { notes: [], duration, sourceOffset: clip.sourceOffset },
        loop && Object.freeze({ ...(loop as BeatRange) }),
        clip.midi,
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

  /** A clip on the timeline or in a Session slot, by ID; undefined when there is none. */
  private findClip(clipId: string): ProjectClip | undefined {
    for (const track of this.s.tracks) {
      const clip = track.clips.find((item) => item.id === clipId);
      if (clip) return clip;
    }
    for (const clip of this.s.session.slots.values()) if (clip.id === clipId) return clip;
    return undefined;
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

  /**
   * The whole recording behind an audio clip, in the audio shape clips use: in-memory `channels` or file-backed `media` (`startFrame` 0, all
   * `frameCount` frames), plus its `duration` in seconds. The clip's own window is `sourceOffset` to `sourceOffset + duration` inside it.
   * It shares the clip's data, so nothing is copied. For a time-stretched clip the recording is the stretched audio the clip stores.
   * Works for timeline and Session slot clips; a MIDI clip or an unknown ID throws. Tracked, so an effect re-runs when the clip changes.
   */
  clipRecording(clipId: string): AudioClipSource & Readonly<{ duration: number }> {
    void this.store.value;
    const { clip } = this.locate(clipId);
    if (clip.kind !== "audio") throw new TypeError("Project clipRecording needs an audio clip.");
    const { source } = audioRecording(clip.media ? audioMediaSource(clip) : { sampleRate: clip.sampleRate, channels: clip.channels });
    return Object.freeze({ ...source, duration: audioFrameCount(source) / source.sampleRate });
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
    const { where, next } = this.stretchedClip(expected, ratio, rendered, warp);
    if (next === expected) return expected;
    this.replaceClip(where, next);
    return next;
  }

  /**
   * Opening a file: swap the varispeed audio of a clip the file stretched for the render the Workspace made, in place. Not an Undo step and not a
   * new version: the clip is the same clip with better audio.
   */
  private adoptRenderedStretch(expected: AudioClip, rendered: ProjectAudio): void {
    assertProjectActive(this);
    const stretch = expected.stretch;
    if (!stretch) throw new Error("Project clip has no stretch to render.");
    const { where, next } = this.stretchedClip(expected, stretch.ratio, rendered, stretch.anchors ?? []);
    if (where.track) {
      const { track, clip } = where;
      this.commit(
        {
          tracks: Object.freeze(
            this.s.tracks.map((item) =>
              item === track ? Object.freeze({ ...item, clips: Object.freeze(track.clips.map((c) => (c === clip ? next : c))) }) : item,
            ),
          ),
        },
        false,
      );
      return;
    }
    const session = this.s.session;
    this.commit({ session: Object.freeze({ scenes: session.scenes, slots: new Map(session.slots).set(where.key, next) }) }, false);
  }

  private stretchedClip(
    expected: AudioClip,
    ratio: number,
    rendered: ProjectAudio | undefined,
    warp: readonly ClipStretchAnchor[],
  ): { where: ClipLocation; next: AudioClip } {
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
    if (!usesRender && !expected.stretch) return { where, next: expected };
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
    return { where, next };
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
  private segment(clip: AudioClip, start: number, end: number, id: string): AudioClip {
    return untracked(() => this.segmentUntracked(clip, start, end, id));
  }

  private segmentUntracked(clip: AudioClip, start: number, end: number, id: string): AudioClip {
    if (clip.loop) return this.loopedAudioSegment(clip, clip.loop, start, end, id);
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
        // A window of the original recording, so a save still names the original file.
        source: sliceAudioSource(source, sourceFrom, sourceTo),
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

  /**
   * Point a clip at part of its content while it stays where it is on the timeline: `clip.time` is kept.
   * An audio clip takes recording seconds inside the recording (`0 <= start < end <= clip.sourceLength`); the duration becomes `end - start` and a fade survives only at an
   * edge whose recording position did not move, as with `resizeClip`. A MIDI clip takes content beats (`start` may be negative or past the last note: the window can show empty
   * content) and keeps its notes: the window is `sourceOffset = start`, `duration = end - start`.
   * On a looped clip the range is the new loop and the point the clip starts from (a slip): `loop = { start, end }`, `sourceOffset = start`, and `time`, `duration`, fades and
   * the clip's place stay, so it keeps filling the same stretch of the timeline and now repeats that part (a MIDI `start` must be `>= 0`, as for `setClipLoop`).
   * On a time-stretched audio clip the range is in seconds of the clip's stored (stretched) audio, as `clipRecording` shows it, so it can only narrow the clip; the stretch ratio and warp anchors are kept.
   * Wrap it in `project.edit` for one Undo step, like the other clip operations.
   */
  setClipSourceRange(clipId: string, range: { start: number; end: number }): ProjectClip {
    assertProjectActive(this);
    const where = this.locate(clipId);
    const { clip } = where;
    const { start, end } = range ?? ({} as { start: number; end: number });
    if (clip.kind === "midi") {
      if (!Number.isFinite(start) || !Number.isFinite(end) || !(start < end))
        throw new RangeError("Project MIDI source range needs finite start < end beats.");
      let resized: MidiClip;
      if (clip.loop) {
        if (start < 0) throw new RangeError("Project clip loop needs 0 <= start < end inside the clip's content.");
        resized = new MidiClip(
          clip.id,
          clip.time,
          { notes: [], duration: clip.duration, sourceOffset: start },
          Object.freeze({ startBeat: start, endBeat: end }),
          clip.midi,
        );
      } else resized = midiWindow(clip, clip.id, { sourceOffset: start, duration: end - start });
      this.replaceClip(where, resized);
      this.retire(clip);
      return resized;
    }
    if (!Number.isFinite(start) || !Number.isFinite(end)) throw outsideRecording();
    const rate = clip.sampleRate;
    if (clip.loop) {
      const resized = untracked(() => this.slippedLoop(clip, start, end));
      this.replaceClip(where, resized);
      return resized;
    }
    const first = Math.round((start - clip.sourceOffset) * rate);
    const last = Math.round((end - clip.sourceOffset) * rate);
    if (first >= last) throw outsideRecording();
    const resized = untracked(() => {
      const moved = this.segment(clip, first / rate, last / rate, clip.id);
      return Object.freeze({ ...moved, time: clip.time }) as AudioClip;
    });
    this.replaceClip(where, resized);
    this.retire(clip);
    return resized;
  }

  /** A looped audio clip that loops recording seconds `[start, end)` and starts from `start`, in the same place with the same length. */
  private slippedLoop(clip: AudioClip, start: number, end: number): AudioClip {
    const rate = clip.sampleRate;
    const first = Math.round(start * rate);
    const last = Math.round(end * rate);
    const recording = recordingOf(clip);
    if (first < 0 || first >= last || last > recording.frames) throw outsideRecording();
    const own = Math.round(clip.sourceOffset * rate);
    // The window runs to the end of the recording, so the loop can play any part of it.
    const playback = sliceAudioSource(clip, first - own, recording.frames - recording.offset);
    let gainAutomation = clip.gainAutomation;
    if (gainAutomation && first !== own) {
      // Points are in recording seconds, so the window's new start moves `sourceStart` by the recording distance.
      const sourceStart = gainAutomation.sourceStart + (first - own) / rate;
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
      id: clip.id,
      time: clip.time,
      ...playback,
      duration: clip.duration,
      loop: Object.freeze({ startSeconds: start, endSeconds: end }),
      ...(clip.envelope ? { envelope: clip.envelope } : {}),
      ...(gainAutomation ? { gainAutomation } : {}),
    });
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
    // Only the window moves: the content stays, aligned in time, so a cut-away note comes back when the edge moves out again and a linked clip stays linked.
    return midiWindow(clip, clip.id, {
      time: clip.time + from,
      sourceOffset: from === 0 ? clip.sourceOffset : midiContentAt(clip.sourceOffset, clip.loop, from),
      duration: to - from,
    });
  }

  /** Split a timeline clip at `offset`, measured from the clip's start in its own unit (seconds for audio, beats for MIDI): `0 < offset < duration`. The left piece keeps the original ID; the right piece gets a new one and the clip's name. */
  splitClip(clipId: string, offset: number): readonly [ProjectClip, ProjectClip] {
    assertProjectActive(this);
    const { track, clip } = this.clipAndTrack(clipId);
    const duration = untracked(() => clip.duration);
    if (!Number.isFinite(offset) || offset <= 0 || offset >= duration) throw new RangeError("Project split needs a time inside the clip.");
    const rightId = this.reserve(undefined, "clip");
    let left: ProjectClip | undefined;
    let right: ProjectClip | undefined;
    try {
      if (clip.kind === "midi") {
        left = midiPiece(clip, clip.id, 0, offset);
        right = midiPiece(clip, rightId, offset, duration);
      } else {
        left = this.segment(clip, 0, offset, clip.id);
        right = this.segment(clip, offset, duration, rightId);
      }
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

  /** Remove a timeline clip by ID (a Session slot clip is removed with `session.clearSlot`). Its name goes with it. */
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

/** Runtime access: swap the varispeed audio of a clip a file stretched for its pitch-preserving render, without an Undo step or a new version. */
export function adoptRenderedStretch(project: Project, expected: AudioClip, rendered: ProjectAudio): void {
  adoptRenderHook(project, expected, rendered);
}

export function captureDeviceState(project: Project, deviceId: string, bytes: Uint8Array, parameters?: readonly DeviceParameterRecord[]): void {
  captureDeviceHook(project, deviceId, { state: bytes, ...(parameters ? { parameters } : {}) });
}

/** Runtime-only: store a running plug-in's parameter table (metadata and the values it reports now) without counting it as an edit. */
export function captureDeviceParameters(project: Project, deviceId: string, parameters: readonly DeviceParameterRecord[]): void {
  captureDeviceHook(project, deviceId, { parameters });
}
