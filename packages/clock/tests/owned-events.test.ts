import { expect, test, vi } from "vitest";
import { Clock, type CancellableEvent } from "../src/Clock";
import { ManualTickSource } from "../src/TickSource";
import { Timeline } from "../src/Timeline";

/** `refresh()` refills in a microtask; let it run. */
const flushRefill = () => new Promise<void>((resolve) => queueMicrotask(resolve));

function event() {
  const listeners: Array<() => void> = [];
  const cancel = vi.fn(() => listeners.splice(0).forEach((listener) => listener()));
  const value: CancellableEvent = {
    cancel,
    onEnded(listener) {
      listeners.push(listener);
    },
  };
  return { value, cancel, end: () => listeners.splice(0).forEach((listener) => listener()) };
}

test("owned events cancel on pause, seek, stop, restart and destroy; unowned events keep the old tail", () => {
  let now = 0;
  const timeline = new Timeline({
    audioContext: {
      get currentTime() {
        return now;
      },
    },
    bpm: 120,
  });
  const ticks = new ManualTickSource();
  const owned: ReturnType<typeof event>[] = [];
  const unowned: ReturnType<typeof event>[] = [];
  const clock = new Clock({
    timeline,
    tickSource: ticks,
    onTick(window) {
      const mine = event(),
        other = event();
      window.own(mine.value, now + 0.05);
      owned.push(mine);
      unowned.push(other);
    },
  });
  clock.start();
  ticks.tick();
  clock.pause();
  expect(owned[0]!.cancel).toHaveBeenCalledTimes(1);
  expect(unowned[0]!.cancel).not.toHaveBeenCalled();
  clock.resume();
  now = 0.01;
  ticks.tick();
  clock.seek(0);
  expect(owned[1]!.cancel).toHaveBeenCalledTimes(1);
  ticks.tick();
  clock.stop();
  expect(owned[2]!.cancel).toHaveBeenCalledTimes(1);
  clock.start();
  ticks.tick();
  clock.start();
  expect(owned[3]!.cancel).toHaveBeenCalledTimes(1);
  ticks.tick();
  clock.destroy();
  expect(owned[4]!.cancel).toHaveBeenCalledTimes(1);
  expect(unowned.every((item) => item.cancel.mock.calls.length === 0)).toBe(true);
});

test("refresh cancels and refills the present horizon without moving transport position", async () => {
  let now = 0;
  const timeline = new Timeline({
    audioContext: {
      get currentTime() {
        return now;
      },
    },
    bpm: 120,
  });
  const ticks = new ManualTickSource();
  const owned: ReturnType<typeof event>[] = [];
  const clock = new Clock({
    timeline,
    tickSource: ticks,
    onTick(window) {
      const hit = event();
      owned.push(hit);
      window.own(hit.value, now + 0.05);
    },
  });
  clock.start();
  ticks.tick();
  now = 0.02;
  const beforeBeat = timeline.timeToBeat(now);
  const beforeSeconds = timeline.position;
  clock.refresh();
  expect(owned[0]!.cancel).toHaveBeenCalledTimes(1); // retraction is synchronous
  expect(owned).toHaveLength(1);
  await flushRefill();
  expect(owned).toHaveLength(2); // refilled right after, no worker wait
  expect(timeline.timeToBeat(now)).toBeCloseTo(beforeBeat, 9);
  expect(timeline.position).toBeCloseTo(beforeSeconds, 9);
  ticks.tick();
  expect(owned).toHaveLength(2); // no duplicate window
  now = 0.08; // the second event has begun; a later edit keeps it sounding
  clock.refresh();
  await flushRefill();
  expect(owned).toHaveLength(3);
  expect(owned[1]!.cancel).not.toHaveBeenCalled();
  owned[1]!.end();
  clock.stop();
  expect(owned[1]!.cancel).not.toHaveBeenCalled();
  expect(owned[2]!.cancel).toHaveBeenCalledTimes(1);
  clock.destroy();
});

