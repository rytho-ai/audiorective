import { expect, test } from "vitest";
import { PadBank } from "../src/PadBank";

test.each(["end-choking", "another-hit"])("a committed choke keeps fading when %s rebuilds the bank", async (action) => {
  const context = new OfflineAudioContext(1, 48000, 48000);
  const bank = new PadBank(
    context,
    [
      { id: "open", group: "hats", sound: (ctx) => new ConstantSourceNode(ctx, { offset: 1 }) },
      { id: "closed", group: "hats", sound: (ctx) => new ConstantSourceNode(ctx, { offset: 0 }) },
      { id: "other", sound: (ctx) => new ConstantSourceNode(ctx, { offset: 0 }) },
    ],
    { release: 0.6 },
  );
  bank.output.connect(context.destination);
  bank.trigger("open", { when: 0 });
  const closed = bank.trigger("closed", { when: 0.1 })!;
  const changed = context.suspend(0.3).then(() => {
    if (action === "end-choking") closed.stop();
    else bank.trigger("other");
    return context.resume();
  });
  try {
    const samples = (await context.startRendering()).getChannelData(0);
    await changed;
    expect(samples[12000]).toBeCloseTo(0.75, 3);
    expect(samples[16800]).toBeCloseTo(7 / 12, 3);
    expect(samples[36000]).toBe(0);
  } finally {
    bank.dispose();
  }
});
