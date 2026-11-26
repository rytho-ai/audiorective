import { resamplePCM } from "@audiorective/core";
import type { ProjectAudio } from "../model";

/** A point of a stretch's time map in frames of the clip's rate: a source frame and the output frame it lands on. */
export type FrameKnot = Readonly<{ sourceFrame: number; outputFrame: number }>;

/**
 * The audio of a time-stretched clip made by varispeed: every segment between two knots is resampled to the length it has on the timeline, so
 * the clip has the right length and every knot lands on its frame, and the pitch moves with the speed. `knots` run from `(0, 0)` to
 * `(source frames, output frames)`. Pure (core `resamplePCM`), exactly `outputFrame` frames at the source's rate.
 */
export function varispeedAudio(source: ProjectAudio, knots: readonly FrameKnot[]): ProjectAudio {
  const rate = source.sampleRate;
  const outputFrames = knots[knots.length - 1].outputFrame;
  const channels = source.channels.map(() => new Float32Array(outputFrames));
  for (let k = 1; k < knots.length; k++) {
    const [a, b] = [knots[k - 1], knots[k]];
    const input = b.sourceFrame - a.sourceFrame;
    const output = b.outputFrame - a.outputFrame;
    const part = { sampleRate: rate, channels: source.channels.map((channel) => channel.subarray(a.sourceFrame, b.sourceFrame)) };
    // Read at `rate * input / output` and play at `rate`: the segment lasts `output` frames.
    const done = input === output ? part : resamplePCM({ ...part, sampleRate: (rate * input) / output }, rate);
    done.channels.forEach((channel, c) => channels[c].set(channel.subarray(0, output), a.outputFrame));
  }
  return { sampleRate: rate, channels };
}
