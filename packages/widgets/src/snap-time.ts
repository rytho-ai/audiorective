/** Shared nearest-point rule for selection and note gestures; earlier point wins ties. */
export function snapTime(time: number, points: readonly number[] | undefined, duration: number): number {
  if (!points?.length) return time;
  let lo = 0,
    hi = points.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (points[mid] < time) lo = mid + 1;
    else hi = mid;
  }
  const a = points[Math.max(0, lo - 1)],
    b = points[Math.min(points.length - 1, lo)];
  return Math.max(0, Math.min(duration, Math.abs(a - time) <= Math.abs(b - time) ? a : b));
}

/** Normalize once when a grid changes; gesture updates only perform binary search. */
export function prepareGrid(grid?: Readonly<{ beats: readonly number[]; downbeats: readonly number[] }>) {
  return {
    beat:
      grid?.beats
        .filter(Number.isFinite)
        .slice()
        .sort((a, b) => a - b) ?? [],
    downbeat:
      grid?.downbeats
        .filter(Number.isFinite)
        .slice()
        .sort((a, b) => a - b) ?? [],
  };
}
