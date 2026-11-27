import { Clock, RangeLoop, Timeline } from "@audiorective/clock";
import type { LoopRange } from "@audiorective/clock";
import { batch, cell, readonlyCell, untracked, type ReadonlyCell } from "@audiorective/core";
import type { ClipScheduler } from "./clip-scheduler";
import { recordingWindow, type AudioClip, type Project, type ProjectTrack } from "./model";
import { findAudioClip } from "./project-lookup";
import { audioChunkSeconds, type AudioClipWindow, type AudioHandle } from "./track-runtime";

/** `clip` is the Project clip (its identity decides staleness); `play` is what sounds, the clip itself or a range of its recording. */
type ClipAudition = { clip: AudioClip; play: AudioClip; cancel?: () => void };
type RangeAudition = { range: RangeAuditionState; tracks: readonly ProjectTrack[]; clock?: Clock };
export type RangeAuditionState = Readonly<{
  /** Inclusive start of the audition loop in project seconds. */
  start: number;
  /** Exclusive end of the audition loop in project seconds; greater than start. */
  end: number;
  /** Opaque IDs of the tracks included in this audition. */
  trackIds: readonly string[];
}>;

/**
 * Plays one audio clip or one looping project range through the master output, independently of
 * Arrangement. It owns the current audition in a cell and the Clock or handle that plays it, and
 * reads clips from the Project it is pointed at; it never writes to the Project.
 */
export class Audition {
  private readonly source = cell<ClipAudition | RangeAudition | null>(null);
  readonly cells: Readonly<{ clip: ReadonlyCell<string | null>; range: ReadonlyCell<RangeAuditionState | null> }>;

  constructor(
    private readonly context: AudioContext,
    private readonly output: AudioNode,
    private readonly project: () => Project,
    private readonly scheduler: ClipScheduler,
    private readonly isDisposed: () => boolean,
  ) {
    const source = this.source;
    this.cells = Object.freeze({
      clip: readonlyCell(() => {
        const current = source.value;
        return current && "clip" in current ? current.clip.id : null;
      }),
      range: readonlyCell(() => {
        const current = source.value;
        return current && "range" in current ? current.range : null;
      }),
    });
  }

  /** The running audition, read without subscribing the caller. */
  get current(): ClipAudition | RangeAudition | null {
    return untracked(() => this.source.value);
  }

  /** Audition the current audio clip, or with `range` that part of its whole recording, through master output independently of Arrangement. */
  async auditionClip(clipId: string, options: { range?: { start: number; end: number } } = {}): Promise<void> {
    if (this.isDisposed()) throw new Error("Workspace is disposed.");
    const source = findAudioClip(this.project(), clipId);
    if (!source) throw new Error("Workspace audition needs an audio clip.");
    const { range } = options ?? {};
    const clip = range ? recordingWindow(source, range.start, range.end) : source;

    const audition: ClipAudition = { clip: source, play: clip };
    batch(() => {
      this.stop();
      this.source.value = audition;
    });
    const finish = () => {
      if (this.current === audition) this.stopClip();
    };
    try {
      await this.context.resume();
      if (this.current !== audition) return;
      if (clip.media) await this.scheduler.loadMediaBuffer(clip, 0);
      if (this.current !== audition) return;
      if (findAudioClip(this.project(), clipId) !== source) return finish();

      if (clip.media) {
        let nextChunk = 0;
        const chunks = Math.ceil(clip.duration / audioChunkSeconds);
        // A fixed origin just ahead: scheduling from the clock's own start would find it already past and skip the clip's head.
        const origin = this.context.currentTime + 0.05;
        const clock = new Clock({
          timeline: new Timeline({ audioContext: this.context }),
          lookAhead: 0.2,
          onTick: (window) => {
            const elapsed = window.time.current - origin;
            if (elapsed >= clip.duration) return finish();
            nextChunk = Math.max(nextChunk, Math.floor(elapsed / audioChunkSeconds));
            while (nextChunk < chunks) {
              const when = origin + nextChunk * audioChunkSeconds;
              if (when >= window.time.lookAheadEnd) break;
              const handle = this.scheduler.scheduleMediaAudio(clip, nextChunk++, this.output, when, 0);
              window.own(handle, when);
              if (nextChunk === chunks) handle.onEnded(finish);
            }
          },
        });
        audition.cancel = () => clock.dispose();
        clock.start();
        // The initial chunk is already preloaded. Let later ticks stream the clip.
        clock.refresh();
      } else {
        // Build the buffer first: scheduling would otherwise treat the time spent building as lateness and skip the clip's head.
        this.scheduler.bufferFor(clip);
        const handle = this.scheduler.scheduleAudio(clip, this.output, this.context.currentTime + 0.02, 0);
        audition.cancel = () => handle.cancel();
        handle.onEnded(finish);
      }
    } catch (error) {
      if (this.current !== audition) return;
      finish();
      throw error;
    }
  }

