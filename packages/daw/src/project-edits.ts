import { AutomationCurve, type AutomationPoint } from "@audiorective/core/automation";
import type { Project, ProjectClip, ProjectMarker, ProjectTrack, TrackKind } from "./model";
import { TempoMap, type TempoChange } from "./tempo-map";
import { timeRangeKind, crossfadeSeconds } from "./ripple-delete";
import { findSlotClip, readSession, slotKey } from "./session-state";

/** One state of a Project. Opaque: compare it for equality and pass it back as `expectedVersion`. */
export type ProjectVersion = string & { readonly __projectVersion: unique symbol };
/** A half-open range of project beats: `startBeat` is inside, `endBeat` is not. */
export type BeatRange = Readonly<{ startBeat: number; endBeat: number }>;
/** A half-open range of project seconds: `startSeconds` is inside, `endSeconds` is not. */
export type SecondsRange = Readonly<{ startSeconds: number; endSeconds: number }>;
/** A half-open range in project beats or project seconds. */
export type TimeRange = BeatRange | SecondsRange;

export type ProjectClipSummary = Readonly<{
  id: string;
  name?: string;
  kind: "audio" | "midi";
  trackId: string;
  trackName: string;
  startSeconds: number;
  durationSeconds: number;
  startBeat: number;
  durationBeats: number;
  /** MIDI only: the content beat where the clip's start sits; the clip plays content `[sourceOffset, sourceOffset + durationBeats)` (or its loop). */
  sourceOffset?: number;
  /** MIDI only: the part of the content that repeats, in content beats; omitted without a loop. */
  loop?: BeatRange;
  /** The IDs of the other clips (timeline or Session slot) that share this clip's MIDI notes; omitted when the clip is not linked. */
  linkedTo?: readonly string[];
}>;

export type ProjectOverview = Readonly<{
  version: ProjectVersion;
  title: string;
  bpm: number;
  signature: readonly [number, number];
  tempoChanges: readonly TempoChange[];
  markers: readonly ProjectMarker[];
  /** The timeline clips of each track. Session slot clips are in `session`, not here. */
  tracks: readonly Readonly<{ id: string; name: string; kind: TrackKind; clips: readonly ProjectClipSummary[] }>[];
  /** The Session grid: scenes in order, each with the clips of its filled slots. */
  session: readonly Readonly<{ id: string; name: string; clips: readonly ProjectSlotClipSummary[] }>[];
}>;

/** A clip in a Session slot. `duration` is in the clip's own unit: seconds for audio, beats for MIDI. */
export type ProjectSlotClipSummary = Readonly<{
  id: string;
  name?: string;
  kind: "audio" | "midi";
  trackId: string;
  trackName: string;
  duration: number;
  unit: "seconds" | "beats";
  /** MIDI only: the content beat where the clip's start sits (see `ProjectClipSummary`). */
  sourceOffset?: number;
  /** MIDI only: the repeating part of the content, in content beats; omitted without a loop. */
  loop?: BeatRange;
  /** The IDs of the other clips (timeline or Session slot) that share this clip's MIDI notes; omitted when the clip is not linked. */
  linkedTo?: readonly string[];
}>;

export type ProjectClipQuery = Readonly<{
  /** Exact clip name. Names are not unique, so check how many clips match. */
  name?: string;
  trackId?: string;
  /** Exact track name. */
  trackName?: string;
  range?: BeatRange;
  /** How a clip must relate to `range`. Default `"overlaps"`. */
  relation?: "overlaps" | "contained";
}>;

/** An existing clip, or one clip made by an earlier `copyRange` in the same request. */
export type EditClipSelector =
  | Readonly<{ clipId: string; fromCopy?: never; trackId?: never; trackName?: never; name?: never }>
  | Readonly<{ fromCopy: string; clipId?: never; trackId?: string; trackName?: string; name?: string }>;

