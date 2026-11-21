import type { ParamOptions, SignalAccessor } from "./types";
import { Param } from "./Param";
import { ParamSync } from "./ParamSync";

/** Seconds a smoothed write waits before it starts: `currentTime` lags the audio thread by a render buffer, and an event in the past would start part-way along its curve. */
const SMOOTHING_LEAD = 0.01;

export interface SchedulableParamOptions extends ParamOptions<number> {
  syncInterval?: number;
  audioParam: AudioParam;
  audioContext: BaseAudioContext;
  /** Seconds a `.value` write takes to settle, like `setTargetAtTime`; 0 (default) jumps like a native AudioParam. */
  smoothing?: number;
}

/**
 * Numeric Param that mirrors the Web Audio AudioParam scheduling API.
 */

export class SchedulableParam extends Param<number> {
  // Not readonly: rebind() re-points this for sources whose node is recreated
  // (an AudioBufferSourceNode is one-shot, so each start() makes a fresh playbackRate).
  private _audioParam: AudioParam;
  private readonly _audioContext: BaseAudioContext;
  // The plain signal, for ParamSync read-back: it must update the value without writing the AudioParam.
  private readonly _signal: SignalAccessor<number>;
  // The constructor's default write must jump, whatever `smoothing` is.
  private _ready = false;

  /** Fires on every change, including while a scheduled ramp moves the value. */
  declare readonly subscribe: Param<number>["subscribe"];

  /** Seconds a `.value` write takes to settle; 0 jumps. Scheduled ramps, the initial value and writes before the context clock first runs are never smoothed. */
  smoothing = 0;

  /** Backing AudioParam, for graph param sinks. */
  get audioParam(): AudioParam {
    return this._audioParam;
  }

  constructor(options: SchedulableParamOptions) {
    super(options);
    // Every write path (`.value` and raw `$(x)`) pushes to the AudioParam, so the two cannot diverge.
    const raw = this.$;
    this._signal = raw;
    const accessor = ((...args: [] | [number]) => {
      if (args.length === 0) return raw();
      raw(args[0]);
      // Nothing has been heard before the clock first runs, so a write at time 0 jumps (an offline render starts at the value you set).
      if (this.smoothing > 0 && this._ready && this._audioContext.currentTime > 0)
        this._audioParam.setTargetAtTime(args[0], this._audioContext.currentTime + SMOOTHING_LEAD, this.smoothing / 5);
      else this._audioParam.value = args[0];
    }) as SignalAccessor<number>;
    (this as { $: SignalAccessor<number> }).$ = accessor;
    this._audioContext = options.audioContext;
    this._audioParam = options.audioParam;

    ParamSync.for(this._audioContext).register(this, options.syncInterval);

    // actively sync default value to audioParam
    this.value = options.default;
    this.smoothing = options.smoothing ?? 0;
    this._ready = true;
  }

  /**
   * Re-point this param at a different AudioParam. For sources whose node is
   * recreated on each (re)start — the new node carries a fresh AudioParam with
   * no scheduling history. ParamSync is keyed on `this`, not the AudioParam, so
   * read()/syncFromAudio() follow the new target with no re-registration, and
   * any automation queued on the old (now-dead) param is gone with its node.
   *
   * `reassert` (default true) mirrors the current value onto the new param,
   * matching the constructor's `this.value = default`. Pass false to keep
   * whatever value the new param already holds.
   */
  rebind(audioParam: AudioParam, opts?: { reassert?: boolean }): void {
    this._audioParam = audioParam;
    if (opts?.reassert ?? true) {
      this._audioParam.value = this.value;
    }
  }

  /**
   * read realtime value from AudioParam directly
   */
  read(): number {
    return this._audioParam.value;
  }

  /**
   * sync current value to the audioParam value underhood
   */
  syncFromAudio(): void {
    this._signal(this._audioParam.value);
  }

  setValueAtTime(value: number, time: number): this {
    this._audioParam.setValueAtTime(value, time);
    return this;
  }

  linearRampToValueAtTime(value: number, endTime: number): this {
    this._audioParam.linearRampToValueAtTime(value, endTime);
    return this;
  }

  exponentialRampToValueAtTime(value: number, endTime: number): this {
    this._audioParam.exponentialRampToValueAtTime(value, endTime);
    return this;
  }

  setTargetAtTime(target: number, startTime: number, timeConstant: number): this {
    this._audioParam.setTargetAtTime(target, startTime, timeConstant);
    return this;
  }

  cancelScheduledValues(cancelTime: number): this {
    this._audioParam.cancelScheduledValues(cancelTime);
    return this;
  }

  cancelAndHoldAtTime(cancelTime: number): this {
    this._audioParam.cancelAndHoldAtTime(cancelTime);
    return this;
  }

  override dispose(): void {
    super.dispose();
    ParamSync.for(this._audioContext).unregister(this);
  }
}
