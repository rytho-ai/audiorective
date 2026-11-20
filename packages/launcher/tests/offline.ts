// Drives a Clock over an OfflineAudioContext with closures applied at audio times (the actions of the contract, and the tests).
import { ManualTickSource } from "@audiorective/clock";

export type Step = { at: number; run: () => void };

/**
 * Renders `ctx` to the end, ticking `ticks` every 25 ms and running each step on the render quantum at or before its `at`
 * (so a step placed exactly on a boundary still meets it). `startFn` runs before the first tick.
 */
export async function driveOffline(
  ctx: OfflineAudioContext,
  ticks: ManualTickSource,
  steps: Step[],
  startFn: () => void = () => {},
): Promise<AudioBuffer> {
  const sr = ctx.sampleRate;
  const Q = 128;
  const length = ctx.length;
  const frameOf = (t: number) => Math.ceil((t * sr) / Q) * Q;
  const stepFrame = (t: number) => Math.floor((t * sr + 1e-6) / Q) * Q;
  const todo = [...steps].sort((a, b) => a.at - b.at);
  const stops = new Set<number>();
  for (let k = 1; frameOf(k * 0.025) < length; k++) stops.add(frameOf(k * 0.025));
  for (const s of todo) if (stepFrame(s.at) > 0 && stepFrame(s.at) < length) stops.add(stepFrame(s.at));
  const frames = [...stops].sort((a, b) => a - b);
  const waits = frames.map((f) => ctx.suspend((f - Q / 2) / sr));
  startFn();
  let next = 0;
  while (next < todo.length && stepFrame(todo[next]!.at) === 0) todo[next++]!.run();
  ticks.tick();
  const rendering = ctx.startRendering();
  rendering.catch(() => {});
  for (let i = 0; i < frames.length; i++) {
    await waits[i];
    try {
      while (next < todo.length && stepFrame(todo[next]!.at) <= frames[i]!) todo[next++]!.run();
      ticks.tick();
    } finally {
      await ctx.resume();
    }
  }
  return rendering;
}
