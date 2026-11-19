import { describe, expect, test } from "vitest";
import { applyEventTransforms, type BeatTiming, type EventTransform, type EventTransformContext, type TimedEvent } from "../src";

const timing: BeatTiming = { beatToTime: (b) => b, timeToBeat: (t) => t };
const context: EventTransformContext = { now: 5, timing, random: () => 0.5 };
const hit = (when: number, extra: Partial<TimedEvent> = {}): TimedEvent => ({ when, duration: 1, velocity: 1, ...extra });
const make = (id: string, apply: EventTransform<TimedEvent>["apply"]): EventTransform<TimedEvent> => ({ id, apply });

describe("applyEventTransforms", () => {
  test("empty list only clamps", () => {
    expect(applyEventTransforms([hit(3), hit(7)], [], context).map((e) => e.when)).toEqual([5, 7]);
  });
  test("runs in array order", () => {
    const seen: string[] = [];
    const t = (id: string) =>
      make(id, (events) => {
        seen.push(id);
        return events.map((e) => ({ ...e, when: e.when + (id === "a" ? 1 : 10) }));
      });
    expect(applyEventTransforms([hit(6)], [t("a"), t("b")], context)[0].when).toBe(17);
    expect(seen).toEqual(["a", "b"]);
  });
  test("names the transform on invalid output", () => {
    const bad = (patch: object) => () => applyEventTransforms([hit(6)], [make("x", (e) => e.map((v) => ({ ...v, ...patch })))], context);
    expect(bad({ when: NaN })).toThrow('Event transform "x" returned an event without a finite "when".');
    expect(bad({ duration: 0 })).toThrow(/"x".*"duration"/);
    expect(bad({ duration: Infinity })).toThrow(/"x".*"duration"/);
    expect(bad({ velocity: 1.5 })).toThrow(/"x".*"velocity"/);
    expect(bad({ velocity: NaN })).toThrow(/"x".*"velocity"/);
    expect(() => applyEventTransforms([hit(6)], [make("y", () => null as never)], context)).toThrow('Event transform "y" must return an array');
  });
  test("velocity 0 drops, and plain scheduled events need only a when", () => {
    expect(applyEventTransforms([hit(6)], [make("x", (e) => e.map((v) => ({ ...v, velocity: 0 })))], context)).toEqual([]);
    const plain = { id: "p", apply: (events: readonly { when: number }[]) => events };
    expect(applyEventTransforms([{ when: 1 }], [plain], context)).toEqual([{ when: 5 }]);
    expect(() => applyEventTransforms([{ when: 1 }], [{ id: "q", apply: () => [{ when: Infinity }] }], context)).toThrow(/"q"/);
  });
});
