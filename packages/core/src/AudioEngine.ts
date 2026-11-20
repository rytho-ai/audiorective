import { effect } from "alien-signals";
import { AudioProcessor } from "./AudioProcessor";
import { assertAudioContextAvailable, LatencyUnknownError } from "./errors";
import { defineGraph as defineGraphFn, _graphRegistry, NodeNotInSolveError } from "./graph";
import type { EdgeList, GraphHandle, GraphOptions } from "./graph";
import { cell, readonlyCell, untracked, type ReadonlyCell } from "./Cell";
import { watchConnections } from "./connections";

export interface AudioEngineOptions {
  /** Aborting the signal calls `dispose()`. */
  signal?: AbortSignal;
}

const DEFAULT_AUTO_START_EVENTS = ["click", "keydown", "touchstart"] as const;

// Samples from `proc`'s output to the destination of the graph that (transitively)
// owns it. Recurses through a nested processor's own graph via a registration's
// `owner` link, so a processor several composites deep still resolves.
//
// `proc` may hold a live registration in more than one graph at once (e.g. wired into
// two engine-owned graphs). Each is tried independently — one whose path doesn't
// currently resolve (a stale registration, or an owner whose own path doesn't
// resolve) is skipped rather than failing the whole query. Among the ones that do
// resolve, a root registration (no `owner` — an engine-owned or otherwise ownerless
// graph) is preferred over a nested composite's own graph, since that's the direct
// path; ties (including among non-root registrations) go to the longest resolved
// path, matching `latency`'s "longest path into the destination" semantics.
function resolvePathLatency(proc: AudioProcessor): number {
  const regs = _graphRegistry.get(proc);
  if (!regs || regs.size === 0) {
    throw new LatencyUnknownError(proc.constructor.name);
  }

  let best: number | undefined;
  let bestIsRoot = false;
  for (const [handle, { owner, sink }] of regs) {
    // `proc` may sit in a graph component that never reaches this registration's
    // sink (a disconnected branch of the same graph) — its solved arrival numbers
    // are real but unrelated, so subtracting them would fabricate a latency.
    if (!handle.reaches(proc, sink)) continue;

    let pathLatency: number;
    try {
      pathLatency = handle.arrivalOf(sink) - handle.arrivalOf(proc);
    } catch (err) {
      if (!(err instanceof NodeNotInSolveError)) throw err;
      // This registration is stale (its graph re-solved without `proc`, or without
      // `sink`) — try the next one instead of failing the whole query.
      continue;
    }
    // Reachability should already rule this out; guard anyway so a fabricated
    // negative number is never returned.
    if (pathLatency < 0) continue;

    let total: number;
    if (owner) {
      try {
        total = pathLatency + resolvePathLatency(owner);
      } catch (err) {
        if (!(err instanceof LatencyUnknownError)) throw err;
        continue;
      }
    } else {
      total = pathLatency;
    }

    const isRoot = owner === undefined;
    if (best === undefined || (isRoot && !bestIsRoot) || (isRoot === bestIsRoot && total > best)) {
      best = total;
      bestIsRoot = isRoot;
    }
  }

  if (best === undefined || best < 0) {
    throw new LatencyUnknownError(proc.constructor.name);
  }
  return best;
}

export class AudioEngine {
  private readonly _context: AudioContext;
  private _processors: AudioProcessor[] = [];
  private readonly _stateCell = cell<AudioContextState>("suspended");
  /** Mirrors AudioContext.state: "suspended" until resume() runs, then "running"; "closed" after dispose(). */
  readonly state: ReadonlyCell<AudioContextState> = readonlyCell(this._stateCell);
  // Pending untilReady() callers; settled when the state reaches "running" or the engine is disposed.
  private _waiters: Array<{ resolve: () => void; reject: (error: unknown) => void }> = [];
  // A borrowed context is the caller's to close; only a context this engine created is closed on dispose.
  private readonly _ownsContext: boolean;
  private readonly _onStateChange: () => void;
  private _cachedPromise: Promise<void> | null = null;
  // Set only by dispose() — separate from the "closed" state, which an external
  // context closure can also reach, so cleanup still runs if dispose() is called
  // after that (rather than being skipped because the mirror already reads "closed").
  private _disposed = false;
  private readonly _abortSignal?: AbortSignal;
  private readonly _onAbort = () => this.dispose();
  private readonly _stopWatchingConnections: () => void;
  private _graphs: GraphHandle[] = [];
  // Each engine-owned graph's most recent destination arrival, keyed by an identity
  // token private to that graph — not the graph itself, so a graph whose own last
  // solve didn't touch the destination just keeps its prior entry (or none) instead
  // of clobbering it with `undefined`. `latency` is always the max across this map.
  private _graphLatency = new Map<object, number>();
  private readonly _latencyCell = cell(0);
  /** Longest path into the destination across engine-owned graphs, in samples. Written only by the engine. */
  readonly latency: ReadonlyCell<number> = readonlyCell(this._latencyCell);

