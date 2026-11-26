import { batch, type SchedulableParam } from "@audiorective/core";
import { Effect, type EffectOptions } from "./Effect";
import { Filter } from "./Filter";
import { mixFrequencyResponse } from "./internal/frequency-response";
import { normalizeEqualizerBands, type EqualizerBand } from "./equalizer-bands";

export interface EqualizerOptions extends EffectOptions {
  bands: readonly EqualizerBand[];
}

/** A serial peaking-filter bank with independent band Params and one global wet/dry mix. Band frequency, gain and Q writes smooth over 10 ms automatically; scheduled ramps stay exact. Each band's Params are also registered in `params` as `band<i>Frequency`, `band<i>Gain` and `band<i>Q`. */
export class Equalizer extends Effect<Record<string, SchedulableParam>> {
  static override readonly type: string = "Equalizer";
  private readonly filters: readonly Filter[];
  private magnitudes = new Float32Array(0);
  private phases = new Float32Array(0);
  /** Per-band `frequency` (Hz), `gain` (dB) and `q` params, in band order; `setBands` rebuilds them. */
  readonly bands: readonly Readonly<{
    frequency: Filter["params"]["frequency"];
    gain: Filter["params"]["gain"];
    q: Filter["params"]["Q"];
  }>[];

  constructor(context: BaseAudioContext, options: EqualizerOptions) {
    const filters = normalizeEqualizerBands(options.bands).map(
      ({ frequency, gain, q }) => new Filter(context, { type: "peaking", frequency, gain, Q: q }),
    );
    super(
      context,
      { input: filters[0], output: filters.at(-1)! },
      () => ({
        params: Object.fromEntries(
          filters.flatMap((filter, i) => [
            [`band${i}Frequency`, filter.params.frequency],
            [`band${i}Gain`, filter.params.gain],
            [`band${i}Q`, filter.params.Q],
          ]),
        ),
        cells: {},
        latency: 0,
      }),
      options,
    );
    this.filters = filters;
    this.bands = Object.freeze(filters.map(({ params }) => Object.freeze({ frequency: params.frequency, gain: params.gain, q: params.Q })));
    this.defineGraph(() => filters.slice(1).map((filter, index) => [filters[index], filter] as const));
  }

  /** Sets every band's frequency (Hz, 20-20000), gain (dB, +-24) and Q (0.1-20) in one batch; the count must equal the constructed band count, else throws RangeError. */
  setBands(bands: readonly EqualizerBand[]): void {
    const settings = normalizeEqualizerBands(bands);
    if (settings.length !== this.bands.length) throw new RangeError("Equalizer band count must match the constructed bank.");
    batch(() => {
      settings.forEach(({ frequency, gain, q }, index) => {
        const band = this.bands[index];
        band.frequency.value = frequency;
        band.gain.value = gain;
        band.q.value = q;
      });
    });
  }

  /** Fills `magnitudes` (linear gain) and `phases` (radians) with the whole bank's response, wet/dry mix included, at each of `frequencies` (Hz); the three arrays must have equal length. */
  getFrequencyResponse(frequencies: Float32Array<ArrayBuffer>, magnitudes: Float32Array<ArrayBuffer>, phases: Float32Array<ArrayBuffer>): void {
    if (magnitudes.length !== frequencies.length || phases.length !== frequencies.length)
      throw new RangeError("Equalizer frequency response arrays must have the same length.");
    if (this.magnitudes.length !== frequencies.length) {
      this.magnitudes = new Float32Array(frequencies.length);
      this.phases = new Float32Array(frequencies.length);
    }
    magnitudes.fill(1);
    phases.fill(0);
    for (const filter of this.filters) {
      filter.getFrequencyResponse(frequencies, this.magnitudes, this.phases);
      for (let index = 0; index < frequencies.length; index++) {
        magnitudes[index] *= this.magnitudes[index];
        phases[index] += this.phases[index];
      }
    }
    mixFrequencyResponse(magnitudes, phases, this.params.wet.value);
  }

  override dispose(): void {
    super.dispose();
    for (const filter of this.filters) filter.dispose();
  }
}
