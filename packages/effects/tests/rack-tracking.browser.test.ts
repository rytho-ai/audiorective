import { afterEach, describe, expect, test } from "vitest";
import { effect } from "@audiorective/core";
import { EffectRack, type RackEffect } from "../src/rack";

const disposers: Array<() => void | Promise<unknown>> = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0).reverse()) await dispose();
});

/**
 * Reads the value inside an effect, changes it through the owner's public method, and checks that the effect
 * re-ran and saw a new value. Public readers must never be plain fields.
 */
async function expectTracked(read: () => unknown, mutate: () => void | Promise<unknown>) {
  const seen: unknown[] = [];
  const stop = effect(() => void seen.push(read()));
  const first = seen[0];
  try {
    await mutate();
  } finally {
    stop();
  }
  expect(seen.length).toBeGreaterThan(1);
  expect(Object.is(seen[seen.length - 1], first)).toBe(false);
}

const filter = (wet: number): RackEffect => ({ id: "f", type: "filter", enabled: true, wet, mode: "lowpass", frequency: 800, q: 1 });

describe("EffectRack readers are tracked", () => {
  const rack = () => {
    const context = new AudioContext();
    const rack = new EffectRack(context, [filter(1)]);
    disposers.push(
      () => context.close(),
      () => rack.destroy(),
    );
    return rack;
  };
  test.each([
    ["effects getter", (r: EffectRack) => r.effects],
    ["cells.effects", (r: EffectRack) => r.cells.effects.value],
  ] as const)("%s follows setEffects", async (_name, read) => {
    const r = rack();
    await expectTracked(
      () => read(r),
      () => r.setEffects([filter(0.5)]),
    );
  });
  test("setEffects inside an effect does not subscribe it", () => {
    const r = rack();
    let runs = 0;
    const stop = effect(() => {
      runs++;
      r.setEffects([filter(0.25)]);
    });
    r.setEffects([filter(0.75)]);
    stop();
    expect(runs).toBe(1);
  });
  test("a response reader follows slot replacement", () => {
    const r = rack();
    const frequencies = new Float32Array([800]);
    const magnitude = new Float32Array(1);
    const phase = new Float32Array(1);
    const seen: boolean[] = [];
    const stop = effect(() => void seen.push(r.readFilterResponse("f", frequencies, magnitude, phase)));
    try {
      r.setEffects([]);
      r.setEffects([filter(0.5)]);
      expect(seen).toEqual([true, false, true]);
    } finally {
      stop();
    }
  });
});