test("refresh gives a hit exactly at now to the refill instead of keeping both copies", async () => {
  const timeline = new Timeline({ audioContext: { currentTime: 0 }, bpm: 120 });
  const ticks = new ManualTickSource();
  const hits: ReturnType<typeof event>[] = [];
  const clock = new Clock({
    timeline,
    tickSource: ticks,
    onTick(window) {
      const hit = event();
      hits.push(hit);
      window.own(hit.value, window.time.current);
    },
  });
  clock.start();
  ticks.tick();
  clock.refresh();
  await flushRefill();
  expect(hits).toHaveLength(2);
  expect(hits[0]!.cancel).toHaveBeenCalledTimes(1);
  expect(hits[1]!.cancel).not.toHaveBeenCalled();
  clock.destroy();
});

test("refresh uses one captured boundary even if cancellation advances the audio clock", async () => {
  let now = 0;
  const timeline = new Timeline({
    audioContext: {
      get currentTime() {
        return now;
      },
    },
    bpm: 120,
  });
  const ticks = new ManualTickSource();
  const first = event();
  first.value.cancel = () => {
    first.cancel();
    now = 0.02;
  };
  const starts: number[] = [];
  const clock = new Clock({
    timeline,
    tickSource: ticks,
    onTick(window) {
      starts.push(window.beat.start);
      if (starts.length === 1) window.own(first.value, 0.01);
    },
  });
  clock.start();
  ticks.tick();
  clock.refresh();
  expect(first.cancel).toHaveBeenCalledTimes(1);
  await flushRefill();
  expect(starts[1]).toBe(0); // the cancelled interval remains in the refill window
  expect(timeline.position).toBeCloseTo(0.02, 9);
  clock.destroy();
});

test("a late registration from an invalidated window is cancelled instead of escaping ownership", () => {
  const timeline = new Timeline({ audioContext: { currentTime: 0 } });
  const ticks = new ManualTickSource();
  const stale = event();
  const clock = new Clock({
    timeline,
    tickSource: ticks,
    onTick(window) {
      clock.pause();
      window.own(stale.value, 0.05);
    },
  });
  clock.start();
  ticks.tick();
  expect(stale.cancel).toHaveBeenCalledTimes(1);
  clock.destroy();
});

test("an end listener cannot register a replacement while Clock cancels its owned events", () => {
  const timeline = new Timeline({ audioContext: { currentTime: 0 } });
  const ticks = new ManualTickSource();
  const first = event();
  const replacement = event();
  const clock = new Clock({
    timeline,
    tickSource: ticks,
    onTick(window) {
      first.value.onEnded(() => window.own(replacement.value, 0.08));
      window.own(first.value, 0.05);
    },
  });
  clock.start();
  ticks.tick();
  clock.pause();
  expect(first.cancel).toHaveBeenCalledTimes(1);
  expect(replacement.cancel).toHaveBeenCalledTimes(1);
  clock.destroy();
});

test("refresh called during onTick does not re-enter it; the refill runs once after the callback returns", async () => {
  const timeline = new Timeline({ audioContext: { currentTime: 0 } });
  const ticks = new ManualTickSource();
  let windows = 0;
  let inside = false;
  let reentered = false;
  const clock = new Clock({
    timeline,
    tickSource: ticks,
    onTick() {
      if (inside) reentered = true;
      inside = true;
      windows++;
      if (windows === 1) clock.refresh();
      inside = false;
    },
  });
  clock.start();
  ticks.tick();
  expect(windows).toBe(1); // not refilled synchronously
  await flushRefill();
  expect(windows).toBe(2);
  expect(reentered).toBe(false);
  ticks.tick();
  expect(windows).toBe(2);
  clock.destroy();
});

test("refresh from a plain synchronous caller does not run onTick before it returns", async () => {
  const timeline = new Timeline({ audioContext: { currentTime: 0 } });
  const ticks = new ManualTickSource();
  let windows = 0;
  const clock = new Clock({ timeline, tickSource: ticks, onTick: () => void windows++ });
  clock.start();
  ticks.tick();
  clock.refresh();
  expect(windows).toBe(1);
  await flushRefill();
  expect(windows).toBe(2);
  clock.destroy();
});

