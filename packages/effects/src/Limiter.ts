import type { ReadonlyCell, SchedulableParam } from "@audiorective/core";
import { DynamicsCore } from "./dynamics/DynamicsCore";
import { Effect, type EffectOptions } from "./Effect";

export interface LimiterOptions extends EffectOptions {
  /** Ceiling, dBFS. Default -1. */
  threshold?: number;
  /** Seconds to let go of the reduction. Default 0.05. */
  release?: number;
  /** Peak-detection window, seconds; the effect declares it as latency. Default 0.005. */
  lookahead?: number;
}

/** Brickwall: infinite ratio, hard knee, windowed-peak detection over `lookahead`. The worklet loads asynchronously; the effect passes dry until `cells.status` is `"ready"`. */
export class Limiter extends Effect<{ threshold: SchedulableParam; release: SchedulableParam }, { reduction: ReadonlyCell<number> }> {
  static override readonly type = "Limiter";
  private readonly core: DynamicsCore;

  constructor(ctx: BaseAudioContext, opts: LimiterOptions = {}) {
    const core = new DynamicsCore(ctx, {
      threshold: opts.threshold ?? -1,
      ratio: Infinity,
      knee: 0,
      attack: 0.001,
      release: opts.release ?? 0.05,
      makeup: 0,
      lookahead: opts.lookahead ?? 0.005,
    });
    super(
      ctx,
      { input: core, output: core, loading: true },
      () => ({ params: { threshold: core.params.threshold, release: core.params.release }, cells: { reduction: core.cells.reduction } }),
      opts,
    );
    this.track(core.ready);
    this.core = core;
  }

  override dispose(): void {
    this.core.dispose();
    super.dispose();
  }
}
