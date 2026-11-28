export const DUCKER_WORKLET_NAME = "audiorective-ducker";

// Input 0 is the audio, input 1 the sidechain. A peak follower on the sidechain (instant attack,
// 50 ms release) gates a gain reduction that moves linearly in dB: `depth` dB over `attack` seconds
// down, over `release` seconds back up. The sidechain never reaches the output.
export const DUCKER_WORKLET = /* js */ `
class DuckerProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: "depth", defaultValue: 8, minValue: 0, maxValue: 60, automationRate: "k-rate" },
      { name: "attack", defaultValue: 0.01, minValue: 0, maxValue: 1, automationRate: "k-rate" },
      { name: "release", defaultValue: 0.3, minValue: 0.001, maxValue: 5, automationRate: "k-rate" },
      { name: "threshold", defaultValue: -30, minValue: -100, maxValue: 0, automationRate: "k-rate" },
    ];
  }
  constructor() {
    super();
    this.env = 0;
    this.reduction = 0;
    this.sinceReport = 0;
    this.appliedReduction = 0;
    this.disposed = false;
    this.port.onmessage = (e) => {
      if (e.data?.dispose) {
        this.disposed = true;
        this.port.close();
      }
    };
  }
  process(inputs, outputs, p) {
    if (this.disposed) return false;
    const audio = inputs[0], side = inputs[1], output = outputs[0];
    const dry = inputs[2]?.[0], wet = inputs[3]?.[0];
    const n = output[0].length;
    const depth = p.depth[0];
    const attackStep = p.attack[0] <= 0 ? Infinity : depth / (p.attack[0] * sampleRate);
    const releaseStep = depth / (p.release[0] * sampleRate);
    const threshold = Math.pow(10, p.threshold[0] / 20);
    const decay = Math.exp(-1 / (0.05 * sampleRate));
    for (let i = 0; i < n; i++) {
      let x = 0;
      for (let c = 0; c < side.length; c++) {
        const a = Math.abs(side[c][i]);
        if (a > x) x = a;
      }
      this.env = x > this.env ? x : this.env * decay;
      const target = this.env > threshold ? depth : 0;
      if (this.reduction < target) this.reduction = Math.min(target, this.reduction + attackStep);
      else this.reduction = Math.max(target, this.reduction - releaseStep);
      const gain = Math.pow(10, -this.reduction / 20);
      const appliedGain = Math.max(0, (dry?.[i] ?? 0) + (wet?.[i] ?? 1) * gain);
      this.appliedReduction = Math.min(0, 20 * Math.log10(appliedGain));
      for (let c = 0; c < output.length; c++) {
        const channel = audio[c] ?? audio[0];
        output[c][i] = channel ? channel[i] * gain : 0;
      }
    }
    this.sinceReport += n;
    if (this.sinceReport >= 512) {
      this.port.postMessage({ reduction: this.appliedReduction });
      this.sinceReport = 0;
    }
    return true;
  }
}
registerProcessor("${DUCKER_WORKLET_NAME}", DuckerProcessor);
`;
