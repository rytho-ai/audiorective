import { AudioProcessor, cell, readonlyCell, registerWorklet, type Cell, type ReadonlyCell, type SchedulableParam } from "@audiorective/core";
import { DUCKER_WORKLET, DUCKER_WORKLET_NAME } from "../worklets/ducker.worklet";

export interface DuckerCoreOptions {
  depth: number;
  attack: number;
  release: number;
  threshold: number;
}

type P = { depth: SchedulableParam; attack: SchedulableParam; release: SchedulableParam; threshold: SchedulableParam };

/** Worklet-backed sidechain ducker core. Constructs synchronously; the node arrives when `ready` resolves, and params are rebound to it then. */
export class DuckerCore extends AudioProcessor<P, { reduction: ReadonlyCell<number> }> {
  readonly sidechain: GainNode;
  readonly ready: Promise<void>;
  private readonly _input: GainNode;
  private readonly _output: GainNode;
  private node: AudioWorkletNode | null = null;
  private disposed = false;
  private readonly _reduction: Cell<number>;

  constructor(ctx: BaseAudioContext, opts: DuckerCoreOptions) {
    const input = new GainNode(ctx);
    const output = new GainNode(ctx);
    const sidechain = new GainNode(ctx);
    const reduction = cell(0);
    super(ctx, ({ schedulableParam }) => ({
      params: {
        depth: schedulableParam({ default: opts.depth, min: 0, max: 60 }),
        attack: schedulableParam({ default: opts.attack, min: 0, max: 1 }),
        release: schedulableParam({ default: opts.release, min: 0.001, max: 5 }),
        threshold: schedulableParam({ default: opts.threshold, min: -100, max: 0 }),
      },
      cells: { reduction: readonlyCell(reduction) },
      latency: 0,
    }));
    this._reduction = reduction;
    this._input = input;
    this._output = output;
    this.sidechain = sidechain;

    this.ready = registerWorklet(ctx, DUCKER_WORKLET_NAME, DUCKER_WORKLET).then(() => {
      if (this.disposed) return;
      const node = new AudioWorkletNode(ctx, DUCKER_WORKLET_NAME, {
        numberOfInputs: 2,
        numberOfOutputs: 1,
        outputChannelCount: [2],
        channelCount: 2,
        channelCountMode: "explicit",
      });
      // TypeScript's AudioParamMap only declares forEach; it is a ReadonlyMap at runtime.
      const nodeParams = node.parameters as unknown as ReadonlyMap<string, AudioParam>;
      for (const key of Object.keys(this.params) as (keyof P)[]) {
        this.params[key].rebind(nodeParams.get(key)!, { reassert: true });
      }
      node.port.onmessage = (e: MessageEvent<{ reduction: number }>) => {
        this._reduction.value = e.data.reduction;
      };
      input.connect(node, 0, 0);
      sidechain.connect(node, 0, 1);
      node.connect(output);
      this.node = node;
    });
    this.ready.catch(() => {});
  }

  override get input(): GainNode {
    return this._input;
  }

  get output(): GainNode {
    return this._output;
  }

  override dispose(): void {
    this.disposed = true;
    if (this.node) {
      this.node.port.postMessage({ dispose: true });
      this.node.disconnect();
    }
    this.sidechain.disconnect();
    super.dispose();
  }
}
