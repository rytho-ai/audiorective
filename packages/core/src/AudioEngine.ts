import { effect } from "alien-signals";
import { AudioProcessor } from "./AudioProcessor";
import { assertAudioContextAvailable, LatencyUnknownError } from "./errors";
import { defineGraph as defineGraphFn, _graphRegistry, NodeNotInSolveError } from "./graph";
import type { EdgeList, GraphHandle, GraphOptions } from "./graph";
import { cell, readonlyCell, untracked, type ReadonlyCell } from "./Cell";
import type { ComputedAccessor, EngineState, Readable } from "./types";

/** Read-only engine state: call it (`engine.state()`) or read `.value` / `.$()`. It has no setter. */
export type EngineStateView = ComputedAccessor<EngineState> & Readable<EngineState>;

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
  private readonly _stateCell = cell<EngineState>("idle");
  private readonly _stateView: EngineStateView;
  // Pending untilReady() callers; settled when the state reaches "running" or the engine is destroyed.
  private _waiters: Array<{ resolve: () => void; reject: (error: unknown) => void }> = [];
  // A borrowed context is the caller's to close; only a context this engine created is closed on destroy.
  private readonly _ownsContext: boolean;
  private readonly _onStateChange: () => void;
  private _cachedPromise: Promise<void> | null = null;
  // Set only by destroy() — separate from the "destroyed" state, which an external
  // context closure can also reach, so cleanup still runs if destroy() is called
  // after that (rather than being skipped because the mirror already reads "destroyed").
  private _destroyed = false;
  private _graphs: GraphHandle[] = [];
  // Each engine-owned graph's most recent destination arrival, keyed by an identity
  // token private to that graph — not the graph itself, so a graph whose own last
  // solve didn't touch the destination just keeps its prior entry (or none) instead
  // of clobbering it with `undefined`. `latency` is always the max across this map.
  private _graphLatency = new Map<object, number>();
  private readonly _latencyCell = cell(0);
  /** Longest path into the destination across engine-owned graphs, in samples. Written only by the engine. */
  readonly latency: ReadonlyCell<number> = readonlyCell(this._latencyCell);

  constructor(existingContext?: AudioContext) {
    if (existingContext === undefined) assertAudioContextAvailable();
    this._ownsContext = existingContext === undefined;
    this._context = existingContext ?? new AudioContext();
    const view = (() => this._stateCell.$()) as EngineStateView;
    Object.defineProperties(view, {
      $: { value: () => this._stateCell.$() },
      value: { get: () => this._stateCell.$() },
    });
    this._stateView = view;
    // A listener, not `onstatechange`: a borrowed context keeps whatever handler its owner installed.
    this._onStateChange = () => {
      if (this._destroyed) return;
      // Safari reports "interrupted" (phone call, Siri); it is not in lib.dom's union.
      const s = this._context.state as string;
      if (s === "closed") {
        this._setState("destroyed");
      } else if (s === "running") {
        this._setState("running");
      } else if (this._peek() !== "idle") {
        this._setState("suspended");
      }
    };
    this._context.addEventListener("statechange", this._onStateChange);
  }

  private _peek(): EngineState {
    return untracked(() => this._stateCell.value);
  }

  private _rejectWaiters(): void {
    this._cachedPromise = null;
    const waiters = this._waiters;
    this._waiters = [];
    const error = new Error("AudioEngine destroyed before it became ready");
    for (const w of waiters) w.reject(error);
  }

  private _setState(next: EngineState): void {
    this._stateCell.value = next;
    if (next === "destroyed") this._rejectWaiters();
    if (next === "running") {
      this._cachedPromise = null;
      const waiters = this._waiters;
      this._waiters = [];
      for (const w of waiters) w.resolve();
    }
  }

  get context(): AudioContext {
    return this._context;
  }

  get state(): EngineStateView {
    return this._stateView;
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
        // A graph contributes only while its last solve actually reaches the
        // destination — one that no longer does drops its entry instead of
        // keeping a stale arrival.
        try {
          this._graphLatency.set(token, h.arrivalOf(this._context.destination));
        } catch (err) {
          if (!(err instanceof NodeNotInSolveError)) throw err;
          this._graphLatency.delete(token);
        }
        this._recomputeLatency();
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
    if (state === "destroyed") return Promise.reject(new Error("AudioEngine destroyed before it became ready"));
    this._cachedPromise ??= new Promise<void>((resolve, reject) => {
      this._waiters.push({ resolve, reject });
    });
    return this._cachedPromise;
  }

  async start(): Promise<void> {
    if (this._peek() === "destroyed") throw new Error("Cannot start a destroyed engine");
    if (this._context.state !== "running") await this._context.resume();
    if (this._destroyed) return;
    this._setState("running");
  }

  async suspend(): Promise<void> {
    if (this._peek() === "destroyed") {
      console.warn("AudioEngine: suspend() called on a destroyed engine");
      return;
    }
    if (this._peek() === "idle") return;
    if (this._context.state === "running") await this._context.suspend();
    if (this._destroyed) return;
    this._setState("suspended");
  }

  async resume(): Promise<void> {
    if (this._peek() === "destroyed") {
      console.warn("AudioEngine: resume() called on a destroyed engine");
      return;
    }
    if (this._context.state !== "running") await this._context.resume();
    if (this._destroyed) return;
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
        void this.start();
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
      if (s === "destroyed") {
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

  destroy(): void {
    if (this._destroyed) return;
    this._destroyed = true;
    // Copy first: each `dispose()` splices itself out of `_graphs`, which
    // would skip entries if this loop iterated the live array directly.
    for (const graph of [...this._graphs]) graph.dispose();
    this._graphs = [];
    this._graphLatency.clear();
    for (const p of this._processors) p.destroy();
    this._processors = [];
    this._context.removeEventListener("statechange", this._onStateChange);
    // Only a context this engine created is closed. It may already be closed (an external
    // close, or the browser tearing it down), and closing it again would reject.
    if (this._ownsContext && this._context.state !== "closed") void this._context.close();
    this._stateCell.value = "destroyed";
    this._rejectWaiters();
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
  options?: { context?: AudioContext },
): T & { core: AudioEngine } {
  const engine = new AudioEngine(options?.context);
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
