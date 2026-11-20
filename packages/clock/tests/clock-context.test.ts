import { describe, expect, test } from "vitest";
import { Clock } from "../src/Clock";
import type { TickWindow } from "../src/Clock";
import { ManualTickSource } from "../src/TickSource";
import { Timeline } from "../src/Timeline";

function run(make: (ctx: { currentTime: number }, tickSource: ManualTickSource, onTick: (w: TickWindow<Record<never, never>>) => void) => Clock) {
  const ctx = { currentTime: 0 };
  const tickSource = new ManualTickSource();
  const seen: Array<[number, number]> = [];
  const clock = make(ctx, tickSource, (w) => seen.push([w.beat.start, w.beat.end]));
  clock.start();
  for (const t of [0.05, 0.1, 0.2, 0.3]) {
    ctx.currentTime = t;
    tickSource.tick();
  }
  return { clock, seen };
}

describe("Clock({ context, bpm })", () => {
  test("schedules identically to the two-object form", () => {
    const two = run((ctx, tickSource, onTick) => new Clock({ timeline: new Timeline({ audioContext: ctx, bpm: 90 }), onTick, tickSource }));
    const one = run((ctx, tickSource, onTick) => new Clock({ context: ctx, bpm: 90, onTick, tickSource }));
    expect(one.seen.length).toBeGreaterThan(0);
    expect(one.seen).toEqual(two.seen);
  });

  test("audioContext is accepted as the same option, and bpm defaults to 120", () => {
    const clock = new Clock({ audioContext: { currentTime: 0 }, tickSource: new ManualTickSource() });
    expect(clock.bpm.value).toBe(120);
    expect(clock.bpm).toBe(clock.timeline.bpm);
  });

  test("clock.bpm ramps the owned timeline's tempo", () => {
    const ctx = { currentTime: 0 };
    const clock = new Clock({ context: ctx, bpm: 60, tickSource: new ManualTickSource() });
    clock.bpm.setValueAtTime(60, 0);
    clock.bpm.linearRampToValueAtTime(120, 4);
    expect(clock.bpm.valueAtTime(2)).toBeCloseTo(90, 9);
    expect(clock.timeline.bpm.valueAtTime(4)).toBeCloseTo(120, 9);
    expect(clock.timeline.state).toBe(clock.state);
  });

  test("dispose stops the tick loop and leaves nothing to tear down on the timeline", () => {
    const tickSource = new ManualTickSource();
    const clock = new Clock({ context: { currentTime: 0 }, tickSource });
    clock.dispose();
    expect(() => clock.attach({ schedule() {} })).toThrow("Clock is disposed.");
  });

  test("a borrowed timeline stays usable after the clock is disposed", () => {
    const timeline = new Timeline({ audioContext: { currentTime: 0 }, bpm: 100 });
    new Clock({ timeline, tickSource: new ManualTickSource() }).dispose();
    expect(timeline.bpm.value).toBe(100);
  });

  test("timeline with context, timeline with bpm, or neither is an error", () => {
    const ctx = { currentTime: 0 };
    const timeline = new Timeline({ audioContext: ctx });
    expect(() => new Clock({ timeline, context: ctx })).toThrow("Clock takes either timeline or context, not both.");
    expect(() => new Clock({ timeline, bpm: 90 })).toThrow("Clock bpm only applies with context");
    expect(() => new Clock({})).toThrow("Clock needs a timeline or a context.");
  });
});
