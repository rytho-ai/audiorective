import type { Param } from "@audiorective/core";
import { Effect, type EffectOptions } from "./Effect";
import { GranularShifter } from "./pitch/GranularShifter";
import { StretchShifter } from "./pitch/StretchShifter";

export type PitchShiftEngine = "granular" | "stretch";

export interface StretchOptions {
  /** Optional Signalsmith tonal-frequency limit in hertz; omitted to use the engine default. */
  tonalityHz?: number;
  /** Optional formant preservation; omitted to use the Signalsmith default. */
  formantCompensation?: boolean;
  /** Optional formant shift in semitones; omitted to use the Signalsmith default. */
  formantSemitones?: number;
  /** Optional Signalsmith processing block duration in milliseconds, matching its native configuration. */
  blockMs?: number;
}

export interface PitchShiftOptions extends EffectOptions {
  /** Shift in semitones. Default 0. */
  pitch?: number;
  /** Default "granular". */
  engine?: PitchShiftEngine;
  /** Grain size for the granular engine, seconds. Default 0.1. */
  windowSize?: number;
  /** Optional Signalsmith configuration; used only by the stretch engine. */
  stretch?: StretchOptions;
}

/** Pitch shifter. The `"stretch"` engine loads asynchronously; until ready only the `1 − wet` dry share passes (`wet: 1` is silent). */
export class PitchShift extends Effect<{ pitch: Param<number> }> {
  static override readonly type: string = "PitchShift";
  /** The pitch engine chosen at construction: `"granular"` (default) or `"stretch"`; it cannot change afterwards. */
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
            validate: (v) => {
              if (!Number.isFinite(2 ** (v / 12))) throw new RangeError(`PitchShift needs a finite pitch in semitones, got ${v}.`);
            },
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
