import { afterEach, describe, expect, test, vi } from "vitest";
import { commands } from "vitest/browser";
import type { PCMData } from "@audiorective/core/peaks";
import { TimeStretch } from "../src/TimeStretch";

declare module "vitest/browser" {
  interface BrowserCommands {
    timeStretchWasmBytes(): Promise<number[] | null>;
  }
}

const sampleRate = 16000;
const markerTime = 0.85;
// The fixture stays outside the package. Compile in the browser, then pass only
// the caller-supplied module through the public API.
const fixture = await commands.timeStretchWasmBytes();
const module = fixture === null ? null : await WebAssembly.compile(new Uint8Array(fixture));
const unsupported = await WebAssembly.compile(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
const processors: TimeStretch[] = [];
function processor(wasm = module!): TimeStretch {
  const instance = new TimeStretch(wasm);
  processors.push(instance);
  return instance;
}
afterEach(() => {
  for (const instance of processors.splice(0)) instance.dispose();
  vi.unstubAllGlobals();
});

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

describe("TimeStretch validation and worker failures", () => {
  test("requires a compiled module", () => {
    expect(() => new TimeStretch(new Uint8Array() as unknown as WebAssembly.Module)).toThrow("TimeStretch requires a compiled WebAssembly.Module.");
  });

  test("rejects invalid ratios and malformed PCM before dispatch", async () => {
    const stretch = processor(unsupported);
    const valid = { channels: [tone()], sampleRate };
    for (const ratio of [0, -1, NaN, Infinity, Number.MAX_VALUE, 0.000001]) {
      await expect(stretch.process(valid, { ratio })).rejects.toThrow(/ratio/);
    }
    const malformed: PCMData[] = [
      { channels: [], sampleRate },
      { channels: [new Float32Array()], sampleRate },
      { channels: [tone(), new Float32Array(1)], sampleRate },
      { channels: [new Float32Array([0, NaN])], sampleRate },
      { channels: [new Float32Array([0, Infinity])], sampleRate },
      { channels: [new Float32Array([0, -Infinity])], sampleRate },
      { channels: [new Float64Array(1)] as unknown as Float32Array[], sampleRate },
      ...[0, NaN, Infinity, 7999, 192001].map((rate) => ({ channels: [tone()], sampleRate: rate })),
    ];
    for (const input of malformed) await expect(stretch.process(input, { ratio: 1 })).rejects.toThrow();
  });

  test("rejects unsupported WASM ABI cleanly on successive jobs", async () => {
    const stretch = processor(unsupported);
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(stretch.process({ channels: [tone()], sampleRate }, { ratio: 1 })).rejects.toThrow(
        "TimeStretch: unsupported Rubber Band WASM ABI.",
      );
    }
  });

  test("rejects non-increasing or endpoint warp anchors before dispatch", async () => {
    const stretch = processor(unsupported);
    const input = { channels: [tone()], sampleRate };
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
    ])
      await expect(stretch.process(input, { ratio: 1, anchors })).rejects.toThrow(/anchors/);
  });

  test("rejects an already-aborted signal without processing", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(processor(unsupported).process({ channels: [tone()], sampleRate }, { ratio: 1, signal: controller.signal })).rejects.toMatchObject({
      name: "AbortError",
    });
  });
});

