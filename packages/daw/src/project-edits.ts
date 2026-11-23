import { AutomationCurve, type AutomationPoint } from "@audiorective/core/automation";
import type { Project, ProjectClip, ProjectMarker, ProjectTrack, TrackKind } from "./model";
import { TempoMap, type TempoChange } from "./tempo-map";

/** One state of a Project. Opaque: compare it for equality and pass it back as `expectedVersion`. */
export type ProjectVersion = string & { readonly __projectVersion: unique symbol };
/** A half-open range of project beats: `startBeat` is inside, `endBeat` is not. */
export type BeatRange = Readonly<{ startBeat: number; endBeat: number }>;

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
}>;

export type ProjectOverview = Readonly<{
  version: ProjectVersion;
  title: string;
  bpm: number;
  signature: readonly [number, number];
  tempoChanges: readonly TempoChange[];
  markers: readonly ProjectMarker[];
  tracks: readonly Readonly<{ id: string; name: string; kind: TrackKind; clips: readonly ProjectClipSummary[] }>[];
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
  /** Beats follow the tempo map at the time this step runs. Landing on another clip of the track rejects the request. */
  position: Readonly<{ atBeat: number; byBeats?: never }> | Readonly<{ byBeats: number; atBeat?: never }>;
}>;
export type SetNoteVelocityEdit = Readonly<{
  type: "setNoteVelocity";
  clip: EditClipSelector;
  noteId: string;
  /** 0 to 1. */
  velocity: number;
}>;
export type RenameClipEdit = Readonly<{ type: "renameClip"; clip: EditClipSelector; name: string }>;
/** One JSON-serializable step of `project.applyEdits`. */
export type ProjectEditOperation = CopyRangeEdit | MoveClipEdit | SetNoteVelocityEdit | RenameClipEdit;

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
      changed: readonly string[];
      removed: readonly string[];
      /** Per `as` name: which clip each copy came from. */
      copies: Readonly<Record<string, readonly Readonly<{ from: string; id: string; trackId: string }>[]>>;
    }
  | { status: "conflict"; version: ProjectVersion; reason: string }
  | { status: "rejected"; version: ProjectVersion; code: ProjectEditRejection; reason: string; opIndex?: number }
>;

export type ProjectEditCopies = Record<string, { from: string; id: string; trackId: string }[]>;

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
    const placed = whole ? copy : project.trimClip(copy.id, from, to);
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
  for (const track of project.tracks) {
    const clip = track.clips.find((item) => item.id === id);
    if (clip) return { track, clip };
  }
  return fail("clip-not-found", `Clip "${id}" does not exist.`);
}

function moveClip(project: Project, op: MoveClipEdit, copies: ProjectEditCopies): void {
  const { track, clip } = resolveClip(project, op.clip, copies);
  const hasAt = op.position?.atBeat !== undefined;
  const hasBy = op.position?.byBeats !== undefined;
  if (hasAt === hasBy) fail("invalid-operation", "moveClip position needs exactly one of atBeat and byBeats.");
  const tempo = project.tempoMap;
  const [startBeat] = clipBeats(tempo, clip);
  const beat = hasAt ? op.position.atBeat! : startBeat + op.position.byBeats!;
  if (!validBeat(beat)) fail("invalid-operation", "moveClip needs a finite target at or after beat 0.");
  const time = clip.kind === "midi" ? beat : tempo.beatToSeconds(beat);
  const end = time + clip.duration;
  const blocker = track.clips.find((other) => other.id !== clip.id && other.time < end - EPSILON && other.time + other.duration > time + EPSILON);
  if (blocker) fail("overlap", `Clip "${clip.id}" would overlap clip "${blocker.id}".`);
  project.moveClip(clip.id, track.id, time);
}

function setNoteVelocity(project: Project, op: SetNoteVelocityEdit, copies: ProjectEditCopies): void {
  const { clip } = resolveClip(project, op.clip, copies);
  if (clip.kind !== "midi") fail("invalid-operation", "setNoteVelocity needs a MIDI clip.");
  if (typeof op.velocity !== "number" || !Number.isFinite(op.velocity) || op.velocity < 0 || op.velocity > 1)
    fail("invalid-operation", "setNoteVelocity needs a velocity from 0 to 1.");
  const midi = clip as Extract<ProjectClip, { kind: "midi" }>;
  if (!midi.midi.notes.value.some(({ id }) => id === op.noteId)) fail("note-not-found", `Clip "${clip.id}" has no note "${op.noteId}".`);
  midi.midi.edit((notes) => {
    notes.find(({ id }) => id === op.noteId)!.velocity = op.velocity;
  });
}

/** Runs inside a Project edit, which rolls everything back when a step throws. */
export function runProjectEdits(project: Project, ops: readonly ProjectEditOperation[]): ProjectEditCopies {
  if (!Array.isArray(ops)) throw new ProjectEditFailure("invalid-request", "applyEdits needs an ops array.");
  const copies: ProjectEditCopies = {};
  ops.forEach((op: ProjectEditOperation, index) => {
    try {
      if (op?.type === "copyRange") copyRange(project, op, copies);
      else if (op?.type === "moveClip") moveClip(project, op, copies);
      else if (op?.type === "setNoteVelocity") setNoteVelocity(project, op, copies);
      else if (op?.type === "renameClip") project.setClipName(resolveClip(project, op.clip, copies).clip.id, op.name);
      else fail("invalid-operation", `Unknown edit type "${String((op as { type?: unknown } | null)?.type)}".`);
    } catch (error) {
      if (error instanceof ProjectEditFailure) throw new ProjectEditFailure(error.code, error.message, index);
      throw new ProjectEditFailure("edit-failed", error instanceof Error ? error.message : String(error), index);
    }
  });
  return copies;
}
