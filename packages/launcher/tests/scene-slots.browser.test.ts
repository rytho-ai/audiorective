import { describe, expect, test } from "vitest";
import { ClipLauncher } from "../src/ClipLauncher";
import { driveOffline } from "./offline";
import { r3, record, rig, rms, tone } from "./helpers";

// 120 bpm, transport beat 0 at 0.1 s: a beat is 0.5 s, a bar 2 s.
const start = (clock: { start(when?: number, offsetBeats?: number): void }) => () => clock.start(0.1, 0);

describe("insertScene and removeScene", () => {
  test("a scene inserted before a playing clip leaves it playing and renumbers slots", async () => {
    const { ctx, ticks, clock } = rig(8);
    const launcher = new ClipLauncher(
      {
        a: [
          { buffer: tone(ctx, 200), loop: true },
          { buffer: tone(ctx, 300), loop: true },
        ],
        b: [null, { buffer: tone(ctx, 400), loop: true }],
      },
      { context: ctx, scenes: [{ name: "One" }, { name: "Two" }] },
    );
    clock.attach(launcher);
    const log = record(launcher, ["started", "ended"]);
    const playing = launcher.tracks.a!.clips[0]!;
    let inserted;
    const out = await driveOffline(
      ctx,
      ticks,
      [
        { at: 0.2, run: () => launcher.launchScene(0) },
        { at: 2.5, run: () => (inserted = launcher.insertScene(0, { name: "New" })) },
        { at: 3.0, run: () => launcher.insertScene(3) },
      ],
      start(clock),
    );
    expect(log.filter((e) => e.type === "ended")).toEqual([]);
    expect(rms(out, 3.1, 7.9)).toBeGreaterThan(0.05);
    expect(playing.playing.value).toBe(true);
    expect(playing.index).toBe(1);
    expect(launcher.tracks.a!.clips[2]!.index).toBe(2);
    expect(launcher.tracks.a!.clips[0]).toBeNull();
    expect(launcher.scenes.map((scene) => [scene.index, scene.name])).toEqual([
      [0, "New"],
      [1, "One"],
      [2, "Two"],
      [3, "Scene 4"],
    ]);
    expect(inserted).toBe(launcher.scenes[0]);
    expect(launcher.tracks.b!.clips).toHaveLength(4);
    launcher.dispose();
  });

  test("removeScene stops the clips in that slot, keeps the others playing and launches by the new indices", async () => {
    const { ctx, ticks, clock } = rig(9);
    const launcher = new ClipLauncher(
      {
        a: [
          { buffer: tone(ctx, 200), loop: true },
          { buffer: tone(ctx, 300), loop: true },
          { buffer: tone(ctx, 400), loop: true },
        ],
        b: [{ buffer: tone(ctx, 500), loop: true }, null, null],
      },
      { context: ctx },
    );
    clock.attach(launcher);
    const log = record(launcher, ["started", "ended"]);
    await driveOffline(
      ctx,
      ticks,
      [
        { at: 0.2, run: () => launcher.launchScene(0) },
        { at: 2.5, run: () => launcher.removeScene(1) },
        { at: 3.0, run: () => launcher.launchScene(1) },
      ],
      start(clock),
    );
    expect(launcher.scenes).toHaveLength(2);
    expect(launcher.tracks.a!.clips.map((clip) => clip?.index)).toEqual([0, 1]);
    // The old third scene is now scene 1: it started at the bar after 3 s.
    expect(log.filter((e) => e.type === "started" && e.track === "a").map((e) => [e.clip, r3(e.when)])).toEqual([
      [0, 2.1],
      [1, 4.1],
    ]);
    expect(() => launcher.removeScene(5)).toThrow("removeScene needs an index from 0 to 1.");
    expect(() => launcher.insertScene(9)).toThrow("insertScene needs an index from 0 to 2.");
    launcher.dispose();
  });

  test("a scene's name can be mirrored in place", () => {
    const { ctx } = rig(1);
    const launcher = new ClipLauncher({ a: [null] }, { context: ctx, scenes: [{ name: "Old" }] });
    launcher.scenes[0]._rename("New");
    expect(launcher.scenes[0].name).toBe("New");
    launcher.dispose();
  });
});
