import type { ReadonlyCell, SchedulableParam } from "@audiorective/core";
import { DuckerCore } from "./dynamics/DuckerCore";
import { Effect, type EffectOptions } from "./Effect";

export interface DuckerOptions extends EffectOptions {
  /** Gain reduction while the sidechain is above `threshold`, dB. Default 8. */
  depth?: number;
  /** Seconds to reach the full `depth`. Default 0.01. */
  attack?: number;
  /** Seconds to recover from the full `depth`. Default 0.3. */
  release?: number;
  /** Sidechain peak level that triggers ducking, dBFS. Default -30. */
  threshold?: number;
}

/**
 * Sidechain ducker: lowers the audio by `depth` dB while the signal connected to `sidechain` is above `threshold`.
 * The sidechain only triggers; it never reaches the output. `cells.reduction` reports actual output attenuation including wet and bypass fades.
 * The worklet loads asynchronously; only the `1 − wet` dry share passes until ready (`wet: 1` is silent).
 */
export class Ducker extends Effect<
  { depth: SchedulableParam; attack: SchedulableParam; release: SchedulableParam; threshold: SchedulableParam },
  {
    /** Actual output attenuation in dB (≤ 0; silence = -Infinity), including wet and bypass fades. Updated every 512 audio frames (~12 ms); read or subscribe directly, without manually masking bypass. Loading/error refreshes from the dry path each animation frame. */
    reduction: ReadonlyCell<number>;
  }
> {
  static override readonly type: string = "Ducker";
  /** Connect the trigger signal here: `kick.connect(ducker.sidechain)`. */
  readonly sidechain: GainNode;
  private readonly core: DuckerCore;
  private loadingMeterFrame = 0;

  constructor(ctx: BaseAudioContext, opts: DuckerOptions = {}) {
    const core = new DuckerCore(ctx, {
      depth: opts.depth ?? 8,
      attack: opts.attack ?? 0.01,
      release: opts.release ?? 0.3,
      threshold: opts.threshold ?? -30,
    });
    super(
      ctx,
      { input: core, output: core, loading: true },
      () => ({ params: { ...core.params }, cells: { reduction: core.cells.reduction } }),
      opts,
    );
    this.connectMixControls(core.dryMix, core.wetMix);
    this.sidechain = core.sidechain;
    this.core = core;
    this.effect(() => {
      cancelAnimationFrame(this.loadingMeterFrame);
      this.loadingMeterFrame = 0;
      if (this.cells.status.value === "ready") return;
      const tick = () => {
        core.reportReduction(Math.min(0, 20 * Math.log10(this.dryMixValue)));
        this.loadingMeterFrame = requestAnimationFrame(tick);
      };
      tick();
    });
    this.track(core.ready);
  }

  override dispose(): void {
    cancelAnimationFrame(this.loadingMeterFrame);
    this.loadingMeterFrame = 0;
    this.core.dispose();
    super.dispose();
  }
}
