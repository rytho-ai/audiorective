import { describe, expect, test } from "vitest";
import type { SoundFactory, SoundHit } from "@audiorective/core";
import { ClipLauncher } from "../src/ClipLauncher";
import { driveOffline } from "./offline";
import { onset, peakIn, record, rig, tone } from "./helpers";

// 120 bpm, transport beat 0 at 0.1 s: a beat is 0.5 s, a bar 2 s.
const start = (clock: { start(when?: number, offsetBeats?: number): void }) => () => clock.start(0.1, 0);

/** Two held sources summed by a gain: 0.2 + 0.3 = 0.5 while the voice sounds. */
const pair: SoundFactory = (ctx) => {
  const a = new ConstantSourceNode(ctx, { offset: 0.2 });
  const b = new ConstantSourceNode(ctx, { offset: 0.3 });
  const mix = new GainNode(ctx);
  a.connect(mix);
  b.connect(mix);
  return { output: mix, sources: [a, b] };
};

describe("sound clips", () => {
  test("a factory clip is played by the launcher: started at the boundary, held for its length, every source stopped at the end", async () => {
    const { ctx, ticks, clock } = rig(5);
    const seen: SoundHit[] = [];
    const launcher = new ClipLauncher(
      {
        t: [
          {
            sound: (context, hit) => (seen.push(hit), pair(context, hit)),
            length: "1m",
            quantize: "4n",
            pitch: 3,
          },
        ],
      },
      { context: ctx },
    );
    clock.attach(launcher);
    const log = record(launcher, ["started", "ended"]);
    const out = await driveOffline(ctx, ticks, [{ at: 0.7, run: () => launcher.tracks.t!.clips[0]!.launch() }], start(clock));
    expect(seen).toHaveLength(1);
    expect(seen[0]!.pitch).toBe(3);
    expect(seen[0]!.velocity).toBe(1);
    expect(seen[0]!.duration).toBeCloseTo(2, 3);
    expect(peakIn(out, 0, 1.05)).toBe(0);
    expect(onset(out)).toBeCloseTo(1.1, 2);
    expect(peakIn(out, 1.2, 3.0)).toBeCloseTo(0.5, 2);
    expect(peakIn(out, 3.2, 5)).toBe(0);
    expect(log.map((event) => event.type)).toEqual(["started", "ended"]);
    launcher.dispose();
  });

  test("a looping factory clip is held until it is stopped, then faded out", async () => {
    const { ctx, ticks, clock } = rig(5);
    const durations: number[] = [];
    const launcher = new ClipLauncher(
      { t: [{ sound: (context, hit) => (durations.push(hit.duration), pair(context, hit)), loop: true, length: "1m", quantize: "4n" }] },
      { context: ctx },
    );
    clock.attach(launcher);
    const out = await driveOffline(
      ctx,
      ticks,
      [
        { at: 0.7, run: () => launcher.tracks.t!.clips[0]!.launch() },
        { at: 3.2, run: () => launcher.tracks.t!.stop({ quantize: "4n" }) },
      ],
      start(clock),
    );
    expect(durations).toEqual([Infinity]);
    expect(peakIn(out, 1.2, 3.5)).toBeCloseTo(0.5, 2);
    expect(peakIn(out, 3.8, 5)).toBe(0);
    launcher.dispose();
  });

  test("a buffer given as `sound` plays like a buffer clip", async () => {
    const { ctx, ticks, clock } = rig(5);
    const launcher = new ClipLauncher({ t: [{ sound: tone(ctx, 200, 2), quantize: "4n" }] }, { context: ctx });
    clock.attach(launcher);
    const out = await driveOffline(ctx, ticks, [{ at: 0.7, run: () => launcher.tracks.t!.clips[0]!.launch() }], start(clock));
    expect(onset(out)).toBeCloseTo(1.1, 2);
    expect(peakIn(out, 1.2, 1.9)).toBeGreaterThan(0.1);
    expect(peakIn(out, 2.3, 5)).toBe(0);
    launcher.dispose();
  });

  test("a clip needs an AudioBuffer or a sound factory", () => {
    const { ctx } = rig(1);
    expect(() => new ClipLauncher({ t: [{ sound: "C4" as never }] }, { context: ctx })).toThrow(
      "Sound needs an AudioBuffer or a sound factory function.",
    );
  });
});
