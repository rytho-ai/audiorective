import { describe, expect, test, vi } from "vitest";
import { Clock, ManualTickSource, Timeline, renderTimeline } from "@audiorective/clock";
import { HitEvent, StepSequencer, type Hit, type SoundFactory, type SoundHit } from "../src/StepSequencer";

/** 120 bpm: a beat is 0.5 s and a "16n" step 0.125 s. Time advances only when the test says so. */
function harness(lookAhead = 3) {
  const ctx = { currentTime: 0 };
  const timeline = new Timeline({ audioContext: ctx, bpm: 120 });
  const ticks = new ManualTickSource();
  const clock = new Clock({ timeline, lookAhead, tickSource: ticks });
  const advance = (to: number) => {
    ctx.currentTime = to;
    ticks.tick();
  };
  /** Clock.refresh() refills in a microtask. */
  const settle = () => Promise.resolve();
  return { ctx, timeline, ticks, clock, advance, settle };
}

const collect = (seq: StepSequencer) => {
  const hits: Hit[] = [];
  seq.addEventListener("hit", (e) => hits.push(e.hit));
  return hits;
};
const at = (hits: readonly Hit[], lane: string) => hits.filter((h) => h.lane === lane);
const times = (hits: readonly Hit[]) => hits.map((h) => Number(h.when.toFixed(6)));

