import type { Param } from "@audiorective/core";
import { Effect, type EffectOptions } from "./Effect";
import { fadeTo, SMOOTHING } from "./internal/smoothing";

export interface DistortionOptions extends EffectOptions {
  /** 0..1 drive. Default 0.4. */
  distortion?: number;
  /** WaveShaper oversampling. Default "none"; "2x"/"4x" reduce aliasing but add browser-defined latency that this effect cannot declare. */
  oversample?: OverSampleType;
}

const CURVE_LENGTH = 4096;

/** Tone.js's distortion curve normalized to unity peak: soft clipping that approaches a square as k grows. */
export function distortionCurve(amount: number): Float32Array<ArrayBuffer> {
  const k = amount * 100;
  const deg = Math.PI / 180;
  const curve = new Float32Array(CURVE_LENGTH);
  // Calculate peak value at x=1 for normalization
  const peak = ((3 + k) * 20 * deg) / (Math.PI + k);
  for (let i = 0; i < CURVE_LENGTH; i++) {
    const x = (i * 2) / CURVE_LENGTH - 1;
    curve[i] = ((3 + k) * x * 20 * deg) / (Math.PI + k * Math.abs(x)) / peak;
  }
  return curve as Float32Array<ArrayBuffer>;
}

/** WaveShaper distortion. Changing `distortion` crossfades two shapers over 10 ms, so a drag never clicks. */
export class Distortion extends Effect<{ distortion: Param<number> }> {
  static override readonly type = "Distortion";
  constructor(ctx: BaseAudioContext, opts: DistortionOptions = {}) {
    const oversample = opts.oversample ?? "none";
    const entry = new GainNode(ctx);
    const exit = new GainNode(ctx);
    const shapers = [0, 1].map(() => new WaveShaperNode(ctx, { oversample, curve: distortionCurve(opts.distortion ?? 0.4) }));
    const gates = [new GainNode(ctx, { gain: 1 }), new GainNode(ctx, { gain: 0 })];
    shapers.forEach((shaper, i) => {
      entry.connect(shaper);
      shaper.connect(gates[i]!);
      gates[i]!.connect(exit);
    });
    let live = 0;
    let first = true;
    super(
      ctx,
      { input: entry, output: exit },
      ({ param }) => ({
        params: {
          distortion: param<number>({
            default: opts.distortion ?? 0.4,
            min: 0,
            max: 1,
            bind: {
              set: (v) => {
                if (first) {
                  first = false;
                  return;
                }
                const next = 1 - live;
                shapers[next]!.curve = distortionCurve(v);
                fadeTo(ctx, gates[next]!.gain, 1, SMOOTHING / 5);
                fadeTo(ctx, gates[live]!.gain, 0, SMOOTHING / 5);
                live = next;
              },
            },
          }),
        },
        cells: {},
        latency: 0,
      }),
      opts,
    );
  }
}