  stopClip(): void {
    if (this.current && "clip" in this.current) this.stop();
  }

  stopStale(): void {
    const audition = this.current;
    if (!audition) return;
    const stale =
      "clip" in audition
        ? findAudioClip(this.project(), audition.clip.id) !== audition.clip
        : audition.tracks.some((track) => this.project().tracks.find(({ id }) => id === track.id)?.clips !== track.clips);
    if (stale) this.stop();
  }

  stop(): void {
    const audition = this.current;
    if (!audition) return;
    batch(() => {
      this.source.value = null;
      if ("clip" in audition) audition.cancel?.();
      else audition.clock?.dispose();
    });
  }

  /** Repeat one project-second range over a group of audio tracks, independently of Arrangement. */
  async auditionRange(range: LoopRange, options: { trackIds?: readonly string[] } = {}): Promise<void> {
    if (this.isDisposed()) throw new Error("Workspace is disposed.");
    const { start, end } = range;
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end - start < 1 / this.context.sampleRate)
      throw new RangeError("Workspace range audition needs a non-negative range at least one audio frame long.");
    const ids = options.trackIds ? new Set(options.trackIds) : undefined;
    const tracks = untracked(() => this.project().tracks.filter((track) => track.kind === "audio" && (!ids || ids.has(track.id))));
    if (!tracks.length || (ids && tracks.length !== ids.size)) throw new Error("Workspace range audition needs existing audio tracks.");
    const clips = untracked(() =>
      tracks.flatMap((track) =>
        track.clips.filter((clip): clip is AudioClip => clip.kind === "audio" && clip.time < end && clip.time + clip.duration > start),
      ),
    );
    if (!clips.length) throw new Error("Workspace range audition needs audio in the selected range.");
    const state = Object.freeze({ start, end, trackIds: Object.freeze(tracks.map(({ id }) => id)) });
    const audition: RangeAudition = { range: state, tracks };
    batch(() => {
      this.stop();
      this.source.value = audition;
    });
    try {
      await this.context.resume();
      if (this.current !== audition) return;
      await Promise.all(
        clips.map((clip) => {
          if (!clip.media || clip.time >= start + 0.15) return undefined;
          const index = Math.floor(Math.max(0, start - clip.time) / audioChunkSeconds);
          return this.scheduler.loadMediaBuffer(clip, index);
        }),
      );
      if (this.current !== audition) return;
      this.stopStale();
      if (this.current !== audition) return;

      const loop = new RangeLoop(state, this.context.currentTime + 0.025);
      const timeline = new Timeline({ audioContext: this.context });
      const scheduled = new Map<string, AudioHandle>();
      const clock = new Clock({
        timeline,
        lookAhead: 0.15,
        tickInterval: 0.025,
        onTick: (window) => {
          const audioStart = timeline.beatToTime(window.beat.start);
          for (const slice of loop.slices(audioStart, window.time.lookAheadEnd)) {
            const span: AudioClipWindow = {
              start: slice.start,
              end: slice.end,
              stop: end,
              audioTime: (time) => slice.when + (time - slice.start),
              keyPrefix: `${slice.cycle}:`,
            };
            for (const clip of clips) this.scheduler.scheduleAudioClipWindow(clip, this.output, span, window, scheduled);
          }
        },
      });
      audition.clock = clock;
      clock.start();
      clock.refresh();
    } catch (error) {
      if (this.current !== audition) return;
      this.stop();
      throw error;
    }
  }

  stopRange(): void {
    if (this.current && "range" in this.current) this.stop();
  }
}