export type CopyRangeEdit = Readonly<{
  type: "copyRange";
  range: BeatRange;
  atBeat: number;
  /** `"insert"` opens room at `atBeat`: later clips, tempo, markers and automation move later on every track. */
  placement: "insert";
  /** Names the copies so later operations in this request can select them with `fromCopy`. */
  as: string;
}>;
export type MoveClipEdit = Readonly<{
  type: "moveClip";
  clip: EditClipSelector;
  /** Beats follow the tempo map at the time this step runs. A clip that ends the request on top of another clip rejects it. */
  position: Readonly<{ atBeat: number; byBeats?: never }> | Readonly<{ byBeats: number; atBeat?: never }>;
}>;
export type SetNoteVelocityEdit = Readonly<{
  type: "setNoteVelocity";
  clip: EditClipSelector;
  noteId: string;
  /** 0 to 1. */
  velocity: number;
}>;
/** A note to add, in content beats (the clip plays the window starting at its `sourceOffset`): `start` counts from the content's first beat, not the clip's start. */
export type NewNoteEdit = Readonly<{
  /** MIDI note number, an integer 0 to 127 (60 is middle C). */
  pitch: number;
  /** Content beats, 0 or more. */
  start: number;
  /** Beats, more than 0. */
  duration: number;
  /** 0 to 1. Default 0.8. */
  velocity?: number;
}>;
/** New notes in a MIDI clip's content. Read their IDs with `read_notes` or from the clip's `midi.notes`. */
export type AddNotesEdit = Readonly<{ type: "addNotes"; clip: EditClipSelector; notes: readonly NewNoteEdit[] }>;
/** Delete notes by ID. */
export type RemoveNotesEdit = Readonly<{ type: "removeNotes"; clip: EditClipSelector; noteIds: readonly string[] }>;
/** Change notes by ID; an omitted field stays. */
export type EditNotesEdit = Readonly<{
  type: "editNotes";
  clip: EditClipSelector;
  notes: readonly Readonly<{ id: string; pitch?: number; start?: number; duration?: number; velocity?: number }>[];
}>;
export type RippleDeleteEdit = Readonly<{
  type: "rippleDelete";
  range: TimeRange;
  /** `true` for a short default crossfade (5 ms), `false` or omitted for none, or a length in seconds. */
  crossfade?: boolean | number;
}>;
export type MakeClipUniqueEdit = Readonly<{
  type: "makeClipUnique";
  clip: EditClipSelector;
}>;
export type ResizeClipEdit = Readonly<{
  type: "resizeClip";
  clip: EditClipSelector;
  /** Absolute project beats. An omitted edge stays. Nothing is deleted: a MIDI clip's start edge moves its `sourceOffset` with it, an audio clip's reveals its recording. */
  start?: number;
  end?: number;
}>;
export type SetClipSourceRangeEdit = Readonly<{
  type: "setClipSourceRange";
  clip: EditClipSelector;
  /** The part of the content to play, keeping the clip's position: content beats for a MIDI clip, recording seconds for an audio clip. */
  start: number;
  end: number;
}>;
export type RenameClipEdit = Readonly<{ type: "renameClip"; clip: EditClipSelector; name: string }>;
/** One JSON-serializable step of `project.applyEdits`. */
export type ProjectEditOperation =
  | CopyRangeEdit
  | MoveClipEdit
  | ResizeClipEdit
  | SetClipSourceRangeEdit
  | SetNoteVelocityEdit
  | AddNotesEdit
  | RemoveNotesEdit
  | EditNotesEdit
  | RenameClipEdit
  | RippleDeleteEdit
  | MakeClipUniqueEdit;

export type ProjectEditRequest = Readonly<{
  /** The version the caller read. A different current version returns `conflict` and changes nothing. */
  expectedVersion: ProjectVersion;
  /** Shown in undo history. */
  label: string;
  ops: readonly ProjectEditOperation[];
}>;

export type ProjectEditRejection =
  | "invalid-request"
  | "invalid-operation"
  | "clip-not-found"
  | "ambiguous-clip"
  | "note-not-found"
  | "overlap"
  | "nothing-to-undo"
  | "nothing-to-redo"
  | "edit-failed";

export type ProjectEditReceipt = Readonly<
  | {
      status: "applied";
      version: ProjectVersion;
      created: readonly string[];
      /** Per `addNotes` operation, in request order: the clip and the IDs of the notes it created, in the order of the operation's `notes`. */
      createdNotes: readonly Readonly<{ clipId: string; ids: readonly string[] }>[];
      changed: readonly string[];
      removed: readonly string[];
      /** Per `as` name: which clip each copy came from. */
      copies: Readonly<Record<string, readonly Readonly<{ from: string; id: string; trackId: string }>[]>>;
    }
  | { status: "conflict"; version: ProjectVersion; reason: string }
  | { status: "rejected"; version: ProjectVersion; code: ProjectEditRejection; reason: string; opIndex?: number }
>;

export type ProjectEditCopies = Record<string, { from: string; id: string; trackId: string }[]>;
export type ProjectEditCreatedNotes = { clipId: string; ids: string[] }[];
/** What running the operations produced beyond the clip changes the history entry already lists. */
export type ProjectEditRun = { copies: ProjectEditCopies; createdNotes: ProjectEditCreatedNotes };

