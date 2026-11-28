import { afterEach, describe, expect, test, vi } from "vitest";
import { Clock, type Scheduler } from "../src/Clock";
import { ManualTickSource } from "../src/TickSource";
import { Timeline } from "../src/Timeline";

afterEach(() => vi.restoreAllMocks());

function harness() {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const timeline = new Timeline({ audioContext: { currentTime: 0 }, bpm: 120 });
  const tickSource = new ManualTickSource();
  const clock = new Clock({ timeline, lookAhead: 0.1, tickSource });
  const windows: number[] = [];
  const healthy: Scheduler = { schedule: (w) => void windows.push(w.beat.start) };
  return { clock, tickSource, windows, healthy };
}

describe("clock.error", () => {
  test("starts null and holds a scheduler's schedule error while the other schedulers keep their windows", () => {
    const { clock, tickSource, windows, healthy } = harness();
    expect(clock.error.value).toBeNull();
    const boom = new Error("schedule broke");
    clock.attach({
      schedule: () => {
        throw boom;
      },
    });
    clock.attach(healthy);
    const seen: Array<Error | null> = [];
    clock.error.subscribe((error) => seen.push(error));
    clock.start();
    tickSource.tick();
    tickSource.tick();
    expect(clock.error.value).toBe(boom);
    expect(seen[0]).toBe(boom);
    expect(windows.length).toBeGreaterThanOrEqual(1);
    expect(clock.state.value).toBe("playing");
    expect(console.error).toHaveBeenCalledWith("Clock scheduler failed:", boom);
  });

  test("holds reset and transport hook errors, and wraps a thrown non-Error", () => {
    const { clock, tickSource } = harness();
    clock.attach({
      schedule() {},
      reset: () => {
        throw new Error("reset broke");
      },
    });
    clock.start();
    tickSource.tick();
    clock.stop();
    expect(clock.error.value?.message).toBe("reset broke");
    clock.attach({
      schedule() {},
      transport: () => {
        throw "plain string";
      },
    });
    clock.start();
    tickSource.tick();
    clock.bpm.value = 100;
    expect(clock.error.value?.message).toBe("Clock scheduler failed.");
    expect(clock.error.value?.cause).toBe("plain string");
  });
});
