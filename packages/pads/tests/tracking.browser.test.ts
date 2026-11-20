import { afterEach, describe, expect, test } from "vitest";
import { effect } from "@audiorective/core";
import { PadBank } from "../src/PadBank";
import * as padBankSourceModule from "../src/PadBank.ts?raw";
import { coverageGaps, watch } from "../../../scripts/tracking-coverage.mjs";

const touched = {
  padBank: new Set<string>(),
};

const disposers: Array<() => void | Promise<unknown>> = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0).reverse()) await dispose();
});

const tone = (context: BaseAudioContext, frames = 16000) => {
  const buffer = context.createBuffer(1, frames, 16000);
  buffer.getChannelData(0).fill(0.25);
  return buffer;
};

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

describe("PadBank readers are tracked", () => {
  test("cells.activeEvents follows trigger and stopAll", async () => {
    const context = new AudioContext();
    const bank = watch(new PadBank(context, [{ id: "kick", buffer: tone(context) }]), touched.padBank);
    disposers.push(
      () => context.close(),
      () => bank.destroy(),
    );
    await expectTracked(
      () => bank.cells.activeEvents.value,
      () => void bank.trigger("kick", 1, context.currentTime + 5),
    );
    await expectTracked(
      () => bank.cells.activeEvents.value,
      () => bank.stopAll(),
    );
  });
  test("cells.pads follows assign", async () => {
    const context = new AudioContext();
    const bank = watch(new PadBank(context, [{ id: "kick", buffer: tone(context) }]), touched.padBank);
    disposers.push(
      () => context.close(),
      () => bank.destroy(),
    );
    await expectTracked(
      () => bank.cells.pads.value,
      () => bank.assign("kick", tone(context, 8000)),
    );
  });
});

describe("command methods called inside an effect do not subscribe it", () => {
  test("PadBank commands", async () => {
    const context = new AudioContext();
    const bank = watch(new PadBank(context, [{ id: "kick", buffer: tone(context) }]), touched.padBank);
    disposers.push(
      () => context.close(),
      () => bank.destroy(),
    );
    const destination = context.createGain();
    let runs = 0;
    const stop = effect(() => {
      runs++;
      bank.trigger("kick", 1, context.currentTime + 5);
      bank.routePad("kick", destination);
      bank.assign("kick", tone(context, 8000));
      bank.stopAll();
    });
    bank.assign("kick", tone(context, 4000));
    bank.routePad("kick", null);
    stop();
    expect(runs).toBe(1);
  });
});

describe("every public member of a tracked block is covered", () => {
  test.each([
    ["PadBank", PadBank, padBankSourceModule.default, touched.padBank, { output: "constant gain node the caller wires; not state" }],
  ] as const)("%s", (_name, ctor, source, seen, excluded) => {
    expect(coverageGaps(ctor, source, seen, excluded)).toEqual([]);
  });
});
