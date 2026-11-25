import { describe, expect, test } from "vitest";
import { ClipLauncher } from "../src/ClipLauncher";
import { driveOffline } from "./offline";
import { r3, record, rig, rms, tone } from "./helpers";

// 120 bpm, transport beat 0 at 0.1 s: a beat is 0.5 s, a bar 2 s.
const start = (clock: { start(when?: number, offsetBeats?: number): void }) => () => clock.start(0.1, 0);

/** Track `a` has a clip in every scene; track `b` has none in scene 1. */
function grid(ctx: OfflineAudioContext, emptySlots?: "keep" | "stop") {
  return new ClipLauncher(
    {
      a: [
        { buffer: tone(ctx, 200), loop: true, length: "1m" },
        { buffer: tone(ctx, 300), loop: true, length: "1m" },
        { buffer: tone(ctx, 400), loop: true, length: "1m" },
      ],
      b: [{ buffer: tone(ctx, 500), loop: true, length: "1m" }, null, { buffer: tone(ctx, 600), loop: true, length: "1m" }],
    },
    { context: ctx, ...(emptySlots ? { emptySlots } : {}) },
  );
}

describe("emptySlots", () => {
  test('"keep" (the default) leaves a track playing when the scene has no clip for it', async () => {
    const { ctx, ticks, clock } = rig(7);
    const launcher = grid(ctx);
    clock.attach(launcher);
    const log = record(launcher, ["started", "ended"]);
    await driveOffline(
      ctx,
      ticks,
      [
        { at: 0.2, run: () => launcher.launchScene(0) },
        { at: 2.5, run: () => launcher.launchScene(1) },
      ],
      start(clock),
    );
    expect(log.filter((e) => e.type === "started" && e.track === "b").map((e) => [e.clip, r3(e.when)])).toEqual([[0, 2.1]]);
    expect(log.filter((e) => e.type === "ended" && e.track === "b")).toEqual([]);
    expect(launcher.tracks.b!.playing.value?.index).toBe(0);
    launcher.dispose();
  });

  test('"stop" stops a track with an empty slot on the scene\'s boundary, and a later scene starts it again', async () => {
    const { ctx, ticks, clock } = rig(9);
    const launcher = grid(ctx, "stop");
    clock.attach(launcher);
    const log = record(launcher, ["started", "ended"]);
    const out = await driveOffline(
      ctx,
      ticks,
      [
        { at: 0.2, run: () => launcher.launchScene(0) },
        { at: 2.5, run: () => launcher.launchScene(1) },
        { at: 4.5, run: () => launcher.launchScene(2) },
      ],
      start(clock),
    );
    expect(log.filter((e) => e.type === "started" && e.track === "a").map((e) => [e.clip, r3(e.when)])).toEqual([
      [0, 2.1],
      [1, 4.1],
      [2, 6.1],
    ]);
    expect(log.filter((e) => e.type === "started" && e.track === "b").map((e) => [e.clip, r3(e.when)])).toEqual([
      [0, 2.1],
      [2, 6.1],
    ]);
    expect(log.filter((e) => e.type === "ended" && e.track === "b").map((e) => r3(e.when))).toEqual([4.1]);
    launcher.dispose();
    expect(out).toBeTruthy();
  });

  test('"stop" leaves a track that was already idle alone, and a clip list launch never stops other tracks', async () => {
    const { ctx, ticks, clock } = rig(7);
    const launcher = grid(ctx, "stop");
    clock.attach(launcher);
    const log = record(launcher, ["started", "ended"]);
    await driveOffline(
      ctx,
      ticks,
      [
        { at: 0.2, run: () => launcher.launchScene(1) },
        { at: 2.5, run: () => launcher.tracks.b!.clips[0]!.launch() },
        { at: 4.5, run: () => launcher.launchScene([launcher.tracks.a!.clips[2]!]) },
      ],
      start(clock),
    );
    expect(log.filter((e) => e.type === "ended" && e.track === "b")).toEqual([]);
    expect(log.filter((e) => e.type === "started" && e.track === "b").map((e) => [e.clip, r3(e.when)])).toEqual([[0, 4.1]]);
    launcher.dispose();
  });

  test('"stop" also applies to each entry of playChain', async () => {
    const { ctx, ticks, clock } = rig(10);
    const launcher = grid(ctx, "stop");
    clock.attach(launcher);
    const log = record(launcher, ["started", "ended"]);
    const out = await driveOffline(ctx, ticks, [{ at: 0.2, run: () => launcher.playChain([0, 1, 2]) }], start(clock));
    expect(log.filter((e) => e.type === "started" && e.track === "b").map((e) => [e.clip, r3(e.when)])).toEqual([
      [0, 2.1],
      [2, 6.1],
    ]);
    // Scene 1 has nothing for b: it stops where the scene begins instead of running on.
    expect(log.filter((e) => e.type === "ended" && e.track === "b").map((e) => r3(e.when))).toContain(4.1);
    expect(rms(out, 6.3, 7.9)).toBeGreaterThan(0.01);
    launcher.dispose();
  });
});
