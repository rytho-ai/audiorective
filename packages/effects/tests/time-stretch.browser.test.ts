import { afterEach, describe, expect, test, vi } from "vitest";
import { commands } from "vitest/browser";
import { TimeStretch } from "../src/TimeStretch";

declare module "vitest/browser" {
  interface BrowserCommands {
    timeStretchWasmBytes(): Promise<number[] | null>;
  }
}

const sampleRate = 16000;
const markerTime = 0.85;
// The fixture stays outside the package: served to `TimeStretch.load` from a blob URL.
const fixture = await commands.timeStretchWasmBytes();
const blobUrl = (bytes: Uint8Array) => URL.createObjectURL(new Blob([bytes as BlobPart], { type: "application/wasm" }));
const wasmUrl = fixture === null ? null : blobUrl(new Uint8Array(fixture));
const unsupportedUrl = blobUrl(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
const processors: TimeStretch[] = [];
async function processor(url: string = wasmUrl!): Promise<TimeStretch> {
  const instance = await TimeStretch.load({ wasmUrl: url });
  processors.push(instance);
  return instance;
}
afterEach(() => {
  for (const instance of processors.splice(0)) instance.dispose();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** An AudioBuffer over copies of `channels`. */
function buffer(channels: Float32Array[], rate = sampleRate): AudioBuffer {
  const out = new AudioBuffer({ length: channels[0]!.length, numberOfChannels: channels.length, sampleRate: rate });
  channels.forEach((channel, c) => out.copyToChannel(channel as Float32Array<ArrayBuffer>, c));
  return out;
}

function tone(frequency = 440, frames = sampleRate * 2, marker = false): Float32Array {
  return Float32Array.from({ length: frames }, (_, frame) => {
    const time = frame / sampleRate;
    const envelope = marker ? 0.12 + 0.7 * Math.exp(-0.5 * ((time - markerTime) / 0.012) ** 2) : 0.2;
    return envelope * Math.sin(2 * Math.PI * frequency * time);
  });
}

// Count positive crossings over a sustained, marker-free interior region. This
// independently measures pitch without depending on an AudioContext or FFT API.
function carrierHz(samples: Float32Array): number {
  const start = Math.round(sampleRate * 0.15);
  const end = Math.round(sampleRate * 0.45);
  let crossings = 0;
  for (let i = start; i < end; i++) if (samples[i] <= 0 && samples[i + 1] > 0) crossings++;
  return (crossings * sampleRate) / (end - start);
}

function markerSeconds(samples: Float32Array): number {
  const width = Math.round(sampleRate * 0.016);
  let energy = 0;
  let bestEnergy = -Infinity;
  let bestCenter = 0;
  for (let frame = 0; frame < samples.length; frame++) {
    energy += samples[frame] ** 2;
    if (frame >= width) energy -= samples[frame - width] ** 2;
    if (frame >= width - 1 && energy > bestEnergy) {
      bestEnergy = energy;
      bestCenter = frame + 1 - width / 2;
    }
  }
  return bestCenter / sampleRate;
}

describe("TimeStretch.load", () => {
  test("fetches and compiles once per URL", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const url = blobUrl(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
    const [a, b] = await Promise.all([TimeStretch.load({ wasmUrl: url }), TimeStretch.load({ wasmUrl: url })]);
    await TimeStretch.load({ wasmUrl: url });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    a.dispose();
    b.dispose();
  });

  test("rejects when the file cannot be fetched or compiled, and a retry fetches again", async () => {
    const url = blobUrl(new Uint8Array([1, 2, 3]));
    await expect(TimeStretch.load({ wasmUrl: url })).rejects.toThrow();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await expect(TimeStretch.load({ wasmUrl: url })).rejects.toThrow();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  test("an aborted signal rejects with AbortError", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(TimeStretch.load({ wasmUrl: unsupportedUrl, signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("TimeStretch validation and worker failures", () => {
  test("rejects invalid ratios and non-finite samples before dispatch", async () => {
    const stretch = await processor(unsupportedUrl);
    const valid = buffer([tone()]);
    for (const ratio of [0, -1, NaN, Infinity, Number.MAX_VALUE, 0.000001]) {
      await expect(stretch.process(valid, { ratio })).rejects.toThrow(/ratio/);
    }
    for (const bad of [NaN, Infinity, -Infinity])
      await expect(stretch.process(buffer([new Float32Array([0, bad])]), { ratio: 1 })).rejects.toThrow(/finite/);
  });

  test("rejects unsupported WASM ABI cleanly on successive jobs", async () => {
    const stretch = await processor(unsupportedUrl);
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(stretch.process(buffer([tone()]), { ratio: 1 })).rejects.toThrow("TimeStretch: unsupported Rubber Band WASM ABI.");
    }
  });

  test("rejects non-increasing or endpoint warp anchors before dispatch", async () => {
    const stretch = await processor(unsupportedUrl);
    const input = buffer([tone()]);
    for (const anchors of [
      [{ sourceFrame: 0, outputFrame: 400 }],
      [{ sourceFrame: 300, outputFrame: sampleRate * 2 }],
      [
        { sourceFrame: 300, outputFrame: 800 },
        { sourceFrame: 400, outputFrame: 400 },
      ],
      [
        { sourceFrame: 400, outputFrame: 800 },
        { sourceFrame: 400, outputFrame: 900 },
      ],
      [{ sourceFrame: 0.5, outputFrame: 900 }],
    ]) {
      await expect(stretch.process(input, { ratio: 1, anchors })).rejects.toThrow(/anchors/);
      await expect(stretch.process(input, { ratio: 1, anchors, loop: true })).rejects.toThrow(/anchors/);
    }
  });

  test("an already-aborted signal rejects with AbortError without processing", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect((await processor(unsupportedUrl)).process(buffer([tone()]), { ratio: 1, signal: controller.signal })).rejects.toMatchObject({
      name: "AbortError",
    });
  });

  test("a failed job is not an AbortError", async () => {
    const stretch = await processor(unsupportedUrl);
    const error = await stretch.process(buffer([tone()]), { ratio: 1 }).catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).not.toBe("AbortError");
  });

  test("dispose rejects pending jobs with AbortError and later calls throw", async () => {
    const stretch = await processor(unsupportedUrl);
    const pending = stretch.process(buffer([tone()]), { ratio: 1 });
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError", message: "TimeStretch is disposed." });
    stretch.dispose();
    stretch.dispose();
    await rejected;
    await expect(stretch.process(buffer([tone()]), { ratio: 1 })).rejects.toThrow("TimeStretch is disposed.");
  });
});

describe.skipIf(wasmUrl === null)("TimeStretch real Rubber Band integration (requires AUDIORECTIVE_RUBBERBAND_WASM)", () => {
  test("moves an interior transient using the same overall duration and pitch", async () => {
    const source = tone(440, sampleRate * 2, true);
    const outputTime = 1.15;
    const result = await (
      await processor()
    ).process(buffer([source]), {
      ratio: 1,
      anchors: [{ sourceFrame: Math.round(markerTime * sampleRate), outputFrame: Math.round(outputTime * sampleRate) }],
    });
    expect(result.length).toBe(source.length);
    expect(Math.abs(markerSeconds(result.getChannelData(0)) - outputTime)).toBeLessThanOrEqual(0.06);
    expect(Math.abs(carrierHz(result.getChannelData(0)) - 440)).toBeLessThanOrEqual(10);
  }, 20000);

  test.each([0.75, 1.5])(
    "ratio %s preserves 440 Hz and scales marker timing and exact duration",
    async (ratio) => {
      const input = tone(440, sampleRate * 2, true);
      const result = await (await processor()).process(buffer([input]), { ratio });
      const expected = Math.round(input.length * ratio);
      expect(result).toBeInstanceOf(AudioBuffer);
      expect(result.sampleRate).toBe(sampleRate);
      expect(result.numberOfChannels).toBe(1);
      expect(result.length).toBe(expected);
      expect(result.duration).toBe(2 * ratio);
      expect(result.getChannelData(0).every(Number.isFinite)).toBe(true);
      expect(Math.abs(carrierHz(result.getChannelData(0)) - 440)).toBeLessThanOrEqual(10);
      expect(Math.abs(markerSeconds(result.getChannelData(0)) - markerTime * ratio)).toBeLessThanOrEqual(0.06);
    },
    20000,
  );

  test("loop: true renders exactly one cycle that wraps without a seam", async () => {
    // 5 whole periods of 400 Hz: the loop wraps with no discontinuity, so the stretched one must too.
    const frames = sampleRate / 2;
    const input = Float32Array.from({ length: frames }, (_, i) => 0.5 * Math.sin((2 * Math.PI * 400 * i) / sampleRate));
    const ratio = 1.25;
    const result = await (await processor()).process(buffer([input]), { ratio, loop: true });
    const out = result.getChannelData(0);
    expect(out.length).toBe(Math.round(frames * ratio));
    let inner = 0;
    for (let i = 1; i < out.length; i++) inner = Math.max(inner, Math.abs(out[i]! - out[i - 1]!));
    expect(Math.abs(out[0]! - out[out.length - 1]!)).toBeLessThanOrEqual(inner * 1.5);
  }, 20000);

  test("preserves stereo separation and never detaches the source buffer", async () => {
    const input = buffer([tone(440), tone(660)]);
    const before = [input.getChannelData(0).slice(), input.getChannelData(1).slice()];
    const result = await (await processor()).process(input, { ratio: 1.5 });
    expect(result.numberOfChannels).toBe(2);
    expect(input.getChannelData(0)).toEqual(before[0]);
    expect(input.getChannelData(1)).toEqual(before[1]);
    expect(Math.abs(carrierHz(result.getChannelData(0)) - 440)).toBeLessThanOrEqual(10);
    expect(Math.abs(carrierHz(result.getChannelData(1)) - 660)).toBeLessThanOrEqual(10);
  }, 20000);

  test("aborts an in-flight job and accepts a valid job afterwards", async () => {
    const stretch = await processor();
    const controller = new AbortController();
    const pending = stretch.process(buffer([tone(440, sampleRate * 8)]), { ratio: 1.5, signal: controller.signal });
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    await rejected;
    const result = await stretch.process(buffer([tone()]), { ratio: 0.75 });
    expect(result.length).toBe(sampleRate * 1.5);
  }, 20000);
});
