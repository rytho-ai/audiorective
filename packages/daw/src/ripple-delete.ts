import { AutomationCurve, type AutomationPoint } from "@audiorective/core/automation";
import type { AudioClip, Project, ProjectClip } from "./model";
import type { BeatRange, SecondsRange, TimeRange } from "./project-edits";
import { TempoMap, type TempoChange } from "./tempo-map";
import { unityClipEnvelope } from "./clip-envelope";
import { controllerPointsAfterDelete } from "./controller-lane";

const EPSILON = 1e-9;
/** Keeps a value step in a linear automation curve from becoming a long ramp. */
const AUTOMATION_EDGE_SECONDS = 0.001;

/** Which shape a valid `range` has, or `undefined` for anything that is not a valid range of either shape. */
export function timeRangeKind(range: TimeRange): "seconds" | "beats" | undefined {
  const value = range as Partial<BeatRange & SecondsRange> | null | undefined;
  const seconds = value?.startSeconds !== undefined || value?.endSeconds !== undefined;
  const beats = value?.startBeat !== undefined || value?.endBeat !== undefined;
  if (!value || typeof value !== "object" || seconds === beats) return undefined;
  const start = seconds ? value.startSeconds : value.startBeat;
  const end = seconds ? value.endSeconds : value.endBeat;
  if (typeof start !== "number" || typeof end !== "number" || !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start >= end)
    return undefined;
  return seconds ? "seconds" : "beats";
}

/** Both edges of a time range in seconds and beats, converted through `tempo`. */
export function resolveTimeRange(
  tempo: TempoMap,
  range: TimeRange,
): Readonly<{ startSeconds: number; endSeconds: number; startBeat: number; endBeat: number }> {
  const kind = timeRangeKind(range);
  if (!kind) throw new RangeError("Project ripple delete needs 0 <= start < end.");
  if (kind === "seconds") {
    const { startSeconds, endSeconds } = range as SecondsRange;
    return { startSeconds, endSeconds, startBeat: tempo.secondsToBeat(startSeconds), endBeat: tempo.secondsToBeat(endSeconds) };
  }
  const { startBeat, endBeat } = range as BeatRange;
  return { startBeat, endBeat, startSeconds: tempo.beatToSeconds(startBeat), endSeconds: tempo.beatToSeconds(endBeat) };
}

function removedTempo(tempo: TempoMap, start: number, end: number): TempoChange[] {
  const length = end - start;
  const steps = new Map<number, number>();
  for (const change of tempo.changes) if (change.beat < start) steps.set(change.beat, change.bpm);
  steps.set(start, tempo.bpmAtBeat(end));
  for (const change of tempo.changes) if (change.beat > end) steps.set(change.beat - length, change.bpm);
  let previous = tempo.initialBpm;
  const changes: TempoChange[] = [];
  for (const [beat, bpm] of [...steps].sort((a, b) => a[0] - b[0])) {
    if (bpm === previous) continue;
    changes.push({ beat, bpm });
    previous = bpm;
  }
  return changes;
}

function removedAutomation(points: readonly AutomationPoint[], start: number, end: number): AutomationPoint[] | undefined {
  if (!points.some((point) => point.time >= start)) return undefined;
  const length = end - start;
  const curve = new AutomationCurve(points);
  const shapeAt = (time: number) => points.findLast((point) => point.time <= time)?.shape ?? "hold";
  const out: AutomationPoint[] = [];
  const push = (time: number, value: number, shape: AutomationPoint["shape"]) => {
    if (time < 0 || (out.length && time <= out[out.length - 1].time)) return;
    out.push({ time, value, shape });
  };
  for (const point of points) if (point.time < start) push(point.time, point.value, point.shape);
  // A curve holds its first value before its first point, so a new earlier point must not redefine that stretch.
  if (!out.length && start > 0) push(Math.max(0, start - AUTOMATION_EDGE_SECONDS), curve.valueAt(start), "hold");
  if (shapeAt(start - EPSILON) === "linear") push(start - AUTOMATION_EDGE_SECONDS, curve.valueAt(start), "linear");
  push(start, curve.valueAt(end), shapeAt(end));
  for (const point of points) if (point.time > end) push(point.time - length, point.value, point.shape);
  return out;
}

const audioEnd = (clip: ProjectClip) => clip.time + clip.duration;

/** Extend the pieces meeting at `at` into each other by up to `crossfade` seconds, and fade them across the overlap. */
function crossfadeJoin(project: Project, left: AudioClip, right: AudioClip, crossfade: number, deleted: number): void {
  const rate = left.sampleRate;
  const available = (clip: AudioClip, side: "after" | "before") =>
    clip.stretch || clip.loop ? 0 : side === "after" ? clip.sourceLength - clip.sourceOffset - clip.duration : Math.min(clip.sourceOffset, clip.time);
  // Each side grows by at most half the deleted range (so no audio is heard twice) and by at most its own length (so the fade fits the clip).
  const half = Math.min(crossfade / 2, deleted / 2, left.duration, right.duration, available(left, "after"), available(right, "before"));
  const frames = Math.floor(half * rate + 1e-6);
  if (frames <= 0 || right.sampleRate !== rate) return;
  const amount = frames / rate;
  const joinedLeft = project.resizeClip(left.id, { end: audioEnd(left) + amount }) as AudioClip;
  const rightStart = right.time - amount;
  const joinedRight = project.resizeClip(right.id, { start: Math.abs(rightStart) < 0.5 / rate ? 0 : rightStart }) as AudioClip;
  const overlap = audioEnd(joinedLeft) - joinedRight.time;
  const fade = (clip: AudioClip, field: "fadeIn" | "fadeOut") => {
    const envelope = clip.envelope ?? unityClipEnvelope;
    const other = field === "fadeIn" ? "fadeOut" : "fadeIn";
    project.setAudioClipEnvelope(clip.id, {
      ...envelope,
      [field]: overlap,
      [other]: Math.min(envelope[other], Math.max(0, clip.duration - overlap)),
    });
  };
  fade(joinedLeft, "fadeOut");
  fade(joinedRight, "fadeIn");
}

