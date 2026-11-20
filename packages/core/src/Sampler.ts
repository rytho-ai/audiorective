import { AudioProcessor } from "./AudioProcessor";
import type { SchedulableParam } from "./SchedulableParam";
import type { Param } from "./Param";
import { cell, readonlyCell, untracked, type Cell, type ReadonlyCell } from "./Cell";
import { Voice, type VoiceOptions } from "./Voice";
import { reverseBuffer, reverseRegion } from "./reverseBuffer";

export interface SamplerOptions {
  /** Decoded sample. Settable later via `.buffer`. */
  buffer?: AudioBuffer;
  /** Default loop for new voices. Default false. */
  loop?: boolean;
  /** Default playback rate for new voices. Default 1. */
  playbackRate?: number;
  /** Player output gain (0..1). Default 1. */
  volume?: number;
  /** Max concurrent voices. Default 1. */
  polyphony?: number;
  /** At the cap: stop the oldest then spawn, or drop the new trigger. Default "oldest". */
  steal?: "oldest" | "none";
  /** Default fade-in for new voices, in seconds. Default 0. */
  fadeIn?: number;
  /** Default fade-out for new voices, in seconds. Default 0. */
  fadeOut?: number;
  /** Play the buffer backwards. Default false. */
  reverse?: boolean;
  /** Start muted. Default false. */
  mute?: boolean;
}

export type TriggerOptions = VoiceOptions;

/**
 * Buffer-backed, polyphonic sound source — the "drum pad". You hit it: each
 * `trigger()` fires a new Voice (up to `polyphony`, then `steal` applies), and
 * voices sum into the player output. No transport/playhead — for SFX,
 * one-shots, and loops. For a single playhead, use BufferPlayer (in-memory) or FilePlayer (streamed).
 *
 * Per-voice control (stop/pause/seek) lives on the returned `Voice`. Spatial/EQ
 * compose externally via `player.output -> ...`.
 *
 * With `polyphony: 1` and a short `fadeOut` it is a sample pad: each trigger
 * replaces the last without a click, and `cells.activeVoices` is 1 while the
 * latest hit plays and 0 once it ends or is stopped.
 */
export class Sampler extends AudioProcessor<
  { volume: SchedulableParam; mute: Param<boolean>; buffer: Param<AudioBuffer | null>; reverse: Param<boolean> },
  { activeVoices: ReadonlyCell<number> }
