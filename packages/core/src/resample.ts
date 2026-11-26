import type { PCMData } from "./peaks";

/** Resampler quality: the number of zero crossings of the sinc kernel on each side (`fast` 12, `standard` 32, `high` 64). */
export type ResampleQuality = "fast" | "standard" | "high";

export interface ResamplePCMOptions {
  /** Default `"standard"`: a 64-tap Kaiser-windowed sinc, about -90 dB aliasing and imaging. `"high"` doubles the taps and the time; `"fast"` is for previews. */
  quality?: ResampleQuality;
}

const ZEROS: Record<ResampleQuality, number> = { fast: 12, standard: 32, high: 64 };
const BETA = 10;
/** The passband edge as a share of the lower Nyquist: a little rolloff keeps the transition band below it. */
const CUTOFF = 0.985;
/** Exact polyphase tables up to this many phases; a ratio with more phases is read from a table of this size with linear interpolation. */
const MAX_PHASES = 4096;

function bessel0(x: number): number {
  let sum = 1;
  let term = 1;
  const quarter = (x * x) / 4;
  for (let k = 1; k < 60; k++) {
    term *= quarter / (k * k);
    sum += term;
    if (term < sum * 1e-17) break;
  }
  return sum;
}

function gcd(a: number, b: number): number {
  while (b) [a, b] = [b, a % b];
  return a;
}

/**
 * `pcm` at `targetRate`, resampled with a Kaiser-windowed sinc polyphase filter. Pure and deterministic (browsers, Node.js, workers).
 * Output sample `n` is the input at time `n / targetRate`, so frame 0 stays frame 0 and a click at input time `t` lands at `round(t * targetRate)`;
 * the length is `round(frames * targetRate / sampleRate)`. Content above `min(source, target) / 2` is removed (anti-aliasing) and the signal beyond the ends counts as silence.
 * Equal rates return a copy.
 */
export function resamplePCM(pcm: PCMData, targetRate: number, options: ResamplePCMOptions = {}): PCMData {
  const src = pcm.sampleRate;
  if (!Number.isFinite(src) || src <= 0) throw new RangeError("resamplePCM: sampleRate must be a finite positive number");
  if (!Number.isFinite(targetRate) || targetRate <= 0) throw new RangeError("resamplePCM: targetRate must be a finite positive number");
  const quality = options.quality ?? "standard";
  if (!(quality in ZEROS)) throw new RangeError('resamplePCM: quality must be "fast", "standard" or "high"');
  const frames = pcm.channels[0]?.length ?? 0;
  if (pcm.channels.some((channel) => channel.length !== frames)) throw new RangeError("resamplePCM: channels must have equal frame counts");
  if (src === targetRate) return { sampleRate: targetRate, channels: pcm.channels.map((channel) => new Float32Array(channel)) };
  const outFrames = Math.round((frames * targetRate) / src);
  if (outFrames === 0 || frames === 0) return { sampleRate: targetRate, channels: pcm.channels.map(() => new Float32Array(outFrames)) };

  // Kernel in source-sample units: h(x) = scale * sinc(scale * x) * kaiser(x / half), normalised to unit gain at DC for every phase.
  const ratio = Math.min(1, targetRate / src);
  const scale = ratio * CUTOFF;
  const half = Math.ceil(ZEROS[quality] / ratio);
  const taps = 2 * half;
  const invBessel = 1 / bessel0(BETA);
  const kernel = (x: number): number => {
    const u = x / half;
    if (u <= -1 || u >= 1) return 0;
    const t = Math.PI * scale * x;
    const sinc = x === 0 ? 1 : Math.sin(t) / t;
    return sinc * bessel0(BETA * Math.sqrt(1 - u * u)) * invBessel;
  };
  const exact = Number.isInteger(src) && Number.isInteger(targetRate) && targetRate / gcd(src, targetRate) <= MAX_PHASES;
  const phases = exact ? targetRate / gcd(src, targetRate) : MAX_PHASES;
  const rows = exact ? phases : phases + 1;
  const table = new Float64Array(rows * taps);
  for (let q = 0; q < rows; q++) {
    const frac = q / phases;
    let sum = 0;
    for (let k = 0; k < taps; k++) {
      const value = kernel(k - half + 1 - frac);
      table[q * taps + k] = value;
      sum += value;
    }
    for (let k = 0; k < taps; k++) table[q * taps + k] /= sum;
  }

  const channels = pcm.channels.map((channel) => {
    const out = new Float32Array(outFrames);
    for (let n = 0; n < outFrames; n++) {
      // Input position n * src / targetRate, split exactly into whole frames and a phase when both rates are integers.
      let base: number;
      let row: number;
      let mix = 0;
      if (exact) {
        const q = (n * src) % targetRate;
        base = (n * src - q) / targetRate;
        row = (q / targetRate) * phases;
        row = Math.round(row);
      } else {
        const position = (n * src) / targetRate;
        base = Math.floor(position);
        const scaled = (position - base) * phases;
        row = Math.floor(scaled);
        mix = scaled - row;
      }
      const first = base - half + 1;
      const offset = row * taps;
      let acc = 0;
      if (first >= 0 && first + taps <= frames) {
        if (exact) {
          // Four independent sums keep the multiply-adds pipelined;
          let a0 = 0;
          let a1 = 0;
          let a2 = 0;
          let a3 = 0;
          let k = 0;
          for (; k + 4 <= taps; k += 4) {
            a0 += table[offset + k] * channel[first + k];
            a1 += table[offset + k + 1] * channel[first + k + 1];
            a2 += table[offset + k + 2] * channel[first + k + 2];
            a3 += table[offset + k + 3] * channel[first + k + 3];
          }
          for (; k < taps; k++) a0 += table[offset + k] * channel[first + k];
          acc = a0 + a1 + a2 + a3;
        } else {
          for (let k = 0; k < taps; k++) acc += (table[offset + k] + mix * (table[offset + taps + k] - table[offset + k])) * channel[first + k];
        }
      } else {
        const from = Math.max(0, -first);
        const to = Math.min(taps, frames - first);
        for (let k = from; k < to; k++) {
          const weight = exact ? table[offset + k] : table[offset + k] + mix * (table[offset + taps + k] - table[offset + k]);
          acc += weight * channel[first + k];
        }
      }
      out[n] = acc;
    }
    return out;
  });
  return { sampleRate: targetRate, channels };
}
