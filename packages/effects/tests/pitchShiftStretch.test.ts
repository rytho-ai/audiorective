import { describe, expect, it, vi } from "vitest";
import { PitchShift } from "../src";
import { dominantHz, renderShift } from "./helpers/spectrum";

describe("PitchShift (stretch)", () => {
  it("+12 semitones doubles the dominant frequency within one bin", async () => {
    const f = await renderShift((ctx) => new PitchShift(ctx, { pitch: 12, engine: "stretch" }));
    expect(Math.abs(dominantHz(f, 44100) - 880)).toBeLessThanOrEqual(5);
  });
  it("reports isReady after load and a positive latency the graph adopts", async () => {
    const ctx = new OfflineAudioContext(2, 4096, 44100);
    const fx = new PitchShift(ctx, { engine: "stretch", stretch: { blockMs: 40 } });
    expect(fx.cells.isReady.value).toBe(false);
    await fx.ready;
    expect(fx.cells.isReady.value).toBe(true);
    expect(fx.latency.value).toBeGreaterThan(0);
    expect(fx.latency.value).toBeLessThan(0.2 * 44100);
  });
  it("disposing before ready resolves leaves isReady false", async () => {
    const ctx = new OfflineAudioContext(2, 4096, 44100);
    const fx = new PitchShift(ctx, { engine: "stretch", stretch: { blockMs: 40 } });
    fx.dispose();
    await fx.ready;
    expect(fx.cells.isReady.value).toBe(false);
  });
  it("dispose() disconnects the input and output gains", () => {
    const ctx = new OfflineAudioContext(2, 4096, 44100);
    const fx = new PitchShift(ctx, { engine: "stretch", stretch: { blockMs: 40 } });
    const core = (fx as unknown as { core: { input: GainNode; output: GainNode } }).core;
    const spies = [vi.spyOn(core.input, "disconnect"), vi.spyOn(core.output, "disconnect")];
    fx.dispose();
    for (const s of spies) expect(s).toHaveBeenCalled();
  });
});
