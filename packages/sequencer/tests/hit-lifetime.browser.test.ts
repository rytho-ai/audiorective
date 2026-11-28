// Pins the hit lifetime stated in docs/sequencer.md ("Cleanup"): a hit is the sequencer's until its step ends.
import { afterEach, expect, test, vi } from "vitest";
import { Clock } from "@audiorective/clock";
import type { Voice } from "@audiorective/core";
import { PadBank } from "@audiorective/pads";
import { StepSequencer } from "../src/StepSequencer";

const disposers: Array<() => void | Promise<unknown>> = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0).reverse()) await dispose();
});
const until = (condition: () => boolean, ms = 4000) => vi.waitFor(() => expect(condition()).toBe(true), { timeout: ms, interval: 10 });

/** A 3 s sample triggered by `onHit` on a sixteenth step (0.125 s at 120 BPM), paused at `offset` seconds after it starts. */
async function pauseAt(offset: number) {
  const context = new AudioContext();
  disposers.push(() => context.close());
  await context.resume();
  const bank = new PadBank(context, [{ id: "a", sound: context.createBuffer(1, context.sampleRate * 3, context.sampleRate) }]);
  bank.connect(context.destination);
  let voice: Voice | null = null;
  let when = 0;
  let cleanups = 0;
  const sequencer = new StepSequencer(
    { a: "X..............." },
    {
      onHit: (hit) => {
        when = hit.when;
        voice = bank.trigger("a", { when: hit.when });
        return () => {
          cleanups++;
          voice?.stop();
        };
      },
    },
  );
  const clock = new Clock({ context, bpm: 120 });
  clock.attach(sequencer);
  disposers.push(() => {
    sequencer.dispose();
    clock.dispose();
    bank.dispose();
  });
  clock.start();
  await until(() => voice !== null);
  await until(() => context.currentTime >= when + offset);
  clock.pause();
  return { cleanups, playing: voice!.playing.value };
}

test("a pause inside the step runs the cleanup, even though the hit already sounds", async () => {
  expect(await pauseAt(0.04)).toEqual({ cleanups: 1, playing: false });
});

test("after the step end the sequencer lets go: a pause leaves a longer voice ringing", async () => {
  expect(await pauseAt(0.3)).toEqual({ cleanups: 0, playing: true });
});
