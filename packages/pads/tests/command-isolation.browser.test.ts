import { expect, test } from "vitest";
import { effect, type Voice } from "@audiorective/core";
import { PadBank } from "../src/PadBank";

test("a scheduled pad starting does not retrigger the effect that issued the command", async () => {
  const context = new AudioContext();
  await context.resume();
  const bank = new PadBank(context, [{ id: "tone", sound: (ctx) => new ConstantSourceNode(ctx) }]);
  const voices: Voice[] = [];
  let runs = 0;
  const stop = effect(() => {
    runs++;
    // Bound a broken implementation without hiding its second execution.
    if (runs <= 2) voices.push(bank.trigger("tone", { when: context.currentTime + 0.04 })!);
  });
  try {
    await expect.poll(() => voices[0].started.value).toBe(true);
    expect(runs).toBe(1);
    expect(voices).toHaveLength(1);
  } finally {
    stop();
    bank.dispose();
    await context.close();
  }
});
