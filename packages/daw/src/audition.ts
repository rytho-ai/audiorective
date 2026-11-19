import { Clock, RangeLoop, Timeline } from "@audiorective/clock";
import type { LoopRange } from "@audiorective/clock";
import { batch, cell, readonlyCell, untracked, type ReadonlyCell } from "@audiorective/core";
import type { ClipScheduler } from "./clip-scheduler";
import type { AudioClip, Project, ProjectTrack } from "./model";
import { findAudioClip } from "./project-lookup";
import { audioChunkSeconds, type AudioClipWindow, type AudioHandle } from "./track-runtime";

type ClipAudition = { clip: AudioClip; cancel?: () => void };
type RangeAudition = { range: RangeAuditionState; tracks: readonly ProjectTrack[]; clock?: Clock };
export type RangeAuditionState = Readonly<{ start: number; end: number; trackIds: readonly string[] }>;

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
    private readonly isDestroyed: () => boolean,
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

  private get audition(): ClipAudition | RangeAudition | null {
    return untracked(() => this.source.value);
  }

  /** Audition the current audio clip through master output independently of Arrangement. */
  async auditionClip(clipId: string): Promise<void> {
    if (this.isDestroyed()) throw new Error("Workspace is destroyed.");
    const clip = findAudioClip(this.project(), clipId);
    if (!clip) throw new Error("Workspace audition needs an audio clip.");

    const audition: ClipAudition = { clip };
    batch(() => {
      this.stop();
      this.source.value = audition;
    });
    const finish = () => {
      if (this.audition === audition) this.stopClip();
    };
    try {
      await this.context.resume();
      if (this.audition !== audition) return;
      if (clip.media) await this.scheduler.loadMediaBuffer(clip, 0);
      if (this.audition !== audition) return;
      if (findAudioClip(this.project(), clipId) !== clip) return finish();

      if (clip.media) {
        let nextChunk = 0;
        const chunks = Math.ceil(clip.duration / audioChunkSeconds);
        const clock = new Clock({
          timeline: new Timeline({ audioContext: this.context }),
          lookAhead: 0.2,
          onTick: (window) => {
            const elapsed = window.time.current - window.time.started;
            if (elapsed >= clip.duration) return finish();
            nextChunk = Math.max(nextChunk, Math.floor(elapsed / audioChunkSeconds));
            while (nextChunk < chunks) {
              const when = window.time.started + nextChunk * audioChunkSeconds;
              if (when >= window.time.lookAheadEnd) break;
              const handle = this.scheduler.scheduleMediaAudio(clip, nextChunk++, this.output, when, 0);
              window.own(handle, when);
              if (nextChunk === chunks) handle.onEnded(finish);
            }
          },
        });
        audition.cancel = () => clock.destroy();
        clock.start();
        // The initial chunk is already preloaded. Let later ticks stream the clip.
        clock.refresh();
      } else {
        const handle = this.scheduler.scheduleAudio(clip, this.output, this.context.currentTime, 0);
        audition.cancel = () => handle.cancel();
        handle.onEnded(finish);
      }
    } catch (error) {
      if (this.audition !== audition) return;
      finish();
      throw error;
    }
  }

  stopClip(): void {
    if (this.audition && "clip" in this.audition) this.stop();
  }

  stopStale(): void {
    const audition = this.audition;
    if (!audition) return;
    const stale =
      "clip" in audition
        ? findAudioClip(this.project(), audition.clip.id) !== audition.clip
        : audition.tracks.some((track) => this.project().tracks.find(({ id }) => id === track.id)?.clips !== track.clips);
    if (stale) this.stop();
  }

  stop(): void {
    const audition = this.audition;
    if (!audition) return;
    batch(() => {
      this.source.value = null;
      if ("clip" in audition) audition.cancel?.();
      else audition.clock?.destroy();
    });
  }

  /** Repeat one project-second range over a group of audio tracks, independently of Arrangement. */
  async auditionRange(range: LoopRange, options: { trackIds?: readonly string[] } = {}): Promise<void> {
    if (this.isDestroyed()) throw new Error("Workspace is destroyed.");
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
      if (this.audition !== audition) return;
      await Promise.all(
        clips.map((clip) => {
          if (!clip.media || clip.time >= start + 0.15) return undefined;
          const index = Math.floor(Math.max(0, start - clip.time) / audioChunkSeconds);
          return this.scheduler.loadMediaBuffer(clip, index);
        }),
      );
      if (this.audition !== audition) return;
      this.stopStale();
      if (this.audition !== audition) return;

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
      if (this.audition !== audition) return;
      this.stop();
      throw error;
    }
  }

  stopRange(): void {
    if (this.audition && "range" in this.audition) this.stop();
  }
}
