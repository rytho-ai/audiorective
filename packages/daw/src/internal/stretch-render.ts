import { ClipTimeMap, type ClipStretchAnchor } from "../clip-time-map";
import { encodeWav } from "./wav";
import { isVarispeed } from "../model";
import type { AudioClip } from "../model";

/**
 * The pitch-correct audio of a time-stretched clip, kept in the file's own folder `audiorective/render/` next to the standard form (the original
 * audio plus `Warps`). The clip's `StoredClip` record in `audiorective/state.json` says which clip it belongs to and what it was rendered from; a
 * reader uses the render only when that description still equals what the standard XML says, so a file another application changed never plays a
 * stale render. Several clips (pieces of a split, copies) that play the same audio share one stored render.
 */
export const renderPrefix = "audiorective/render/";

export type StoredRender = {
  /** Archive path of the stored rendered WAV. */
  path: string;
  /** Start of this clip in the stored WAV, in sample frames per channel. */
  offset: number;
  /** Clip output length in sample frames per channel. */
  frames: number;
  /** Rendered and original source sample rate in hertz. */
  rate: number;
  /** Integer audio channel count shared by source and rendered output. */
  channels: number;
  /** Archive path of the original recording used to produce this render. */
  source: string;
  /** Inclusive original-source window start in sample frames per channel. */
  from: number;
  /** Original-source window length in sample frames per channel. */
  length: number;
  /** Hash of the in-memory source PCM; omitted when no PCM hash was recorded. */
  hash?: string;
  /** Positive output-duration/source-duration ratio of the rendered stretch. */
  ratio: number;
  /** Interior source/output sample-frame anchors defining the rendered stretch. */
  anchors: readonly ClipStretchAnchor[];
};

/** What the standard XML of a stretched clip says, in the units a `StoredRender` states. */
export type StretchDescription = {
  /** Archive path of the original audio recording. */
  source: string;
  /** Inclusive original-source window start in sample frames per channel. */
  from: number;
  /** Original-source window length in sample frames per channel. */
  length: number;
  /** Rendered clip length in sample frames per channel. */
  output: number;
  /** Audio sample rate in hertz. */
  rate: number;
  /** Integer number of audio channels. */
  channels: number;
  /** Interior source/output sample-frame anchors reconstructed from the standard warp XML. */
  anchors: readonly ClipStretchAnchor[];
};

