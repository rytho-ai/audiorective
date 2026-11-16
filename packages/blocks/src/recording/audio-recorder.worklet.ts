/** Captures input sample frames. Control messages use absolute AudioContext frame indices. */
export const AUDIO_RECORDER_WORKLET_NAME = "audiorective-audio-recorder";
export const AUDIO_RECORDER_WORKLET = /* js */ `
class AudioRecorderProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{ name: "capture", defaultValue: 0, minValue: 0, maxValue: 1, automationRate: "a-rate" }];
  }
  constructor(options) {
    super();
    this.channels = options.processorOptions.channels;
    this.firstFrame = null;
    this.endFrame = null;
    this.chunkStart = 0;
    this.chunkLength = 0;
    this.chunks = Array.from({ length: this.channels }, () => new Float32Array(4096));
    this.disposed = false;
    this.port.onmessage = ({ data }) => {
      if (data.type === "dispose") this.disposed = true;
    };
  }
  flush() {
    if (!this.chunkLength) return;
    const channels = this.chunks.map((chunk) => chunk.slice(0, this.chunkLength));
    this.port.postMessage({ type: "chunk", startFrame: this.chunkStart, channels }, channels.map((channel) => channel.buffer));
    this.chunkLength = 0;
  }
  process(inputs, outputs, parameters) {
    if (this.disposed) return false;
    const input = inputs[0] || [];
    const count = outputs[0][0].length;
    const capture = parameters.capture;
    for (let index = 0; index < count; index++) {
      const frame = currentFrame + index;
      const enabled = (capture.length === 1 ? capture[0] : capture[index]) >= 0.5;
      if (!enabled) {
        if (this.firstFrame !== null) {
          this.flush();
          this.port.postMessage({ type: "done", startFrame: this.firstFrame, endFrame: this.endFrame });
          this.disposed = true;
          return false;
        }
        continue;
      }
      if (this.firstFrame === null) {
        this.firstFrame = frame;
        this.port.postMessage({ type: "begin", frame });
      }
      if (!this.chunkLength) this.chunkStart = frame;
      for (let channel = 0; channel < this.channels; channel++) {
        this.chunks[channel][this.chunkLength] = input[channel]?.[index] ?? 0;
      }
      this.chunkLength++;
      this.endFrame = frame + 1;
      if (this.chunkLength === this.chunks[0].length) this.flush();
    }
    return true;
  }
}
registerProcessor("${AUDIO_RECORDER_WORKLET_NAME}", AudioRecorderProcessor);
`;