export class ProjectEditFailure extends Error {
  constructor(
    readonly code: ProjectEditRejection,
    message: string,
    readonly opIndex?: number,
  ) {
    super(message);
  }
}

const EPSILON = 1e-9;
/** Keeps a value step between adjoining automation blocks from becoming a long ramp. */
const AUTOMATION_EDGE_SECONDS = 0.001;

const fail = (code: ProjectEditRejection, message: string): never => {
  throw new ProjectEditFailure(code, message);
};
const validBeat = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

function clipBeats(tempo: TempoMap, clip: ProjectClip): readonly [number, number] {
  if (clip.kind === "midi") return [clip.time, clip.time + clip.duration];
  return [tempo.secondsToBeat(clip.time), tempo.secondsToBeat(clip.time + clip.duration)];
}

function summary(project: Project, tempo: TempoMap, track: ProjectTrack, clip: ProjectClip): ProjectClipSummary {
  const linked = project.linkedClips(clip.id).map(({ id }) => id);
  const name = project.clipName(clip.id);
  const [startBeat, endBeat] = clipBeats(tempo, clip);
  const startSeconds = clip.kind === "midi" ? tempo.beatToSeconds(clip.time) : clip.time;
  const endSeconds = clip.kind === "midi" ? tempo.beatToSeconds(clip.time + clip.duration) : clip.time + clip.duration;
  return {
    id: clip.id,
    ...(name === undefined ? {} : { name }),
    kind: clip.kind,
    trackId: track.id,
    trackName: track.name,
    startSeconds,
    durationSeconds: endSeconds - startSeconds,
    startBeat,
    durationBeats: endBeat - startBeat,
    ...(clip.kind === "midi" ? { sourceOffset: clip.sourceOffset, ...(clip.loop ? { loop: { ...clip.loop } } : {}) } : {}),
    ...(linked.length ? { linkedTo: linked } : {}),
  };
}

export function projectOverview(project: Project, version: ProjectVersion): ProjectOverview {
  const tempo = project.tempoMap;
  return {
    version,
    title: project.title,
    bpm: project.bpm,
    signature: project.signature,
    tempoChanges: tempo.changes,
    markers: project.markers,
    tracks: project.tracks.map((track) => ({
      id: track.id,
      name: track.name,
      kind: track.kind,
      clips: track.clips.map((clip) => summary(project, tempo, track, clip)),
    })),
    session: readSession(project).scenes.map((scene) => ({
      id: scene.id,
      name: scene.name,
      clips: project.tracks.flatMap((track) => {
        const clip = readSession(project).slots.get(slotKey(scene.id, track.id));
        if (!clip) return [];
        const name = project.clipName(clip.id);
        const linked = project.linkedClips(clip.id).map(({ id }) => id);
        return [
          {
            id: clip.id,
            ...(name === undefined ? {} : { name }),
            kind: clip.kind,
            trackId: track.id,
            trackName: track.name,
            duration: clip.duration,
            unit: clip.kind === "midi" ? ("beats" as const) : ("seconds" as const),
            ...(clip.kind === "midi" ? { sourceOffset: clip.sourceOffset, ...(clip.loop ? { loop: { ...clip.loop } } : {}) } : {}),
            ...(linked.length ? { linkedTo: linked } : {}),
          },
        ];
      }),
    })),
  };
}

export function findProjectClips(project: Project, query: ProjectClipQuery): readonly ProjectClipSummary[] {
  const tempo = project.tempoMap;
  const { range, relation = "overlaps" } = query;
  if (range && (!validBeat(range.startBeat) || !validBeat(range.endBeat) || range.startBeat >= range.endBeat))
    throw new RangeError("Project clip query needs a range with 0 <= startBeat < endBeat.");
  if (relation !== "overlaps" && relation !== "contained") throw new RangeError('Project clip query relation must be "overlaps" or "contained".');
  return project.tracks.flatMap((track) => {
    if ((query.trackId !== undefined && track.id !== query.trackId) || (query.trackName !== undefined && track.name !== query.trackName)) return [];
    return track.clips.flatMap((clip) => {
      if (query.name !== undefined && project.clipName(clip.id) !== query.name) return [];
      const item = summary(project, tempo, track, clip);
      if (range) {
        const end = item.startBeat + item.durationBeats;
        const matches =
          relation === "contained"
            ? item.startBeat >= range.startBeat - EPSILON && end <= range.endBeat + EPSILON
            : item.startBeat < range.endBeat - EPSILON && end > range.startBeat + EPSILON;
        if (!matches) return [];
      }
      return [item];
    });
  });
}

