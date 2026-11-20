import { describe, expect, test } from "vitest";
import { effect, type BeatTiming, type CancellableEvent } from "@audiorective/core";
import {
  StepSequencer,
  type Hit,
  type HitTransform,
  type LaneOptions,
  type Pattern,
  type Step,
  type StepRate,
  type StepSequencerOptions,
  type StepWindow,
} from "../src/StepSequencer";

/** 120 bpm starting at audio time 10: one beat is 0.5 s. */
const timing: BeatTiming = { beatToTime: (beat) => 10 + beat * 0.5, timeToBeat: (time) => (time - 10) * 2 };
const full = (n: number) => "X".repeat(n);

type StepFields = Partial<Omit<Step, "values">>;

/** Builds a sequencer over `lanes`, applies per-step field edits (`{ lane: { stepIndex: { offset: 0.2 } } }`) and records every hit. */
function rig(
  lanes: Record<string, Pattern | LaneOptions>,
  options: StepSequencerOptions = {},
  edits: Record<string, Record<number, StepFields>> = {},
) {
  const hits: Hit[] = [];
  const cancelled: number[] = [];
  const sequencer = new StepSequencer(lanes, {
    ...options,
    onHit: (hit) => {
      hits.push(hit);
      return () => cancelled.push(hit.index);
    },
  });
  for (const [name, steps] of Object.entries(edits)) {
    for (const [index, fields] of Object.entries(steps)) Object.assign(sequencer.lanes[name]!.steps[Number(index)]!, fields);
  }
  /** Schedule one window over [start, end) beats; `current` defaults to the window start. */
  const run = (start: number, end: number, current = timing.beatToTime(start)) => {
    const owned: Array<{ event: CancellableEvent; when: number }> = [];
    const window: StepWindow = { beat: { start, end }, time: { current }, own: (event, when) => owned.push({ event, when }) };
    sequencer.schedule(window, timing);
    return owned;
  };
  const beats = (lane?: string) => hits.filter((hit) => !lane || hit.lane === lane).map((hit) => (hit.when - 10) * 2);
  const steps = (lane: string) => hits.filter((hit) => hit.lane === lane).map((hit) => hit.index);
  return { sequencer, hits, cancelled, run, beats, steps };
}

const close = (actual: number[], expected: number[]) => {
  expect(actual).toHaveLength(expected.length);
  actual.forEach((value, i) => expect(value).toBeCloseTo(expected[i]!, 6));
};

