const modules = new WeakMap<BaseAudioContext, Promise<boolean>>();
const source = `class ArWidthProbe extends AudioWorkletProcessor {
  process(inputs) {
    if (!this.sent) {
      this.sent = true;
      this.port.postMessage(inputs[0].length);
    }
    return true;
  }
}
registerProcessor("ar-width-probe", ArWidthProbe);`;

/**
 * How many channels `node` carries right now (its computed channel count), or undefined when that cannot be told: no sound source connected, an offline
 * context, or no AudioWorklet. A mono instrument and a stereo one look the same to the project, so a device change on such a track asks the graph.
 */
export async function probeWidth(context: BaseAudioContext, node: AudioNode): Promise<1 | 2 | undefined> {
  if (typeof OfflineAudioContext !== "undefined" && context instanceof OfflineAudioContext) return undefined;
  if (!context.audioWorklet || typeof AudioWorkletNode === "undefined" || typeof GainNode === "undefined") return undefined;
  let ready = modules.get(context);
  if (!ready) {
    ready = context.audioWorklet
      .addModule(URL.createObjectURL(new Blob([source], { type: "text/javascript" })))
      .then(() => true)
      .catch(() => false);
    modules.set(context, ready);
  }
  if (!(await ready)) return undefined;
  const probe = new AudioWorkletNode(context, "ar-width-probe", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
  const sink = new GainNode(context, { gain: 0 });
  try {
    node.connect(probe);
    probe.connect(sink).connect(context.destination);
    const channels = await new Promise<number>((resolve) => {
      const timer = setTimeout(() => resolve(0), 250);
      probe.port.onmessage = (event) => {
        clearTimeout(timer);
        resolve(event.data as number);
      };
    });
    return channels === 1 ? 1 : channels >= 2 ? 2 : undefined;
  } finally {
    try {
      node.disconnect(probe);
    } catch {
      // already gone
    }
    probe.disconnect();
    sink.disconnect();
  }
}
