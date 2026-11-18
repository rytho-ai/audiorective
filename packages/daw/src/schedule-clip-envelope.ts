import { clipGainAt, type ClipEnvelope } from "./clip-envelope";

/** Write a clip envelope window onto an AudioParam. */
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
