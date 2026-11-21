import { describe, expect, it, vi } from "vitest";
import { AudioProcessor, defineGraph, cell } from "../src";

const SR = 48000;
const EDIT = 0.2;
const JUMP_LIMIT = 0.02;

// A silent, variable-latency branch isolates the other branch's compensation.
// No effect, worklet, live chain edit or changing DSP node can create the jump.
class LatencyAnchor extends AudioProcessor {
  private readonly node: GainNode;
  constructor(ctx: BaseAudioContext, samples: number) {
    const node = new GainNode(ctx, { gain: 0 });
    super(ctx, () => ({ latency: samples }));
    this.node = node;
  }
  override get input() {
    return this.node;
  }
  get output() {
    return this.node;
  }
}
function signal(ctx: BaseAudioContext, impulses = false) {
  const buffer = ctx.createBuffer(1, Math.round(0.8 * SR), SR),
    data = buffer.getChannelData(0);
  if (impulses) data[Math.round(0.65 * SR)] = 0.1;
  else for (let i = 0; i < data.length; i++) data[i] = 0.12 + 0.03 * Math.sin((2 * Math.PI * 97 * i) / SR);
  const source = new AudioBufferSourceNode(ctx, { buffer });
  source.start();
  return source;
}
async function retime(from: number, to: number, impulses = false) {
  const ctx = new OfflineAudioContext(1, Math.round(0.8 * SR), SR),
    anchor = new LatencyAnchor(ctx, from),
    source = signal(ctx, impulses),
    join = new GainNode(ctx);
  const graph = defineGraph(
    () => [
      [source, join],
      [anchor, join],
      [join, ctx.destination],
    ],
    { context: ctx },
  );
  const edit = ctx.suspend(EDIT).then(async () => {
    anchor.latency.value = to;
    await ctx.resume();
  });
  const audio = (await ctx.startRendering()).getChannelData(0);
  await edit;
  graph.dispose();
  anchor.dispose();
  return audio;
}
const maxJump = (data: Float32Array) => {
  let max = 0;
  for (let i = Math.round(0.19 * SR); i < Math.round(0.5 * SR); i++) max = Math.max(max, Math.abs(data[i] - data[i - 1]));
  return max;
};

describe("live compensation retiming", () => {
  for (const [from, to] of [
    [0, 240],
    [240, 0],
    [240, 480],
    [480, 240],
  ]) {
    it(`changes ${from} to ${to} samples without a discontinuity or gap`, async () => {
      const data = await retime(from, to);
      expect(maxJump(data)).toBeLessThan(JUMP_LIMIT);
      expect(Math.min(...data.slice(Math.round(0.19 * SR), Math.round(0.5 * SR)))).toBeGreaterThan(0.06);
    });
    it(`settles ${from} to ${to} samples at the exact compensated arrival`, async () => {
      const data = await retime(from, to, true),
        frames: number[] = [];
      for (let i = Math.round(0.6 * SR); i < Math.round(0.75 * SR); i++) if (Math.abs(data[i]) > 0.001) frames.push(i);
      expect(frames).toEqual([Math.round(0.65 * SR) + to]);
      expect(data[frames[0]!]).toBeCloseTo(0.1, 5);
    });
  }
});

