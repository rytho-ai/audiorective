/** Pure measurements of rendered PCM for reading a mix without hearing it. */

const silenceFloor = 1e-10;

/** Highest absolute sample in dBFS, or `null` for digital silence. */
export function peakDbFS(channels: readonly Float32Array[]): number | null {
  let peak = 0;
  for (const channel of channels) for (const sample of channel) peak = Math.max(peak, Math.abs(sample));
  return peak > 0 ? 20 * Math.log10(peak) : null;
}

/** ITU-R BS.1770 K-weighting: two biquads, with coefficients derived for any sample rate. */
function kWeight(input: Float32Array, sampleRate: number): Float64Array {
  let K = Math.tan((Math.PI * 1681.974450955533) / sampleRate);
  let Q = 0.7071752369554196;
  const Vh = 10 ** (3.999843853973347 / 20);
  const Vb = Vh ** 0.4996667741545416;
  let a0 = 1 + K / Q + K * K;
  const b = [(Vh + (Vb * K) / Q + K * K) / a0, (2 * (K * K - Vh)) / a0, (Vh - (Vb * K) / Q + K * K) / a0];
  const a = [(2 * (K * K - 1)) / a0, (1 - K / Q + K * K) / a0];
  K = Math.tan((Math.PI * 38.13547087602444) / sampleRate);
  Q = 0.5003270373238773;
  a0 = 1 + K / Q + K * K;
  const c = [(2 * (K * K - 1)) / a0, (1 - K / Q + K * K) / a0];
  const out = new Float64Array(input.length);
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  let u1 = 0;
  let u2 = 0;
  for (let index = 0; index < input.length; index++) {
    const x = input[index];
    const y = b[0] * x + b[1] * x1 + b[2] * x2 - a[0] * y1 - a[1] * y2;
    x2 = x1;
    x1 = x;
    y2 = y1;
    y1 = y;
    const v = y - c[0] * u1 - c[1] * u2;
    out[index] = v - 2 * u1 + u2;
    u2 = u1;
    u1 = v;
  }
  return out;
}

/** Gated integrated loudness in LUFS for mono or stereo, or `null` when shorter than one 400 ms block or silent. */
export function integratedLoudness(channels: readonly Float32Array[], sampleRate: number): number | null {
  const frames = channels[0]?.length ?? 0;
  const block = Math.round(0.4 * sampleRate);
  const hop = Math.round(0.1 * sampleRate);
  if (frames < block) return null;
  const weighted = channels.map((channel) => kWeight(channel, sampleRate));
  const prefix = new Float64Array(frames + 1);
  for (let frame = 0; frame < frames; frame++) {
    let energy = 0;
    for (const channel of weighted) energy += channel[frame] * channel[frame];
    prefix[frame + 1] = prefix[frame] + energy;
  }
  const powers: number[] = [];
  for (let start = 0; start + block <= frames; start += hop) powers.push((prefix[start + block] - prefix[start]) / block);
  const lufs = (power: number) => -0.691 + 10 * Math.log10(power);
  const absolute = powers.filter((power) => power > silenceFloor && lufs(power) > -70);
  if (!absolute.length) return null;
  const threshold = lufs(absolute.reduce((sum, power) => sum + power, 0) / absolute.length) - 10;
  const gated = absolute.filter((power) => lufs(power) > threshold);
  return gated.length ? lufs(gated.reduce((sum, power) => sum + power, 0) / gated.length) : null;
}

const seamSeconds = 0.002;
const contextSeconds = 0.05;
const minimumClick = 0.01;
const clickRatio = 4;

/** Compare the largest sample-to-sample step at `frame` with the steps around it. A large ratio suggests a click, or a hard attack placed there. */
export function measureSeam(
  channels: readonly Float32Array[],
  frame: number,
  sampleRate: number,
): { jump: number; localJump: number; hasClick: boolean } {
  const frames = channels[0]?.length ?? 0;
  const near = Math.max(1, Math.round(seamSeconds * sampleRate));
  const context = Math.round(contextSeconds * sampleRate);
  let jump = 0;
  let localJump = 0;
  for (let index = Math.max(1, frame - context); index < Math.min(frames, frame + context); index++) {
    let step = 0;
    for (const channel of channels) step = Math.max(step, Math.abs(channel[index] - channel[index - 1]));
    if (Math.abs(index - frame) <= near) jump = Math.max(jump, step);
    else localJump = Math.max(localJump, step);
  }
  return { jump, localJump, hasClick: jump > minimumClick && jump > localJump * clickRatio };
}
