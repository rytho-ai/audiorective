import type { Param } from "@audiorective/core";
import { Effect, type EffectOptions } from "./Effect";
import { GranularShifter } from "./pitch/GranularShifter";
import { StretchShifter } from "./pitch/StretchShifter";

export type PitchShiftEngine = "granular" | "stretch";

export interface StretchOptions {
  tonalityHz?: number;
  formantCompensation?: boolean;
  formantSemitones?: number;
  blockMs?: number;
}

export interface PitchShiftOptions extends EffectOptions {
  /** Shift in semitones. Default 0. */
  pitch?: number;
  /** Default "granular". */
  engine?: PitchShiftEngine;
  /** Grain size for the granular engine, seconds. Default 0.1. */
  windowSize?: number;
  stretch?: StretchOptions;
}

/** Pitch shifter. The `"stretch"` engine loads asynchronously; until ready only the `1 − wet` dry share passes (`wet: 1` is silent). */
export class PitchShift extends Effect<{ pitch: Param<number> }> {
  static override readonly type: string = "PitchShift";
  readonly engine: PitchShiftEngine;
  private readonly core: GranularShifter | StretchShifter;

  constructor(ctx: BaseAudioContext, opts: PitchShiftOptions = {}) {
    const engine = opts.engine ?? "granular";
    const core =
      engine === "stretch"
        ? new StretchShifter(ctx, opts.pitch ?? 0, opts.stretch)
        : new GranularShifter(ctx, { pitch: opts.pitch ?? 0, windowSize: opts.windowSize });
    super(
      ctx,
      { input: core, output: core, loading: engine === "stretch" },
      ({ param }) => ({
        params: {
          pitch: param<number>({
            default: opts.pitch ?? 0,
            min: -24,
            max: 24,
            bind: { set: (v) => core.setPitch(v) },
          }),
        },
        cells: {},
      }),
      opts,
    );
    this.engine = engine;
    if (core instanceof StretchShifter) this.track(core.ready);
    this.core = core;
  }

  override dispose(): void {
    this.core.dispose();
    super.dispose();
  }
}
