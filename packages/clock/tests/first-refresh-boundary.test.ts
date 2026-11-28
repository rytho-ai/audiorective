import { afterEach, expect, test } from "vitest";
import { Clock, type SchedulerWindow } from "../src/Clock";
import { ManualTickSource } from "../src/TickSource";

const clocks: Clock[] = [];
afterEach(() => {
  for (const clock of clocks.splice(0)) clock.dispose();
});
function rig() {
  const context = { currentTime: 0 };
  const ticks = new ManualTickSource();
  const clock = new Clock({ context, bpm: 120, lookAhead: 0.1, tickSource: ticks });
  clocks.push(clock);
  const windows: SchedulerWindow[] = [];
  clock.attach({
    schedule(window) {
      windows.push(window);
    },
  });
  return { context, ticks, clock, windows };
}

test("refresh after start but before its first window keeps beat zero instead of skipping the first cue", async () => {
  const { context, clock, windows } = rig();
  clock.start();
  context.currentTime = 0.015;
  await clock.refresh();
  expect(windows).toHaveLength(1);
  expect(windows[0]!.beat.start).toBe(0);
  expect(windows[0]!.beat.end).toBeCloseTo(0.23, 12);
});

test.each([8, -4])("first refresh retains a nonzero requested start beat %s", async (atBeat) => {
  const { context, clock, windows } = rig();
  clock.start(undefined, atBeat);
  context.currentTime = 0.015;
  await clock.refresh();
  expect(windows[0]!.beat.start).toBe(atBeat);
  expect(clock.timeline.beatToTime(atBeat)).toBe(0);
});

test("refresh after seek retains its requested target despite elapsed audio time", async () => {
  const { context, ticks, clock, windows } = rig();
  clock.start();
  ticks.tick();
  context.currentTime = 0.1;
  clock.seek(32);
  context.currentTime = 0.12;
  await clock.refresh();
  expect(windows).toHaveLength(2);
  expect(windows[1]!.beat.start).toBe(32);
  expect(clock.timeline.beatToTime(32)).toBe(0.1);
});

test("a no-window tick before a future start does not consume its first-window boundary", async () => {
  const { context, ticks, clock, windows } = rig();
  clock.start(1, 5);
  context.currentTime = 0.2;
  ticks.tick();
  context.currentTime = 0.3;
  await clock.refresh();
  expect(windows).toHaveLength(0);
  context.currentTime = 1.015;
  await clock.refresh();
  expect(windows).toHaveLength(1);
  expect(windows[0]!.beat.start).toBe(5);
  expect(clock.timeline.beatToTime(5)).toBe(1);
});

test("ordinary refresh after a dispatched window starts at captured now and never replays past cues", async () => {
  const { context, ticks, clock, windows } = rig();
  let cueHits = 0;
  clock.attach({
    schedule(w) {
      if (w.beat.start <= 0 && w.beat.end > 0) cueHits++;
    },
  });
  clock.start();
  ticks.tick();
  context.currentTime = 0.025;
  await clock.refresh();
  expect(windows[1]!.beat.start).toBeCloseTo(0.05, 12);
  expect(cueHits).toBe(1);
});

test("refresh inside the first scheduler callback is an ordinary refill, not a rewind", async () => {
  const { context, ticks, clock, windows } = rig();
  let cueHits = 0,
    first = true;
  let completion: Promise<void> | undefined;
  clock.attach({
    schedule(w) {
      if (w.beat.start <= 0 && w.beat.end > 0) cueHits++;
      if (first) {
        first = false;
        context.currentTime = 0.02;
        completion = clock.refresh();
      }
    },
  });
  clock.start();
  ticks.tick();
  expect(windows).toHaveLength(1);
  await completion;
  expect(windows).toHaveLength(2);
  expect(windows[1]!.beat.start).toBeCloseTo(0.04, 12);
  expect(cueHits).toBe(1);
  ticks.tick();
  expect(windows).toHaveLength(2);
});

test("seek during an old first window preserves the new seek target before its own first refresh", async () => {
  const { context, ticks, clock, windows } = rig();
  let first = true;
  let completion: Promise<void> | undefined;
  const laterSchedulerStarts: number[] = [];
  clock.attach({
    schedule() {
      if (first) {
        first = false;
        context.currentTime = 0.01;
        clock.seek(16);
        context.currentTime = 0.025;
        completion = clock.refresh();
      }
    },
  });
  clock.attach({
    schedule(w) {
      laterSchedulerStarts.push(w.beat.start);
    },
  });
  clock.start();
  ticks.tick();
  await completion;
  expect(windows.map((w) => w.beat.start)).toEqual([0, 16]);
  expect(laterSchedulerStarts).toEqual([16]);
  expect(clock.timeline.beatToTime(16)).toBe(0.01);
});

test("stop inside the first callback fulfils a cancelled refill and a later start gets its own first boundary", async () => {
  const { context, ticks, clock, windows } = rig();
  let first = true;
  let completion: Promise<void> | undefined;
  clock.attach({
    schedule() {
      if (first) {
        first = false;
        context.currentTime = 0.01;
        completion = clock.refresh();
        clock.stop();
      }
    },
  });
  clock.start();
  ticks.tick();
  await completion;
  expect(clock.state.value).toBe("stopped");
  expect(windows).toHaveLength(1);
  clock.start(undefined, 8);
  context.currentTime = 0.03;
  await clock.refresh();
  expect(windows.map((w) => w.beat.start)).toEqual([0, 8]);
});

test("a callback throwing after receiving its first window cannot cause past cues to replay on refresh", async () => {
  const context = { currentTime: 0 };
  const ticks = new ManualTickSource();
  const starts: number[] = [];
  let first = true,
    cueHits = 0;
  const clock = new Clock({
    context,
    bpm: 120,
    tickSource: ticks,
    onTick(w) {
      starts.push(w.beat.start);
      if (w.beat.start <= 0 && w.beat.end > 0) cueHits++;
      if (first) {
        first = false;
        throw new Error("Consumer callback failed after scheduling");
      }
    },
  });
  clocks.push(clock);
  clock.start();
  expect(() => ticks.tick()).toThrow("Consumer callback failed after scheduling");
  context.currentTime = 0.02;
  await clock.refresh();
  expect(starts[1]).toBeCloseTo(0.04, 12);
  expect(cueHits).toBe(1);
});

test("refresh inside the first onTick also keeps past cues out of its refill", async () => {
  const context = { currentTime: 0 };
  const ticks = new ManualTickSource();
  const starts: number[] = [];
  let completion: Promise<void> | undefined;
  let cueHits = 0;
  const clock = new Clock({
    context,
    bpm: 120,
    tickSource: ticks,
    onTick(w) {
      starts.push(w.beat.start);
      if (w.beat.start <= 0 && w.beat.end > 0) cueHits++;
      if (starts.length === 1) {
        context.currentTime = 0.02;
        completion = clock.refresh();
      }
    },
  });
  clocks.push(clock);
  clock.start();
  ticks.tick();
  await completion;
  expect(starts).toHaveLength(2);
  expect(starts[1]).toBeCloseTo(0.04, 12);
  expect(cueHits).toBe(1);
});
