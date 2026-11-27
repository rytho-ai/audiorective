import type { WaveStretchAnchor, WaveStretchProcessor } from "@audiorective/player";
import { normalizeClipAnchors } from "./clip-time-map";
import { adoptRenderedStretch, audioFrameCount } from "./model";
import type { AudioClip, Project } from "./model";
import { findAudioClip } from "./project-lookup";
import { takeOpenedStretches } from "./internal/open-stretch";

export type PreparedClipStretch = Readonly<{
  /** Commits the prepared audio to its clip and returns it; refuses a clip changed since preparation. */
  apply(): AudioClip;
}>;

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
    /** Opening a file: applying swaps the clip's audio in place, as no Undo step and no new version (`adoptRenderedStretch`). */
    opening = false,
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
      let rendered: { sampleRate: number; channels: Float32Array[] } | undefined;
      if (usesRender) {
        const channels = source.media
          ? await source.media.readFrames(source.startFrame, source.frameCount)
          : source.channels.map((channel) => channel.slice());
        check();
        const input = new AudioBuffer({ length: frames, numberOfChannels: channels.length, sampleRate: source.sampleRate });
        channels.forEach((channel, c) => input.copyToChannel(channel as Float32Array<ArrayBuffer>, c));
        const output = await processor!.process(input, { ratio, signal, ...(anchors.length ? { anchors } : {}) });
        rendered = { sampleRate: output.sampleRate, channels: Array.from({ length: output.numberOfChannels }, (_, c) => output.getChannelData(c)) };
        check();
      }
      return Object.freeze({
        apply: () => {
          try {
            check();
            if (!opening) return this.project().applyAudioClipStretch(clip, ratio, rendered, anchors);
            adoptRenderedStretch(this.project(), clip, rendered!);
            return findAudioClip(this.project(), clipId)!;
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

/**
 * Opening a file that stretches audio clips: the reader gave each such clip varispeed audio (the right length, the pitch moved with the speed).
 * With a `processor` every one is rendered pitch-preserving, one after the other, and swapped in place before the song plays; an engine failure on
 * one clip leaves its varispeed audio and warns. Without one the clips stay as they are and one warning says how to fix the pitch.
 */
export async function renderOpenedStretches(
  project: Project,
  processor: WaveStretchProcessor | undefined,
  warn: (message: string) => void,
  isDisposed: () => boolean,
): Promise<void> {
  const opened = takeOpenedStretches(project).filter(({ clip }) => findAudioClip(project, clip.id) === clip);
  if (!opened.length) return;
  if (!processor) {
    warn(
      `${opened.length} audio ${opened.length === 1 ? "clip is" : "clips are"} time-stretched by the file's warp markers and play with the right length and position ` +
        "but a changed pitch (varispeed). Pass a stretch processor, for example TimeStretch from @audiorective/effects/time-stretch, as the `stretch` option to keep the pitch.",
    );
    return;
  }
  const stretch = new ClipStretch(() => project, isDisposed);
  for (const { clip, name } of opened) {
    try {
      const { ratio, anchors } = clip.stretch!;
      (await stretch.prepare(clip.id, ratio, processor, anchors?.length ? { anchors } : {}, true)).apply();
    } catch (error) {
      if (isDisposed()) return;
      warn(
        `Audio clip "${name}" could not be stretched with the stretch processor (${error instanceof Error ? error.message : String(error)}); ` +
          "it plays with a changed pitch.",
      );
    }
  }
}
