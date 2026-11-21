import { describe, expect, it } from "vitest";
import { AudioProcessor, effect, type Param } from "@audiorective/core";
import { Distortion, Effect, EffectChain, Filter, PingPongDelay } from "../src";

const SR = 44100;

/** Pass-through effect that scales by a constant, so each chain order has a distinct, exact result. */
class Scale extends Effect<{}> {
  static override readonly type = "Scale";
  constructor(ctx: BaseAudioContext, factor = 2) {
    const g = new GainNode(ctx, { gain: factor });
    super(ctx, { input: g, output: g }, () => ({ params: {}, cells: {} }));
  }
}

/** Plays a 330 Hz sine through the chain, running `edit` at `at` seconds. */
async function render(
  build: (ctx: OfflineAudioContext) => EffectChain,
  seconds: number,
  edit?: (chain: EffectChain) => void,
  at = 0.1,
  source: "sine" | "dc" = "sine",
) {
  const ctx = new OfflineAudioContext(1, Math.round(SR * seconds), SR);
  const chain = build(ctx);
  const src = source === "sine" ? new OscillatorNode(ctx, { frequency: 330 }) : new ConstantSourceNode(ctx, { offset: 0.25 });
  const amp = new GainNode(ctx, { gain: 0.25 });
  src.connect(amp).connect(chain.input);
  chain.output.connect(ctx.destination);
  src.start();
  if (edit) {
    ctx.suspend(at).then(() => {
      edit(chain);
      ctx.resume();
    });
  }
  return { out: (await ctx.startRendering()).getChannelData(0), chain };
}
const maxStep = (d: Float32Array, from = 1, to = d.length) => {
  let m = 0;
  for (let i = from; i < to; i++) m = Math.max(m, Math.abs(d[i]! - d[i - 1]!));
  return m;
};
/** Longest run of near-silent samples in [from, to). */
const longestSilence = (d: Float32Array, from: number, to: number) => {
  let run = 0;
  let best = 0;
  for (let i = from; i < to; i++) {
    run = Math.abs(d[i]!) < 1e-4 ? run + 1 : 0;
    best = Math.max(best, run);
  }
  return best;
};
const peak = (d: Float32Array, seconds: number, length: number) => {
  let m = 0;
  for (let i = Math.round(seconds * SR); i < Math.round((seconds + length) * SR); i++) m = Math.max(m, Math.abs(d[i]!));
  return m;
};
const SLOPE = 0.25 * 2 * Math.PI * (330 / SR); // the sine's own largest sample step

