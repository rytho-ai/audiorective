import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { effect } from "alien-signals";
import { AudioProcessor, Param, SchedulableParam, batch, cell, readonlyCell, type SchedulableParam as SP } from "../src";

describe("subscribe", () => {
  test("Cell calls the listener after each change, not on subscribe", () => {
    const c = cell(1);
    const seen: number[] = [];
    c.subscribe((v) => seen.push(v));
    expect(seen).toEqual([]);
    c.value = 2;
    c.value = 3;
    expect(seen).toEqual([2, 3]);
  });

  test("immediate also calls once with the current value at subscribe", () => {
    const c = cell("a");
    const seen: string[] = [];
    c.subscribe((v) => seen.push(v), { immediate: true });
    expect(seen).toEqual(["a"]);
    c.value = "b";
    expect(seen).toEqual(["a", "b"]);
  });

  test("the returned function unsubscribes", () => {
    const c = cell(0);
    const listener = vi.fn();
    const stop = c.subscribe(listener);
    c.value = 1;
    stop();
    c.value = 2;
    expect(listener).toHaveBeenCalledTimes(1);
    expect(() => stop()).not.toThrow();
  });

  test("an unchanged write does not fire", () => {
    const c = cell(1);
    const listener = vi.fn();
    c.subscribe(listener);
    c.value = 1;
    expect(listener).not.toHaveBeenCalled();
  });

  test("a batch of writes fires once with the final value", () => {
    const a = cell(1);
    const b = cell(1);
    const sum = readonlyCell(() => a.value + b.value);
    const seen: number[] = [];
    sum.subscribe((v) => seen.push(v));
    batch(() => {
      a.value = 2;
      b.value = 3;
    });
    expect(seen).toEqual([5]);
  });

  test("ReadonlyCell fires when the derived value changes", () => {
    const source = cell(2);
    const doubled = readonlyCell(() => source.value * 2);
    const seen: number[] = [];
    doubled.subscribe((v) => seen.push(v), { immediate: true });
    source.value = 5;
    expect(seen).toEqual([4, 10]);
  });

  test("Param fires on .value and raw $ writes", () => {
    const p = new Param({ default: 0 });
    const seen: number[] = [];
    p.subscribe((v) => seen.push(v));
    p.value = 1;
    p.$(2);
    expect(seen).toEqual([1, 2]);
    p.dispose();
  });

  test("subscribe is a bound method: it works detached, as useSyncExternalStore calls it", () => {
    const c = cell(0);
    const { subscribe } = c;
    const listener = vi.fn();
    const stop = subscribe(listener);
    c.value = 1;
    expect(listener).toHaveBeenCalledWith(1);
    stop();
  });

  test("a subscription made inside an effect survives that effect re-running", () => {
    const trigger = cell(0);
    const target = cell(0);
    const listener = vi.fn();
    const stopEffect = effect(() => {
      void trigger.value;
      if (trigger.value === 0) target.subscribe(listener);
    });
    trigger.value = 1; // re-runs the effect; the subscription must not be disposed with it
    target.value = 1;
    expect(listener).toHaveBeenCalledWith(1);
    stopEffect();
  });

  test("what the listener reads does not become a dependency of the subscription", () => {
    const a = cell(0);
    const other = cell(0);
    const listener = vi.fn(() => void other.value);
    a.subscribe(listener);
    a.value = 1;
    other.value = 1;
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

class Fader extends AudioProcessor<{ gain: SP }> {
  private readonly node: GainNode;
  constructor(ctx: AudioContext) {
    const node = new GainNode(ctx);
    super(ctx, ({ param }) => ({ params: { gain: param({ default: 0, bind: node.gain }) } }));
    this.node = node;
  }
  get output() {
    return this.node;
  }
}

describe("SchedulableParam subscribe", () => {
  let ctx: AudioContext;
  beforeEach(async () => {
    ctx = new AudioContext();
    await ctx.resume();
  });
  afterEach(() => {
    void ctx.close();
  });

  test("fires while a scheduled ramp moves the value, and on direct writes", async () => {
    const fader = new Fader(ctx);
    // The audio thread only advances a param whose node is being pulled, so run a source through it.
    const source = new ConstantSourceNode(ctx);
    source.connect(fader.output);
    fader.output.connect(ctx.destination);
    source.start();
    expect(fader.params.gain).toBeInstanceOf(SchedulableParam);
    const seen: number[] = [];
    fader.params.gain.subscribe((v) => seen.push(v));

    fader.params.gain.linearRampToValueAtTime(1, ctx.currentTime + 1);
    await vi.waitFor(() => expect(seen.length).toBeGreaterThanOrEqual(2), { timeout: 3000 });
    // Read back from the audio thread: strictly between the endpoints and non-decreasing.
    expect(seen.every((v) => v >= 0 && v <= 1)).toBe(true);
    expect(seen.some((v) => v > 0 && v < 1)).toBe(true);
    expect([...seen].sort((a, b) => a - b)).toEqual(seen);

    const before = seen.length;
    fader.params.gain.value = 0.25;
    expect(seen.length).toBe(before + 1);
    expect(seen.at(-1)).toBe(0.25);
    source.stop();
    fader.dispose();
  });
});