> {
  // Reversed copy of `_reversedSource`, built once per buffer.
  private _reversed: AudioBuffer | null = null;
  private _reversedSource: AudioBuffer | null = null;
  private readonly _active: Cell<number>;

  private readonly _output: GainNode;
  private readonly _muteGain: GainNode;
  private readonly _loop: boolean;
  private readonly _rate: number;
  private readonly _polyphony: number;
  private readonly _steal: "oldest" | "none";
  private readonly _fadeIn: number;
  private readonly _fadeOut: number;
  private _voices: Voice[] = [];

  constructor(ctx: BaseAudioContext, opts: SamplerOptions = {}) {
    const outputGain = new GainNode(ctx, { gain: opts.volume ?? 1 });
    // Mute sits before the volume gain so queued volume automation survives a mute toggle.
    const muteGain = new GainNode(ctx, { gain: opts.mute ? 0 : 1 });
    muteGain.connect(outputGain);
    const active = cell(0);
    super(ctx, ({ param }) => ({
      params: {
        volume: param({ default: opts.volume ?? 1, bind: outputGain.gain, min: 0, max: 1 }),
        mute: param<boolean>({
          default: opts.mute ?? false,
          bind: {
            set: (m) => {
              muteGain.gain.value = m ? 0 : 1;
            },
          },
        }),
        buffer: param<AudioBuffer | null>({ default: opts.buffer ?? null }),
        reverse: param<boolean>({ default: opts.reverse ?? false }),
      },
      cells: { activeVoices: readonlyCell(active) },
    }));
    this._active = active;
    this._output = outputGain;
    this._muteGain = muteGain;
    this._loop = opts.loop ?? false;
    this._rate = opts.playbackRate ?? 1;
    this._polyphony = Math.max(1, opts.polyphony ?? 1);
    this._steal = opts.steal ?? "oldest";
    this._fadeIn = opts.fadeIn ?? 0;
    this._fadeOut = opts.fadeOut ?? 0;
  }

  get output(): AudioNode {
    return this._output;
  }

  /** Decoded sample; hot-swappable, applies to the next trigger. */
  get buffer(): AudioBuffer | null {
    return this.params.buffer.value;
  }

  set buffer(b: AudioBuffer | null) {
    this.params.buffer.value = b;
  }

  /** Play backwards. Regions passed to trigger() are still measured on the forward buffer. */
  get reverse(): boolean {
    return this.params.reverse.value;
  }

  set reverse(v: boolean) {
    this.params.reverse.value = v;
  }

  /** Fire a new voice. Returns the Voice, or null if no buffer / dropped by steal:"none". */
  trigger(opts: TriggerOptions = {}): Voice | null {
    const { buffer, reverse } = untracked(() => ({ buffer: this.params.buffer.value, reverse: this.params.reverse.value }));
    if (!buffer) {
      console.warn("Sampler.trigger: no buffer set");
      return null;
    }
    let victim: Voice | null = null;
    if (this._voices.length >= this._polyphony) {
      if (this._steal === "none") return null;
      victim = this._voices[0]!;
    }
    const loop = opts.loop ?? this._loop;
    const voiceOpts: VoiceOptions = {
      ...this.region(buffer, reverse, opts.offset ?? 0, opts.duration, loop),
      when: opts.when,
      rate: opts.rate ?? this._rate,
      volume: opts.volume,
      loop,
      fadeIn: opts.fadeIn ?? this._fadeIn,
      fadeOut: opts.fadeOut ?? this._fadeOut,
    };
    const voice = new Voice(this.context, this.playBuffer(buffer, reverse), this._muteGain, voiceOpts, () => this._evict(voice));
    // The new voice joins before the victim leaves and the count is published once
    // afterwards, so a retrigger never shows 0 or a count above the cap.
    this._voices.push(voice);
    victim?.stop(); // synchronous finish -> _evict
    this._active.value = this._voices.length;
    return voice;
  }

  stopAll(when?: number): void {
    // Cell updates are driven by each voice's _evict callback, so activeVoices
    // stays accurate for future-dated stops (voices keep playing until `when`).
    for (const v of [...this._voices]) v.stop(when);
  }

  override dispose(): void {
    this.stopAll();
    this._muteGain.disconnect();
    this._output.disconnect();
    super.dispose();
  }

  /** The buffer a voice plays: the forward buffer, or a reversed copy built once per buffer. */
  private playBuffer(buffer: AudioBuffer, reverse: boolean): AudioBuffer {
    if (!reverse) return buffer;
    if (this._reversedSource !== buffer || !this._reversed) {
      this._reversed = reverseBuffer(buffer);
      this._reversedSource = buffer;
    }
    return this._reversed;
  }

  /** A forward-buffer region mapped onto whichever buffer is playing. */
  private region(
    buffer: AudioBuffer,
    reverse: boolean,
    offset: number,
    duration: number | undefined,
    loop: boolean,
  ): Pick<VoiceOptions, "offset" | "duration"> {
    if (!reverse) return { offset, duration };
    const length = buffer.duration;
    // A whole-buffer loop keeps looping; only its entry point mirrors.
    if (loop && duration == null) return { offset: (length - Math.min(Math.max(0, offset), length)) % length };
    return reverseRegion(offset, duration, length);
  }

  private _evict(voice: Voice): void {
    const i = this._voices.indexOf(voice);
    if (i !== -1) this._voices.splice(i, 1);
    this._active.value = this._voices.length;
  }
}
