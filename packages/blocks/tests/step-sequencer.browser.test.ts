import { describe, expect, test } from "vitest";
import { effect, type BeatTiming, type CancellableEvent } from "@audiorective/core";
import { StepSequencer, type StepCellInput, type StepHit, type StepLaneInput, type StepWindow } from "../src/StepSequencer";

/** 120 bpm starting at audio time 10: one beat is 0.5 s. */
const timing: BeatTiming = { beatToTime: (beat) => 10 + beat * 0.5, timeToBeat: (time) => (time - 10) * 2 };
const on = (velocity = 1): StepCellInput => ({ velocity });
const cellsAt = (size: number, active: Record<number, StepCellInput | number>): StepCellInput[] =>
  Array.from({ length: size }, (_, i) => {
    const value = active[i];
    return value === undefined ? {} : typeof value === "number" ? on(value) : value;
  });

function rig(size: number, lanes: StepLaneInput[], random?: () => number) {
  const hits: StepHit[] = [];
  const events: Array<CancellableEvent & { cancelled: number }> = [];
  const sequencer = new StepSequencer(
    { size, lanes },
    (hit) => {
      hits.push(hit);
      const event = {
        cancelled: 0,
        cancel() {
          event.cancelled++;
        },
        onEnded() {},
      };
      events.push(event);
      return event;
    },
    { random },
  );
  /** Schedule one window over [start, end) beats; `current` defaults to the window start. */
  const run = (start: number, end: number, current = timing.beatToTime(start)) => {
    const owned: Array<{ event: CancellableEvent; when: number }> = [];
    const window: StepWindow = { beat: { start, end }, time: { current }, own: (event, when) => owned.push({ event, when }) };
    sequencer.schedule(window, timing);
    return owned;
  };
  const beats = (laneId?: string) => hits.filter((hit) => !laneId || hit.laneId === laneId).map((hit) => (hit.when - 10) * 2);
  const steps = (laneId: string) => hits.filter((hit) => hit.laneId === laneId).map((hit) => hit.step);
  return { sequencer, hits, events, run, beats, steps };
}

const close = (actual: number[], expected: number[]) => {
  expect(actual).toHaveLength(expected.length);
  actual.forEach((value, i) => expect(value).toBeCloseTo(expected[i], 6));
};

