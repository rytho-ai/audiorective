import { describe, expect, it } from "vitest";
import { AudioProcessor, AudioEngine, createEngine, type SchedulableParam } from "../src";

// An AudioProcessor wrapping a delay node: `samples` of declared latency, input and output.
class Latent extends AudioProcessor {
  readonly delay: DelayNode;
  constructor(ctx: BaseAudioContext, samples: number) {
    const delay = new DelayNode(ctx, { delayTime: samples / ctx.sampleRate, maxDelayTime: 1 });
    super(ctx, () => ({ latency: samples }));
    this.delay = delay;
  }
  override get input() {
    return this.delay;
  }
  get output() {
    return this.delay;
  }
}

class OutputOnly extends AudioProcessor {
  readonly node: GainNode;
  constructor(ctx: BaseAudioContext) {
    const node = new GainNode(ctx);
    super(ctx, () => ({}));
    this.node = node;
  }
  get output() {
    return this.node;
  }
}

class Detached extends AudioProcessor {
  constructor(ctx: BaseAudioContext) {
    super(ctx, () => ({}));
  }
  get output() {
    return undefined;
  }
}

async function render(build: (ctx: OfflineAudioContext) => void): Promise<Float32Array> {
  const ctx = new OfflineAudioContext(1, 4410, 44100);
  build(ctx);
  const buffer = await ctx.startRendering();
  return buffer.getChannelData(0);
}

describe("AudioProcessor.connect", () => {
  it("returns the destination so calls chain, for every destination kind", () => {
    const ctx = new AudioContext();
    const a = new Latent(ctx, 0);
    const b = new Latent(ctx, 0);
    const c = new Latent(ctx, 0);
    const gain = new GainNode(ctx);
    expect(a.connect(b)).toBe(b);
    expect(a.connect(ctx.destination)).toBe(ctx.destination);
    expect(a.connect(gain.gain)).toBe(gain.gain);
    expect(a.connect(b).connect(c).connect(ctx.destination)).toBe(ctx.destination);
    a.dispose();
    b.dispose();
    c.dispose();
    void ctx.close();
  });

  it("returns a SchedulableParam destination unchanged", () => {
    const ctx = new AudioContext();
    const a = new Latent(ctx, 0);
    const target = new (class extends AudioProcessor<{ gain: SchedulableParam }> {
      private readonly node = new GainNode(ctx);
      constructor() {
        const node = new GainNode(ctx);
        super(ctx, ({ param }) => ({ params: { gain: param({ default: 0, bind: node.gain }) } }));
      }
      get output() {
        return this.node;
      }
    })();
    expect(a.connect(target.params.gain)).toBe(target.params.gain);
    a.dispose();
    target.dispose();
    void ctx.close();
  });

  it("passes audio from the output to a native node and to the input of a processor", async () => {
    const samples = await render((ctx) => {
      const source = new ConstantSourceNode(ctx, { offset: 1 });
      const first = new Latent(ctx, 0);
      const second = new Latent(ctx, 0);
      source.connect(first.input!);
      first.connect(second).connect(ctx.destination);
      source.start();
    });
    expect(samples[4000]).toBeCloseTo(1, 5);
  });

  it("modulates an AudioParam destination", async () => {
    const samples = await render((ctx) => {
      const source = new ConstantSourceNode(ctx, { offset: 0.5 });
      const mod = new Latent(ctx, 0);
      const target = new GainNode(ctx, { gain: 0 });
      const dc = new ConstantSourceNode(ctx, { offset: 1 });
      source.connect(mod.input!);
      mod.connect(target.gain);
      dc.connect(target).connect(ctx.destination);
      source.start();
      dc.start();
    });
    expect(samples[4000]).toBeCloseTo(0.5, 5);
  });

  it("honours the output and input indices", async () => {
    const samples = await render((ctx) => {
      const source = new ConstantSourceNode(ctx, { offset: 1 });
      const a = new Latent(ctx, 0);
      const merger = new ChannelMergerNode(ctx, { numberOfInputs: 2 });
      source.connect(a.input!);
      a.connect(merger, 0, 1);
      merger.connect(ctx.destination);
      source.start();
    });
    // Input 1 carries the signal but the mono mixdown of the merger's stereo output is half of it.
    expect(samples[4000]).toBeCloseTo(0.5, 5);
  });

  it("disconnect(destination) removes only that connection; disconnect() removes all", async () => {
    const run = (undo: (a: Latent, b: Latent) => void) =>
      render((ctx) => {
        const source = new ConstantSourceNode(ctx, { offset: 1 });
        const a = new Latent(ctx, 0);
        const b = new Latent(ctx, 0);
        source.connect(a.input!);
        a.connect(ctx.destination);
        a.connect(b).connect(ctx.destination);
        undo(a, b);
        source.start();
      });
    expect((await run(() => {}))[4000]).toBeCloseTo(2, 5); // direct + through b
    expect((await run((a, b) => a.disconnect(b)))[4000]).toBeCloseTo(1, 5);
    expect((await run((a) => a.disconnect(a.context.destination)))[4000]).toBeCloseTo(1, 5);
    expect((await run((a) => a.disconnect()))[4000]).toBeCloseTo(0, 5);
  });

  it("connecting the same edge twice is one connection", async () => {
    const samples = await render((ctx) => {
      const source = new ConstantSourceNode(ctx, { offset: 1 });
      const a = new Latent(ctx, 0);
      source.connect(a.input!);
      a.connect(ctx.destination);
      a.connect(ctx.destination);
      source.start();
    });
    expect(samples[4000]).toBeCloseTo(1, 5);
  });

  it("connects to a bare AudioWorkletNode destination directly", () => {
    const ctx = new AudioContext();
    const a = new Latent(ctx, 0);
    const fake = Object.create(AudioWorkletNode.prototype) as AudioWorkletNode;
    let connected = 0;
    a.output.connect = ((dest: unknown) => {
      if (dest === fake) connected++;
    }) as never;
    expect(a.connect(fake)).toBe(fake);
    expect(connected).toBe(1);
    a.disconnect();
    a.dispose();
    void ctx.close();
  });

  it("throws a documented error without an output, without a destination input, or after dispose", () => {
    const ctx = new AudioContext();
    const a = new Latent(ctx, 0);
    expect(() => new Detached(ctx).connect(ctx.destination)).toThrow("AudioProcessor.connect: Detached has no output");
    expect(() => a.connect(new OutputOnly(ctx))).toThrow("AudioProcessor.connect: OutputOnly has no input");
    a.dispose();
    expect(() => a.connect(ctx.destination)).toThrow("Latent is disposed.");
    void ctx.close();
  });
});

