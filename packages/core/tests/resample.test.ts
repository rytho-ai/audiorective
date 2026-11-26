import { describe, expect, test } from "vitest";
import { resamplePCM } from "../src/resample";
import type { PCMData } from "../src/peaks";

const sine = (rate: number, hz: number, seconds: number, amp = 0.5): PCMData => ({
  sampleRate: rate,
  channels: [Float32Array.from({ length: Math.round(rate * seconds) }, (_, n) => amp * Math.sin((2 * Math.PI * hz * n) / rate))],
});

/** Least-squares fit of a sine at `hz` over a middle window; returns its amplitude and the residual (THD+N) relative to it, in dB. */
function fit(x: Float32Array, rate: number, hz: number, from: number, to: number) {
  let sc = 0;
  let ss = 0;
  let cc = 0;
  let xc = 0;
  let xs = 0;
  for (let n = from; n < to; n++) {
    const c = Math.cos((2 * Math.PI * hz * n) / rate);
    const s = Math.sin((2 * Math.PI * hz * n) / rate);
    cc += c * c;
    ss += s * s;
    sc += s * c;
    xc += x[n] * c;
    xs += x[n] * s;
  }
  const det = cc * ss - sc * sc;
  const a = (xc * ss - xs * sc) / det;
  const b = (xs * cc - xc * sc) / det;
  let residual = 0;
  let power = 0;
  for (let n = from; n < to; n++) {
    const fitted = a * Math.cos((2 * Math.PI * hz * n) / rate) + b * Math.sin((2 * Math.PI * hz * n) / rate);
    residual += (x[n] - fitted) ** 2;
    power += fitted ** 2;
  }
  return { amplitude: Math.hypot(a, b), thdn: 10 * Math.log10(residual / power) };
}

describe("resamplePCM", () => {
  for (const hz of [1000, 18_000]) {
    test(`${hz} Hz through 44.1k to 48k keeps its level within 0.1 dB and THD+N below -80 dB`, () => {
      const out = resamplePCM(sine(44_100, hz, 1), 48_000);
      const { amplitude, thdn } = fit(out.channels[0], 48_000, hz, 2000, 46_000);
      expect(Math.abs(20 * Math.log10(amplitude / 0.5))).toBeLessThan(0.1);
      expect(thdn).toBeLessThan(-80);
    });
  }

  test("a 30 kHz component in a 96k source is attenuated more than 60 dB going to 48k", () => {
    const out = resamplePCM(sine(96_000, 30_000, 1, 1), 48_000);
    let peak = 0;
    for (let n = 2000; n < 46_000; n++) peak = Math.max(peak, Math.abs(out.channels[0][n]));
    expect(20 * Math.log10(peak)).toBeLessThan(-60);
  });

  test("a click at input time t lands at round(t * target) for every ratio", () => {
    for (const [from, to] of [
      [44_100, 48_000],
      [48_000, 44_100],
      [22_050, 48_000],
      [96_000, 48_000],
    ]) {
      const channel = new Float32Array(from * 2);
      const at = Math.round(from * 0.5);
      channel[at] = 1;
      const out = resamplePCM({ sampleRate: from, channels: [channel] }, to).channels[0];
      const peak = out.reduce((best, v, i) => (Math.abs(v) > Math.abs(out[best]) ? i : best), 0);
      expect(peak).toBe(Math.round((at * to) / from));
    }
  });

  test("length is round(frames * target / source); stereo channels stay separate; empty input works", () => {
    const left = Float32Array.from({ length: 1001 }, (_, i) => Math.sin(i / 10));
    const out = resamplePCM({ sampleRate: 44_100, channels: [left, new Float32Array(1001)] }, 48_000);
    expect(out.sampleRate).toBe(48_000);
    expect(out.channels.map((c) => c.length)).toEqual([1090, 1090]);
    expect(out.channels[1].every((v) => v === 0)).toBe(true);
    expect(resamplePCM({ sampleRate: 44_100, channels: [new Float32Array(0)] }, 48_000).channels[0].length).toBe(0);
  });

  test("edges are finite (zero padded) and a constant keeps its level away from the ends", () => {
    const out = resamplePCM({ sampleRate: 44_100, channels: [new Float32Array(4000).fill(0.25)] }, 48_000).channels[0];
    expect(out.every(Number.isFinite)).toBe(true);
    expect(out[2000]).toBeCloseTo(0.25, 4);
  });

  test("equal rates return a copy", () => {
    const pcm = { sampleRate: 48_000, channels: [Float32Array.of(1, 2, 3)] };
    const out = resamplePCM(pcm, 48_000);
    expect(out.channels[0]).toEqual(pcm.channels[0]);
    expect(out.channels[0]).not.toBe(pcm.channels[0]);
  });

  test("a non-integer rate reads an interpolated table and still resamples accurately", () => {
    const out = resamplePCM(sine(44_100, 1000, 0.5), 47_999.5);
    const { thdn } = fit(out.channels[0], 47_999.5, 1000, 1500, 22_000);
    expect(thdn).toBeLessThan(-80);
  });

  test("rejects bad rates, channel lengths and quality", () => {
    const pcm = { sampleRate: 44_100, channels: [new Float32Array(10)] };
    expect(() => resamplePCM(pcm, 0)).toThrow("resamplePCM: targetRate must be a finite positive number");
    expect(() => resamplePCM({ ...pcm, sampleRate: NaN }, 48_000)).toThrow("resamplePCM: sampleRate must be a finite positive number");
    expect(() => resamplePCM({ sampleRate: 44_100, channels: [new Float32Array(2), new Float32Array(3)] }, 48_000)).toThrow(
      "resamplePCM: channels must have equal frame counts",
    );
    expect(() => resamplePCM(pcm, 48_000, { quality: "x" as never })).toThrow('resamplePCM: quality must be "fast", "standard" or "high"');
  });

  test("speed: 4 minutes of stereo 44.1k to 48k", () => {
    const n = 44_100 * 240;
    const ch = () => Float32Array.from({ length: n }, (_, i) => Math.sin(i * 0.01));
    const pcm = { sampleRate: 44_100, channels: [ch(), ch()] };
    const start = performance.now();
    resamplePCM(pcm, 48_000);
    const ms = performance.now() - start;
    console.log(`resamplePCM 4 min stereo 44.1k->48k: ${Math.round(ms)} ms`);
    expect(ms).toBeLessThan(8000);
  });
});
