/** Planar PCM samples, with one equally sized Float32Array per channel. */
export interface PCMData {
  readonly channels: readonly Float32Array[];
  readonly sampleRate: number;
}
