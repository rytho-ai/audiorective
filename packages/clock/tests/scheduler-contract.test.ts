import { describe, expect, test } from "vitest";
import { Clock } from "../src/Clock";
import type { ResetReason, Scheduler, SchedulerHandle, TransportChange } from "../src/Clock";
import { ManualTickSource } from "../src/TickSource";
import { Timeline } from "../src/Timeline";

function harness() {
  const ctx = { currentTime: 0 };
  const timeline = new Timeline({ audioContext: ctx, bpm: 120 });
  const tickSource = new ManualTickSource();
  const clock = new Clock({ timeline, lookAhead: 0.1, tickSource });
  return { ctx, timeline, tickSource, clock };
}

function recorder(log: string[] = [], name = "s") {
  const r = {
    resets: [] as ResetReason[],
    changes: [] as TransportChange[],
    windows: [] as Array<{ start: number; end: number; current: number }>,
    handle: undefined as SchedulerHandle | undefined,
    log,
    schedule: (w: { beat: { start: number; end: number }; time: { current: number } }) =>
      void r.windows.push({ start: w.beat.start, end: w.beat.end, current: w.time.current }),
    reset: (reason: ResetReason) => {
      r.resets.push(reason);
      log.push(`${name}:reset:${reason}`);
    },
    transport: (change: TransportChange) => {
      r.changes.push(change);
      log.push(`${name}:transport:${change.type}`);
    },
    attached: (handle: SchedulerHandle) => void (r.handle = handle),
  };
  return r satisfies Scheduler & Record<string, unknown>;
}

describe("reset reasons", () => {
  test("each transport call passes its reason; resume sends none", () => {
    const { clock } = harness();
    const s = recorder();
    clock.attach(s);
    clock.start();
    clock.pause();
    clock.resume();
    clock.seek(3);
    clock.stop();
    expect(s.resets).toEqual(["start", "pause", "seek", "stop"]);
  });

  test("detach and destroy reset with 'detach'", () => {
    const { clock } = harness();
    const a = recorder();
    const b = recorder();
    const detach = clock.attach(a);
    clock.attach(b);
    detach();
    detach();
    expect(a.resets).toEqual(["detach"]);
    clock.destroy();
    expect(b.resets).toEqual(["detach"]);
    expect(a.resets).toEqual(["detach"]);
  });

  test("reset runs before the state changes and the transport hook after", () => {
    const { clock } = harness();
    const states: string[] = [];
    const s = {
      schedule() {},
      reset: () => void states.push(`reset:${clock.state.value}`),
      transport: (c: TransportChange) => void states.push(`${c.type}:${clock.state.value}`),
    };
    clock.attach(s);
    clock.start();
    clock.pause();
    clock.resume();
    clock.stop();
    expect(states).toEqual(["reset:stopped", "start:playing", "reset:playing", "pause:paused", "resume:playing", "reset:playing", "stop:stopped"]);
  });
});

describe("attached handle", () => {
  test("carries timeline, state and meter synchronously inside attach", () => {
    const { clock, timeline } = harness();
    let seen: { beat: number; state: string; meter: readonly [number, number] } | undefined;
    clock.attach({
      schedule() {},
      attached(handle) {
        seen = { beat: handle.timeline.timeToBeat(1), state: handle.state.value, meter: handle.meter.value };
        expect(handle.timeline).toBe(timeline);
        expect(handle.state).toBe(clock.state);
      },
    });
    expect(seen).toEqual({ beat: 0, state: "stopped", meter: [4, 4] });
  });

  test("beat/time conversions are usable at once while playing", () => {
    const { clock, ctx } = harness();
    clock.start();
    ctx.currentTime = 1;
    let beat = NaN;
    clock.attach({ schedule() {}, attached: (h) => void (beat = h.timeline.timeToBeat(ctx.currentTime)) });
    expect(beat).toBeCloseTo(2);
  });
});

describe("meter", () => {
  test("defaults to 4/4, takes an option and changes through the cell", () => {
    const { clock, timeline, tickSource } = harness();
    expect(clock.meter.value).toEqual([4, 4]);
    const s = recorder();
    clock.attach(s);
    clock.meter.value = [3, 4];
    expect(s.handle!.meter.value).toEqual([3, 4]);
    expect(new Clock({ timeline, meter: [6, 8], tickSource }).meter.value).toEqual([6, 8]);
  });

  test("rejects a malformed time signature", () => {
    const { timeline, tickSource } = harness();
    expect(() => new Clock({ timeline, meter: [0, 4], tickSource })).toThrow(/Clock meter must be/);
    expect(() => new Clock({ timeline, meter: [4, 2.5], tickSource })).toThrow(/Clock meter must be/);
  });
});

