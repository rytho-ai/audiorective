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
    this.startFrame = options.processorOptions.startFrame || 0;
    this.length = options.processorOptions.length ?? null;
    this.firstFrame = null;
    this.endFrame = null;
    this.chunkStart = 0;
    this.chunkLength = 0;
    this.chunks = Array.from({ length: this.channels }, () => new Float32Array(4096));
    this.dropouts = [];
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
      const gate = (capture.length === 1 ? capture[0] : capture[index]) >= 0.5;
      const enabled = gate && frame >= this.startFrame && (this.length === null || this.firstFrame === null || frame < this.firstFrame + this.length);
      if (!enabled) {
        if (this.firstFrame !== null) {
          this.flush();
          this.port.postMessage({ type: "done", startFrame: this.firstFrame, endFrame: this.endFrame, dropouts: this.dropouts });
          this.disposed = true;
          return false;
        }
        continue;
      }
      if (this.firstFrame === null) {
        this.firstFrame = frame;
        this.port.postMessage({ type: "begin", frame });
      }
      // A render quantum repeated by the browser (a frame already captured) is skipped, so chunks stay contiguous.
      if (this.endFrame !== null && frame < this.endFrame) continue;
      if (this.endFrame !== null && frame > this.endFrame) {
        const missing = frame - this.endFrame;
        if (missing > sampleRate * 2) {
          this.port.postMessage({ type: "gap", startFrame: this.endFrame, endFrame: frame });
          this.disposed = true;
          return false;
        }
        this.dropouts.push({ startFrame: this.endFrame, endFrame: frame });
        for (let lost = this.endFrame; lost < frame; lost++) {
          if (!this.chunkLength) this.chunkStart = lost;
          for (let channel = 0; channel < this.channels; channel++) this.chunks[channel][this.chunkLength] = 0;
          this.chunkLength++;
          if (this.chunkLength === this.chunks[0].length) this.flush();
        }
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
