import { describe, test, expect, vi } from "vitest";
import { AudioProcessor, Param, SchedulableParam, ParamSync, type SchedulableParam as SP } from "../src";

class Gainer extends AudioProcessor<{ gain: SP; flag: Param<number> }> {
  readonly node: GainNode;
  constructor(ctx: AudioContext, bound?: { set: (v: number) => void }) {
    const node = new GainNode(ctx);
    super(ctx, ({ param }) => ({
      params: {
        gain: param({ default: 1, bind: node.gain }),
        flag: param<number>({ default: 0, bind: bound ? { set: bound.set } : undefined }),
      },
    }));
    this.node = node;
  }
  get input() {
    return this.node;
  }
  get output() {
    return this.node;
  }
}

describe("dispose", () => {
  test("AudioProcessor.dispose() stops params and unregisters them from ParamSync", () => {
    const ctx = new AudioContext();
    const set = vi.fn();
    const p = new Gainer(ctx, { set });
    const sync = ParamSync.for(ctx);
    expect(sync.size).toBe(1);
    set.mockClear();
    p.dispose();
    expect(sync.size).toBe(0);
    p.params.flag.value = 5;
    expect(set).not.toHaveBeenCalled();
    void ctx.close();
  });

  test("dispose() is safe to call twice", () => {
    const ctx = new AudioContext();
    const p = new Gainer(ctx);
    p.dispose();
    expect(() => p.dispose()).not.toThrow();
    void ctx.close();
  });

  test("[Symbol.dispose]() calls dispose(), also through a subclass override", () => {
    const ctx = new AudioContext();
    let calls = 0;
    class Override extends Gainer {
      override dispose(): void {
        calls++;
        super.dispose();
      }
    }
    const p = new Override(ctx);
    p[Symbol.dispose]();
    expect(calls).toBe(1);
    expect(() => p[Symbol.dispose]()).not.toThrow();
    void ctx.close();
  });

  test("a using declaration disposes at scope exit", () => {
    const ctx = new AudioContext();
    let spy!: ReturnType<typeof vi.spyOn>;
    {
      using p = new Gainer(ctx);
      spy = vi.spyOn(p, "dispose");
    }
    expect(spy).toHaveBeenCalledOnce();
    void ctx.close();
  });

  test("Param.dispose() is safe to call twice and stops the bind effect", () => {
    const set = vi.fn();
    const p = new Param({ default: 1, bind: { set } });
    set.mockClear();
    p.dispose();
    p.dispose();
    p.value = 2;
    expect(set).not.toHaveBeenCalled();
  });

  test("Param and SchedulableParam have [Symbol.dispose]()", () => {
    const set = vi.fn();
    const p = new Param({ default: 1, bind: { set } });
    p[Symbol.dispose]();
    set.mockClear();
    p.value = 2;
    expect(set).not.toHaveBeenCalled();
    const ctx = new AudioContext();
    const s = new SchedulableParam({ default: 1, audioContext: ctx, audioParam: new GainNode(ctx).gain });
    s[Symbol.dispose]();
    expect(ParamSync.for(ctx).size).toBe(0);
    void ctx.close();
  });

  test("SchedulableParam.dispose() twice is safe", async () => {
    const ctx = new AudioContext();
    const node = new GainNode(ctx);
    const p = new SchedulableParam({ default: 1, audioContext: ctx, audioParam: node.gain });
    p.dispose();
    expect(() => p.dispose()).not.toThrow();
    void ctx.close();
  });
});
