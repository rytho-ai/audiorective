export type TakeAnchor = Readonly<{
  /** Absolute AudioContext seconds captured when anchoring the take; finite and non-negative. */
  audioTime: number;
  /** Project position in seconds corresponding to audioTime, before input-latency correction. */
  projectTime: number;
  /** True while project time advances with the audio clock; false anchors a paused take to one project position. */
  advancing: boolean;
}>;

/** Throws unless `audioTime` is a finite, non-negative AudioContext time. */
export function assertTakeAudioTime(audioTime: number): void {
  if (!Number.isFinite(audioTime) || audioTime < 0) throw new RangeError("Workspace take anchor needs a finite non-negative audio time.");
}

/**
 * Project time of a take that started at `take.startTime` on the audio clock. Positive input latency
 * moves the take earlier; use preroll when this would cross project zero.
 */
export function placeTake(anchor: TakeAnchor, take: Readonly<{ startTime: number }>, inputLatencySeconds = 0): number {
  if (
    ![anchor.audioTime, anchor.projectTime, take.startTime, inputLatencySeconds].every(Number.isFinite) ||
    anchor.audioTime < 0 ||
    take.startTime < 0 ||
    inputLatencySeconds < 0
  )
    throw new RangeError("Workspace take placement needs a valid anchor, take start and non-negative input latency.");
  const time = anchor.projectTime + (anchor.advancing ? take.startTime - anchor.audioTime : 0) - inputLatencySeconds;
  if (time < 0) throw new RangeError("Workspace take placement crosses project zero; use preroll or a smaller latency correction.");
  return time;
}
