/**
 * Sample-accurate capture of a live AudioContext node, for browser tests.
 *
 * An AudioWorklet copies each 128-frame quantum into a block and posts a block every `BLOCK` frames, tagged with `currentFrame`. A jump in `currentFrame`
 * between two calls of `process` is an audio-thread dropout (the same test the recorder worklet uses), counted in `dropouts` and kept as a gap.
 */
const BLOCK = 128 * 32;
const SOURCE = `
class LiveCapture extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.channels = options.processorOptions.channels;
    this.fill = 0;
    this.expected = -1;
    this.blockStart = -1;
    this.dropouts = [];
    this.on = true;
    this.fresh();
    this.port.onmessage = () => { this.flush(); this.on = false; this.port.postMessage({ done: true, dropouts: this.dropouts }); };
  }
  fresh() { this.data = Array.from({ length: this.channels }, () => new Float32Array(${BLOCK})); this.fill = 0; }
  flush() {
    if (!this.fill) return;
    const data = this.data.map((x) => x.slice(0, this.fill));
    this.port.postMessage({ frame: this.blockStart, data }, data.map((x) => x.buffer));
    this.fresh();
  }
  process(inputs) {
    if (!this.on) return false;
    let frame = currentFrame;
    // Chromium may repeat currentFrame for one quantum: keep those samples in order. Only a forward jump is a dropout.
    if (frame < this.expected) frame = this.expected;
    if (this.expected >= 0 && frame > this.expected) {
      this.dropouts.push({ startFrame: this.expected, endFrame: frame });
      this.flush();
    }
    if (this.fill === 0) this.blockStart = frame;
    for (let c = 0; c < this.channels; c++) {
      const input = inputs[0][c] || inputs[0][0];
      if (input) this.data[c].set(input, this.fill);
    }
    this.fill += 128;
    this.expected = frame + 128;
    if (this.fill >= ${BLOCK}) this.flush();
    return true;
  }
}
registerProcessor("live-capture", LiveCapture);`;

export type Dropout = Readonly<{ startFrame: number; endFrame: number }>;

export class LiveCapture {
  private readonly blocks: Array<{ frame: number; data: Float32Array[] }> = [];
  private done?: (dropouts: Dropout[]) => void;
  private constructor(
    private readonly node: AudioWorkletNode,
    readonly channels: number,
  ) {
    node.port.onmessage = (event) => {
      if (event.data.done) this.done?.(event.data.dropouts);
      else this.blocks.push(event.data);
    };
  }

  static async on(context: AudioContext, source: AudioNode, channels = 2): Promise<LiveCapture> {
    const url = URL.createObjectURL(new Blob([SOURCE], { type: "text/javascript" }));
    try {
      await context.audioWorklet.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }
    const node = new AudioWorkletNode(context, "live-capture", {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      channelCount: channels,
      channelCountMode: "explicit",
      channelInterpretation: "speakers",
      processorOptions: { channels },
    });
    source.connect(node);
    return new LiveCapture(node, channels);
  }

  /** Stop, and return the PCM from the first captured frame (`first`, a context frame), with silence in any dropout gap, and the dropouts. */
  async stop(): Promise<{ first: number; data: Float32Array[]; dropouts: Dropout[] }> {
    const dropouts = await new Promise<Dropout[]>((resolve) => {
      this.done = resolve;
      this.node.port.postMessage("stop");
    });
    this.node.disconnect();
    const first = this.blocks[0]?.frame ?? 0;
    const last = this.blocks.length ? this.blocks[this.blocks.length - 1]!.frame + this.blocks[this.blocks.length - 1]!.data[0]!.length : 0;
    const data = Array.from({ length: this.channels }, () => new Float32Array(last - first));
    for (const block of this.blocks) block.data.forEach((x, c) => data[c]!.set(x, block.frame - first));
    return { first, data, dropouts };
  }
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