describe("model", () => {
  test("defaults fill partial input", () => {
    const { sequencer } = rig(4, [{ id: "k", cells: [{ velocity: 0.5 }] }]);
    const { size, lanes } = sequencer.pattern.value;
    expect(size).toBe(4);
    expect(lanes[0]).toMatchObject({ id: "k", label: "k", steps: 4, rate: "1/16", direction: "forward", swing: 0, mute: false, solo: false });
    expect(lanes[0].cells).toHaveLength(4);
    expect(lanes[0].cells[0]).toEqual({ velocity: 0.5, offset: 0, length: 1, repeat: 1, pitch: 0, chance: 1 });
    expect(lanes[0].cells[3]).toEqual({ velocity: 0, offset: 0, length: 1, repeat: 1, pitch: 0, chance: 1 });
    expect(sequencer.playheads.value).toEqual({ k: null });
    expect(sequencer.loopProgress.value).toBeNull();
    expect(Object.isFrozen(lanes[0].cells[0])).toBe(true);
  });

  test("validation errors", () => {
    const make = (size: number, lanes: StepLaneInput[]) => () => new StepSequencer({ size, lanes }, () => null);
    expect(make(0, [])).toThrow("Step Sequencer needs an integer size from 1 to 128.");
    expect(make(129, [])).toThrow("Step Sequencer needs an integer size from 1 to 128.");
    expect(make(2.5, [])).toThrow("Step Sequencer needs an integer size from 1 to 128.");
    expect(make(4, [{ id: "" }])).toThrow("Step Sequencer needs lanes with unique, nonempty IDs.");
    expect(make(4, [{ id: "a" }, { id: "a" }])).toThrow("Step Sequencer needs lanes with unique, nonempty IDs.");
    for (const bad of [{ steps: 5 }, { steps: 0 }, { rate: "1/3" as never }, { direction: "up" as never }, { swing: 1.5 }, { mute: 1 as never }]) {
      expect(make(4, [{ id: "a", ...bad }])).toThrow(/^Step Sequencer lane needs/);
    }
    expect(make(2, [{ id: "a", cells: [{}, {}, {}] }])).toThrow(/^Step Sequencer lane needs/);
    for (const bad of [
      { velocity: 2 },
      { velocity: NaN },
      { chance: -0.1 },
      { offset: 0.6 },
      { length: 0.01 },
      { length: 5 },
      { repeat: 0 },
      { repeat: 9 },
      { repeat: 1.5 },
      { pitch: 25 },
      { pitch: 0.5 },
    ]) {
      expect(make(4, [{ id: "a", cells: [bad] }]), JSON.stringify(bad)).toThrow(/^Step Sequencer cell needs/);
    }
  });

  test("setCell, toggle, setLane", () => {
    const { sequencer } = rig(4, [{ id: "a" }, { id: "b" }]);
    sequencer.setCell("a", 1, { velocity: 0.5, pitch: -3, repeat: 2 });
    const [a, b] = sequencer.pattern.value.lanes;
    expect(a.cells[1]).toMatchObject({ velocity: 0.5, pitch: -3, repeat: 2, chance: 1 });
    expect(sequencer.pattern.value.lanes[1]).toBe(b);
    sequencer.toggle("a", 2);
    expect(sequencer.pattern.value.lanes[0].cells[2].velocity).toBe(1);
    sequencer.setCell("a", 2, { chance: 0.5 });
    sequencer.toggle("a", 2);
    expect(sequencer.pattern.value.lanes[0].cells[2]).toMatchObject({ velocity: 0, chance: 0.5 });
    sequencer.setLane("b", { steps: 3, rate: "1/8T", direction: "bounce", swing: 0.5, mute: true, solo: true, label: "B" });
    expect(sequencer.pattern.value.lanes[1]).toMatchObject({
      steps: 3,
      rate: "1/8T",
      direction: "bounce",
      swing: 0.5,
      mute: true,
      solo: true,
      label: "B",
    });
    // A failed edit changes nothing.
    const before = sequencer.pattern.value;
    expect(() => sequencer.setCell("a", 0, { velocity: 1, pitch: 99 })).toThrow(/^Step Sequencer cell needs/);
    expect(() => sequencer.setLane("a", { swing: 1, steps: 9 })).toThrow(/^Step Sequencer lane needs/);
    expect(sequencer.pattern.value).toBe(before);
    expect(() => sequencer.setCell("zz", 0, {})).toThrow("Step Sequencer needs an existing lane and step.");
    expect(() => sequencer.setCell("a", 4, {})).toThrow("Step Sequencer needs an existing lane and step.");
    expect(() => sequencer.setCell("a", 0.5, {})).toThrow("Step Sequencer needs an existing lane and step.");
    expect(() => sequencer.toggle("a", -1)).toThrow("Step Sequencer needs an existing lane and step.");
    expect(() => sequencer.setLane("zz", {})).toThrow("Step Sequencer needs an existing lane.");
  });

  test("a multi-field edit is one change and a no-op edit is none", () => {
    const { sequencer } = rig(4, [{ id: "a" }]);
    let runs = 0;
    const stop = effect(() => {
      void sequencer.pattern.value;
      runs++;
    });
    sequencer.setCell("a", 0, { velocity: 1, offset: 0.2, length: 2, repeat: 3, pitch: 5, chance: 0.5 });
    expect(runs).toBe(2);
    sequencer.setCell("a", 0, { velocity: 1 });
    sequencer.setLane("a", { rate: "1/16" });
    expect(runs).toBe(2);
    sequencer.setLane("a", { rate: "1/8", swing: 0.3, direction: "backward" });
    expect(runs).toBe(3);
    stop();
  });

  test("setSize truncates, pads and clamps in one change", () => {
    const { sequencer } = rig(4, [
      { id: "a", cells: cellsAt(4, { 1: 1, 3: 0.5 }) },
      { id: "b", steps: 2 },
    ]);
    let runs = 0;
    const stop = effect(() => {
      void sequencer.pattern.value;
      runs++;
    });
    sequencer.setSize(2);
    expect(runs).toBe(2);
    let { lanes } = sequencer.pattern.value;
    expect(lanes.map((lane) => [lane.steps, lane.cells.length])).toEqual([
      [2, 2],
      [2, 2],
    ]);
    expect(lanes[0].cells[1].velocity).toBe(1);
    sequencer.setSize(6);
    lanes = sequencer.pattern.value.lanes;
    expect(lanes[0].cells).toHaveLength(6);
    expect(lanes[0].steps).toBe(2);
    expect(lanes[0].cells[5].velocity).toBe(0);
    expect(() => sequencer.setSize(0)).toThrow("Step Sequencer needs an integer size from 1 to 128.");
    expect(() => sequencer.setSize(1.5)).toThrow("Step Sequencer needs an integer size from 1 to 128.");
    stop();
  });

  test("the cells are read-only views and commands do not subscribe a calling effect", () => {
    const { sequencer, run } = rig(4, [{ id: "a", cells: cellsAt(4, { 0: 1 }) }]);
    // @ts-expect-error pattern is a ReadonlyCell: there is no setter
    expect(() => (sequencer.pattern.value = { size: 1, lanes: [] })).toThrow();
    let runs = 0;
    const stop = effect(() => {
      runs++;
      sequencer.setCell("a", 1, { velocity: 1 });
      sequencer.toggle("a", 2);
      sequencer.setLane("a", { swing: 0.1 });
      sequencer.setSize(5);
      run(0, 1);
      sequencer.reset();
    });
    sequencer.setCell("a", 3, { velocity: 1 });
    sequencer.setSize(6);
    expect(runs).toBe(1);
    stop();
  });
});

