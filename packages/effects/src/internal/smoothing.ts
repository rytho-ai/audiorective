/** Seconds a `.value` write on an audible effect parameter takes to settle. */
export const SMOOTHING = 0.01;

/** Seconds a scheduled fade waits before it starts: `currentTime` lags the audio thread by a render buffer, and an event in the past would start part-way along its curve. */
export const LEAD = 0.01;

/** Moves `param` to `value` with time constant `tc`, or jumps there while the context clock has not run yet (nothing has been heard, and an offline render starts at the final value). */
export function fadeTo(ctx: BaseAudioContext, param: AudioParam, value: number, tc: number): void {
  if (ctx.currentTime === 0) {
    param.cancelScheduledValues(0);
    param.value = value;
  } else param.setTargetAtTime(value, ctx.currentTime + LEAD, tc);
}