describe("model", () => {
  test("defaults fill the lane and every step", () => {
    const { sequencer } = rig({ k: "x..." });
    const lane = sequencer.lanes.k!;
    expect([lane.length, lane.rate, lane.direction, lane.swing, lane.mute, lane.solo, lane.sound]).toEqual([
      4,
      "16n",
      "forward",
      0,
      false,
      false,
      undefined,
    ]);
    expect(lane.steps[0]).toMatchObject({ velocity: 0.8, offset: 0, length: 1, repeat: 1, pitch: 0, chance: 1, values: {} });
    expect(lane.steps[3]).toMatchObject({ velocity: 0, offset: 0, length: 1, repeat: 1, pitch: 0, chance: 1 });
    expect(lane.playhead).toBeNull();
    expect(lane.progress).toBeNull();
  });

  test("lane options set direction, solo and mute at construction", () => {
    const { sequencer } = rig({ a: { pattern: "XX", direction: "bounce", solo: true, mute: true } });
    expect(sequencer.lanes.a).toMatchObject({ direction: "bounce", solo: true, mute: true });
  });

  test("validation errors", () => {
    const make = (lane: Partial<LaneOptions> & Record<string, unknown>) => () => new StepSequencer({ a: { pattern: "XX", ...lane } as LaneOptions });
    for (const bad of [{ direction: "up" }, { mute: 1 }, { solo: "yes" }])
      expect(make(bad), JSON.stringify(bad)).toThrow(/^Step Sequencer lane needs/);
    for (const bad of [{ rate: "1/3" }, { swing: 1.5 }]) expect(make(bad), JSON.stringify(bad)).toThrow(/^Step Sequencer /);
    const lane = new StepSequencer({ a: "XX" }).lanes.a!;
    for (const bad of [0, 129, 1.5, NaN]) expect(() => (lane.length = bad), String(bad)).toThrow(/^Step Sequencer lane needs/);
    expect(() => (lane.direction = "up" as never)).toThrow(/^Step Sequencer lane needs/);
    expect(() => (lane.solo = 1 as never)).toThrow(/^Step Sequencer lane needs/);
    expect(lane.length).toBe(2);
    const step = lane.steps[0]!;
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
      const [key, value] = Object.entries(bad)[0]!;
      expect(() => ((step as Record<string, unknown>)[key] = value), JSON.stringify(bad)).toThrow(/^Step Sequencer cell needs/);
    }
    expect(step).toMatchObject({ velocity: 1, offset: 0, length: 1, repeat: 1, pitch: 0, chance: 1 });
    expect(() => new StepSequencer([] as never)).toThrow(/^Step Sequencer takes a record of lanes/);
    expect(() => new StepSequencer({ a: "X" }, (() => null) as never)).toThrow(/^Step Sequencer takes a record of lanes/);
  });

  test("every step field accepts its bounds and rejects one past them", () => {
    const step = new StepSequencer({ k: "XX" }).lanes.k!.steps[0]!;
    const ranges: Array<[keyof StepFields, number, number, number]> = [
      ["velocity", 0, 1, 0.001],
      ["offset", -0.5, 0.5, 0.001],
      ["length", 1 / 16, 4, 0.001],
      ["repeat", 1, 8, 1],
      ["pitch", -24, 24, 1],
      ["chance", 0, 1, 0.001],
    ];
    for (const [id, min, max, past] of ranges) {
      step[id] = min;
      step[id] = max;
      expect(() => (step[id] = max + past), id).toThrow("Step Sequencer cell");
      expect(() => (step[id] = min - past), id).toThrow("Step Sequencer cell");
    }
    expect(() => (step.repeat = 2.5)).toThrow("Step Sequencer cell");
    expect(() => (step.pitch = 0.5)).toThrow("Step Sequencer cell");
  });

  test("every StepRate name is a valid rate", () => {
    const lane = new StepSequencer({ k: "X" }).lanes.k!;
    const rates: StepRate[] = ["1/2", "1/4", "1/8", "1/16", "1/32", "1/64", "1/2T", "1/4T", "1/8T", "1/16T", "1/32T", "1/64T"];
    for (const rate of rates) {
      lane.rate = rate;
      expect(lane.rate).toBe(rate);
    }
    expect(() => (lane.rate = "1/3" as StepRate)).toThrow("Step Sequencer needs a Time");
  });

  test("a multi-field step write is one change and a no-op write is none", () => {
    const { sequencer } = rig({ a: "...." });
    const lane = sequencer.lanes.a!;
    let runs = 0;
    const stop = effect(() => {
      void lane.steps[0]!.velocity;
      void lane.steps[0]!.offset;
      void lane.rate;
      void lane.direction;
      runs++;
    });
    lane.steps[0]!.velocity = 1;
    expect(runs).toBe(2);
    lane.steps[0]!.velocity = 1;
    lane.rate = "16n";
    lane.direction = "forward";
    expect(runs).toBe(2);
    lane.direction = "backward";
    expect(runs).toBe(3);
    stop();
  });

  test("length shortens and grows the lane; hidden steps keep their values", () => {
    const { sequencer } = rig({ a: "X.X5" });
    const lane = sequencer.lanes.a!;
    lane.steps[3]!.pitch = 7;
    lane.length = 2;
    expect(lane.steps).toHaveLength(2);
    expect(lane.pattern).toBe("X.");
    lane.length = 6;
    expect(lane.steps).toHaveLength(6);
    expect(lane.steps[2]!.velocity).toBe(1);
    expect(lane.steps[3]).toMatchObject({ velocity: 0.5, pitch: 7 });
    expect(lane.steps[5]).toMatchObject({ velocity: 0, pitch: 0 });
    lane.length = 128;
    expect(lane.steps).toHaveLength(128);
  });

  test("step writes, lane setters, schedule and reset do not subscribe a calling effect", () => {
    const { sequencer, run } = rig({ a: "X..." });
    const lane = sequencer.lanes.a!;
    const step = lane.steps[1]!;
    let runs = 0;
    const stop = effect(() => {
      runs++;
      step.velocity = 1;
      lane.swing = 0.1;
      lane.direction = "bounce";
      lane.length = 5;
      run(0, 1);
      sequencer.reset();
    });
    lane.steps[3]!.velocity = 1;
    lane.length = 6;
    expect(runs).toBe(1);
    stop();
  });
});