  /** Without a context it creates one and closes it on dispose(). Aborting `options.signal` calls dispose(). */
  constructor(existingContext?: AudioContext, options?: AudioEngineOptions) {
    if (existingContext === undefined) assertAudioContextAvailable();
    this._ownsContext = existingContext === undefined;
    this._context = existingContext ?? new AudioContext();
    this._stateCell.value = this._contextState();
    // A listener, not `onstatechange`: a borrowed context keeps whatever handler its owner installed.
    this._onStateChange = () => this._syncState();
    this._context.addEventListener("statechange", this._onStateChange);
    // Edges made with `AudioProcessor.connect` form a latency graph per context; it feeds `latency` like an engine graph.
    const connectionToken = {};
    this._stopWatchingConnections = watchConnections(this._context, (h) => this._recordSolve(connectionToken, h));
    this._abortSignal = options?.signal;
    if (this._abortSignal?.aborted) this.dispose();
    else this._abortSignal?.addEventListener("abort", this._onAbort, { once: true });
  }

  // Safari reports "interrupted" (phone call, Siri); it is not in lib.dom's union.
  private _contextState(): AudioContextState {
    const s = this._context.state as string;
    return s === "running" || s === "closed" ? s : "suspended";
  }

  private _peek(): AudioContextState {
    return untracked(() => this._stateCell.value);
  }

  private _syncState(): void {
    if (this._disposed) return;
    this._setState(this._contextState());
  }

  private _rejectWaiters(): void {
    this._cachedPromise = null;
    const waiters = this._waiters;
    this._waiters = [];
    const error = new Error("AudioEngine disposed before it became ready");
    for (const w of waiters) w.reject(error);
  }

  private _setState(next: AudioContextState): void {
    this._stateCell.value = next;
    if (next === "closed") this._rejectWaiters();
    if (next === "running") {
      this._cachedPromise = null;
      const waiters = this._waiters;
      this._waiters = [];
      for (const w of waiters) w.resolve();
    }
  }

  // A graph contributes only while its last solve actually reaches the destination —
  // one that no longer does drops its entry instead of keeping a stale arrival.
  private _recordSolve(token: object, handle: GraphHandle): void {
    try {
      this._graphLatency.set(token, handle.arrivalOf(this._context.destination));
    } catch (err) {
      if (!(err instanceof NodeNotInSolveError)) throw err;
      this._graphLatency.delete(token);
    }
    this._recomputeLatency();
  }

  get context(): AudioContext {
    return this._context;
  }

  /**
   * The schedule time the listener is hearing right now: `currentTime` minus
   * the root graph's compensated latency and the context's output latency.
   * Sound scheduled at `t` is still in flight through the graph and the output
   * stage, so the ear lags the render clock by both.
   */
  get perceivedTime(): number {
    const ctx = this._context;
    const outputLatency = "outputLatency" in ctx && typeof ctx.outputLatency === "number" ? ctx.outputLatency : 0;
    return ctx.currentTime - this.latency.value / ctx.sampleRate - outputLatency;
  }

  defineGraph(fn: () => EdgeList, opts?: Omit<GraphOptions, "context">): GraphHandle {
    const token = {};
    const inner = defineGraphFn(fn, {
      ...opts,
      context: this._context,
      onSolve: (h) => {
        this._recordSolve(token, h);
        opts?.onSolve?.(h);
      },
    });
    const handle: GraphHandle = {
      dispose: () => {
        inner.dispose();
        this._graphLatency.delete(token);
        this._recomputeLatency();
        // Otherwise a disposed-and-rebuilt graph (e.g. every `setPdc` toggle)
        // leaves a dead handle behind, and `_graphs` grows without bound.
        const idx = this._graphs.indexOf(handle);
        if (idx !== -1) this._graphs.splice(idx, 1);
      },
      arrivalOf: (node) => inner.arrivalOf(node),
      snapshot: () => inner.snapshot(),
      idOf: (endpoint) => inner.idOf(endpoint),
      reaches: (from, to) => inner.reaches(from, to),
    };
    this._graphs.push(handle);
    return handle;
  }

