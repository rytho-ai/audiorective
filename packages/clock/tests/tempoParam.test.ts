import { describe, test, expect, vi } from "vitest";
import { effect } from "alien-signals";
import { TempoParam } from "../src/TempoParam";

function makeClock(startAt = 0) {
  let now = startAt;
  return {
    advance: (dt: number) => (now += dt),
    now: () => now,
  };
}

describe("TempoParam — construction & value", () => {
  test("reads back the default", () => {
    const clock = makeClock();
    const param = new TempoParam({ default: 120, now: clock.now });
    expect(param.value).toBe(120);
    expect(param.valueAtTime(0)).toBe(120);
  });

  test(".value = x is a step at now(), leaving future events intact", () => {
    const clock = makeClock(10);
    const param = new TempoParam({ default: 120, now: clock.now });
    param.setValueAtTime(180, 20); // future event
    param.value = 90; // step at t=10
    expect(param.value).toBe(90);
    expect(param.valueAtTime(15)).toBe(90);
    expect(param.valueAtTime(25)).toBe(180); // future event survives
  });

  test(".value = x updates the signal synchronously (no tick needed)", () => {
    const clock = makeClock(5);
    const param = new TempoParam({ default: 120, now: clock.now });
    const seen: number[] = [];
    const stop = effect(() => {
      seen.push(param.value);
    });
    param.value = 140;
    expect(seen).toEqual([120, 140]);
    stop();
  });
});

describe("TempoParam — scheduling API", () => {
  test("setValueAtTime schedules without touching the signal directly", () => {
    const clock = makeClock(0);
    const param = new TempoParam({ default: 120, now: clock.now });
    param.setValueAtTime(200, 50); // a future event
    expect(param.value).toBe(120); // signal unchanged until _refresh
    expect(param.valueAtTime(50)).toBe(200);
  });

  test("setValueAtTime returns this for chaining", () => {
    const param = new TempoParam({ default: 120, now: () => 0 });
    expect(param.setValueAtTime(100, 1)).toBe(param);
  });

  test("cancelScheduledValues / cancelAndHoldAtTime delegate to the curve", () => {
    const param = new TempoParam({ default: 120, now: () => 0 });
    param.setValueAtTime(140, 10);
    param.setValueAtTime(160, 20);
    param.cancelAndHoldAtTime(15);
    expect(param.valueAtTime(15)).toBe(140);
    expect(param.valueAtTime(100)).toBe(140);
  });

  test("linear and exponential ramps interpolate from the previous event", () => {
    const param = new TempoParam({ default: 120, now: () => 0 });
    param.linearRampToValueAtTime(160, 8);
    expect(param.valueAtTime(4)).toBeCloseTo(140);
    expect(param.valueAtTime(8)).toBe(160);
    expect(param.valueAtTime(20)).toBe(160);
    const expo = new TempoParam({ default: 100, now: () => 0 });
    expo.exponentialRampToValueAtTime(400, 8);
    expect(expo.valueAtTime(4)).toBeCloseTo(200);
  });

  test("a first ramp starts at the current audio time, not at time 0", () => {
    const param = new TempoParam({ default: 120, now: () => 10 });
    param.linearRampToValueAtTime(160, 18);
    expect(param.valueAtTime(10)).toBe(120);
    expect(param.valueAtTime(14)).toBeCloseTo(140);
    expect(param.valueAtTime(5)).toBe(120);
  });

  test("a ramp whose end is not after the previous event is a step", () => {
    const param = new TempoParam({ default: 120, now: () => 0 });
    param.setValueAtTime(100, 5);
    param.linearRampToValueAtTime(140, 5);
    expect(param.valueAtTime(5)).toBe(140);
    expect(param.valueAtTime(4)).toBe(120);
  });

  test("ramps reject a non-finite end time and a non-positive bpm", () => {
    const param = new TempoParam({ default: 120, now: () => 0 });
    expect(() => param.linearRampToValueAtTime(140, NaN)).toThrow(RangeError);
    expect(() => param.exponentialRampToValueAtTime(0, 4)).toThrow(RangeError);
  });
});

describe("TempoParam — _refresh (internal, Clock-driven)", () => {
  test("_refresh pushes the curve value at `now` into the signal", () => {
    const param = new TempoParam({ default: 120, now: () => 0 });
    param.setValueAtTime(180, 10);
    expect(param.value).toBe(120);
    param._refresh(10);
    expect(param.value).toBe(180);
  });

  test("_refresh triggers reactive effects", () => {
    const param = new TempoParam({ default: 120, now: () => 0 });
    param.setValueAtTime(180, 10);
    const onChange = vi.fn();
    const stop = effect(() => {
      onChange(param.value);
    });
    onChange.mockClear();
    param._refresh(10);
    expect(onChange).toHaveBeenCalledWith(180);
    stop();
  });
});

describe("TempoParam — raw signal writes", () => {
  test("$(x) is a step at now() on the curve, like .value = x", () => {
    const clock = makeClock(10);
    const param = new TempoParam({ default: 120, now: clock.now });
    param.setValueAtTime(180, 20);
    param.$(90);
    expect(param.value).toBe(90);
    expect(param.valueAtTime(15)).toBe(90);
    expect(param.valueAtTime(25)).toBe(180);
    param._refresh(15);
    expect(param.$()).toBe(90); // survives the next refresh
  });

  test("_refresh does not add steps to the curve", () => {
    const param = new TempoParam({ default: 120, now: () => 0 });
    param.setValueAtTime(150, 5);
    param._refresh(6);
    expect(param.value).toBe(150);
    expect(param.valueAtTime(0)).toBe(120);
  });

  test("_refresh follows a ramp, so `.value` tracks the interpolated tempo", () => {
    const param = new TempoParam({ default: 120, now: () => 0 });
    param.linearRampToValueAtTime(160, 8);
    param._refresh(4);
    expect(param.value).toBeCloseTo(140);
  });
});

