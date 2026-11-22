import { expect, test } from "vitest";
import { Effect, EffectChain } from "../src";

class Unity extends Effect<{}> {
  constructor(context: AudioContext) {
    const node = new GainNode(context);
    super(context, { input: node, output: node }, () => ({ params: {}, cells: {} }));
  }
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test.each(["add", "remove"])("%s keeps native audio continuous across a suspended crossfade", async (edit) => {
  const context = new AudioContext();
  const unity = new Unity(context);
  const chain = new EffectChain(context, edit === "remove" ? [unity] : []);
  const source = new ConstantSourceNode(context, { offset: 0.25 });
  const monitor = context.createScriptProcessor(256, 1, 1);
  const samples: number[] = [];
  let capture = false;
  monitor.onaudioprocess = (event) => {
    if (capture) samples.push(...event.inputBuffer.getChannelData(0));
  };
  source.connect(chain.input);
  chain.output.connect(monitor).connect(context.destination);
  source.start();
  try {
    await context.resume();
    await delay(150);
    if (edit === "add") chain.add(unity);
    else chain.remove(unity);
    await context.suspend();
    const held = context.currentTime;
    capture = true;
    await delay(150);
    expect(context.currentTime).toBe(held);
    await context.resume();
    await delay(200);
    expect(samples.length).toBeGreaterThan(4096);
    expect(Math.min(...samples)).toBeGreaterThan(0.24);
    expect(Math.max(...samples)).toBeLessThan(0.26);
  } finally {
    monitor.onaudioprocess = null;
    chain.dispose();
    unity.dispose();
    source.stop();
    monitor.disconnect();
    await context.close();
  }
});
