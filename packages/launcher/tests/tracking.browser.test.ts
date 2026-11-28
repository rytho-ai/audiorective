import { describe, expect, test } from "vitest";
import { effect } from "@audiorective/core";
import { Clip, ClipLauncher, Scene, Track } from "../src/ClipLauncher";
import * as launcherSourceModule from "../src/ClipLauncher.ts?raw";
import { coverageGaps, watch } from "../../../scripts/tracking-coverage.mjs";
import { rig, tone } from "./helpers";

const touched = { launcher: new Set<string>(), clip: new Set<string>(), track: new Set<string>(), scene: new Set<string>() };

function make() {
  const { ctx, clock } = rig(2);
  const launcher = watch(
    new ClipLauncher(
      {
        a: [
          { buffer: tone(ctx, 200), loop: true },
          { buffer: tone(ctx, 300), mode: "toggle" },
        ],
        b: [{ buffer: tone(ctx, 400) }],
      },
      { context: ctx, scenes: [{ tempo: 100 }] },
    ),
    touched.launcher,
  );
  clock.attach(launcher);
  clock.start(0.1, 0);
  const track = watch(launcher.tracks.a!, touched.track);
  const clip = watch(track.clips[0]!, touched.clip);
  return { ctx, clock, launcher, track, clip };
}

async function expectTracked(read: () => unknown, mutate: () => void) {
  const seen: unknown[] = [];
  const stop = effect(() => void seen.push(read()));
  const first = seen[0];
  try {
    mutate();
  } finally {
    stop();
  }
  expect(seen.length).toBeGreaterThan(1);
  expect(Object.is(seen[seen.length - 1], first)).toBe(false);
}

describe("commands called inside an effect do not subscribe it", () => {
  test("ClipLauncher commands and the clock-facing hooks", () => {
    const { ctx, clock, launcher, clip } = make();
    let runs = 0;
    const stop = effect(() => {
      runs++;
      launcher.launchScene(0);
      launcher.launchScene([clip]);
      launcher.playChain([0]);
      launcher.insertScene(1);
      launcher.removeScene(1);
      launcher.stopAll();
      launcher.cancelQueued();
      const onStarted = () => {};
      launcher.addEventListener("started", onStarted);
      launcher.removeEventListener("started", onStarted);
      launcher.schedule({ beat: { start: 0, end: 0.2 }, time: { current: 0 }, own() {} }, clock.timeline);
      launcher.transport({ type: "tempo", when: 0, beat: 0 });
      launcher.reset("pause");
      launcher.attached({
        ...(clock as never),
        timeline: clock.timeline,
        state: clock.state,
        meter: clock.meter,
        refresh() {},
        cancelFrom() {},
        detach() {},
      });
    });
    launcher.launchScene(0);
    launcher.cancelQueued();
    launcher.dispose();
    stop();
    expect(runs).toBe(1);
    void ctx;
  });

  test("Clip commands and readers that are not tracked", () => {
    const { launcher, clip } = make();
    let runs = 0;
    const stop = effect(() => {
      runs++;
      clip.launch();
      clip.release();
      clip.configure({ name: "x" });
      clip.cancelQueued();
      void clip.position;
    });
    clip.launch();
    clip.configure({ name: "y" });
    stop();
    expect(runs).toBe(1);
    launcher.dispose();
  });

  test("Track commands", () => {
    const { ctx, launcher, track } = make();
    let runs = 0;
    const stop = effect(() => {
      runs++;
      track.stop();
      track.cancelQueued();
      track.setClip(2, { buffer: tone(ctx, 500) });
      track.setClip(2, null);
      track.connect(ctx.destination);
      track.disconnect();
      void track.clips;
    });
    track.setClip(2, { buffer: tone(ctx, 500) });
    stop();
    expect(runs).toBe(1);
    launcher.dispose();
  });
});

describe("public readers are tracked", () => {
  test("clip.options, name, mode, duration and lengthBeats follow configure", async () => {
    const { launcher, clip } = make();
    await expectTracked(
      () => clip.options.value,
      () => clip.configure({ quantize: "4n" }),
    );
    await expectTracked(
      () => clip.name,
      () => clip.configure({ name: "kick" }),
    );
    await expectTracked(
      () => clip.mode,
      () => clip.configure({ mode: "gate" }),
    );
    await expectTracked(
      () => clip.lengthBeats,
      () => clip.configure({ length: "2m" }),
    );
    await expectTracked(
      () => clip.duration,
      () => clip.configure({ length: "1m" }),
    );
    launcher.dispose();
  });

  test("queued and playing cells follow a launch", async () => {
    const { launcher, track, clip } = make();
    await expectTracked(
      () => clip.queued.value,
      () => clip.launch({ quantize: "2m" }),
    );
    await expectTracked(
      () => launcher.queued.value.length,
      () => clip.cancelQueued(),
    );
    await expectTracked(
      () => track.queued.value,
      () => track.clips[1]!.launch({ quantize: "2m" }),
    );
    await expectTracked(
      () => launcher.chain.value,
      () => launcher.playChain([0, 1]),
    );
    await expectTracked(
      () => launcher.quantize.value,
      () => (launcher.quantize.value = "2m"),
    );
    const scene = watch(launcher.scenes[0]!, touched.scene);
    await expectTracked(
      () => scene.name,
      () => scene.rename("Renamed"),
    );
    await expectTracked(
      () => launcher.scenes.length,
      () => launcher.insertScene(1),
    );
    await expectTracked(
      () => launcher.scenes.map((s) => s.name).join(),
      () => launcher.moveScene(0, 1),
    );
    await expectTracked(
      () => launcher.scenes[0]!.tempo.value,
      () => (launcher.scenes[0]!.tempo.value = 90),
    );
    await expectTracked(
      () => clip.gainDb.value,
      () => (clip.gainDb.value = -3),
    );
    await expectTracked(
      () => clip.pitch.value,
      () => (clip.pitch.value = 2),
    );
    launcher.dispose();
  });
});

describe("every public member of a tracked class is covered", () => {
  test.each([
    ["ClipLauncher", ClipLauncher, touched.launcher, {}],
    ["Clip", Clip, touched.clip, {}],
    ["Track", Track, touched.track, {}],
    ["Scene", Scene, touched.scene, {}],
  ] as const)("%s", (_name, ctor, seen, excluded) => {
    expect(coverageGaps(ctor, launcherSourceModule.default, seen, excluded)).toEqual([]);
  });
});
