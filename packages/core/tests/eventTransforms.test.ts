import { describe, expect, test } from "vitest";
import {
  applyEventTransforms,
  hash01,
  type EventTransformInput,
  type BeatEvent,
  type BeatTiming,
  type EventTransform,
  type EventTransformContext,
  type SecondsOf,
  type TimedBeatEvent,
} from "../src";

/** 120 bpm from time 0: a beat is 0.5 s. */
const timing: BeatTiming = { beatToTime: (b) => b * 0.5, timeToBeat: (t) => t * 2 };
const context: EventTransformInput = { now: 2.5, timing, random: () => 0.5 };
const hit = (beat: number, extra: Partial<TimedBeatEvent> = {}): TimedBeatEvent => ({ beat, durationBeats: 1, velocity: 1, ...extra });
const make = (
  id: string,
  apply: (events: readonly TimedBeatEvent[], context: EventTransformContext) => readonly TimedBeatEvent[],
): EventTransform<TimedBeatEvent> => ({
  id,
  apply,
});
const makeSeconds = (
  id: string,
  apply: (events: readonly SecondsOf<TimedBeatEvent>[], context: EventTransformContext) => readonly SecondsOf<TimedBeatEvent>[],
): EventTransform<TimedBeatEvent> => ({ id, unit: "second", apply });

describe("applyEventTransforms", () => {
  test("empty list converts to seconds and clamps", () => {
    expect(applyEventTransforms([hit(1), hit(7)], [], context).map((e) => e.when)).toEqual([2.5, 3.5]);
    expect(applyEventTransforms([hit(7, { durationBeats: 2 })], [], context)[0]).toEqual({ when: 3.5, duration: 1, velocity: 1 });
  });
  test("runs in array order", () => {
    const seen: string[] = [];
    const t = (id: string) =>
      make(id, (events) => {
        seen.push(id);
        return events.map((e) => ({ ...e, beat: e.beat + (id === "a" ? 1 : 10) }));
      });
    expect(applyEventTransforms([hit(6)], [t("a"), t("b")], context)[0].when).toBe(8.5);
    expect(seen).toEqual(["a", "b"]);
  });
  test("beat transforms see beats and now in beats; seconds transforms see seconds and now in seconds", () => {
    const seen: unknown[] = [];
    const spy = (e: readonly object[], c: EventTransformContext) => (seen.push([e, c.now]), e);
    applyEventTransforms(
      [hit(4, { durationBeats: 2 })],
      [make("b", spy as never), makeSeconds("s", spy as never), make("b2", spy as never)],
      context,
    );
    expect(seen).toEqual([
      [[{ beat: 4, durationBeats: 2, velocity: 1 }], 5],
      [[{ when: 2, duration: 1, velocity: 1 }], 2.5],
      [[{ beat: 4, durationBeats: 2, velocity: 1 }], 5],
    ]);
  });
  test("a seconds transform's result is read back in beats", () => {
    const late = makeSeconds("late", (events) => events.map((e) => ({ ...e, when: e.when + 0.5, duration: e.duration * 2 })));
    const seen: BeatEvent[] = [];
    const peek = make("peek", (events) => (seen.push(...events), events));
    applyEventTransforms([hit(4)], [late, peek], context);
    expect(seen).toEqual([{ beat: 5, durationBeats: 2, velocity: 1 }]);
  });
  test("clamps to now after the last transform, in either unit", () => {
    const back = make("back", (events) => events.map((e) => ({ ...e, beat: e.beat - 100 })));
    expect(applyEventTransforms([hit(6)], [back], context).map((e) => e.when)).toEqual([2.5]);
    const zero = makeSeconds("zero", (events) => events.map((e) => ({ ...e, when: 0 })));
    expect(applyEventTransforms([hit(6)], [zero], context).map((e) => e.when)).toEqual([2.5]);
  });
  test("names the transform on invalid output", () => {
    const bad = (patch: object) => () => applyEventTransforms([hit(6)], [make("x", (e) => e.map((v) => ({ ...v, ...patch })))], context);
    expect(bad({ beat: NaN })).toThrow('Event transform "x" returned an event without a finite "beat".');
    expect(bad({ durationBeats: 0 })).toThrow('Event transform "x" returned an event whose "durationBeats" is not a finite number above 0.');
    expect(bad({ durationBeats: Infinity })).toThrow(/"x".*"durationBeats"/);
    expect(bad({ velocity: 1.5 })).toThrow(/"x".*"velocity"/);
    expect(bad({ velocity: NaN })).toThrow(/"x".*"velocity"/);
    const badSeconds = (patch: object) => () =>
      applyEventTransforms([hit(6)], [makeSeconds("s", (e) => e.map((v) => ({ ...v, ...patch })))], context);
    expect(badSeconds({ when: NaN })).toThrow('Event transform "s" returned an event without a finite "when".');
    expect(badSeconds({ duration: 0 })).toThrow('Event transform "s" returned an event whose "duration" is not a finite number above 0.');
    expect(() => applyEventTransforms([hit(6)], [make("y", () => null as never)], context)).toThrow('Event transform "y" must return an array');
    expect(() => applyEventTransforms([hit(6)], [{ id: "u", unit: "ms" as never, apply: (e) => e }], context)).toThrow(
      'Event transform "u" has a unit other than "beat" or "second".',
    );
  });
  test("velocity 0 drops, and plain beat events need only a beat", () => {
    expect(applyEventTransforms([hit(6)], [make("x", (e) => e.map((v) => ({ ...v, velocity: 0 })))], context)).toEqual([]);
    const plain = { id: "p", apply: (events: readonly BeatEvent[]) => events };
    expect(applyEventTransforms([{ beat: 1 }], [plain], context)).toEqual([{ when: 2.5 }]);
    expect(() => applyEventTransforms([{ beat: 1 }], [{ id: "q", apply: () => [{ beat: Infinity }] }], context)).toThrow(/"q"/);
  });
});