describe("scheduling", () => {
  test("a 5-step lane drifts against a 16-step lane and both restart each loop", () => {
    const { run, beats, steps } = rig(16, [
      { id: "five", steps: 5, cells: cellsAt(16, { 0: 1, 1: 1, 2: 1, 3: 1, 4: 1 }) },
      { id: "sixteen", cells: cellsAt(16, { 0: 1, 15: 1 }) },
    ]);
    run(0, 4);
    // Loop 0: the 5-step lane cycles 0..4 three times and starts a fourth cycle at step 15 -> cell 0.
    expect(steps("five")).toEqual([0, 1, 2, 3, 4, 0, 1, 2, 3, 4, 0, 1, 2, 3, 4, 0]);
    expect(steps("sixteen")).toEqual([0, 15]);
    run(4, 8);
    // Loop 1 restarts both lanes at beat 4.
    expect(steps("five").slice(16, 19)).toEqual([0, 1, 2]);
    close(beats("five").slice(16, 19), [4, 4.25, 4.5]);
    expect(steps("sixteen")).toEqual([0, 15, 0, 15]);
    close(beats("sixteen"), [0, 3.75, 4, 7.75]);
  });

  test("windows that tile the timeline schedule each boundary exactly once", () => {
    const lane = { id: "a", rate: "1/8T" as const, cells: cellsAt(8, Object.fromEntries(Array.from({ length: 8 }, (_, i) => [i, 1]))) };
    const whole = rig(8, [lane]);
    whole.run(0, 6);
    const tiled = rig(8, [lane]);
    for (let beat = 0; beat < 6; beat += 0.7) tiled.run(beat, Math.min(6, beat + 0.7));
    close(
      tiled.beats().sort((x, y) => x - y),
      whole.beats().sort((x, y) => x - y),
    );
    expect(whole.beats()).toHaveLength(18);
  });

  test("rates, including a triplet", () => {
    const { run, beats } = rig(
      16,
      (["1/4", "1/8", "1/8T", "1/16T", "1/2"] as const).map((rate) => ({
        id: rate,
        rate,
        cells: cellsAt(16, Object.fromEntries(Array.from({ length: 16 }, (_, i) => [i, 1]))),
      })),
    );
    run(0, 4);
    close(beats("1/4"), [0, 1, 2, 3]);
    close(beats("1/8"), [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5]);
    close(
      beats("1/8T"),
      Array.from({ length: 12 }, (_, i) => i / 3),
    );
    expect(beats("1/16T")).toHaveLength(24);
    close(beats("1/2"), [0, 2]);
  });

  test("a rate that does not divide the loop is cut off at the loop end", () => {
    const { run, beats } = rig(4, [{ id: "a", rate: "1/2", cells: cellsAt(4, { 0: 1, 1: 1, 2: 1, 3: 1 }) }]);
    run(0, 2);
    // Loop is 1 beat; a half-note step (2 beats) starts once per loop.
    close(beats(), [0, 1]);
    const t = rig(4, [{ id: "a", rate: "1/8T", cells: cellsAt(4, { 0: 1, 1: 1, 2: 1, 3: 1 }) }]);
    t.run(0, 1);
    close(t.beats(), [0, 1 / 3, 2 / 3]);
  });

  test("forward, backward and bounce", () => {
    const full = cellsAt(16, Object.fromEntries(Array.from({ length: 16 }, (_, i) => [i, 1])));
    const { run, steps } = rig(16, [
      { id: "f", steps: 4, cells: full },
      { id: "b", steps: 4, direction: "backward", cells: full },
      { id: "p", steps: 4, direction: "bounce", cells: full },
      { id: "p1", steps: 1, direction: "bounce", cells: full },
      { id: "p2", steps: 2, direction: "bounce", cells: full },
    ]);
    run(0, 4);
    expect(steps("f").slice(0, 6)).toEqual([0, 1, 2, 3, 0, 1]);
    expect(steps("b").slice(0, 6)).toEqual([3, 2, 1, 0, 3, 2]);
    expect(steps("p").slice(0, 10)).toEqual([0, 1, 2, 3, 2, 1, 0, 1, 2, 3]);
    expect(steps("p1")).toEqual(Array(16).fill(0));
    expect(steps("p2").slice(0, 5)).toEqual([0, 1, 0, 1, 0]);
  });

  test("swing delays odd lane steps", () => {
    const { run, beats } = rig(4, [{ id: "a", swing: 0.5, cells: cellsAt(4, { 0: 1, 1: 1, 2: 1, 3: 1 }) }]);
    run(0, 1);
    // swing 0.5 delays odd steps by 0.25 of a 0.25-beat step.
    close(beats(), [0, 0.25 + 0.0625, 0.5, 0.75 + 0.0625]);
  });

  test("positive and negative offsets; a past trigger plays at the current time", () => {
    const { run, hits, beats } = rig(4, [
      { id: "a", cells: cellsAt(4, { 0: { velocity: 1, offset: -0.5 }, 1: { velocity: 1, offset: 0.5 }, 2: { velocity: 1, offset: -0.5 } }) },
    ]);
    // The window starts at beat 0 with the clock already there: step 0's trigger lies 0.125 beats before it.
    run(0, 1, timing.beatToTime(0));
    expect(hits[0].when).toBe(timing.beatToTime(0));
    close(beats().slice(1), [0.25 + 0.125, 0.5 - 0.125]);
    // A trigger still ahead of the current time keeps its computed time.
    const late = rig(4, [{ id: "a", cells: cellsAt(4, { 3: { velocity: 1, offset: -0.5 } }) }]);
    late.run(0.5, 1, timing.beatToTime(0.5));
    close(late.beats(), [0.75 - 0.125]);
    // Current time already past the trigger: it plays now.
    const past = rig(4, [{ id: "a", cells: cellsAt(4, { 2: { velocity: 1, offset: -0.5 } }) }]);
    past.run(0.5, 1, timing.beatToTime(0.45));
    close(past.beats(), [0.45]); // boundary 0.5, trigger 0.375: already past, plays at the current time
  });

  test("repeat count, spacing and per-hit duration", () => {
    const { run, hits, beats } = rig(4, [{ id: "a", rate: "1/8", cells: cellsAt(4, { 0: { velocity: 0.8, repeat: 3, length: 2, pitch: -7 } }) }]);
    run(0, 1);
    close(beats(), [0, 0.5 / 3, 1 / 3]);
    expect(hits.map((hit) => [hit.repeatIndex, hit.repeatCount, hit.velocity, hit.pitch, hit.step])).toEqual([
      [0, 3, 0.8, -7, 0],
      [1, 3, 0.8, -7, 0],
      [2, 3, 0.8, -7, 0],
    ]);
    // length 2 lane steps of 0.5 beats, split over 3 repeats, at 0.5 s per beat.
    for (const hit of hits) expect(hit.duration).toBeCloseTo((2 * 0.5) / 3 / 2, 6);
    const single = rig(4, [{ id: "a", cells: cellsAt(4, { 0: { velocity: 1, length: 0.5 } }) }]);
    single.run(0, 1);
    expect(single.hits[0].duration).toBeCloseTo(0.5 * 0.25 * 0.5, 6);
  });

  test("mute and solo", () => {
    const lanes = ["a", "b", "c"].map((id) => ({ id, cells: cellsAt(4, { 0: 1 }) }));
    const play = (patch: Record<string, { mute?: boolean; solo?: boolean }>) => {
      const r = rig(4, lanes);
      for (const [id, change] of Object.entries(patch)) r.sequencer.setLane(id, change);
      r.run(0, 1);
      return r.hits.map((hit) => hit.laneId).sort();
    };
    expect(play({})).toEqual(["a", "b", "c"]);
    expect(play({ b: { mute: true } })).toEqual(["a", "c"]);
    expect(play({ b: { solo: true } })).toEqual(["b"]);
    expect(play({ a: { solo: true }, c: { solo: true } })).toEqual(["a", "c"]);
    expect(play({ a: { solo: true, mute: true }, b: { solo: true } })).toEqual(["b"]);
  });

  test("chance uses the injectable random once per step", () => {
    const cells = cellsAt(16, Object.fromEntries(Array.from({ length: 16 }, (_, i) => [i, { velocity: 1, chance: 0.5, repeat: 2 }])));
    const draws: number[] = [];
    const sequence = [0.1, 0.9, 0.49, 0.5];
    const random = () => {
      const value = sequence[draws.length % sequence.length];
      draws.push(value);
      return value;
    };
    const { run, hits, steps } = rig(16, [{ id: "a", cells }], random);
    run(0, 1);
    expect(draws).toHaveLength(4);
    expect(steps("a")).toEqual([0, 0, 2, 2]);
    expect(hits.map((hit) => hit.repeatIndex)).toEqual([0, 1, 0, 1]);

    const never = rig(4, [{ id: "a", cells: cellsAt(4, { 0: { velocity: 1, chance: 0 }, 1: { velocity: 1, chance: 0 } }) }], () => 0);
    never.run(0, 1);
    expect(never.hits).toHaveLength(0);
    const always = rig(4, [{ id: "a", cells: cellsAt(4, { 0: { velocity: 1, chance: 1 }, 1: { velocity: 1, chance: 1 } }) }], () => 0.999999);
    always.run(0, 1);
    expect(always.hits).toHaveLength(2);

    // A step that is off never draws.
    let calls = 0;
    const off = rig(4, [{ id: "a" }], () => (calls++, 0));
    off.run(0, 1);
    expect(calls).toBe(0);
  });

  test("playheads and loopProgress follow the window's current time", () => {
    const { sequencer, run } = rig(16, [
      { id: "five", steps: 5 },
      { id: "back", direction: "backward" },
      { id: "slow", rate: "1/4" },
    ]);
    run(0, 1, timing.beatToTime(0));
    expect(sequencer.playheads.value).toEqual({ five: 0, back: 15, slow: 0 });
    expect(sequencer.loopProgress.value).toBe(0);
    run(1, 2, timing.beatToTime(1.3));
    // beat 1.3 is lane step 5 at 1/16: 5 mod 5 = 0; backward 15-5 = 10; the 1/4 lane is on step 1.
    expect(sequencer.playheads.value).toEqual({ five: 0, back: 10, slow: 1 });
    expect(sequencer.loopProgress.value).toBeCloseTo(1.3 / 4, 6);
    run(4, 5, timing.beatToTime(4.1));
    expect(sequencer.loopProgress.value).toBeCloseTo(0.1 / 4, 6);
    expect(sequencer.playheads.value.slow).toBe(0);
    let heads = 0;
    const stop = effect(() => {
      void sequencer.playheads.value;
      heads++;
    });
    run(4, 5, timing.beatToTime(4.1));
    expect(heads).toBe(1);
    stop();
  });

  test("reset cancels pending events and clears the playheads", () => {
    const { sequencer, run, events } = rig(4, [{ id: "a", cells: cellsAt(4, { 0: 1, 1: 1 }) }]);
    const owned = run(0, 1);
    expect(owned).toHaveLength(2);
    expect(sequencer.playheads.value.a).not.toBeNull();
    sequencer.reset();
    expect(events.map((event) => event.cancelled)).toEqual([1, 1]);
    expect(sequencer.playheads.value).toEqual({ a: null });
    expect(sequencer.loopProgress.value).toBeNull();
    sequencer.reset();
    expect(events.map((event) => event.cancelled)).toEqual([1, 1]);
  });

  test("a trigger returning null registers nothing", () => {
    const sequencer = new StepSequencer({ size: 4, lanes: [{ id: "a", cells: cellsAt(4, { 0: 1 }) }] }, () => null);
    const owned: unknown[] = [];
    sequencer.schedule({ beat: { start: 0, end: 1 }, time: { current: 10 }, own: (event) => owned.push(event) }, timing);
    expect(owned).toHaveLength(0);
  });
});
