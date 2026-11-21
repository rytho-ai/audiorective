import type { ReadonlyCell, SchedulableParam } from "@audiorective/core";
import { DynamicsCore } from "./dynamics/DynamicsCore";
import { Effect, type EffectOptions } from "./Effect";

export interface CompressorOptions extends EffectOptions {
  /** dBFS above which gain reduction starts. Default -24. */
  threshold?: number;
  /** Input:output slope above the threshold. Default 4. */
  ratio?: number;
  /** Soft-knee width, dB. Default 6. */
  knee?: number;
  /** Seconds to reach the reduction. Default 0.003. */
  attack?: number;
  /** Seconds to let go of the reduction. Default 0.25. */
  release?: number;
  /** Output gain after compression, dB. Default 0. */
  makeup?: number;
  /** Detector lookahead, seconds; the effect declares it as latency. Default 0. */
  lookahead?: number;
}

type P = {
  threshold: SchedulableParam;
  ratio: SchedulableParam;
  knee: SchedulableParam;
  attack: SchedulableParam;
  release: SchedulableParam;
  makeup: SchedulableParam;
};

/** Feedforward compressor. The worklet loads asynchronously; the effect passes dry until `cells.status` is `"ready"`. `cells.reduction` is the live gain reduction in dB (<= 0). */
export class Compressor extends Effect<P, { reduction: ReadonlyCell<number> }> {
  static override readonly type = "Compressor";
  private readonly core: DynamicsCore;

  constructor(ctx: BaseAudioContext, opts: CompressorOptions = {}) {
    const core = new DynamicsCore(ctx, {
      threshold: opts.threshold ?? -24,
      ratio: opts.ratio ?? 4,
      knee: opts.knee ?? 6,
      attack: opts.attack ?? 0.003,
      release: opts.release ?? 0.25,
      makeup: opts.makeup ?? 0,
      lookahead: opts.lookahead ?? 0,
    });
    super(
      ctx,
      { input: core, output: core, loading: true },
      () => ({ params: { ...core.params }, cells: { reduction: core.cells.reduction } }),
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
