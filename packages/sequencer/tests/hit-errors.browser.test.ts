import { afterEach, describe, expect, test, vi } from "vitest";
import type { BeatTiming, CancellableEvent } from "@audiorective/core";
import { StepSequencer, type StepWindow } from "../src/StepSequencer";

const timing: BeatTiming = { beatToTime: (beat) => 10 + beat * 0.5, timeToBeat: (time) => (time - 10) * 2 };
const run = (sequencer: StepSequencer, start: number, end: number) => {
  const owned: CancellableEvent[] = [];
  const window: StepWindow = { beat: { start, end }, time: { current: timing.beatToTime(start) }, own: (event) => void owned.push(event) };
  sequencer.schedule(window, timing);
  return owned;
};

afterEach(() => vi.restoreAllMocks());

describe("sequencer.error", () => {
  test("holds an onHit error; the other hits still fire and are announced", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const boom = new Error("onHit broke");
    const fired: number[] = [];
    const sequencer = new StepSequencer(
      { a: "XXXX" },
      {
        onHit: (hit) => {
          fired.push(hit.index);
          if (hit.index === 1) throw boom;
        },
      },
    );
    const announced: number[] = [];
    sequencer.addEventListener("hit", (event) => announced.push((event as Event & { hit: { index: number } }).hit.index));
    expect(sequencer.error.value).toBeNull();
    run(sequencer, 0, 1);
    expect(sequencer.error.value).toBe(boom);
    expect(fired).toEqual([0, 1, 2, 3]);
    expect(announced).toEqual([0, 1, 2, 3]);
    sequencer.dispose();
  });

  test("holds a lane sound's failure and wraps a thrown non-Error", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const context = new OfflineAudioContext(1, 4410, 44100);
    const sequencer = new StepSequencer(
      {
        a: {
          pattern: "X...",
          sound: () => {
            throw 42;
          },
        },
      },
      { context },
    );
    run(sequencer, 0, 1);
    expect(sequencer.error.value?.message).toBe("Step Sequencer hit failed.");
    expect(sequencer.error.value?.cause).toBe(42);
    expect(console.error).toHaveBeenCalledWith("Step Sequencer sound failed:", 42);
    sequencer.dispose();
  });
});
