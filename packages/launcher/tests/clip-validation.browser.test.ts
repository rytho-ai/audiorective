import { describe, expect, test } from "vitest";
import { ClipLauncher } from "../src/ClipLauncher";
import { driveOffline } from "./offline";
import { freq, near, rig, tone } from "./helpers";

describe("live clip gain and pitch", () => {
  test("NaN and infinite gain are refused; -Infinity mutes", () => {
    const { ctx } = rig(1);
    const l = new ClipLauncher({ t: [{ buffer: tone(ctx, 200) }] }, { context: ctx });
    const clip = l.tracks.t!.clips[0]!;
    expect(() => (clip.gainDb.value = NaN)).toThrow("Clip Launcher requires a gainDb that gives a finite gain (-Infinity mutes), got NaN.");
    expect(() => (clip.gainDb.value = Infinity)).toThrow(RangeError);
    expect(clip.gainDb.value).toBe(0);
    clip.gainDb.value = -Infinity;
    expect(clip.gainDb.value).toBe(-Infinity);
    expect(() => new ClipLauncher({ t: [{ buffer: tone(ctx, 200), pitch: NaN }] }, { context: ctx })).toThrow(RangeError);
    l.dispose();
  });

  test("a NaN pitch during playback is refused and the clip then plays exactly as if it was never tried", async () => {
    const play = async (tryNaN: boolean) => {
      const { ctx, ticks, clock } = rig(3);
      const l = new ClipLauncher({ t: [{ buffer: tone(ctx, 200), quantize: "none" }] }, { context: ctx });
      clock.attach(l);
      const clip = l.tracks.t!.clips[0]!;
      const errors: unknown[] = [];
      const out = await driveOffline(
        ctx,
        ticks,
        [
          { at: 0.2, run: () => clip.launch() },
          {
            at: 0.8,
            run: () => {
              if (!tryNaN) return;
              try {
                clip.pitch.value = NaN;
              } catch (error) {
                errors.push(error);
              }
            },
          },
          { at: 1.2, run: () => (clip.pitch.value = 12) },
        ],
        () => clock.start(0.1, 0),
      );
      expect(clip.pitch.value).toBe(12);
      l.dispose();
      return { out, errors };
    };
    const tried = await play(true);
    const control = await play(false);
    expect(tried.errors).toHaveLength(1);
    expect(tried.errors[0]).toBeInstanceOf(RangeError);
    // Before the fix the NaN corrupted the playing instance and the later pitch write threw.
    for (const [t0, t1] of [
      [0.9, 1.1],
      [1.5, 1.8],
      [2.2, 2.6],
    ] as const) {
      const f = freq(control.out, t0, t1);
      expect(f).toBeGreaterThan(0);
      near(freq(tried.out, t0, t1), f, 0.001);
    }
  });
});
