import type { Channel } from "@audiorective/effects";
import { smoothGain } from "./internal/playback-gain";

/**
 * A second way into a track's channel strip, with the stereo pan law, so a mono track can become stereo (or back) without a step.
 *
 * A channel pans a mono input with the equal-power law and a stereo input with the stereo law, and its input follows the widest connection, so
 * connecting a stereo chain changes the level of what already plays: a graph edit changes gain, and edits made a few microseconds apart can land in
 * different render quanta. Here the law never changes under sound. The strip's own input (path A, the natural width) and this path (B, always stereo)
 * are each weighted by an AudioParam, and a switch is a crossfade between the two weights, scheduled ahead of time. Whenever a path's width is
 * changed (`pinInput`, the node that connects the new chain) its weight is 0, so no graph edit is ever heard.
 */
export class WidthPath {
  /** Which path carries the sound: `natural` is the strip's own input, `stereo` is this path. */
  mode: "natural" | "stereo" = "natural";
  /** A switch is in progress: a second device change in that time plays without the width handling. */
  busy = false;
  private readonly pin: GainNode;
  private readonly gain: GainNode;
  private readonly pan: StereoPannerNode;
  private readonly stops: Array<() => void> = [];

  constructor(
    context: BaseAudioContext,
    source: AudioNode,
    private readonly channel: Channel,
  ) {
    // The weight of this path is `pin.gain`; it starts silent, so building it is not heard.
    this.pin = new GainNode(context, { gain: 0, channelCount: 2, channelCountMode: "explicit" });
    this.gain = new GainNode(context, { gain: channel.params.gain.value });
    this.pan = new StereoPannerNode(context, { pan: channel.params.pan.value });
    source.connect(this.pin).connect(this.gain).connect(this.pan).connect(channel.tap);
    // The strip's volume and pan reach this path too.
    this.stops.push(
      channel.params.gain.subscribe((value) => smoothGain(context, this.gain.gain, value)),
      channel.params.pan.subscribe((value) => smoothGain(context, this.pan.pan, value)),
    );
  }

  /** The strip's own input is mono (`true`) or follows its connections (`false`). Call it only while that path's weight is 0 or its signal is mono. */
  pinInput(mono: boolean): void {
    // One effective change: while the mode is "max" the count is ignored, so it is set first when pinning and last when letting go. Setting the mode first
    // would leave the input at "explicit 2" for a moment (a mono signal upmixed to stereo), and edits landing in different render quanta make that audible.
    const input = this.channel.input;
    if (mono) {
      input.channelCount = 1;
      input.channelCountMode = "explicit";
    } else {
      input.channelCountMode = "max";
      input.channelCount = 2;
    }
  }

  /** From `at` the sound moves from the strip's own input to this path over `seconds`. */
  toStereo(at: number, seconds: number): void {
    this.cross(this.channel.input.gain, this.pin.gain, at, seconds);
    this.mode = "stereo";
  }

  /** From `at` the sound moves back to the strip's own input. */
  toNatural(at: number, seconds: number): void {
    this.cross(this.pin.gain, this.channel.input.gain, at, seconds);
    this.mode = "natural";
  }

  private cross(from: AudioParam, to: AudioParam, at: number, seconds: number): void {
    for (const [param, a, b] of [
      [from, 1, 0],
      [to, 0, 1],
    ] as const) {
      param.cancelScheduledValues(at);
      param.setValueAtTime(a, at);
      param.linearRampToValueAtTime(b, at + seconds);
    }
  }

  dispose(): void {
    for (const stop of this.stops.splice(0)) stop();
    this.pin.disconnect();
    this.gain.disconnect();
    this.pan.disconnect();
  }
}
