import { describe, expect, it } from "vitest";
import { Channel, SendBus } from "../src";

async function renderStereo(build: (ctx: OfflineAudioContext) => void, frames = 256) {
  const ctx = new OfflineAudioContext(2, frames, 44100);
  build(ctx);
  return ctx.startRendering();
}

describe("Channel", () => {
  it("gain scales, mute silences, unmute restores", async () => {
    const buf = await renderStereo((ctx) => {
      const ch = new Channel(ctx, { gain: 0.5 });
      const src = new ConstantSourceNode(ctx, { offset: 1 });
      src.connect(ch.input);
      ch.output.connect(ctx.destination);
      src.start();
      ch.params.mute.value = true;
      ctx.suspend(128 / 44100).then(() => {
        ch.params.mute.value = false;
        ctx.resume();
      });
    });
    const l = buf.getChannelData(0);
    expect(l[64]).toBeCloseTo(0, 6);
    expect(l[250]).toBeCloseTo(0.5, 6);
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
      expect(send.gain.value).toBe(0.5);
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
      expect(a.enabled.value).toBe(true);
      a.enabled.value = false;
      expect(a.gain.value).toBe(0.5);
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
