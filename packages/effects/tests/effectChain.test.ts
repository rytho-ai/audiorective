import { describe, expect, expectTypeOf, it } from "vitest";
import { AudioProcessor, effect, type Param } from "@audiorective/core";
import {
  Distortion,
  Effect,
  EffectChain,
  Filter,
  PingPongDelay,
  type AnyEffect,
  type Compressor,
  type Convolver,
  type Ducker,
  type Equalizer,
  type FrequencyShifter,
  type Limiter,
  type Phaser,
  type PitchShift,
  type EffectStatus,
} from "../src";

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
  it("keeps typed shared controls on heterogeneous built-in and custom effects", () => {
    expectTypeOf<Filter>().toMatchTypeOf<AnyEffect>();
    expectTypeOf<Distortion>().toMatchTypeOf<AnyEffect>();
    expectTypeOf<PingPongDelay>().toMatchTypeOf<AnyEffect>();
    expectTypeOf<Convolver>().toMatchTypeOf<AnyEffect>();
    expectTypeOf<Compressor>().toMatchTypeOf<AnyEffect>();
    expectTypeOf<Limiter>().toMatchTypeOf<AnyEffect>();
    expectTypeOf<Ducker>().toMatchTypeOf<AnyEffect>();
    expectTypeOf<Equalizer>().toMatchTypeOf<AnyEffect>();
    expectTypeOf<Phaser>().toMatchTypeOf<AnyEffect>();
    expectTypeOf<FrequencyShifter>().toMatchTypeOf<AnyEffect>();
    expectTypeOf<PitchShift>().toMatchTypeOf<AnyEffect>();
    expectTypeOf<Scale>().toMatchTypeOf<AnyEffect>();
    const effect: AnyEffect = new Scale(new OfflineAudioContext(1, 128, SR));
    const stopBypass = effect.params.bypass.subscribe(
      (value) => {
        expectTypeOf(value).toEqualTypeOf<boolean>();
        expect(value).toBe(false);
      },
      { immediate: true },
    );
    const stopStatus = effect.cells.status.subscribe(
      (status) => {
        expectTypeOf(status).toEqualTypeOf<EffectStatus>();
        expect(status).toBe("ready");
      },
      { immediate: true },
    );
    expectTypeOf(effect.params.wet.value).toEqualTypeOf<number>();
    stopBypass();
    stopStatus();
    effect.dispose();
  });

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
    let removed!: AnyEffect;
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

  it("commands do not subscribe their caller while public JSON reads stay tracked", () => {
    const ctx = new OfflineAudioContext(1, 128, SR),
      a = new Scale(ctx),
      b = new Scale(ctx),
      chain = new EffectChain(ctx, [a, b]);
    let commands = 0;
    const stopCommand = effect(() => {
      commands++;
      chain.move(a, 1);
    });
    const lengths: number[] = [];
    const stopRead = effect(() => {
      lengths.push(chain.toJSON().effects.length);
    });
    chain.add(new Scale(ctx));
    expect(commands).toBe(1);
    expect(lengths).toEqual([2, 3]);
    stopCommand();
    stopRead();
    chain.dispose();
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
    const { chain: copy, issues } = EffectChain.fromJSON(ctx, json, { types });
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
      const result = EffectChain.fromJSON(ctx, { version: 1, effects: [{ type: "Filter", params: { frequency: 1800, wet: 0.3 } }] }, { types });
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

  it.each(["fromJSON", "fromJSON-partial", "restore"] as const)(
    "%s initializes saved bypass in both directions, then retains click-free live changes",
    async (method) => {
      for (const { saved, factory } of [
        { saved: true, factory: false },
        { saved: false, factory: false },
        { saved: true, factory: true },
        { saved: false, factory: true },
      ]) {
        const ctx = new OfflineAudioContext(2, 16384, SR);
        const start = 2048,
          live = 8192;
        const merger = new ChannelMergerNode(ctx, { numberOfInputs: 2 });
        merger.connect(ctx.destination);
        const source = new ConstantSourceNode(ctx, { offset: 0.12 });
        source.start(start / SR);
        let chain!: EffectChain, reference!: Distortion, restored!: Distortion;
        let issues: unknown;
        const prepared = ctx.suspend(start / SR).then(async () => {
          try {
            reference = new Distortion(ctx, { bypass: saved });
            const json = {
              version: 1,
              effects: [{ type: "Distortion", params: { wet: 1, bypass: saved, ...(method === "fromJSON-partial" ? { unknown: 1 } : {}) } }],
            };
            // Factories may start with either gate state; saved values must replace it immediately.
            const types = { Distortion: factory ? (context: BaseAudioContext) => new Distortion(context, { bypass: !saved }) : Distortion };
            if (method !== "restore") {
              const result = EffectChain.fromJSON(ctx, json, { types });
              chain = result.chain;
              issues = result.issues;
            } else {
              chain = new EffectChain(ctx);
              issues = await chain.restore(json, { types });
            }
            restored = chain.cells.effects.value[0] as Distortion;
            source.connect(reference.input);
            source.connect(restored.input);
            reference.output.connect(merger, 0, 0);
            // Observe the published prepared effect itself: a later chain handover must not hide bad initial settings.
            restored.output.connect(merger, 0, 1);
          } finally {
            await ctx.resume();
          }
        });
        const edited = ctx.suspend(live / SR).then(async () => {
          try {
            reference.params.bypass.value = !saved;
            restored.params.bypass.value = !saved;
          } finally {
            await ctx.resume();
          }
        });
        const output = await ctx.startRendering();
        await Promise.all([prepared, edited]);
        expect(issues).toEqual(method === "fromJSON-partial" ? [{ path: "effects[0].params.unknown", message: "unknown parameter" }] : []);
        const expected = output.getChannelData(0),
          actual = output.getChannelData(1);
        let firstDifference = 0;
        for (let frame = start; frame < start + 256; frame++)
          firstDifference = Math.max(firstDifference, Math.abs(actual[frame]! - expected[frame]!));
        expect(firstDifference, `${method}: saved=${saved}, factory=${factory}`).toBeLessThan(1e-6);
        let liveDifference = 0;
        for (let frame = live; frame < actual.length; frame++) liveDifference = Math.max(liveDifference, Math.abs(actual[frame]! - expected[frame]!));
        expect(liveDifference).toBeLessThan(1e-6);
        const initial = actual[start + 128]!,
          final = actual.at(-1)!;
        expect(Math.abs(final - initial)).toBeGreaterThan(0.5);
        expect(actual[live + 256]).toBeCloseTo(initial, 5); // still inside the native fade's 10 ms lead
        const duringFade = actual[live + Math.round(0.013 * SR)]!;
        expect(duringFade).toBeGreaterThan(Math.min(initial, final));
        expect(duringFade).toBeLessThan(Math.max(initial, final));
        expect(maxStep(actual, live)).toBeLessThan(0.01);
        chain.dispose();
        reference.dispose();
      }
    },
  );

  it("a built-in effect subclass keeps its own serialization type", () => {
    class CustomDelay extends PingPongDelay {
      static override readonly type = "CustomDelay";
    }
    const ctx = new OfflineAudioContext(1, 128, SR);
    const original = new EffectChain(ctx, [new CustomDelay(ctx, { delayTime: 0.4 })]);
    const json = JSON.parse(JSON.stringify(original));
    expect(json.effects[0].type).toBe("CustomDelay");
    const { chain, issues } = EffectChain.fromJSON(ctx, json, { types: { CustomDelay } });
    expect(issues).toEqual([]);
    expect(chain.cells.effects.value[0]).toBeInstanceOf(CustomDelay);
    expect((chain.cells.effects.value[0] as CustomDelay).params.delayTime.value).toBe(0.4);
    chain.dispose();
    original.dispose();
  });

  it("unknown types and invalid parameters become issues, not throws", () => {
    const ctx = new OfflineAudioContext(1, 128, SR);
    const { chain, issues } = EffectChain.fromJSON(
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
      const { chain, issues } = EffectChain.fromJSON(ctx, bad, { types });
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
    const { chain, issues } = EffectChain.fromJSON(
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
    const { chain, issues } = EffectChain.fromJSON(
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
    const { chain, issues } = EffectChain.fromJSON(
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

function deferred() {
  let resolve!: () => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

class TrackedScale extends Scale {
  disposals = 0;
  override dispose(): void {
    this.disposals++;
    super.dispose();
  }
}
class LoadingScale extends TrackedScale {
  constructor(context: BaseAudioContext, wait: Promise<void>) {
    super(context);
    this.track(wait);
  }
}

describe("EffectChain live restore", () => {
  const preset = (...types: string[]) => ({ version: 1, effects: types.map((type) => ({ type, params: { wet: 1, bypass: false } })) });

  it("keeps stable I/O and crossfades a running preset without clicks or silence", async () => {
    const ctx = new OfflineAudioContext(1, SR, SR);
    const previous = new TrackedScale(ctx, 2);
    const chain = new EffectChain(ctx, [previous]);
    const input = chain.input,
      output = chain.output;
    const source = new ConstantSourceNode(ctx, { offset: 0.1 });
    source.connect(input);
    chain.connect(ctx.destination);
    source.start();
    let next!: TrackedScale;
    let publications = 0;
    const stop = chain.cells.effects.subscribe(() => publications++);
    const edit = ctx.suspend(0.2).then(async () => {
      const issues = await chain.restore(preset("Triple"), { types: { Triple: (c) => (next = new TrackedScale(c, 3)) } });
      expect(issues).toEqual([]);
      expect(chain.input).toBe(input);
      expect(chain.output).toBe(output);
      expect(chain.cells.effects.value).toEqual([next]);
      await ctx.resume();
    });
    const audio = (await ctx.startRendering()).getChannelData(0);
    await edit;
    expect(publications).toBe(1);
    expect(maxStep(audio, Math.round(0.18 * SR), Math.round(0.6 * SR))).toBeLessThan(0.01);
    expect(longestSilence(audio, Math.round(0.18 * SR), Math.round(0.6 * SR))).toBe(0);
    expect(audio[Math.round(0.8 * SR)]).toBeCloseTo(0.3, 5);
    expect(previous.disposals).toBe(1);
    stop();
    chain.dispose();
    expect(next.disposals).toBe(1);
  });

  it("strict schema failures dispose provisional effects and leave the exact live snapshot untouched", async () => {
    const ctx = new OfflineAudioContext(1, 128, SR),
      old = new TrackedScale(ctx),
      chain = new EffectChain(ctx, [old]);
    const snapshot = chain.cells.effects.value,
      original = chain.toJSON();
    const good = { type: "Tracked", params: { wet: 0.4, bypass: false } };
    const badEntries = [
      null,
      { type: "Tracked" },
      { type: "Tracked", params: [] },
      { type: "Tracked", params: { wet: 2 } },
      { type: "Tracked", params: { unknown: 1 } },
      { type: "Tracked", params: { wet: NaN } },
      { type: "Tracked", params: { bypass: "yes" } },
      { type: "Tracked", params: {}, extra: 1 },
      { type: "Missing", params: {} },
    ];
    for (const bad of [
      null,
      { version: 2, effects: [] },
      { version: 1, effects: [good], extra: 1 },
      ...badEntries.map((entry) => ({ version: 1, effects: [good, entry] })),
    ]) {
      const provisional: TrackedScale[] = [];
      const issues = await chain.restore(bad, {
        types: {
          Tracked: (c) => {
            const e = new TrackedScale(c);
            provisional.push(e);
            return e;
          },
        },
      });
      expect(issues.length).toBeGreaterThan(0);
      expect(chain.cells.effects.value).toBe(snapshot);
      expect(chain.toJSON()).toEqual(original);
      expect(old.disposals).toBe(0);
      for (const effect of provisional) expect(effect.disposals).toBe(1);
    }
    chain.dispose();
  });

  it("rejects a factory reusing a live effect without changing or disposing it", async () => {
    const ctx = new OfflineAudioContext(1, 128, SR),
      old = new TrackedScale(ctx),
      chain = new EffectChain(ctx, [old]);
    const issues = await chain.restore({ version: 1, effects: [{ type: "Reused", params: { wet: 0 } }] }, { types: { Reused: () => old } });
    expect(issues[0]!.message).toContain("new effect");
    expect(old.params.wet.value).toBe(1);
    expect(old.disposals).toBe(0);
    expect(chain.cells.effects.value).toEqual([old]);
    chain.dispose();
  });

  it("readiness failure rolls back promptly even when another candidate never becomes ready", async () => {
    const ctx = new OfflineAudioContext(1, 128, SR),
      old = new TrackedScale(ctx),
      chain = new EffectChain(ctx, [old]);
    const fail = deferred(),
      never = deferred();
    let first!: LoadingScale, second!: LoadingScale;
    const load = chain.restore(preset("Fail", "Never"), {
      types: { Fail: (c) => (first = new LoadingScale(c, fail.promise)), Never: (c) => (second = new LoadingScale(c, never.promise)) },
    });
    expect(chain.cells.effects.value).toEqual([old]);
    fail.reject(new Error("IR failed"));
    const issues = await load;
    expect(issues[0]!.path).toBe("effects[0]");
    expect(issues[0]!.message).toContain("IR failed");
    expect(first.disposals).toBe(1);
    expect(second.disposals).toBe(1);
    expect(old.disposals).toBe(0);
    expect(chain.cells.effects.value).toEqual([old]);
    never.resolve();
    chain.dispose();
  });

  it("waits for every candidate and publishes exactly one complete target snapshot", async () => {
    const ctx = new OfflineAudioContext(1, 128, SR),
      chain = new EffectChain(ctx, [new Scale(ctx)]),
      a = deferred(),
      b = deferred();
    const snapshots: Array<readonly AnyEffect[]> = [];
    const stop = chain.cells.effects.subscribe((value) => snapshots.push(value));
    let first!: LoadingScale, second!: LoadingScale;
    const load = chain.restore(preset("A", "B"), {
      types: { A: (c) => (first = new LoadingScale(c, a.promise)), B: (c) => (second = new LoadingScale(c, b.promise)) },
    });
    a.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(snapshots).toEqual([]);
    b.resolve();
    expect(await load).toEqual([]);
    expect(snapshots).toEqual([[first, second]]);
    expect(chain.cells.effects.value).toBe(snapshots[0]);
    stop();
    chain.dispose();
  });

  it("supersedes pending work, disposes stale candidates and ignores their later readiness", async () => {
    const ctx = new OfflineAudioContext(1, 128, SR),
      chain = new EffectChain(ctx, [new Scale(ctx)]),
      wait = deferred();
    let stale!: LoadingScale, next!: TrackedScale;
    const first = chain.restore(preset("Slow"), { types: { Slow: (c) => (stale = new LoadingScale(c, wait.promise)) } });
    const rejected = expect(first).rejects.toMatchObject({ name: "AbortError" });
    const second = chain.restore(preset("Next"), { types: { Next: (c) => (next = new TrackedScale(c, 3)) } });
    await rejected;
    expect(await second).toEqual([]);
    expect(stale.disposals).toBe(1);
    wait.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(chain.cells.effects.value).toEqual([next]);
    chain.dispose();
  });

  it("an aborted restore cancels only its job, including the resolve-before-abort race", async () => {
    const ctx = new OfflineAudioContext(1, 128, SR),
      old = new TrackedScale(ctx),
      chain = new EffectChain(ctx, [old]),
      wait = deferred(),
      abort = new AbortController();
    let candidate!: LoadingScale;
    const load = chain.restore(preset("Slow"), { types: { Slow: (c) => (candidate = new LoadingScale(c, wait.promise)) }, signal: abort.signal });
    const rejected = expect(load).rejects.toMatchObject({ name: "AbortError" });
    wait.resolve();
    abort.abort();
    await rejected;
    expect(candidate.disposals).toBe(1);
    expect(old.disposals).toBe(0);
    expect(chain.cells.effects.value).toEqual([old]);
    chain.add(new Scale(ctx, 3));
    expect(chain.cells.effects.value).toHaveLength(2);
    chain.dispose();
  });

  it("an already-aborted job creates no effects and a completed job relinquishes its signal", async () => {
    const ctx = new OfflineAudioContext(1, 128, SR),
      chain = new EffectChain(ctx),
      abort = new AbortController();
    abort.abort();
    let calls = 0;
    await expect(
      chain.restore(preset("Scale"), {
        types: {
          Scale: (c) => {
            calls++;
            return new Scale(c);
          },
        },
        signal: abort.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(calls).toBe(0);
    const later = new AbortController();
    expect(await chain.restore(preset("Scale"), { types: { Scale }, signal: later.signal })).toEqual([]);
    later.abort();
    expect(chain.cells.effects.value).toHaveLength(1);
    chain.add(new Scale(ctx));
    chain.dispose();
  });

  it("disposing the chain cancels its pending job and prevents stale publication", async () => {
    const ctx = new OfflineAudioContext(1, 128, SR),
      old = new TrackedScale(ctx),
      chain = new EffectChain(ctx, [old]),
      wait = deferred();
    let candidate!: LoadingScale;
    const load = chain.restore(preset("Slow"), { types: { Slow: (c) => (candidate = new LoadingScale(c, wait.promise)) } });
    const rejected = expect(load).rejects.toMatchObject({ name: "AbortError" });
    chain.dispose();
    await rejected;
    wait.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(candidate.disposals).toBe(1);
    expect(old.disposals).toBe(1);
    expect(chain.cells.effects.value).toEqual([]);
    await expect(chain.restore(preset("Scale"), { types: { Scale } })).rejects.toThrow("disposed");
  });

  it("queues the complete replacement after existing edits and before subscriber edits", async () => {
    const ctx = new OfflineAudioContext(1, SR, SR),
      first = new Scale(ctx, 2),
      second = new Scale(ctx, 3),
      chain = new EffectChain(ctx, [first, second]);
    const source = new ConstantSourceNode(ctx, { offset: 0.001 });
    source.connect(chain.input);
    chain.connect(ctx.destination);
    source.start();
    let a!: Scale, b!: Scale;
    const appended = new Scale(ctx, 11);
    let appendedOnce = false;
    const snapshots: Array<readonly AnyEffect[]> = [];
    const stop = chain.cells.effects.subscribe((value) => {
      snapshots.push(value);
      if (!appendedOnce && value[0] === a && value[1] === b) {
        appendedOnce = true;
        chain.add(appended);
      }
    });
    const edit = ctx.suspend(0.1).then(async () => {
      chain.move(first, 1);
      expect(
        await chain.restore(preset("Five", "Seven"), { types: { Five: (c) => (a = new Scale(c, 5)), Seven: (c) => (b = new Scale(c, 7)) } }),
      ).toEqual([]);
      await ctx.resume();
    });
    const out = (await ctx.startRendering()).getChannelData(0);
    await edit;
    expect(snapshots.filter((value) => value.length === 2 && value[0] === a && value[1] === b)).toHaveLength(1);
    expect(chain.cells.effects.value).toEqual([a, b, appended]);
    expect(out[Math.round(0.9 * SR)]).toBeCloseTo(0.385, 4);
    stop();
    chain.dispose();
  });

  it("fromJSON remains a tolerant factory and reports non-Effect factory results", () => {
    const ctx = new OfflineAudioContext(1, 128, SR);
    const { chain, issues } = EffectChain.fromJSON(
      ctx,
      {
        version: 1,
        effects: [
          { type: "Scale", params: {} },
          { type: "Bad", params: {} },
          { type: "Missing", params: {} },
        ],
      },
      { types: { Scale, Bad: (() => null) as never } },
    );
    expect(chain.cells.effects.value).toHaveLength(1);
    expect(issues).toHaveLength(2);
    expect(issues[0]!.message).toContain("factory must return an Effect");
    chain.dispose();
  });
});

describe("EffectChain restore boundary cases", () => {
  it("cancels safely when a factory aborts during construction", async () => {
    const ctx = new OfflineAudioContext(1, 128, SR),
      abort = new AbortController(),
      old = new Scale(ctx),
      chain = new EffectChain(ctx, [old]);
    let candidate!: TrackedScale;
    await expect(
      chain.restore(
        { version: 1, effects: [{ type: "Cancel", params: {} }] },
        {
          signal: abort.signal,
          types: {
            Cancel: (c) => {
              candidate = new TrackedScale(c);
              abort.abort();
              return candidate;
            },
          },
        },
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(candidate.disposals).toBe(1);
    expect(chain.cells.effects.value).toEqual([old]);
    chain.dispose();
  });
  it("loads an empty preset without replacing the chain's I/O", async () => {
    const ctx = new OfflineAudioContext(1, 128, SR),
      old = new TrackedScale(ctx),
      chain = new EffectChain(ctx, [old]),
      input = chain.input,
      output = chain.output;
    expect(await chain.restore({ version: 1, effects: [] }, { types: {} })).toEqual([]);
    expect(chain.cells.effects.value).toEqual([]);
    expect(old.disposals).toBe(1);
    expect(chain.input).toBe(input);
    expect(chain.output).toBe(output);
    chain.add(new Scale(ctx));
    expect(chain.cells.effects.value).toHaveLength(1);
    chain.dispose();
  });
  it("initializes a live-load candidate's native settings before its first audio sample", async () => {
    const ctx = new OfflineAudioContext(1, 8192, SR),
      chain = new EffectChain(ctx);
    const edit = ctx.suspend(2048 / SR).then(async () => {
      expect(
        await chain.restore({ version: 1, effects: [{ type: "Filter", params: { frequency: 1800, wet: 0.3 } }] }, { types: { Filter } }),
      ).toEqual([]);
      const filter = chain.cells.effects.value[0] as Filter;
      filter.params.frequency.syncFromAudio();
      filter.params.wet.syncFromAudio();
      expect(filter.params.frequency.value).toBe(1800);
      expect(filter.params.wet.value).toBeCloseTo(0.3, 6);
      expect(filter.params.frequency.smoothing).toBe(0.01);
      await ctx.resume();
    });
    await ctx.startRendering();
    await edit;
    chain.dispose();
  });
});

describe("EffectChain restore reentrancy", () => {
  const json = (type: string) => ({ version: 1, effects: [{ type, params: {} }] });
  it("rejects and disposes a wrong-context candidate before changing the live chain", async () => {
    const ctx = new OfflineAudioContext(1, 128, SR),
      other = new OfflineAudioContext(1, 128, SR),
      old = new TrackedScale(ctx),
      chain = new EffectChain(ctx, [old]);
    const candidate = new TrackedScale(other);
    const issues = await chain.restore(json("Wrong"), { types: { Wrong: () => candidate } });
    expect(issues[0]!.message).toContain("another audio context");
    expect(candidate.disposals).toBe(1);
    expect(old.disposals).toBe(0);
    expect(chain.cells.effects.value).toEqual([old]);
    chain.dispose();
  });
  it("a restore started by a factory supersedes that factory's parent job without leaking either candidate", async () => {
    const ctx = new OfflineAudioContext(1, 128, SR),
      chain = new EffectChain(ctx, [new Scale(ctx)]);
    let stale!: TrackedScale, fresh!: TrackedScale, nested!: Promise<unknown>;
    const outer = chain.restore(json("Outer"), {
      types: {
        Outer: (c) => {
          stale = new TrackedScale(c);
          nested = chain.restore(json("Nested"), { types: { Nested: (n) => (fresh = new TrackedScale(n, 3)) } });
          return stale;
        },
      },
    });
    await expect(outer).rejects.toMatchObject({ name: "AbortError" });
    expect(await nested).toEqual([]);
    expect(stale.disposals).toBe(1);
    expect(fresh.disposals).toBe(0);
    expect(chain.cells.effects.value).toEqual([fresh]);
    chain.dispose();
  });
  it("a subscriber can start the next restore after publication without cancelling the committed preset", async () => {
    const ctx = new OfflineAudioContext(1, SR, SR),
      old = new TrackedScale(ctx, 2),
      chain = new EffectChain(ctx, [old]);
    const source = new ConstantSourceNode(ctx, { offset: 0.1 });
    source.connect(chain.input);
    chain.connect(ctx.destination);
    source.start();
    let first!: TrackedScale, last!: TrackedScale, next: Promise<unknown> | undefined;
    const snapshots: Array<readonly AnyEffect[]> = [];
    const stop = chain.cells.effects.subscribe((value) => {
      snapshots.push(value);
      if (value[0] === first && !next) next = chain.restore(json("Last"), { types: { Last: (c) => (last = new TrackedScale(c, 4)) } });
    });
    const edit = ctx.suspend(0.1).then(async () => {
      expect(await chain.restore(json("First"), { types: { First: (c) => (first = new TrackedScale(c, 3)) } })).toEqual([]);
      expect(await next).toEqual([]);
      await ctx.resume();
    });
    const output = (await ctx.startRendering()).getChannelData(0);
    await edit;
    expect(snapshots).toEqual([[first], [last]]);
    expect(chain.cells.effects.value).toEqual([last]);
    expect(first.disposals).toBe(1);
    expect(last.disposals).toBe(0);
    expect(output[Math.round(0.8 * SR)]).toBeCloseTo(0.4, 5);
    stop();
    chain.dispose();
  });
});
