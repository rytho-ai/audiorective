import { describe, expect, it } from "vitest";
import { AudioProcessor } from "@audiorective/core";
import { Channel, SendBus } from "../src";

async function renderStereo(build: (ctx: OfflineAudioContext) => void, frames = 256) {
  const ctx = new OfflineAudioContext(2, frames, 44100);
  build(ctx);
  return ctx.startRendering();
}

describe("Channel", () => {
  it("dispose and Symbol.dispose can be repeated with a native meter attached", async () => {
    const context = new AudioContext();
    const channel = new Channel(context);
    try {
      channel.dispose();
      expect(() => channel.dispose()).not.toThrow();
      expect(() => channel[Symbol.dispose]()).not.toThrow();
    } finally {
      await context.close();
    }
  });

  it("gain scales, mute silences, unmute restores", async () => {
    const buf = await renderStereo((ctx) => {
      const ch = new Channel(ctx, { gain: 0.5, muted: true });
      const src = new ConstantSourceNode(ctx, { offset: 1 });
      src.connect(ch.input);
      ch.output.connect(ctx.destination);
      src.start();
      expect(ch.params.muted.value).toBe(true);
      ctx.suspend(128 / 44100).then(() => {
        ch.params.muted.value = false;
        ctx.resume();
      });
    }, 4096);
    const l = buf.getChannelData(0);
    expect(l[64]).toBeCloseTo(0, 6);
    expect(l[4095]).toBeCloseTo(0.5, 6);
  });

  it("smooths mute and output gating on a 0.5 signal", async () => {
    for (const control of ["muted", "outputEnabled"] as const) {
      const buffer = await renderStereo((ctx) => {
        const channel = new Channel(ctx);
        const source = new ConstantSourceNode(ctx, { offset: 0.5 });
        source.connect(channel.input);
        channel.output.connect(ctx.destination);
        source.start();
        void ctx.suspend(512 / ctx.sampleRate).then(() => {
          channel.params[control].value = control === "muted";
          return ctx.resume();
        });
      }, 4096);
      const samples = buffer.getChannelData(0);
      let maxStep = 0;
      for (let i = 1; i < samples.length; i++) maxStep = Math.max(maxStep, Math.abs(samples[i] - samples[i - 1]));
      expect(maxStep).toBeLessThan(0.005);
      expect(samples.at(-1)).toBeCloseTo(0, 4);
    }
  });

  it("pan = 1 puts a mono source in the right channel only", async () => {
    const buf = await renderStereo((ctx) => {
      const ch = new Channel(ctx, { pan: 1 });
      const src = new ConstantSourceNode(ctx, { offset: 1 });
      src.connect(ch.input);
      ch.output.connect(ctx.destination);
      src.start();
    });
    expect(buf.getChannelData(0)[200]).toBeCloseTo(0, 5);
    expect(buf.getChannelData(1)[200]).toBeGreaterThan(0.9);
  });

  it("a send delivers the post-mute signal at its own gain", async () => {
    let tapped!: Float32Array;
    const buf = await renderStereo((ctx) => {
      const bus = new SendBus(ctx);
      bus.define("hall");
      const ch = new Channel(ctx);
      const src = new ConstantSourceNode(ctx, { offset: 1 });
      src.connect(ch.input);
      src.start();
      const send = ch.send(bus, "hall", 0.5);
      expect(send.params.gain.value).toBe(0.5);
      bus.receive("hall").connect(ctx.destination); // only the send reaches the output
    });
    tapped = buf.getChannelData(0);
    expect(tapped[200]).toBeCloseTo(0.5, 5);
  });

  it("SendBus.receive throws for an undefined name", () => {
    const ctx = new OfflineAudioContext(1, 128, 44100);
    const bus = new SendBus(ctx);
    expect(() => bus.receive("nope")).toThrow(/nope/);
  });

  it("a send delays by its compensation and builds no delay node until asked", async () => {
    const created: number[] = [];
    const Original = globalThis.DelayNode;
    globalThis.DelayNode = class extends Original {
      constructor(context: BaseAudioContext, options?: DelayOptions) {
        super(context, options);
        created.push(1);
      }
    };
    try {
      const buf = await renderStereo((ctx) => {
        const ch = new Channel(ctx);
        const bus = new SendBus(ctx);
        bus.define("hall");
        const send = ch.send(bus, "hall", 1);
        expect(created).toEqual([]);
        send.setCompensation(0);
        expect(created).toEqual([]);
        send.setCompensation(100);
        expect(created).toEqual([1]);
        bus.receive("hall").connect(ctx.destination);
        const src = new ConstantSourceNode(ctx, { offset: 1 });
        src.connect(ch.input);
        src.start();
      }, 512);
      const data = buf.getChannelData(0);
      const first = data.findIndex((v) => Math.abs(v) > 0.01);
      expect(first).toBe(100);
    } finally {
      globalThis.DelayNode = Original;
    }
  });

  it("a disposed send delivers nothing", async () => {
    const buf = await renderStereo((ctx) => {
      const bus = new SendBus(ctx);
      bus.define("hall");
      const ch = new Channel(ctx);
      const src = new ConstantSourceNode(ctx, { offset: 1 });
      src.connect(ch.input);
      src.start();
      const send = ch.send(bus, "hall", 0.5);
      send.dispose();
      expect(() => send.dispose()).not.toThrow();
      bus.receive("hall").connect(ctx.destination);
    });
    expect(buf.getChannelData(0)[200]).toBeCloseTo(0, 6);
  });
  it("default input upmixes mono before the panner; channelCountMode max keeps mono equal-power", async () => {
    const centre = async (opts: { channelCountMode?: "max" }) => {
      const buf = await renderStereo((ctx) => {
        const ch = new Channel(ctx, opts);
        const src = new ConstantSourceNode(ctx, { offset: 1 });
        src.connect(ch.input);
        ch.output.connect(ctx.destination);
        src.start();
      });
      return [buf.getChannelData(0)[200], buf.getChannelData(1)[200]];
    };
    const [explicitL, explicitR] = await centre({});
    expect(explicitL).toBeCloseTo(1, 5);
    expect(explicitR).toBeCloseTo(1, 5);
    const [monoL, monoR] = await centre({ channelCountMode: "max" });
    expect(monoL).toBeCloseTo(Math.SQRT1_2, 5);
    expect(monoR).toBeCloseTo(Math.SQRT1_2, 5);
  });

  it("channelCountMode max leaves a stereo source on the stereo panner law", async () => {
    const buf = await renderStereo((ctx) => {
      const ch = new Channel(ctx, { channelCountMode: "max", pan: -1 });
      const left = new ConstantSourceNode(ctx, { offset: 1 });
      const right = new ConstantSourceNode(ctx, { offset: 0.5 });
      const merger = new ChannelMergerNode(ctx, { numberOfInputs: 2 });
      left.connect(merger, 0, 0);
      right.connect(merger, 0, 1);
      merger.connect(ch.input);
      ch.output.connect(ctx.destination);
      left.start();
      right.start();
    });
    expect(buf.getChannelData(0)[200]).toBeCloseTo(1.5, 5);
    expect(buf.getChannelData(1)[200]).toBeCloseTo(0, 5);
  });

  it("outputEnabled gates the main output but not the sends", async () => {
    const buf = await renderStereo((ctx) => {
      const bus = new SendBus(ctx);
      bus.define("hall");
      const ch = new Channel(ctx);
      const src = new ConstantSourceNode(ctx, { offset: 1 });
      src.connect(ch.input);
      src.start();
      ch.send(bus, "hall", 0.5);
      ch.params.outputEnabled.value = false;
      ch.output.connect(ctx.destination);
      const tapped = new GainNode(ctx);
      bus.receive("hall").connect(tapped).connect(ctx.destination);
    });
    expect(buf.getChannelData(0)[200]).toBeCloseTo(0.5, 5);
  });

  it("send.enabled gates one send without changing its gain", async () => {
    const buf = await renderStereo((ctx) => {
      const bus = new SendBus(ctx);
      bus.define("a");
      bus.define("b");
      const ch = new Channel(ctx);
      const src = new ConstantSourceNode(ctx, { offset: 1 });
      src.connect(ch.input);
      src.start();
      const a = ch.send(bus, "a", 0.5);
      ch.send(bus, "b", 0.25);
      expect(a.params.enabled.value).toBe(true);
      a.params.enabled.value = false;
      expect(a.params.gain.value).toBe(0.5);
      bus.receive("a").connect(ctx.destination);
      bus.receive("b").connect(ctx.destination);
    });
    expect(buf.getChannelData(0)[200]).toBeCloseTo(0.25, 5);
  });

  it("SendBus.undefine forgets a receive point", () => {
    const ctx = new OfflineAudioContext(1, 128, 44100);
    const bus = new SendBus(ctx);
    bus.define("x");
    bus.undefine("x");
    expect(bus.has("x")).toBe(false);
    expect(() => bus.undefine("x")).not.toThrow();
  });
});

