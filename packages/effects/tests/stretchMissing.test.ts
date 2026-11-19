import { describe, expect, it, vi } from "vitest";

// Simulates an install without the optional peer: loading the module fails. (A factory that throws at
// registration breaks vitest's browser mocker, so the failure surfaces when the import is consumed.)
vi.mock("signalsmith-stretch", () => ({
  get default(): never {
    throw new Error("Failed to resolve import signalsmith-stretch");
  },
}));

const { Filter, PingPongDelay, PitchShift } = await import("../src");
const { dominantHz, renderShift } = await import("./helpers/spectrum");

describe("without the signalsmith-stretch peer", () => {
  it("the root entry, Filter and PingPongDelay work", () => {
    const ctx = new OfflineAudioContext(1, 128, 44100);
    expect(new Filter(ctx).output).toBeDefined();
    expect(new PingPongDelay(ctx).output).toBeDefined();
  });
  it("the granular PitchShift engine renders", async () => {
    const f = await renderShift((ctx) => new PitchShift(ctx, { pitch: 12 }));
    expect(Math.abs(dominantHz(f, 44100) - 880)).toBeLessThanOrEqual(15);
  });
  it("the stretch engine rejects ready with an install hint and stays not ready", async () => {
    const ctx = new OfflineAudioContext(2, 4096, 44100);
    const fx = new PitchShift(ctx, { engine: "stretch" });
    await expect(fx.ready).rejects.toThrow(
      'PitchShift stretch engine needs the optional peer dependency "signalsmith-stretch": install it (npm i signalsmith-stretch).',
    );
    expect(fx.cells.isReady.value).toBe(false);
  });
});
