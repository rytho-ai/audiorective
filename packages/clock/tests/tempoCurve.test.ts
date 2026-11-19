import { describe, test, expect } from "vitest";
import { TempoCurve } from "../src/TempoCurve";

describe("TempoCurve — construction & validation", () => {
  test("throws on non-finite or non-positive bpm", () => {
    expect(() => new TempoCurve(0)).toThrow(RangeError);
    expect(() => new TempoCurve(-10)).toThrow(RangeError);
    expect(() => new TempoCurve(Infinity)).toThrow(RangeError);
    expect(() => new TempoCurve(NaN)).toThrow(RangeError);
  });

  test("setValueAtTime throws on invalid bpm", () => {
    const curve = new TempoCurve(120);
    expect(() => curve.setValueAtTime(0, 5)).toThrow(RangeError);
    expect(() => curve.setValueAtTime(-1, 5)).toThrow(RangeError);
  });

  test("valueAt before any event returns the initial bpm", () => {
    const curve = new TempoCurve(120);
    expect(curve.valueAt(-100)).toBe(120);
    expect(curve.valueAt(0)).toBe(120);
    expect(curve.valueAt(1000)).toBe(120);
  });
});

describe("TempoCurve — constant tempo (linear integrals)", () => {
  test("beatsBetween is linear at constant bpm", () => {
    const curve = new TempoCurve(120); // 2 beats/sec
    expect(curve.beatsBetween(0, 1)).toBeCloseTo(2);
    expect(curve.beatsBetween(0, 30)).toBeCloseTo(60);
    expect(curve.beatsBetween(10, 20)).toBeCloseTo(20);
  });

  test("beatsBetween(t, t) and reversed range are 0", () => {
    const curve = new TempoCurve(120);
    expect(curve.beatsBetween(5, 5)).toBe(0);
    expect(curve.beatsBetween(5, 2)).toBe(0);
  });

  test("timeToAdvance is linear at constant bpm", () => {
    const curve = new TempoCurve(120); // 2 beats/sec -> 0.5s/beat
    expect(curve.timeToAdvance(0, 2)).toBeCloseTo(1);
    expect(curve.timeToAdvance(10, 20)).toBeCloseTo(10);
  });

  test("timeToAdvance(t, 0) is 0", () => {
    const curve = new TempoCurve(120);
    expect(curve.timeToAdvance(42, 0)).toBe(0);
    expect(curve.timeToAdvance(42, -5)).toBe(0);
  });

  test("timeToAdvance is the exact inverse of beatsBetween", () => {
    const curve = new TempoCurve(90);
    const from = 3.3;
    const beats = curve.beatsBetween(from, 17.7);
    const advance = curve.timeToAdvance(from, beats);
    expect(advance).toBeCloseTo(17.7 - from, 10);
  });
});

describe("TempoCurve — step events split the integral", () => {
  test("a step at t=10 changes the beat rate exactly at that time", () => {
    const curve = new TempoCurve(60); // 1 beat/sec
    curve.setValueAtTime(120, 10); // 2 beats/sec from t=10

    // segment [0,10) at 60bpm = 10 beats; segment [10,20) at 120bpm = 20 beats
    expect(curve.beatsBetween(0, 10)).toBeCloseTo(10);
    expect(curve.beatsBetween(0, 20)).toBeCloseTo(30);
    expect(curve.beatsBetween(10, 20)).toBeCloseTo(20);
  });

  test("event takes effect at its own time (valueAt is left-closed per segment)", () => {
    const curve = new TempoCurve(60);
    curve.setValueAtTime(120, 10);
    expect(curve.valueAt(9.999)).toBe(60);
    expect(curve.valueAt(10)).toBe(120);
    expect(curve.valueAt(10.001)).toBe(120);
  });

  test("timeToAdvance is the exact inverse across a segment boundary", () => {
    const curve = new TempoCurve(60);
    curve.setValueAtTime(120, 10);
    curve.setValueAtTime(30, 25);

    const from = 4;
    const beats = curve.beatsBetween(from, 40);
    const advance = curve.timeToAdvance(from, beats);
    expect(advance).toBeCloseTo(40 - from, 9);

    // and crossing exactly one boundary
    const beats2 = curve.beatsBetween(5, 15);
    expect(curve.timeToAdvance(5, beats2)).toBeCloseTo(10, 9);
  });

  test("setValueAtTime at an existing event time replaces it, not duplicates", () => {
    const curve = new TempoCurve(60);
    curve.setValueAtTime(120, 10);
    curve.setValueAtTime(200, 10);
    expect(curve.valueAt(10)).toBe(200);
    expect(curve.beatsBetween(10, 11)).toBeCloseTo(200 / 60);
  });

  test("out-of-order insertion still sorts correctly", () => {
    const curve = new TempoCurve(60);
    curve.setValueAtTime(90, 20);
    curve.setValueAtTime(120, 10);
    expect(curve.valueAt(5)).toBe(60);
    expect(curve.valueAt(15)).toBe(120);
    expect(curve.valueAt(25)).toBe(90);
  });
});

