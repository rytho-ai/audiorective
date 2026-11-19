import { batch, cell, readonlyCell, untracked, type BeatTiming } from "@audiorective/core";

export type ClipLaunch = Readonly<{ trackId: string; clipId: string | null; mode?: "loop" | "one-shot" }>;
/** A pending launch with the grid boundary it will switch on. `beat` and `when` are the same instant. */
export type QueuedClipLaunch = Readonly<ClipLaunch & { beat: number; when: number }>;
/** `active` and `queued` hold at most one entry per track. */
export type ClipLauncherState = Readonly<{ active: readonly ClipLaunch[]; queued: readonly QueuedClipLaunch[] }>;
export type ClipLaunchTransition = Readonly<{
  /** Retract the incoming playback and leave the previous playback intact. */
  cancel(): void;
  /** Release the outgoing playback; the switch time has arrived. */
  commit(): void;
  /** Absolute audio time at which a finite (one-shot) override naturally ends. */
  endsAt?: number;
}>;
export type ClipLaunchTransport = BeatTiming &
  Readonly<{
    now(): number;
    /** Prepare one track's change to take effect at `when`. Called once per track, with the same `when` for every track of a call. */
    schedule(change: ClipLaunch, when: number): ClipLaunchTransition;
    reset(): void;
  }>;

const none: readonly never[] = Object.freeze([]);
const empty: ClipLauncherState = Object.freeze({ active: none, queued: none });

/** Quantized per-track overrides using a borrowed audio clock and reversible playback driver. */
export class ClipLauncher {
  private readonly source = cell<ClipLauncherState>(empty);
  private readonly pending = new Map<string, { launch: QueuedClipLaunch; transition: ClipLaunchTransition }>();
  private readonly endsAt = new Map<string, number>();
  readonly state = readonlyCell(() => this.source.value);

  constructor(private readonly transport: ClipLaunchTransport) {}

  /**
   * Queue one launch per listed track for the next boundary of `quantumBeats` (0 launches at the current audio time).
   * Every track of one call lands on the same boundary. A track's new launch replaces only that track's pending launch.
   */
  queue(changes: readonly ClipLaunch[], quantumBeats = 1): readonly QueuedClipLaunch[] {
    return untracked(() => this.enqueue(changes, quantumBeats));
  }

  private enqueue(changes: readonly ClipLaunch[], quantumBeats: number): readonly QueuedClipLaunch[] {
    if (!Number.isFinite(quantumBeats) || quantumBeats < 0) throw new RangeError("Clip Launcher requires a non-negative launch quantum.");
    if (!changes.length || new Set(changes.map(({ trackId }) => trackId)).size !== changes.length) {
      throw new Error("Clip Launcher requires one launch per affected track.");
    }
    const now = this.transport.now();
    const position = this.transport.timeToBeat(now);
    const beat = quantumBeats === 0 ? position : (Math.floor(position / quantumBeats + 1e-10) + 1) * quantumBeats;
    const when = quantumBeats === 0 ? now : this.transport.beatToTime(beat);
    if (!Number.isFinite(when) || (quantumBeats > 0 && when <= now)) throw new RangeError("Clip Launcher requires a future audio time.");
    const launches = changes.map((change) => Object.freeze({ ...change, beat, when }));

    batch(() => {
      this.advance();
      for (const { trackId } of launches) this.withdraw(trackId);
      const created: ClipLaunchTransition[] = [];
      try {
        for (const launch of launches) {
          const { beat: _beat, when: _when, ...change } = launch;
          const transition = this.transport.schedule(change, when);
          created.push(transition);
          this.pending.set(launch.trackId, { launch, transition });
        }
      } catch (error) {
        for (const { trackId } of launches) this.pending.delete(trackId);
        for (const transition of created) transition.cancel();
        this.publish();
        throw error;
      }
      this.publish();
    });
    return Object.freeze(launches);
  }

  /** Withdraw `trackId`'s pending launch, or every pending launch without an argument. Returns whether anything was withdrawn. */
  cancel(trackId?: string): boolean {
    return untracked(() => {
      this.advance();
      const ids = trackId === undefined ? [...this.pending.keys()] : [trackId];
      const withdrawn = ids.map((id) => this.withdraw(id));
      if (!withdrawn.includes(true)) return false;
      this.publish();
      return true;
    });
  }

  private withdraw(trackId: string): boolean {
    const entry = this.pending.get(trackId);
    if (!entry) return false;
    this.pending.delete(trackId);
    entry.transition.cancel();
    return true;
  }

  private publish(active: readonly ClipLaunch[] = this.source.value.active): void {
    this.source.value = Object.freeze({ active, queued: Object.freeze([...this.pending.values()].map(({ launch }) => launch)) });
  }

  /** Publish every switch whose audio time has arrived. Call it from the borrowed transport's tick. */
  advance(): void {
    untracked(() => this.settle());
  }

  private settle(): void {
    const now = this.transport.now();
    const due = [...this.pending.values()].filter(({ launch }) => launch.when <= now);
    if (!due.length && ![...this.endsAt.values()].some((end) => end <= now)) return;
    const tracks = new Map(this.source.value.active.map((change) => [change.trackId, change]));
    for (const { launch, transition } of due) {
      const { beat: _beat, when: _when, ...change } = launch;
      this.pending.delete(change.trackId);
      transition.commit();
      if (transition.endsAt === undefined) this.endsAt.delete(change.trackId);
      else this.endsAt.set(change.trackId, transition.endsAt);
      if (change.clipId === null) tracks.delete(change.trackId);
      else tracks.set(change.trackId, change);
    }
    for (const [id, end] of this.endsAt) {
      if (end > now) continue;
      this.endsAt.delete(id);
      tracks.delete(id);
    }
    this.publish(Object.freeze([...tracks.values()]));
  }

  /** Clear pending and active overrides when the borrowed transport jumps or stops. */
  reset(): void {
    for (const { transition } of this.pending.values()) transition.cancel();
    this.pending.clear();
    this.endsAt.clear();
    this.transport.reset();
    this.source.value = empty;
  }
}