describe("EffectChain", () => {
  it("applies the effects in order, reports them in cells.effects, and exposes latency", async () => {
    const { out, chain } = await render((ctx) => new EffectChain(ctx, [new Scale(ctx, 2), new Scale(ctx, 3)]), 0.2, undefined, 0.1, "dc");
    expect(out[4000]).toBeCloseTo(0.0625 * 6, 4);
    expect(chain.cells.effects.value).toHaveLength(2);
    expect(chain.latency.value).toBe(0);
  });

  it("add inserts click-free with no gap and ends in the new topology", async () => {
    const { out } = await render(
      (ctx) => new EffectChain(ctx, [new Scale(ctx, 2)]),
      0.4,
      (chain) => chain.add(new Scale(ctx0(chain), 3), 0),
    );
    expect(peak(out, 0.3, 0.1)).toBeCloseTo(0.25 * 6, 1);
    expect(maxStep(out, 100)).toBeLessThan(SLOPE * 6 * 1.2);
    expect(longestSilence(out, 2000, out.length)).toBeLessThan(8);
  });

  it("remove is click-free, disposes the effect, and ends without it", async () => {
    let removed!: Effect;
    const { out, chain } = await render(
      (ctx) => {
        removed = new Scale(ctx, 3);
        return new EffectChain(ctx, [new Scale(ctx, 2), removed]);
      },
      0.4,
      (chain) => chain.remove(chain.cells.effects.value[1]!),
    );
    expect(chain.cells.effects.value).toHaveLength(1);
    expect(peak(out, 0.3, 0.1)).toBeCloseTo(0.25 * 2, 1);
    expect(maxStep(out, 100)).toBeLessThan(SLOPE * 6 * 1.2);
    expect(longestSilence(out, 2000, out.length)).toBeLessThan(8);
  });

  it("move reorders without a click, a dropout or a feedback loop", async () => {
    // A filter then a delay: moving the delay first changes the sound but the signal never breaks.
    const { out, chain } = await render(
      (ctx) =>
        new EffectChain(ctx, [new Filter(ctx, { frequency: 1500, wet: 1 }), new PingPongDelay(ctx, { delayTime: 0.01, feedback: 0.3, wet: 0.5 })]),
      0.6,
      (chain) => chain.move(chain.cells.effects.value[1]!, 0),
    );
    expect(chain.cells.effects.value[0]).toBeInstanceOf(PingPongDelay);
    expect(maxStep(out, 4000)).toBeLessThan(SLOPE * 2);
    expect(longestSilence(out, 4000, out.length)).toBeLessThan(8);
    expect(Math.max(...Array.from(out.slice(-4000), Math.abs))).toBeLessThan(0.5);
  });

  it("an A, B, A move cycle never drops the signal (no silence gap)", async () => {
    const { out } = await render(
      (ctx) => new EffectChain(ctx, [new Scale(ctx, 2), new Scale(ctx, 3), new Scale(ctx, 4)]),
      0.8,
      (chain) => {
        const [a, b] = chain.cells.effects.value;
        chain.move(a!, 2);
        chain.move(b!, 0);
        chain.move(a!, 0);
      },
    );
    expect(longestSilence(out, 2000, out.length)).toBeLessThan(8);
    expect(maxStep(out, 100)).toBeLessThan(SLOPE * 24 * 1.2);
  });

  it("an effect keeps its tail when another effect moves", async () => {
    const { out } = await render(
      (ctx) => {
        const delay = new PingPongDelay(ctx, { delayTime: 0.05, feedback: 0.5, wet: 1 });
        return new EffectChain(ctx, [new Scale(ctx, 1), delay]);
      },
      0.5,
      (chain) => chain.move(chain.cells.effects.value[0]!, 1),
      0.3,
    );
    expect(Math.max(...Array.from(out.slice(-2000), Math.abs))).toBeGreaterThan(0.02);
  });

  it("throws for duplicates and strangers; a disposed chain throws", () => {
    const ctx = new OfflineAudioContext(1, 128, SR);
    const a = new Scale(ctx);
    const chain = new EffectChain(ctx, [a]);
    expect(() => chain.add(a)).toThrow("EffectChain: effect is already in the chain.");
    expect(() => chain.remove(new Scale(ctx))).toThrow("EffectChain: effect is not in this chain.");
    expect(() => chain.move(new Scale(ctx), 0)).toThrow("EffectChain: effect is not in this chain.");
    expect(() => new EffectChain(ctx, [a, a])).toThrow("EffectChain: effect is already in the chain.");
    chain.dispose();
    expect(() => chain.add(new Scale(ctx))).toThrow("EffectChain is disposed.");
  });

  it("cells.effects is tracked and read-only", () => {
    const ctx = new OfflineAudioContext(1, 128, SR);
    const chain = new EffectChain(ctx);
    const seen: number[] = [];
    const stop = effect(() => void seen.push(chain.cells.effects.value.length));
    chain.add(new Scale(ctx));
    chain.add(new Scale(ctx));
    stop();
    expect(seen).toEqual([0, 1, 2]);
    expect(Boolean(Object.getOwnPropertyDescriptor(Object.getPrototypeOf(chain.cells.effects), "value")?.set)).toBe(false);
  });

  it("dispose releases every effect; an aborted signal disposes the chain", () => {
    const ctx = new OfflineAudioContext(1, 128, SR);
    const controller = new AbortController();
    const a = new Scale(ctx);
    const chain = new EffectChain(ctx, [a], { signal: controller.signal });
    controller.abort();
    expect(() => chain.add(new Scale(ctx))).toThrow("disposed");
    expect(() => a.dispose()).not.toThrow();
  });

  it("derives its latency from the effects it holds", () => {
    const ctx = new OfflineAudioContext(1, 128, SR);
    class Late extends Effect<{}> {
      constructor() {
        const g = new GainNode(ctx);
        super(ctx, { input: g, output: g }, () => ({ params: {}, cells: {}, latency: 64 }));
      }
    }
    const chain = new EffectChain(ctx, [new Late()]);
    expect(chain.latency.value).toBe(64);
    chain.add(new Late());
    expect(chain.latency.value).toBe(128);
  });

  it("connects like any processor", () => {
    const ctx = new OfflineAudioContext(1, 128, SR);
    const chain = new EffectChain(ctx);
    expect(chain instanceof AudioProcessor).toBe(true);
    expect(chain.connect(ctx.destination)).toBe(ctx.destination);
  });
});