describe("lane-record form: the six behaviours", () => {
  test("four lanes loop on the transport, beat 0 lands on start(when)", () => {
    const { clock, advance } = harness();
    const seq = new StepSequencer({
      kick: "X...X...X...X...",
      snare: "....X.......X...",
      hat: "x.x.x.x.x.x.x.x.",
      clap: { pattern: "........X.......", rate: "16n" },
    });
    const hits = collect(seq);
    clock.attach(seq);
    clock.start(0.5);
    advance(0);
    // loop length is 16 steps * 0.125 s = 2 s: the kick's beats 0..3 then the second pass at 2.5 s
    expect(times(at(hits, "kick"))).toEqual([0.5, 1, 1.5, 2, 2.5].slice(0, at(hits, "kick").length));
    expect(times(at(hits, "kick")).slice(0, 5)).toEqual([0.5, 1, 1.5, 2, 2.5]);
    expect(at(hits, "kick").map((h) => h.loop)).toEqual([0, 0, 0, 0, 1, 1, 1, 1].slice(0, at(hits, "kick").length));
    expect(times(at(hits, "snare"))).toEqual([1, 2]); // the next pass starts at 3 s, the end of the window
    expect(
      at(hits, "snare")
        .map((h) => h.index)
        .slice(0, 2),
    ).toEqual([4, 12]);
    expect(times(at(hits, "hat")).slice(0, 3)).toEqual([0.5, 0.75, 1]);
    expect(at(hits, "hat")[0]!.velocity).toBeCloseTo(0.8);
    expect(at(hits, "clap")[0]!.when).toBeCloseTo(1.5);
    expect(hits.find((h) => h.lane === "kick")!.index).toBe(0);
    expect(hits.every((h) => h.when >= 0.5)).toBe(true);
  });

  test("per-step velocity and per-lane swing move hits in beats", () => {
    const { clock, advance } = harness();
    const seq = new StepSequencer({ a: { pattern: "X1X5", swing: "50%" }, b: { pattern: [1, 0, 0.25, 0], swing: 0 } });
    const hits = collect(seq);
    clock.attach(seq);
    clock.start(0);
    advance(0);
    const a = at(hits, "a").slice(0, 4);
    expect(a.map((h) => h.velocity)).toEqual([1, 0.1, 1, 0.5]);
    // 16n = 0.25 beat; swing 50% delays odd steps by 0.5 * 0.5 * 0.25 = 0.0625 beat = 0.03125 s
    expect(a.map((h) => (h.when / 0.5) * 4)).toEqual([0, 1 + 0.25, 2, 3 + 0.25].map((x) => expect.closeTo(x, 5)));
    expect(
      at(hits, "b")
        .slice(0, 2)
        .map((h) => [h.index, h.velocity]),
    ).toEqual([
      [0, 1],
      [2, 0.25],
    ]);
  });

  test("per-step values reach the hit; an onHit automation lands at hit.when and is undone on re-queue", async () => {
    const { ctx, clock, advance, settle } = harness();
    const automation: Array<[number, number]> = [];
    const filter = {
      frequency: {
        setValueAtTime: (value: number, time: number) => void automation.push([time, value]),
        cancelScheduledValues: (time: number) => {
          for (let i = automation.length - 1; i >= 0; i--) if (automation[i]![0] >= time) automation.splice(i, 1);
        },
      },
    };
    let calls = 0;
    const seq = new StepSequencer(
      { hat: { pattern: "XXXX", params: { cutoff: { min: 200, max: 8000, default: 1200 } } } },
      {
        onHit(hit) {
          calls++;
          filter.frequency.setValueAtTime(hit.values.cutoff!, hit.when);
          return () => filter.frequency.cancelScheduledValues(hit.when);
        },
      },
    );
    const hits = collect(seq);
    clock.attach(seq);
    clock.start(0);
    advance(0);
    const first = hits.length;
    expect(hits[0]!.values).toEqual({ cutoff: 1200 });
    expect(automation).toHaveLength(first);
    expect(automation[0]).toEqual([hits[0]!.when, 1200]);
    seq.lanes.hat!.steps[0]!.values.cutoff = 400;
    seq.lanes.hat!.steps[1]!.velocity = 0.5;
    await settle();
    ctx.currentTime = 0.2;
    // the refill ran in the microtask: everything from 0.2 on was retracted and queued again once
    const afterEdit = automation.filter(([t]) => t >= 0.2);
    const pendingTimes = hits.slice(first).map((h) => h.when);
    expect(new Set(afterEdit.map(([t]) => Number(t.toFixed(6)))).size).toBe(afterEdit.length); // no double automation
    expect(afterEdit.length).toBeGreaterThan(0);
    expect(calls).toBeGreaterThan(first);
    expect(pendingTimes.length).toBeGreaterThan(0);
    // the edited values are the ones queued
    const loop1 = hits.slice(first).find((h) => h.index === 0)!;
    expect(loop1.values.cutoff).toBe(400);
    expect(automation.find(([t]) => Math.abs(t - loop1.when) < 1e-9)![1]).toBe(400);
  });

  test("seeded ms transform stays bounded and is stable across an edit re-queue", async () => {
    const { ctx, clock, advance, settle } = harness();
    const seq = new StepSequencer(
      { k: "X.X.X.X.X.X.X.X.", s: "..X...X" },
      { seed: 7, transform: (hit, random) => ({ ...hit, when: hit.when + (random("t") - 0.5) * 0.016 }) },
    );
    const hits = collect(seq);
    clock.attach(seq);
    clock.start(1);
    advance(0);
    const grid = (h: Hit) => 1 + (h.index + h.loop * (h.lane === "k" ? 16 : 7)) * 0.125;
    const key = (h: Hit) => `${h.lane}:${h.loop}:${h.index}`;
    const before = new Map(hits.map((h) => [key(h), h.when]));
    for (const h of hits) expect(Math.abs(h.when - grid(h))).toBeLessThanOrEqual(0.008 + 1e-9);
    expect(hits.some((h) => Math.abs(h.when - grid(h)) > 1e-4)).toBe(true);
    const mark = hits.length;
    seq.lanes.k!.steps[1]!.velocity = 1; // an unrelated step edit re-queues everything pending
    ctx.currentTime = 0.3;
    await settle();
    const again = hits.slice(mark);
    expect(again.length).toBeGreaterThan(0);
    for (const h of again) {
      if (before.has(key(h))) expect(h.when).toBeCloseTo(before.get(key(h))!, 9);
      expect(Math.abs(h.when - grid(h))).toBeLessThanOrEqual(0.008 + 1e-9);
    }
  });

  test("a live steps[i] edit is heard on the next pass without restarting; dispose silences without stopping a shared clock", async () => {
    const { ctx, clock, advance, settle, ticks } = harness(0.6);
    const seq = new StepSequencer({ snare: "....X.......X..." });
    const hits = collect(seq);
    const other: number[] = [];
    clock.attach({ schedule: (w) => void other.push(w.beat.start) });
    const detach = clock.attach(seq);
    clock.start(0);
    advance(0); // look-ahead 0.6 s: steps 0..4 (the hit on step 4 is at 0.5 s)
    expect(hits.map((h) => h.index)).toEqual([4]);
    seq.lanes.snare!.steps[6]!.velocity = 0.8;
    await settle();
    advance(0.5);
    advance(1);
    expect(hits.map((h) => [h.index, h.velocity])).toContainEqual([6, 0.8]);
    expect(clock.state.value).toBe("playing");
    const count = hits.length;
    seq.dispose();
    expect(seq.dispose()).toBeUndefined(); // idempotent
    ctx.currentTime = 1.5;
    ticks.tick();
    ticks.tick();
    expect(hits).toHaveLength(count);
    expect(clock.state.value).toBe("playing");
    expect(other.length).toBeGreaterThan(2); // the shared clock keeps feeding others
    detach(); // already detached: harmless
    expect(() => clock.attach(seq)).toThrow("Step Sequencer is disposed.");
  });
});

