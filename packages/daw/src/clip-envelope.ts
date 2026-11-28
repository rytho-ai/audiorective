/** Linear gain and edge fades measured in clip-local seconds. */
export type ClipEnvelope = Readonly<{
  /** Finite linear gain, 0..∞ with 1 for unity; the neutral envelope uses 1. */
  gain: number;
  /** Non-negative fade-in duration in clip-local seconds; 0 disables it and both fades must fit the clip. */
  fadeIn: number;
  /** Non-negative fade-out duration in clip-local seconds; 0 disables it and both fades must fit the clip. */
  fadeOut: number;
}>;

/** The neutral envelope: gain 1 and no fades. `normalizeClipEnvelope` returns this exact object for neutral input, so `=== unityClipEnvelope` tests for it. */
export const unityClipEnvelope: ClipEnvelope = Object.freeze({ gain: 1, fadeIn: 0, fadeOut: 0 });

/**
 * Validate and copy settings without taking ownership of a source or track. `duration` is the clip's length in seconds (0 or more); gain must be 0 or more
 * and `fadeIn + fadeOut` must fit in it, else `RangeError`.
 */
export function normalizeClipEnvelope(envelope: ClipEnvelope, duration: number): ClipEnvelope {
  const { gain, fadeIn, fadeOut } = envelope;
  if (
    !Number.isFinite(duration) ||
    duration < 0 ||
    ![gain, fadeIn, fadeOut].every((value) => Number.isFinite(value) && value >= 0) ||
    fadeIn + fadeOut > duration + 1e-9
  )
    throw new RangeError("Clip gain must be non-negative and fades must fit its duration.");
  return gain === 1 && fadeIn === 0 && fadeOut === 0 ? unityClipEnvelope : Object.freeze({ gain, fadeIn, fadeOut });
}

/** The linear gain (0 or more) of the envelope at `seconds` into a clip `duration` seconds long; `seconds` is clamped to `0 … duration`. */
export function clipGainAt(envelope: ClipEnvelope, duration: number, seconds: number): number {
  const t = Math.max(0, Math.min(duration, seconds));
  return envelope.gain * Math.min(1, envelope.fadeIn ? t / envelope.fadeIn : 1, envelope.fadeOut ? (duration - t) / envelope.fadeOut : 1);
}
