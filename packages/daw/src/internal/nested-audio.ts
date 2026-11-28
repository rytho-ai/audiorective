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

export type WarpPoint = Readonly<{
  /** Position in the containing clip content unit, beats or seconds as stated by the file. */
  time: number;
  /** Corresponding position in seconds of the original audio recording. */
  contentTime: number;
}>;

/**
 * The most the warp may differ from the timeline, in seconds of audio: 1.5 frames of the recording (the slack the reader already allows a
 * file written by another application) so the float32 rounding Bitwig puts on beat values (a 4 s clip at 100 BPM is written as
 * 6.6666669845581055 beats) is accepted, while the smallest real stretch (a few thousandths of a percent over a clip) is not.
 */
export const warpTolerance = (sampleRate: number): number => 1.5 / sampleRate;

/** Rounding noise a file's own numbers carry (a float32 beat count is exact to about 6e-8 of its size), in seconds of audio: below it a warp is always the identity. */
const WARP_NOISE_SECONDS = 2e-6;
/** The most a warp may differ from the timeline per second of audio before it is a stretch rather than rounding: a relative bound, so a short clip is judged by its slope too. */
const WARP_SLOPE = 1e-5;
/** The difference between audio seconds and timeline seconds that still counts as the identity over `timeline` seconds: `tolerance` for a long clip, a slope bound for a short one. */
const identityBound = (tolerance: number, timeline: number): number =>
  Math.min(tolerance, Math.max(WARP_NOISE_SECONDS, WARP_SLOPE * Math.abs(timeline)));

export type WarpVerdict =
  | {
      /** True when the warp preserves original playback speed within the frame and slope tolerances. */
      identity: true;
      /** Recording-second position at the requested window start when the warp is effectively identity. */
      contentStart: number;
    }
  | {
      /** True when the warp preserves original playback speed within the frame and slope tolerances. */
      identity: false;
      /** Failure category: outside lacks valid covering points, while speed changes the recording playback speed. */
      reason: "outside";
      /** Recording seconds covered by the window; omitted when valid covering warp points are unavailable. */
      contentSpan?: undefined;
      /** Project seconds covered by the window; omitted when valid covering warp points are unavailable. */
      timelineSpan?: undefined;
    }
  | {
      /** True when the warp preserves original playback speed within the frame and slope tolerances. */
      identity: false;
      /** Failure category: outside lacks valid covering points, while speed changes the recording playback speed. */
      reason: "speed";
      /** Recording seconds covered by the window; omitted when valid covering warp points are unavailable. */
      contentSpan: number;
      /** Project seconds covered by the window; omitted when valid covering warp points are unavailable. */
      timelineSpan: number;
    };

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
 * The audio second at the clip's local position `local`. A clip edge that lies within `tolerance` seconds of the first or last warp point takes that point's
 * audio second: a warp written to end a fraction of a frame short of the clip's end (the stretch ratio is exact, the clip's length a whole number of
 * frames) still covers the clip, and its end is the audio the warp states. Elsewhere it is `contentAt`.
 */
function contentAtEdge(
  points: readonly WarpPoint[],
  input: { from: number; start: number; elapsed: (position: number) => number; tolerance: number },
  local: number,
): number | undefined {
  const { from, start, elapsed, tolerance } = input;
  const origin = elapsed(start);
  const here = elapsed(start + local) - origin;
  for (const point of [points[0], points[points.length - 1]]) {
    const position = start + point.time - from;
    if (position >= 0 && Math.abs(elapsed(position) - origin - here) <= tolerance) return point.contentTime;
  }
  return contentAt(points, from + local, 1e-9);
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
  const edge = { from, start, elapsed, tolerance };
  const base = contentAtEdge(points, edge, 0);
  const end = contentAtEdge(points, edge, length);
  if (base === undefined || end === undefined) return { identity: false, reason: "outside" };
  const locals = new Set<number>([0, length]);
  for (const point of points) if (point.time > from && point.time < from + length) locals.add(point.time - from);
  for (const position of tempoBreaks) if (position > start && position < start + length) locals.add(position - start);
  const origin = elapsed(start);
  for (const local of locals) {
    const timeline = elapsed(start + local) - origin;
    const content = (local === 0 || local === length ? contentAtEdge(points, edge, local) : contentAt(points, from + local, slack))! - base;
    if (Math.abs(content - timeline) > identityBound(tolerance, timeline))
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
export type WarpKnot = Readonly<{
  /** Non-negative output seconds from the clip start. */
  output: number;
  /** Corresponding seconds in the original audio recording. */
  content: number;
}>;

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
  // `tolerance` is half a frame here; an edge may sit a frame and a half from the warp's last point (a clip's length is a whole number of frames).
  const edge = { from, start, elapsed, tolerance: 3 * tolerance };
  for (const local of [...locals].sort((a, b) => a - b)) {
    const content = local === 0 || local === length ? contentAtEdge(points, edge, local) : contentAt(points, from + local, 1e-9);
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

/**
 * The exact stretch ratio (timeline seconds per second of audio) of a clip whose window lies on one warp segment, from the warp's own two points
 * rather than from the clip's whole frames: a clip's length and window are whole frames, so their quotient is the ratio only to half a frame over
 * the window, and a ratio read from it and written again would drift with every edit. Undefined when the window spans more than one segment.
 */
export function exactWarpRatio(input: {
  points: readonly WarpPoint[];
  from: number;
  length: number;
  start: number;
  elapsed: (position: number) => number;
}): number | undefined {
  const { points, from, length, start, elapsed } = input;
  const middle = from + length / 2;
  const at = points.findIndex((point, i) => i + 1 < points.length && point.time <= middle && points[i + 1].time >= middle);
  if (at < 0) return undefined;
  const a = points[at];
  const b = points[at + 1];
  // The tempo is steady across the window (a change inside it would be a knot of its own), so one beat of the file's unit lasts a fixed time there.
  const perUnit = (elapsed(start + length) - elapsed(start)) / length;
  const ratio = ((b.time - a.time) * perUnit) / (b.contentTime - a.contentTime);
  return Number.isFinite(ratio) && ratio > 0 ? ratio : undefined;
}
