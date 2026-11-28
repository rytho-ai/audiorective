import { expect, test } from "vitest";
import { Sampler } from "../src";

test("immediate Stop ends the public voice while its native nodes finish the release", async () => {
  const context = new OfflineAudioContext(1, 33600, 48000);
  const sampler = new Sampler(context, { sound: (ctx) => new ConstantSourceNode(ctx), release: 0.4 });
  sampler.output.connect(context.destination);
  const voice = sampler.trigger()!;
  let stopped: unknown;
  const edit = context.suspend(0.1).then(() => {
    voice.stop();
    stopped = { playing: voice.playing.value, activeVoices: sampler.cells.activeVoices.value };
    return context.resume();
  });
  try {
    const pcm = (await context.startRendering()).getChannelData(0);
    await edit;
    expect(stopped).toEqual({ playing: false, activeVoices: 0 });
    expect(pcm[2400]).toBeCloseTo(1, 5);
    expect(pcm[9600]).toBeCloseTo(0.75, 2);
    expect(pcm[28800]).toBe(0);
  } finally {
    sampler.dispose();
  }
});