describe("polymeter and rates", () => {
  test("lanes of 5, 16 and 8 steps loop independently at their own lengths", () => {
    const { clock, advance } = harness(2);
    const seq = new StepSequencer({ five: "XXXXX", sixteen: "X".repeat(16), eight: "XXXXXXXX" });
    const hits = collect(seq);
    clock.attach(seq);
    clock.start(0);
    advance(0); // 2 s = 16 steps of 0.125 s
    expect(at(hits, "five").map((h) => [h.loop, h.index])).toEqual(Array.from({ length: 16 }, (_, k) => [Math.floor(k / 5), k % 5]));
    expect(at(hits, "eight").map((h) => [h.loop, h.index])).toEqual(Array.from({ length: 16 }, (_, k) => [Math.floor(k / 8), k % 8]));
    expect(at(hits, "sixteen").map((h) => h.loop)).toEqual(Array(16).fill(0));
    expect(seq.lanes.five!.length).toBe(5);
  });

  test("Time strings and StepRate names map to beats", () => {
    const { clock, advance } = harness(4);
    const seq = new StepSequencer({
      dotted: { pattern: "XX", rate: "16n." },
      triplet: { pattern: "XXX", rate: "8t" },
      bar: { pattern: "X", rate: "1m" },
      ms: { pattern: "XX", rate: "250ms" },
      secs: { pattern: "X", rate: 1 },
      named: { pattern: "XX", rate: "1/8" },
    });
    const hits = collect(seq);
    clock.attach(seq);
    clock.start(0);
    advance(0);
    const t = (lane: string) => times(at(hits, lane)).slice(0, 3);
    expect(t("dotted")).toEqual([0, 0.1875, 0.375]); // 0.375 beat = 0.1875 s
    expect(t("triplet")[1]).toBeCloseTo(1 / 6, 5);
    expect(t("bar")).toEqual([0, 2]);
    expect(t("ms")).toEqual([0, 0.25, 0.5]); // 250 ms = half a beat at 120 bpm
    expect(t("secs")).toEqual([0, 1, 2]);
    expect(t("named")).toEqual([0, 0.25, 0.5]);
  });

  test("two sequencers on one clock stay beat-aligned", () => {
    const { clock, advance } = harness(2);
    const a = new StepSequencer({ k: "X..." });
    const b = new StepSequencer({ s: { pattern: "X..", rate: "8n" } });
    const ha = collect(a);
    const hb = collect(b);
    clock.attach(a);
    clock.attach(b);
    clock.start(0.25);
    advance(0);
    expect(times(ha)[0]).toBe(0.25);
    expect(times(hb)[0]).toBe(0.25);
    expect(times(hb).slice(0, 3)).toEqual([0.25, 1, 1.75]); // 8n steps of 0.25 s, one hit per 3
    expect(times(ha).slice(0, 3)).toEqual([0.25, 0.75, 1.25]);
  });
});

