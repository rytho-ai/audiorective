import { expect, test } from "vitest";
import { Clock } from "../src/Clock";
import { Timeline } from "../src/Timeline";
import { ManualTickSource } from "../src/TickSource";

test("Play starts once, resumes pause and preserves existing playback and queued ownership", () => {
  const context = { currentTime: 0 };
  const ticks = new ManualTickSource();
  const clock = new Clock({ timeline: new Timeline({ audioContext: context, bpm: 120 }), tickSource: ticks });
  const changes: string[] = [];
  let cancelled = 0;
  clock.attach({
    schedule(window) {
      window.own(
        {
          cancel() {
            cancelled++;
          },
          onEnded() {},
        },
        context.currentTime + 0.05,
      );
    },
    reset(reason) {
      changes.push(reason);
    },
  });
  try {
    clock.play();
    expect(clock.state.value).toBe("playing");
    clock.seek(8);
    ticks.tick();
    cancelled = 0;
    changes.length = 0;
    clock.play();
    clock.play();
    expect(clock.beat).toBe(8);
    expect(cancelled).toBe(0);
    expect(changes).toEqual([]);
    clock.pause();
    context.currentTime = 5;
    changes.length = 0;
    clock.play();
    expect(clock.beat).toBe(8);
    expect(clock.state.value).toBe("playing");
    expect(changes).toEqual([]);
    clock.start();
    expect(clock.beat).toBe(0);
    expect(changes).toEqual(["start"]);
  } finally {
    clock.dispose();
  }
});
