import { describe, expect, test } from "vitest";
import { encodeWav, encodeWavBytes } from "../src/wav";
import * as root from "../src";
import * as peaks from "../src/peaks";

type Decoded = {
  format: number;
  channels: number;
  sampleRate: number;
  byteRate: number;
  blockAlign: number;
  bits: number;
  samples: Float32Array[];
  size: number;
};

/** An independent decoder: reads the 44-byte header and de-interleaves. */
function decode(bytes: Uint8Array): Decoded {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ascii = (at: number) => String.fromCharCode(...bytes.subarray(at, at + 4));
  expect([ascii(0), ascii(8), ascii(12), ascii(36)]).toEqual(["RIFF", "WAVE", "fmt ", "data"]);
  const format = view.getUint16(20, true);
  const channels = view.getUint16(22, true);
  const bits = view.getUint16(34, true);
  const dataBytes = view.getUint32(40, true);
  expect(view.getUint32(4, true)).toBe(36 + dataBytes + (dataBytes & 1));
  expect(bytes.length).toBe(44 + dataBytes + (dataBytes & 1));
  const frames = dataBytes / (channels * (bits / 8));
  const samples = Array.from({ length: channels }, () => new Float32Array(frames));
  let at = 44;
  for (let f = 0; f < frames; f++)
    for (let c = 0; c < channels; c++) {
      if (bits === 32) samples[c]![f] = view.getFloat32(at, true);
      else if (bits === 16) samples[c]![f] = view.getInt16(at, true) / 32768;
      else samples[c]![f] = (((bytes[at]! | (bytes[at + 1]! << 8) | (bytes[at + 2]! << 16)) << 8) >> 8) / 8388608;
      at += bits / 8;
    }
  return {
    format,
    channels,
    sampleRate: view.getUint32(24, true),
    byteRate: view.getUint32(28, true),
    blockAlign: view.getUint16(32, true),
    bits,
    samples,
    size: bytes.length,
  };
}

const pcm = {
  sampleRate: 48000,
  channels: [Float32Array.of(0, 0.5, -0.5, 1, -1), Float32Array.of(0.25, -0.25, 0.125, 0, 0.75)],
};

describe("encodeWav", () => {
  test("is exported from the root only, not from the peaks entry", () => {
    expect(root.encodeWav).toBe(encodeWav);
    expect(root.encodeWavBytes).toBe(encodeWavBytes);
    expect(Object.keys(peaks).sort()).toEqual(["peakFrameRange", "summarizePeaks"]);
  });

  test("defaults to 16-bit PCM with a canonical header", async () => {
    const blob = encodeWav(pcm);
    expect(blob.type).toBe("audio/wav");
    const wav = decode(new Uint8Array(await blob.arrayBuffer()));
    expect(wav).toMatchObject({ format: 1, channels: 2, sampleRate: 48000, byteRate: 48000 * 4, blockAlign: 4, bits: 16, size: 44 + 5 * 4 });
  });

  test.each([
    [16, 1 / 32767],
    [24, 1 / 8388607],
    [32, 0],
  ] as const)("%i-bit round-trips within one step", (bitDepth, tolerance) => {
    const wav = decode(encodeWavBytes(pcm, { bitDepth }));
    expect(wav.format).toBe(bitDepth === 32 ? 3 : 1);
    expect(wav.bits).toBe(bitDepth);
    expect(wav.byteRate).toBe(48000 * 2 * (bitDepth / 8));
    pcm.channels.forEach((channel, c) => channel.forEach((v, f) => expect(Math.abs(wav.samples[c]![f]! - v)).toBeLessThanOrEqual(tolerance + 1e-9)));
  });

  test("32-bit keeps samples outside +-1 while integer depths clamp", () => {
    const hot = { sampleRate: 8000, channels: [Float32Array.of(2, -3, 0.5)] };
    expect(Array.from(decode(encodeWavBytes(hot, { bitDepth: 32 })).samples[0]!)).toEqual([2, -3, 0.5]);
    expect(decode(encodeWavBytes(hot, { bitDepth: 16 })).samples[0]![0]).toBeCloseTo(32767 / 32768, 6);
    expect(decode(encodeWavBytes(hot, { bitDepth: 16 })).samples[0]![1]).toBe(-1);
    expect(decode(encodeWavBytes(hot, { bitDepth: 24 })).samples[0]![1]).toBe(-1);
  });

  test("interleaves any channel count and accepts empty audio", () => {
    const six = { sampleRate: 44100, channels: Array.from({ length: 6 }, (_, c) => Float32Array.of(c / 10, -c / 10)) };
    const wav = decode(encodeWavBytes(six, { bitDepth: 32 }));
    expect(wav.channels).toBe(6);
    expect(wav.blockAlign).toBe(24);
    six.channels.forEach((channel, c) => expect(Array.from(wav.samples[c]!)).toEqual(Array.from(channel)));
    expect(decode(encodeWavBytes({ sampleRate: 44100, channels: [new Float32Array(0)] })).size).toBe(44);
  });

  test("writes 24-bit values as three little-endian bytes", () => {
    const bytes = encodeWavBytes({ sampleRate: 8000, channels: [Float32Array.of(1, -1)] }, { bitDepth: 24 });
    expect(Array.from(bytes.subarray(44))).toEqual([0xff, 0xff, 0x7f, 0x00, 0x00, 0x80]);
  });

  test("rejects invalid input with documented errors", () => {
    const ok = Float32Array.of(0);
    expect(() => encodeWav({ sampleRate: NaN, channels: [ok] })).toThrow("encodeWav: sampleRate must be a finite positive number");
    expect(() => encodeWav({ sampleRate: 0, channels: [ok] })).toThrow("encodeWav: sampleRate must be a finite positive number");
    expect(() => encodeWav({ sampleRate: 8000, channels: [] })).toThrow("encodeWav: at least one channel is required");
    expect(() => encodeWav({ sampleRate: 8000, channels: [ok, new Float32Array(2)] })).toThrow("encodeWav: channels must have equal frame counts");
    expect(() => encodeWav({ sampleRate: 8000, channels: [ok] }, { bitDepth: 8 as 16 })).toThrow("encodeWav: bitDepth must be 16, 24 or 32");
  });
});

describe("encodeWavBytes odd-sized data chunk", () => {
  test("pads a 24-bit mono single frame to an even length without changing the data size", () => {
    const bytes = encodeWavBytes({ sampleRate: 48_000, channels: [Float32Array.of(0.5)] }, { bitDepth: 24 });
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(bytes.length).toBe(48);
    expect(view.getUint32(4, true)).toBe(40);
    expect(view.getUint32(40, true)).toBe(3);
    expect(bytes[47]).toBe(0);
  });
});
