// Mirrors the "Standalone drum machine" example in docs/blocks.md. The wiring is
// identical except for the DOM-only grid (`mountStepGrid`), buffers synthesized
// in place of decoded files, and the test's own assertions.
import { afterEach, expect, test, vi } from "vitest";
import { Clock, Timeline } from "@audiorective/clock";
import { InstrumentEvents } from "../src/InstrumentEvents";
import { StepSequencer, type StepPattern } from "../src/StepSequencer";

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

  // ---- begin: same code as docs/blocks.md ----
  const bank = new InstrumentEvents(context, [
    { id: "kick", buffer: kick },
    { id: "snare", buffer: snare },
    { id: "closed", buffer: closedHat, group: "hat" },
    { id: "open", buffer: openHat, group: "hat" },
  ]);
  bank.output.connect(context.destination);

  const steps = (...on: number[]) => Array.from({ length: 16 }, (_, step) => (on.includes(step) ? 1 : 0));
  const pattern: StepPattern = {
    steps: 16,
    beatsPerStep: 0.25,
    lanes: [
      { id: "kick", label: "Kick", velocities: steps(0, 4, 8, 12) },
      { id: "snare", label: "Snare", velocities: steps(4, 12) },
      { id: "closed", label: "Closed hat", velocities: steps(0, 4, 8, 12) },
      { id: "open", label: "Open hat", velocities: steps(2, 10) },
    ],
  };
  const sequencer = new StepSequencer(pattern, ({ laneId, velocity, when }) => bank.trigger(laneId, velocity, when));
  const timeline = new Timeline({ audioContext: context, bpm: 120 });
  const clock = new Clock({ timeline, onTick: (window) => sequencer.schedule(window, timeline) });
  // ---- end: same code as docs/blocks.md ----

  disposers.push(() => {
    clock.destroy();
    bank.destroy();
  });
  return { context, bank, sequencer, timeline, clock };
}

test("hits fire at step times with pattern velocities", async () => {
  const { bank, timeline, clock, sequencer } = await drumMachine();
  const spy = vi.spyOn(bank, "trigger");
  clock.start();
  await until(() => spy.mock.calls.length >= 6);
  const calls = spy.mock.calls.map(([id, velocity, when]) => ({ id, velocity, when: when! }));
  const first = calls.find((c) => c.id === "kick")!.when;
  const at = (id: string, step: number) => calls.find((c) => c.id === id && Math.abs(c.when - (first + step * 0.125)) < 1e-6);
  expect(at("closed", 0)?.velocity).toBe(1);
  expect(at("open", 2)?.velocity).toBe(1);
  expect(at("kick", 4)).toBeDefined();
  expect(at("snare", 4)).toBeDefined();
  expect(at("snare", 2)).toBeUndefined();
  expect(sequencer.currentStep.value).not.toBeNull();
  timeline.bpm.value = 140;
  expect(timeline.bpm.value).toBe(140);
  clock.stop();
});

/** Plays open hat (step 2) then closed hat (step 4); optionally deletes the scheduled closed hat first. */
async function openHatEndedAfterStep4(deleteClosed: boolean) {
  const { bank, sequencer, clock, context } = await drumMachine();
  const spy = vi.spyOn(bank, "trigger");
  clock.start();
  const call = (lane: string, nth: number) => spy.mock.calls.filter(([id]) => id === lane)[nth];
  // closed #0 is step 0, closed #1 is step 4; open #0 is step 2
  await until(() => call("closed", 1) !== undefined);
  const when = call("closed", 1)![2]!;
  expect(when).toBeGreaterThan(context.currentTime);
  const open = spy.mock.results[spy.mock.calls.findIndex(([id]) => id === "open")].value as { onEnded(l: () => void): void };
  let ended = false;
  open.onEnded(() => (ended = true));

  if (deleteClosed) {
    // ---- begin: same code as docs/blocks.md ----
    sequencer.setVelocity("closed", 4, 0);
    clock.refresh();
    // ---- end: same code as docs/blocks.md ----
  }

  await until(() => context.currentTime > when + 0.5);
  return { ended, closedAfter: spy.mock.calls.filter(([id, , w]) => id === "closed" && Math.abs(w! - when) < 1e-6).length };
}

test("control: the closed hat at step 4 chokes the open hat", async () => {
  expect(await openHatEndedAfterStep4(false)).toEqual({ ended: true, closedAfter: 1 });
});

test("deleting a scheduled closed-hat step before it plays leaves the open hat sounding", async () => {
  const result = await openHatEndedAfterStep4(true);
  expect(result.ended).toBe(false);
});