describe("AudioProcessor.connect and delay compensation", () => {
  it("engine.latency sees a connect edge into the destination", () => {
    const engine = createEngine((ctx) => ({ slow: new Latent(ctx, 400), dry: new Latent(ctx, 0) }));
    expect(engine.core.latency.value).toBe(0);
    engine.slow.connect(engine.core.context.destination);
    engine.dry.connect(engine.core.context.destination);
    expect(engine.core.latency.value).toBe(400);
    expect(engine.core.getPathLatency(engine.slow)).toBe(0);
    expect(engine.core.getPathLatency(engine.dry)).toBe(400); // the dry branch carries the compensation
    engine.core.dispose();
  });

  it("an engine created after the connections still sees them", () => {
    const ctx = new AudioContext();
    const slow = new Latent(ctx, 250);
    slow.connect(ctx.destination);
    const engine = new AudioEngine(ctx);
    expect(engine.latency.value).toBe(250);
    engine.dispose();
    slow.dispose();
    void ctx.close();
  });

  it("chains processor to processor: latencies add along the path", () => {
    const engine = createEngine((ctx) => ({ a: new Latent(ctx, 100), b: new Latent(ctx, 200) }));
    engine.a.connect(engine.b).connect(engine.core.context.destination);
    expect(engine.core.latency.value).toBe(300);
    expect(engine.core.getPathLatency(engine.a)).toBe(200);
    expect(engine.core.getPathLatency(engine.b)).toBe(0);
    engine.core.dispose();
  });

  it("splices a compensation delay where connect edges join with unequal latency", async () => {
    const ctx = new OfflineAudioContext(1, 8820, 44100);
    const source = new ConstantSourceNode(ctx, { offset: 1 });
    const slow = new Latent(ctx, 1000);
    const dry = new Latent(ctx, 0);
    source.connect(slow.input!);
    source.connect(dry.input!);
    slow.connect(ctx.destination);
    dry.connect(ctx.destination);
    source.start();
    const out = (await ctx.startRendering()).getChannelData(0);
    // Uncompensated, the dry branch would reach 1 at sample 0 and 2 at sample 1000.
    // Compensated, nothing is heard until the slow branch arrives and both rise together.
    expect(out[500]).toBeCloseTo(0, 5);
    expect(out[1500]).toBeCloseTo(2, 5);
  });

  it("disconnect() and dispose() remove the edge from the latency graph", () => {
    const engine = createEngine((ctx) => ({ slow: new Latent(ctx, 400), other: new Latent(ctx, 150) }));
    const dest = engine.core.context.destination;
    engine.slow.connect(dest);
    engine.other.connect(dest);
    expect(engine.core.latency.value).toBe(400);
    engine.slow.disconnect();
    expect(engine.core.latency.value).toBe(150);
    engine.other.dispose();
    expect(engine.core.latency.value).toBe(0);
    engine.core.dispose();
  });

  it("disposing a destination processor drops the edges that fed it", () => {
    const engine = createEngine((ctx) => ({ a: new Latent(ctx, 100), b: new Latent(ctx, 200) }));
    engine.a.connect(engine.b).connect(engine.core.context.destination);
    expect(engine.core.latency.value).toBe(300);
    engine.b.dispose();
    expect(engine.core.latency.value).toBe(0);
    engine.core.dispose();
  });
});
