import { describe, expect, test } from "vitest";
import { ClipLauncher } from "../src/ClipLauncher";
import { driveOffline } from "./offline";
import { r3, record, rig, tone } from "./helpers";

// 120 bpm, transport beat 0 at 0.1 s: a beat is 0.5 s, a bar 2 s.
const start = (clock: { start(when?: number, offsetBeats?: number): void }) => () => clock.start(0.1, 0);

describe("a repeating clip and a waiting launch", () => {
  test("every retrigger leaves the track's waiting launch queued, and it starts at its own boundary", async () => {
    const { ctx, ticks, clock } = rig(5);
    const launcher = new ClipLauncher(
      {
        t: [
          { buffer: tone(ctx, 200), mode: "repeat", repeatBeats: 1, loop: true },
          { buffer: tone(ctx, 300), loop: true },
        ],
      },
      { context: ctx },
    );
    clock.attach(launcher);
    const log = record(launcher, ["started", "cancelled"]);
    const track = launcher.tracks.t!;
    const waiting: Array<string | null> = [];
    // the repeat fires on every beat (0.5 s): sample what waits just after each retrigger inside the first bar
    const sample = (at: number) => ({
      at,
      run: () => waiting.push(track.queued.value ? `${track.queued.value.clip!.index}@${r3(track.queued.value.when)}` : null),
    });
    await driveOffline(
      ctx,
      ticks,
      [
        { at: 0.1, run: () => track.clips[0]!.launch({ quantize: "none" }) },
        { at: 0.3, run: () => track.clips[1]!.launch({ quantize: "1m" }) }, // waits for the bar at 2.1 s
        sample(0.7),
        sample(1.2),
        sample(1.7),
      ],
      start(clock),
    );
    expect(waiting).toEqual(["1@2.1", "1@2.1", "1@2.1"]);
    const repeats = log.filter((event) => event.type === "started" && event.clip === 0).map((event) => r3(event.when));
    expect(repeats).toEqual([0.1, 0.6, 1.1, 1.6]);
    expect(log.filter((event) => event.type === "started" && event.clip === 1).map((event) => r3(event.when))).toEqual([2.1]);
    expect(log.filter((event) => event.type === "cancelled")).toEqual([]);
    // clip 0 does not retrigger once clip 1 has taken the track
    expect(repeats.filter((when) => when! >= 2.1)).toEqual([]);
    launcher.dispose();
  });
});