describe("notation and lane setters", () => {
  test("pattern strings and arrays parse; the getter reads back notation", () => {
    const seq = new StepSequencer({ a: "X x 3 . 9", b: [1, 0.55, 0] });
    expect(seq.lanes.a!.steps.map((s) => s.velocity)).toEqual([1, 0.8, 0.3, 0, 0.9]);
    expect(seq.lanes.a!.pattern).toBe("Xx3.9");
    expect(seq.lanes.b!.pattern).toEqual([1, 0.55, 0]);
    expect(seq.lanes.b!.steps).toHaveLength(3);
    expect(Object.isFrozen(seq.lanes.a!.steps)).toBe(true);
  });

  test("setters change the live lane: pattern (and length), rate, swing, muted, sound", () => {
    const ctx = new OfflineAudioContext(1, 128, 44100);
    const seq = new StepSequencer({ a: "X..." }, { context: ctx });
    const lane = seq.lanes.a!;
    lane.pattern = "X.X.X";
    expect(lane.length).toBe(5);
    lane.pattern = "X".repeat(20);
    expect(lane.length).toBe(20);
    lane.rate = "8t";
    expect(lane.rate).toBe("8t");
    lane.swing = "30%";
    expect(lane.swing).toBeCloseTo(0.3);
    lane.muted = true;
    expect(lane.muted).toBe(true);
    expect(lane.sound).toBeUndefined();
    lane.sound = "C4";
    expect(lane.sound).toBe("C4");
    expect(lane.output).toBeInstanceOf(GainNode);
    lane.sound = undefined;
    expect(lane.sound).toBeUndefined();
    expect(seq.lane("a")).toBe(lane);
  });

  test("an attached transport re-queues once per task for edits of every kind", async () => {
    const { clock, advance, settle } = harness();
    const seq = new StepSequencer({ a: "X..." });
    const refresh = vi.spyOn(clock, "refresh");
    clock.attach(seq);
    clock.start(0);
    advance(0);
    refresh.mockClear();
    seq.lanes.a!.rate = "8n";
    seq.lanes.a!.swing = 0.2;
    seq.lanes.a!.muted = false;
    seq.lanes.a!.steps[1]!.velocity = 1;
    expect(refresh).toHaveBeenCalledTimes(3); // one per committed change (muted stays false: no commit); the clock coalesces them into one refill
    await settle();
  });

  test("step and params writes are validated", () => {
    const seq = new StepSequencer({ a: { pattern: "XX", params: { p: { min: 0, max: 1, default: 0.5, step: 0.1 } } } });
    const step = seq.lanes.a!.steps[1]!;
    expect(step.values.p).toBe(0.5);
    step.values.p = 0.9;
    expect(seq.lanes.a!.steps[1]!.values.p).toBe(0.9);
    expect(() => (step.values.p = 2)).toThrow("Step Sequencer custom values need declared param ids");
    expect(() => (step.velocity = 2)).toThrow("Step Sequencer cell needs velocity");
    expect(() => ((step.values as Record<string, number>).q = 1)).toThrow();
    expect(seq.lanes.a!.params).toEqual({ p: { min: 0, max: 1, default: 0.5, step: 0.1 } });
  });
});

