/** Drives the Clock tick loop: `start(onTick)` begins calling `onTick` repeatedly, `stop()` ends it. A `Clock` picks one itself (`WorkerTickSource`); pass `tickSource` only for tests (`ManualTickSource`) or an offline render. Writing your own is never needed. */
export interface TickSource {
  /** Begins periodic notifications; callback timing is wall-clock driven rather than audio accurate. */
  start(onTick: () => void): void;
  /** Stops periodic notifications; no further ticks should be delivered. */
  stop(): void;
}

/** Pass as `new Clock({ tickSource })` in tests or an offline render to run ticks by hand with `tick()`: deterministic, no timers. */
export class ManualTickSource implements TickSource {
  private _onTick?: () => void;
  private _running = false;

  /** Begins accepting `tick()`; `onTick` is called once per `tick()` while started. */
  start(onTick: () => void): void {
    this._onTick = onTick;
    this._running = true;
  }

  /** Stops accepting `tick()`; later ticks are ignored until `start`. */
  stop(): void {
    this._running = false;
    this._onTick = undefined;
  }

  /** Runs one tick now; does nothing when stopped. */
  tick(): void {
    if (this._running) this._onTick?.();
  }
}

/** Main-thread `setInterval` ticks, throttled in background tabs. Do not pass it to `Clock`: the default `WorkerTickSource` already falls back to it when `Worker` is missing, and a hand-written `setInterval` source is never needed. */
export class IntervalTickSource implements TickSource {
  private readonly _intervalMs: number;
  private _handle: ReturnType<typeof setInterval> | undefined;

  constructor(intervalMs: number) {
    this._intervalMs = intervalMs;
  }

  /** Calls `onTick` every `intervalMs` milliseconds with `setInterval`; a second start replaces the first. */
  start(onTick: () => void): void {
    this._handle = setInterval(onTick, this._intervalMs);
  }

  /** Clears the interval; safe to call when not started. */
  stop(): void {
    if (this._handle !== undefined) clearInterval(this._handle);
    this._handle = undefined;
  }
}

const WORKER_SOURCE = `
let handle;
self.onmessage = (e) => {
  if (e.data === "stop") {
    clearInterval(handle);
    return;
  }
  handle = setInterval(() => self.postMessage("tick"), e.data);
};
`;

/**
 * Web-Worker-based timer so ticks continue in background tabs (main-thread
 * setInterval/rAF throttles heavily when a tab is backgrounded). Falls back
 * to IntervalTickSource when Worker is unavailable.
 */
export class WorkerTickSource implements TickSource {
  private readonly _intervalMs: number;
  private _worker: Worker | undefined;
  private _fallback: IntervalTickSource | undefined;

  constructor(intervalMs: number) {
    this._intervalMs = intervalMs;
  }

  /** Starts the Worker timer that calls `onTick` each interval; a second start replaces the first. */
  start(onTick: () => void): void {
    if (typeof Worker === "undefined") {
      this._fallback = new IntervalTickSource(this._intervalMs);
      this._fallback.start(onTick);
      return;
    }
    const blob = new Blob([WORKER_SOURCE], { type: "application/javascript" });
    const url = URL.createObjectURL(blob);
    this._worker = new Worker(url);
    URL.revokeObjectURL(url);
    this._worker.onmessage = () => onTick();
    this._worker.postMessage(this._intervalMs);
  }

  /** Stops the Worker timer; safe to call when not started. */
  stop(): void {
    if (this._worker) {
      this._worker.postMessage("stop");
      this._worker.terminate();
      this._worker = undefined;
    }
    this._fallback?.stop();
    this._fallback = undefined;
  }
}
