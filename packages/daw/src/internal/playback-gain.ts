/** Allow the scheduled change to reach the audio thread before its ramp begins. */
export const playbackLead = 0.025;
/** How far ahead a transport start is parked while a seek waits for media; `startArrangement` re-anchors it long before. */
export const holdSeconds = 2 ** 24;
const fadeSeconds = 0.012;

export function smoothGain(context: BaseAudioContext, param: AudioParam, value: number): void {
  if (!context.currentTime) param.setValueAtTime(value, 0);
  else param.setTargetAtTime(value, context.currentTime + 0.01, 0.004);
}

export function stopSource(context: BaseAudioContext, source: AudioBufferSourceNode, gain: AudioParam, when: number): void {
  const now = context.currentTime;
  if (when > now) {
    source.stop(now);
    return;
  }
  const fadeStart = now + 0.01;
  gain.setValueAtTime(1, fadeStart);
  gain.linearRampToValueAtTime(0, fadeStart + fadeSeconds);
  source.stop(fadeStart + fadeSeconds);
}
