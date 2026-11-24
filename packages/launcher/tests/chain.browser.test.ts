import { describe, expect, test } from "vitest";
import { ClipLauncher } from "../src/ClipLauncher";
import { driveOffline } from "./offline";
import { r3, record, rig, rms, tone } from "./helpers";

// 120 bpm, transport beat 0 at 0.1 s: a beat is 0.5 s, a bar 2 s.
const start = (clock: { start(when?: number, offsetBeats?: number): void }) => () => clock.start(0.1, 0);

describe("playChain", () => {
  test("plays each entry for its scene's longest clip, back to back, then stops every track", async () => {
    const { ctx, ticks, clock } = rig(13);
    const launcher = new ClipLauncher(
      {
        a: [
          { buffer: tone(ctx, 200), loop: true, length: "1m" },
          { buffer: tone(ctx, 300), loop: true, length: "1m" },
          { buffer: tone(ctx, 400), loop: true, length: "2m" },
        ],
        b: [{ buffer: tone(ctx, 500), loop: true, length: "1m" }, null, { buffer: tone(ctx, 600), loop: true, length: "1m" }],
      },
      { context: ctx },
    );
    clock.attach(launcher);
    const log = record(launcher, ["started", "ended"]);
    const positions: number[] = [];
    launcher.chain.subscribe((chain) => positions.push(chain ? chain.index : -2));
    const out = await driveOffline(ctx, ticks, [{ at: 0.2, run: () => launcher.playChain([0, 0, 1, 2]) }], start(clock));
    const startsA = log.filter((e) => e.type === "started" && e.track === "a").map((e) => [e.clip, r3(e.when)]);
    expect(startsA).toEqual([
      [0, 2.1],
      [0, 4.1],
      [1, 6.1],
      [2, 8.1],
    ]);
    // b has no clip in scene 1, so it keeps looping scene 0 through it; scene 2 replaces it.
    expect(log.filter((e) => e.type === "started" && e.track === "b").map((e) => [e.clip, r3(e.when)])).toEqual([
      [0, 2.1],
      [0, 4.1],
      [2, 8.1],
    ]);
    const endsAt = log.filter((e) => e.type === "ended").map((e) => r3(e.when));
    expect(Math.max(...(endsAt as number[]))).toBe(12.1);
    expect(rms(out, 12.2, 12.9)).toBeLessThan(1e-4);
    expect(positions).toEqual([-1, 0, 1, 2, 3, -2]);
    expect(launcher.chain.value).toBe(null);
    launcher.dispose();
  });

  test("a scene launched during the chain ends it and queues as usual", async () => {
    const { ctx, ticks, clock } = rig(10);
    const launcher = new ClipLauncher(
      {
        a: [
          { buffer: tone(ctx, 200), loop: true, length: "1m" },
          { buffer: tone(ctx, 300), loop: true, length: "1m" },
          { buffer: tone(ctx, 400), loop: true, length: "1m" },
        ],
      },
      { context: ctx },
    );
    clock.attach(launcher);
    const log = record(launcher, ["started"]);
    await driveOffline(
      ctx,
      ticks,
      [
        { at: 0.2, run: () => launcher.playChain([0, 1, 1, 1]) },
        { at: 4.5, run: () => launcher.launchScene(2) },
      ],
      start(clock),
    );
    expect(log.map((e) => [e.clip, r3(e.when)])).toEqual([
      [0, 2.1],
      [1, 4.1],
      [2, 6.1],
    ]);
    expect(launcher.chain.value).toBe(null);
    launcher.dispose();
  });

  test("a chain started while stopped begins with the transport; bad indices throw", async () => {
    const { ctx, ticks, clock } = rig(6);
    const launcher = new ClipLauncher(
      {
        a: [
          { buffer: tone(ctx, 200), loop: true, length: "1m" },
          { buffer: tone(ctx, 300), loop: true, length: "1m" },
        ],
      },
      { context: ctx },
    );
    clock.attach(launcher);
    expect(() => launcher.playChain([])).toThrow(RangeError);
    expect(() => launcher.playChain([0, 2])).toThrow("playChain needs scene indices from 0 to 1.");
    const log = record(launcher, ["started", "ended"]);
    launcher.playChain([1, 0]);
    await driveOffline(ctx, ticks, [], start(clock));
    expect(log.map((e) => [e.type, e.clip, r3(e.when)])).toEqual([
      ["started", 1, 0.1],
      ["ended", 1, 2.1],
      ["started", 0, 2.1],
      ["ended", 0, 4.1],
    ]);
    launcher.dispose();
  });
});

