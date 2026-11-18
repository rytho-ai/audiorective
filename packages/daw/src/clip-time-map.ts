import { AutomationCurve, type AutomationPoint } from "@audiorective/core/automation";

/** A warp marker mapping a source frame to a stretched output frame; structurally the same as the player's anchor. */
export type ClipStretchAnchor = Readonly<{ sourceFrame: number; outputFrame: number }>;

export function normalizeClipAnchors(
  anchors: readonly ClipStretchAnchor[],
  sourceFrames: number,
  outputFrames: number,
): readonly ClipStretchAnchor[] {
  const error = () => new RangeError("Project clip warp needs strictly increasing interior source and output frames.");
  if (!Array.isArray(anchors)) throw error();
  let source = 0;
  let output = 0;
  return Object.freeze(
    Array.from(anchors, (point: ClipStretchAnchor) => {
      if (
        !point ||
        !Number.isSafeInteger(point.sourceFrame) ||
        !Number.isSafeInteger(point.outputFrame) ||
        point.sourceFrame <= source ||
        point.sourceFrame >= sourceFrames ||
        point.outputFrame <= output ||
        point.outputFrame >= outputFrames
      )
        throw error();
      source = point.sourceFrame;
      output = point.outputFrame;
      return Object.freeze({ sourceFrame: source, outputFrame: output });
    }),
  );
}

function interpolate(points: readonly [number, number][], time: number, axis: 0 | 1): number {
  let low = 1;
  let high = points.length - 1;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (time <= points[mid][axis]) high = mid;
    else low = mid + 1;
  }
  const a = points[low - 1];
  const b = points[low];
  const other = axis === 0 ? 1 : 0;
  const length = b[axis] - a[axis];
  return length ? a[other] + ((time - a[axis]) / length) * (b[other] - a[other]) : 0;
}

/** A piecewise-linear map in clip-local seconds with implicit endpoints. */
export class ClipTimeMap {
  private readonly points: readonly [number, number][];

  constructor(
    readonly sourceDuration: number,
    readonly outputDuration: number,
    anchors: readonly ClipStretchAnchor[],
    sampleRate: number,
  ) {
    this.points = [
      [0, 0],
      ...anchors.map(({ sourceFrame, outputFrame }): [number, number] => [sourceFrame / sampleRate, outputFrame / sampleRate]),
      [sourceDuration, outputDuration],
    ];
  }

  sourceToOutput(seconds: number): number {
    return interpolate(this.points, seconds, 0);
  }

  outputToSource(seconds: number): number {
    return interpolate(this.points, seconds, 1);
  }

  /** Insert a gain point at each warp slope change so linear ramps stay source-relative. */
  projectGain(points: readonly AutomationPoint[], sourceStart: number): readonly AutomationPoint[] {
    const curve = new AutomationCurve(points);
    const end = sourceStart + this.sourceDuration;
    const times = new Set(this.points.map(([time]) => time + sourceStart));
    for (const { time } of curve.value) if (time > sourceStart && time < end) times.add(time);
    const projected: AutomationPoint[] = [];
    let index = 0;
    for (const time of [...times].sort((a, b) => a - b)) {
      while (index + 1 < curve.value.length && curve.value[index + 1].time <= time) index++;
      const point = curve.value[index];
      const outputTime = time === end ? this.outputDuration : this.sourceToOutput(time - sourceStart);
      const next: AutomationPoint = { time: outputTime, value: curve.valueAt(time), shape: time < point.time ? "hold" : point.shape };
      // Two source values can round to the same output second at extreme scales.
      if (projected.at(-1)?.time === next.time) projected[projected.length - 1] = next;
      else projected.push(next);
    }
    return projected;
  }
}