describe("transport changes", () => {
  test("report start, pause, resume, seek and stop in call order with beats", () => {
    const { clock, ctx } = harness();
    const s = recorder();
    clock.attach(s);
    clock.start(undefined, 2);
    ctx.currentTime = 0.5;
    clock.pause();
    ctx.currentTime = 1;
    clock.resume();
    clock.seek(8);
    clock.stop();
    expect(s.changes).toEqual([
      { type: "start", when: 0, beat: 2 },
      { type: "pause", when: 0.5, beat: 3 },
      { type: "resume", when: 1, beat: 3 },
      { type: "seek", when: 1, beat: 8 },
      { type: "stop", when: 1, beat: 0 },
    ]);
  });

  test("a future start reports its time; no-ops report nothing", () => {
    const { clock } = harness();
    const s = recorder();
    clock.attach(s);
    clock.stop();
    clock.pause();
    clock.resume();
    expect(s.changes).toEqual([]);
    clock.start(2, 1);
    expect(s.changes).toEqual([{ type: "start", when: 2, beat: 1 }]);
    clock.start();
    clock.resume();
    expect(s.changes.map((c) => c.type)).toEqual(["start", "start"]);
  });

  test("tempo steps and ramps are reported once per edit, not by ticks", () => {
    const { clock, ctx, tickSource } = harness();
    const s = recorder();
    clock.attach(s);
    clock.start();
    ctx.currentTime = 1;
    clock.bpm.value = 90;
    clock.bpm.setValueAtTime(100, 3);
    clock.bpm.linearRampToValueAtTime(140, 6);
    clock.bpm.setTargetAtTime(80, 8, 0.5);
    clock.bpm.cancelScheduledValues(7);
    tickSource.tick();
    expect(s.changes.map((c) => [c.type, c.when])).toEqual([
      ["start", 0],
      ["tempo", 1],
      ["tempo", 3],
      ["tempo", 1],
      ["tempo", 8],
      ["tempo", 7],
    ]);
    expect(s.changes[1]!.beat).toBeCloseTo(2);
  });

  test("a tempo edit through a shared timeline reaches every clock; destroyed clocks stop listening", () => {
    const { timeline, tickSource } = harness();
    const a = new Clock({ timeline, tickSource: new ManualTickSource() });
    const b = new Clock({ timeline, tickSource });
    const sa = recorder();
    const sb = recorder();
    a.attach(sa);
    b.attach(sb);
    timeline.bpm.value = 100;
    b.destroy();
    timeline.bpm.value = 110;
    expect(sa.changes).toHaveLength(2);
    expect(sb.changes).toHaveLength(1);
  });

  test("a throwing hook does not stop other schedulers", () => {
    const { clock } = harness();
    const errors = console.error;
    console.error = () => {};
    try {
      const s = recorder();
      clock.attach({
        schedule() {},
        transport() {
          throw new Error("boom");
        },
      });
      clock.attach(s);
      clock.start();
      expect(s.changes).toHaveLength(1);
    } finally {
      console.error = errors;
    }
  });
});

describe("two schedulers on one clock", () => {
  test("both are reset and notified, in attach order", () => {
    const { clock } = harness();
    const log: string[] = [];
    const a = recorder(log, "a");
    const b = recorder(log, "b");
    clock.attach(a);
    clock.attach(b);
    clock.start();
    clock.seek(4);
    expect(log).toEqual([
      "a:reset:start",
      "b:reset:start",
      "a:transport:start",
      "b:transport:start",
      "a:reset:seek",
      "b:reset:seek",
      "a:transport:seek",
      "b:transport:seek",
    ]);
  });
});

describe("work queued while stopped", () => {
  test("survives start(when, offsetBeats) and the first window starts exactly at when", () => {
    const { clock, ctx, tickSource, timeline } = harness();
    const queued = ["clip-a"];
    const launched: Array<{ clip: string; beat: number; time: number }> = [];
    const windows: Array<{ start: number; end: number }> = [];
    clock.attach({
      reset(reason) {
        if (reason !== "start") queued.length = 0;
      },
      schedule(window, timing) {
        windows.push(window.beat);
        for (const clip of queued.splice(0)) launched.push({ clip, beat: window.beat.start, time: timing.beatToTime(window.beat.start) });
      },
    });
    ctx.currentTime = 1;
    clock.start(1.05, 4);
    ctx.currentTime = 1.05;
    tickSource.tick();
    expect(launched).toEqual([{ clip: "clip-a", beat: 4, time: 1.05 }]);
    expect(timeline.beatToTime(windows[0]!.start)).toBeCloseTo(1.05);
    queued.push("clip-b");
    clock.stop();
    expect(queued).toEqual([]);
  });
});