describe("hits, cleanup and disposal", () => {
  test("hit events, onhit and onHit all see the hit; onHit cleanups run on stop, seek and dispose", () => {
    const { clock, advance } = harness();
    const log: string[] = [];
    const seq = new StepSequencer(
      { a: { pattern: "X", onHit: (hit) => (log.push(`lane ${hit.when}`), () => log.push(`undo lane ${hit.when}`)) } },
      { onHit: (hit) => (log.push(`all ${hit.when}`), () => log.push(`undo all ${hit.when}`)) },
    );
    const events: HitEvent[] = [];
    seq.onhit = function (e) {
      expect(this).toBe(seq);
      events.push(e);
    };
    clock.attach(seq);
    clock.start(0);
    advance(0);
    expect(events[0]).toBeInstanceOf(HitEvent);
    expect(events[0]!.hit.lane).toBe("a");
    expect(log.slice(0, 2)).toEqual(["all 0", "lane 0"]);
    expect(log.some((l) => l.startsWith("undo"))).toBe(false);
    clock.stop();
    expect(log).toContain("undo lane 0");
    expect(log.indexOf("undo lane 0")).toBeLessThan(log.indexOf("undo all 0")); // reverse order
    const undone = log.filter((l) => l.startsWith("undo")).length;
    seq.onhit = null;
    clock.start(0);
    advance(0);
    const queued = events.length;
    seq.dispose();
    expect(log.filter((l) => l.startsWith("undo")).length).toBeGreaterThan(undone);
    advance(0.1);
    expect(events.length).toBe(queued);
  });

  test("dispose detaches from every transport and removes listeners; the signal option disposes", () => {
    const a = harness();
    const b = harness();
    const seq = new StepSequencer({ x: "X" });
    const hits = collect(seq);
    a.clock.attach(seq);
    b.clock.attach(seq);
    a.clock.start(0);
    b.clock.start(0);
    a.advance(0);
    b.advance(0);
    expect(hits.length).toBe(2 * Math.ceil(3 / 0.125)); // each clock queues 3 s of 16n steps
    seq[Symbol.dispose]();
    const count = hits.length;
    a.advance(1);
    b.advance(1);
    expect(hits).toHaveLength(count);
    seq.addEventListener("hit", () => hits.push({} as Hit)); // ignored after dispose

    const controller = new AbortController();
    const second = new StepSequencer({ x: "X" }, { signal: controller.signal });
    const seen = collect(second);
    const h = harness();
    h.clock.attach(second);
    h.clock.start(0);
    h.advance(0);
    controller.abort();
    const n = seen.length;
    h.advance(1);
    expect(seen).toHaveLength(n);
    const aborted = new StepSequencer({ x: "X" }, { signal: controller.signal });
    expect(() => harness().clock.attach(aborted)).toThrow("disposed");
  });

  test("an onHit that throws does not stop the window", () => {
    const { clock, advance } = harness();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const seq = new StepSequencer(
      { x: "XX" },
      {
        onHit: () =>
          void (() => {
            throw new Error("boom");
          })(),
      },
    );
    const hits = collect(seq);
    clock.attach(seq);
    clock.start(0);
    advance(0);
    expect(hits.length).toBeGreaterThan(2);
    spy.mockRestore();
  });

  test("errors name the problem", () => {
    const ctx = new OfflineAudioContext(1, 128, 44100);
    expect(() => new StepSequencer({ a: "X?" })).toThrow('Step Sequencer pattern has an invalid character "?"');
    expect(() => new StepSequencer({ a: "" })).toThrow("Step Sequencer pattern needs from 1 to 128 steps.");
    expect(() => new StepSequencer({ a: { pattern: "X", rate: "fast" as never } })).toThrow("Step Sequencer needs a Time");
    expect(() => new StepSequencer({ a: { pattern: "X", rate: "1000n" } })).toThrow("Step Sequencer needs a rate");
    expect(() => new StepSequencer({ a: { pattern: "X", swing: "x%" as never } })).toThrow("Step Sequencer swing needs");
    expect(() => new StepSequencer({ a: { pattern: "X", sound: "C4" } })).toThrow("Step Sequencer needs options.context for a lane with a sound.");
    expect(() => new StepSequencer({ a: { pattern: "X", sound: "H9" as never } }, { context: ctx })).toThrow(
      'Sound needs a note name like "C4", an AudioBuffer or a sound factory function.',
    );
    expect(() => new StepSequencer({ a: { pattern: "X", params: { v: { min: 1, max: 0, default: 0 } } } })).toThrow(
      "Step Sequencer lane params need",
    );
    expect(() => new StepSequencer({ a: { pattern: "X", params: { velocity: { min: 0, max: 1, default: 0 } } } })).toThrow(
      "Step Sequencer lane params need",
    );
    expect(() => new StepSequencer({ "": "X" })).toThrow("Step Sequencer lanes need nonempty names");
    expect(() => new StepSequencer({ a: {} as never })).toThrow("Step Sequencer lanes need nonempty names");
    expect(() => new StepSequencer({ a: "X" }, { onHit: 3 as never })).toThrow("Step Sequencer onHit and transform need functions.");
    const seq = new StepSequencer({ a: "X" });
    expect(() => seq.lanes.a!.output).toThrow("needs options.context");
    expect(() => seq.lane("nope")).toThrow("Step Sequencer needs an existing lane.");
  });
});

