import { describe, expect, test } from "vitest";
import { Cell, cell, Param } from "../src";

const finite = (v: number) => {
  if (!Number.isFinite(v)) throw new RangeError(`not finite: ${v}`);
};

describe("validate on Param", () => {
  test("a refused .value or $(x) write keeps the value and never reaches the bind target", () => {
    const seen: number[] = [];
    const p = new Param<number>({ default: 1, validate: finite, bind: { set: (v) => void seen.push(v) } });
    expect(() => (p.value = NaN)).toThrow(RangeError);
    expect(() => p.$(Infinity)).toThrow(RangeError);
    expect(p.value).toBe(1);
    p.value = 2;
    expect(p.value).toBe(2);
    expect(seen).toEqual([1, 2]);
  });

  test("the initial value is checked", () => {
    expect(() => new Param<number>({ default: NaN, validate: finite })).toThrow(RangeError);
  });
});

describe("validate on Cell", () => {
  test("a refused .value, $(x) or update write keeps the value", () => {
    const c = cell({ n: 1 }, { validate: (v) => finite(v.n) });
    expect(c).toBeInstanceOf(Cell);
    expect(() => (c.value = { n: NaN })).toThrow(RangeError);
    expect(() => c.$({ n: Infinity })).toThrow(RangeError);
    expect(() =>
      c.update((d) => {
        d.n = NaN;
      }),
    ).toThrow(RangeError);
    expect(c.value).toEqual({ n: 1 });
    c.update((d) => {
      d.n = 3;
    });
    expect(c.value).toEqual({ n: 3 });
  });

  test("the initial value is checked", () => {
    expect(() => cell(NaN, { validate: finite })).toThrow(RangeError);
  });
});
