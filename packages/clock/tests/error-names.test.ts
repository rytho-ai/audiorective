import { expect, test } from "vitest";
import { Clock } from "../src/Clock";
import { Timeline } from "../src/Timeline";
import { ManualTickSource } from "../src/TickSource";

test.each(["missing source", "two sources", "tempo with timeline"])("Clock configuration uses TypeError: %s", (kind) => {
  const context = { currentTime: 0 };
  const timeline = new Timeline({ audioContext: context, bpm: 120 });
  try {
    const options = kind === "missing source" ? {} : kind === "two sources" ? { context, timeline } : { timeline, bpm: 120 };
    expect(() => new Clock(options as never)).toThrowError(expect.objectContaining({ name: "TypeError" }));
  } finally {
    timeline.bpm.dispose();
  }
});

test("duplicate and disposed Clock attachments use InvalidStateError", () => {
  const clock = new Clock({ context: { currentTime: 0 }, tickSource: new ManualTickSource() });
  const scheduler = { schedule() {} };
  try {
    clock.attach(scheduler);
    expect(() => clock.attach(scheduler)).toThrowError(expect.objectContaining({ name: "InvalidStateError" }));
    clock.dispose();
    expect(() => clock.attach({ schedule() {} })).toThrowError(expect.objectContaining({ name: "InvalidStateError" }));
  } finally {
    clock.dispose();
  }
});