/** Tempo after inserting a copy of `[start, end)` at `at`: every old beat at or after `at` moves later by the section length. */
function insertedTempo(tempo: TempoMap, start: number, end: number, at: number): TempoChange[] {
  const length = end - start;
  if (at === 0 && tempo.bpmAtBeat(start) !== tempo.initialBpm)
    fail("invalid-operation", "copyRange cannot insert at beat 0 when the section starts at a different tempo.");
  const steps = new Map<number, number>();
  for (const change of tempo.changes) if (change.beat < at) steps.set(change.beat, change.bpm);
  steps.set(at, tempo.bpmAtBeat(start));
  for (const change of tempo.changes) if (change.beat > start && change.beat < end) steps.set(at + change.beat - start, change.bpm);
  steps.set(at + length, tempo.bpmAtBeat(at));
  for (const change of tempo.changes) if (change.beat > at) steps.set(change.beat + length, change.bpm);
  let previous = tempo.initialBpm;
  const changes: TempoChange[] = [];
  for (const [beat, bpm] of [...steps].sort((a, b) => a[0] - b[0])) {
    if (beat === 0 || bpm === previous) continue;
    changes.push({ beat, bpm });
    previous = bpm;
  }
  return changes;
}

function insertedAutomation(
  points: readonly AutomationPoint[],
  edges: Readonly<{ start: number; end: number; at: number; atAfter: number }>,
  copied: (seconds: number) => number,
  later: (seconds: number) => number,
): AutomationPoint[] {
  const curve = new AutomationCurve(points);
  const shapeAt = (time: number) => points.findLast((point) => point.time <= time)?.shape ?? "hold";
  const out: AutomationPoint[] = [];
  const push = (time: number, value: number, shape: AutomationPoint["shape"]) => {
    if (time < 0 || (out.length && time <= out[out.length - 1].time)) return;
    out.push({ time, value, shape });
  };
  for (const point of points) if (point.time < edges.at) push(point.time, point.value, point.shape);
  // A curve holds its first value before its first point, so a new earlier point must not redefine that stretch.
  if (!out.length && edges.at > 0) push(Math.max(0, edges.at - AUTOMATION_EDGE_SECONDS), curve.valueAt(edges.at), "hold");
  if (shapeAt(edges.at - EPSILON) === "linear") push(edges.at - AUTOMATION_EDGE_SECONDS, curve.valueAt(edges.at), "linear");
  push(edges.at, curve.valueAt(edges.start), shapeAt(edges.start));
  for (const point of points) if (point.time > edges.start && point.time < edges.end) push(copied(point.time), point.value, point.shape);
  if (shapeAt(edges.end - EPSILON) === "linear") push(edges.atAfter - AUTOMATION_EDGE_SECONDS, curve.valueAt(edges.end), "linear");
  push(edges.atAfter, curve.valueAt(edges.at), shapeAt(edges.at));
  for (const point of points) if (point.time > edges.at) push(later(point.time), point.value, point.shape);
  return out;
}

