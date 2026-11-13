import { describe, expect, test } from "vitest";
import { peakFrameRange, summarizePeaks } from "../src/peaks";
import type { PCMData } from "../src/peaks";

describe("summarizePeaks", () => {
  test("keeps DC offsets, amplitudes outside unity, and true signed extrema", () => {
    const positive = summarizePeaks({ channels: [new Float32Array([2, 4, 3])], sampleRate: 3 });
    expect(Array.from(positive.min)).toEqual([2]);
    expect(Array.from(positive.max)).toEqual([4]);
    const negative = summarizePeaks({ channels: [new Float32Array([-4, -2, -3])], sampleRate: 3 });
    expect(Array.from(negative.min)).toEqual([-4]);
    expect(Array.from(negative.max)).toEqual([-2]);
  });

  test("merges opposite-sign stereo extrema without channel cancellation", () => {
    const channels = [new Float32Array([1, 2, 3, 4]), new Float32Array([-4, -3, -2, -1])];
    const before = channels.map((channel) => channel.slice());
    const peaks = summarizePeaks({ channels, sampleRate: 4 }, { framesPerPeak: 2 });
    expect(Array.from(peaks.min)).toEqual([-4, -2]);
    expect(Array.from(peaks.max)).toEqual([2, 4]);
    expect(channels).toEqual(before);
    peaks.min[0] = -99;
    peaks.max[0] = 99;
    expect(channels).toEqual(before);
  });

  test("bins fixed source frames, defaults to 128, and retains the final sample", () => {
    const samples = new Float32Array(257).fill(0.5);
    samples[127] = 1;
    samples[128] = -1;
    samples[256] = 8;
    const peaks = summarizePeaks({ channels: [samples], sampleRate: 256 });
    expect(Array.from(peaks.min)).toEqual([0.5, -1, 8]);
    expect(Array.from(peaks.max)).toEqual([1, 0.5, 8]);
    expect(peaks.framesPerPeak).toBe(128);
    expect(peaks.frameCount).toBe(257);
    expect(peaks.sampleRate).toBe(256);
    expect(peaks.duration).toBe(257 / 256);
  });

  test("accepts equally empty channels and produces no artificial bins", () => {
    const peaks = summarizePeaks({ channels: [new Float32Array(), new Float32Array()], sampleRate: 48000 });
    expect(peaks.min).toEqual(new Float32Array());
    expect(peaks.max).toEqual(new Float32Array());
    expect(peaks.frameCount).toBe(0);
    expect(peaks.duration).toBe(0);
  });

  test.each([0, -1, NaN, Infinity, -Infinity])("rejects invalid sampleRate %s", (sampleRate) => {
    expect(() => summarizePeaks({ channels: [new Float32Array()], sampleRate })).toThrow(
      "summarizePeaks: sampleRate must be a finite positive number",
    );
  });

  test.each([0, -1, 0.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1])("rejects invalid framesPerPeak %s", (framesPerPeak) => {
    expect(() => summarizePeaks({ channels: [new Float32Array()], sampleRate: 48000 }, { framesPerPeak })).toThrow(
      "summarizePeaks: framesPerPeak must be a positive safe integer",
    );
  });

  test("rejects missing, unequal, and non-Float32 channels", () => {
    expect(() => summarizePeaks({ channels: [], sampleRate: 48000 })).toThrow("summarizePeaks: at least one channel is required");
    expect(() => summarizePeaks({ channels: [new Float32Array(1), new Float32Array()], sampleRate: 48000 })).toThrow(
      "summarizePeaks: channels must have equal frame counts",
    );
    for (const channel of [[0], new Float64Array(1), new Int16Array(1), undefined]) {
      const pcm = { channels: [new Float32Array(1), channel], sampleRate: 48000 } as unknown as PCMData;
      expect(() => summarizePeaks(pcm)).toThrow("summarizePeaks: every channel must be a Float32Array");
    }
  });

  test.each([NaN, Infinity, -Infinity])("rejects nonfinite samples %s without modifying any input", (invalid) => {
    const channels = [new Float32Array([1, 2, 3]), new Float32Array([4, 5, invalid])];
    const before = channels.map((channel) => channel.slice());
    expect(() => summarizePeaks({ channels, sampleRate: 48000 }, { framesPerPeak: 2 })).toThrow("summarizePeaks: samples must be finite numbers");
    expect(channels).toEqual(before);
  });
});

describe("peakFrameRange", () => {
  test("uses local input coordinates and clamps the final bin", () => {
    const samples = new Float32Array(20).subarray(5, 14);
    const peaks = summarizePeaks({ channels: [samples], sampleRate: 8 }, { framesPerPeak: 4 });
    expect(peakFrameRange(peaks, 0)).toEqual({ startFrame: 0, endFrame: 4, startTime: 0, endTime: 0.5 });
    expect(peakFrameRange(peaks, 1)).toEqual({ startFrame: 4, endFrame: 8, startTime: 0.5, endTime: 1 });
    expect(peakFrameRange(peaks, 2)).toEqual({ startFrame: 8, endFrame: 9, startTime: 1, endTime: 1.125 });
  });

  test.each([-1, 0.5, 1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])("rejects invalid bin index %s", (index) => {
    const peaks = summarizePeaks({ channels: [new Float32Array(1)], sampleRate: 48000 });
    expect(() => peakFrameRange(peaks, index)).toThrow("peakFrameRange: index must identify an existing peak");
  });

  test("has no valid bin for empty PCM", () => {
    const peaks = summarizePeaks({ channels: [new Float32Array()], sampleRate: 48000 });
    expect(() => peakFrameRange(peaks, 0)).toThrow("peakFrameRange: index must identify an existing peak");
  });
});
