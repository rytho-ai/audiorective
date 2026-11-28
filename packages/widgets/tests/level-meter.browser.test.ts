import { cell, effect } from "@audiorective/core";
import { afterEach, expect, test, vi } from "vitest";
import { mountLevelMeter, type LevelMeterHandle } from "../src/level-meter";
import { cleanup, host, own } from "./helpers";

afterEach(cleanup);

test("a tracked dBFS peak is displayed directly without inventing RMS", async () => {
  const peak = cell(-20);
  const meter = mountLevelMeter(host(), { source: () => peak.value });
  own(() => meter.dispose());

  expect(meter.getLevel().peak).toBeCloseTo(0.1, 12);
  expect(meter.getLevel().rms).toBeNull();
  expect(meter.element.textContent).toContain("-20.0");
  expect(meter.element.textContent).not.toContain("RMS");

  peak.value = -Infinity;
  await new Promise(requestAnimationFrame);
  expect(meter.getLevel()).toEqual({ peak: 0, rms: null });
  expect(meter.element.dataset.overload).toBe("false");

  peak.value = 0;
  await new Promise(requestAnimationFrame);
  expect(meter.getLevel()).toEqual({ peak: 1, rms: null });
  expect(meter.element.dataset.overload).toBe("true");

  peak.value = 6.020599913279624;
  await new Promise(requestAnimationFrame);
  expect(meter.getLevel().peak).toBeCloseTo(2, 12);
  expect(meter.element.querySelector("meter")!.value).toBe(1);
});

test("genuine rendered PCM retains measured RMS and unclipped float peaks", async () => {
  const context = new OfflineAudioContext(1, 128, 48_000);
  const source = new ConstantSourceNode(context, { offset: -1.25 });
  source.connect(context.destination);
  source.start();
  const buffer = await context.startRendering();
  let reads = 0;
  const meter = mountLevelMeter(host(), {
    source: {
      sampleCount: buffer.length,
      read(samples) {
        reads++;
        buffer.copyFromChannel(samples, 0);
      },
    },
  });
  own(() => meter.dispose());
  expect(meter.getLevel()).toEqual({ peak: 1.25, rms: 1.25 });
  expect(meter.element.dataset.overload).toBe("true");
  expect(meter.element.textContent).toContain("RMS 1.9 dBFS");
  meter.dispose();
  meter.dispose();
  const before = reads;
  await new Promise(requestAnimationFrame);
  expect(reads).toBe(before);
  expect(meter.element.isConnected).toBe(false);
  expect(buffer.getChannelData(0)[0]).toBe(-1.25);
});

test("a dBFS view owns its sampling loop and releases it without disposing the source", async () => {
  const peak = cell(-20);
  const trigger = cell(0);
  const read = vi.fn(() => peak.value);
  const root = host();
  let meter: LevelMeterHandle | undefined;
  const stopMount = effect(() => {
    void trigger.value;
    meter ??= mountLevelMeter(root, { source: read });
  });
  own(stopMount);
  own(() => meter?.dispose());
  trigger.value = 1;
  stopMount();
  peak.value = 0;
  await new Promise(requestAnimationFrame);
  expect(meter!.getLevel()).toEqual({ peak: 1, rms: null });
  meter!.dispose();
  const before = read.mock.calls.length;
  peak.value = -10;
  await new Promise(requestAnimationFrame);
  expect(read).toHaveBeenCalledTimes(before);
  expect(peak.value).toBe(-10);
  expect(meter!.element.isConnected).toBe(false);
});

test("PCM readers receive their requested buffer size and invalid sizes retain the public error", () => {
  const lengths: number[] = [];
  const meter = mountLevelMeter(host(), { source: { read: (samples) => lengths.push(samples.length) } });
  own(() => meter.dispose());
  expect(lengths[0]).toBe(2048);
  for (const sampleCount of [0, -1, 1.5, Infinity, NaN])
    expect(() => mountLevelMeter(host(), { source: { read: () => {}, sampleCount } })).toThrow(
      "Level meter sample count must be a positive integer.",
    );
});

test("an ordinary dBFS callback is sampled on each frame and stops after disposal", async () => {
  let peak = -20;
  const read = vi.fn(() => peak);
  const meter = mountLevelMeter(host(), { source: read });
  own(() => meter.dispose());
  expect(meter.getLevel()).toEqual({ peak: 0.1, rms: null });
  peak = 0;
  await new Promise(requestAnimationFrame);
  expect(meter.getLevel()).toEqual({ peak: 1, rms: null });
  const before = read.mock.calls.length;
  await new Promise(requestAnimationFrame);
  expect(read.mock.calls.length).toBeGreaterThan(before);
  meter.dispose();
  const after = read.mock.calls.length;
  await new Promise(requestAnimationFrame);
  expect(read).toHaveBeenCalledTimes(after);
});

test.each([
  { dbfs: NaN, peak: 0, overload: "false" },
  { dbfs: Infinity, peak: 1, overload: "true" },
  { dbfs: -Infinity, peak: 0, overload: "false" },
])("a non-finite dBFS callback ($dbfs) has a safe visible level", ({ dbfs, peak, overload }) => {
  const meter = mountLevelMeter(host(), { source: () => dbfs });
  own(() => meter.dispose());
  expect(meter.getLevel()).toEqual({ peak, rms: null });
  expect(meter.element.querySelector("meter")!.value).toBe(peak);
  expect(meter.element.dataset.overload).toBe(overload);
});
