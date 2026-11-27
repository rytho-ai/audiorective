import type { PCMData } from "./pcm";

/** Sample format of an encoded WAV: 16- or 24-bit signed integer, or 32-bit IEEE float. */
export interface EncodeWavOptions {
  /** Default 16. 16 and 24 write signed integer PCM, clamping to [-1, 1]; 32 writes IEEE float and keeps every sample as is. */
  bitDepth?: 16 | 24 | 32;
}

const HEADER = 44;
const MAX_BYTES = 0xffffffff - 36;

function writeAscii(view: DataView, at: number, value: string): void {
  for (let i = 0; i < value.length; i++) view.setUint8(at + i, value.charCodeAt(i));
}

/**
 * The WAV bytes of `pcm`: a 44-byte header and interleaved little-endian samples. Same checks and layout as `encodeWav`, for callers that want bytes
 * (Node, workers, zip entries) instead of a `Blob`.
 */
export function encodeWavBytes(pcm: PCMData, options: EncodeWavOptions = {}): Uint8Array<ArrayBuffer> {
  const bitDepth = options.bitDepth ?? 16;
  if (bitDepth !== 16 && bitDepth !== 24 && bitDepth !== 32) throw new RangeError("encodeWav: bitDepth must be 16, 24 or 32");
  const { channels, sampleRate } = pcm;
  if (!Number.isFinite(sampleRate) || Math.round(sampleRate) < 1 || Math.round(sampleRate) > 0xffffffff)
    throw new RangeError("encodeWav: sampleRate must be a finite positive number");
  if (channels.length < 1 || channels.length > 0xffff) throw new RangeError("encodeWav: at least one channel is required");
  const frames = channels[0]!.length;
  if (channels.some((channel) => channel.length !== frames)) throw new RangeError("encodeWav: channels must have equal frame counts");
  const bytesPerSample = bitDepth / 8;
  const blockAlign = channels.length * bytesPerSample;
  const dataBytes = frames * blockAlign;
  const rate = Math.round(sampleRate);
  if (blockAlign > 0xffff || dataBytes > MAX_BYTES || rate * blockAlign > 0xffffffff)
    throw new RangeError("encodeWav: audio is too large for a WAV file; split it into shorter pieces");

  const pad = dataBytes & 1; // RIFF chunks are word aligned: an odd data chunk is followed by one pad byte
  const output = new Uint8Array(HEADER + dataBytes + pad);
  const view = new DataView(output.buffer);
  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataBytes + pad, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, bitDepth === 32 ? 3 : 1, true);
  view.setUint16(22, channels.length, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitDepth, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, dataBytes, true);

  let at = HEADER;
  for (let frame = 0; frame < frames; frame++) {
    for (const channel of channels) {
      const sample = channel[frame]!;
      if (bitDepth === 32) view.setFloat32(at, sample, true);
      else {
        const clamped = sample > 1 ? 1 : sample < -1 ? -1 : sample;
        if (bitDepth === 16) view.setInt16(at, Math.round(clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff), true);
        else {
          const value = Math.round(clamped < 0 ? clamped * 0x800000 : clamped * 0x7fffff) | 0;
          view.setUint8(at, value & 0xff);
          view.setUint8(at + 1, (value >> 8) & 0xff);
          view.setUint8(at + 2, (value >> 16) & 0xff);
        }
      }
      at += bytesPerSample;
    }
  }
  return output;
}

/**
 * Encode PCM as a WAV file. Pure: no `AudioContext` or DOM, so it runs in browsers, Node.js and workers.
 * Samples are interleaved little-endian after a classic 44-byte header, for any channel count (more than two channels carry no speaker mask).
 */
export function encodeWav(pcm: PCMData, options: EncodeWavOptions = {}): Blob {
  return new Blob([encodeWavBytes(pcm, options) as BlobPart], { type: "audio/wav" });
}
