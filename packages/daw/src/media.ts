/** The fields of a recorder chunk that media storage reads; a recorder's output satisfies it. */
export type AudioMediaChunk = Readonly<{ startFrame: number; channels: readonly Float32Array[] }>;
/** The fields of a finished recorder span that media storage reads. */
export type AudioMediaSpan = Readonly<{ sampleRate: number; channelCount: number; startFrame: number; endFrame: number }>;

/** Interleaved little-endian float32 PCM held by a Blob or disk-backed File. */
export class AudioMedia {
  private disposed = false;
  constructor(
    readonly blob: Blob,
    readonly sampleRate: number,
    readonly channelCount: number,
    readonly frameCount: number,
    readonly byteOffset = 0,
    private readonly cleanup?: () => Promise<void>,
  ) {
    if (
      !Number.isInteger(sampleRate) ||
      sampleRate <= 0 ||
      !Number.isInteger(channelCount) ||
      channelCount < 1 ||
      channelCount > 32 ||
      !Number.isSafeInteger(frameCount) ||
      frameCount < 1 ||
      !Number.isSafeInteger(byteOffset) ||
      byteOffset < 0 ||
      byteOffset + frameCount * channelCount * 4 > blob.size
    )
      throw new RangeError("AudioMedia needs a valid PCM frame window.");
  }

  /** Release caller-owned temporary storage after no clips or undo states refer to it. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await this.cleanup?.();
  }

  async readFrames(startFrame: number, frameCount: number): Promise<readonly Float32Array[]> {
    if (this.disposed) throw new Error("AudioMedia is disposed.");
    if (
      !Number.isInteger(startFrame) ||
      !Number.isInteger(frameCount) ||
      startFrame < 0 ||
      frameCount < 1 ||
      startFrame + frameCount > this.frameCount
    )
      throw new RangeError("AudioMedia read needs a valid frame window.");
    const stride = this.channelCount * 4;
    const bytes = await this.blob.slice(this.byteOffset + startFrame * stride, this.byteOffset + (startFrame + frameCount) * stride).arrayBuffer();
    if (bytes.byteLength !== frameCount * stride) throw new Error("AudioMedia asset ended before its declared frame count.");
    const view = new DataView(bytes);
    const channels = Array.from({ length: this.channelCount }, () => new Float32Array(frameCount));
    for (let frame = 0; frame < frameCount; frame++)
      for (let channel = 0; channel < this.channelCount; channel++) {
        const sample = view.getFloat32((frame * this.channelCount + channel) * 4, true);
        if (!Number.isFinite(sample)) throw new Error("AudioMedia asset has non-finite PCM samples.");
        channels[channel][frame] = sample;
      }
    return channels;
  }

  /** Reduce a frame window to display peaks without decoding the whole asset at once. */
  async peaks(startFrame = 0, frameCount = this.frameCount): Promise<{ min: Float32Array; max: Float32Array; duration: number }> {
    if (
      !Number.isInteger(startFrame) ||
      !Number.isInteger(frameCount) ||
      startFrame < 0 ||
      frameCount < 1 ||
      startFrame + frameCount > this.frameCount
    )
      throw new RangeError("AudioMedia peaks need a valid frame window.");
    const bins = Math.min(500_000, Math.ceil(frameCount / Math.max(1, this.sampleRate / 100)));
    const framesPerBin = Math.ceil(frameCount / bins);
    const min = new Float32Array(bins);
    const max = new Float32Array(bins);
    for (let at = 0; at < frameCount; at += 32768) {
      const channels = await this.readFrames(startFrame + at, Math.min(32768, frameCount - at));
      for (let frame = 0; frame < channels[0].length; frame++) {
        const bin = Math.min(bins - 1, Math.floor((at + frame) / framesPerBin));
        for (const channel of channels) {
          min[bin] = Math.min(min[bin], channel[frame]);
          max[bin] = Math.max(max[bin], channel[frame]);
        }
      }
    }
    return { min, max, duration: frameCount / this.sampleRate };
  }
}

export interface AudioMediaStorage {
  write(bytes: Uint8Array): Promise<void>;
  finish(): Promise<Blob>;
  abort(): Promise<void>;
}

/** Serializes recorder chunks to a caller-owned storage target without retaining PCM arrays. */
export class AudioMediaWriter {
  private frames = 0;
  private firstFrame: number | undefined;
  private pending: Promise<void> = Promise.resolve();
  private failed: unknown;
  private closed = false;
  private finished = false;

  constructor(
    readonly sampleRate: number,
    readonly channelCount: number,
    private readonly storage: AudioMediaStorage,
  ) {
    if (!Number.isInteger(sampleRate) || sampleRate <= 0 || !Number.isInteger(channelCount) || channelCount < 1 || channelCount > 32)
      throw new RangeError("AudioMediaWriter needs a sample rate and 1–32 channels.");
  }

  writeChunk(chunk: AudioMediaChunk): Promise<void> {
    if (this.closed) throw new Error("AudioMediaWriter is closed.");
    if (this.failed) throw this.failed;
    const count = chunk.channels[0]?.length ?? 0;
    if (!count || chunk.channels.length !== this.channelCount || chunk.channels.some((channel) => channel.length !== count))
      throw new Error("AudioMediaWriter needs equal-length PCM channels.");
    if (this.firstFrame === undefined) this.firstFrame = chunk.startFrame;
    if (chunk.startFrame !== this.firstFrame + this.frames) throw new Error("AudioMediaWriter lost captured frames.");
    const bytes = new Uint8Array(count * this.channelCount * 4);
    const view = new DataView(bytes.buffer);
    for (let frame = 0; frame < count; frame++)
      for (let channel = 0; channel < this.channelCount; channel++) {
        const sample = chunk.channels[channel][frame];
        if (!Number.isFinite(sample)) throw new Error("AudioMediaWriter needs finite PCM samples.");
        view.setFloat32((frame * this.channelCount + channel) * 4, sample, true);
      }
    this.frames += count;
    this.pending = this.pending
      .then(() => this.storage.write(bytes))
      .catch((error: unknown) => {
        this.failed = error;
        throw error;
      });
    return this.pending;
  }

  async finish(span: AudioMediaSpan): Promise<AudioMedia> {
    if (this.closed) throw new Error("AudioMediaWriter is closed.");
    this.closed = true;
    try {
      await this.pending;
      if (this.failed) throw this.failed;
      if (
        span.sampleRate !== this.sampleRate ||
        span.channelCount !== this.channelCount ||
        span.startFrame !== this.firstFrame ||
        span.endFrame - span.startFrame !== this.frames
      )
        throw new Error("AudioMediaWriter take does not match captured frames.");
      const media = new AudioMedia(await this.storage.finish(), this.sampleRate, this.channelCount, this.frames, 0, () => this.storage.abort());
      this.finished = true;
      return media;
    } catch (error) {
      await this.storage.abort();
      throw error;
    }
  }

  async abort(): Promise<void> {
    if (this.finished) return;
    this.closed = true;
    await this.pending.catch(() => undefined);
    await this.storage.abort();
  }
}
