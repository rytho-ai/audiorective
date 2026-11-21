import { describe, expect, test } from "vitest";
import { ClipLauncher } from "../src/ClipLauncher";
import { driveOffline } from "./offline";
import { freq, near, onset, r3, record, rig, tone } from "./helpers";

// 120 bpm, transport beat 0 at 0.1 s: a beat is 0.5 s, a bar 2 s. tone(): material beat b sounds at base * (1 + b / 16).
const start = (clock: { start(when?: number, offsetBeats?: number): void }) => () => clock.start(0.1, 0);

describe("clip.launch({ at })", () => {
  test("a beat already past starts now at the phase the clip would have reached", async () => {
    const { ctx, ticks, clock } = rig(6);
    const launcher = new ClipLauncher({ t: [{ buffer: tone(ctx, 200) }] }, { context: ctx });
    clock.attach(launcher);
    const log = record(launcher, ["started"]);
    const clip = launcher.tracks.t!.clips[0]!;
    const out = await driveOffline(ctx, ticks, [{ at: 2.8, run: () => clip.launch({ at: 4 }) }], start(clock));
    const started = log[0]!;
    const nowBeat = (started.when! - 0.1) * 2;
    expect(started.when!).toBeLessThan(2.85); // now, not the next bar
    expect(started.off!).toBeCloseTo(nowBeat - 4, 3); // elapsed beats since beat 4
    expect(started.off!).toBeGreaterThan(1.3);
    near(freq(out, started.when! + 0.02, started.when! + 0.25), 200 * (1 + 1 / 16), 0.01); // material beat 1, not beat 0
    launcher.dispose();
  });

  test("the phase wraps inside a loop", async () => {
    const { ctx, ticks, clock } = rig(12);
    const launcher = new ClipLauncher({ t: [{ buffer: tone(ctx, 200), loop: true }] }, { context: ctx });
    clock.attach(launcher);
    const log = record(launcher, ["started"]);
    const clip = launcher.tracks.t!.clips[0]!;
    const out = await driveOffline(ctx, ticks, [{ at: 9.5, run: () => clip.launch({ at: 0 }) }], start(clock));
    const nowBeat = (log[0]!.when! - 0.1) * 2; // about 18.8; the loop is 16 beats
    expect(log[0]!.off!).toBeCloseTo(nowBeat - 16, 3);
    near(freq(out, log[0]!.when! + 0.01, log[0]!.when! + 0.09), 200 * (1 + 2 / 16), 0.01);
    launcher.dispose();
  });

  test("a beat still ahead starts there, from the clip's offsetBeats", async () => {
    const { ctx, ticks, clock } = rig(6);
    const launcher = new ClipLauncher({ t: [{ buffer: tone(ctx, 200), offsetBeats: 2 }] }, { context: ctx });
    clock.attach(launcher);
    const log = record(launcher, ["started"]);
    const clip = launcher.tracks.t!.clips[0]!;
    const out = await driveOffline(ctx, ticks, [{ at: 2.8, run: () => clip.launch({ at: 6 }) }], start(clock));
    expect(r3(log[0]!.when)).toBe(3.1);
    expect(log[0]!.off!).toBeCloseTo(2, 6);
    expect(onset(out)).toBeCloseTo(3.1, 2);
    launcher.dispose();
  });
});