function copyRange(project: Project, op: CopyRangeEdit, copies: ProjectEditCopies): void {
  const { range, atBeat: at, placement, as } = op;
  if (placement !== "insert") fail("invalid-operation", 'copyRange placement must be "insert".');
  if (!range || !validBeat(range.startBeat) || !validBeat(range.endBeat) || range.startBeat >= range.endBeat || !validBeat(at))
    fail("invalid-operation", "copyRange needs a range with 0 <= startBeat < endBeat and a non-negative atBeat.");
  if (typeof as !== "string" || !as || Object.hasOwn(copies, as)) fail("invalid-operation", "copyRange needs an `as` name unused in this request.");
  const { startBeat: start, endBeat: end } = range;
  if (at > start && at < end) fail("invalid-operation", "copyRange cannot insert inside the copied range.");

  const before = project.tempoMap;
  const length = end - start;
  const startSeconds = before.beatToSeconds(start);
  const endSeconds = before.beatToSeconds(end);
  const atSeconds = before.beatToSeconds(at);
  // A throwaway map answers where each old position lands; the Project takes it last.
  const tempoChanges = insertedTempo(before, start, end, at);
  const after = new TempoMap(before.initialBpm, tempoChanges);
  const copiedSeconds = (seconds: number) => after.beatToSeconds(at + before.secondsToBeat(seconds) - start);
  const laterSeconds = (seconds: number) => after.beatToSeconds(before.secondsToBeat(seconds) + length);
  const originals = project.tracks.flatMap((track) => track.clips.map((clip) => ({ trackId: track.id, clip })));

  const made: ProjectEditCopies[string] = [];
  for (const { trackId, clip } of originals) {
    const isMidi = clip.kind === "midi";
    const from = Math.max((isMidi ? start : startSeconds) - clip.time, 0);
    const to = Math.min((isMidi ? end : endSeconds) - clip.time, clip.duration);
    if (to - from <= (isMidi ? EPSILON : 0.5 / clip.sampleRate)) continue;
    const copy = project.duplicateClip(clip.id, clip.time);
    const whole = from <= EPSILON && to >= clip.duration - EPSILON;
    const placed = whole ? copy : project.resizeClip(copy.id, { start: copy.time + from, end: copy.time + to });
    const position = isMidi ? at + clip.time + from - start : copiedSeconds(clip.time + from);
    project.moveClip(placed.id, trackId, position);
    made.push({ from: clip.id, id: placed.id, trackId });
  }

  for (const { trackId, clip } of originals) {
    const boundary = clip.kind === "midi" ? at : atSeconds;
    const offset = boundary - clip.time;
    const minimum = clip.kind === "midi" ? EPSILON : 1 / clip.sampleRate;
    // A start within one frame of the boundary is on it: audio positions round to frames.
    if (offset >= minimum && clip.duration - offset < minimum) continue;
    if (offset >= clip.duration) continue;
    const moving = offset >= minimum ? project.splitClip(clip.id, offset)[1] : clip;
    if (moving !== clip)
      for (const list of Object.values(copies)) {
        const owner = list.find(({ id }) => id === clip.id);
        if (owner) list.push({ from: owner.from, id: moving.id, trackId });
      }
    project.moveClip(moving.id, trackId, moving.kind === "midi" ? moving.time + length : laterSeconds(moving.time));
  }

  const atAfter = after.beatToSeconds(at + length);
  for (const track of project.tracks)
    if (track.volumeAutomation.length)
      project.setVolumeAutomation(
        track.id,
        insertedAutomation(track.volumeAutomation, { start: startSeconds, end: endSeconds, at: atSeconds, atAfter }, copiedSeconds, laterSeconds),
      );

  const markers = project.markers.flatMap((marker) => {
    const beat = before.secondsToBeat(marker.time);
    const moved = beat >= at - EPSILON ? { time: laterSeconds(marker.time), name: marker.name } : marker;
    return beat >= start - EPSILON && beat < end - EPSILON ? [moved, { time: copiedSeconds(marker.time), name: marker.name }] : [moved];
  });
  project.setMarkers(markers);
  project.setTempoChanges(tempoChanges);
  copies[as] = made;
}

function resolveClip(project: Project, selector: EditClipSelector, copies: ProjectEditCopies): { track: ProjectTrack; clip: ProjectClip } {
  const id = selectedClipId(project, selector, copies);
  for (const track of project.tracks) {
    const clip = track.clips.find((item) => item.id === id);
    if (clip) return { track, clip };
  }
  return fail("clip-not-found", `Clip "${id}" does not exist.`);
}

/** Like `resolveClip`, for edits that work on any clip by ID: a Session slot clip counts. */
function resolveAnyClip(project: Project, selector: EditClipSelector, copies: ProjectEditCopies): ProjectClip {
  const id = selectedClipId(project, selector, copies);
  for (const track of project.tracks) {
    const clip = track.clips.find((item) => item.id === id);
    if (clip) return clip;
  }
  return findSlotClip(project, id!) ?? fail("clip-not-found", `Clip "${id}" does not exist.`);
}

function selectedClipId(project: Project, selector: EditClipSelector, copies: ProjectEditCopies): string | undefined {
  if (!selector || typeof selector !== "object") fail("invalid-operation", "Edit needs a clip selector.");
  const hasId = selector.clipId !== undefined;
  const hasCopy = selector.fromCopy !== undefined;
  if (hasId === hasCopy) fail("invalid-operation", "A clip selector needs exactly one of clipId and fromCopy.");
  if (hasId && (selector.trackId !== undefined || selector.trackName !== undefined || selector.name !== undefined))
    fail("invalid-operation", "A clipId selector cannot also filter by track or name.");
  let id = selector.clipId;
  if (hasCopy) {
    if (!Object.hasOwn(copies, selector.fromCopy!)) fail("clip-not-found", `No earlier copyRange is named "${selector.fromCopy}".`);
    const matches = copies[selector.fromCopy!].filter(({ id: copyId, trackId }) => {
      const track = project.tracks.find((item) => item.id === trackId);
      return (
        (selector.trackId === undefined || trackId === selector.trackId) &&
        (selector.trackName === undefined || track?.name === selector.trackName) &&
        (selector.name === undefined || project.clipName(copyId) === selector.name)
      );
    });
    if (!matches.length) fail("clip-not-found", `Copy "${selector.fromCopy}" has no clip on that track.`);
    if (matches.length > 1)
      fail("ambiguous-clip", `Copy "${selector.fromCopy}" matches ${matches.length} clips: ${matches.map((m) => m.id).join(", ")}.`);
    id = matches[0].id;
  }
  return id;
}

