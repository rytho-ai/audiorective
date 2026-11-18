/** Linear gain and edge fades measured in clip-local seconds. */
export type ClipEnvelope = Readonly<{ gain: number; fadeIn: number; fadeOut: number }>;

export const unityClipEnvelope: ClipEnvelope = Object.freeze({ gain: 1, fadeIn: 0, fadeOut: 0 });

/** Validate and copy settings without taking ownership of a source or track. */
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

/** A scheduled segment continues the original clip envelope at its local offset. */
export function clipGainAt(envelope: ClipEnvelope, duration: number, seconds: number): number {
  const t = Math.max(0, Math.min(duration, seconds));
  return envelope.gain * Math.min(1, envelope.fadeIn ? t / envelope.fadeIn : 1, envelope.fadeOut ? (duration - t) / envelope.fadeOut : 1);
}

export function scheduleClipEnvelope(
  target: Pick<AudioParam, "setValueAtTime" | "linearRampToValueAtTime">,
  envelope: ClipEnvelope,
  duration: number,
  window: Readonly<{ when: number; offset: number; length: number }>,
): void {
  const { when, offset, length } = window;
  const end = Math.min(duration, offset + length);
  target.setValueAtTime(clipGainAt(envelope, duration, offset), when);
  if (envelope.fadeIn > offset && envelope.fadeIn < end) target.linearRampToValueAtTime(envelope.gain, when + envelope.fadeIn - offset);
  const fadeOutStart = duration - envelope.fadeOut;
  if (fadeOutStart > Math.max(offset, envelope.fadeIn) && fadeOutStart < end)
    target.linearRampToValueAtTime(envelope.gain, when + fadeOutStart - offset);
  if (end > offset) target.linearRampToValueAtTime(clipGainAt(envelope, duration, end), when + end - offset);
}
