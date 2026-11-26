import type { BeatTiming, PCMData } from "@audiorective/core";

/** Where a loop's beats are in seconds: a constant tempo (`bpm`), or a transport's timing (`timeline`, e.g. `clock.timeline`, which follows a tempo curve). */
export type LoopTiming = { bpm: number; timeline?: never } | { timeline: Pick<BeatTiming, "beatToTime">; bpm?: never };

export type OverdubOptions = LoopTiming & {
  /** Transport beat the loop's first frame sounds at (the beat the loop was launched on). */
  loopStartBeat: number;
  /** Transport beat the take starts at. Default `take.startBeat`; required for a take that has none. */
  atBeat?: number;
  /** Linear level of the take added to the loop. Default 1. */
  gain?: number;
};

export type PunchOptions = LoopTiming & {
  loopStartBeat: number;
  /** The region replaced, in transport beats: [fromBeat, toBeat). It may wrap across the loop end, and must be shorter than the loop. */
  fromBeat: number;
  toBeat: number;
  /** Transport beat the take starts at. Default `take.startBeat`, else `fromBeat`. */
  atBeat?: number;
  /** Seconds of linear crossfade at each edge of the region, so a punch does not click. Default 0.005; 0 cuts hard. */
  fadeSeconds?: number;
};

/** A take as placement sees it: PCM plus, when known, the beat it started at (`RecordedAudio` fits). */
export type PlacedTake = PCMData & { readonly startBeat?: number | null };

function seconds(timing: LoopTiming, loopStartBeat: number, beat: number): number {
  if ("timeline" in timing && timing.timeline) return timing.timeline.beatToTime(beat) - timing.timeline.beatToTime(loopStartBeat);
  if (!(timing.bpm! > 0)) throw new RangeError("AudioRecorder placement requires a positive bpm or a timeline.");
  return ((beat - loopStartBeat) * 60) / timing.bpm!;
}
const wrap = (frame: number, length: number): number => ((frame % length) + length) % length;

function check(target: AudioBuffer, take: PlacedTake): void {
  if (take.sampleRate !== target.sampleRate)
    throw new RangeError(`AudioRecorder placement needs equal sample rates, got ${take.sampleRate} and ${target.sampleRate}.`);
  if (take.channels.length !== target.numberOfChannels && take.channels.length !== 1)
    throw new RangeError(`AudioRecorder placement needs a mono take or ${target.numberOfChannels} channels, got ${take.channels.length}.`);
}
function copy(target: AudioBuffer): { buffer: AudioBuffer; data: Float32Array[] } {
  const buffer = new AudioBuffer({ length: target.length, sampleRate: target.sampleRate, numberOfChannels: target.numberOfChannels });
  const data = Array.from({ length: target.numberOfChannels }, (_, channel) => {
    const out = buffer.getChannelData(channel);
    out.set(target.getChannelData(channel));
    return out;
  });
  return { buffer, data };
}

/**
 * A new loop buffer with `take` summed in at its beat position: the take's first frame lands where `atBeat` falls in the loop, and a take that runs past the loop end wraps to its start.
 * The target is not modified (a playing clip keeps using it); hand the result to `clip.configure({ buffer })`. A mono take is added to every channel.
 */
export function overdub(target: AudioBuffer, take: PlacedTake, options: OverdubOptions): AudioBuffer {
  check(target, take);
  const atBeat = options.atBeat ?? take.startBeat;
  if (atBeat == null || !Number.isFinite(atBeat)) throw new RangeError("AudioRecorder overdub needs `atBeat` or a take with a startBeat.");
  const { buffer, data } = copy(target);
  const length = target.length;
  const start = wrap(Math.round(seconds(options, options.loopStartBeat, atBeat) * target.sampleRate), length);
  const gain = options.gain ?? 1;
  const frames = take.channels[0]?.length ?? 0;
  for (let channel = 0; channel < data.length; channel++) {
    const source = take.channels[take.channels.length === 1 ? 0 : channel]!;
    const out = data[channel]!;
    for (let i = 0; i < frames; i++) out[(start + i) % length]! += source[i]! * gain;
  }
  return buffer;
}

/**
 * A new loop buffer with the region [`fromBeat`, `toBeat`) replaced by `take`, with short linear crossfades at both edges. Frames of the region the take does not cover keep the loop's audio.
 * The target is not modified; hand the result to `clip.configure({ buffer })`. A mono take replaces every channel.
 */
export function punch(target: AudioBuffer, take: PlacedTake, options: PunchOptions): AudioBuffer {
  check(target, take);
  const atBeat = options.atBeat ?? take.startBeat ?? options.fromBeat;
  const rate = target.sampleRate;
  const length = target.length;
  const from = Math.round(seconds(options, options.loopStartBeat, options.fromBeat) * rate);
  const to = Math.round(seconds(options, options.loopStartBeat, options.toBeat) * rate);
  const region = to - from;
  if (!(region > 0) || region >= length) throw new RangeError("AudioRecorder punch needs fromBeat before toBeat, within one loop.");
  const fade = Math.max(0, Math.round((options.fadeSeconds ?? 0.005) * rate));
  const takeStart = Math.round(seconds(options, options.loopStartBeat, atBeat) * rate);
  const frames = take.channels[0]?.length ?? 0;
  const { buffer, data } = copy(target);
  for (let channel = 0; channel < data.length; channel++) {
    const source = take.channels[take.channels.length === 1 ? 0 : channel]!;
    const out = data[channel]!;
    for (let i = 0; i < region; i++) {
      const index = i + from - takeStart; // position inside the take
      if (index < 0 || index >= frames) continue;
      const weight = fade ? Math.min(1, (i + 0.5) / fade, (region - i - 0.5) / fade) : 1;
      const at = wrap(from + i, length);
      out[at] = out[at]! * (1 - weight) + source[index]! * weight;
    }
  }
  return buffer;
}
