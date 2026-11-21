import { describe, expect, it } from "vitest";
import { AudioProcessor } from "@audiorective/core";
import { Effect } from "../src/Effect";

/** Wet arm that inverts polarity — makes wet and dry trivially distinguishable. */
class Inverter extends Effect {
  constructor(ctx: BaseAudioContext, wet?: number) {
    const inv = new GainNode(ctx, { gain: -1 });
    super(ctx, { input: inv, output: inv }, () => ({ params: {}, cells: {} }), { wet });
  }
}

/** Wet arm with 100 samples of declared latency (a DelayNode standing in for a worklet). */
class Latent extends AudioProcessor<{}, {}> {
  private readonly d: DelayNode;
  constructor(ctx: BaseAudioContext) {
    const d = new DelayNode(ctx, { delayTime: 100 / ctx.sampleRate, maxDelayTime: 1 });
    super(ctx, () => ({ params: {}, cells: {}, latency: 100 }));
    this.d = d;
  }
  override get input() {
    return this.d;
  }
  get output() {
    return this.d;
  }
}
class LatentEffect extends Effect {
  constructor(ctx: BaseAudioContext, wet?: number) {
    const arm = new Latent(ctx);
    super(ctx, { input: arm, output: arm }, () => ({ params: {}, cells: {} }), { wet });
  }
}

async function render(build: (ctx: OfflineAudioContext) => Effect, frames = 512): Promise<Float32Array> {
  const ctx = new OfflineAudioContext(1, frames, 44100);
  const fx = build(ctx);
  const src = new ConstantSourceNode(ctx, { offset: 0.5 });
  src.connect(fx.input);
  fx.output.connect(ctx.destination);
  src.start();
  const buf = await ctx.startRendering();
  return buf.getChannelData(0);
}

describe("Effect wet/dry", () => {
  it("wet = 0 passes the dry signal unchanged", async () => {
    const out = await render((ctx) => new Inverter(ctx, 0));
    expect(out[400]).toBeCloseTo(0.5, 6);
  });
  it("wet = 1 passes only the effect arm", async () => {
    const out = await render((ctx) => new Inverter(ctx, 1));
    expect(out[400]).toBeCloseTo(-0.5, 6);
  });
  it("wet = 0.25 mixes linearly", async () => {
    const out = await render((ctx) => new Inverter(ctx, 0.25));
    expect(out[400]).toBeCloseTo(0.75 * 0.5 + 0.25 * -0.5, 6);
  });
  it("a ramp on wet is sample-accurate on both arms", async () => {
    const out = await render((ctx) => {
      const fx = new Inverter(ctx, 0);
      fx.params.wet.setValueAtTime(0, 0).linearRampToValueAtTime(1, 256 / ctx.sampleRate);
      return fx;
    });
    // at frame 128 wet ≈ 0.5 → dry 0.25 + wet -0.25 = 0
    expect(Math.abs(out[128]!)).toBeLessThan(0.02);
    expect(out[400]).toBeCloseTo(-0.5, 6);
  });
  it("derives latency from the wet arm and delays the dry arm to match", async () => {
    const ctx = new OfflineAudioContext(1, 1024, 44100);
    const fx = new LatentEffect(ctx, 0.5);
    expect(fx.latency.value).toBe(100);
    const src = new ConstantSourceNode(ctx, { offset: 1 });
    src.connect(fx.input);
    fx.output.connect(ctx.destination);
    src.start(0);
    const out = (await ctx.startRendering()).getChannelData(0);
    // both arms arrive together at sample 100: nothing before, full level after
    expect(out[50]).toBeCloseTo(0, 6);
    expect(out[300]).toBeCloseTo(1, 6);
  });
});

/** An effect whose wet arm inverts polarity and which reports `loading` until `release()` is called. */
class Slow extends Effect {
  release!: () => void;
  constructor(ctx: BaseAudioContext, opts: { bypass?: boolean } = {}) {
    const inv = new GainNode(ctx, { gain: -1 });
    super(ctx, { input: inv, output: inv, loading: true }, () => ({ params: {}, cells: {} }), opts);
    this.track(new Promise<void>((resolve) => (this.release = resolve)));
  }
}

