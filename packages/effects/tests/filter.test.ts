import { describe, expect, it } from "vitest";
import { Filter } from "../src";

/** RMS of a rendered sine through `build`, steady-state (skip the first half). */
async function rmsThrough(freq: number, build: (ctx: OfflineAudioContext) => Filter): Promise<number> {
  const ctx = new OfflineAudioContext(1, 44100, 44100);
  const fx = build(ctx);
  const osc = new OscillatorNode(ctx, { frequency: freq });
  osc.connect(fx.input);
  fx.output.connect(ctx.destination);
  osc.start();
  const d = (await ctx.startRendering()).getChannelData(0);
  let sum = 0;
  const from = d.length / 2;
  for (let i = from; i < d.length; i++) sum += d[i]! * d[i]!;
  return Math.sqrt(sum / (d.length - from));
}
const db = (a: number, b: number) => 20 * Math.log10(a / b);

describe("Filter", () => {
  it("lowpass at 1 kHz passes 100 Hz and attenuates 4 kHz by ≥ 12 dB per stage", async () => {
    const pass = await rmsThrough(100, (ctx) => new Filter(ctx, { frequency: 1000, type: "lowpass" }));
    const cut12 = await rmsThrough(4000, (ctx) => new Filter(ctx, { frequency: 1000, type: "lowpass", rolloff: -12 }));
    const cut24 = await rmsThrough(4000, (ctx) => new Filter(ctx, { frequency: 1000, type: "lowpass", rolloff: -24 }));
    expect(db(pass, Math.SQRT1_2)).toBeGreaterThan(-1);
    expect(db(cut12, Math.SQRT1_2)).toBeLessThan(-20);
    expect(db(cut24, Math.SQRT1_2)).toBeLessThan(db(cut12, Math.SQRT1_2) - 15);
  });
  it("type switches live and frequency ramps are honoured", async () => {
    const hp = await rmsThrough(100, (ctx) => {
      const f = new Filter(ctx, { frequency: 1000 });
      f.params.type.value = "highpass";
      return f;
    });
    expect(db(hp, Math.SQRT1_2)).toBeLessThan(-30);
    const ramped = await rmsThrough(4000, (ctx) => {
      const f = new Filter(ctx, { frequency: 200, type: "lowpass" });
      f.params.frequency.linearRampToValueAtTime(20000, 0.4); // fully open before the measured half
      return f;
    });
    expect(db(ramped, Math.SQRT1_2)).toBeGreaterThan(-1);
  });
  it.each([-12, -24, -48] as const)("reads the rendered wet/dry response at %d dB/octave", async (rolloff) => {
    const hz = 1200;
    const frequencies = Float32Array.of(hz);
    const magnitudes = new Float32Array(1);
    const phases = new Float32Array(1);
    let mixed = 0;
    const actual = await rmsThrough(hz, (ctx) => {
      const filter = new Filter(ctx, { frequency: hz, Q: 0.7, rolloff });
      filter.getFrequencyResponse(frequencies, magnitudes, phases);
      expect(magnitudes[0]).toBeGreaterThan(0);
      filter.params.wet.value = 0;
      filter.getFrequencyResponse(frequencies, magnitudes, phases);
      expect(magnitudes[0]).toBe(1);
      expect(phases[0]).toBeCloseTo(0, 7);
      filter.params.wet.value = 0.5;
      filter.getFrequencyResponse(frequencies, magnitudes, phases);
      expect(Number.isFinite(phases[0])).toBe(true);
      mixed = magnitudes[0];
      return filter;
    });
    expect(actual / Math.SQRT1_2).toBeCloseTo(mixed, 4);
  });
});