describe("TempoParam — setTargetAtTime and setValueCurveAtTime", () => {
  test("setTargetAtTime follows the exponential approach within 0.05% of the swing and ends on the target", () => {
    const clock = makeClock();
    const param = new TempoParam({ default: 120, now: clock.now });
    param.setTargetAtTime(60, 2, 1.5);
    expect(param.valueAtTime(1)).toBe(120);
    expect(param.valueAtTime(2)).toBe(120);
    for (const t of [2.4, 3, 4.1, 6, 9]) {
      const exact = 60 + 60 * Math.exp(-(t - 2) / 1.5);
      expect(Math.abs(param.valueAtTime(t) - exact)).toBeLessThan(60 * 0.0005);
    }
    expect(param.valueAtTime(2 + 8 * 1.5)).toBe(60);
    expect(param.valueAtTime(100)).toBe(60);
  });

  test("setTargetAtTime starts from the value in force at its start, including a ramp in progress", () => {
    const clock = makeClock();
    const param = new TempoParam({ default: 100, now: clock.now });
    param.setValueAtTime(100, 0).linearRampToValueAtTime(200, 10);
    param.setTargetAtTime(100, 5, 1);
    // the ramp is cut at 5 (value 150), then decays toward 100
    expect(param.valueAtTime(5)).toBeCloseTo(150, 6);
    expect(param.valueAtTime(6)).toBeCloseTo(100 + 50 * Math.exp(-1), 1);
  });

  test("setTargetAtTime stops at the next scheduled event", () => {
    const clock = makeClock();
    const param = new TempoParam({ default: 120, now: clock.now });
    param.setValueAtTime(200, 3);
    param.setTargetAtTime(60, 1, 1);
    expect(param.valueAtTime(2.9)).toBeLessThan(120);
    expect(param.valueAtTime(3)).toBe(200);
    expect(param.valueAtTime(5)).toBe(200);
  });

  test("an event scheduled inside a setTargetAtTime span cuts it and holds the value reached", () => {
    const clock = makeClock();
    const param = new TempoParam({ default: 120, now: clock.now });
    param.setTargetAtTime(60, 0, 2);
    const held = 60 + 60 * Math.exp(-1);
    param.setValueAtTime(90, 4);
    expect(param.valueAtTime(3.99)).toBeCloseTo(60 + 60 * Math.exp(-3.99 / 2), 0);
    expect(param.valueAtTime(2)).toBeCloseTo(held, 0);
    expect(param.valueAtTime(4)).toBe(90);
    expect(param.valueAtTime(7)).toBe(90);
  });

  test("a zero time constant is a step", () => {
    const param = new TempoParam({ default: 120, now: () => 0 });
    param.setTargetAtTime(90, 1, 0);
    expect(param.valueAtTime(0.5)).toBe(120);
    expect(param.valueAtTime(1)).toBe(90);
  });

  test("setValueCurveAtTime interpolates linearly between evenly spaced values, then holds the last", () => {
    const param = new TempoParam({ default: 100, now: () => 0 });
    param.setValueCurveAtTime([100, 200, 150], 2, 4);
    expect(param.valueAtTime(1)).toBe(100);
    expect(param.valueAtTime(2)).toBe(100);
    expect(param.valueAtTime(3)).toBeCloseTo(150, 9);
    expect(param.valueAtTime(4)).toBeCloseTo(200, 9);
    expect(param.valueAtTime(5)).toBeCloseTo(175, 9);
    expect(param.valueAtTime(6)).toBe(150);
    expect(param.valueAtTime(9)).toBe(150);
  });

  test("a curve accepts any iterable and rejects bad input", () => {
    const param = new TempoParam({ default: 100, now: () => 0 });
    param.setValueCurveAtTime(new Set([100, 140]), 0, 1);
    expect(param.valueAtTime(0.5)).toBeCloseTo(120, 9);
    expect(() => param.setValueCurveAtTime([100], 0, 1)).toThrow(RangeError);
    expect(() => param.setValueCurveAtTime([100, 120], 0, 0)).toThrow(RangeError);
    expect(() => param.setValueCurveAtTime([100, -1], 0, 1)).toThrow(RangeError);
    expect(() => param.setTargetAtTime(0, 0, 1)).toThrow(RangeError);
    expect(() => param.setTargetAtTime(90, 0, -1)).toThrow(RangeError);
  });

  test("an event inside a curve cuts it, and .value writes cut it too", () => {
    const clock = makeClock();
    const param = new TempoParam({ default: 100, now: clock.now });
    param.setValueCurveAtTime([100, 200], 0, 10);
    clock.advance(4);
    param.value = 50; // a step at 4 cuts the curve
    expect(param.valueAtTime(3)).toBeCloseTo(130, 9);
    expect(param.valueAtTime(4)).toBe(50);
    expect(param.valueAtTime(8)).toBe(50);
  });

  test("beats integrate across a curve", () => {
    const param = new TempoParam({ default: 120, now: () => 0 });
    param.setValueCurveAtTime([120, 240], 0, 10);
    // mean bpm 180 over 10 s = 30 beats
    expect(param._curveForTimeline.beatsBetween(0, 10)).toBeCloseTo(30, 9);
  });
});
