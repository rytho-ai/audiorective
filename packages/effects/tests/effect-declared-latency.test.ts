import { describe, expect, it } from "vitest";
import { AudioProcessor, Param } from "@audiorective/core";
import { Effect } from "../src";

const SR = 44100;
const N = 256;

/** Wet arm of plain Web Audio nodes: the graph cannot see its latency, only the declaration can. */
class BareArmEffect extends Effect {
  constructor(ctx: BaseAudioContext, opts = {}) {
    const delay = new DelayNode(ctx, { delayTime: N / SR, maxDelayTime: 1 });
    super(ctx, { input: delay, output: delay }, () => ({ params: {}, cells: {}, latency: N }), opts);
  }
}

class DelayProcessor extends AudioProcessor {
  private readonly delay: DelayNode;
  constructor(ctx: BaseAudioContext) {
    const delay = new DelayNode(ctx, { delayTime: N / SR, maxDelayTime: 1 });
    super(ctx, () => ({ params: {}, cells: {}, latency: N }) as never);
    this.delay = delay;
  }
  override get input() {
    return this.delay;
  }
  override get output() {
    return this.delay;
  }
}

/** Wet arm is a processor that declares its own latency; the effect declares nothing and derives it. */
class ProcessorArmEffect extends Effect {
  constructor(ctx: BaseAudioContext, opts = {}) {
    const arm = new DelayProcessor(ctx);
    super(ctx, { input: arm, output: arm }, () => ({ params: {}, cells: {} }), opts);
  }
}

/** Declares latency through a Param that is raised after construction. */
class ParamLatencyEffect extends Effect {
  readonly declared: Param<number>;
  constructor(ctx: BaseAudioContext, opts = {}) {
    const delay = new DelayNode(ctx, { delayTime: N / SR, maxDelayTime: 1 });
    const declared = new Param<number>({ default: 0 });
    super(ctx, { input: delay, output: delay }, () => ({ params: {}, cells: {}, latency: declared }), opts);
    this.declared = declared;
  }
}

async function impulsePeaks(make: (ctx: OfflineAudioContext) => Effect, after?: (fx: Effect) => void): Promise<number[]> {
  const ctx = new OfflineAudioContext(1, SR / 2, SR);
  const fx = make(ctx);
  after?.(fx);
  const buffer = ctx.createBuffer(1, 1, SR);
  buffer.getChannelData(0)[0] = 1;
  const src = new AudioBufferSourceNode(ctx, { buffer });
  src.connect(fx.input);
  fx.output.connect(ctx.destination);
  src.start(0);
  const out = (await ctx.startRendering()).getChannelData(0);
  const hits: number[] = [];
  for (let i = 0; i < out.length; i++) if (Math.abs(out[i]) > 0.05) hits.push(i);
  return hits;
}

describe("Effect keeps a declared latency on the dry path", () => {
  for (const [name, Make] of [
    ["bare-node arm declaring 256", BareArmEffect],
    ["processor arm with 256", ProcessorArmEffect],
  ] as const) {
    it(`${name}: active and bypassed both land at 256`, async () => {
      expect(await impulsePeaks((c) => new Make(c))).toEqual([N]);
      expect(await impulsePeaks((c) => new Make(c, { bypass: true }))).toEqual([N]);
    });

    it(`${name}: wet 0.5 puts dry and wet on the same sample`, async () => {
      expect(await impulsePeaks((c) => new Make(c, { wet: 0.5 }))).toEqual([N]);
    });
  }

  it("a declared Param latency delays the dry path while bypassed and follows later values", async () => {
    const hits = await impulsePeaks(
      (c) => new ParamLatencyEffect(c, { bypass: true }),
      (fx) => {
        (fx as ParamLatencyEffect).declared.value = N;
      },
    );
    expect(hits).toEqual([N]);
  });

  it("a zero declared latency adds no dry delay", async () => {
    class ZeroEffect extends Effect {
      constructor(ctx: BaseAudioContext) {
        const gain = new GainNode(ctx);
        super(ctx, { input: gain, output: gain }, () => ({ params: {}, cells: {}, latency: 0 }));
      }
    }
    const ctx = new OfflineAudioContext(1, 128, SR);
    const fx = new ZeroEffect(ctx);
    expect((fx as unknown as { _dryDelay?: DelayNode })._dryDelay).toBeUndefined();
    expect(await impulsePeaks((c) => new ZeroEffect(c), undefined)).toEqual([0]);
  });
});