function moveClip(project: Project, op: MoveClipEdit, copies: ProjectEditCopies, moved: Map<string, number>, index: number): void {
  const { track, clip } = resolveClip(project, op.clip, copies);
  const hasAt = op.position?.atBeat !== undefined;
  const hasBy = op.position?.byBeats !== undefined;
  if (hasAt === hasBy) fail("invalid-operation", "moveClip position needs exactly one of atBeat and byBeats.");
  const tempo = project.tempoMap;
  const [startBeat] = clipBeats(tempo, clip);
  const beat = hasAt ? op.position.atBeat! : startBeat + op.position.byBeats!;
  if (!validBeat(beat)) fail("invalid-operation", "moveClip needs a finite target at or after beat 0.");
  const time = clip.kind === "midi" ? beat : tempo.beatToSeconds(beat);
  project.moveClip(clip.id, track.id, time);
  moved.set(clip.id, index);
}

function resizeClipOp(project: Project, op: ResizeClipEdit, copies: ProjectEditCopies, moved: Map<string, number>, index: number): void {
  const clip = resolveAnyClip(project, op.clip, copies);
  const { start, end } = op;
  if (
    (start === undefined && end === undefined) ||
    [start, end].some((edge) => edge !== undefined && (typeof edge !== "number" || !Number.isFinite(edge)))
  )
    fail("invalid-operation", "resizeClip needs a finite start, a finite end or both, in project beats.");
  const tempo = project.tempoMap;
  const unit = (beat: number | undefined) => (beat === undefined || clip.kind === "midi" ? beat : tempo.beatToSeconds(Math.max(0, beat)));
  project.resizeClip(clip.id, { start: unit(start), end: unit(end) });
  moved.set(clip.id, index);
}

function setClipSourceRangeOp(
  project: Project,
  op: SetClipSourceRangeEdit,
  copies: ProjectEditCopies,
  moved: Map<string, number>,
  index: number,
): void {
  const clip = resolveAnyClip(project, op.clip, copies);
  if (typeof op.start !== "number" || typeof op.end !== "number" || !Number.isFinite(op.start) || !Number.isFinite(op.end) || !(op.start < op.end))
    fail("invalid-operation", "setClipSourceRange needs finite start < end (content beats for MIDI, recording seconds for audio).");
  project.setClipSourceRange(clip.id, { start: op.start, end: op.end });
  moved.set(clip.id, index);
}

function setNoteVelocity(project: Project, op: SetNoteVelocityEdit, copies: ProjectEditCopies): void {
  const clip = resolveAnyClip(project, op.clip, copies);
  if (clip.kind !== "midi") fail("invalid-operation", "setNoteVelocity needs a MIDI clip.");
  if (typeof op.velocity !== "number" || !Number.isFinite(op.velocity) || op.velocity < 0 || op.velocity > 1)
    fail("invalid-operation", "setNoteVelocity needs a velocity from 0 to 1.");
  const midi = clip as Extract<ProjectClip, { kind: "midi" }>;
  if (!midi.midi.notes.value.some(({ id }) => id === op.noteId)) fail("note-not-found", `Clip "${clip.id}" has no note "${op.noteId}".`);
  midi.midi.edit((notes) => {
    notes.find(({ id }) => id === op.noteId)!.velocity = op.velocity;
  });
}

const NOTE_FIELDS = ["pitch", "start", "duration", "velocity"] as const;

/** Rejects a field of `value` that `allowed` does not list, naming the ones it does. */
function onlyFields(value: unknown, allowed: readonly string[], where: string): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return;
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown !== undefined) fail("invalid-operation", `${where} has unknown field "${unknown}"; allowed: ${allowed.join(", ")}.`);
}

function noteFieldProblem(note: Record<string, unknown>, field: (typeof NOTE_FIELDS)[number]): string | null {
  const value = note[field];
  if (value === undefined) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) return `${field} must be a finite number`;
  if (field === "pitch" && (!Number.isInteger(value) || value < 0 || value > 127)) return "pitch must be an integer 0 to 127";
  if (field === "velocity" && (value < 0 || value > 1)) return "velocity must be 0 to 1";
  if (field === "start" && value < 0) return "start must be 0 or more content beats";
  if (field === "duration" && value <= 0) return "duration must be more than 0 beats";
  return null;
}