describe("playChain edge cases", () => {
  const loops = (ctx: BaseAudioContext, n: number) =>
    Array.from({ length: n }, (_, i) => ({ buffer: tone(ctx, 200 + 100 * i), loop: true, length: "1m" as const }));

  test("a tempo change just before an entry starts keeps that entry", async () => {
    const { ctx, ticks, clock } = rig(10);
    const launcher = new ClipLauncher({ a: loops(ctx, 2) }, { context: ctx });
    clock.attach(launcher);
    const log = record(launcher, ["started"]);
    await driveOffline(
      ctx,
      ticks,
      [
        { at: 0.2, run: () => launcher.playChain([0, 1, 0]) },
        { at: 4.04, run: () => (clock.bpm.value = 121) },
      ],
      start(clock),
    );
    expect(log.map((e) => e.clip)).toEqual([0, 1, 0]);
    launcher.dispose();
  });

  test("an empty scene still advances the chain", async () => {
    const { ctx, ticks, clock } = rig(10);
    const launcher = new ClipLauncher({ a: [loops(ctx, 1)[0], null, { buffer: tone(ctx, 400), loop: true, length: "1m" }] }, { context: ctx });
    clock.attach(launcher);
    const log = record(launcher, ["started", "ended"]);
    await driveOffline(ctx, ticks, [{ at: 0.2, run: () => launcher.playChain([0, 1, 2]) }], start(clock));
    // Scene 1 is empty for track a, so clip 0 keeps looping through it; scene 2 starts on beat 12 (6.1 s) and the chain ends a bar later.
    expect(log.map((e) => [e.type, e.clip, r3(e.when)])).toEqual([
      ["started", 0, 2.1],
      ["ended", 0, 6.1],
      ["started", 2, 6.1],
      ["ended", 2, 8.1],
    ]);
    expect(launcher.chain.value).toBe(null);
    launcher.dispose();
  });

  test("a launch dropped by chance still advances the chain to its end", async () => {
    const { ctx, ticks, clock } = rig(8);
    const launcher = new ClipLauncher({ a: [loops(ctx, 1)[0], { buffer: tone(ctx, 400), loop: true, length: "1m", chance: 0 }] }, { context: ctx });
    clock.attach(launcher);
    const log = record(launcher, ["started", "ended", "skipped"]);
    await driveOffline(ctx, ticks, [{ at: 0.2, run: () => launcher.playChain([0, 1]) }], start(clock));
    expect(log.map((e) => [e.type, e.clip, r3(e.when)])).toEqual([
      ["started", 0, 2.1],
      ["skipped", 1, 4.1],
      ["ended", 0, 6.1],
    ]);
    expect(launcher.chain.value).toBe(null);
    launcher.dispose();
  });

  test("scene tempos apply inside a chain", async () => {
    const { ctx, ticks, clock } = rig(9);
    const launcher = new ClipLauncher({ a: loops(ctx, 2) }, { context: ctx, scenes: [{ tempo: 100 }, { tempo: 140 }] });
    clock.attach(launcher);
    const bpm: number[] = [];
    await driveOffline(
      ctx,
      ticks,
      [
        { at: 0.2, run: () => launcher.playChain([0, 1]) },
        { at: 3, run: () => bpm.push(clock.bpm.value) },
        { at: 6, run: () => bpm.push(clock.bpm.value) },
      ],
      start(clock),
    );
    expect(bpm).toEqual([100, 140]);
    launcher.dispose();
  });

  test("a repeat clip does not swallow the chain's next entry", async () => {
    const { ctx, ticks, clock } = rig(8);
    const launcher = new ClipLauncher(
      { a: [{ buffer: tone(ctx, 200), mode: "repeat", repeatBeats: 1, length: "1m" }, loops(ctx, 2)[1]] },
      { context: ctx },
    );
    clock.attach(launcher);
    const log = record(launcher, ["started"]);
    await driveOffline(ctx, ticks, [{ at: 0.2, run: () => launcher.playChain([0, 1]) }], start(clock));
    expect(log.some((e) => e.clip === 1 && r3(e.when) === 4.1)).toBe(true);
    launcher.dispose();
  });

  test("a command on one track ends the chain and withdraws its next entry on every track", async () => {
    const { ctx, ticks, clock } = rig(8);
    const launcher = new ClipLauncher({ a: loops(ctx, 2), b: loops(ctx, 2) }, { context: ctx });
    clock.attach(launcher);
    const log = record(launcher, ["started"]);
    await driveOffline(
      ctx,
      ticks,
      [
        { at: 0.2, run: () => launcher.playChain([0, 1]) },
        { at: 2.5, run: () => launcher.tracks.a!.stop() },
      ],
      start(clock),
    );
    expect(log.filter((e) => e.clip === 1)).toEqual([]);
    expect(launcher.chain.value).toBe(null);
    launcher.dispose();
  });
});