async function renderSteps(build: (ctx: OfflineAudioContext) => Effect, frames = 4096, edit?: (fx: Effect, ctx: OfflineAudioContext) => void) {
  const ctx = new OfflineAudioContext(1, frames, 44100);
  const fx = build(ctx);
  const src = new ConstantSourceNode(ctx, { offset: 0.5 });
  src.connect(fx.input);
  fx.output.connect(ctx.destination);
  src.start();
  edit?.(fx, ctx);
  return (await ctx.startRendering()).getChannelData(0);
}
const maxStep = (d: Float32Array, from = 1) => {
  let m = 0;
  for (let i = from; i < d.length; i++) m = Math.max(m, Math.abs(d[i]! - d[i - 1]!));
  return m;
};

describe("Effect bypass and status", () => {
  it("params.bypass takes the effect out of the sound, click-free, keeping its settings", async () => {
    const out = await renderSteps(
      (ctx) => new Inverter(ctx, 0.75),
      8192,
      (fx, ctx) => {
        ctx.suspend(2048 / 44100).then(() => {
          fx.params.bypass.value = true;
          ctx.resume();
        });
      },
    );
    expect(out[1500]).toBeCloseTo(0.25 * 0.5 + 0.75 * -0.5, 3);
    expect(out[8000]).toBeCloseTo(0.5, 3);
    expect(maxStep(out, 2)).toBeLessThan(0.01);
    const fx = new Inverter(new OfflineAudioContext(1, 128, 44100), 0.75);
    fx.params.bypass.value = true;
    expect(fx.params.wet.value).toBe(0.75);
  });

  it("the bypass option starts the effect bypassed and clearing it fades the wet arm back in", async () => {
    const out = await renderSteps(
      (ctx) => new Inverter(ctx, 1),
      8192,
      () => {},
    );
    expect(out[4000]).toBeCloseTo(-0.5, 3);
    const bypassed = await renderSteps((ctx) => {
      const inv = new GainNode(ctx, { gain: -1 });
      return new (class extends Effect {
        constructor() {
          super(ctx, { input: inv, output: inv }, () => ({ params: {}, cells: {} }), { bypass: true });
        }
      })();
    });
    expect(bypassed[100]).toBeCloseTo(0.5, 6);
  });

  it("passes the dry signal while loading, then the effect once ready", async () => {
    const loading = await renderSteps((ctx) => new Slow(ctx));
    expect(loading[2000]).toBeCloseTo(0.5, 6);
    expect(maxStep(loading)).toBeLessThan(1e-6);
    const ctx = new OfflineAudioContext(1, 4096, 44100);
    const fx = new Slow(ctx);
    expect(fx.cells.status.value).toBe("loading");
    fx.release();
    await fx.ready;
    expect(fx.cells.status.value).toBe("ready");
  });

  it("a rejected load reports status error with the cause, rejects ready, and keeps passing dry", async () => {
    const ctx = new OfflineAudioContext(1, 128, 44100);
    const failing = new (class extends Effect {
      constructor() {
        super(ctx, { input: new GainNode(ctx), output: new GainNode(ctx), loading: true }, () => ({ params: {}, cells: {} }));
        this.track(Promise.reject(new Error("no impulse")));
      }
    })();
    await expect(failing.ready).rejects.toThrow("no impulse");
    expect(failing.cells.status.value).toBe("error");
    expect(failing.cells.error.value?.message).toBe("no impulse");
  });

  it("wet writes ramp instead of stepping", async () => {
    const out = await renderSteps(
      (ctx) => new Inverter(ctx, 0),
      8192,
      (fx, ctx) => {
        ctx.suspend(2048 / 44100).then(() => {
          fx.params.wet.value = 1;
          ctx.resume();
        });
      },
    );
    expect(out[8000]).toBeCloseTo(-0.5, 3);
    // a hard step would be 1.0
    expect(maxStep(out, 2)).toBeLessThan(0.02);
  });
});