function midiClipOf(project: Project, op: { type: string; clip: EditClipSelector }, copies: ProjectEditCopies) {
  const clip = resolveAnyClip(project, op.clip, copies);
  if (clip.kind !== "midi") fail("invalid-operation", `${op.type} needs a MIDI clip.`);
  return clip as Extract<ProjectClip, { kind: "midi" }>;
}

function noteList(op: { type: string }, key: string, value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.length === 0) fail("invalid-operation", `${op.type} needs a non-empty ${key} array.`);
  return value as Record<string, unknown>[];
}

function addNotesOp(project: Project, op: AddNotesEdit, copies: ProjectEditCopies, createdNotes: ProjectEditCreatedNotes): void {
  const clip = midiClipOf(project, op, copies);
  const notes = noteList(op, "notes", op.notes);
  for (const [index, note] of notes.entries()) {
    if (typeof note !== "object" || note === null)
      fail("invalid-operation", `addNotes notes[${index}] must be { pitch, start, duration, velocity? }.`);
    onlyFields(note, NOTE_FIELDS, `addNotes notes[${index}]`);
    for (const field of ["pitch", "start", "duration"] as const)
      if (note[field] === undefined) fail("invalid-operation", `addNotes notes[${index}] needs ${field}.`);
    for (const field of NOTE_FIELDS) {
      const problem = noteFieldProblem(note, field);
      if (problem) fail("invalid-operation", `addNotes notes[${index}]: ${problem}.`);
    }
  }
  const before = new Set(clip.midi.notes.value.map(({ id }) => id));
  const velocities = notes.map((note) => (note.velocity as number | undefined) ?? 0.8);
  clip.midi.edit((draft) => {
    for (const [index, note] of notes.entries())
      draft.push({ pitch: note.pitch as number, start: note.start as number, duration: note.duration as number, velocity: velocities[index] });
  });
  // The clip sorts its notes, so match each requested note to its new one; equal notes are interchangeable and keep push order.
  const fresh = clip.midi.notes.value.filter(({ id }) => !before.has(id));
  const ids = notes.map((note, index) => {
    const at = fresh.findIndex(
      (made) => made.pitch === note.pitch && made.start === note.start && made.duration === note.duration && made.velocity === velocities[index],
    );
    return fresh.splice(at, 1)[0].id;
  });
  createdNotes.push({ clipId: clip.id, ids });
}

function removeNotesOp(project: Project, op: RemoveNotesEdit, copies: ProjectEditCopies): void {
  const clip = midiClipOf(project, op, copies);
  const ids = noteList(op, "noteIds", op.noteIds) as unknown as unknown[];
  if (!ids.every((id) => typeof id === "string" && id)) fail("invalid-operation", "removeNotes noteIds must be note ID strings.");
  const present = new Set(clip.midi.notes.value.map(({ id }) => id));
  for (const id of ids) if (!present.has(id as string)) fail("note-not-found", `Clip "${clip.id}" has no note "${id}".`);
  clip.midi.edit((draft) => {
    for (let index = draft.length - 1; index >= 0; index--) if (ids.includes(draft[index].id)) draft.splice(index, 1);
  });
}

function editNotesOp(project: Project, op: EditNotesEdit, copies: ProjectEditCopies): void {
  const clip = midiClipOf(project, op, copies);
  const edits = noteList(op, "notes", op.notes);
  const present = new Set(clip.midi.notes.value.map(({ id }) => id));
  for (const [index, edit] of edits.entries()) {
    if (typeof edit !== "object" || edit === null || typeof edit.id !== "string") fail("invalid-operation", `editNotes notes[${index}] needs an id.`);
    onlyFields(edit, ["id", ...NOTE_FIELDS], `editNotes notes[${index}]`);
    if (!present.has(edit.id as string)) fail("note-not-found", `Clip "${clip.id}" has no note "${edit.id}".`);
    if (NOTE_FIELDS.every((field) => edit[field] === undefined))
      fail("invalid-operation", `editNotes notes[${index}] changes nothing: give pitch, start, duration or velocity.`);
    for (const field of NOTE_FIELDS) {
      const problem = noteFieldProblem(edit, field);
      if (problem) fail("invalid-operation", `editNotes notes[${index}]: ${problem}.`);
    }
  }
  clip.midi.edit((draft) => {
    for (const edit of edits) {
      const note = draft.find(({ id }) => id === edit.id)!;
      for (const field of NOTE_FIELDS) if (edit[field] !== undefined) note[field] = edit[field] as number;
    }
  });
}