/** Implements `Project.rippleDelete`. Validates before the first change. */
/** `crossfade: true` uses this many seconds: short enough to keep the cut tight, long enough to avoid a click. */
export const DEFAULT_CROSSFADE_SECONDS = 0.005;

/** `true` → the default length, `false` or omitted → no crossfade, a number → that many seconds; anything else is `undefined`. */
export function crossfadeSeconds(value: unknown): number | undefined {
  if (value === undefined || value === false) return 0;
  if (value === true) return DEFAULT_CROSSFADE_SECONDS;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function rippleDelete(project: Project, range: TimeRange, options?: { crossfade?: boolean | number }): void {
  const crossfade = crossfadeSeconds(options?.crossfade);
  if (crossfade === undefined) throw new RangeError("Project ripple delete crossfade must be true, false or a non-negative number of seconds.");
  const before = project.tempoMap;
  const { startSeconds, endSeconds, startBeat, endBeat } = resolveTimeRange(before, range);
  const lengthSeconds = endSeconds - startSeconds;
  const lengthBeats = endBeat - startBeat;

  for (const track of project.tracks) {
    const lefts: string[] = [];
    const rights: string[] = [];
    for (const clip of [...track.clips]) {
      const midi = clip.kind === "midi";
      const [from, to, length] = midi ? [startBeat, endBeat, lengthBeats] : [startSeconds, endSeconds, lengthSeconds];
      const epsilon = midi ? EPSILON : 0.5 / clip.sampleRate;
      const clipStart = clip.time;
      const clipEnd = clipStart + clip.duration;
      if (clipEnd <= from + epsilon) {
        if (!midi && Math.abs(clipEnd - from) <= epsilon) lefts.push(clip.id);
      } else if (clipStart >= to - epsilon) {
        project.moveClip(clip.id, track.id, Math.max(0, clipStart - length));
        if (!midi) rights.push(clip.id);
      } else if (clipStart >= from - epsilon && clipEnd <= to + epsilon) {
        project.removeClip(clip.id);
      } else if (clipStart < from - epsilon && clipEnd > to + epsilon) {
        const [leftPart, rightPart] = project.splitClip(clip.id, from - clipStart);
        const trimmed = project.resizeClip(rightPart.id, { start: to });
        project.moveClip(trimmed.id, track.id, Math.max(0, to - length));
        if (!midi) {
          lefts.push(leftPart.id);
          rights.push(trimmed.id);
        }
      } else if (clipStart < from - epsilon) {
        project.resizeClip(clip.id, { end: from });
        if (!midi) lefts.push(clip.id);
      } else {
        const trimmed = project.resizeClip(clip.id, { start: to });
        project.moveClip(trimmed.id, track.id, Math.max(0, to - length));
        if (!midi) rights.push(clip.id);
      }
    }
    if (crossfade > 0 && lefts.length && rights.length) {
      const find = (ids: string[], pick: (clip: AudioClip) => boolean) =>
        project.tracks
          .find((item) => item.id === track.id)!
          .clips.find((clip): clip is AudioClip => clip.kind === "audio" && ids.includes(clip.id) && pick(clip));
      const left = find(lefts, (clip) => Math.abs(audioEnd(clip) - startSeconds) <= 0.5 / clip.sampleRate);
      const right = find(rights, (clip) => Math.abs(clip.time - startSeconds) <= 0.5 / clip.sampleRate);
      if (left && right) crossfadeJoin(project, left, right, crossfade, lengthSeconds);
    }
  }

  // Only what changes is written, so a later unrelated tempo, marker or curve edit does not block undoing this one.
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const tempoChanges = removedTempo(before, startBeat, endBeat);
  const markers = project.markers.flatMap((marker) =>
    marker.time >= endSeconds ? [{ ...marker, time: marker.time - lengthSeconds }] : marker.time >= startSeconds ? [] : [marker],
  );
  if (!same(markers, project.markers)) project.setMarkers(markers);
  for (const track of project.tracks) {
    const points = track.volumeAutomation.length ? removedAutomation(track.volumeAutomation, startSeconds, endSeconds) : undefined;
    if (points && !same(points, track.volumeAutomation)) project.setVolumeAutomation(track.id, points);
  }
  for (const track of project.tracks)
    for (const lane of track.controllerLanes) {
      const points = controllerPointsAfterDelete(lane.expression, lane.points, startBeat, endBeat);
      if (!same(points, lane.points)) project.setControllerLane(track.id, { ...lane, points });
    }
  if (!same(tempoChanges, before.changes)) project.setTempoChanges(tempoChanges);
}
