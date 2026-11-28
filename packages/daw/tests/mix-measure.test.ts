import { describe, expect, it } from "vitest";
import { integratedLoudness, measureSeam, peakDbFS } from "../src/internal/mix-measure";

const sine = (frames: number, rate: number, frequency: number, amplitude: number) =>
  Float32Array.from({ length: frames }, (_, index) => amplitude * Math.sin((2 * Math.PI * frequency * index) / rate));

describe("mix measurements", () => {
  it.each([44_100, 48_000, 96_000])("reads the EBU stereo reference tone as -23 LUFS at %i Hz", (rate) => {
    const tone = sine(rate * 5, rate, 1000, 10 ** (-23 / 20));
    expect(integratedLoudness([tone, tone], rate)).toBeCloseTo(-23, 1);
  });

  it("gates out silence between tones", () => {
    const rate = 48_000;
    const tone = sine(rate * 2, rate, 1000, 10 ** (-23 / 20));
    const gapped = new Float32Array(rate * 6);
    gapped.set(tone, 0);
    gapped.set(tone, rate * 4);
    expect(integratedLoudness([gapped, gapped], rate)).toBeCloseTo(-23, 0);
  });

  it("reports no loudness for silence or under one block, and no peak for silence", () => {
    expect(integratedLoudness([new Float32Array(48_000)], 48_000)).toBeNull();
    expect(integratedLoudness([sine(1000, 48_000, 1000, 0.5)], 48_000)).toBeNull();
    expect(peakDbFS([new Float32Array(10)])).toBeNull();
    expect(peakDbFS([Float32Array.of(0, -0.5, 0.25)])).toBeCloseTo(-6.02, 2);
  });

  it("flags a discontinuity and leaves a continuous tone alone", () => {
    const rate = 48_000;
    const smooth = sine(rate, rate, 440, 0.5);
    expect(measureSeam([smooth], 24_000, rate).hasClick).toBe(false);
    const broken = smooth.slice();
    broken.fill(0, 24_000);
    broken.set(
      sine(24_000, rate, 440, 0.5).map((value) => value + 0.4),
      24_000,
    );
    expect(measureSeam([broken], 24_000, rate).hasClick).toBe(true);
    expect(measureSeam([new Float32Array(rate)], 24_000, rate)).toEqual({ jump: 0, localJump: 0, hasClick: false });
  });
});
