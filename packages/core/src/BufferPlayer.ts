import { AudioProcessor } from "./AudioProcessor";
import type { SchedulableParam } from "./SchedulableParam";
import { cell, readonlyCell, untracked, type Cell, type ReadonlyCell } from "./Cell";
import type { Param } from "./Param";

export interface BufferPlayerOptions {
  /** Decoded sample. Settable later via `.buffer` (applies on next start). */
  buffer?: AudioBuffer;
  /** Loop the buffer. Default false. */
  loop?: boolean;
  /** Loop start in seconds. Default 0. */
  loopStart?: number;
  /** Loop end in seconds. Default 0 → falls back to buffer end (musical-loop / decode-tail guard). */
  loopEnd?: number;
  /** Starting playback rate; also the rate a restart re-anchors to. Default 1. */
  playbackRate?: number;
  /** Output gain (0..1). Default 1. */
  volume?: number;
}

/**
 * Buffer-backed single-playhead transport — the "deck". One persistent source
 * you start(), stop(), and loop, on the sample-accurate AudioContext clock. Unlike
 * Sampler (polyphonic, fire-and-forget voices), the source lives for the whole
 * play session, so its `rate` is a real schedulable AudioParam you can ramp for
 * tempo/pitch moves (spin-down, tempo-match). For SFX/one-shots use Sampler;
 * for long-form streamed files use FilePlayer.
 *
 * The source node is one-shot (an AudioBufferSourceNode can't restart), so each
 * start() builds a fresh node and `rate` is rebound to its playbackRate — see
 * SchedulableParam.rebind. Scheduled rate automation belongs to the current play
 * session; stop() ends it and the next start() re-anchors to the base rate.
 */
export class BufferPlayer extends AudioProcessor<
  { volume: SchedulableParam; rate: SchedulableParam; loop: Param<boolean>; loopStart: Param<number>; loopEnd: Param<number> },
  { isPlaying: ReadonlyCell<boolean> }
> {
  /** Hot-swappable; the new buffer takes effect on the next start(). */
  buffer: AudioBuffer | null;

  private readonly _output: GainNode;
  private readonly _baseRate: number;
  private readonly _playing: Cell<boolean>;
  private _source: AudioBufferSourceNode | null = null;

  constructor(ctx: BaseAudioContext, opts: BufferPlayerOptions = {}) {
    const output = new GainNode(ctx, { gain: opts.volume ?? 1 });
    const playing = cell(false);
    // The loop params reach the live source through this holder; it is filled once `this` exists.
    const live: { player?: BufferPlayer } = {};
    super(ctx, ({ param, schedulableParam }) => ({
      params: {
        volume: param({ default: opts.volume ?? 1, bind: output.gain, min: 0, max: 1 }),
        // Unbound until the first start() rebinds it to a live source.playbackRate.
        rate: schedulableParam({ default: opts.playbackRate ?? 1 }),
        // Loop window controls: applied to the live source when one exists, and read by the next start().
        loop: param<boolean>({
          default: opts.loop ?? false,
          bind: { set: (v) => live.player?._applyLoop(v) },
        }),
        loopStart: param({
          default: opts.loopStart ?? 0,
          bind: { set: (v) => live.player?._applyLoopStart(v) },
        }),
        loopEnd: param({
          default: opts.loopEnd ?? 0,
          bind: { set: (v) => live.player?._applyLoopEnd(v) },
        }),
      },
      cells: { isPlaying: readonlyCell(playing) },
    }));
    live.player = this;
    this._playing = playing;
    this._output = output;
    this.buffer = opts.buffer ?? null;
    this._baseRate = opts.playbackRate ?? 1;
  }

  get output(): AudioNode {
    return this._output;
  }

  /**
   * Begin playback at ctx-time `when` (default now), from buffer `offset` seconds.
   * A no-op if already playing or no buffer is set (single live source).
   */
  start(when: number = this.context.currentTime, offset = 0): void {
    if (this._source || !this.buffer) return;
    const { loop, loopStart, loopEnd } = untracked(() => ({
      loop: this.params.loop.value,
      loopStart: this.params.loopStart.value,
      loopEnd: this.params.loopEnd.value,
    }));
    const src = new AudioBufferSourceNode(this.context, {
      buffer: this.buffer,
      loop,
      playbackRate: this._baseRate,
    });
    if (loop) {
      src.loopStart = loopStart;
      src.loopEnd = loopEnd || this.buffer.duration;
    }
    src.connect(this._output);
    src.onended = () => {
      if (src === this._source) this._finish();
    };

    // Re-point `rate` at the fresh node's playbackRate, then anchor to the base
    // rate. reassert:false — the value is set explicitly on the next line, so we
    // skip mirroring any leftover (e.g. spun-down) signal value onto the new node.
    this.params.rate.rebind(src.playbackRate, { reassert: false });
    this.params.rate.value = this._baseRate;

    src.start(when, offset);
    this._source = src;
    this._playing.value = true;
  }

  /**
   * Stop playback. With a future `when`, the source plays until then and its
   * natural end finalizes state; immediate stop tears down now.
   */
  stop(when?: number): void {
    const src = this._source;
    if (!src) return;
    if (when != null && when > this.context.currentTime) {
      try {
        src.stop(when);
      } catch {
        /* already stopped */
      }
      return; // onended at `when` runs _finish
    }
    this._source = null; // null first so the scheduled onended is ignored as stale
    try {
      src.stop();
    } catch {
      /* already stopped */
    }
    src.disconnect();
    this._playing.value = false;
  }

  /** Loop the buffer. Reads and writes `params.loop`; applies to a playing source immediately. */
  get loop(): boolean {
    return this.params.loop.value;
  }
  set loop(v: boolean) {
    this.params.loop.value = v;
  }
  /** Loop start in seconds. Reads and writes `params.loopStart`. */
  get loopStart(): number {
    return this.params.loopStart.value;
  }
  set loopStart(v: number) {
    this.params.loopStart.value = v;
  }
  /** Loop end in seconds (0 = buffer end). Reads and writes `params.loopEnd`. */
  get loopEnd(): number {
    return this.params.loopEnd.value;
  }
  set loopEnd(v: number) {
    this.params.loopEnd.value = v;
  }

  /** Applies the `loop` param to the live source. */
  private _applyLoop(v: boolean): void {
    if (!this._source) return;
    this._source.loop = v;
    // Toggling loop on mid-play must (re)apply the stored loop window — a source
    // started non-looping carries the node defaults (0/0 = full buffer), not ours.
    if (v) {
      const { loopStart, loopEnd } = untracked(() => ({ loopStart: this.params.loopStart.value, loopEnd: this.params.loopEnd.value }));
      this._source.loopStart = loopStart;
      this._source.loopEnd = loopEnd || this.buffer?.duration || 0;
    }
  }
  /** Applies the `loopStart` param to the live source. */
  private _applyLoopStart(v: number): void {
    if (this._source) this._source.loopStart = v;
  }
  /** Applies the `loopEnd` param to the live source. */
  private _applyLoopEnd(v: number): void {
    if (this._source) this._source.loopEnd = v || this.buffer?.duration || 0;
  }

  override destroy(): void {
    this.stop();
    this._output.disconnect();
    super.destroy();
  }

  private _finish(): void {
    this._source?.disconnect();
    this._source = null;
    this._playing.value = false;
  }
}
