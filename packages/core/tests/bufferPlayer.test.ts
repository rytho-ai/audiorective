import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { BufferPlayer, cell, effect } from "../src";

function makeBuffer(ctx: AudioContext, seconds = 0.5): AudioBuffer {
  return ctx.createBuffer(1, Math.max(1, Math.ceil(ctx.sampleRate * seconds)), ctx.sampleRate);
}
// Ramps run on the audio clock, which can stall under load; wait on it, not wall time.
async function waitForAudioClock(ctx: AudioContext, from: number, seconds: number): Promise<void> {
  const deadline = Date.now() + 5000;
  while (ctx.currentTime - from < seconds) {
    if (Date.now() > deadline) throw new Error(`audio clock advanced only ${ctx.currentTime - from}s of ${seconds}s in 5s`);
    await delay(5);
  }
}
function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe("BufferPlayer", () => {
  let ctx: AudioContext;
  beforeEach(async () => {
    ctx = new AudioContext();
    await ctx.resume();
  });
  afterEach(() => {
    void ctx.close();
  });

  test("output is an AudioNode and volume param drives it", () => {
    const p = new BufferPlayer(ctx, { buffer: makeBuffer(ctx), volume: 0.5 });
    expect(p.output).toBeInstanceOf(AudioNode);
    expect((p.output as GainNode).gain.value).toBeCloseTo(0.5);
    p.params.volume.value = 0.25;
    expect((p.output as GainNode).gain.value).toBeCloseTo(0.25);
    p.destroy();
  });

  test("start() sets isPlaying; stop() clears it", () => {
    const p = new BufferPlayer(ctx, { buffer: makeBuffer(ctx, 2) });
    expect(p.cells.isPlaying.value).toBe(false);
    p.start();
    expect(p.cells.isPlaying.value).toBe(true);
    p.stop();
    expect(p.cells.isPlaying.value).toBe(false);
    p.destroy();
  });

  test("start() with no buffer is a no-op", () => {
    const p = new BufferPlayer(ctx);
    p.start();
    expect(p.cells.isPlaying.value).toBe(false);
    p.destroy();
  });

  test("start() while already playing is a guarded no-op", () => {
    const p = new BufferPlayer(ctx, { buffer: makeBuffer(ctx, 2) });
    p.start();
    expect(() => p.start()).not.toThrow();
    expect(p.cells.isPlaying.value).toBe(true);
    p.stop();
    p.destroy();
  });

  test("rate is a SchedulableParam whose ramp automates the live source", async () => {
    const p = new BufferPlayer(ctx, { buffer: makeBuffer(ctx, 2) });
    p.output.connect(ctx.destination); // source must reach destination for playbackRate to render
    p.start();
    expect(p.params.rate.read()).toBeCloseTo(1);
    const t = ctx.currentTime;
    p.params.rate
      .cancelScheduledValues(t)
      .setValueAtTime(p.params.rate.read(), t)
      .exponentialRampToValueAtTime(0.1, t + 0.05);
    await waitForAudioClock(ctx, t, 0.15);
    expect(p.params.rate.read()).toBeLessThan(0.5); // spun down on the real source
    p.stop();
    p.destroy();
  });

  test("restart re-anchors rate to base and rebinds to a fresh source", async () => {
    const p = new BufferPlayer(ctx, { buffer: makeBuffer(ctx, 2), playbackRate: 1 });
    p.output.connect(ctx.destination);
    p.start();
    const t = ctx.currentTime;
    p.params.rate.setValueAtTime(1, t).exponentialRampToValueAtTime(0.1, t + 0.05);
    await waitForAudioClock(ctx, t, 0.12);
    expect(p.params.rate.read()).toBeLessThan(0.5);
    p.stop();

    p.start(); // fresh source
    expect(p.params.rate.read()).toBeCloseTo(1); // re-anchored to base, not the spun-down 0.1
    const t2 = ctx.currentTime;
    p.params.rate.setValueAtTime(1, t2).exponentialRampToValueAtTime(0.1, t2 + 0.05);
    await waitForAudioClock(ctx, t2, 0.12);
    expect(p.params.rate.read()).toBeLessThan(0.5); // new source automates too
    p.stop();
    p.destroy();
  });

  test("a looping player keeps playing past buffer length; non-looping ends", async () => {
    const looping = new BufferPlayer(ctx, { buffer: makeBuffer(ctx, 0.05), loop: true });
    looping.start();
    await delay(200);
    expect(looping.cells.isPlaying.value).toBe(true);
    looping.stop();
    looping.destroy();

    const once = new BufferPlayer(ctx, { buffer: makeBuffer(ctx, 0.05) });
    once.start();
    await delay(200);
    expect(once.cells.isPlaying.value).toBe(false); // ended naturally
    once.destroy();
  });

  test("toggling loop on mid-play keeps a non-looping source playing", async () => {
    const p = new BufferPlayer(ctx, { buffer: makeBuffer(ctx, 0.05) }); // started non-looping
    p.start();
    p.loop = true; // toggle on before it ends — must apply the loop window, not the 0/0 default
    await delay(200);
    expect(p.cells.isPlaying.value).toBe(true); // still looping past the buffer length
    p.stop();
    p.destroy();
  });

  test("destroy() does not throw", () => {
    const p = new BufferPlayer(ctx, { buffer: makeBuffer(ctx, 1) });
    p.start();
    expect(() => p.destroy()).not.toThrow();
  });

  test("buffer property delegates to params.buffer and is tracked", () => {
    const b1 = makeBuffer(ctx, 1);
    const b2 = makeBuffer(ctx, 1);
    const p = new BufferPlayer(ctx, { buffer: b1 });
    const seen: Array<AudioBuffer | null> = [];
    const stop = effect(() => {
      seen.push(p.buffer);
    });
    expect(p.params.buffer.value).toBe(b1);
    p.buffer = b2;
    expect(p.params.buffer.value).toBe(b2);
    expect(seen).toEqual([b1, b2]);
    stop();
    p.destroy();
  });

  test("constructed inside an effect, its bound params survive the effect re-running", () => {
    const trigger = cell(0);
    let player!: BufferPlayer;
    const stop = effect(() => {
      void trigger.value;
      player ??= new BufferPlayer(ctx, { buffer: makeBuffer(ctx, 1), loop: false });
    });
    trigger.value = 1; // re-run the outer effect
    player.start();
    player.params.loop.value = true;
    const src = (player as unknown as { _source: AudioBufferSourceNode })._source;
    expect(src.loop).toBe(true);
    stop();
    player.destroy();
  });
});