describe("TempoCurve — cancellation", () => {
  test("cancelScheduledValues drops events at/after the given time", () => {
    const curve = new TempoCurve(60);
    curve.setValueAtTime(120, 10);
    curve.setValueAtTime(180, 20);
    curve.cancelScheduledValues(15);
    expect(curve.valueAt(25)).toBe(120); // the 180 step at t=20 is gone
    expect(curve.valueAt(10)).toBe(120); // the 120 step at t=10 survives (< 15)
  });

  test("cancelScheduledValues never removes the initial event", () => {
    const curve = new TempoCurve(60);
    curve.setValueAtTime(120, 10);
    curve.cancelScheduledValues(0);
    expect(curve.valueAt(0)).toBe(60);
    expect(curve.valueAt(100)).toBe(60);
  });

  test("cancelScheduledValues with a time past all events is a no-op", () => {
    const curve = new TempoCurve(60);
    curve.setValueAtTime(120, 10);
    curve.cancelScheduledValues(1000);
    expect(curve.valueAt(10)).toBe(120);
  });

  test("cancelAndHoldAtTime holds the value at the cancel point and drops future events", () => {
    const curve = new TempoCurve(60);
    curve.setValueAtTime(120, 10);
    curve.setValueAtTime(180, 20);
    curve.cancelAndHoldAtTime(15);
    expect(curve.valueAt(15)).toBe(120);
    expect(curve.valueAt(100)).toBe(120); // held, not 180
  });
});