describe.skipIf(module === null)("TimeStretch real Rubber Band integration (requires AUDIORECTIVE_RUBBERBAND_WASM)", () => {
  test("moves an interior transient using the same overall duration and pitch", async () => {
    const source = tone(440, sampleRate * 2, true);
    const original = source.slice();
    const outputTime = 1.15;
    const result = await processor().process(
      { sampleRate, channels: [source] },
      {
        ratio: 1,
        anchors: [{ sourceFrame: Math.round(markerTime * sampleRate), outputFrame: Math.round(outputTime * sampleRate) }],
      },
    );
    expect(result.outputFrames).toBe(source.length);
    expect(Math.abs(markerSeconds(result.channels[0]) - outputTime)).toBeLessThanOrEqual(0.06);
    expect(Math.abs(carrierHz(result.channels[0]) - 440)).toBeLessThanOrEqual(10);
    expect(source.every((value, i) => value === original[i])).toBe(true);
  }, 20000);

  test.each([0.75, 1.5])(
    "ratio %s preserves 440 Hz and scales marker timing and exact duration",
    async (ratio) => {
      const input = tone(440, sampleRate * 2, true);
      const result = await processor().process({ channels: [input], sampleRate }, { ratio });
      const expected = Math.round(input.length * ratio);
      expect(result).toMatchObject({ sampleRate, inputFrames: input.length, outputFrames: expected, ratio });
      expect(result.channels).toHaveLength(1);
      expect(result.channels[0].length).toBe(expected);
      expect(result.channels[0].length / sampleRate).toBe(2 * ratio);
      expect(result.channels[0].every(Number.isFinite)).toBe(true);
      expect(Math.abs(carrierHz(result.channels[0]) - 440)).toBeLessThanOrEqual(10);
      expect(Math.abs(markerSeconds(result.channels[0]) - markerTime * ratio)).toBeLessThanOrEqual(0.06);
    },
    20000,
  );

  test.each([0.75, 1.5])(
    "rounds an odd source frame count exactly for ratio %s",
    async (ratio) => {
      const frames = 4097;
      const result = await processor().process({ channels: [tone(440, frames)], sampleRate }, { ratio });
      expect(result.inputFrames).toBe(frames);
      expect(result.outputFrames).toBe(Math.round(frames * ratio));
      expect(result.channels[0].length).toBe(Math.round(frames * ratio));
      expect(result.channels[0].every(Number.isFinite)).toBe(true);
    },
    20000,
  );

  test("preserves stereo separation and the source bytes without any audio nodes", async () => {
    for (const name of ["AudioContext", "OfflineAudioContext", "AudioNode", "GainNode"]) {
      vi.stubGlobal(
        name,
        class {
          constructor() {
            throw new Error(`Unexpected ${name} construction`);
          }
        },
      );
    }
    const channels = [tone(440), tone(660)];
    const originals = channels.map((channel) => channel.slice());
    const originalBuffers = channels.map((channel) => channel.buffer);
    const stretch = processor();
    expect("input" in stretch).toBe(false);
    expect("output" in stretch).toBe(false);
    const result = await stretch.process({ channels, sampleRate }, { ratio: 1.5 });
    expect(channels.map((channel) => channel.buffer)).toEqual(originalBuffers);
    expect(channels).toEqual(originals);
    expect(result.channels).toHaveLength(2);
    expect(result.channels[0].buffer).not.toBe(channels[0].buffer);
    expect(result.channels[1].buffer).not.toBe(channels[1].buffer);
    expect(Math.abs(carrierHz(result.channels[0]) - 440)).toBeLessThanOrEqual(10);
    expect(Math.abs(carrierHz(result.channels[1]) - 660)).toBeLessThanOrEqual(10);
  }, 20000);

  test("takes private source copies before asynchronous worker processing", async () => {
    const source = tone();
    const pending = processor().process({ channels: [source], sampleRate }, { ratio: 1 });
    source.fill(0);
    const result = await pending;
    expect(source.every((sample) => sample === 0)).toBe(true);
    expect(Math.abs(carrierHz(result.channels[0]) - 440)).toBeLessThanOrEqual(10);
  }, 20000);

  test("aborts an in-flight job and accepts a valid job after cancellation and validation failure", async () => {
    const stretch = processor();
    const controller = new AbortController();
    const pending = stretch.process({ channels: [tone(440, sampleRate * 8)], sampleRate }, { ratio: 1.5, signal: controller.signal });
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    await rejected;
    await expect(stretch.process({ channels: [tone()], sampleRate }, { ratio: -1 })).rejects.toThrow();
    const result = await stretch.process({ channels: [tone()], sampleRate }, { ratio: 0.75 });
    expect(result.channels[0].length).toBe(sampleRate * 1.5);
    expect(Math.abs(carrierHz(result.channels[0]) - 440)).toBeLessThanOrEqual(10);
  }, 20000);

  test("dispose rejects all pending jobs and remains idempotent", async () => {
    const stretch = processor();
    const input = { channels: [tone()], sampleRate };
    const pending = Promise.allSettled([stretch.process(input, { ratio: 0.75 }), stretch.process(input, { ratio: 1.5 })]);
    stretch.dispose();
    stretch.dispose();
    for (const result of await pending) {
      expect(result.status).toBe("rejected");
      if (result.status === "rejected") expect(result.reason.message).toBe("TimeStretch is disposed.");
    }
    await expect(stretch.process(input, { ratio: 1 })).rejects.toThrow("TimeStretch is disposed.");
  });

  test("concurrent jobs keep ratios, channels, and cancellation independent", async () => {
    const stretch = processor();
    const controller = new AbortController();
    const cancelled = stretch.process({ channels: [tone(880)], sampleRate }, { ratio: 2, signal: controller.signal });
    const cancellation = expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
    const pending = Promise.all([
      stretch.process({ channels: [tone(440)], sampleRate }, { ratio: 0.75 }),
      stretch.process({ channels: [tone(660)], sampleRate }, { ratio: 1.5 }),
    ]);
    controller.abort();
    const [short, long] = await pending;
    await cancellation;
    expect(short.outputFrames).toBe(sampleRate * 1.5);
    expect(long.outputFrames).toBe(sampleRate * 3);
    expect(short.channels[0].length).toBe(short.outputFrames);
    expect(long.channels[0].length).toBe(long.outputFrames);
    expect(Math.abs(carrierHz(short.channels[0]) - 440)).toBeLessThanOrEqual(10);
    expect(Math.abs(carrierHz(long.channels[0]) - 660)).toBeLessThanOrEqual(10);
  }, 20000);
});
