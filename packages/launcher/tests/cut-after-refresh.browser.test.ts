import { describe, expect, test } from "vitest";
import type { BeatTiming, CancellableEvent } from "@audiorective/core";
import { ClipLauncher } from "../src/ClipLauncher";
import type { ClipScheduler, TransportWindow } from "../src/types";
import { driveOffline } from "./offline";
import { r3, rig } from "./helpers";

// 120 bpm, transport beat 0 at 0.1 s: a beat is 0.5 s, a bar 2 s.
const start = (clock: { start(when?: number, offsetBeats?: number): void }) => () => clock.start(0.1, 0);

/** A scheduler that holds one note per window for far longer than the window: every event it registers can be cut. */
function holder() {
  const events: Array<{ registeredAt: number; cuts: number[] }> = [];
  const scheduler: ClipScheduler = {
    schedule(window: TransportWindow, timing: BeatTiming) {
      const entry = { registeredAt: window.time.current, cuts: [] as number[] };
      events.push(entry);
      const event: CancellableEvent = { cancel: (time?: number) => void entry.cuts.push(r3(time ?? NaN)!), onEnded: () => {} };
      window.own(event, timing.beatToTime(window.beat.end + 100));
    },
  };
  return { scheduler, events };
}

describe("a scheduler clip's note is cut where its track stops", () => {
  test.each([1.9, 2.0, 2.05, 2.08])("the cut reaches the events a clock refresh at %f s registers again", async (refreshAt) => {
    const { ctx, ticks, clock } = rig(4);
    const { scheduler, events } = holder();
    const launcher = new ClipLauncher({ a: [{ scheduler, loop: true, length: "4m" }] }, { context: ctx });
    clock.attach(launcher);
    let stopped = 0;
    await driveOffline(
      ctx,
      ticks,
      [
        { at: 0.1, run: () => launcher.tracks.a!.clips[0]!.launch({ quantize: "none" }) },
        {
          at: 1.0,
          run: () => {
            launcher.tracks.a!.stop({ quantize: "1m" }); // the boundary is 2.1 s
            stopped = events.length;
          },
        },
        // a refresh before the boundary: the clock retracts everything and the scheduler registers its notes again
        { at: refreshAt, run: () => clock.refresh() },
      ],
      start(clock),
    );
    const afterRefresh = events.filter((event) => event.registeredAt >= refreshAt - 0.01);
    expect(afterRefresh.length).toBeGreaterThan(0);
    expect(events.length).toBeGreaterThan(stopped);
    for (const event of afterRefresh) expect(event.cuts, `registered at ${event.registeredAt}`).toContain(2.1);
    launcher.dispose();
  });
});