/** A 32-bit hash of PCM samples (their bits), for noticing that the audio a render was made from is not the audio the file now holds. */
export function hashPcm(channels: readonly Float32Array[]): string {
  let hash = 0x811c9dc5;
  for (const channel of channels) {
    const bits = new Uint32Array(channel.buffer, channel.byteOffset, channel.length);
    for (let i = 0; i < bits.length; i++) hash = Math.imul(hash ^ bits[i], 0x01000193) ^ (hash >>> 15);
    hash = Math.imul(hash ^ channel.length, 0x85ebca6b) >>> 0;
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

const bitsOf = (channel: Float32Array) => new Uint32Array(channel.buffer, channel.byteOffset, channel.length);

/** The frame at which `needle` occurs in `haystack` bit for bit (all channels), or -1. */
function locate(haystack: readonly Float32Array[], needle: readonly Float32Array[]): number {
  if (haystack.length !== needle.length) return -1;
  const length = needle[0].length;
  const last = haystack[0].length - length;
  if (last < 0) return -1;
  const hay = haystack.map(bitsOf);
  const pin = needle.map(bitsOf);
  for (let at = 0; at <= last; at++) {
    if (hay[0][at] !== pin[0][0]) continue;
    let same = true;
    for (let c = 0; same && c < pin.length; c++) {
      for (let i = c === 0 ? 1 : 0; i < length; i++)
        if (hay[c][at + i] !== pin[c][i]) {
          same = false;
          break;
        }
    }
    if (same) return at;
  }
  return -1;
}

type Item = {
  stored: { render?: StoredRender };
  clip: AudioClip & { channels: readonly Float32Array[] };
  description: Omit<StoredRender, "path" | "offset">;
};

/**
 * Collects the renders of the stretched clips of one save and writes each distinct render once. A clip's audio is a window of the buffer its render
 * was made in; windows of one buffer (pieces of a split) and windows with the same samples (copies) are stored as one WAV that covers all of them.
 */
export class RenderCollector {
  private readonly items: Item[] = [];

  /** Records `clip` (stretched, with the original at `source`) for `stored`. A clip that plays stand-in varispeed audio or file-backed audio has no render. */
  add(clip: AudioClip, source: string, stored: { render?: StoredRender }): void {
    if (!clip.stretch || !clip.channels || isVarispeed(clip)) return;
    const { channels: pcm } = clip;
    const window = clip.stretch.source;
    this.items.push({
      stored,
      clip: clip as Item["clip"],
      description: {
        frames: pcm[0].length,
        rate: clip.sampleRate,
        channels: pcm.length,
        source,
        from: Math.round(window.sourceOffset * clip.sampleRate),
        length: window.media ? window.frameCount : window.channels[0].length,
        ...(window.media ? {} : { hash: hashPcm(window.channels) }),
        ratio: clip.stretch.ratio,
        anchors: clip.stretch.anchors ?? [],
      },
    });
  }

  /** Writes the WAVs into `entries` and gives every recorded clip the place of its render. */
  finish(entries: Record<string, Uint8Array>): void {
    type Group = { whole: boolean; rate: number; lo: number; hi: number; members: Array<{ item: Item; at: number }> };
    const groups = new Map<object, Group>();
    for (const item of this.items) {
      const { channels } = item.clip;
      const first = channels[0];
      // Every channel is a window of its own buffer at the same place: then the buffer is the render the clip was cut from.
      const whole =
        first.buffer instanceof ArrayBuffer &&
        first.buffer.byteLength % 4 === 0 &&
        channels.every(
          (c) => c.buffer instanceof ArrayBuffer && c.buffer.byteLength === first.buffer.byteLength && c.byteOffset === first.byteOffset,
        ) &&
        new Set(channels.map((c) => c.buffer)).size === channels.length;
      const key: object = whole ? first.buffer : item;
      const at = whole ? first.byteOffset / 4 : 0;
      let group = groups.get(key);
      if (!group) groups.set(key, (group = { whole, rate: item.clip.sampleRate, lo: at, hi: at + first.length, members: [] }));
      group.lo = Math.min(group.lo, at);
      group.hi = Math.max(group.hi, at + first.length);
      group.members.push({ item, at });
    }
    const written: Array<{ path: string; rate: number; channels: Float32Array[] }> = [];
    // Larger renders first, so a smaller one that lies inside one is found there.
    for (const group of [...groups.values()].sort((a, b) => b.hi - b.lo - (a.hi - a.lo))) {
      const [{ item: lead }] = group.members;
      // The covered part of the buffer the clips were cut from; a clip whose channels are not windows of one buffer is its own render.
      const range = lead.clip.channels.map((channel) =>
        group.whole ? new Float32Array(channel.buffer, 0, channel.buffer.byteLength / 4).subarray(group.lo, group.hi) : channel,
      );
      let home: { path: string; start: number } | undefined;
      for (const other of written) {
        if (other.rate !== group.rate || other.channels.length !== range.length) continue;
        const start = locate(other.channels, range);
        if (start >= 0) {
          home = { path: other.path, start };
          break;
        }
      }
      if (!home) {
        const path = `${renderPrefix}${lead.clip.id}.wav`;
        written.push({ path, rate: group.rate, channels: range });
        entries[path] = encodeWav({ sampleRate: group.rate, channels: range });
        home = { path, start: 0 };
      }
      for (const { item, at } of group.members) item.stored.render = { path: home.path, offset: home.start + at - group.lo, ...item.description };
    }
  }
}

const integer = (value: unknown, min: number): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= min;

/** The sidecar record of a render, or undefined when it is not one. A file is untrusted: every field is checked. */
export function readStoredRender(value: unknown): StoredRender | undefined {
  if (!value || typeof value !== "object") return undefined;
  const r = value as Record<string, unknown>;
  if (
    typeof r.path !== "string" ||
    !r.path.startsWith(renderPrefix) ||
    typeof r.source !== "string" ||
    !integer(r.offset, 0) ||
    !integer(r.frames, 1) ||
    !integer(r.rate, 1) ||
    !integer(r.channels, 1) ||
    !integer(r.from, 0) ||
    !integer(r.length, 1) ||
    typeof r.ratio !== "number" ||
    !(r.hash === undefined || typeof r.hash === "string") ||
    !Array.isArray(r.anchors)
  )
    return undefined;
  const anchors: ClipStretchAnchor[] = [];
  for (const point of r.anchors as unknown[]) {
    const a = point as Record<string, unknown> | null;
    if (!a || !integer(a.sourceFrame, 0) || !integer(a.outputFrame, 0)) return undefined;
    anchors.push({ sourceFrame: a.sourceFrame, outputFrame: a.outputFrame });
  }
  return { ...(r as StoredRender), anchors };
}

/**
 * Whether `stored` was rendered from what `now` describes: the same file, window, sample rate, channels and length of the clip, the same audio when
 * both know a hash, and the same time map. The time map compares by what it does, not by its anchors: a warp the file writes where only the song's
 * tempo changes the speed adds an anchor the model never had, and it is the same map. Positions are equal within 1.5 frames of the original.
 */
export function renderMatches(stored: StoredRender, now: StretchDescription, hash: () => string): boolean {
  if (
    stored.source !== now.source ||
    stored.from !== now.from ||
    stored.length !== now.length ||
    stored.frames !== now.output ||
    stored.rate !== now.rate ||
    stored.channels !== now.channels ||
    (stored.hash !== undefined && stored.hash !== hash())
  )
    return false;
  const rate = now.rate;
  const [a, b] = [stored.anchors, now.anchors].map((anchors) => new ClipTimeMap(now.length / rate, now.output / rate, anchors, rate));
  const tolerance = 1.5 / rate;
  const agrees = (anchors: readonly ClipStretchAnchor[], other: ClipTimeMap) =>
    anchors.every((point) => Math.abs(other.outputToSource(point.outputFrame / rate) - point.sourceFrame / rate) <= tolerance);
  return agrees(stored.anchors, b) && agrees(now.anchors, a);
}
