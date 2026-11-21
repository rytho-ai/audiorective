import { renderOffline, type RenderOfflineOptions } from "@audiorective/core";
import { ManualTickSource, type TickSource } from "./TickSource";

/** Web Audio's render quantum, in frames — `OfflineAudioContext.suspend` rounds to it. */
const RENDER_QUANTUM = 128;

/** Matches `Clock`'s default `tickInterval`, and sits well below its default 100 ms `lookAhead`. */
const DEFAULT_TICK_INTERVAL = 0.025;

export interface RenderTimelineOptions extends RenderOfflineOptions {
  /**
   * Seconds of audio time between ticks. Default 0.025 — `Clock`'s own default.
   * Keep it below the driven clock's `lookAhead`, exactly as live: a tick that
   * lands past the previous window's end is a miss offline too. An offline
   * render can only pause on a 128-frame render-quantum boundary, so ticks are
   * never closer than one quantum: a smaller interval ticks once per quantum.
   */
  tickInterval?: number;
  /**
   * Closures to run at audio times, like a user pressing record or launching a clip. Each runs while the render is suspended, on the render quantum at or before `at`
   * (so one placed exactly on a boundary still meets it), before that quantum's tick. When it returns a promise the render stays suspended until it settles, so an
   * action that returns `recorder.record(...)`'s take, or awaits a take delivered by an AudioWorklet, sees it complete before the next tick instead of arbitrarily late in audio time.
   * A rejection fails the render. Actions run in `at` order.
   */
  actions?: ReadonlyArray<RenderAction>;
}

/** One closure `renderTimeline` runs at audio time `at` (seconds); a returned promise is awaited while the render is suspended. */
export interface RenderAction {
  at: number;
  run: () => unknown;
}

/**
 * `renderOffline` for a `Clock`-driven graph. An `OfflineAudioContext` renders
 * as fast as it can and its `currentTime` never moves before rendering starts,
 * so a timer-driven tick source would emit one window and then starve. This
 * hands `setup` a tick source to build the clock on, then drives it in step
 * with the render: the first tick fires at time 0 before rendering, and every
 * `tickInterval` after that the render is suspended, ticked, and resumed —
 * the clock reads the context's real `currentTime` throughout, so there is
 * no fake time source and no test-only seam. Start the transport inside
 * `setup`; the first window is emitted as soon as it returns.
 *
 * One tick source drives one clock (`ManualTickSource` holds a single
 * callback), which is also the package's one-clock rule.
 */
export async function renderTimeline(
  options: RenderTimelineOptions,
  setup: (ctx: OfflineAudioContext, tickSource: TickSource) => void | Promise<void>,
): Promise<AudioBuffer> {
  const tickInterval = options.tickInterval ?? DEFAULT_TICK_INTERVAL;
  if (!(tickInterval > 0)) throw new RangeError(`renderTimeline: tickInterval must be positive, got ${tickInterval}`);

  let drive: Promise<void> | undefined;
  const buffer = await renderOffline(options, async (ctx) => {
    const ticks = new ManualTickSource();
    await setup(ctx, ticks);
    const actions = [...(options.actions ?? [])].sort((a, b) => a.at - b.at);
    // actions due before the first quantum run before the first tick, still before rendering starts
    const stepFrame = (t: number): number => Math.floor((t * ctx.sampleRate + 1e-6) / RENDER_QUANTUM) * RENDER_QUANTUM;
    while (actions.length && stepFrame(actions[0]!.at) <= 0) await actions.shift()!.run();
    // time 0, before rendering starts -- the first window
    ticks.tick();
    // every suspend is scheduled synchronously here, ahead of startRendering
    drive = driveTicks(ctx, ticks, tickInterval, actions, stepFrame);
    // rendering still has to finish before `drive` is awaited below; keep an
    // early failure from surfacing as an unhandled rejection in the meantime
    drive.catch(() => {});
  });
  await drive;
  return buffer;
}

async function driveTicks(
  ctx: OfflineAudioContext,
  ticks: ManualTickSource,
  interval: number,
  actions: RenderAction[],
  stepFrame: (t: number) => number,
): Promise<void> {
  // `suspend(t)` pauses on the render-quantum boundary at or after `t`
  // (ceil), rejects a second suspend on a frame that already has one, and a
  // suspend at or past the end of the render never settles. So every stop is
  // planned in quantized frames: the k-th tick's nominal time rounded up to a
  // quantum, never the same quantum twice (a sub-quantum interval degrades
  // to one tick per quantum), and never at or beyond `ctx.length`. An action's
  // stop is the quantum at or before its time, merged into the same set.
  const quantize = (t: number): number => Math.ceil((t * ctx.sampleRate) / RENDER_QUANTUM) * RENDER_QUANTUM;
  const stops = new Set<number>();
  let frame = 0;
  for (let k = 1; ; k++) {
    frame = Math.max(quantize(k * interval), frame + RENDER_QUANTUM);
    if (frame >= ctx.length) break;
    stops.add(frame);
  }
  for (const action of actions) {
    const at = stepFrame(action.at);
    if (at < ctx.length) stops.add(at);
  }
  const frames = [...stops].sort((a, b) => a - b);
  // ask for a time safely inside the quantum below the target, so rounding
  // error in frame/sampleRate can't push the actual stop one quantum later
  const waits = frames.map((f) => ctx.suspend((f - RENDER_QUANTUM / 2) / ctx.sampleRate));
  for (const wait of waits) wait.catch(() => {});
  for (let i = 0; i < frames.length; i++) {
    await waits[i];
    try {
      while (actions.length && stepFrame(actions[0]!.at) <= frames[i]!) await actions.shift()!.run();
      ticks.tick();
    } catch (error) {
      // every stop is already scheduled: let the render run past the rest so it ends and the failure surfaces instead of hanging
      await ctx.resume();
      for (let rest = i + 1; rest < frames.length; rest++) {
        await waits[rest];
        await ctx.resume();
      }
      throw error;
    }
    await ctx.resume();
  }
}