describe("TempoCurve — ramps", () => {
  const rampCurve = () => {
    const curve = new TempoCurve(120);
    curve.rampToValueAtTime("linear", 160, 8);
    return curve;
  };

  test("valueAt interpolates linearly and holds after the ramp", () => {
    const curve = rampCurve();
    expect(curve.valueAt(0)).toBe(120);
    expect(curve.valueAt(2)).toBeCloseTo(130);
    expect(curve.valueAt(8)).toBe(160);
    expect(curve.valueAt(100)).toBe(160);
  });

  test("120 -> 160 over 8 s is 8 * 140 / 60 beats (the integral)", () => {
    const curve = rampCurve();
    expect(curve.beatsBetween(0, 8)).toBeCloseTo((8 * 140) / 60, 12);
    // quadratic in time: b(t) = (120 t + 2.5 t^2) / 60
    expect(curve.beatsBetween(0, 4)).toBeCloseTo((120 * 4 + 2.5 * 16) / 60, 12);
    expect(curve.beatsBetween(0, 12)).toBeCloseTo((8 * 140) / 60 + (4 * 160) / 60, 12);
  });

  test("timeToAdvance inverts beatsBetween across steps and ramps", () => {
    const curve = new TempoCurve(90);
    curve.setValueAtTime(120, 2);
    curve.rampToValueAtTime("linear", 180, 6);
    curve.setValueAtTime(60, 8); // a step down after the ramp's hold
    curve.rampToValueAtTime("exponential", 240, 12);
    curve.rampToValueAtTime("linear", 120, 14); // descending ramp
    for (const [from, to] of [
      [0, 1],
      [0, 7],
      [1, 13],
      [3.3, 5.1],
      [5, 20],
      [6, 7],
      [9, 14],
    ] as const) {
      const beats = curve.beatsBetween(from, to);
      expect(curve.timeToAdvance(from, beats)).toBeCloseTo(to - from, 9);
    }
    // forward: advancing n beats then integrating returns n
    for (const beats of [0.01, 1, 5, 17.5, 40]) {
      const dt = curve.timeToAdvance(1.5, beats);
      expect(curve.beatsBetween(1.5, 1.5 + dt)).toBeCloseTo(beats, 9);
    }
  });

  test("a flat ramp (equal values) behaves like a hold, and tiny slopes stay stable", () => {
    const flat = new TempoCurve(120);
    flat.rampToValueAtTime("linear", 120, 4);
    flat.rampToValueAtTime("exponential", 120, 8);
    expect(flat.beatsBetween(0, 8)).toBeCloseTo(16, 12);
    expect(flat.timeToAdvance(0, 16)).toBeCloseTo(8, 12);
    const nearly = new TempoCurve(120);
    nearly.rampToValueAtTime("exponential", 120 + 1e-9, 4);
    expect(nearly.timeToAdvance(0, 4)).toBeCloseTo(2, 8);
    const slight = new TempoCurve(120);
    slight.rampToValueAtTime("linear", 120 + 1e-12, 4);
    expect(slight.timeToAdvance(0, 4)).toBeCloseTo(2, 9);
  });

  test("exponential ramp: closed-form integral and inverse", () => {
    const curve = new TempoCurve(60);
    curve.rampToValueAtTime("exponential", 240, 4);
    expect(curve.valueAt(2)).toBeCloseTo(120);
    // integral of 60 * 4^(t/4) dt over [0, 4], in beats: (240 - 60) / (ln 4 / 4) / 60
    expect(curve.beatsBetween(0, 4)).toBeCloseTo(180 / (Math.log(4) / 4) / 60, 10);
    expect(curve.timeToAdvance(0, curve.beatsBetween(0, 3))).toBeCloseTo(3, 10);
  });

  test("a setValueAtTime inside a ramp splits it: the ramp then starts from that event", () => {
    const curve = rampCurve();
    curve.setValueAtTime(100, 4);
    expect(curve.valueAt(3.9)).toBeCloseTo(120);
    expect(curve.valueAt(4)).toBe(100);
    expect(curve.valueAt(6)).toBeCloseTo(130);
  });

  test("cancelScheduledValues drops a ramp that ends at or after the time", () => {
    const curve = rampCurve();
    curve.cancelScheduledValues(8);
    expect(curve.valueAt(4)).toBe(120);
    expect(curve.valueAt(100)).toBe(120);
  });

  test("cancelAndHoldAtTime mid-ramp keeps the slope up to the cut, then holds the interpolated value", () => {
    const curve = rampCurve();
    curve.cancelAndHoldAtTime(4);
    expect(curve.valueAt(2)).toBeCloseTo(130);
    expect(curve.valueAt(4)).toBeCloseTo(140);
    expect(curve.valueAt(50)).toBeCloseTo(140);
    expect(curve.beatsBetween(0, 10)).toBeCloseTo((4 * 130) / 60 + (6 * 140) / 60, 12);
  });

  test("cancelAndHoldAtTime mid exponential ramp holds the exponential value", () => {
    const curve = new TempoCurve(100);
    curve.rampToValueAtTime("exponential", 400, 8);
    curve.cancelAndHoldAtTime(4);
    expect(curve.valueAt(4)).toBeCloseTo(200);
    expect(curve.valueAt(2)).toBeCloseTo(100 * Math.pow(4, 0.25));
    expect(curve.valueAt(9)).toBeCloseTo(200);
  });

  test("cancelAndHoldAtTime outside a ramp behaves as before", () => {
    const curve = rampCurve();
    curve.cancelAndHoldAtTime(10);
    expect(curve.valueAt(8)).toBe(160);
    expect(curve.valueAt(20)).toBe(160);
  });
});
