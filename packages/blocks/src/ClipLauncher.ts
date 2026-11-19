import { batch, cell, readonlyCell, untracked, type BeatTiming } from "@audiorective/core";

export type ClipLaunch = Readonly<{ trackId: string; clipId: string | null; mode?: "loop" | "one-shot" }>;
export type QueuedClipLaunch = Readonly<{ beat: number; when: number; changes: readonly ClipLaunch[] }>;
export type ClipLauncherState = Readonly<{ active: readonly ClipLaunch[]; queued: QueuedClipLaunch | null }>;
export type ClipLaunchTransition = Readonly<{
  cancel(): void;
  commit(): void;
  /** Absolute audio time at which each finite override naturally ends. */
  endsAt?: ReadonlyMap<string, number>;
}>;
export type ClipLaunchTransport = BeatTiming &
  Readonly<{
    now(): number;
    schedule(changes: readonly ClipLaunch[], when: number): ClipLaunchTransition;
    reset(): void;
  }>;

const empty: ClipLauncherState = Object.freeze({ active: Object.freeze([]), queued: null });

/** Quantized track overrides using a borrowed audio clock and reversible playback driver. */
export class ClipLauncher {
  private readonly source = cell<ClipLauncherState>(empty);
  private transition?: ClipLaunchTransition;
  private readonly endsAt = new Map<string, number>();
  readonly state = readonlyCell(() => this.source.value);

  constructor(private readonly transport: ClipLaunchTransport) {}

  /** Queue one group for the next grid boundary. A new group replaces the pending group. */
  queue(changes: readonly ClipLaunch[], quantumBeats = 1): QueuedClipLaunch {
    return untracked(() => this.enqueue(changes, quantumBeats));
  }

  private enqueue(changes: readonly ClipLaunch[], quantumBeats: number): QueuedClipLaunch {
    if (!Number.isFinite(quantumBeats) || quantumBeats <= 0) throw new RangeError("Clip Launcher requires a positive launch quantum.");
    if (!changes.length || new Set(changes.map(({ trackId }) => trackId)).size !== changes.length) {
      throw new Error("Clip Launcher requires one launch per affected track.");
    }
    const now = this.transport.now();
    const position = this.transport.timeToBeat(now);
    const beat = (Math.floor(position / quantumBeats + 1e-10) + 1) * quantumBeats;
    const when = this.transport.beatToTime(beat);
    if (!Number.isFinite(when) || when <= now) throw new RangeError("Clip Launcher requires a future audio time.");
    const queued = Object.freeze({ beat, when, changes: Object.freeze(changes.map((change) => Object.freeze({ ...change }))) });

    batch(() => {
      this.dequeue();
      this.transition = this.transport.schedule(queued.changes, when);
      this.source.value = Object.freeze({ active: this.source.value.active, queued });
    });
    return queued;
  }

  /** Cancel the pending group if its audio deadline has not arrived. */
  cancel(): boolean {
    return untracked(() => this.dequeue());
  }

  private dequeue(): boolean {
    this.advance();
    if (!this.transition) return false;
    this.transition.cancel();
    this.transition = undefined;
    this.source.value = Object.freeze({ active: this.source.value.active, queued: null });
    return true;
  }

  /** Publish a switch after the audio clock reaches its already scheduled deadline. */
  advance(): void {
    untracked(() => this.settle());
  }

  private settle(): void {
    const { active, queued } = this.source.value;
    const now = this.transport.now();
    const due = queued && queued.when <= now;
    if (!due && ![...this.endsAt.values()].some((end) => end <= now)) return;
    const tracks = new Map(active.map((change) => [change.trackId, change]));
    if (due && queued) {
      const transition = this.transition!;
      transition.commit();
      this.transition = undefined;
      for (const change of queued.changes) {
        const end = transition.endsAt?.get(change.trackId);
        if (end === undefined) this.endsAt.delete(change.trackId);
        else this.endsAt.set(change.trackId, end);
        if (change.clipId === null) tracks.delete(change.trackId);
        else tracks.set(change.trackId, change);
      }
    }
    for (const [id, end] of this.endsAt) {
      if (end > now) continue;
      this.endsAt.delete(id);
      tracks.delete(id);
    }
    this.source.value = Object.freeze({ active: Object.freeze([...tracks.values()]), queued: due ? null : queued });
  }

  /** Clear pending and active overrides when the borrowed transport jumps or stops. */
  reset(): void {
    this.transition?.cancel();
    this.transition = undefined;
    this.endsAt.clear();
    this.transport.reset();
    this.source.value = empty;
  }
}
