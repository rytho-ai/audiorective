import type { Element } from "@xmldom/xmldom";

/**
 * Bitwig Studio writes an audio clip as an outer `Clip` (place, length, name, fades) whose content is a `Clips` holding one inner `Clip`
 * (`contentTimeUnit="seconds"`, the window into the file in `playStart` / `playStop`) with the `Audio` inside it, directly, in a `Lanes` with a
 * gain `Points`, or in a `Warps` with `Warp` points. The reader turns the clips whose warp leaves the audio at its original speed into
 * ordinary audio clips and keeps the elements here so a save can write an edit back into the same form.
 */
export type NestedAudioLink = {
  /** The inner Clip. */
  inner: Element;
  /** The Audio element, wherever it sits (the inner Clip, a Lanes or a Warps). */
  audio: Element;
  /** The Warps element when the file has one; its points are the identity for the song's tempo map. */
  warps?: Element;
  /** The gain Points of the clip's content lanes, flat (every value equal). */
  gain?: Element;
};

export type WarpPoint = Readonly<{ time: number; contentTime: number }>;

/**
 * The most the warp may differ from the timeline, in seconds of audio: 1.5 frames of the recording (the slack the reader already allows a
 * file written by another application) so the float32 rounding Bitwig puts on beat values (a 4 s clip at 100 BPM is written as
 * 6.6666669845581055 beats) is accepted, while the smallest real stretch (a few thousandths of a percent over a clip) is not.
 */
export const warpTolerance = (sampleRate: number): number => 1.5 / sampleRate;

export type WarpVerdict =
  | { identity: true; contentStart: number }
  | { identity: false; reason: "outside"; contentSpan?: undefined; timelineSpan?: undefined }
  | { identity: false; reason: "speed"; contentSpan: number; timelineSpan: number };

export function readWarpPoints(warps: Element): WarpPoint[] {
  const points: WarpPoint[] = [];
  for (let node = warps.firstChild; node; node = node.nextSibling) {
    if (node.nodeType !== 1 || (node as Element).tagName !== "Warp") continue;
    const element = node as Element;
    points.push({ time: Number(element.getAttribute("time")), contentTime: Number(element.getAttribute("contentTime")) });
  }
  return points.sort((a, b) => a.time - b.time);
}

/** Audio seconds at warp time `at`, linear between the points; undefined outside them (by `slack` of timeline units). */
function contentAt(points: readonly WarpPoint[], at: number, slack: number): number | undefined {
  const first = points[0];
  const last = points[points.length - 1];
  if (at < first.time - slack || at > last.time + slack) return undefined;
  if (at <= first.time) return first.contentTime;
  if (at >= last.time) return last.contentTime;
  let high = 1;
  while (points[high].time < at) high++;
  const a = points[high - 1];
  const b = points[high];
  return a.contentTime + ((at - a.time) / (b.time - a.time)) * (b.contentTime - a.contentTime);
}

/**
 * Whether `points` (warp time in the clip's own unit, audio in seconds) play the audio at its original speed over the clip's window
 * `[from, from + length]` when the clip starts at `start` on the project's timeline. `elapsed(position)` is the timeline seconds from the
 * project timeline origin to `position`, in the clip's unit, so the tempo map is applied: audio seconds must advance exactly as timeline
 * seconds do at every point where either the warp or the tempo changes slope, which are the only points where the difference between
 * two piecewise-linear maps can peak. `tempoBreaks` are the positions (clip unit) where the tempo changes.
 */
