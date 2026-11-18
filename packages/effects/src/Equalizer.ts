import { batch } from "@audiorective/core";
import { Effect, type EffectOptions } from "./Effect";
import { Filter } from "./Filter";
import { mixFrequencyResponse } from "./internal/frequency-response";

export type EqualizerBand = Readonly<{ frequency: number; gain: number; q: number }>;

export interface EqualizerOptions extends EffectOptions {
  bands: readonly EqualizerBand[];
}

export function normalizeEqualizerBands(bands: readonly EqualizerBand[]): readonly EqualizerBand[] {
  const inRange = (value: number, min: number, max: number) => Number.isFinite(value) && value >= min && value <= max;
  if (
    !Array.isArray(bands) ||
    !bands.length ||
    Array.from(bands).some((band) => !band || !inRange(band.frequency, 20, 20_000) || !inRange(band.gain, -24, 24) || !inRange(band.q, 0.1, 20))
  )
    throw new RangeError("Equalizer needs valid bands with frequency 20–20000 Hz, gain ±24 dB, and Q 0.1–20.");
  return Object.freeze(bands.map(({ frequency, gain, q }) => Object.freeze({ frequency, gain, q })));
}

/** A serial peaking-filter bank with independent band Params and one global wet/dry mix. */
export class Equalizer extends Effect {
  private readonly filters: readonly Filter[];
  private magnitudes = new Float32Array(0);
  private phases = new Float32Array(0);
  readonly bands: readonly Readonly<{
    frequency: Filter["params"]["frequency"];
    gain: Filter["params"]["gain"];
    q: Filter["params"]["Q"];
  }>[];

  constructor(context: BaseAudioContext, options: EqualizerOptions) {
    const filters = normalizeEqualizerBands(options.bands).map(
      ({ frequency, gain, q }) => new Filter(context, { type: "peaking", frequency, gain, Q: q }),
    );
    super(context, { input: filters[0], output: filters.at(-1)! }, () => ({ params: {}, cells: {}, latency: 0 }), options);
    this.filters = filters;
    this.bands = Object.freeze(filters.map(({ params }) => Object.freeze({ frequency: params.frequency, gain: params.gain, q: params.Q })));
    this.defineGraph(() => filters.slice(1).map((filter, index) => [filters[index], filter] as const));
  }

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

  override destroy(): void {
    super.destroy();
    for (const filter of this.filters) filter.destroy();
  }
}