  // `latency` is the longest path into the destination across every engine-owned
  // graph currently live — not just whichever one solved most recently.
  private _recomputeLatency(): void {
    let max = 0;
    for (const v of this._graphLatency.values()) if (v > max) max = v;
    this._latencyCell.value = max;
  }

  /** Samples from `proc`'s output to `ctx.destination`, following its graph ownership chain. */
  getPathLatency(proc: AudioProcessor): number {
    return resolvePathLatency(proc);
  }

  untilReady(): Promise<void> {
    const state = this._peek();
    if (state === "running") return Promise.resolve();
    if (state === "closed") return Promise.reject(new Error("AudioEngine disposed before it became ready"));
    this._cachedPromise ??= new Promise<void>((resolve, reject) => {
      this._waiters.push({ resolve, reject });
    });
    return this._cachedPromise;
  }

  private _assertLive(): void {
    if (this._disposed) throw new DOMException("AudioEngine is disposed.", "InvalidStateError");
  }

  /** Suspends the context. Rejects with InvalidStateError after dispose(). */
  async suspend(): Promise<void> {
    this._assertLive();
    if (this._context.state === "running") await this._context.suspend();
    if (this._disposed || this._peek() === "closed") return;
    this._setState("suspended");
  }

  /** Resumes the context; call it from a user gesture. Resolves at once when already running; rejects with InvalidStateError after dispose(). */
  async resume(): Promise<void> {
    this._assertLive();
    if (this._context.state !== "running") await this._context.resume();
    if (this._disposed || this._peek() === "closed") return;
    this._setState("running");
  }

  register<T extends AudioProcessor>(processor: T): T {
    this._processors.push(processor);
    return processor;
  }

  autoStart(target: EventTarget, options?: { events?: readonly string[] }): () => void {
    const events = options?.events ?? DEFAULT_AUTO_START_EVENTS;
    let gestureCleanup: (() => void) | null = null;

    const arm = () => {
      if (gestureCleanup) return;
      const handler = () => {
        disarm();
        void this.resume().catch(() => {});
      };
      for (const ev of events) target.addEventListener(ev, handler);
      gestureCleanup = () => {
        for (const ev of events) target.removeEventListener(ev, handler);
        gestureCleanup = null;
      };
    };

    const disarm = () => {
      gestureCleanup?.();
    };

    const stop = effect(() => {
      const s = this._stateCell.value;
      if (s === "closed") {
        disarm();
        return;
      }
      if (s !== "running") arm();
      else disarm();
    });

    return () => {
      stop();
      disarm();
    };
  }

  /** Disposes registered processors and graphs, and closes a context the engine created. Safe to call twice. */
  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    this._abortSignal?.removeEventListener("abort", this._onAbort);
    this._stopWatchingConnections();
    // Copy first: each `dispose()` splices itself out of `_graphs`, which
    // would skip entries if this loop iterated the live array directly.
    for (const graph of [...this._graphs]) graph.dispose();
    this._graphs = [];
    this._graphLatency.clear();
    for (const p of this._processors) p.dispose();
    this._processors = [];
    this._context.removeEventListener("statechange", this._onStateChange);
    // Only a context this engine created is closed. It may already be closed (an external
    // close, or the browser tearing it down), and closing it again would reject.
    if (this._ownsContext && this._context.state !== "closed") void this._context.close();
    this._setState("closed");
  }

  [Symbol.dispose](): void {
    this.dispose();
  }
}

// --- createEngine factory ---

type ValidSetupReturn<T> = {
  [K in keyof T]: K extends "core" ? never : T[K];
};

export interface EngineSetupHelpers {
  defineGraph: AudioEngine["defineGraph"];
}

export function createEngine<T extends Record<string, unknown>>(
  setup: (context: AudioContext, helpers: EngineSetupHelpers) => ValidSetupReturn<T>,
  options?: { context?: AudioContext; signal?: AbortSignal },
): T & { core: AudioEngine } {
  const engine = new AudioEngine(options?.context, { signal: options?.signal });
  const result = setup(engine.context, { defineGraph: (fn, o) => engine.defineGraph(fn, o) });

  if ("core" in result) {
    throw new Error('createEngine: setup returned reserved key "core"');
  }

  for (const value of Object.values(result)) {
    if (value instanceof AudioProcessor) {
      engine.register(value);
    }
  }

  return {
    ...result,
    core: engine,
  };
}
