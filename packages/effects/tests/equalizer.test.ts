import { expect, test } from "vitest";
import { Equalizer } from "../src";

const settings = [
  { frequency: 250, gain: -3, q: 0.7 },
  { frequency: 1000, gain: 6, q: 1 },
  { frequency: 4000, gain: 0, q: 0.8 },
];

async function render(frequency: number, wet: number) {
  const context = new OfflineAudioContext(1, 48_000, 48_000);
  const eq = new Equalizer(context, { bands: settings, wet });
  const mag = new Float32Array(1),
    phase = new Float32Array(1);
  eq.getFrequencyResponse(Float32Array.of(frequency), mag, phase);
  const oscillator = new OscillatorNode(context, { frequency });
  oscillator.connect(eq.input);
  eq.output.connect(context.destination);
  oscillator.start();
  const values = (await context.startRendering()).getChannelData(0).subarray(24_000);
  const heard = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0) / values.length) / Math.SQRT1_2;
  eq.dispose();
  return { heard, predicted: mag[0] };
}

test("standalone equalizer matches rendered full and mixed responses", async () => {
  const [low, middle, high, mixed] = await Promise.all([render(250, 1), render(1000, 1), render(8000, 1), render(500, 0.5)]);
  for (const sample of [low, middle, high, mixed]) expect(sample.heard).toBeCloseTo(sample.predicted, 4);
  expect(20 * Math.log10(low.heard)).toBeLessThan(-1);
  expect(20 * Math.log10(middle.heard)).toBeGreaterThan(5);
  expect(20 * Math.log10(high.heard)).toBeCloseTo(0, 0);
});

test("prevalidates full band edits and keeps their schedulable Params stable", () => {
  const context = new OfflineAudioContext(1, 1024, 48_000);
  const eq = new Equalizer(context, { bands: settings });
  const initial = eq.bands[0].frequency;
  eq.setBands(settings.map((band, index) => (index ? band : { ...band, frequency: 500 })));
  expect(eq.bands[0].frequency).toBe(initial);
  expect(initial.value).toBe(500);
  expect(() => eq.setBands([{ ...settings[0], frequency: 100 }, ...settings.slice(1, 2)])).toThrow(/count/);
  expect(() => eq.setBands([{ ...settings[0], frequency: 100 }, ...settings.slice(1, 2), { ...settings[2], gain: 30 }])).toThrow(/valid bands/);
  expect(initial.value).toBe(500);
  eq.dispose();
});

test("band Params are also registered in params", () => {
  const context = new OfflineAudioContext(1, 1024, 48_000);
  const eq = new Equalizer(context, { bands: settings });
  settings.forEach((_, i) => {
    expect(eq.params[`band${i}Frequency`]).toBe(eq.bands[i].frequency);
    expect(eq.params[`band${i}Gain`]).toBe(eq.bands[i].gain);
    expect(eq.params[`band${i}Q`]).toBe(eq.bands[i].q);
  });
  eq.setBands(settings.map((band) => ({ ...band, gain: 1 })));
  expect(eq.params.band1Gain.value).toBe(1);
  expect(eq.params.wet.value).toBe(1);
  eq.dispose();
});
