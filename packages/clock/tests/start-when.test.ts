import { describe, expect, test } from "vitest";
import { Clock } from "../src/Clock";
import type { TickWindow } from "../src/Clock";
import { ManualTickSource } from "../src/TickSource";
import { Timeline } from "../src/Timeline";

function harness(bpm = 120, lookAhead = 0.1) {
  const ctx = { currentTime: 0 };
  const timeline = new Timeline({ audioContext: ctx, bpm });
  const tickSource = new ManualTickSource();
  const windows: TickWindow<Record<string, never>>[] = [];
  const clock = new Clock({ timeline, lookAhead, onTick: (w) => windows.push(w), tickSource });
  return { ctx, timeline, tickSource, clock, windows };
}

describe("Clock.start(when, offsetBeats)", () => {
  test("beat offsetBeats sounds at `when`, exactly", () => {
    const { timeline, clock } = harness(120);
    clock.start(2, 4);
    expect(timeline.beatToTime(4)).toBe(2);
    expect(timeline.beatToTime(6)).toBeCloseTo(3, 12); // 120 bpm: a beat is 0.5 s
    expect(timeline.timeToBeat(3)).toBeCloseTo(6, 12);
  });

  test("a future `when` is playing at once, schedules no beat before it and reports no miss", () => {
    const { ctx, timeline, tickSource, clock, windows } = harness(120, 0.1);
    clock.start(1);
    expect(timeline.state.value).toBe("playing");
    expect(timeline.position).toBe(0);
    ctx.currentTime = 0.5;
    tickSource.tick(); // look-ahead ends at 0.6, before `when`
    expect(windows).toHaveLength(0);
    expect(timeline.position).toBe(0);
    ctx.currentTime = 0.95;
    tickSource.tick(); // look-ahead reaches 1.05: beats [0, 0.1]
    expect(windows).toHaveLength(1);
    expect(windows[0]!.beat.start).toBe(0);
    expect(windows[0]!.beat.end).toBeCloseTo(0.1, 12);
    expect(timeline.beatToTime(windows[0]!.beat.start)).toBe(1);
    ctx.currentTime = 1.5;
    expect(timeline.position).toBeCloseTo(0.5, 12);
  });

  test("a negative offset counts in before beat 0 at `when`", () => {
    const { timeline, clock } = harness(120);
    clock.start(1, -2);
    expect(timeline.beatToTime(-2)).toBe(1);
    expect(timeline.beatToTime(0)).toBeCloseTo(2, 12);
  });

  test("a past `when` clamps to now", () => {
    const { ctx, timeline, clock } = harness(120);
    ctx.currentTime = 5;
    clock.start(1, 2);
    expect(timeline.beatToTime(2)).toBe(5);
    expect(timeline.beatToTime(3)).toBeCloseTo(5.5, 12);
  });

  test("start() with no arguments and start({ atBeat }) still work", () => {
    const { ctx, timeline, clock } = harness(120);
    ctx.currentTime = 3;
    clock.start();
    expect(timeline.beatToTime(0)).toBe(3);
    clock.start({ atBeat: 8 });
    expect(timeline.beatToTime(8)).toBe(3);
    expect(timeline.timeToBeat(4)).toBeCloseTo(10, 12);
    clock.start({});
    expect(timeline.beatToTime(0)).toBe(3);
  });

  test("follows the tempo curve from `when`", () => {
    const { timeline, clock } = harness(120);
    timeline.bpm.setValueAtTime(120, 0).linearRampToValueAtTime(240, 10);
    clock.start(2, 0);
    // bpm 120 + 12/s * (t - 0): from t=2 (144 bpm) the beat-1 time satisfies integral(144..) = 60/60... check against timeToBeat
    const t1 = timeline.beatToTime(1);
    expect(t1).toBeGreaterThan(2);
    expect(timeline.timeToBeat(t1)).toBeCloseTo(1, 9);
    expect(timeline.beatToTime(0)).toBe(2);
    // a tempo change before `when` shifts nothing about beat 0 landing at `when`
    timeline.bpm.setValueAtTime(60, 1);
    expect(timeline.beatToTime(0)).toBe(2);
  });

  test("the tempo in force at `when` sets the pace of the first beats", () => {
    const { timeline, clock } = harness(120);
    timeline.bpm.setValueAtTime(60, 5);
    clock.start(5, 0);
    expect(timeline.beatToTime(2)).toBeCloseTo(7, 12); // 60 bpm from t=5
  });

  test("refresh() before `when` keeps the future start", () => {
    const { ctx, timeline, tickSource, clock, windows } = harness(120, 0.1);
    clock.start(1, 3);
    ctx.currentTime = 0.2;
    clock.refresh();
    expect(timeline.beatToTime(3)).toBe(1);
    ctx.currentTime = 0.95;
    tickSource.tick();
    expect(windows.at(-1)!.beat.start).toBe(3);
  });

  test("pausing before `when` freezes at the start beat", () => {
    const { ctx, timeline, clock } = harness(120);
    clock.start(1, 3);
    ctx.currentTime = 0.5;
    clock.pause();
    expect(timeline.position).toBeCloseTo((3 * 60) / 120, 12);
    ctx.currentTime = 2;
    clock.resume();
    expect(timeline.beatToTime(3)).toBe(2);
  });

  test("rejects non-finite arguments", () => {
    const { clock } = harness();
    expect(() => clock.start(Number.NaN)).toThrow(RangeError);
    expect(() => clock.start(0, Infinity)).toThrow(RangeError);
  });
});
