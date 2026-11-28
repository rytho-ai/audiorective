import { expect, test } from "vitest";
import { AudioProcessor } from "../src";

class PassThrough extends AudioProcessor<{}, {}> {
  readonly node: GainNode;
  constructor(context: BaseAudioContext) {
    const node = new GainNode(context);
    super(context, () => ({ params: {}, cells: {} }));
    this.node = node;
  }
  get input() {
    return this.node;
  }
  get output() {
    return this.node;
  }
}

test.each([false, true])("disconnect(input) retracts connect(processor) and vice versa (nativeConnect=%s)", async (nativeConnect) => {
  const context = new OfflineAudioContext(1, 4800, 48000);
  const a = new PassThrough(context),
    b = new PassThrough(context);
  const source = new ConstantSourceNode(context, { offset: 1 });
  source.connect(a.input);
  source.start();
  b.connect(context.destination);
  a.connect(nativeConnect ? b.input : b);
  a.disconnect(nativeConnect ? b : b.input);
  try {
    const samples = (await context.startRendering()).getChannelData(0);
    expect(Math.max(...samples.map(Math.abs))).toBe(0);
  } finally {
    a.dispose();
    b.dispose();
  }
});