export function warpVerdict(input: {
  points: readonly WarpPoint[];
  from: number;
  length: number;
  start: number;
  elapsed: (position: number) => number;
  tempoBreaks: readonly number[];
  tolerance: number;
}): WarpVerdict {
  const { points, from, length, start, elapsed, tempoBreaks, tolerance } = input;
  if (
    points.length < 2 ||
    points.some((point, i) => !Number.isFinite(point.time) || !Number.isFinite(point.contentTime) || (i > 0 && point.time <= points[i - 1].time))
  )
    return { identity: false, reason: "outside" };
  const slack = 1e-9;
  const base = contentAt(points, from, slack);
  const end = contentAt(points, from + length, slack);
  if (base === undefined || end === undefined) return { identity: false, reason: "outside" };
  const locals = new Set<number>([0, length]);
  for (const point of points) if (point.time > from && point.time < from + length) locals.add(point.time - from);
  for (const position of tempoBreaks) if (position > start && position < start + length) locals.add(position - start);
  const origin = elapsed(start);
  for (const local of locals) {
    const timeline = elapsed(start + local) - origin;
    const content = contentAt(points, from + local, slack)! - base;
    if (Math.abs(content - timeline) > tolerance)
      return { identity: false, reason: "speed", contentSpan: end - base, timelineSpan: elapsed(start + length) - origin };
  }
  return { identity: true, contentStart: base };
}

/** The warp points that play audio from `contentStart` at its original speed over `[from, from + length]`: one per tempo change in the window. */
export function identityWarpPoints(input: {
  from: number;
  length: number;
  start: number;
  contentStart: number;
  elapsed: (position: number) => number;
  tempoBreaks: readonly number[];
}): WarpPoint[] {
  const { from, length, start, contentStart, elapsed, tempoBreaks } = input;
  const locals = [0, ...tempoBreaks.filter((position) => position > start && position < start + length).map((position) => position - start), length];
  const origin = elapsed(start);
  return locals.map((local) => ({ time: from + local, contentTime: contentStart + elapsed(start + local) - origin }));
}

/** A point of a stretched clip's time map: `output` seconds from the clip's start, `content` seconds in the recording. */
export type WarpKnot = Readonly<{ output: number; content: number }>;

/**
 * The time map of a clip whose warp stretches its audio, as knots in seconds: the first and last knot are the clip's edges, every one between is
 * a place where the speed changes, either at a warp marker or at a tempo change of the song (a warp that is steady in beats is not steady in
 * seconds across a tempo change). Knots that lie on the line between their neighbours (within `tolerance` seconds of audio) are dropped.
 * Undefined when the audio would run backwards or stand still.
 */
export function warpKnots(input: {
  points: readonly WarpPoint[];
  from: number;
  length: number;
  start: number;
  elapsed: (position: number) => number;
  tempoBreaks: readonly number[];
  tolerance: number;
}): WarpKnot[] | undefined {
  const { points, from, length, start, elapsed, tempoBreaks, tolerance } = input;
  const locals = new Set<number>([0, length]);
  for (const point of points) if (point.time > from && point.time < from + length) locals.add(point.time - from);
  for (const position of tempoBreaks) if (position > start && position < start + length) locals.add(position - start);
  const origin = elapsed(start);
  const all: WarpKnot[] = [];
  const last = Math.max(...locals);
  for (const local of [...locals].sort((a, b) => a - b)) {
    const content = contentAt(points, from + local, 1e-9);
    if (content === undefined) return undefined;
    const knot = { output: elapsed(start + local) - origin, content };
    // A warp marker and a tempo change at the same beat are one place: the file states the marker's beat to 12 digits and the tempo change is
    // exact, so the two knots differ by rounding noise only. The later one is dropped (the clip's end is kept over a marker that touches it).
    const previous = all[all.length - 1];
    if (previous && knot.output - previous.output <= tolerance && Math.abs(knot.content - previous.content) <= tolerance) {
      if (local === last && all.length > 1) all[all.length - 1] = knot;
      continue;
    }
    all.push(knot);
  }
  for (let i = 1; i < all.length; i++) if (!(all[i].output > all[i - 1].output) || !(all[i].content > all[i - 1].content)) return undefined;
  const kept: WarpKnot[] = [all[0]];
  for (let i = 1; i < all.length - 1; i++) {
    const a = kept[kept.length - 1];
    const b = all[i + 1];
    const line = a.content + ((all[i].output - a.output) / (b.output - a.output)) * (b.content - a.content);
    if (Math.abs(all[i].content - line) > tolerance) kept.push(all[i]);
  }
  kept.push(all[all.length - 1]);
  return kept;
}