describe("scheduling", () => {
  test("windows that tile the timeline schedule each boundary exactly once", () => {
    const lanes = { a: { pattern: full(8), rate: "1/8T" as const } };
    const whole = rig(lanes);
    whole.run(0, 6);
    const tiled = rig(lanes);
    for (let beat = 0; beat < 6; beat += 0.7) tiled.run(beat, Math.min(6, beat + 0.7));
    close(
      tiled.beats().sort((x, y) => x - y),
      whole.beats().sort((x, y) => x - y),
    );
    expect(whole.beats()).toHaveLength(18);
  });

  test("rates, including a triplet", () => {
    const { run, beats } = rig(
      Object.fromEntries((["1/4", "1/8", "1/8T", "1/16T", "1/2"] as const).map((rate) => [rate, { pattern: full(16), rate }])),
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

  test("a lane whose length does not fill a beat loops on its own length", () => {
    const { run, beats, steps } = rig({ a: { pattern: "XXX", rate: "1/8T" } });
    run(0, 2);
    close(beats(), [0, 1 / 3, 2 / 3, 1, 4 / 3, 5 / 3]);
    expect(steps("a")).toEqual([0, 1, 2, 0, 1, 2]);
  });

  test("forward, backward and bounce", () => {
    const { run, steps } = rig({
      f: { pattern: "XXXX" },
      b: { pattern: "XXXX", direction: "backward" },
      p: { pattern: "XXXX", direction: "bounce" },
      p1: { pattern: "X", direction: "bounce" },
      p2: { pattern: "XX", direction: "bounce" },
    });
    run(0, 4);
    expect(steps("f").slice(0, 6)).toEqual([0, 1, 2, 3, 0, 1]);
    expect(steps("b").slice(0, 6)).toEqual([3, 2, 1, 0, 3, 2]);
    expect(steps("p").slice(0, 10)).toEqual([0, 1, 2, 3, 2, 1, 0, 1, 2, 3]);
    expect(steps("p1")).toEqual(Array(16).fill(0));
    expect(steps("p2").slice(0, 5)).toEqual([0, 1, 0, 1, 0]);
  });

  test("a direction change applies on the next pass", () => {
    const { sequencer, run, steps } = rig({ a: "XXXX" });
    run(0, 1);
    expect(steps("a")).toEqual([0, 1, 2, 3]);
    sequencer.lanes.a!.direction = "backward";
    run(1, 2);
    expect(steps("a").slice(4)).toEqual([3, 2, 1, 0]);
  });

  test("swing delays odd lane steps", () => {
    const { run, beats } = rig({ a: { pattern: "XXXX", swing: 0.5 } });
    run(0, 1);
    // swing 0.5 delays odd steps by 0.25 of a 0.25-beat step.
    close(beats(), [0, 0.25 + 0.0625, 0.5, 0.75 + 0.0625]);
  });

  test("swing composes with offset and repeat", () => {
    const { run, beats } = rig({ a: { pattern: ".X..", swing: 1 } }, {}, { a: { 1: { offset: 0.5, repeat: 2 } } });
    run(0, 1);
    close(beats(), [0.25 + 0.125 + 0.125, 0.25 + 0.125 + 0.125 + 0.125]);
  });

  test("positive and negative offsets; a past trigger plays at the current time", () => {
    const { run, hits, beats } = rig({ a: "XXX." }, {}, { a: { 0: { offset: -0.5 }, 1: { offset: 0.5 }, 2: { offset: -0.5 } } });
    // The window starts at beat 0 with the clock already there: step 0's trigger lies 0.125 beats before it.
    run(0, 1, timing.beatToTime(0));
    expect(hits[0]!.when).toBe(timing.beatToTime(0));
    close(beats().slice(1), [0.25 + 0.125, 0.5 - 0.125]);
    // A trigger still ahead of the current time keeps its computed time.
    const late = rig({ a: "...X" }, {}, { a: { 3: { offset: -0.5 } } });
    late.run(0.5, 1, timing.beatToTime(0.5));
    close(late.beats(), [0.75 - 0.125]);
    // Current time already past the trigger: it plays now.
    const past = rig({ a: "..X." }, {}, { a: { 2: { offset: -0.5 } } });
    past.run(0.5, 1, timing.beatToTime(0.45));
    close(past.beats(), [0.45]); // boundary 0.5, trigger 0.375: already past, plays at the current time
  });

  test("repeat count, spacing, per-hit duration and pitch", () => {
    const { run, hits, beats } = rig({ a: { pattern: "x...", rate: "1/8" } }, {}, { a: { 0: { repeat: 3, length: 2, pitch: -7 } } });
    run(0, 1);
    close(beats(), [0, 0.5 / 3, 1 / 3]);
    expect(hits.map((hit) => [hit.velocity, hit.pitch, hit.index])).toEqual([
      [0.8, -7, 0],
      [0.8, -7, 0],
      [0.8, -7, 0],
    ]);
    // length 2 lane steps of 0.5 beats, split over 3 repeats, at 0.5 s per beat.
    for (const hit of hits) expect(hit.duration).toBeCloseTo((2 * 0.5) / 3 / 2, 6);
    const single = rig({ a: "X..." }, {}, { a: { 0: { length: 0.5 } } });
    single.run(0, 1);
    expect(single.hits[0]!.duration).toBeCloseTo(0.5 * 0.25 * 0.5, 6);
    expect(single.hits[0]!.pitch).toBe(0);
  });

  test("mute and solo", () => {
    const play = (patch: Record<string, { mute?: boolean; solo?: boolean }>) => {
      const r = rig({ a: "X...", b: "X...", c: "X..." });
      for (const [name, change] of Object.entries(patch)) Object.assign(r.sequencer.lanes[name]!, change);
      r.run(0, 1);
      return r.hits.map((hit) => hit.lane).sort();
    };
    expect(play({})).toEqual(["a", "b", "c"]);
    expect(play({ b: { mute: true } })).toEqual(["a", "c"]);
    expect(play({ b: { solo: true } })).toEqual(["b"]);
    expect(play({ a: { solo: true }, c: { solo: true } })).toEqual(["a", "c"]);
    expect(play({ a: { solo: true, mute: true }, b: { solo: true } })).toEqual(["b"]);
  });

  test("chance uses the injectable random once per step", () => {
    const every = Object.fromEntries(Array.from({ length: 16 }, (_, i) => [i, { chance: 0.5, repeat: 2 }]));
    const draws: number[] = [];
    const sequence = [0.1, 0.9, 0.49, 0.5];
    const random = () => {
      const value = sequence[draws.length % sequence.length]!;
      draws.push(value);
      return value;
    };
    const { run, steps, beats } = rig({ a: full(16) }, { random }, { a: every });
    run(0, 1);
    expect(draws).toHaveLength(4);
    expect(steps("a")).toEqual([0, 0, 2, 2]);
    close(beats(), [0, 0.125, 0.5, 0.625]);

    const never = rig({ a: "XX.." }, { random: () => 0 }, { a: { 0: { chance: 0 }, 1: { chance: 0 } } });
    never.run(0, 1);
    expect(never.hits).toHaveLength(0);
    const always = rig({ a: "XX.." }, { random: () => 0.999999 });
    always.run(0, 1);
    expect(always.hits).toHaveLength(2);

    // A step that is off never draws.
    let calls = 0;
    const off = rig({ a: "...." }, { random: () => (calls++, 0) });
    off.run(0, 1);
    expect(calls).toBe(0);
  });

  test("playheads and progress follow the window's current time, per lane", () => {
    const { sequencer, run } = rig({
      five: { pattern: "....." },
      back: { pattern: ".".repeat(16), direction: "backward" },
      slow: { pattern: ".".repeat(16), rate: "1/4" },
    });
    const { five, back, slow } = sequencer.lanes as Record<string, NonNullable<(typeof sequencer.lanes)[string]>>;
    run(0, 1, timing.beatToTime(0));
    expect([five!.playhead, back!.playhead, slow!.playhead]).toEqual([0, 15, 0]);
    expect([five!.progress, back!.progress, slow!.progress]).toEqual([0, 0, 0]);
    run(1, 2, timing.beatToTime(1.3));
    // beat 1.3 is lane step 5 at 1/16: 5 mod 5 = 0; backward 15 - 5 = 10; the 1/4 lane is on step 1.
    expect([five!.playhead, back!.playhead, slow!.playhead]).toEqual([0, 10, 1]);
    expect(five!.progress).toBeCloseTo((1.3 % 1.25) / 1.25, 6);
    expect(back!.progress).toBeCloseTo(1.3 / 4, 6);
    expect(slow!.progress).toBeCloseTo(1.3 / 16, 6);
    run(4, 5, timing.beatToTime(4.1));
    expect(back!.progress).toBeCloseTo(0.1 / 4, 6);
    expect(slow!.playhead).toBe(4);
    let heads = 0;
    const stop = effect(() => {
      void five!.playhead;
      heads++;
    });
    run(4, 5, timing.beatToTime(4.1)); // progress moves, the step does not: playhead readers stay quiet
    expect(heads).toBe(1);
    stop();
  });

  test("reset retracts pending hits, runs their cleanups and clears the playheads", () => {
    const { sequencer, run, cancelled } = rig({ a: "XX.." });
    const owned = run(0, 1);
    expect(owned).toHaveLength(2);
    expect(sequencer.lanes.a!.playhead).not.toBeNull();
    sequencer.reset();
    expect(cancelled).toEqual([0, 1]);
    expect(sequencer.lanes.a!.playhead).toBeNull();
    expect(sequencer.lanes.a!.progress).toBeNull();
    sequencer.reset();
    expect(cancelled).toHaveLength(2);
  });

  test("a hit nothing listens to registers nothing", () => {
    const sequencer = new StepSequencer({ a: "X..." });
    const owned: unknown[] = [];
    sequencer.schedule({ beat: { start: 0, end: 1 }, time: { current: 10 }, own: (event) => owned.push(event) }, timing);
    expect(owned).toHaveLength(0);
  });
});

describe("per-lane params", () => {
  const params = { cutoff: { min: 0, max: 1, default: 0.5 }, pan: { min: -1, max: 1, default: 0, step: 0.1 } };

  test("declaration validation", () => {
    const make = (list: unknown) => () => new StepSequencer({ a: { pattern: "X", params: list as never } });
    expect(make(params)).not.toThrow();
    for (const bad of [
      { "": { min: 0, max: 1, default: 0 } },
      { velocity: { min: 0, max: 1, default: 0 } },
      { custom: { min: 0, max: 1, default: 0 } },
      { x: { min: 1, max: 1, default: 1 } },
      { x: { min: 0, max: NaN, default: 0 } },
      { x: { min: 0, max: 1, default: 2 } },
      { x: { min: 0, max: 1, default: 0, step: 0 } },
    ])
      expect(make(bad), JSON.stringify(bad)).toThrow(/^Step Sequencer lane params need/);
  });

  test("defaults, exposure and independent writes", () => {
    const { sequencer } = rig({ a: { pattern: "XXX.", params }, b: "XX" });
    const a = sequencer.lanes.a!;
    expect(a.params).toEqual(params);
    expect(sequencer.lanes.b!.params).toEqual({});
    expect({ ...a.steps[2]!.values }).toEqual({ cutoff: 0.5, pan: 0 });
    a.steps[1]!.values.cutoff = 0.4;
    expect({ ...a.steps[1]!.values }).toEqual({ cutoff: 0.4, pan: 0 });
    a.steps[1]!.values.pan = -1;
    expect({ ...a.steps[1]!.values }).toEqual({ cutoff: 0.4, pan: -1 });
    // Steps grown by `length` and `pattern` carry the defaults.
    a.length = 6;
    expect({ ...a.steps[5]!.values }).toEqual({ cutoff: 0.5, pan: 0 });
  });

  test("a no-op write is no change; a bad write throws and changes nothing", () => {
    const { sequencer } = rig({ a: { pattern: "XX", params } });
    const step = sequencer.lanes.a!.steps[0]!;
    let runs = 0;
    const stop = effect(() => {
      void step.values.cutoff;
      runs++;
    });
    step.values.cutoff = 0.5;
    expect(runs).toBe(1);
    expect(() => (step.values.cutoff = 1.1)).toThrow(/^Step Sequencer custom values need/);
    expect(() => (step.values.cutoff = NaN)).toThrow(/^Step Sequencer custom values need/);
    expect(() => ((step.values as Record<string, number>).nope = 0)).toThrow();
    expect(step.values.cutoff).toBe(0.5);
    expect(runs).toBe(1);
    stop();
  });

  test("hits carry the step's values; a lane without params has an empty record", () => {
    const { sequencer, run, hits } = rig({ a: { pattern: "X...", params }, b: "X..." });
    sequencer.lanes.a!.steps[0]!.values.cutoff = 0.9;
    run(0, 1);
    expect(hits.find((hit) => hit.lane === "a")!.values).toEqual({ cutoff: 0.9, pan: 0 });
    expect(hits.find((hit) => hit.lane === "b")!.values).toEqual({});
  });
});

describe("hit fields", () => {
  test("lane, index, loop and swing-adjusted time across loops", () => {
    const { run, hits } = rig({ a: { pattern: "XX", rate: "1/8", swing: 0.4 } });
    run(0, 4);
    // The lane is 1 beat long: two 1/8 steps per loop; swing delays the second by 0.4 * 0.5 * 0.5 beats.
    expect(hits.map((hit) => [hit.lane, hit.loop, hit.index])).toEqual(Array.from({ length: 8 }, (_, k) => ["a", Math.floor(k / 2), k % 2]));
    close(
      hits.map((hit) => (hit.when - 10) * 2),
      Array.from({ length: 8 }, (_, k) => k * 0.5 + (k % 2 ? 0.1 : 0)),
    );
  });
});

describe("transform", () => {
  const four = { a: "XXXX" };
  const withTransform = (transform: HitTransform, lanes: Record<string, Pattern | LaneOptions> = four, options: StepSequencerOptions = {}) =>
    rig(lanes, { transform, ...options });

  test("a returned hit replaces the scheduled one; null drops it", () => {
    const { run, steps, hits } = withTransform((hit) => (hit.index % 2 ? null : { ...hit, when: hit.when + 0.01, velocity: 0.5, pitch: 3 }));
    const owned = run(0, 1);
    expect(steps("a")).toEqual([0, 2]);
    expect(owned).toHaveLength(2);
    expect(hits[0]).toMatchObject({ velocity: 0.5, pitch: 3 });
    expect(hits[0]!.when).toBeCloseTo(10.01, 9);
  });

  test("an event earlier than now plays at now", () => {
    const { run, hits } = withTransform((hit) => ({ ...hit, when: 0 }));
    run(0, 1, 12);
    expect(hits.map((hit) => hit.when)).toEqual([12, 12, 12, 12]);
  });

  test("the scheduler never sees a time before now, under a changing tempo", () => {
    /** A tempo that speeds up: beat b sounds at 10 + 0.5 b + 0.1 b^2. */
    const ramp: BeatTiming = {
      beatToTime: (beat) => 10 + 0.5 * beat + 0.1 * beat * beat,
      timeToBeat: (time) => (-0.5 + Math.sqrt(0.25 + 0.4 * (time - 10))) / 0.2,
    };
    const current = ramp.beatToTime(0.3);
    for (const transform of [undefined, ((hit) => ({ ...hit, when: hit.when - 5 })) as HitTransform]) {
      const hits: Hit[] = [];
      const sequencer = new StepSequencer(four, { transform, onHit: (hit) => void hits.push(hit) });
      sequencer.schedule({ beat: { start: 0, end: 1 }, time: { current }, own: () => {} }, ramp);
      expect(hits.length).toBeGreaterThan(0);
      for (const hit of hits) expect(hit.when).toBeGreaterThanOrEqual(current);
    }
  });

  test("swing stays a fixed beat offset when the tempo changes", () => {
    const ramp: BeatTiming = {
      beatToTime: (beat) => 10 + 0.5 * beat + 0.1 * beat * beat,
      timeToBeat: (time) => (-0.5 + Math.sqrt(0.25 + 0.4 * (time - 10))) / 0.2,
    };
    const hits: Hit[] = [];
    const sequencer = new StepSequencer({ a: { pattern: "XXXX", swing: 0.5 } }, { onHit: (hit) => void hits.push(hit) });
    sequencer.schedule({ beat: { start: 0, end: 1 }, time: { current: ramp.beatToTime(0) }, own: () => {} }, ramp);
    close(
      hits.map((hit) => ramp.timeToBeat(hit.when)),
      [0, 0.25 + 0.0625, 0.5, 0.75 + 0.0625],
    );
    // The same offset in seconds differs between the first and the last step, so a seconds-only swing could not hold it.
    expect(hits[3]!.when - ramp.beatToTime(0.75)).not.toBeCloseTo(hits[1]!.when - ramp.beatToTime(0.25), 3);
  });

  test("invalid outputs throw an error that names the transform", () => {
    const bad = (patch: Partial<Hit>) => {
      const { run } = withTransform((hit) => ({ ...hit, ...patch }));
      return () => run(0, 1);
    };
    expect(bad({ when: NaN })).toThrow('Event transform "transform" returned an event without a finite "when".');
    expect(bad({ when: Infinity })).toThrow(/"transform"/);
    for (const duration of [0, -1, NaN]) expect(bad({ duration })).toThrow(/"transform".*"duration"/);
    for (const velocity of [1.1, -0.1, NaN]) expect(bad({ velocity })).toThrow(/"transform".*"velocity"/);
  });

  test("velocity 0 drops the event", () => {
    const { run, steps } = withTransform((hit) => (hit.index % 2 ? { ...hit, velocity: 0 } : hit));
    const owned = run(0, 1);
    expect(steps("a")).toEqual([0, 2]);
    expect(owned).toHaveLength(2);
  });

  describe("stable randomness", () => {
    const chancy = (n: number) => ({ pattern: full(n) });
    const everyStep = (n: number, chance = 0.5) => Object.fromEntries(Array.from({ length: n }, (_, i) => [i, { chance, repeat: 2 }]));
    const humanize: HitTransform = (hit, random) => ({ ...hit, when: hit.when + (random() - 0.5) * 0.01 });
    /** Identity-keyed, order-independent summary of what sounded. */
    const summary = (hits: Hit[]) => hits.map((h) => `${h.lane}:${h.loop}:${h.index}@${h.when.toFixed(9)}`).sort();

    test("an unrelated edit and re-queue keeps the chance outcomes and humanize offsets", () => {
      const { sequencer, hits, run } = rig({ a: chancy(16), b: chancy(16) }, { transform: humanize }, { a: everyStep(16), b: everyStep(16) });
      run(0, 8);
      const before = summary(hits);
      expect(before.length).toBeGreaterThan(0);
      expect(before.length).toBeLessThan(2 * 16 * 2 * 2);
      hits.length = 0;
      sequencer.lanes.b!.steps[0]!.pitch = 3;
      sequencer.lanes.a!.swing = 0;
      run(0, 8);
      // Lane b step 0 changed pitch only; every identity and every jittered time is the same.
      expect(summary(hits)).toEqual(before);
      hits.length = 0;
      run(0, 8);
      expect(summary(hits)).toEqual(before);
    });

    test("small and large look-ahead windows give the same result", () => {
      const lanes = { a: chancy(16), b: { ...chancy(16), rate: "1/8" as const } };
      const edits = { a: everyStep(16), b: everyStep(16) };
      const big = rig(lanes, { transform: humanize }, edits);
      big.run(0, 8, 0);
      const small = rig(lanes, { transform: humanize }, edits);
      for (let start = 0; start < 8; start += 0.3) small.run(start, Math.min(8, start + 0.3), 0); // current far in the past: no clamp to `now`
      expect(summary(small.hits)).toEqual(summary(big.hits));
    });

    test("seeds: same seed reproduces, different seeds differ, all results are valid", () => {
      const play = (seed: number) => {
        const r = rig({ a: chancy(16) }, { seed, transform: humanize }, { a: everyStep(16) });
        r.run(0, 12);
        return r;
      };
      expect(summary(play(7).hits)).toEqual(summary(play(7).hits));
      expect(summary(play(7).hits)).not.toEqual(summary(play(8).hits));
      for (const hit of play(7).hits) expect(Number.isFinite(hit.when)).toBe(true);
    });

    test("repeats of one step share the chance outcome", () => {
      const r = rig({ a: chancy(16) }, { seed: 3 }, { a: everyStep(16) });
      r.run(0, 4);
      const byStep = new Map<string, number>();
      for (const hit of r.hits) byStep.set(`${hit.loop}:${hit.index}`, (byStep.get(`${hit.loop}:${hit.index}`) ?? 0) + 1);
      expect(byStep.size).toBeGreaterThan(0);
      for (const n of byStep.values()) expect(n).toBe(2);
    });

    test("random() gives independent numbers per key and a stable number per hit", () => {
      const seen: number[][] = [];
      const probe: HitTransform = (hit, random) => (seen.push([random(), random("other")]), hit);
      const r = rig({ a: "XX.." }, { transform: probe });
      r.run(0, 1);
      r.run(0, 1);
      expect(seen[0]).toEqual(seen[2]);
      expect(seen[1]).toEqual(seen[3]);
      expect(seen[0]![0]).not.toBe(seen[0]![1]);
      expect(seen[0]![0]).not.toBe(seen[1]![0]);
    });

    test("chance 0.5 plays about half the steps", () => {
      const n = 64;
      const r = rig({ a: full(n) }, {}, { a: everyStep(n) });
      for (const step of r.sequencer.lanes.a!.steps) step.repeat = 1;
      r.run(0, n * 0.25 * 16);
      const total = n * 16;
      expect(r.hits.length).toBeGreaterThan(total * 0.4);
      expect(r.hits.length).toBeLessThan(total * 0.6);
    });
  });
});

describe("attached", () => {
  test("an edit refreshes once per commit, never on attach, and a refresh that schedules does not loop", () => {
    const { sequencer, run } = rig({ k: "X..." });
    let refreshes = 0;
    const cleanup = sequencer.attached({
      refresh: () => {
        refreshes++;
        run(0, 1); // a re-queue publishes positions but edits nothing
      },
      detach() {},
    });
    expect(refreshes).toBe(0);
    sequencer.lanes.k!.steps[1]!.velocity = 1;
    expect(refreshes).toBe(1);
    sequencer.lanes.k!.steps[1]!.velocity = 1; // no change
    expect(refreshes).toBe(1);
    cleanup();
    sequencer.lanes.k!.steps[2]!.velocity = 1;
    expect(refreshes).toBe(1);
  });

  test("attaching inside an effect does not subscribe it", () => {
    const { sequencer } = rig({ k: "X..." });
    let runs = 0;
    const stop = effect(() => {
      runs++;
      sequencer.attached({ refresh() {}, detach() {} });
    });
    sequencer.lanes.k!.steps[1]!.velocity = 1;
    sequencer.lanes.k!.rate = "8n";
    expect(runs).toBe(1);
    stop();
    sequencer.dispose();
  });
});
