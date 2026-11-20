import type { WaveStretchAnchor, WaveStretchProcessor } from "@audiorective/player";
import { normalizeClipAnchors } from "./clip-time-map";
import { audioFrameCount } from "./model";
import type { AudioClip, Project } from "./model";
import { findAudioClip } from "./project-lookup";

export type PreparedClipStretch = Readonly<{ apply(): AudioClip }>;

/**
 * Renders time-stretched audio clips from their retained source. It owns one cancellable job per
 * clip and hands the result back as a prepared edit; applying it is the caller's undo transaction,
 * and only that step writes to the Project.
 */
export class ClipStretch {
  private readonly jobs = new Map<string, AbortController>();

  constructor(
    private readonly project: () => Project,
    private readonly isDisposed: () => boolean,
  ) {}

  /** Abort every running job, such as when the workspace is disposed. */
  abortAll(): void {
    for (const job of this.jobs.values()) job.abort();
  }

  /** Render a clip from its retained source and defer the project mutation to the caller's undo transaction. */
  async prepare(
    clipId: string,
    ratio: number,
    processor?: WaveStretchProcessor,
    options: { signal?: AbortSignal; anchors?: readonly WaveStretchAnchor[] } = {},
  ): Promise<PreparedClipStretch> {
    if (this.isDisposed()) throw new Error("Workspace is disposed.");
    options.signal?.throwIfAborted();
    const clip = findAudioClip(this.project(), clipId);
    if (!clip) throw new Error("Workspace clip stretch needs an audio clip.");
    const source = clip.stretch?.source ?? clip;
    const frames = audioFrameCount(source);
    const outputFrames = Math.round(frames * ratio);
    if (!Number.isFinite(ratio) || ratio <= 0 || outputFrames < 1 || !Number.isSafeInteger(outputFrames))
      throw new RangeError("Workspace clip stretch ratio must produce at least one sample.");
    const anchors = normalizeClipAnchors(options.anchors ?? [], frames, outputFrames);
    const usesRender = ratio !== 1 || anchors.length > 0;
    if (usesRender && !processor) throw new Error("Workspace clip stretch needs a processor.");

    this.jobs.get(clipId)?.abort();
    const job = new AbortController();
    const signal = options.signal ? AbortSignal.any([options.signal, job.signal]) : job.signal;
    this.jobs.set(clipId, job);
    const release = () => {
      signal.removeEventListener("abort", release);
      if (this.jobs.get(clipId) === job) this.jobs.delete(clipId);
    };
    const check = () => {
      signal.throwIfAborted();
      if (this.jobs.get(clipId) !== job || this.isDisposed()) throw new DOMException("Audio clip stretch was cancelled.", "AbortError");
    };
    signal.addEventListener("abort", release, { once: true });
    try {
      check();
      let rendered: Awaited<ReturnType<WaveStretchProcessor["process"]>> | undefined;
      if (usesRender) {
        const channels = source.media
          ? await source.media.readFrames(source.startFrame, source.frameCount)
          : source.channels.map((channel) => channel.slice());
        check();
        rendered = await processor!.process({ sampleRate: source.sampleRate, channels }, { ratio, signal, ...(anchors.length ? { anchors } : {}) });
        check();
      }
      return Object.freeze({
        apply: () => {
          try {
            check();
            return this.project().applyAudioClipStretch(clip, ratio, rendered, anchors);
          } finally {
            release();
          }
        },
      });
    } catch (error) {
      release();
      throw error;
    }
  }
}