describe("EffectChain.toJSON and restore", () => {
  const types = { Filter, Distortion, PingPongDelay, Scale: (ctx: BaseAudioContext) => new Scale(ctx) };

  it("round-trips order, parameters and bypass", () => {
    const ctx = new OfflineAudioContext(1, 128, SR);
    const filter = new Filter(ctx, { frequency: 900 });
    const dist = new Distortion(ctx, { distortion: 0.7 });
    dist.params.bypass.value = true;
    const chain = new EffectChain(ctx, [filter, dist]);
    const json = JSON.parse(JSON.stringify(chain));
    expect(json.version).toBe(1);
    expect(json.effects.map((e: { type: string }) => e.type)).toEqual(["Filter", "Distortion"]);
    const { chain: copy, issues } = EffectChain.restore(ctx, json, { types });
    expect(issues).toEqual([]);
    const [f, d] = copy.cells.effects.value as [Filter, Distortion];
    expect(f.params.frequency.value).toBe(900);
    expect(d.params.distortion.value).toBe(0.7);
    expect(d.params.bypass.value).toBe(true);
  });

  it("restores initial smoothed settings immediately after the context clock has run", async () => {
    const start = 2048;
    const ctx = new OfflineAudioContext(2, 8192, SR);
    const reference = new Filter(ctx, { frequency: 1800, wet: 0.3 });
    const merger = new ChannelMergerNode(ctx, { numberOfInputs: 2 });
    reference.output.connect(merger, 0, 0);
    merger.connect(ctx.destination);
    const source = new ConstantSourceNode(ctx, { offset: 0.5 });
    source.connect(reference.input);
    source.start(start / SR);
    let restored!: EffectChain;
    let initial!: { frequency: number; wet: number; smoothing: number[] };
    let issues: unknown;
    const edit = ctx.suspend(start / SR).then(async () => {
      const result = EffectChain.restore(ctx, { version: 1, effects: [{ type: "Filter", params: { frequency: 1800, wet: 0.3 } }] }, { types });
      restored = result.chain;
      issues = result.issues;
      const filter = restored.cells.effects.value[0] as Filter;
      // A display poll must observe the restored setting, not constructor defaults.
      filter.params.frequency.syncFromAudio();
      filter.params.wet.syncFromAudio();
      initial = {
        frequency: filter.params.frequency.value,
        wet: filter.params.wet.value,
        smoothing: [filter.params.frequency.smoothing, filter.params.wet.smoothing],
      };
      source.connect(restored.input);
      restored.output.connect(merger, 0, 1);
      await ctx.resume();
    });
    const output = await ctx.startRendering();
    await edit;
    expect(issues).toEqual([]);
    expect(initial.frequency).toBe(1800);
    expect(initial.wet).toBeCloseTo(0.3, 6);
    expect(initial.smoothing).toEqual([0.01, 0.01]);
    const expected = output.getChannelData(0);
    const actual = output.getChannelData(1);
    // Compare the first wet/dry/filter samples, before a 10 ms ramp could settle.
    let difference = 0;
    for (let frame = start; frame < start + 256; frame++) difference = Math.max(difference, Math.abs(actual[frame]! - expected[frame]!));
    expect(difference).toBeLessThan(1e-6);
    restored.dispose();
    reference.dispose();
  });

  it("a built-in effect subclass keeps its own serialization type", () => {
    class CustomDelay extends PingPongDelay {
      static override readonly type = "CustomDelay";
    }
    const ctx = new OfflineAudioContext(1, 128, SR);
    const original = new EffectChain(ctx, [new CustomDelay(ctx, { delayTime: 0.4 })]);
    const json = JSON.parse(JSON.stringify(original));
    expect(json.effects[0].type).toBe("CustomDelay");
    const { chain, issues } = EffectChain.restore(ctx, json, { types: { CustomDelay } });
    expect(issues).toEqual([]);
    expect(chain.cells.effects.value[0]).toBeInstanceOf(CustomDelay);
    expect((chain.cells.effects.value[0] as CustomDelay).params.delayTime.value).toBe(0.4);
    chain.dispose();
    original.dispose();
  });

  it("unknown types and invalid parameters become issues, not throws", () => {
    const ctx = new OfflineAudioContext(1, 128, SR);
    const { chain, issues } = EffectChain.restore(
      ctx,
      {
        version: 1,
        effects: [
          { type: "Filter", params: { frequency: 800, Q: -5, nope: 1, type: 3 } },
          { type: "Reverb9000", params: {} },
          { type: "Equalizer", params: {} },
        ],
      },
      {
        types: {
          ...types,
          Equalizer: class extends Distortion {} as never,
          Boom: (() => {
            throw new Error("x");
          }) as never,
        },
      },
    );
    expect(chain.cells.effects.value).toHaveLength(2);
    expect((chain.cells.effects.value[0] as Filter).params.frequency.value).toBe(800);
    expect(issues.map((i) => i.path)).toEqual(["effects[0].params.Q", "effects[0].params.nope", "effects[0].params.type", "effects[1].type"]);
  });

  it("malformed JSON yields an empty chain and one issue", () => {
    const ctx = new OfflineAudioContext(1, 128, SR);
    for (const bad of [null, 5, "x", {}, { version: 2, effects: [] }, { version: 1, effects: "no" }]) {
      const { chain, issues } = EffectChain.restore(ctx, bad, { types });
      expect(chain.cells.effects.value).toHaveLength(0);
      expect(issues).toHaveLength(1);
    }
  });

  it("a custom bind's validation becomes an issue and restores its previous value", () => {
    const ctx = new OfflineAudioContext(1, 128, SR);
    class Guarded extends Effect<{ choice: Param<string> }> {
      constructor(context: BaseAudioContext) {
        const node = new GainNode(context);
        super(context, { input: node, output: node }, ({ param }) => ({
          params: {
            choice: param({
              default: "safe",
              bind: {
                set: (value) => {
                  if (value !== "safe") throw new RangeError("unsupported choice");
                },
              },
            }),
          },
          cells: {},
        }));
      }
    }
    const { chain, issues } = EffectChain.restore(
      ctx,
      { version: 1, effects: [{ type: "Guarded", params: { choice: "unsafe", wet: 0.5 } }] },
      { types: { ...types, Guarded } },
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]!.path).toBe("effects[0].params.choice");
    const guarded = chain.cells.effects.value[0] as Guarded;
    expect(guarded.params.choice.value).toBe("safe");
    expect(guarded.params.wet.value).toBe(0.5);
    chain.dispose();
  });

  it("reports an invalid saved filter type without desynchronizing its parameter", () => {
    const ctx = new OfflineAudioContext(1, 128, SR);
    const { chain, issues } = EffectChain.restore(
      ctx,
      { version: 1, effects: [{ type: "Filter", params: { type: "not-a-filter", frequency: 800 } }] },
      { types },
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]!.path).toBe("effects[0].params.type");
    const filter = chain.cells.effects.value[0] as Filter;
    expect(filter.params.type.value).toBe("lowpass");
    expect(filter.params.frequency.value).toBe(800);
    chain.dispose();
  });

  it("a constructor that throws becomes an issue", () => {
    const ctx = new OfflineAudioContext(1, 128, SR);
    const { chain, issues } = EffectChain.restore(
      ctx,
      { version: 1, effects: [{ type: "Boom", params: {} }] },
      {
        types: {
          Boom: () => {
            throw new Error("needs bands");
          },
        },
      },
    );
    expect(chain.cells.effects.value).toHaveLength(0);
    expect(issues[0]!.message).toContain("needs bands");
  });
});

function ctx0(chain: EffectChain): BaseAudioContext {
  return chain.context;
}
