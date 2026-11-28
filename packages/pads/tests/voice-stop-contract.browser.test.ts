import { expect, test } from "vitest";
import { PadBank } from "../src/PadBank";

test("a later pending Stop replaces the earlier one like a core Voice", async () => {
  const context = new OfflineAudioContext(1, 28800, 48000);
  const bank = new PadBank(context, [{ id: "tone", sound: (ctx) => new ConstantSourceNode(ctx) }], { release: 0.01 });
  bank.output.connect(context.destination);
  const voice = bank.trigger("tone")!;
  voice.stop(0.1);
  voice.stop(0.4);
  try {
    const data = (await context.startRendering()).getChannelData(0);
    expect(data[9600]).toBeCloseTo(1, 5);
    expect(data[24000]).toBe(0);
  } finally {
    bank.dispose();
  }
});

test("a Stop after a committed release does not restart its tail", async () => {
  const context = new OfflineAudioContext(1, 28800, 48000);
  const bank = new PadBank(context, [{ id: "tone", sound: (ctx) => new ConstantSourceNode(ctx) }], { release: 0.2 });
  bank.output.connect(context.destination);
  const voice = bank.trigger("tone")!;
  voice.stop(0.1);
  const edit = context.suspend(0.15).then(() => {
    voice.stop(0.4);
    return context.resume();
  });
  try {
    const data = (await context.startRendering()).getChannelData(0);
    await edit;
    expect(data[9600]).toBeCloseTo(0.5, 2);
    expect(data[24000]).toBe(0);
  } finally {
    bank.dispose();
  }
});
