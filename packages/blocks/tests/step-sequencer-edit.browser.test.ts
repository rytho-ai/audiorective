import { describe, expect, test } from "vitest";
import { batch, effect, withCancel, type BeatTiming, type CancellableEvent } from "@audiorective/core";
import { refreshOnEdit, StepSequencer, stepCellParams, stepRates, stepSwing, type StepRate } from "../src/StepSequencer";

const pattern = { size: 8, lanes: [{ id: "k", cells: [{ velocity: 1 }] }] };
const make = () => new StepSequencer(pattern, () => null);

describe("refreshOnEdit", () => {
  test("refreshes once per committed pattern or transforms change, never on attach", () => {
    const sequencer = make();
    let refreshes = 0;
    const stop = refreshOnEdit(sequencer, { refresh: () => refreshes++ });
    expect(refreshes).toBe(0);
    sequencer.toggle("k", 3);
    expect(refreshes).toBe(1);
    sequencer.setCell("k", 3, { velocity: 1 }); // no change: no commit
    expect(refreshes).toBe(1);
    sequencer.setTransforms([stepSwing()]);
    expect(refreshes).toBe(2);
    batch(() => {
      sequencer.setCell("k", 1, { velocity: 0.5 });
      sequencer.setLane("k", { swing: 0.3 });
    });
    expect(refreshes).toBe(3);
    stop();
    sequencer.toggle("k", 4);
    expect(refreshes).toBe(3);
  });

  test("does not subscribe a caller's effect and survives it re-running", () => {
    const sequencer = make();
    let refreshes = 0;
    let runs = 0;
    let stopHelper: (() => void) | undefined;
    const stop = effect(() => {
      runs++;
      stopHelper = refreshOnEdit(sequencer, { refresh: () => refreshes++ });
      sequencer.toggle("k", 2);
    });
    expect(runs).toBe(1);
    sequencer.toggle("k", 5);
    expect(runs).toBe(1);
    expect(refreshes).toBe(2); // the toggle inside the effect (after attach) and the one outside
    stop();
    sequencer.toggle("k", 6); // the caller's effect is gone, the helper is not tied to it
    expect(refreshes).toBe(3);
    stopHelper!();
  });

  test("a refresh that edits nothing does not loop", () => {
    const sequencer = make();
    let refreshes = 0;
    const stop = refreshOnEdit(sequencer, {
      refresh: () => {
        refreshes++;
        sequencer.setCell("k", 0, { velocity: 1 });
      },
    });
    sequencer.toggle("k", 1);
    expect(refreshes).toBe(1);
    stop();
  });
});

describe("cellParams and rates", () => {
  test("expose the built-in ranges and the twelve rates as data", () => {
    const sequencer = make();
    expect(sequencer.cellParams).toBe(stepCellParams);
    expect(sequencer.rates).toBe(stepRates);
    expect(sequencer.cellParams.map(({ id, min, max, step }) => [id, min, max, step])).toEqual([
      ["velocity", 0, 1, 0.01],
      ["offset", -0.5, 0.5, 0.01],
      ["length", 1 / 16, 4, 1 / 16],
      ["repeat", 1, 8, 1],
      ["pitch", -24, 24, 1],
      ["chance", 0, 1, 0.01],
    ]);
    expect(sequencer.rates).toEqual(["1/2", "1/4", "1/8", "1/16", "1/32", "1/64", "1/2T", "1/4T", "1/8T", "1/16T", "1/32T", "1/64T"]);
    expect(Object.isFrozen(stepCellParams)).toBe(true);
  });

  test("validation follows the same ranges: every bound is accepted and one past it throws", () => {
    const sequencer = make();
    for (const { id, min, max } of sequencer.cellParams) {
      sequencer.setCell("k", 0, { [id]: min });
      sequencer.setCell("k", 0, { [id]: max });
      const step = id === "repeat" || id === "pitch" ? 1 : 0.001;
      expect(() => sequencer.setCell("k", 0, { [id]: max + step })).toThrow("Step Sequencer cell");
      expect(() => sequencer.setCell("k", 0, { [id]: min - step })).toThrow("Step Sequencer cell");
    }
    expect(() => sequencer.setCell("k", 0, { repeat: 2.5 })).toThrow("Step Sequencer cell");
    expect(() => sequencer.setCell("k", 0, { pitch: 0.5 })).toThrow("Step Sequencer cell");
  });

  test("every listed rate is valid and the defaults match the blank cell", () => {
    const sequencer = make();
    for (const rate of sequencer.rates) sequencer.setLane("k", { rate });
    expect(() => sequencer.setLane("k", { rate: "1/3" as StepRate })).toThrow("Step Sequencer lane");
    const blank = sequencer.pattern.value.lanes[0].cells[7];
    for (const spec of sequencer.cellParams) expect((blank as Record<string, unknown>)[spec.id]).toBe(spec.default);
  });
});

describe("a trigger side effect paired with withCancel is retracted on re-queue", () => {
  test("reset cancels the event and runs the undo for every owned hit", () => {
    const timing: BeatTiming = { beatToTime: (beat) => beat * 0.5, timeToBeat: (time) => time * 2 };
    const log: string[] = [];
    const sequencer = new StepSequencer({ size: 4, lanes: [{ id: "k", cells: [{ velocity: 1 }, { velocity: 1 }] }] }, ({ step }) => {
      log.push(`set ${step}`);
      const inner: CancellableEvent = { cancel: () => log.push(`cancel ${step}`), onEnded() {} };
      return withCancel(inner, () => log.push(`undo ${step}`));
    });
    const owned: CancellableEvent[] = [];
    sequencer.schedule({ beat: { start: 0, end: 1 }, time: { current: 0 }, own: (event) => owned.push(event) }, timing);
    expect(log).toEqual(["set 0", "set 1"]);
    sequencer.reset();
    expect(log).toEqual(["set 0", "set 1", "cancel 0", "undo 0", "cancel 1", "undo 1"]);
    sequencer.reset();
    expect(log).toHaveLength(6); // idempotent
  });
});
