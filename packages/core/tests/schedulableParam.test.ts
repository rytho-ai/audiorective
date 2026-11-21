import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { SchedulableParam } from "../src";

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe("SchedulableParam — rebind", () => {
  let ctx: AudioContext;
  beforeEach(async () => {
    ctx = new AudioContext();
    await ctx.resume();
  });
  afterEach(() => {
    void ctx.close();
  });

  test("value writes and read() follow the new AudioParam after rebind", () => {
    const a = new GainNode(ctx, { gain: 0 });
    const b = new GainNode(ctx, { gain: 0 });
    const p = new SchedulableParam({ default: 1, audioContext: ctx, audioParam: a.gain });
    expect(a.gain.value).toBeCloseTo(1); // default synced onto A

    p.rebind(b.gain);
    expect(b.gain.value).toBeCloseTo(1); // reassert (default) mirrors current value onto B

    p.value = 0.5;
    expect(b.gain.value).toBeCloseTo(0.5); // writes go to B
    expect(a.gain.value).toBeCloseTo(1); // A is left untouched
    expect(p.read()).toBeCloseTo(0.5); // read() reads B

    p.dispose();
  });

  test("rebind with reassert:false leaves the new param's value intact", () => {
    const a = new GainNode(ctx, { gain: 0 });
    const b = new GainNode(ctx, { gain: 0.3 });
    const p = new SchedulableParam({ default: 1, audioContext: ctx, audioParam: a.gain });
    p.rebind(b.gain, { reassert: false });
    expect(b.gain.value).toBeCloseTo(0.3);
    p.dispose();
  });

  test("scheduling after rebind automates the new param, not the old", async () => {
    const a = new GainNode(ctx, { gain: 0 });
    const b = new GainNode(ctx, { gain: 0 });
    b.connect(ctx.destination); // automation only renders for a node reaching destination
    const p = new SchedulableParam({ default: 0, audioContext: ctx, audioParam: a.gain });
    p.rebind(b.gain);
    const t = ctx.currentTime;
    p.setValueAtTime(0, t).linearRampToValueAtTime(1, t + 0.05);
    await delay(120);
    expect(b.gain.value).toBeGreaterThan(0.5); // B ramped
    expect(a.gain.value).toBeCloseTo(0); // A never moved
    p.dispose();
  });

  test("stays a SchedulableParam — scheduling methods remain callable after rebind", () => {
    const a = new GainNode(ctx, { gain: 0 });
    const b = new GainNode(ctx, { gain: 0 });
    const p = new SchedulableParam({ default: 0, audioContext: ctx, audioParam: a.gain });
    p.rebind(b.gain);
    expect(typeof p.setValueAtTime).toBe("function");
    expect(typeof p.exponentialRampToValueAtTime).toBe("function");
    expect(p.exponentialRampToValueAtTime(0.5, ctx.currentTime + 0.01)).toBe(p); // chainable
    p.dispose();
  });
});

describe("SchedulableParam — smoothing", () => {
  const SR = 44100;
  /** Renders `seconds`, running `edit` at 0.05 s (the context clock has run by then). */
  const render = async (build: (ctx: OfflineAudioContext) => () => void, seconds = 0.3) => {
    const ctx = new OfflineAudioContext(1, Math.round(SR * seconds), SR);
    const edit = build(ctx);
    ctx.suspend(0.05).then(() => {
      edit();
      ctx.resume();
    });
    return (await ctx.startRendering()).getChannelData(0);
  };
  const constant = (ctx: OfflineAudioContext, gain: GainNode) => {
    const src = new ConstantSourceNode(ctx, { offset: 1 });
    src.connect(gain).connect(ctx.destination);
    src.start();
  };
  const at = (seconds: number) => Math.round(seconds * SR);

  test("a .value write settles over `smoothing` seconds instead of jumping", async () => {
    const out = await render((ctx) => {
      const gain = new GainNode(ctx, { gain: 0 });
      const p = new SchedulableParam({ default: 0, audioContext: ctx, audioParam: gain.gain, smoothing: 0.02 });
      constant(ctx, gain);
      return () => (p.value = 1);
    });
    expect(out[at(0.04)]).toBe(0);
    expect(out[at(0.07)]).toBeGreaterThan(0.3); // 10 ms lead + 10 ms
    expect(out[at(0.07)]).toBeLessThan(0.95);
    expect(out[at(0.2)]).toBeCloseTo(1, 2);
    let step = 0;
    for (let i = 1; i < out.length; i++) step = Math.max(step, Math.abs(out[i]! - out[i - 1]!));
    expect(step).toBeLessThan(0.01);
  });

  test("the default value, smoothing 0 and a write before the clock runs jump like a native AudioParam", async () => {
    const out = await render((ctx) => {
      const gain = new GainNode(ctx, { gain: 0 });
      new SchedulableParam({ default: 0.7, audioContext: ctx, audioParam: gain.gain, smoothing: 0.5 });
      constant(ctx, gain);
      return () => {};
    });
    expect(out[0]).toBeCloseTo(0.7, 5);
    const jump = await render((ctx) => {
      const gain = new GainNode(ctx, { gain: 0 });
      const p = new SchedulableParam({ default: 0, audioContext: ctx, audioParam: gain.gain });
      constant(ctx, gain);
      return () => (p.value = 1);
    });
    expect(jump[at(0.06)]).toBeCloseTo(1, 5);
    const early = await render((ctx) => {
      const gain = new GainNode(ctx, { gain: 0 });
      const p = new SchedulableParam({ default: 0, audioContext: ctx, audioParam: gain.gain, smoothing: 0.5 });
      p.value = 0.4;
      constant(ctx, gain);
      return () => {};
    });
    expect(early[0]).toBeCloseTo(0.4, 5);
  });

  test("scheduled ramps are not smoothed", async () => {
    const out = await render((ctx) => {
      const gain = new GainNode(ctx, { gain: 0 });
      const p = new SchedulableParam({ default: 0, audioContext: ctx, audioParam: gain.gain, smoothing: 0.5 });
      p.setValueAtTime(0, 0).linearRampToValueAtTime(1, 2205 / 44100);
      constant(ctx, gain);
      return () => {};
    });
    expect(out[1102]).toBeCloseTo(0.5, 2);
    expect(out[2205]).toBeCloseTo(1, 3);
  });
});
