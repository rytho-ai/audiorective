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
 * The sidechain only triggers; it never reaches the output. `cells.reduction` is the live gain reduction in dB (<= 0).
 * The worklet loads asynchronously; the effect passes dry until `cells.status` is `"ready"`.
 */
export class Ducker extends Effect<
  { depth: SchedulableParam; attack: SchedulableParam; release: SchedulableParam; threshold: SchedulableParam },
  { reduction: ReadonlyCell<number> }
> {
  static override readonly type = "Ducker";
  /** Connect the trigger signal here: `kick.connect(ducker.sidechain)`. */
  readonly sidechain: GainNode;
  private readonly core: DuckerCore;

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
    this.track(core.ready);
    this.sidechain = core.sidechain;
    this.core = core;
  }

  override dispose(): void {
    this.core.dispose();
    super.dispose();
  }
}
