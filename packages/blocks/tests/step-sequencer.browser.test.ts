import { describe, expect, test } from "vitest";
import { effect, type BeatTiming, type CancellableEvent } from "@audiorective/core";
import {
  defaultStepTransforms,
  StepSequencer,
  stepSwing,
  type StepCellInput,
  type StepHit,
  type StepLaneInput,
  type StepParamSpec,
  type StepSequencerOptions,
  type StepTransform,
  type StepWindow,
} from "../src/StepSequencer";

/** 120 bpm starting at audio time 10: one beat is 0.5 s. */
const timing: BeatTiming = { beatToTime: (beat) => 10 + beat * 0.5, timeToBeat: (time) => (time - 10) * 2 };
const on = (velocity = 1): StepCellInput => ({ velocity });
const cellsAt = (size: number, active: Record<number, StepCellInput | number>): StepCellInput[] =>
  Array.from({ length: size }, (_, i) => {
    const value = active[i];
    return value === undefined ? {} : typeof value === "number" ? on(value) : value;
  });

function rig(size: number, lanes: StepLaneInput[], random?: () => number, options: Omit<StepSequencerOptions, "random"> = {}) {
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
    { random, ...options },
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
    expect(lanes[0].cells[0]).toEqual({ velocity: 0.5, offset: 0, length: 1, repeat: 1, pitch: 0, chance: 1, custom: {} });
    expect(lanes[0].cells[3]).toEqual({ velocity: 0, offset: 0, length: 1, repeat: 1, pitch: 0, chance: 1, custom: {} });
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

describe("custom step params", () => {
  const params: StepParamSpec[] = [
    { id: "cutoff", min: 0, max: 1, default: 0.5 },
    { id: "pan", label: "Pan", min: -1, max: 1, default: 0, step: 0.1 },
  ];

  test("declaration validation", () => {
    const make = (list: StepParamSpec[]) => () => new StepSequencer({ size: 4, lanes: [] }, () => null, { params: list });
    expect(make(params)).not.toThrow();
    for (const bad of [
      [{ id: "", min: 0, max: 1, default: 0 }],
      [params[0], params[0]],
      [{ id: "velocity", min: 0, max: 1, default: 0 }],
      [{ id: "custom", min: 0, max: 1, default: 0 }],
      [{ id: "x", min: 1, max: 1, default: 1 }],
      [{ id: "x", min: 0, max: NaN, default: 0 }],
      [{ id: "x", min: 0, max: 1, default: 2 }],
    ])
      expect(make(bad), JSON.stringify(bad)).toThrow(/^Step Sequencer params need/);
  });

  test("defaults, exposure and partial merge", () => {
    const { sequencer } = rig(4, [{ id: "a" }], undefined, { params });
    expect(sequencer.params.map((p) => p.id)).toEqual(["cutoff", "pan"]);
    expect(sequencer.pattern.value.lanes[0].cells[2].custom).toEqual({ cutoff: 0.5, pan: 0 });
    sequencer.setCell("a", 1, { custom: { cutoff: 0.4 } });
    expect(sequencer.pattern.value.lanes[0].cells[1].custom).toEqual({ cutoff: 0.4, pan: 0 });
    sequencer.setCell("a", 1, { custom: { pan: -1 } });
    expect(sequencer.pattern.value.lanes[0].cells[1].custom).toEqual({ cutoff: 0.4, pan: -1 });
    // A no-op custom edit is no change.
    const before = sequencer.pattern.value;
    sequencer.setCell("a", 1, { custom: { pan: -1 } });
    expect(sequencer.pattern.value).toBe(before);
    // Constructor cells and setSize padding carry the defaults.
    const made = rig(2, [{ id: "a", cells: [{ custom: { pan: 0.5 } }] }], undefined, { params });
    expect(made.sequencer.pattern.value.lanes[0].cells[0].custom).toEqual({ cutoff: 0.5, pan: 0.5 });
    made.sequencer.setSize(3);
    expect(made.sequencer.pattern.value.lanes[0].cells[2].custom).toEqual({ cutoff: 0.5, pan: 0 });
  });

  test("range and undeclared ids throw and change nothing", () => {
    const { sequencer } = rig(4, [{ id: "a" }], undefined, { params });
    const before = sequencer.pattern.value;
    expect(() => sequencer.setCell("a", 0, { custom: { cutoff: 1.1 } })).toThrow(/^Step Sequencer custom values need/);
    expect(() => sequencer.setCell("a", 0, { velocity: 1, custom: { nope: 0 } })).toThrow(/^Step Sequencer custom values need/);
    expect(() => sequencer.setCell("a", 0, { custom: { cutoff: NaN } })).toThrow(/^Step Sequencer custom values need/);
    expect(sequencer.pattern.value).toBe(before);
    expect(() => rig(2, [{ id: "a", cells: [{ custom: { cutoff: 5 } }] }], undefined, { params })).toThrow(/^Step Sequencer custom values need/);
    // Without declared params every custom id is undeclared.
    expect(() => rig(2, [{ id: "a", cells: [{ custom: { cutoff: 0 } }] }])).toThrow(/^Step Sequencer custom values need/);
  });

  test("hits carry the cell's custom values; no params means an empty record", () => {
    const { run, hits } = rig(4, [{ id: "a", cells: [{ velocity: 1, custom: { cutoff: 0.9 } }] }], undefined, { params });
    run(0, 1);
    expect(hits[0].custom).toEqual({ cutoff: 0.9, pan: 0 });
    const plain = rig(4, [{ id: "a", cells: cellsAt(4, { 0: 1 }) }]);
    plain.run(0, 1);
    expect(plain.hits[0].custom).toEqual({});
    expect(plain.sequencer.params).toEqual([]);
  });
});

describe("hit fields", () => {
  test("count, stepBeat, rateBeats, swing and loop across two loops", () => {
    const { run, hits } = rig(4, [{ id: "a", rate: "1/8", swing: 0.4, steps: 2, cells: cellsAt(4, { 0: 1, 1: 1 }) }]);
    run(0, 4);
    // The loop is 1 beat: two 1/8 steps per loop.
    expect(hits.map((hit) => [hit.loop, hit.count, hit.step, hit.stepBeat, hit.rateBeats, hit.swing])).toEqual([
      [0, 0, 0, 0, 0.5, 0.4],
      [0, 1, 1, 0.5, 0.5, 0.4],
      [1, 0, 0, 1, 0.5, 0.4],
      [1, 1, 1, 1.5, 0.5, 0.4],
      [2, 0, 0, 2, 0.5, 0.4],
      [2, 1, 1, 2.5, 0.5, 0.4],
      [3, 0, 0, 3, 0.5, 0.4],
      [3, 1, 1, 3.5, 0.5, 0.4],
    ]);
  });
});

describe("transform sockets", () => {
  const four = cellsAt(4, { 0: 1, 1: 1, 2: 1, 3: 1 });
  // These generic tests drive the seconds unit; the beat unit has its own describe below.
  const named = (id: string, apply: (events: readonly StepHit[]) => readonly StepHit[]): StepTransform => ({
    id,
    unit: "second",
    apply: (events) => apply(events),
  });

  test("defaults are exposed and equal phase 1 swing timing; an empty list is straight", () => {
    const lane = { id: "a", swing: 0.5, cells: four };
    const withDefault = rig(4, [lane]);
    expect(withDefault.sequencer.transforms.value).toBe(withDefault.sequencer.transforms.value);
    expect(withDefault.sequencer.transforms.value.map((t) => t.id)).toEqual(["step-swing"]);
    expect(defaultStepTransforms.map((t) => t.id)).toEqual(["step-swing"]);
    withDefault.run(0, 1);
    close(withDefault.beats(), [0, 0.25 + 0.0625, 0.5, 0.75 + 0.0625]);
    const straight = rig(4, [lane], undefined, { transforms: [] });
    straight.run(0, 1);
    close(straight.beats(), [0, 0.25, 0.5, 0.75]);
    // Swing composes with offset and repeat as before.
    const mixed = rig(4, [{ id: "a", swing: 1, cells: cellsAt(4, { 1: { velocity: 1, offset: 0.5, repeat: 2 } }) }]);
    mixed.run(0, 1);
    close(mixed.beats(), [0.25 + 0.125 + 0.125, 0.25 + 0.125 + 0.125 + 0.125]);
    expect(stepSwing().id).toBe("step-swing");
  });

  test("transforms run in array order on each window's hits", () => {
    const calls: string[] = [];
    const shift = (id: string, by: number) =>
      named(id, (events) => {
        calls.push(`${id}:${events.length}`);
        return events.map((hit) => ({ ...hit, when: hit.when + by }));
      });
    const { run, hits } = rig(4, [{ id: "a", cells: four }], undefined, { transforms: [shift("one", 1), shift("two", 10)] });
    run(0, 1);
    expect(calls).toEqual(["one:4", "two:4"]);
    expect(hits[0].when).toBe(timing.beatToTime(0) + 11);
    // Order matters: the second sees the first's output.
    const order: number[] = [];
    const seen = rig(4, [{ id: "a", cells: four }], undefined, {
      transforms: [shift("one", 1), named("peek", (events) => (order.push(events[0].when), events))],
    });
    seen.run(0, 1);
    expect(order).toEqual([timing.beatToTime(0) + 1]);
  });

  test("an event earlier than now plays at now", () => {
    const early = named("early", (events) => events.map((hit) => ({ ...hit, when: 0 })));
    const { run, hits } = rig(4, [{ id: "a", cells: four }], undefined, { transforms: [early] });
    run(0, 1, 12);
    expect(hits.map((hit) => hit.when)).toEqual([12, 12, 12, 12]);
  });

  test("invalid outputs throw an error that names the transform", () => {
    const bad = (patch: Partial<StepHit>) => {
      const { run } = rig(4, [{ id: "a", cells: four }], undefined, {
        transforms: [named("culprit", (events) => events.map((hit) => ({ ...hit, ...patch })))],
      });
      return () => run(0, 1);
    };
    expect(bad({ when: NaN })).toThrow('Event transform "culprit" returned an event without a finite "when".');
    expect(bad({ when: Infinity })).toThrow(/"culprit"/);
    expect(bad({ duration: 0 })).toThrow(/"culprit".*"duration"/);
    expect(bad({ duration: -1 })).toThrow(/"culprit".*"duration"/);
    expect(bad({ duration: NaN })).toThrow(/"culprit".*"duration"/);
    expect(bad({ velocity: 1.1 })).toThrow(/"culprit".*"velocity"/);
    expect(bad({ velocity: -0.1 })).toThrow(/"culprit".*"velocity"/);
    expect(bad({ velocity: NaN })).toThrow(/"culprit".*"velocity"/);
    const { run } = rig(4, [{ id: "a", cells: four }], undefined, { transforms: [{ id: "arr", apply: () => undefined as never }] });
    expect(() => run(0, 1)).toThrow(/"arr" must return an array/);
  });

  test("velocity 0 drops the event", () => {
    const dropOdd = named("drop", (events) => events.map((hit) => (hit.step % 2 ? { ...hit, velocity: 0 } : hit)));
    const { run, steps } = rig(4, [{ id: "a", cells: four }], undefined, { transforms: [dropOdd] });
    const owned = run(0, 1);
    expect(steps("a")).toEqual([0, 2]);
    expect(owned).toHaveLength(2);
  });

  test("an added event is triggered and owned, and reset cancels it", () => {
    const ratchet = named("ratchet", (events) => events.flatMap((hit) => [hit, { ...hit, when: hit.when + 0.01, repeatIndex: 9 }]));
    const { sequencer, run, events, hits } = rig(4, [{ id: "a", cells: cellsAt(4, { 0: 1 }) }], undefined, { transforms: [ratchet] });
    const owned = run(0, 1);
    expect(hits.map((hit) => hit.repeatIndex)).toEqual([0, 9]);
    expect(owned.map((o) => o.when)).toEqual(hits.map((hit) => hit.when));
    sequencer.reset();
    expect(events.map((event) => event.cancelled)).toEqual([1, 1]);
  });

  describe("stable randomness", () => {
    const chancy = (n: number, chance = 0.5) =>
      cellsAt(n, Object.fromEntries(Array.from({ length: n }, (_, i) => [i, { velocity: 1, chance, repeat: 2 }])));
    const humanize: StepTransform = {
      id: "humanize",
      unit: "second",
      apply: (hits, { randomFor }) => hits.map((hit) => ({ ...hit, when: hit.when + (randomFor(hit) - 0.5) * 0.01 })),
    };
    /** Identity-keyed, order-independent summary of what sounded. */
    const summary = (hits: StepHit[]) => hits.map((h) => `${h.laneId}:${h.loop}:${h.count}:${h.repeatIndex}@${h.when.toFixed(9)}`).sort();

    test("an unrelated edit and re-queue keeps the chance outcomes and humanize offsets", () => {
      const lanes = [
        { id: "a", cells: chancy(16) },
        { id: "b", cells: chancy(16) },
      ];
      const { sequencer, hits, run } = rig(16, lanes, undefined, { transforms: [humanize] });
      run(0, 8);
      const before = summary(hits);
      expect(before.length).toBeGreaterThan(0);
      expect(before.length).toBeLessThan(2 * 16 * 2 * 2);
      hits.length = 0;
      sequencer.setCell("b", 0, { pitch: 3 });
      sequencer.setLane("a", { swing: 0 });
      run(0, 8);
      // Lane b step 0 changed pitch only; every identity and every jittered time is the same.
      expect(summary(hits)).toEqual(before);
      hits.length = 0;
      run(0, 8);
      expect(summary(hits)).toEqual(before);
    });

    test("small and large look-ahead windows give the same result", () => {
      const lanes = [
        { id: "a", cells: chancy(16) },
        { id: "b", rate: "1/8" as const, cells: chancy(16) },
      ];
      const big = rig(16, lanes, undefined, { transforms: [humanize] });
      big.run(0, 8, 0);
      const small = rig(16, lanes, undefined, { transforms: [humanize] });
      for (let start = 0; start < 8; start += 0.3) small.run(start, Math.min(8, start + 0.3), 0); // current far in the past: no clamp to `now`
      expect(summary(small.hits)).toEqual(summary(big.hits));
    });

    test("seeds: same seed reproduces, different seeds differ, all results are valid", () => {
      const play = (seed: number) => {
        const r = rig(16, [{ id: "a", cells: chancy(16) }], undefined, { seed, transforms: [humanize] });
        r.run(0, 12);
        return summary(r.hits);
      };
      expect(play(7)).toEqual(play(7));
      expect(play(7)).not.toEqual(play(8));
      const seeded = rig(16, [{ id: "a", cells: chancy(16) }], undefined, { seed: 7, transforms: [humanize] });
      seeded.run(0, 12);
      for (const hit of seeded.hits) expect(Number.isFinite(hit.when)).toBe(true);
    });

    test("repeats of one step share the chance outcome", () => {
      const r = rig(16, [{ id: "a", cells: chancy(16) }], undefined, { seed: 3 });
      r.run(0, 4);
      const byStep = new Map<number, number>();
      for (const hit of r.hits) byStep.set(hit.count, (byStep.get(hit.count) ?? 0) + 1);
      expect(byStep.size).toBeGreaterThan(0);
      for (const n of byStep.values()) expect(n).toBe(2);
    });

    test("randomFor gives independent numbers per key and a stable number per event", () => {
      const seen: number[][] = [];
      const probe: StepTransform = {
        id: "probe",
        apply: (hits, { randomFor }) => (
          seen.push(
            hits.map((hit) => randomFor(hit)),
            hits.map((hit) => randomFor(hit, "other")),
          ),
          hits
        ),
      };
      const r = rig(4, [{ id: "a", cells: cellsAt(4, { 0: 1, 1: 1 }) }], undefined, { transforms: [probe] });
      r.run(0, 1);
      r.run(0, 1);
      expect(seen[0]).toEqual(seen[2]);
      expect(seen[1]).toEqual(seen[3]);
      expect(seen[0]).not.toEqual(seen[1]);
      expect(seen[0][0]).not.toBe(seen[0][1]);
    });

    test("chance 0.5 plays about half the steps", () => {
      const n = 64;
      const r = rig(n, [{ id: "a", cells: cellsAt(n, Object.fromEntries(Array.from({ length: n }, (_, i) => [i, { velocity: 1, chance: 0.5 }]))) }]);
      r.run(0, n * 0.25 * 16);
      const total = n * 16;
      expect(r.hits.length).toBeGreaterThan(total * 0.4);
      expect(r.hits.length).toBeLessThan(total * 0.6);
    });
  });

  test("randomness comes from context.random, which is the injected source", () => {
    let seenRandom: (() => number) | undefined;
    const t: StepTransform = {
      id: "jitter",
      unit: "second",
      apply: (events, context) => ((seenRandom = context.random), events.map((hit) => ({ ...hit, when: hit.when + context.random() }))),
    };
    let n = 0;
    const random = () => [0.25, 0.75][n++ % 2];
    const { run, hits } = rig(4, [{ id: "a", cells: cellsAt(4, { 0: 1, 1: 1 }) }], random, { transforms: [t] });
    run(0, 1);
    // Chance draws 0.25 then 0.75 for the two steps; the transform then draws 0.25 and 0.75 again for the two hits.
    expect(hits[0].when).toBeCloseTo(timing.beatToTime(0) + 0.25, 9);
    expect(hits[1].when).toBeCloseTo(timing.beatToTime(0.25) + 0.75, 9);
    expect(typeof seenRandom).toBe("function");
  });

  test("setTransforms is a tracked owner write; invalid lists throw", () => {
    const { sequencer, run, beats } = rig(4, [{ id: "a", swing: 0.5, cells: four }]);
    let runs = 0;
    const stop = effect(() => {
      void sequencer.transforms.value;
      runs++;
    });
    sequencer.setTransforms([]);
    expect(runs).toBe(2);
    expect(sequencer.transforms.value).toEqual([]);
    run(0, 1);
    close(beats(), [0, 0.25, 0.5, 0.75]);
    // @ts-expect-error transforms is a ReadonlyCell: there is no setter
    expect(() => (sequencer.transforms.value = [])).toThrow();
    expect(() => sequencer.setTransforms([{ id: "", apply: (e) => e }])).toThrow(/^Step Sequencer transforms need/);
    expect(() => sequencer.setTransforms([{ id: "x" } as never])).toThrow(/^Step Sequencer transforms need/);
    expect(() => new StepSequencer({ size: 4, lanes: [] }, () => null, { transforms: "no" as never })).toThrow(/^Step Sequencer transforms need/);
    expect(runs).toBe(2);
    // Calling it inside an effect does not subscribe that effect.
    let inner = 0;
    const stop2 = effect(() => {
      inner++;
      sequencer.setTransforms(defaultStepTransforms);
    });
    sequencer.setTransforms([]);
    expect(inner).toBe(1);
    stop();
    stop2();
  });

  test("a custom transform composes after the defaults", () => {
    const evenLoops = named("even-loops", (events) => events.filter((hit) => hit.loop % 2 === 0));
    const { sequencer, run, hits } = rig(4, [{ id: "a", swing: 0.5, cells: cellsAt(4, { 0: 1, 1: 1 }) }]);
    sequencer.setTransforms([...defaultStepTransforms, evenLoops]);
    run(0, 2);
    expect(hits.map((hit) => hit.loop)).toEqual([0, 0]);
    close(
      hits.map((hit) => (hit.when - 10) * 2),
      [0, 0.25 + 0.0625],
    );
  });
});

describe("beat and seconds transforms", () => {
  const four = cellsAt(4, { 0: 1, 1: 1, 2: 1, 3: 1 });
  /** A tempo that speeds up: beat b sounds at 10 + 0.5 b + 0.1 b^2. */
  const ramp: BeatTiming = {
    beatToTime: (beat) => 10 + 0.5 * beat + 0.1 * beat * beat,
    timeToBeat: (time) => (-0.5 + Math.sqrt(0.25 + 0.4 * (time - 10))) / 0.2,
  };
  const play = (clock: BeatTiming, lanes: StepLaneInput[], transforms: readonly StepTransform[], current?: number) => {
    const hits: StepHit[] = [];
    const sequencer = new StepSequencer({ size: 4, lanes }, (hit) => (hits.push(hit), null), { transforms });
    sequencer.schedule({ beat: { start: 0, end: 1 }, time: { current: current ?? clock.beatToTime(0) }, own: () => {} }, clock);
    return hits;
  };

  test("a beat transform and the equivalent seconds transform agree at constant tempo", () => {
    const byBeats: StepTransform = {
      id: "beats",
      apply: (events) => events.map((hit) => ({ ...hit, beat: hit.beat + 0.1, durationBeats: hit.durationBeats * 2 })),
    };
    // At 120 bpm one beat is 0.5 s.
    const bySeconds: StepTransform = {
      id: "seconds",
      unit: "second",
      apply: (events) => events.map((hit) => ({ ...hit, when: hit.when + 0.05, duration: hit.duration * 2 })),
    };
    const lanes = [{ id: "a", swing: 0.5, cells: four }];
    const a = play(timing, lanes, [stepSwing(), byBeats]);
    const b = play(timing, lanes, [stepSwing(), bySeconds]);
    expect(a).toHaveLength(4);
    a.forEach((hit, i) => {
      expect(hit.when).toBeCloseTo(b[i].when, 9);
      expect(hit.duration).toBeCloseTo(b[i].duration, 9);
    });
  });

  test("swing stays a fixed beat offset when the tempo changes", () => {
    const hits = play(ramp, [{ id: "a", swing: 0.5, cells: four }], defaultStepTransforms);
    const beats = hits.map((hit) => ramp.timeToBeat(hit.when));
    close(beats, [0, 0.25 + 0.0625, 0.5, 0.75 + 0.0625]);
    // The same offset in seconds differs between the first and the last step, so a seconds-only swing could not hold it.
    expect(hits[3].when - ramp.beatToTime(0.75)).not.toBeCloseTo(hits[1].when - ramp.beatToTime(0.25), 3);
  });

  test("a seconds transform's output lands in beats for the next beat transform", () => {
    let seen: Array<{ beat: number; durationBeats: number }> = [];
    let nowBeat = NaN;
    const jitter: StepTransform = { id: "late", unit: "second", apply: (events) => events.map((hit) => ({ ...hit, when: hit.when + 0.2 })) };
    const peek: StepTransform = {
      id: "peek",
      apply: (events, context) => ((seen = events.map(({ beat, durationBeats }) => ({ beat, durationBeats }))), (nowBeat = context.now), events),
    };
    const hits = play(ramp, [{ id: "a", cells: four }], [jitter, peek]);
    seen.forEach((event, i) => {
      const start = ramp.beatToTime(i * 0.25) + 0.2;
      expect(event.beat).toBeCloseTo(ramp.timeToBeat(start), 9);
      expect(event.durationBeats).toBeCloseTo(ramp.timeToBeat(start + hits[i].duration) - event.beat, 9);
      expect(hits[i].when).toBeCloseTo(start, 9);
    });
    // Beat transforms get `now` in beats.
    expect(nowBeat).toBeCloseTo(0, 9);
    // A unit that is not changed by the transform survives the two conversions.
    const identity: StepTransform = { id: "same", unit: "second", apply: (events) => events };
    const through = play(ramp, [{ id: "a", cells: four }], [identity]);
    through.forEach((hit, i) => expect(hit.when).toBeCloseTo(ramp.beatToTime(i * 0.25), 9));
  });

  test("the trigger never sees a time before now", () => {
    const current = ramp.beatToTime(0.3);
    const lanes = [{ id: "a", cells: four }];
    const early: StepTransform = { id: "early", apply: (events) => events.map((hit) => ({ ...hit, beat: hit.beat - 2 })) };
    const earlySeconds: StepTransform = { id: "early-s", unit: "second", apply: (events) => events.map((hit) => ({ ...hit, when: 0 })) };
    for (const transforms of [[], [early], [earlySeconds], [stepSwing(), early, earlySeconds]]) {
      const hits = play(ramp, lanes, transforms, current);
      expect(hits.length).toBeGreaterThan(0);
      for (const hit of hits) expect(hit.when).toBeGreaterThanOrEqual(current);
    }
    expect(play(ramp, lanes, [early], current).every((hit) => hit.when === current)).toBe(true);
  });

  test("invalid beat outputs name the transform", () => {
    const bad = (patch: object) => () =>
      play(timing, [{ id: "a", cells: four }], [{ id: "culprit", apply: (events) => events.map((hit) => ({ ...hit, ...patch })) }]);
    expect(bad({ beat: NaN })).toThrow('Event transform "culprit" returned an event without a finite "beat".');
    expect(bad({ durationBeats: 0 })).toThrow('Event transform "culprit" returned an event whose "durationBeats" is not a finite number above 0.');
    expect(bad({ velocity: 2 })).toThrow(/"culprit".*"velocity"/);
  });
});
