/** Planar PCM samples, with one equally sized Float32Array per channel. */
export interface PCMData {
  /** Planar linear PCM, one equal-length Float32Array per channel; samples are not clamped. */
  readonly channels: readonly Float32Array[];
  /** Number of sample frames per second, in hertz. */
  readonly sampleRate: number;
}
