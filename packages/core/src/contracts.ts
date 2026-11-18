/** A consumer-owned audio event that a scheduler may revoke after a transport or edit change. */
export interface CancellableEvent {
  cancel(): void;
  onEnded(listener: () => void): void;
}

/** Converts between beats and absolute audio-context time. */
export type BeatTiming = Readonly<{
  beatToTime(beat: number): number;
  timeToBeat(time: number): number;
}>;
