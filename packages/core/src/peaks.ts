/** Planar PCM samples, with one equally sized Float32Array per channel. */
export interface PCMData {
  readonly channels: readonly Float32Array[];
  readonly sampleRate: number;
}

/** Extrema across all channels in fixed source-frame bins. */
export interface PeakSummary {
  readonly min: Float32Array;
  readonly max: Float32Array;
  readonly sampleRate: number;
  readonly frameCount: number;
  readonly framesPerPeak: number;
  readonly duration: number;
}

/** Summarize PCM without changing its samples or normalizing their amplitudes. */
export function summarizePeaks(pcm: PCMData, options: { framesPerPeak?: number } = {}): PeakSummary {
  const { channels, sampleRate } = pcm;
  const framesPerPeak = options.framesPerPeak === undefined ? 128 : options.framesPerPeak;
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new RangeError("summarizePeaks: sampleRate must be a finite positive number");
  }
  if (!Number.isSafeInteger(framesPerPeak) || framesPerPeak < 1) {
    throw new RangeError("summarizePeaks: framesPerPeak must be a positive safe integer");
  }
  if (channels.length === 0) {
    throw new RangeError("summarizePeaks: at least one channel is required");
  }
  for (const channel of channels) {
    if (!(channel instanceof Float32Array)) {
      throw new TypeError("summarizePeaks: every channel must be a Float32Array");
    }
  }
  const frameCount = channels[0].length;
  for (const channel of channels) {
    if (channel.length !== frameCount) {
      throw new RangeError("summarizePeaks: channels must have equal frame counts");
    }
  }

  const peakCount = Math.ceil(frameCount / framesPerPeak);
  const min = new Float32Array(peakCount);
  const max = new Float32Array(peakCount);
  for (let peak = 0; peak < peakCount; peak++) {
    const start = peak * framesPerPeak;
    const end = Math.min(start + framesPerPeak, frameCount);
    let low = Infinity;
    let high = -Infinity;
    for (const channel of channels) {
      for (let frame = start; frame < end; frame++) {
        const sample = channel[frame];
        if (!Number.isFinite(sample)) {
          throw new RangeError("summarizePeaks: samples must be finite numbers");
        }
        low = Math.min(low, sample);
        high = Math.max(high, sample);
      }
    }
    min[peak] = low;
    max[peak] = high;
  }
  return { min, max, sampleRate, frameCount, framesPerPeak, duration: frameCount / sampleRate };
}

/** The half-open frame/time range of a bin, relative to the supplied PCM. */
export function peakFrameRange(
  summary: PeakSummary,
  index: number,
): {
  startFrame: number;
  endFrame: number;
  startTime: number;
  endTime: number;
} {
  if (!Number.isSafeInteger(index) || index < 0 || index >= summary.min.length) {
    throw new RangeError("peakFrameRange: index must identify an existing peak");
  }
  const startFrame = index * summary.framesPerPeak;
  const endFrame = Math.min(startFrame + summary.framesPerPeak, summary.frameCount);
  return {
    startFrame,
    endFrame,
    startTime: startFrame / summary.sampleRate,
    endTime: endFrame / summary.sampleRate,
  };
}

export { encodeWav, encodeWavBytes } from "./wav";
export type { EncodeWavOptions } from "./wav";
export { resamplePCM } from "./resample";
export type { ResamplePCMOptions, ResampleQuality } from "./resample";
