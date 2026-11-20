import { describe, expect, test } from "vitest";
import { effect } from "@audiorective/core";
import { Lane, StepSequencer } from "../src/StepSequencer";
import * as stepSequencerSourceModule from "../src/StepSequencer.ts?raw";
import { coverageGaps, watch } from "../../../scripts/tracking-coverage.mjs";

const touched = {
  stepSequencer: new Set<string>(),
  lane: new Set<string>(),
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

describe("StepSequencer readers are tracked", () => {
  const ctx = new OfflineAudioContext(1, 128, 8000);
  const make = () => {
    const sequencer = watch(
      new StepSequencer({ k: { pattern: "X...", params: { p: { min: 0, max: 1, default: 0 } } } }, { context: ctx }),
      touched.stepSequencer,
    );
    return { sequencer, lane: watch(sequencer.lanes.k!, touched.lane) };
  };
  test("lane readers follow their setters and the step objects follow cell writes", () => {
    const { sequencer, lane } = make();
    expectTracked(
      () => lane.pattern,
      () => (lane.pattern = "XX.."),
    );
    expectTracked(
      () => lane.length,
      () => (lane.pattern = "XX..X"),
    );
    expectTracked(
      () => lane.rate,
      () => (lane.rate = "8t"),
    );
    expectTracked(
      () => lane.swing,
      () => (lane.swing = "20%"),
    );
    expectTracked(
      () => lane.mute,
      () => (lane.mute = true),
    );
    expectTracked(
      () => lane.solo,
      () => (lane.solo = true),
    );
    expectTracked(
      () => lane.direction,
      () => (lane.direction = "bounce"),
    );
    expectTracked(
      () => lane.length,
      () => (lane.length = 8),
    );
    for (const field of ["offset", "length", "repeat", "pitch", "chance"] as const) {
      const value = field === "repeat" ? 2 : field === "pitch" ? 3 : 0.5;
      expectTracked(
        () => lane.steps[0]![field],
        () => (lane.steps[0]![field] = value),
      );
    }
    expectTracked(
      () => lane.sound,
      () => (lane.sound = "C4"),
    );
    expectTracked(
      () => lane.steps.length,
      () => (lane.pattern = "X"),
    );
    expectTracked(
      () => lane.steps[0]!.velocity,
      () => (lane.steps[0]!.velocity = 0.5),
    );
    expectTracked(
      () => lane.steps[0]!.values.p,
      () => (lane.steps[0]!.values.p = 0.7),
    );
    expect(Object.keys(lane.params)).toEqual(["p"]);
    expect(sequencer.lane("k")).toBe(sequencer.lanes.k);
    expect(sequencer.context).toBe(ctx);
  });
  test("playhead and progress follow the transport position", async () => {
    const { sequencer, lane } = make();
    const timing = { timeToBeat: (t: number) => t, beatToTime: (b: number) => b };
    const window = (current: number) => ({ beat: { start: current, end: current + 1 }, time: { current }, own() {} });
    await expectTracked(
      () => lane.playhead,
      () => sequencer.schedule(window(0.5), timing),
    );
    await expectTracked(
      () => lane.progress,
      () => sequencer.schedule(window(0.75), timing),
    );
    await expectTracked(
      () => lane.playhead,
      () => sequencer.reset(),
    );
  });
  test("output, connect and disconnect", () => {
    const { lane } = make();
    const node = new GainNode(ctx);
    expect(lane.connect(node)).toBe(node);
    lane.disconnect();
    expect(lane.output).toBeInstanceOf(GainNode);
  });
  test("attached, onhit, addEventListener, dispose and Symbol.dispose", () => {
    const { sequencer } = make();
    let refreshes = 0;
    const cleanup = sequencer.attached({ refresh: () => refreshes++, detach() {} });
    sequencer.lanes.k!.mute = true;
    expect(refreshes).toBe(1);
    cleanup();
    sequencer.lanes.k!.mute = false;
    expect(refreshes).toBe(1);
    sequencer.onhit = () => {};
    expect(sequencer.onhit).toBeTypeOf("function");
    sequencer.addEventListener("hit", () => {});
    sequencer.dispose();
    sequencer[Symbol.dispose]();
  });
});

describe("command methods called inside an effect do not subscribe it", () => {
  test("StepSequencer commands and schedule", () => {
    const sequencer = watch(new StepSequencer({ k: "X..." }), touched.stepSequencer);
    const lane = watch(sequencer.lanes.k!, touched.lane);
    const timing = { timeToBeat: (t: number) => t, beatToTime: (b: number) => b };
    const window = { beat: { start: 0, end: 2 }, time: { current: 0 }, own() {} };
    const step = lane.steps[1]!;
    let runs = 0;
    const stop = effect(() => {
      runs++;
      step.velocity = 0.5;
      lane.swing = 0.2;
      lane.pattern = "XX..";
      sequencer.schedule(window, timing);
      sequencer.reset();
    });
    sequencer.lanes.k!.steps[2]!.velocity = 0.5;
    sequencer.reset();
    stop();
    expect(runs).toBe(1);
  });
});

describe("every public member of a tracked block is covered", () => {
  test.each([
    ["StepSequencer", StepSequencer, stepSequencerSourceModule.default, touched.stepSequencer, {}],
    ["Lane", Lane, stepSequencerSourceModule.default, touched.lane, {}],
  ] as const)("%s", (_name, ctor, source, seen, excluded) => {
    expect(coverageGaps(ctor, source, seen, excluded)).toEqual([]);
  });
});
