import { encodeWavBytes } from "@audiorective/core";
import type { ProjectAudio } from "../model";
import { AudioMedia } from "../media";
import type { StoredZipEntry } from "./stored-zip";

const readAscii = (view: DataView, at: number, length: number) => String.fromCharCode(...new Uint8Array(view.buffer, view.byteOffset + at, length));

const invalidPcm = () => new RangeError("Project WAV needs equal-length PCM channels and a valid sample rate.");

/** IEEE float32 WAV preserves AudioRecorder's PCM samples without quantization. */
export function encodeWav(audio: ProjectAudio): Uint8Array {
  if (!Number.isInteger(audio.sampleRate) || audio.sampleRate <= 0 || audio.channels.length > 32) throw invalidPcm();
  try {
    return encodeWavBytes(audio, { bitDepth: 32 });
  } catch {
    throw invalidPcm();
  }
}

/** Header for a streamed IEEE float32 WAV. RIFF limits one asset to under 4 GiB. */
export function encodeWavHeader(sampleRate: number, channels: number, frames: number): Uint8Array {
  if (!Number.isInteger(sampleRate) || sampleRate <= 0 || !Number.isInteger(channels) || channels > 32 || !Number.isSafeInteger(frames) || frames < 1)
    throw invalidPcm();
  const bytes = frames * channels * 4;
  if (bytes > 0xffffffff - 36) throw invalidPcm();
  // The header of an empty encode, with the sizes of the frames that are streamed after it.
  let header: Uint8Array;
  try {
    header = encodeWavBytes({ sampleRate, channels: Array.from({ length: channels }, () => new Float32Array(0)) }, { bitDepth: 32 });
  } catch {
    throw invalidPcm();
  }
  const view = new DataView(header.buffer);
  view.setUint32(4, 36 + bytes, true);
  view.setUint32(40, bytes, true);
  return header;
}

/** Stream a frame window of borrowed interleaved PCM as a WAV archive entry. */
export function wavMediaEntry(path: string, media: AudioMedia, startFrame: number, frameCount: number): StoredZipEntry {
  if (
    !Number.isSafeInteger(startFrame) ||
    startFrame < 0 ||
    !Number.isSafeInteger(frameCount) ||
    frameCount < 1 ||
    startFrame + frameCount > media.frameCount
  )
    throw new RangeError("Project WAV media entry needs a valid frame window.");
  const header = encodeWavHeader(media.sampleRate, media.channelCount, frameCount);
  const stride = media.channelCount * 4;
  const start = media.byteOffset + startFrame * stride;
  const end = start + frameCount * stride;
  return {
    path,
    size: header.length + frameCount * stride,
    async *chunks() {
      yield header;
      for (let at = start; at < end; at += 1024 * 1024) {
        const bytes = new Uint8Array(await media.blob.slice(at, Math.min(end, at + 1024 * 1024)).arrayBuffer());
        if (!bytes.length) throw new Error("Project media asset ended before its declared frame count.");
        yield bytes;
      }
    },
  };
}

/** Select one stereo pair from a packed multichannel recording without retaining the render in RAM. */
export function wavMediaStereoPairEntry(path: string, media: AudioMedia, startFrame: number, frameCount: number, pairIndex: number): StoredZipEntry {
  if (
    !Number.isSafeInteger(startFrame) ||
    startFrame < 0 ||
    !Number.isSafeInteger(frameCount) ||
    frameCount < 1 ||
    startFrame + frameCount > media.frameCount ||
    !Number.isInteger(pairIndex) ||
    pairIndex < 0 ||
    pairIndex * 2 + 1 >= media.channelCount
  )
    throw new RangeError("Project WAV media entry needs a valid frame window and stereo pair.");
  const header = encodeWavHeader(media.sampleRate, 2, frameCount);
  const stride = media.channelCount * 4;
  return {
    path,
    size: header.length + frameCount * 8,
    async *chunks() {
      yield header;
      for (let frame = 0; frame < frameCount; frame += 16384) {
        const count = Math.min(16384, frameCount - frame);
        const start = media.byteOffset + (startFrame + frame) * stride;
        const source = new Uint8Array(await media.blob.slice(start, start + count * stride).arrayBuffer());
        if (source.length !== count * stride) throw new Error("Project media asset ended before its declared frame count.");
        const output = new Uint8Array(count * 8);
        for (let i = 0; i < count; i++) output.set(source.subarray(i * stride + pairIndex * 8, i * stride + pairIndex * 8 + 8), i * 8);
        yield output;
      }
    },
  };
}