describe("stable randomness", () => {
  test("randomFor is pure in seed, event identity and key", () => {
    const seen: number[] = [];
    const t = make("r", (events, { randomFor }) => (seen.push(...events.map((e) => randomFor(e)), randomFor(events[0], "k")), events));
    const events = [hit(1), hit(2)];
    applyEventTransforms(events, [t], { ...context, seed: 5 });
    applyEventTransforms([...events].reverse().reverse(), [t], { ...context, seed: 5 });
    expect(seen.slice(0, 3)).toEqual(seen.slice(3));
    expect(new Set(seen.slice(0, 3)).size).toBe(3);
    applyEventTransforms(events, [t], { ...context, seed: 6 });
    expect(seen.slice(6, 9)).not.toEqual(seen.slice(0, 3));
  });

  test("keyOf supplies identity and survives a copying transform", () => {
    const keyOf = (e: TimedBeatEvent & { id?: string }) => e.id ?? "";
    let draw = 0;
    const read = make("read", (events, { randomFor }) => ((draw = randomFor(events[0])), events));
    const move = make("move", (events) => events.map((e) => ({ ...e, beat: e.beat + 1 })));
    applyEventTransforms([{ ...hit(1), id: "x" }], [read], { ...context, keyOf });
    const first = draw;
    applyEventTransforms([{ ...hit(9), id: "x" }], [move, read], { ...context, keyOf });
    expect(draw).toBe(first);
  });
});

describe("hash01", () => {
  test("is deterministic, in [0, 1), order- and type-sensitive", () => {
    expect(hash01(1, "a", 2.5)).toBe(hash01(1, "a", 2.5));
    expect(hash01(1, 2)).not.toBe(hash01(2, 1));
    expect(hash01(1)).not.toBe(hash01("1"));
    for (let i = 0; i < 1000; i++) {
      const v = hash01(i, "x");
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  test("is roughly uniform over consecutive integers", () => {
    const buckets = new Array(10).fill(0);
    for (let i = 0; i < 10000; i++) buckets[Math.floor(hash01(0, i) * 10)]++;
    for (const n of buckets) {
      expect(n).toBeGreaterThan(850);
      expect(n).toBeLessThan(1150);
    }
  });
});
