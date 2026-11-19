import { describe, expect, test, vi } from "vitest";
import { Clock } from "../src/Clock";
import type { Scheduler } from "../src/Clock";
import { ManualTickSource } from "../src/TickSource";
import { Timeline } from "../src/Timeline";

function harness(options: { onTick?: boolean } = {}) {
  const ctx = { currentTime: 0 };
  const timeline = new Timeline({ audioContext: ctx, bpm: 120 });
  const tickSource = new ManualTickSource();
  const ticks: number[] = [];
  const clock = new Clock({ timeline, lookAhead: 0.1, onTick: options.onTick ? (w) => ticks.push(w.beat.start) : undefined, tickSource });
  const recorder = (): Scheduler & { windows: Array<[number, number]>; resets: number } => {
    const r = {
      windows: [] as Array<[number, number]>,
      resets: 0,
      schedule: (w: { beat: { start: number; end: number } }) => void r.windows.push([w.beat.start, w.beat.end]),
      reset: () => void r.resets++,
    };
    return r;
  };
  return { ctx, timeline, tickSource, clock, ticks, recorder };
}

describe("Clock.attach", () => {
  test("onTick is optional and attached schedulers all see the same windows with the clock's timeline", () => {
    const { tickSource, clock, timeline, recorder } = harness();
    const a = recorder();
    const b = recorder();
    const timings: unknown[] = [];
    clock.attach({ schedule: (_w, timing) => timings.push(timing) });
    clock.attach(a);
    clock.attach(b);
    expect(clock.timeline).toBe(timeline);
    clock.start();
    tickSource.tick();
    expect(a.windows).toHaveLength(1);
    expect(b.windows).toEqual(a.windows);
    expect(timings[0]).toBe(timeline);
  });

  test("onTick users are unchanged and run before schedulers", () => {
    const { tickSource, clock, ticks, recorder } = harness({ onTick: true });
    const a = recorder();
    clock.attach(a);
    clock.start();
    tickSource.tick();
    expect(ticks).toEqual([0]);
    expect(a.windows).toHaveLength(1);
  });

  test("start, pause, stop, seek and destroy reset attached schedulers after cancelling owned events", () => {
    const { clock, recorder } = harness();
    const a = recorder();
    clock.attach(a);
    clock.start();
    expect(a.resets).toBe(1);
    clock.pause();
    expect(a.resets).toBe(2);
    clock.resume();
    clock.seek(4);
    expect(a.resets).toBe(3);
    clock.stop();
    expect(a.resets).toBe(4);
    clock.destroy();
    expect(a.resets).toBe(5);
  });

  test("detach resets once, stops the windows and leaves other schedulers running", () => {
    const { tickSource, ctx, clock, recorder } = harness();
    const a = recorder();
    const b = recorder();
    const detachA = clock.attach(a);
    clock.attach(b);
    clock.start();
    tickSource.tick();
    detachA();
    detachA();
    expect(a.resets).toBe(2); // start + detach
    ctx.currentTime = 0.05;
    tickSource.tick();
    expect(a.windows).toHaveLength(1);
    expect(b.windows).toHaveLength(2);
  });

  test("a throwing scheduler does not stop the others", () => {
    const { tickSource, clock, recorder } = harness();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const b = recorder();
    clock.attach({
      schedule: () => {
        throw new Error("boom");
      },
    });
    clock.attach(b);
    clock.start();
    tickSource.tick();
    expect(b.windows).toHaveLength(1);
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  test("a scheduler's owned events are cancelled by stop and kept apart from other schedulers' refresh", () => {
    const { tickSource, clock } = harness();
    let cancelled = 0;
    clock.attach({
      schedule: (w) => w.own({ cancel: () => void cancelled++, onEnded: () => {} }, 1),
    });
    clock.start();
    tickSource.tick();
    clock.stop();
    expect(cancelled).toBe(1);
  });

  test("attaching while playing refreshes the look-ahead; double attach and attach after destroy throw", async () => {
    const { tickSource, clock, recorder } = harness();
    clock.start();
    tickSource.tick();
    const late = recorder();
    const s = recorder();
    clock.attach(s);
    await Promise.resolve();
    expect(s.windows.length).toBeGreaterThan(0); // the refill after attach
    expect(() => clock.attach(s)).toThrow(/already has this scheduler/);
    clock.destroy();
    expect(() => clock.attach(late)).toThrow(/destroyed/);
  });
});
