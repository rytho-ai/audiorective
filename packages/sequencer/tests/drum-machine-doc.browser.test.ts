// Mirrors the "Standalone drum machine" example in docs/sequencer.md. The wiring is
// identical except for the DOM-only grid (`mountStepGrid`), buffers synthesized
// in place of decoded files, and the test's own assertions.
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

async function drumMachine() {
  const context = new AudioContext();
  disposers.push(() => context.close());
  await context.resume();
  const silent = (seconds: number) => context.createBuffer(1, Math.ceil(context.sampleRate * seconds), context.sampleRate);
  const [kick, snare, closedHat, openHat] = [silent(0.1), silent(0.1), silent(0.05), silent(3)];

  // ---- begin: same code as docs/sequencer.md ----
  const bank = new PadBank(context, [
    { id: "kick", sound: kick },
    { id: "snare", sound: snare },
    { id: "closed", sound: closedHat, group: "hat" },
    { id: "open", sound: openHat, group: "hat" }, // the open hat rings until a later closed hit chokes it
  ]);
  bank.connect(context.destination);

  const sequencer = new StepSequencer(
    {
      kick: "X...X...X...X...",
      snare: "....X.......X...",
      closed: "X...X...X...X...",
      open: "..X.......X.....",
    },
    {
      onHit: (hit) => {
        const voice = bank.trigger(hit.lane, { velocity: hit.velocity, when: hit.when, pitch: hit.pitch });
        return () => voice?.stop(); // runs if the hit is retracted before it sounds
      },
    },
  );
  const clock = new Clock({ context, bpm: 120 });
  clock.attach(sequencer); // every edit re-queues the look-ahead
  // ---- end: same code as docs/sequencer.md ----

  disposers.push(() => {
    sequencer.dispose();
    clock.dispose();
    bank.dispose();
  });
  return { context, bank, sequencer, clock };
}

test("hits fire at step times with pattern velocities", async () => {
  const { bank, clock, sequencer } = await drumMachine();
  const spy = vi.spyOn(bank, "trigger");
  clock.start();
  await until(() => spy.mock.calls.length >= 12);
  const calls = spy.mock.calls.map(([id, options]) => ({ id, velocity: options!.velocity, when: options!.when! }));
  // Step 0 may have started before the first window and plays "now", so anchor on the snare at step 4.
  const first = calls.find((c) => c.id === "snare")!.when - 4 * 0.125;
  const at = (id: string, step: number) => calls.find((c) => c.id === id && Math.abs(c.when - (first + step * 0.125)) < 1e-6);
  expect(at("closed", 4)?.velocity).toBe(1);
  expect(at("open", 2)?.velocity).toBe(1);
  expect(at("kick", 8)).toBeDefined();
  expect(at("snare", 4)).toBeDefined();
  expect(at("snare", 2)).toBeUndefined();
  expect(sequencer.lanes.kick.playhead).not.toBeNull();
  clock.bpm.value = 140;
  expect(clock.bpm.value).toBe(140);
  clock.stop();
});

/**
 * Plays open hat (step 2) then closed hat (step 4); optionally deletes the scheduled closed hat first.
 * Everything waits on the audio clock. The deletion only counts when it happens while the audio clock is
 * still safely before the step's time; if load made the test arrive too late, returns `null` (retry).
 */
async function openHatEndedAfterStep4(deleteClosed: boolean) {
  const { bank, sequencer, clock, context } = await drumMachine();
  const spy = vi.spyOn(bank, "trigger");
  clock.start();
  const call = (lane: string, nth: number) => spy.mock.calls.filter(([id]) => id === lane)[nth];
  // closed #0 is step 0, closed #1 is step 4; open #0 is step 2
  await until(() => call("closed", 1) !== undefined);
  const when = call("closed", 1)![1]!.when!;
  const open = spy.mock.results[spy.mock.calls.findIndex(([id]) => id === "open")].value as Voice;
  let ended = false;
  open.playing.subscribe((playing) => playing || (ended = true));

  if (deleteClosed) {
    // The edit is synchronous, so checking the audio clock right before it is race-free.
    if (context.currentTime > when - SAFE_MARGIN) return null;
    // ---- begin: same code as docs/sequencer.md ----
    sequencer.lanes.closed.steps[4].velocity = 0;
    // ---- end: same code as docs/sequencer.md ----
  } else {
    expect(when).toBeGreaterThan(context.currentTime);
  }

  await until(() => context.currentTime > when + 0.5);
  if (!deleteClosed) await until(() => ended);
  return { ended, closedAfter: spy.mock.calls.filter(([id, options]) => id === "closed" && Math.abs(options!.when! - when) < 1e-6).length };
}

/** Margin (s) the audio clock must leave before the step so the edit cannot lose the race. */
const SAFE_MARGIN = 0.03;

async function settled(deleteClosed: boolean) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const result = await openHatEndedAfterStep4(deleteClosed);
    if (result) return result;
    for (const dispose of disposers.splice(0).reverse()) await dispose();
  }
  throw new Error("audio clock was never early enough to edit before the step");
}

test("control: the closed hat at step 4 chokes the open hat", async () => {
  expect(await settled(false)).toEqual({ ended: true, closedAfter: 1 });
});

test("deleting a scheduled closed-hat step before it plays leaves the open hat sounding", async () => {
  const result = await settled(true);
  expect(result.ended).toBe(false);
});