describe("Channel meter and send latency compensation", () => {
  it("cells.level reads the post-fader peak in dBFS and -Infinity when silent", async () => {
    const ctx = new AudioContext();
    await ctx.resume();
    const ch = new Channel(ctx, { gain: 0.5 });
    expect(ch.cells.level.value).toBe(-Infinity);
    const src = new OscillatorNode(ctx, { frequency: 220 });
    src.connect(ch.input);
    src.start();
    await new Promise((r) => setTimeout(r, 300));
    expect(ch.cells.level.value).toBeGreaterThan(-7.5);
    expect(ch.cells.level.value).toBeLessThan(-5);
    ch.params.muted.value = true;
    await new Promise((r) => setTimeout(r, 300));
    expect(ch.cells.level.value).toBe(-Infinity);
    src.stop();
    ch.dispose();
    await ctx.close();
  });

  it("a hard-panned source meters at its own peak, not the downmix", async () => {
    const ctx = new AudioContext();
    await ctx.resume();
    const ch = new Channel(ctx, { pan: 1 });
    const src = new ConstantSourceNode(ctx, { offset: 1 });
    src.connect(ch.input);
    src.start();
    await new Promise((r) => setTimeout(r, 300));
    expect(ch.cells.level.value).toBeGreaterThan(-1);
    src.stop();
    ch.dispose();
    await ctx.close();
  });

  it("sends join the latency graph: a latent strip's send lines up with an unlatent one", async () => {
    const frames = 1024;
    const ctx = new OfflineAudioContext(1, frames, 44100);
    const bus = new SendBus(ctx);
    const hall = bus.define("hall");
    // A 100-sample processor in front of strip A only.
    class Latent extends AudioProcessor<{}, {}> {
      private readonly d = new DelayNode(ctx, { delayTime: 100 / 44100, maxDelayTime: 1 });
      constructor() {
        super(ctx, () => ({ params: {}, cells: {}, latency: 100 }));
      }
      override get input() {
        return this.d;
      }
      get output() {
        return this.d;
      }
    }
    const a = new Channel(ctx);
    const b = new Channel(ctx);
    const latent = new Latent();
    latent.connect(a);
    a.send(bus, "hall");
    b.send(bus, "hall");
    const impulse = ctx.createBuffer(1, 1, 44100);
    impulse.getChannelData(0)[0] = 1;
    const srcA = new AudioBufferSourceNode(ctx, { buffer: impulse });
    srcA.connect(latent.input);
    const srcB = new AudioBufferSourceNode(ctx, { buffer: impulse });
    srcB.connect(b.input);
    srcA.start();
    srcB.start();
    hall.connect(ctx.destination);
    const out = (await ctx.startRendering()).getChannelData(0);
    // Without compensation the two impulses land at 100 and 0; compensated they coincide at 100.
    expect(out[0]).toBeCloseTo(0, 5);
    expect(out[100]).toBeGreaterThan(1.5);
  });
});
