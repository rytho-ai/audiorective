import type { Param, SchedulableParam } from "@audiorective/core";
import { Effect, type EffectOptions } from "./Effect";
import { fanout } from "./internal/fanout";
import { SMOOTHING } from "./internal/smoothing";
import { mixFrequencyResponse } from "./internal/frequency-response";

const FILTER_TYPES: readonly BiquadFilterType[] = ["lowpass", "highpass", "bandpass", "lowshelf", "highshelf", "peaking", "notch", "allpass"];

export interface FilterOptions extends EffectOptions {
  /** Cutoff in hertz, 10..22050; defaults to 350. */
  frequency?: number;
  /** Biquad response shape; defaults to "lowpass". */
  type?: BiquadFilterType;
  /** Resonance amount, 0.0001..1000; defaults to 1. */
  Q?: number;
  /** Shelf or peaking boost in dB, -40..40; defaults to 0. */
  gain?: number;
  /** dB per octave; one biquad per 12 dB in series. Default -12. */
  rolloff?: -12 | -24 | -48;
}

/** `params.frequency`, `params.Q` and `params.gain` writes smooth over 10 ms automatically; scheduled ramps stay exact. */
export class Filter extends Effect<{
  /** Cutoff in Hz; value writes already smooth over 10 ms by default. */
  frequency: SchedulableParam;
  /** Resonance; value writes already smooth over 10 ms by default. */
  Q: SchedulableParam;
  /** Gain in dB; value writes already smooth over 10 ms by default. */
  gain: SchedulableParam;
  type: Param<BiquadFilterType>;
}> {
  static override readonly type: string = "Filter";
  private readonly sources: ConstantSourceNode[];
  private readonly stageCount: number;
  private responseBiquad?: BiquadFilterNode;

  constructor(ctx: BaseAudioContext, opts: FilterOptions = {}) {
    const stageCount = Math.abs(opts.rolloff ?? -12) / 12;
    const type = opts.type ?? "lowpass";
    const stages = Array.from({ length: stageCount }, () => new BiquadFilterNode(ctx, { type }));
    for (let i = 1; i < stages.length; i++) stages[i - 1]!.connect(stages[i]!);

    const freq = fanout(
      ctx,
      opts.frequency ?? 350,
      stages.map((s) => s.frequency),
    );
    const q = fanout(
      ctx,
      opts.Q ?? 1,
      stages.map((s) => s.Q),
    );
    const gain = fanout(
      ctx,
      opts.gain ?? 0,
      stages.map((s) => s.gain),
    );

    super(
      ctx,
      { input: stages[0]!, output: stages[stages.length - 1]! },
      ({ param }) => ({
        params: {
          frequency: param({ default: opts.frequency ?? 350, bind: freq.offset, min: 10, max: 22050, smoothing: SMOOTHING }),
          Q: param({ default: opts.Q ?? 1, bind: q.offset, min: 0.0001, max: 1000, smoothing: SMOOTHING }),
          gain: param({ default: opts.gain ?? 0, bind: gain.offset, min: -40, max: 40, smoothing: SMOOTHING }),
          type: param<BiquadFilterType>({
            default: type,
            validate: (t) => {
              if (!FILTER_TYPES.includes(t)) throw new RangeError(`Effect: invalid filter type "${t}".`);
            },
            bind: {
              set: (t) => {
                stages.forEach((s) => {
                  s.type = t;
                });
              },
            },
          }),
        },
        cells: {},
        latency: 0,
      }),
      opts,
    );
    this.sources = [freq, q, gain];
    this.stageCount = stageCount;
  }

  /** Snapshot the combined wet and dry response. Frequencies outside Nyquist follow the native NaN convention. */
  getFrequencyResponse(frequencies: Float32Array<ArrayBuffer>, magnitudes: Float32Array<ArrayBuffer>, phases: Float32Array<ArrayBuffer>): void {
    // Audio-rate fanout drives the live stages. A disconnected calculator reads the same parameter snapshot.
    const node = (this.responseBiquad ??= new BiquadFilterNode(this.context));
    const { frequency, Q, gain, type, wet } = this.params;
    node.type = type.value;
    node.frequency.value = frequency.value;
    node.Q.value = Q.value;
    node.gain.value = gain.value;
    node.getFrequencyResponse(frequencies, magnitudes, phases);
    mixFrequencyResponse(magnitudes, phases, wet.value, this.stageCount);
  }

  override dispose(): void {
    for (const s of this.sources) {
      s.stop();
      s.disconnect();
    }
    super.dispose();
  }
}
