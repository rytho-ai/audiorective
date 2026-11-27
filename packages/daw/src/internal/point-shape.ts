/**
 * How a DAWproject point's `interpolation` and the model's `shape` relate. In the file a point's `interpolation` says how the value ARRIVES at that point
 * from the previous one (Bitwig Studio reads and writes it so; checked on track volume, clip gain and controller lanes). In the model a point's `shape`
 * says how the value LEAVES it toward the next point, and the last point's shape is always `"hold"`, because nothing follows it. Pure.
 */
export type PointShape = "linear" | "hold";

/** The `interpolation` to write for each point of a curve in time order: the previous point's `shape`; the first point, which nothing arrives at, writes its own. */
export function arrivalShapes(points: readonly Readonly<{ shape: PointShape }>[]): PointShape[] {
  return points.map((_, i) => points[Math.max(0, i - 1)].shape);
}

/** The model `shape` of each point of a curve in time order, from the `interpolation` the file gave each point: the next point's, and `"hold"` for the last. */
export function leavingShapes(arrival: readonly PointShape[]): PointShape[] {
  return arrival.map((_, i) => arrival[i + 1] ?? "hold");
}

/** A point as a file gives it: `shape` is the file's `interpolation`, how the value arrives. */
export type ArrivalPoint = Readonly<{
  /** Curve position in the caller units, seconds or beats from the containing XML Points. */
  time: number;
  /** Curve value in its declared unit, such as linear gain or controller value. */
  value: number;
  /** Interpolation arriving from the previous point, as encoded by the file. */
  shape: PointShape;
}>;

/**
 * Points in time order (equal times in file order) with one point per time. Another DAW writes a vertical step as two points at one time (Bitwig Studio writes
 * every segment `linear` and a hold as the value repeated at the next time); when the earlier of the pair only repeats the value before it, the pair is a hold,
 * and the later point stays with its arrival set to `"hold"`. Returns `undefined` for a step the model cannot hold: one that follows a ramp or opens the curve.
 */
export function foldSteps(points: readonly ArrivalPoint[]): ArrivalPoint[] | undefined {
  const out: ArrivalPoint[] = [];
  for (const point of points) {
    const last = out.at(-1);
    if (last && last.time === point.time) {
      const before = out.at(-2);
      if (!before || before.value !== last.value) return undefined;
      out.pop();
      out.push({ ...point, shape: "hold" });
    } else out.push(point);
  }
  return out;
}