describe("compensation handover ownership", () => {
  for (const impulses of [false, true])
    it(`rapid retimes retain warmed audio and the latest exact target (${impulses ? "impulses" : "continuous"})`, async () => {
      const ctx = new OfflineAudioContext(1, Math.round(0.8 * SR), SR),
        anchor = new LatencyAnchor(ctx, 0),
        source = signal(ctx, impulses),
        join = new GainNode(ctx);
      const graph = defineGraph(
        () => [
          [source, join],
          [anchor, join],
          [join, ctx.destination],
        ],
        { context: ctx },
      );
      const edits = [
        [9600, 240],
        [9728, 480],
        [9856, 0],
        [9984, 360],
      ].map(([frame, samples]) =>
        ctx.suspend(frame! / SR).then(async () => {
          anchor.latency.value = samples!;
          await ctx.resume();
        }),
      );
      const audio = (await ctx.startRendering()).getChannelData(0);
      await Promise.all(edits);
      expect(graph.arrivalOf(join)).toBe(360);
      expect(graph.snapshot().nodes).toHaveLength(4);
      expect(graph.snapshot().edges).toHaveLength(3);
      if (impulses) {
        const frames = [];
        for (let i = 0.6 * SR; i < 0.75 * SR; i++) if (Math.abs(audio[i]!) > 0.001) frames.push(i);
        expect(frames).toEqual([0.65 * SR + 360]);
        expect(audio[frames[0]!]).toBeCloseTo(0.1, 5);
      } else {
        expect(maxJump(audio)).toBeLessThan(JUMP_LIMIT);
        expect(Math.min(...audio.slice(0.19 * SR, 0.5 * SR))).toBeGreaterThan(0.06);
      }
      graph.dispose();
      anchor.dispose();
    });

  it("disposing during warmup clears every cleanup timer and all audible helper routes", async () => {
    const ctx = new OfflineAudioContext(1, Math.round(0.5 * SR), SR),
      anchor = new LatencyAnchor(ctx, 0),
      source = signal(ctx),
      join = new GainNode(ctx);
    const graph = defineGraph(
      () => [
        [source, join],
        [anchor, join],
        [join, ctx.destination],
      ],
      { context: ctx },
    );
    const edit = ctx.suspend(0.2).then(async () => {
      const scheduled = vi.spyOn(globalThis, "setTimeout"),
        cleared = vi.spyOn(globalThis, "clearTimeout");
      try {
        anchor.latency.value = 240;
        const timerIds = scheduled.mock.results.filter((r) => r.type === "return").map((r) => r.value);
        expect(timerIds.length).toBeGreaterThan(0);
        graph.dispose();
        for (const id of timerIds) expect(cleared.mock.calls.some(([value]) => value === id)).toBe(true);
      } finally {
        scheduled.mockRestore();
        cleared.mockRestore();
        anchor.dispose();
        await ctx.resume();
      }
    });
    const audio = (await ctx.startRendering()).getChannelData(0);
    await edit;
    expect(Math.max(...audio.slice(0.25 * SR).map(Math.abs))).toBe(0);
    expect(graph.snapshot().nodes).toEqual([]);
  });

  it("removing a wire during warmup cancels its pending cleanup without leaving a dry or delayed copy", async () => {
    const ctx = new OfflineAudioContext(1, Math.round(0.5 * SR), SR),
      anchor = new LatencyAnchor(ctx, 0),
      source = signal(ctx),
      join = new GainNode(ctx),
      enabled = cell(true);
    const graph = defineGraph(() => [enabled.value && [source, join], [anchor, join], [join, ctx.destination]], { context: ctx });
    const edit = ctx.suspend(0.2).then(async () => {
      anchor.latency.value = 240;
      enabled.value = false;
      await ctx.resume();
    });
    const audio = (await ctx.startRendering()).getChannelData(0);
    await edit;
    expect(Math.max(...audio.slice(0.25 * SR).map(Math.abs))).toBe(0);
    graph.dispose();
    anchor.dispose();
  });
});

it("keeps the old route audible when wall-clock cleanup runs while the audio clock is paused", async () => {
  const ctx = new OfflineAudioContext(1, Math.round(0.8 * SR), SR),
    anchor = new LatencyAnchor(ctx, 0),
    source = signal(ctx),
    join = new GainNode(ctx);
  const graph = defineGraph(
    () => [
      [source, join],
      [anchor, join],
      [join, ctx.destination],
    ],
    { context: ctx },
  );
  const edit = ctx.suspend(0.2).then(async () => {
    anchor.latency.value = 240;
    const pausedAt = ctx.currentTime;
    // The scheduled fade ends about 40ms of AUDIO time later. Hold for 90ms
    // of real time so the cleanup timer runs before the context resumes.
    await new Promise<void>((resolve) => setTimeout(resolve, 90));
    expect(ctx.state).toBe("suspended");
    expect(ctx.currentTime).toBe(pausedAt);
    await ctx.resume();
  });
  const audio = (await ctx.startRendering()).getChannelData(0);
  await edit;
  expect(maxJump(audio)).toBeLessThan(JUMP_LIMIT);
  expect(Math.min(...audio.slice(0.19 * SR, 0.5 * SR))).toBeGreaterThan(0.06);
  graph.dispose();
  anchor.dispose();
});
