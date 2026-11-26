/** Allow the scheduled change to reach the audio thread before its ramp begins. */
export const playbackLead = 0.04;
/** The lead of a device-chain swap: its graph edits take hold at once, so a longer wait only delays the crossfade. */
export const chainLead = 0.025;
/** How far ahead a transport start is parked while a seek waits for media; `startArrangement` re-anchors it long before. */
export const holdSeconds = 2 ** 24;
/**
 * The least a live cut may lie ahead of `currentTime` when it is scheduled. A main thread that is slow (a long batch of edits, a busy page) reaches
 * the cut time `playbackLead` after it was chosen with the audio thread already past it, and gain events in the past take effect at once as a step.
 * A cut that is overdue moves forward to this margin instead.
 */
export const minLead = 0.012;
/** Length of the fade that ends a cancelled source and begins the source that takes over from it. */
export const fadeSeconds = 0.012;
/** Length of the crossfade from a track's old device chain to its new one. */
export const chainFadeSeconds = 0.025;

export function smoothGain(context: BaseAudioContext, param: AudioParam, value: number): void {
  if (!context.currentTime) param.setValueAtTime(value, 0);
  else param.setTargetAtTime(value, context.currentTime + 0.01, 0.004);
}

/**
 * A gain parameter whose scheduled events are mirrored in script, so the level it will have at a future time can be computed (an AudioParam only reports
 * its present value, which is not what a fade planned 25 ms ahead sees). A source that is cancelled while still fading in, or while already fading out,
 * continues from its own level instead of jumping to full.
 */
export class VoiceGain {
  private initial = 1;
  private readonly events: Array<{ time: number; value: number; ramp: boolean }> = [];
  /** When the voice is silent for good: set by `fadeOut`. */
  end = Infinity;

  constructor(
    private readonly param: AudioParam,
    /** The time the source starts; before it the voice is silent whatever the events say. */
    private readonly start: number,
  ) {}

  /** The level before the first scheduled event. */
  setInitialValue(value: number): void {
    this.param.value = value;
    this.initial = value;
  }

  setValueAtTime(value: number, time: number): void {
    this.param.setValueAtTime(value, time);
    this.events.push({ time, value, ramp: false });
  }

  linearRampToValueAtTime(value: number, time: number): void {
    this.param.linearRampToValueAtTime(value, time);
    this.events.push({ time, value, ramp: true });
  }

  /** The level at `time`, by the same rules the audio thread applies to the scheduled events. */
  valueAt(time: number): number {
    if (time < this.start) return 0;
    let prev = { time: -Infinity, value: this.initial };
    for (const event of this.events) {
      if (event.time <= time) prev = event;
      else {
        if (event.ramp && prev.time > -Infinity) return prev.value + ((event.value - prev.value) * (time - prev.time)) / (event.time - prev.time);
        return prev.value;
      }
    }
    return prev.value;
  }

  /** From `at` on, leave the level it has there and fall linearly to silence over `seconds`. Returns when it is silent. */
  fadeOut(at: number, seconds: number): number {
    const level = this.valueAt(at);
    const cut = this.events.findIndex((event) => event.time >= at);
    const truncated = cut >= 0 && this.events.slice(cut).some((event) => event.ramp);
    this.param.cancelScheduledValues(at);
    if (cut >= 0) this.events.length = cut;
    // A ramp that was under way keeps its line up to `at`.
    if (truncated && this.events.length) this.linearRampToValueAtTime(level, at);
    else this.setValueAtTime(level, at);
    this.linearRampToValueAtTime(0, at + seconds);
    return (this.end = at + seconds);
  }
}

/**
 * Fade a source out and stop it. `at` is the shared cut time of a live edit: the fade starts there, so the sources an edit replaces
 * can fade in over the same span (a crossfade of the same audio keeps its level). Without `at` the fade starts 10 ms from now.
 * The fade starts from the level the voice has at that moment, so a source cut while it is still fading in (or out) does not jump.
 * Returns whether a sounding source was faded (false: it had not started, so it was stopped silently).
 */
export function stopSource(context: BaseAudioContext, source: AudioBufferSourceNode, gain: VoiceGain, when: number, at?: number): boolean {
  const now = context.currentTime;
  if (when > (at ?? now)) {
    source.stop(now);
    return false;
  }
  const end = gain.fadeOut(at ?? now + 0.01, fadeSeconds);
  source.stop(end);
  return true;
}
