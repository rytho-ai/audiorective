/** Pure Equalizer band settings and validation; loads without Web Audio. */
export type EqualizerBand = Readonly<{ frequency: number; gain: number; q: number }>;

/** Validates `bands` (frequency 20-20000 Hz, gain +-24 dB, Q 0.1-20, at least one) and returns frozen copies; throws RangeError otherwise. */
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
