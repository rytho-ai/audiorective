import { cell, readonlyCell, type Cell, type ReadonlyCell, type Param } from "@audiorective/core";
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

export class PitchShift extends Effect<{ pitch: Param<number> }, { isReady: ReadonlyCell<boolean> }> {
  readonly engine: PitchShiftEngine;
  /** Resolves once the engine is ready to process audio. */
  readonly ready: Promise<void>;
  private readonly core: GranularShifter | StretchShifter;
  private disposed = false;
  private readonly _isReady: Cell<boolean>;

  constructor(ctx: BaseAudioContext, opts: PitchShiftOptions = {}) {
    const engine = opts.engine ?? "granular";
    const core =
      engine === "stretch"
        ? new StretchShifter(ctx, opts.pitch ?? 0, opts.stretch)
        : new GranularShifter(ctx, { pitch: opts.pitch ?? 0, windowSize: opts.windowSize });
    const isReady = cell(engine === "granular");
    super(
      ctx,
      { input: core, output: core },
      ({ param }) => ({
        params: {
          pitch: param<number>({
            default: opts.pitch ?? 0,
            min: -24,
            max: 24,
            bind: { set: (v) => core.setPitch(v) },
          }),
        },
        cells: { isReady: readonlyCell(isReady) },
      }),
      opts,
    );
    this.engine = engine;
    this._isReady = isReady;
    this.ready =
      core instanceof StretchShifter
        ? core.ready.then(() => {
            if (this.disposed) return;
            this._isReady.value = true;
          })
        : Promise.resolve();
    // A failed engine load rejects `ready` for callers that await it; this keeps it from also surfacing as unhandled.
    this.ready.catch(() => {});
    this.core = core;
  }

  override dispose(): void {
    this.disposed = true;
    this.core.dispose();
    super.dispose();
  }
}
