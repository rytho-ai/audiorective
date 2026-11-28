import { afterEach, expect, test } from "vitest";
import { StepSequencer } from "../src/StepSequencer";
import { Clock, ManualTickSource } from "@audiorective/clock";

const machines: StepSequencer[] = [];
afterEach(() => {
  for (const seq of machines.splice(0)) seq.dispose();
});
function create(...args: ConstructorParameters<typeof StepSequencer>) {
  const seq = new StepSequencer(...args);
  machines.push(seq);
  return seq;
}

const notationCases: Array<{ label: string; lane: unknown; name: string }> = [
  { label: "pattern character", lane: { pattern: "?" }, name: "RangeError" },
  { label: "velocity type", lane: { pattern: ["loud"] }, name: "TypeError" },
  { label: "velocity range", lane: { pattern: [2] }, name: "RangeError" },
  { label: "pattern shape", lane: { pattern: null }, name: "TypeError" },
  { label: "empty pattern", lane: { pattern: [] }, name: "RangeError" },
  { label: "nonfinite time", lane: { pattern: "X", rate: NaN }, name: "RangeError" },
  { label: "time type", lane: { pattern: "X", rate: true }, name: "TypeError" },
  { label: "time notation", lane: { pattern: "X", rate: "nonsense" }, name: "TypeError" },
  { label: "zero note denominator", lane: { pattern: "X", rate: "0n" }, name: "RangeError" },
  { label: "swing notation", lane: { pattern: "X", swing: "oops" }, name: "TypeError" },
  { label: "swing range", lane: { pattern: "X", swing: 1.5 }, name: "RangeError" },
];

test.each(notationCases)("notation error class: $label", ({ lane, name }) => {
  expect(() => new StepSequencer({ a: lane as never })).toThrowError(expect.objectContaining({ name }));
});

const configurationCases: Array<{ label: string; lanes: unknown; options?: unknown; name: string }> = [
  { label: "lane record", lanes: [], name: "TypeError" },
  { label: "options object", lanes: { a: "X" }, options: () => {}, name: "TypeError" },
  { label: "global callback", lanes: { a: "X" }, options: { onHit: 1 }, name: "TypeError" },
  { label: "missing pattern", lanes: { a: {} }, name: "TypeError" },
  { label: "lane callback", lanes: { a: { pattern: "X", onHit: 1 } }, name: "TypeError" },
  { label: "sound context option", lanes: { a: { pattern: "X", sound: "C4" } }, name: "TypeError" },
  { label: "rate range", lanes: { a: { pattern: "X", rate: "1024n" } }, name: "RangeError" },
  { label: "params object", lanes: { a: { pattern: "X", params: null } }, name: "TypeError" },
  { label: "reserved param ID", lanes: { a: { pattern: "X", params: { velocity: { min: 0, max: 1, default: 0 } } } }, name: "TypeError" },
  { label: "param range shape", lanes: { a: { pattern: "X", params: { cutoff: null } } }, name: "TypeError" },
  { label: "param scalar type", lanes: { a: { pattern: "X", params: { cutoff: { min: "low", max: 1, default: 0 } } } }, name: "TypeError" },
  { label: "param scalar range", lanes: { a: { pattern: "X", params: { cutoff: { min: 2, max: 1, default: 0 } } } }, name: "RangeError" },
  { label: "param step type", lanes: { a: { pattern: "X", params: { cutoff: { min: 0, max: 1, default: 0, step: true } } } }, name: "TypeError" },
  { label: "param step range", lanes: { a: { pattern: "X", params: { cutoff: { min: 0, max: 1, default: 0, step: 0 } } } }, name: "RangeError" },
];
test.each(configurationCases)("configuration error class: $label", ({ lanes, options, name }) => {
  expect(() => create(lanes as never, options as never)).toThrowError(expect.objectContaining({ name }));
});

const writeCases: Array<{ label: string; write(seq: StepSequencer): unknown; name: string }> = [
  {
    label: "step type",
    write: (seq) => {
      seq.lanes.a.steps[0].velocity = "loud" as never;
    },
    name: "TypeError",
  },
  {
    label: "step range",
    write: (seq) => {
      seq.lanes.a.steps[0].velocity = 2;
    },
    name: "RangeError",
  },
  {
    label: "length type",
    write: (seq) => {
      seq.lanes.a.length = "many" as never;
    },
    name: "TypeError",
  },
  {
    label: "length range",
    write: (seq) => {
      seq.lanes.a.length = 0;
    },
    name: "RangeError",
  },
  {
    label: "direction type",
    write: (seq) => {
      seq.lanes.a.direction = 1 as never;
    },
    name: "TypeError",
  },
  {
    label: "direction value",
    write: (seq) => {
      seq.lanes.a.direction = "up" as never;
    },
    name: "RangeError",
  },
  {
    label: "muted type",
    write: (seq) => {
      seq.lanes.a.muted = 1 as never;
    },
    name: "TypeError",
  },
  {
    label: "solo type",
    write: (seq) => {
      seq.lanes.a.solo = "yes" as never;
    },
    name: "TypeError",
  },
  { label: "unknown lane", write: (seq) => seq.lane("missing"), name: "RangeError" },
  { label: "headless output", write: (seq) => seq.lanes.a.output, name: "InvalidStateError" },
];
test.each(writeCases)("live write error class: $label", ({ write, name }) => {
  const seq = create({ a: "X" });
  expect(() => write(seq)).toThrowError(expect.objectContaining({ name }));
});

test.each([
  { label: "custom scalar type", value: "bad", name: "TypeError" },
  { label: "custom scalar range", value: 2, name: "RangeError" },
])("custom value write error class: $label", ({ value, name }) => {
  const seq = create({ a: { pattern: "X", params: { cutoff: { min: 0, max: 1, default: 0 } } } });
  expect(() => {
    seq.lanes.a.steps[0].values.cutoff = value as never;
  }).toThrowError(expect.objectContaining({ name }));
});

test("a disposed sequencer cannot attach to a borrowed clock", () => {
  const clock = new Clock({ context: { currentTime: 0 }, tickSource: new ManualTickSource() });
  try {
    const seq = create({ a: "X" });
    seq.dispose();
    expect(() => clock.attach(seq)).toThrowError(expect.objectContaining({ name: "InvalidStateError" }));
  } finally {
    clock.dispose();
  }
});
