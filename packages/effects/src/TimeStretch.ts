import { TIME_STRETCH_WORKER } from "./stretch/timeStretch.worker";

/** An interior correspondence in frames at the buffer's sample rate. */
export type TimeStretchAnchor = Readonly<{ sourceFrame: number; outputFrame: number }>;

export interface TimeStretchLoadOptions {
  /** URL of the Rubber Band WebAssembly build (rubberband-wasm 3.3 C ABI). Fetched and compiled once per URL. */
  wasmUrl: string | URL;
  /** Aborting rejects `load` with an `AbortError`. */
  signal?: AbortSignal;
}

export interface TimeStretchOptions {
  /** Output length divided by input length: 8 / 10.43 shortens a 92 BPM loop to 120 BPM, so `ratio = fromBpm / toBpm`. */
  ratio: number;
  /** Optional increasing interior correspondences, in frames. The start and end are implicit. */
  anchors?: readonly TimeStretchAnchor[];
  /** The input is one loop cycle: the result has exactly `round(frames * ratio)` frames and wraps back to its start without a seam. */
  loop?: boolean;
  /** Aborting rejects `process` with an `AbortError`. */
  signal?: AbortSignal;
}

const modules = new Map<string, Promise<WebAssembly.Module>>();
/** Seconds of the loop's own ends wrapped around it, so the stretcher sees a continuous signal at the seam. */
const LOOP_MARGIN = 0.5;

/**
 * Pitch-preserving offline time-stretch: `AudioBuffer` in, `AudioBuffer` out, rendered in a worker.
 * `await TimeStretch.load({ wasmUrl })` once; the compiled module is cached per URL. Every cancellation
 * (an aborted `signal` or `dispose()`) rejects with an `AbortError`, so `error.name === "AbortError"` tells it from a failure.
 */
export class TimeStretch {
  private disposed = false;
  private readonly jobs = new Set<() => void>();

