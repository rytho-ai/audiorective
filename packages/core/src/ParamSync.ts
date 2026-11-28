import type { SchedulableParam } from "./SchedulableParam";

/**
 * Per-AudioContext singleton that periodically reads AudioParam values
 * back into their SchedulableParam signals, keeping the reactive layer
 * in sync with the audio thread at a configurable per-param rate
 * (~10 Hz by default).
 */

export const DEFAULT_SYNC_INTERVAL_MS = 100; // ~10Hz

interface ParamEntry {
  intervalMs: number;
  lastSyncTime: number;
}

const paramSyncInstances = new WeakMap<BaseAudioContext, ParamSync>();

/** Reads native `AudioParam` values back into their `SchedulableParam` signals on a timer, so the UI follows ramps the audio thread runs. */
export class ParamSync {
  private readonly _params = new Map<SchedulableParam, ParamEntry>();
  private _rafId: number | null = null;

  /** The shared instance for `ctx`; one rAF loop per context serves every registered param. */
  static for(ctx: BaseAudioContext): ParamSync {
    let instance = paramSyncInstances.get(ctx);
    if (!instance) {
      instance = new ParamSync();
      paramSyncInstances.set(ctx, instance);
    }
    return instance;
  }

  private constructor() {}

  /** Starts mirroring `param`'s native AudioParam value into its signal at most every `intervalMs` milliseconds (default `DEFAULT_SYNC_INTERVAL_MS`, 100). */
  register(param: SchedulableParam, intervalMs = DEFAULT_SYNC_INTERVAL_MS): void {
    this._params.set(param, { intervalMs, lastSyncTime: 0 });
    if (this._params.size === 1) this._start();
  }

  /** Stops mirroring `param`; the loop ends with the last one. */
  unregister(param: SchedulableParam): void {
    this._params.delete(param);
    if (this._params.size === 0) this._stop();
  }

  /** Number of registered params. */
  get size(): number {
    return this._params.size;
  }

  /** True while the rAF loop is active (at least one param is registered). */
  get running(): boolean {
    return this._rafId !== null;
  }

  private _start(): void {
    if (this._rafId !== null) return;
    this._loop();
  }

  private _stop(): void {
    if (this._rafId !== null) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
  }

  private _loop = (): void => {
    try {
      const now = performance.now();
      for (const [param, entry] of this._params) {
        if (now - entry.lastSyncTime >= entry.intervalMs) {
          entry.lastSyncTime = now;
          try {
            param.syncFromAudio();
          } catch (error) {
            // Preserve the platform error without stopping other owners' readback.
            queueMicrotask(() => {
              throw error;
            });
          }
        }
      }
    } finally {
      this._rafId = this._params.size > 0 ? requestAnimationFrame(this._loop) : null;
    }
  };
}
