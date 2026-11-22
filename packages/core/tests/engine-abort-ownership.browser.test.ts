import { expect, test } from "vitest";
import { AudioProcessor, cell, createEngine, type GraphHandle, type Param } from "../src";

class OwnedProcessor extends AudioProcessor<{ volume: Param<number> }> {
  readonly node: GainNode;
  constructor(context: AudioContext) {
    const node = new GainNode(context, { gain: 0.5 });
    super(context, ({ param }) => ({
      params: { volume: param({ default: 0.5, bind: { get: () => node.gain.value, set: (value) => (node.gain.value = value) } }) },
    }));
    this.node = node;
  }
  get output(): GainNode {
    return this.node;
  }
}

test.each(["before setup", "during setup"])("aborting %s releases processors and graphs returned afterwards", async (when) => {
  const context = new AudioContext();
  const controller = new AbortController();
  const enabled = cell(true);
  let graph!: GraphHandle;
  if (when === "before setup") controller.abort();
  const engine = createEngine(
    (ctx, { defineGraph }) => {
      const processor = new OwnedProcessor(ctx);
      if (when === "during setup") controller.abort();
      graph = defineGraph(() => (enabled.value ? [[processor, ctx.destination]] : []));
      return { processor };
    },
    { context, signal: controller.signal },
  );
  try {
    const solved = graph.snapshot().solveId;
    engine.processor.params.volume.value = 0.25;
    enabled.value = false;
    expect({
      engineState: engine.core.state.value,
      ownedVolume: engine.processor.node.gain.value,
      graphUpdated: graph.snapshot().solveId !== solved,
    }).toEqual({ engineState: "closed", ownedVolume: 0.5, graphUpdated: false });
    expect(context.state).not.toBe("closed");
  } finally {
    graph.dispose();
    engine.processor.dispose();
    engine.core.dispose();
    await context.close();
  }
});