describe("sound", () => {
  const renderLane = async (setup: (seq: StepSequencer, ticks: { tick(): void }) => void) =>
    renderTimeline({ seconds: 0.5, channels: 1, sampleRate: 8000 }, (ctx, ticks) => {
      const timeline = new Timeline({ audioContext: ctx });
      const clock = new Clock({ timeline, tickSource: ticks, lookAhead: 0.2 });
      const buffer = new AudioBuffer({ length: 800, sampleRate: 8000 });
      buffer.getChannelData(0).fill(0.5);
      const seq = new StepSequencer({ k: { pattern: "X...", rate: "8n", sound: buffer } }, { context: ctx });
      clock.attach(seq);
      clock.start(0.1);
      setup(seq, ticks);
    });
  const peak = (buffer: AudioBuffer, from: number, to: number) => {
    const data = buffer.getChannelData(0);
    let max = 0;
    for (let i = Math.floor(from * buffer.sampleRate); i < Math.floor(to * buffer.sampleRate); i++) max = Math.max(max, Math.abs(data[i]!));
    return max;
  };

  test("a lane with a sound plays a voice per hit at hit.when, scaled by velocity", async () => {
    const out = await renderLane(() => {});
    expect(peak(out, 0, 0.09)).toBe(0);
    expect(peak(out, 0.1, 0.19)).toBeCloseTo(0.5, 2);
    expect(peak(out, 0.2, 0.4)).toBe(0);
  });

  test("a retracted hit never sounds", async () => {
    const out = await renderLane((seq, ticks) => {
      ticks.tick(); // queue the first window, then retract it
      seq.dispose();
    });
    expect(peak(out, 0, 0.5)).toBe(0);
  });

  test("output defaults to the destination and connect reroutes it", async () => {
    const out = await renderTimeline({ seconds: 0.2, channels: 1, sampleRate: 8000 }, (ctx, ticks) => {
      const clock = new Clock({ timeline: new Timeline({ audioContext: ctx }), tickSource: ticks, lookAhead: 0.2 });
      const seq = new StepSequencer({ k: { pattern: "X", sound: "A4" } }, { context: ctx });
      const half = new GainNode(ctx, { gain: 0.5 });
      half.connect(ctx.destination);
      expect(seq.lanes.k!.connect(half)).toBe(half);
      clock.attach(seq);
      clock.start(0);
    });
    const direct = await renderTimeline({ seconds: 0.2, channels: 1, sampleRate: 8000 }, (ctx, ticks) => {
      const clock = new Clock({ timeline: new Timeline({ audioContext: ctx }), tickSource: ticks, lookAhead: 0.2 });
      const seq = new StepSequencer({ k: { pattern: "X", sound: "A4" } }, { context: ctx });
      expect(seq.lanes.k!.output.context).toBe(ctx);
      clock.attach(seq);
      clock.start(0);
    });
    expect(peak(direct, 0, 0.1)).toBeGreaterThan(0.1);
    expect(peak(out, 0, 0.1)).toBeCloseTo(peak(direct, 0, 0.1) / 2, 2);
  });

  /** Render one lane whose sound is `sound`, hits at 0.1 s with a quarter-second step (8n at 120 bpm). */
  const renderSound = (sound: SoundFactory, pattern = "X...", step?: { velocity?: number }) =>
    renderTimeline({ seconds: 0.8, channels: 1, sampleRate: 8000 }, (ctx, ticks) => {
      const clock = new Clock({ timeline: new Timeline({ audioContext: ctx }), tickSource: ticks, lookAhead: 0.5 });
      const seq = new StepSequencer({ k: { pattern, rate: "8n", sound } }, { context: ctx });
      if (step?.velocity !== undefined) seq.lanes.k!.steps[0]!.velocity = step.velocity;
      clock.attach(seq);
      clock.start(0.1);
    });
  const constant: SoundFactory = (ctx) => new ConstantSourceNode(ctx, { offset: 1 });

  test("a factory voice is connected, started and stopped by the player: held for the step, then faded out", async () => {
    const out = await renderSound((ctx) => {
      const a = new ConstantSourceNode(ctx, { offset: 0.2 });
      const b = new ConstantSourceNode(ctx, { offset: 0.3 });
      const mix = new GainNode(ctx);
      a.connect(mix);
      b.connect(mix);
      return { output: mix, sources: [a, b] };
    });
    expect(peak(out, 0.15, 0.3)).toBeCloseTo(0.5, 2); // both oscillators of the voice are held for the 0.25 s step
    expect(peak(out, 0.4, 0.8)).toBe(0); // and both are stopped once it ends
  });

  test("a voice's own duration ends it however long the step is, and the step's length reaches the factory", async () => {
    const seen: SoundHit[] = [];
    const out = await renderSound((ctx, hit) => {
      seen.push(hit);
      const source = new ConstantSourceNode(ctx, { offset: 1 });
      return { output: source, sources: [source], duration: 0.05 };
    });
    expect(seen[0]!.duration).toBeCloseTo(0.25, 6);
    expect(peak(out, 0.11, 0.14)).toBeCloseTo(1, 2);
    expect(peak(out, 0.2, 0.8)).toBe(0);
  });

  test("the player applies velocity once, after the factory's output", async () => {
    const seen: number[] = [];
    const out = await renderSound((ctx, hit) => (seen.push(hit.velocity), constant(ctx, hit)), "5");
    expect(seen[0]).toBeCloseTo(0.5, 6);
    expect(peak(out, 0.15, 0.3)).toBeCloseTo(0.5, 2);
  });

  test("a retracted hit's factory voice never sounds", async () => {
    const out = await renderTimeline({ seconds: 0.5, channels: 1, sampleRate: 8000 }, (ctx, ticks) => {
      const clock = new Clock({ timeline: new Timeline({ audioContext: ctx }), tickSource: ticks, lookAhead: 0.2 });
      const seq = new StepSequencer({ k: { pattern: "X...", rate: "8n", sound: constant } }, { context: ctx });
      clock.attach(seq);
      clock.start(0.1);
      ticks.tick();
      seq.dispose();
    });
    expect(peak(out, 0, 0.5)).toBe(0);
  });

  test("a factory sound is called per hit", async () => {
    let made = 0;
    await renderTimeline({ seconds: 0.3, channels: 1, sampleRate: 8000 }, (ctx, ticks) => {
      const clock = new Clock({ timeline: new Timeline({ audioContext: ctx }), tickSource: ticks, lookAhead: 0.3 });
      const seq = new StepSequencer(
        { k: { pattern: "XX", rate: "8n", sound: (c) => (made++, new OscillatorNode(c, { frequency: 220 })) } },
        { context: ctx },
      );
      clock.attach(seq);
      clock.start(0);
    });
    expect(made).toBeGreaterThanOrEqual(2);
  });
});
