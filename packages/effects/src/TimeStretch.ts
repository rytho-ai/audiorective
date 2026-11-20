import type { PCMData } from "@audiorective/core/peaks";
import { TIME_STRETCH_WORKER } from "./stretch/timeStretch.worker";

/** An interior correspondence in frames at the PCM sample rate. */
export type TimeStretchAnchor = Readonly<{ sourceFrame: number; outputFrame: number }>;

export interface TimeStretchOptions {
  ratio: number;
  /** Optional increasing interior correspondences. The start and end are implicit. */
  anchors?: readonly TimeStretchAnchor[];
  signal?: AbortSignal;
}
export interface TimeStretchResult extends PCMData {
  readonly inputFrames: number;
  readonly outputFrames: number;
  readonly ratio: number;
}
/** Data-only, pitch-preserving offline processor. No input/output nodes or wet/dry mix.
 * The caller supplies a compiled module with the rubberband-wasm3.3 C ABI. */
export class TimeStretch {
  private disposed = false;
  private readonly jobs = new Set<() => void>();
  constructor(private readonly module: WebAssembly.Module) {
    if (!(module instanceof WebAssembly.Module)) throw new TypeError("TimeStretch requires a compiled WebAssembly.Module.");
  }
  async process(input: PCMData, options: TimeStretchOptions): Promise<TimeStretchResult> {
    const { ratio, anchors = [], signal } = options;
    const sampleRate = input.sampleRate;
    if (this.disposed) throw new Error("TimeStretch is disposed.");
    if (signal?.aborted) throw new DOMException("TimeStretch processing was aborted.", "AbortError");
    const frames = input.channels[0]?.length ?? 0;
    const outputFrames = Math.round(frames * ratio);
    if (!Number.isFinite(ratio) || ratio <= 0 || !Number.isSafeInteger(outputFrames) || outputFrames < 1) {
      throw new RangeError("TimeStretch ratio must be positive and produce at least one frame.");
    }
    if (
      !Number.isInteger(sampleRate) ||
      sampleRate < 8000 ||
      sampleRate > 192000 ||
      !input.channels.length ||
      input.channels.some((channel) => !(channel instanceof Float32Array) || channel.length !== frames || !channel.every(Number.isFinite))
    ) {
      throw new RangeError("TimeStretch needs finite equal-length PCM channels and an integer sampleRate from 8000 to 192000.");
    }
    let lastSource = 0;
    let lastOutput = 0;
    if (!Array.isArray(anchors)) throw new RangeError("TimeStretch anchors need strictly increasing interior source and output frames.");
    const timeMap = Array.from(anchors, (anchor: TimeStretchAnchor) => {
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
    // Transfer private copies: never detach the caller's original PCM buffers.
    const channels = input.channels.map((channel) => channel.slice());
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
      const dispose = () => finish(new Error("TimeStretch is disposed."));
      const finish = (error?: unknown, result?: TimeStretchResult) => {
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
        if (event.data.error) {
          finish(new Error(event.data.error));
          return;
        }
        finish(undefined, { channels: event.data.channels, sampleRate: sampleRate, inputFrames: frames, outputFrames, ratio: ratio });
      };
      if (signal?.aborted) {
        abort();
        return;
      }
      try {
        worker.postMessage(
          { module: this.module, channels, sampleRate: sampleRate, ratio: ratio, outputFrames, anchors: timeMap },
          channels.map((channel) => channel.buffer),
        );
      } catch (error) {
        finish(error);
      }
    });
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const cancel of [...this.jobs]) cancel();
  }
}
