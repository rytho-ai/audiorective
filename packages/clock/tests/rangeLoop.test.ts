import { describe, expect, it } from "vitest";
import { RangeLoop } from "../src";

describe("RangeLoop", () => {
  it("projects a scheduling window across repeats and excludes the window end", () => {
    const loop = new RangeLoop({ start: 1, end: 1.5 }, 8);
    expect([...loop.slices(7.8, 9)]).toEqual([
      { cycle: 0, start: 1, end: 1.5, when: 8 },
      { cycle: 1, start: 1, end: 1.5, when: 8.5 },
    ]);
    expect([...loop.slices(8.375, 8.625)]).toEqual([
      { cycle: 0, start: 1.375, end: 1.5, when: 8.375 },
      { cycle: 1, start: 1, end: 1.125, when: 8.5 },
    ]);
  });

  it("keeps phase after a late tick and computes each start from the original anchor", () => {
    const loop = new RangeLoop({ start: 0.1, end: 0.45 }, 0.025);
    const boundary = 0.025 + loop.duration * 3_000;
    const slices = [...loop.slices(boundary - 0.05, boundary + 0.05)];
    expect(slices.map(({ cycle }) => cycle)).toEqual([2_999, 3_000]);
    expect(slices[0].end).toBe(0.45);
    expect(slices[1].start).toBe(0.1);
    expect(slices[1].when).toBe(boundary);
  });

  it("rejects invalid ranges and nonfinite scheduling windows", () => {
    expect(() => new RangeLoop({ start: 2, end: 2 }, 0)).toThrow(RangeError);
    expect(() => new RangeLoop({ start: 0, end: Infinity }, 0)).toThrow(RangeError);
    expect(() => new RangeLoop({ start: 0, end: 1 }, -1)).toThrow(RangeError);
    const valid = new RangeLoop({ start: 0, end: 1 }, 0.5);
    expect(() => [...valid.slices(0, Infinity)]).toThrow(RangeError);
    expect([...valid.slices(0, 0.5)]).toEqual([]);
  });
});