  /** Fetches and compiles the wasm at `wasmUrl` (once per URL) and returns a stretcher over it. */
  static async load(options: TimeStretchLoadOptions): Promise<TimeStretch> {
    const { wasmUrl, signal } = options;
    signal?.throwIfAborted();
    const url = new URL(wasmUrl, typeof location === "undefined" ? undefined : location.href).href;
    let pending = modules.get(url);
    if (!pending) {
      pending = (async () => {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`TimeStretch.load: ${url} responded ${response.status}.`);
        return WebAssembly.compile(await response.arrayBuffer());
      })();
      modules.set(url, pending);
      pending.catch(() => modules.delete(url));
    }
    const module = await new Promise<WebAssembly.Module>((resolve, reject) => {
      const abort = () => reject(new DOMException("TimeStretch.load was aborted.", "AbortError"));
      signal?.addEventListener("abort", abort, { once: true });
      pending.then(resolve, reject).finally(() => signal?.removeEventListener("abort", abort));
    });
    return new TimeStretch(module);
  }

  private constructor(private readonly module: WebAssembly.Module) {}

  /** Returns a new buffer of `round(input.length * ratio)` frames at the input's sample rate; `ratio` is output duration over input duration (2 plays twice as long). Rejects with RangeError for a bad `ratio`, `anchors` or non-finite samples, and with `AbortError` on cancellation. */
  async process(input: AudioBuffer, options: TimeStretchOptions): Promise<AudioBuffer> {
    const { ratio, anchors = [], loop = false, signal } = options;
    if (this.disposed) throw new Error("TimeStretch is disposed.");
    if (signal?.aborted) throw new DOMException("TimeStretch processing was aborted.", "AbortError");
    const sampleRate = input.sampleRate;
    const frames = input.length;
    const outputFrames = Math.round(frames * ratio);
    if (!Number.isFinite(ratio) || ratio <= 0 || !Number.isSafeInteger(outputFrames) || outputFrames < 1) {
      throw new RangeError("TimeStretch ratio must be positive and produce at least one frame.");
    }
    const source = Array.from({ length: input.numberOfChannels }, (_, c) => input.getChannelData(c));
    if (source.some((channel) => !channel.every(Number.isFinite))) throw new RangeError("TimeStretch needs finite samples.");
    if (!Array.isArray(anchors)) throw new RangeError("TimeStretch anchors need strictly increasing interior source and output frames.");
    let lastSource = 0;
    let lastOutput = 0;
    const interior = Array.from(anchors, (anchor: TimeStretchAnchor) => {
      if (
        !anchor ||
        !Number.isInteger(anchor.sourceFrame) ||
        !Number.isInteger(anchor.outputFrame) ||
        anchor.sourceFrame <= lastSource ||
        anchor.sourceFrame >= frames ||
        anchor.sourceFrame > 0xffff_ffff ||
        anchor.outputFrame <= lastOutput ||
        anchor.outputFrame >= outputFrames ||
        anchor.outputFrame > 0xffff_ffff
      ) {
        throw new RangeError("TimeStretch anchors need strictly increasing interior source and output frames.");
      }
      lastSource = anchor.sourceFrame;
      lastOutput = anchor.outputFrame;
      return { sourceFrame: lastSource, outputFrame: lastOutput };
    });
    if (typeof Worker === "undefined") throw new Error("TimeStretch requires Web Workers.");

    // A loop is rendered from [tail | loop | head] with its endpoints anchored, then cut back to exactly one cycle.
    const margin = loop ? Math.min(frames, Math.max(1, Math.round(LOOP_MARGIN * sampleRate))) : 0;
    const lead = loop ? Math.max(1, Math.round(margin * ratio)) : 0;
    const trail = loop ? Math.max(1, Math.round(margin * ratio)) : 0;
    // Transfer private copies: never detach the caller's original buffer data.
    const channels = source.map((channel): Float32Array<ArrayBuffer> => {
      if (!loop) return channel.slice();
      const wrapped = new Float32Array(frames + 2 * margin);
      wrapped.set(channel.subarray(frames - margin), 0);
      wrapped.set(channel, margin);
      wrapped.set(channel.subarray(0, margin), margin + frames);
      return wrapped;
    });
    const timeMap = loop
      ? [
          { sourceFrame: margin, outputFrame: lead },
          ...interior.map((a) => ({ sourceFrame: a.sourceFrame + margin, outputFrame: a.outputFrame + lead })),
          { sourceFrame: margin + frames, outputFrame: lead + outputFrames },
        ]
      : interior;
    const renderFrames = lead + outputFrames + trail;
    // A loop's render length is fixed by its parts; give the stretcher the ratio that lands exactly on it.
    const renderRatio = loop ? renderFrames / channels[0]!.length : ratio;
    const rendered = await this.render(channels, sampleRate, renderRatio, renderFrames, timeMap, signal);
    const result = new AudioBuffer({ length: outputFrames, numberOfChannels: rendered.length, sampleRate });
    rendered.forEach((channel, c) => result.copyToChannel(channel.subarray(lead, lead + outputFrames), c));
    return result;
  }

  private render(
    channels: Float32Array<ArrayBuffer>[],
    sampleRate: number,
    ratio: number,
    outputFrames: number,
    anchors: readonly TimeStretchAnchor[],
    signal: AbortSignal | undefined,
  ): Promise<Float32Array<ArrayBuffer>[]> {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(new Blob([TIME_STRETCH_WORKER], { type: "application/javascript" }));
      let worker: Worker;
      try {
        worker = new Worker(url);
      } catch (error) {
        URL.revokeObjectURL(url);
        reject(error);
        return;
      }
      let settled = false;
      const abort = () => finish(new DOMException("TimeStretch processing was aborted.", "AbortError"));
      const dispose = () => finish(new DOMException("TimeStretch is disposed.", "AbortError"));
      const finish = (error?: unknown, result?: Float32Array<ArrayBuffer>[]) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", abort);
        this.jobs.delete(dispose);
        worker.terminate();
        URL.revokeObjectURL(url);
        if (error) reject(error);
        else resolve(result!);
      };
      this.jobs.add(dispose);
      signal?.addEventListener("abort", abort, { once: true });
      worker.onerror = (event) => finish(new Error(event.message || "TimeStretch worker failed."));
      worker.onmessage = (event) => {
        if (event.data.error) finish(new Error(event.data.error));
        else finish(undefined, event.data.channels);
      };
      try {
        worker.postMessage(
          { module: this.module, channels, sampleRate, ratio, outputFrames, anchors },
          channels.map((channel) => channel.buffer),
        );
      } catch (error) {
        finish(error);
      }
    });
  }

  /** Cancels every running job (each rejects with an `AbortError`); later `process` calls throw. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const cancel of [...this.jobs]) cancel();
  }

  [Symbol.dispose](): void {
    this.dispose();
  }
}