/** The fields each edit type takes; anything else is rejected instead of silently ignored. */
const EDIT_FIELDS: Record<ProjectEditOperation["type"], readonly string[]> = {
  copyRange: ["range", "atBeat", "placement", "as"],
  moveClip: ["clip", "position"],
  resizeClip: ["clip", "start", "end"],
  setClipSourceRange: ["clip", "start", "end"],
  setNoteVelocity: ["clip", "noteId", "velocity"],
  addNotes: ["clip", "notes"],
  removeNotes: ["clip", "noteIds"],
  editNotes: ["clip", "notes"],
  renameClip: ["clip", "name"],
  rippleDelete: ["range", "crossfade"],
  makeClipUnique: ["clip"],
};

function checkFields(op: ProjectEditOperation): void {
  const type = op?.type;
  if (typeof type !== "string" || !Object.hasOwn(EDIT_FIELDS, type)) return;
  onlyFields(op, ["type", ...EDIT_FIELDS[type]], type);
  const nested = op as unknown as Record<string, unknown>;
  const range = nested.range as Record<string, unknown> | undefined;
  if (range && typeof range === "object")
    onlyFields(
      range,
      type === "rippleDelete" && "startSeconds" in range ? ["startSeconds", "endSeconds"] : ["startBeat", "endBeat"],
      `${type} range`,
    );
  onlyFields(nested.position, ["atBeat", "byBeats"], `${type} position`);
  onlyFields(nested.clip, ["clipId", "fromCopy", "trackId", "trackName", "name"], `${type} clip`);
}

function rippleDeleteOp(project: Project, op: RippleDeleteEdit): void {
  if (!timeRangeKind(op.range)) fail("invalid-operation", "Project ripple delete needs 0 <= start < end.");
  if (crossfadeSeconds(op.crossfade) === undefined)
    fail("invalid-operation", "Project ripple delete crossfade must be true, false or a non-negative number of seconds.");
  project.rippleDelete(op.range, op.crossfade === undefined ? undefined : { crossfade: op.crossfade });
}

/** Runs inside a Project edit, which rolls everything back when a step throws. */
export function runProjectEdits(project: Project, ops: readonly ProjectEditOperation[]): ProjectEditRun {
  if (!Array.isArray(ops)) throw new ProjectEditFailure("invalid-request", "applyEdits needs an ops array.");
  const copies: ProjectEditCopies = {};
  const createdNotes: ProjectEditCreatedNotes = [];
  const moved = new Map<string, number>();
  ops.forEach((op: ProjectEditOperation, index) => {
    try {
      checkFields(op);
      if (op?.type === "copyRange") copyRange(project, op, copies);
      else if (op?.type === "moveClip") moveClip(project, op, copies, moved, index);
      else if (op?.type === "resizeClip") resizeClipOp(project, op, copies, moved, index);
      else if (op?.type === "setClipSourceRange") setClipSourceRangeOp(project, op, copies, moved, index);
      else if (op?.type === "setNoteVelocity") setNoteVelocity(project, op, copies);
      else if (op?.type === "addNotes") addNotesOp(project, op, copies, createdNotes);
      else if (op?.type === "removeNotes") removeNotesOp(project, op, copies);
      else if (op?.type === "editNotes") editNotesOp(project, op, copies);
      else if (op?.type === "rippleDelete") rippleDeleteOp(project, op);
      else if (op?.type === "makeClipUnique") project.makeClipUnique(resolveClip(project, op.clip, copies).clip.id);
      else if (op?.type === "renameClip") project.setClipName(resolveAnyClip(project, op.clip, copies).id, op.name);
      else fail("invalid-operation", `Unknown edit type "${String((op as { type?: unknown } | null)?.type)}".`);
    } catch (error) {
      if (error instanceof ProjectEditFailure) throw new ProjectEditFailure(error.code, error.message, index);
      throw new ProjectEditFailure("edit-failed", error instanceof Error ? error.message : String(error), index);
    }
  });
  // Checked on the final arrangement, so clips moved together may pass through each other's old positions.
  for (const [clipId, index] of moved) {
    const track = project.tracks.find((item) => item.clips.some(({ id }) => id === clipId));
    const clip = track?.clips.find(({ id }) => id === clipId);
    if (!track || !clip) continue;
    const end = clip.time + clip.duration;
    const blocker = track.clips.find(
      (other) => other.id !== clipId && other.time < end - EPSILON && other.time + other.duration > clip.time + EPSILON,
    );
    if (blocker) throw new ProjectEditFailure("overlap", `Clip "${clipId}" would overlap clip "${blocker.id}".`, index);
  }
  return { copies, createdNotes };
}