test("N refreshes in one task coalesce into one refill; retraction is still immediate", async () => {
  let now = 0;
  const timeline = new Timeline({
    audioContext: {
      get currentTime() {
        return now;
      },
    },
    bpm: 120,
  });
  const ticks = new ManualTickSource();
  const hits: ReturnType<typeof event>[] = [];
  const starts: number[] = [];
  const clock = new Clock({
    timeline,
    tickSource: ticks,
    onTick(window) {
      starts.push(window.beat.start);
      const hit = event();
      hits.push(hit);
      window.own(hit.value, now + 0.05);
    },
  });
  clock.start();
  ticks.tick();
  now = 0.01;
  clock.refresh();
  expect(hits[0]!.cancel).toHaveBeenCalledTimes(1); // retracted before any refill
  now = 0.02; // the audio clock moves between calls in the same task
  clock.refresh();
  clock.refresh();
  expect(hits).toHaveLength(1);
  await flushRefill();
  expect(hits).toHaveLength(2); // one refill, not three
  expect(starts[1]).toBeCloseTo(0.02, 9); // from the first boundary (0.01 s = 0.02 beats): no beat skipped
  expect(hits[0]!.cancel).toHaveBeenCalledTimes(1);
  expect(hits[1]!.cancel).not.toHaveBeenCalled();
  await flushRefill();
  expect(hits).toHaveLength(2);
  clock.destroy();
});

test("stop, pause, seek, start or destroy before the microtask: no refill from the stale refresh", async () => {
  for (const act of ["stop", "pause", "destroy"] as const) {
    const timeline = new Timeline({ audioContext: { currentTime: 0 } });
    const ticks = new ManualTickSource();
    let windows = 0;
    const clock = new Clock({ timeline, tickSource: ticks, onTick: () => void windows++ });
    clock.start();
    ticks.tick();
    clock.refresh();
    clock[act]();
    await flushRefill();
    expect(windows, act).toBe(1);
    clock.destroy();
  }
});

test("a seek between refresh and its microtask wins: the refill starts at the seek target or not at all", async () => {
  const timeline = new Timeline({ audioContext: { currentTime: 0 } });
  const ticks = new ManualTickSource();
  const starts: number[] = [];
  const clock = new Clock({ timeline, tickSource: ticks, onTick: (window) => void starts.push(window.beat.start) });
  clock.start();
  ticks.tick();
  clock.refresh();
  clock.seek(32);
  await flushRefill();
  expect(starts).toEqual([0]); // the stale refill never ran
  ticks.tick();
  expect(starts[1]).toBe(32); // the regular tick starts exactly at the seek target
  clock.destroy();
});

test("a tick that runs before the microtask performs the refill; the microtask does nothing more", async () => {
  const timeline = new Timeline({ audioContext: { currentTime: 0 } });
  const ticks = new ManualTickSource();
  let windows = 0;
  const clock = new Clock({ timeline, tickSource: ticks, onTick: () => void windows++ });
  clock.start();
  ticks.tick();
  clock.refresh();
  ticks.tick();
  expect(windows).toBe(2);
  await flushRefill();
  expect(windows).toBe(2);
  clock.destroy();
});

test("restart then refresh before the old microtask runs refills once", async () => {
  const timeline = new Timeline({ audioContext: { currentTime: 0 } });
  const ticks = new ManualTickSource();
  let windows = 0;
  const clock = new Clock({ timeline, tickSource: ticks, onTick: () => void windows++ });
  clock.start();
  clock.refresh();
  clock.stop();
  clock.start();
  clock.refresh();
  await flushRefill();
  expect(windows).toBe(1);
  clock.destroy();
});

test("invalid owned-event time cancels the event before rejecting registration", () => {
  const timeline = new Timeline({ audioContext: { currentTime: 0 } });
  const ticks = new ManualTickSource();
  const bad = event();
  const clock = new Clock({
    timeline,
    tickSource: ticks,
    onTick(window) {
      expect(() => window.own(bad.value, Number.NaN)).toThrow("Clock owned event time must be finite, non-negative seconds.");
    },
  });
  clock.start();
  ticks.tick();
  expect(bad.cancel).toHaveBeenCalledTimes(1);
  clock.destroy();
});
