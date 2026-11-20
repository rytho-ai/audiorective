import { describe, expect, test } from "vitest";
import { StepSequencer, type Hit } from "@audiorective/sequencer";
import { ClipLauncher } from "../src/ClipLauncher";
import { driveOffline, type Step } from "./offline";
import { freq, lastSound, near, onset, record, rig, tone, r3 } from "./helpers";

describe("launcher module (beyond the contract)", () => {
  test("4. repeat mode retriggers every N beats until released, release stops on the clip quantize", async () => {
    const { ctx, ticks, clock } = rig(5);
    const l = new ClipLauncher({ t: [{ buffer: tone(ctx, 200), loop: true, mode: "repeat", repeatBeats: 1, quantize: "4n" }] }, { context: ctx });
    clock.attach(l);
    const log = record(l, ["started", "ended"]);
    const clip = l.tracks.t!.clips[0]!;
    const out = await driveOffline(
      ctx,
      ticks,
      [
        { at: 0.1, run: () => clip.launch() },
        { at: 2.3, run: () => clip.release() },
      ],
      () => clock.start(0.1, 0),
    );
    // starts every beat (0.5 s) from 0.1 until the release boundary (next beat after 2.3 = 2.6)
    const starts = log.filter((e) => e.type === "started").map((e) => r3(e.when));
    expect(starts).toEqual([0.1, 0.6, 1.1, 1.6, 2.1]);
    expect(r3(log.filter((e) => e.type === "ended").at(-1)!.when)).toBe(2.6);
    // every retrigger starts from the clip's first beat
    near(freq(out, 0.65, 0.95), 200);
    near(freq(out, 1.15, 1.45), 200);
    expect(lastSound(out)).toBeCloseTo(2.6, 3);
    l.dispose();
  });

  test("9. transform: one rule rewrites launches (Lead solo -> Lead launches wait for 2 bars)", async () => {
    const { ctx, ticks, clock } = rig(8);
    let leadSolo = false;
    const l = new ClipLauncher(
      { lead: [{ buffer: tone(ctx, 200) }, { buffer: tone(ctx, 300) }], bass: [{ buffer: tone(ctx, 100) }] },
      { context: ctx, transform: (req) => (leadSolo && req.track.name === "lead" && req.clip ? { ...req, quantize: "2m" } : req) },
    );
    clock.attach(l);
    const log = record(l, ["started"]);
    await driveOffline(
      ctx,
      ticks,
      [
        { at: 0.7, run: () => l.tracks.lead!.clips[0]!.launch() }, // free: next bar, 2.1
        { at: 0.7, run: () => l.tracks.bass!.clips[0]!.launch() },
        {
          at: 2.5,
          run: () => {
            leadSolo = true;
          },
        },
        { at: 2.6, run: () => l.tracks.lead!.clips[1]!.launch() }, // solo: next 2-bar boundary = 4.1 -> that is the next 2 bars from beat 0: 4.1
      ],
      () => clock.start(0.1, 0),
    );
    const when = (track: string, clip: number) => r3(log.find((e) => e.track === track && e.clip === clip)!.when);
    expect(when("lead", 0)).toBe(2.1);
    expect(when("bass", 0)).toBe(2.1);
    expect(when("lead", 1)).toBe(4.1);
    l.dispose();
  });

  test("9. transform returning null drops the launch (skipped), and may set an exact beat", async () => {
    const { ctx, ticks, clock } = rig(6);
    const l = new ClipLauncher(
      { t: [{ buffer: tone(ctx, 200) }, { buffer: tone(ctx, 300) }] },
      {
        context: ctx,
        transform: (req) => (req.clip?.index === 0 ? null : { ...req, beat: 6 }),
      },
    );
    clock.attach(l);
    const log = record(l, ["started", "skipped"]);
    await driveOffline(
      ctx,
      ticks,
      [
        { at: 0.1, run: () => l.tracks.t!.clips[0]!.launch() },
        { at: 0.7, run: () => l.tracks.t!.clips[1]!.launch() },
      ],
      () => clock.start(0.1, 0),
    );
    expect(log.map((e) => e.type)).toEqual(["skipped", "started"]);
    expect(r3(log[1]!.when)).toBe(3.1); // beat 6 at 120 bpm from 0.1
    l.dispose();
  });

  test("10/11. pattern clips switch on boundaries with no doubled or missing hits; a hat lane on the same clock is untouched", async () => {
    const { ctx, ticks, clock } = rig(10);
    const active = new Set<Hit & { _n?: string }>();
    const mk = (name: string, pattern: string) =>
      new StepSequencer(
        { k: { pattern, rate: "4n" } },
        {
          onHit: (h) => {
            const x = { ...h, _n: name };
            active.add(x);
            return () => active.delete(x);
          },
        },
      );
    const A = mk("A", "X"); // a hit every beat
    const B = mk("B", "X."); // a hit every other beat
    const hats = new StepSequencer(
      { h: { pattern: "X", rate: "8n" } },
      {
        onHit: (h) => {
          hat.add(h.when);
          return () => hat.delete(h.when);
        },
      },
    );
    const hat = new Set<number>();
    const l = new ClipLauncher(
      {
        drums: [
          { scheduler: A, loop: true, length: "1m" },
          { scheduler: B, loop: true, length: "1m" },
        ],
      },
      { context: ctx },
    );
    clock.attach(hats);
    clock.attach(l);
    const A0 = l.tracks.drums!.clips[0]!;
    const B0 = l.tracks.drums!.clips[1]!;
    const steps: Step[] = [
      { at: 0.1, run: () => A0.launch() },
      { at: 1.0, run: () => B0.launch() }, // A -> B at 2.1 (outside the look-ahead when asked)
      { at: 3.0, run: () => A0.launch() }, // -> 4.1
      { at: 4.05, run: () => B0.launch({ quantize: "1m" }) }, // 4.1 is inside the look-ahead when asked: switch lands at 4.1 -> B? (boundary 4.1 hits now)
      { at: 5.95, run: () => A0.launch() }, // -> 6.1, again inside the look-ahead
      { at: 6.07, run: () => B0.launch() }, // replaces the waiting A: B at 6.1
      { at: 8.2, run: () => l.tracks.drums!.stop({ quantize: "1m" }) }, // stop at 10.1: beyond the end; use beat quantum instead
    ];
    await driveOffline(ctx, ticks, steps, () => clock.start(0.1, 0));
    const got = [...active].filter((h) => h.when < 9.8).sort((a, b) => a.when - b.when);
    // ideal: segments [start, end, clip]
    const seg: Array<[number, number, "A" | "B"]> = [
      [0.1, 2.1, "A"],
      [2.1, 4.1, "B"],
      [4.1, 6.1, "B"],
      [6.1, 9.8, "B"],
    ];
    // 4.05 launch of B at 4.1 replaces A's waiting launch (A would have started at 4.1): B plays from 4.1
    const want: number[] = [];
    for (const [s, e, c] of seg) {
      const step = c === "A" ? 0.5 : 1.0;
      for (let t = s; t < e - 1e-9; t += step) want.push(t);
    }
    expect(got.map((h) => Math.round(h.when * 1e5) / 1e5)).toEqual(want.map((t) => Math.round(t * 1e5) / 1e5));
    expect(got.filter((h) => h._n === "A").every((h) => h.when < 2.1 - 1e-9)).toBe(true);
    // hat lane: 0.25 s grid from 0.1, nothing missing, nothing doubled
    const hs = [...hat].filter((t) => t < 9.8).sort((a, b) => a - b);
    expect(hs.length).toBe(Math.ceil((9.8 - 0.1) / 0.25 - 1e-9));
    hs.forEach((t, i) => expect(t).toBeCloseTo(0.1 + i * 0.25, 5));
    l.dispose();
  });

  test("pause freezes the launcher and resume continues from the paused position", async () => {
    const { ctx, ticks, clock } = rig(6);
    const l = new ClipLauncher({ t: [{ buffer: tone(ctx, 200), loop: true }] }, { context: ctx });
    clock.attach(l);
    const clip = l.tracks.t!.clips[0]!;
    let posAtPause: number | null = null;
    const out = await driveOffline(
      ctx,
      ticks,
      [
        { at: 0.1, run: () => clip.launch() },
        {
          at: 1.6,
          run: () => {
            clock.pause();
            posAtPause = clip.position;
          },
        }, // 3 beats in
        { at: 3.1, run: () => clock.resume() },
      ],
      () => clock.start(0.1, 0),
    );
    expect(posAtPause).toBeCloseTo(3, 1);
    // silent while paused, then continues at material beat 3 (+ a few ms)
    expect(lastSound(out, 1.7) > 0 ? onset(out, 1.7) : -1).toBeGreaterThan(3.09);
    near(freq(out, 3.15, 3.45), 200 * (1 + 3 / 16));
    l.dispose();
  });

  test("a launch made while the clock is stopped waits for start and starts exactly there", async () => {
    const { ctx, ticks, clock } = rig(3);
    const l = new ClipLauncher({ t: [{ buffer: tone(ctx, 200) }] }, { context: ctx });
    clock.attach(l);
    const log = record(l, ["started", "queued"]);
    l.tracks.t!.clips[0]!.launch();
    const out = await driveOffline(ctx, ticks, [], () => clock.start(0.35, 0));
    expect(log.find((e) => e.type === "started")!.when).toBeCloseTo(0.35, 6);
    expect(onset(out)).toBeCloseTo(0.35, 3);
    l.dispose();
  });

  test("5. a buffer clip follows the scene tempo by default; warp: false keeps its speed", async () => {
    const { ctx, ticks, clock } = rig(8);
    const l = new ClipLauncher(
      {
        t: [
          { buffer: tone(ctx, 200), loop: true, bpm: 120 },
          { buffer: tone(ctx, 300), loop: true, bpm: 120, warp: false },
        ],
      },
      { context: ctx, scenes: [{}, { tempo: 240 }] },
    );
    clock.attach(l);
    const tracks = l.tracks.t!;
    const out = await driveOffline(
      ctx,
      ticks,
      [
        { at: 0.1, run: () => tracks.clips[0]!.launch() },
        { at: 0.5, run: () => l.launchScene(1) }, // 240 bpm at 2.1, clip 1 starts there (unwarped)
      ],
      () => clock.start(0.1, 0),
    );
    // before the scene: normal; after it clip 1 plays unwarped at its natural speed (first beat 300 Hz for 0.5 s)
    near(freq(out, 0.15, 0.45), 200);
    near(freq(out, 2.15, 2.55), 300);
    expect(clock.timeline.bpm.valueAtTime(2.2)).toBe(240);
    l.dispose();
  });

  test("a waiting boundary is fixed in beats and follows a tempo change", async () => {
    const { ctx, ticks, clock } = rig(4);
    const l = new ClipLauncher({ t: [{ buffer: tone(ctx, 200) }] }, { context: ctx });
    clock.attach(l);
    const log = record(l, ["started"]);
    const clip = l.tracks.t!.clips[0]!;
    const seen: Array<number | null> = [];
    await driveOffline(
      ctx,
      ticks,
      [
        { at: 0.3, run: () => clip.launch() }, // waits for beat 4 (2.1 s at 120)
        {
          at: 0.5,
          run: () => {
            seen.push(clip.startsAt.value);
            clock.bpm.value = 240;
            seen.push(clip.startsAt.value);
          },
        },
      ],
      () => clock.start(0.1, 0),
    );
    expect(seen[0]).toBeCloseTo(2.1, 2);
    // at 0.5 s the beat is 0.8: 3.2 beats left at 4 beats/s -> 1.3 s
    expect(seen[1]).toBeCloseTo(1.3, 2);
    expect(r3(log[0]!.when)).toBeCloseTo(1.3, 2);
    l.dispose();
  });

  test("configure: loop applies at the next wrap, pitch is live, follow on a playing clip is due at once and still quantized", async () => {
    const { ctx, ticks, clock } = rig(16);
    const l = new ClipLauncher(
      {
        t: [
          { buffer: tone(ctx, 200), loop: true },
          { buffer: tone(ctx, 300), loop: true },
        ],
      },
      { context: ctx },
    );
    clock.attach(l);
    const log = record(l, ["started"]);
    const [a] = l.tracks.t!.clips as [import("../src/ClipLauncher").Clip, unknown];
    const out = await driveOffline(
      ctx,
      ticks,
      [
        { at: 0.1, run: () => a.launch() },
        { at: 1.0, run: () => a.configure({ loop: { startBeat: 4, endBeat: 8 } }) }, // the 16-beat pass finishes first (wrap at 8.1 s)
      ],
      () => clock.start(0.1, 0),
    );
    near(freq(out, 2.7, 3.0), 200 * (1 + 5 / 16)); // still on the first pass: material beat 5 sounds at t=2.6..3.1
    near(freq(out, 8.15, 8.45), 250); // new loop: material beat 4
    near(freq(out, 10.15, 10.45), 250); // 2 s (4 beats) later it wrapped back to 4
    expect(log).toHaveLength(1);
    l.dispose();

    const r2 = rig(8);
    const l2 = new ClipLauncher(
      {
        t: [
          { buffer: tone(r2.ctx, 200), loop: true },
          { buffer: tone(r2.ctx, 300), loop: true },
        ],
      },
      { context: r2.ctx },
    );
    r2.clock.attach(l2);
    const log2 = record(l2, ["started"]);
    const c0 = l2.tracks.t!.clips[0]!;
    const out2 = await driveOffline(
      r2.ctx,
      r2.ticks,
      [
        { at: 0.1, run: () => c0.launch() },
        { at: 1.1, run: () => (c0.pitch.value = 12) },
        { at: 3.0, run: () => c0.configure({ follow: { after: "1m", next: [{ clip: 1 }] } }) }, // 1 bar after its start has passed: due now, quantized to 4.1
      ],
      () => r2.clock.start(0.1, 0),
    );
    near(freq(out2, 1.15, 1.3), 2 * 200 * (1 + 2 / 16), 0.02); // +12 st at t=1.1 (material beat 2): the beat now lasts 0.25 s
    expect(log2.map((e) => [e.clip, r3(e.when)])).toEqual([
      [0, 0.1],
      [1, 4.1],
    ]);
    l2.dispose();
  });

  test("onSchedule: a host switches other audio at the same boundary and undoes it when the launch is replaced", async () => {
    const { ctx, ticks, clock } = rig(4);
    const calls: string[] = [];
    const l = new ClipLauncher(
      { t: [{ buffer: tone(ctx, 200) }, { buffer: tone(ctx, 300) }] },
      {
        context: ctx,
        onSchedule: (c) => {
          const n = `${c.clip?.index ?? "stop"}@${r3(c.when)}`;
          calls.push(`schedule ${n}`);
          return { cancel: () => calls.push(`cancel ${n}`), commit: () => calls.push(`commit ${n}`) };
        },
      },
    );
    clock.attach(l);
    await driveOffline(
      ctx,
      ticks,
      [
        { at: 2.0, run: () => l.tracks.t!.clips[0]!.launch() }, // boundary 2.1 is inside the look-ahead: handed over at once
        { at: 2.05, run: () => l.tracks.t!.clips[1]!.launch() }, // replaces it
      ],
      () => clock.start(0.1, 0),
    );
    expect(calls).toEqual(["schedule 0@2.1", "cancel 0@2.1", "schedule 1@2.1", "commit 1@2.1"]);
    l.dispose();
  });

  test("stopping the clock clears everything and tells the listeners", async () => {
    const { ctx, ticks, clock } = rig(4);
    const l = new ClipLauncher({ t: [{ buffer: tone(ctx, 200), loop: true }, { buffer: tone(ctx, 300) }] }, { context: ctx });
    clock.attach(l);
    const log = record(l, ["started", "ended", "cancelled"]);
    await driveOffline(
      ctx,
      ticks,
      [
        { at: 0.1, run: () => l.tracks.t!.clips[0]!.launch() },
        { at: 1.0, run: () => l.tracks.t!.clips[1]!.launch() },
        { at: 1.2, run: () => clock.stop() },
      ],
      () => clock.start(0.1, 0),
    );
    expect(log.map((e) => `${e.type}:${e.clip}`)).toEqual(["started:0", "ended:0", "cancelled:1"]);
    expect(l.tracks.t!.playing.value).toBeNull();
    expect(l.tracks.t!.queued.value).toBeNull();
    l.dispose();
  });

  test("a skipped scene clip still moves the scene tempo", async () => {
    const { ctx, ticks, clock } = rig(6);
    const l = new ClipLauncher({ t: [null, { buffer: tone(ctx, 200), chance: 0 }] }, { context: ctx, scenes: [{}, { tempo: 60 }] });
    clock.attach(l);
    const log = record(l, ["started", "skipped"]);
    await driveOffline(ctx, ticks, [{ at: 0.1, run: () => l.launchScene(1) }], () => clock.start(0.1, 0));
    expect(log.map((e) => e.type)).toEqual(["skipped"]);
    expect(clock.timeline.bpm.valueAtTime(1)).toBe(60);
    l.dispose();
  });
});