/** The streaming archive path accepts canonical interleaved float32 WAV only. */
export function mediaFromWav(blob: Blob, header: Uint8Array): AudioMedia {
  if (header.length < 44) throw new Error("Project audio needs an IEEE float32 WAV asset.");
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  const channels = view.getUint16(22, true);
  const sampleRate = view.getUint32(24, true);
  const bytes = view.getUint32(40, true);
  if (
    readAscii(view, 0, 4) !== "RIFF" ||
    readAscii(view, 8, 4) !== "WAVE" ||
    readAscii(view, 12, 4) !== "fmt " ||
    view.getUint32(16, true) !== 16 ||
    view.getUint16(20, true) !== 3 ||
    view.getUint16(34, true) !== 32 ||
    readAscii(view, 36, 4) !== "data" ||
    channels < 1 ||
    channels > 32 ||
    sampleRate < 1 ||
    view.getUint32(4, true) + 8 !== blob.size ||
    bytes + 44 !== blob.size ||
    bytes % (channels * 4) !== 0
  )
    throw new Error("Project audio needs a canonical IEEE float32 WAV asset.");
  return new AudioMedia(blob, sampleRate, channels, bytes / channels / 4, 44);
}

/** Reads the WAV files DAWs write: 8, 16, 24 and 32-bit integer PCM and 32 or 64-bit float, also in a WAVE_FORMAT_EXTENSIBLE header. */
export function decodeWav(bytes: Uint8Array): ProjectAudio {
  const unsupported = () => new Error("Project audio needs a PCM or IEEE float WAV asset.");
  if (bytes.length < 44) throw unsupported();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (readAscii(view, 0, 4) !== "RIFF" || readAscii(view, 8, 4) !== "WAVE" || view.getUint32(4, true) + 8 > bytes.length) throw unsupported();
  let format = 0,
    channels = 0,
    sampleRate = 0,
    bits = 0;
  let dataAt = -1,
    dataSize = 0;
  for (let at = 12; at + 8 <= bytes.length; ) {
    const name = readAscii(view, at, 4);
    const size = view.getUint32(at + 4, true);
    const body = at + 8;
    // A data chunk may be cut short by a writer that never came back to fix its size; take what is there.
    if (body + size > bytes.length && name !== "data") throw unsupported();
    if (name === "fmt " && size >= 16) {
      format = view.getUint16(body, true);
      channels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      bits = view.getUint16(body + 14, true);
      if (format === 0xfffe && size >= 26) format = view.getUint16(body + 24, true);
    }
    if (name === "data") {
      dataAt = body;
      dataSize = Math.min(size, bytes.length - body);
    }
    at = body + size + (size & 1);
  }
  const width = bits >> 3;
  const supported = (format === 1 && (bits === 8 || bits === 16 || bits === 24 || bits === 32)) || (format === 3 && (bits === 32 || bits === 64));
  if (!supported || channels < 1 || channels > 32 || sampleRate <= 0 || dataAt < 0) throw unsupported();
  const frames = Math.floor(dataSize / channels / width);
  const pcm = Array.from({ length: channels }, () => new Float32Array(frames));
  let at = dataAt;
  for (let frame = 0; frame < frames; frame++)
    for (const channel of pcm) {
      channel[frame] =
        format === 3
          ? bits === 32
            ? view.getFloat32(at, true)
            : view.getFloat64(at, true)
          : bits === 16
            ? view.getInt16(at, true) / 32768
            : bits === 24
              ? ((view.getUint8(at) | (view.getUint8(at + 1) << 8) | (view.getInt8(at + 2) << 16)) as number) / 8388608
              : bits === 32
                ? view.getInt32(at, true) / 2147483648
                : (view.getUint8(at) - 128) / 128;
      at += width;
    }
  return { sampleRate, channels: pcm };
}
