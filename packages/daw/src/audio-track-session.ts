import type { ScheduleHandle } from "@audiorective/launcher";

type Change = { when: number; playing: boolean; end: number | undefined };

/**
 * Switches one track between Arrangement and Session upstream of its shared devices, effects and mixer. Session clips play through the launcher
 * into `input`; this holds the Arrangement side: its gain is 0 from a launch until a stop or the end of a one-shot, and 1 otherwise.
 */
export class AudioTrackSession {
  readonly arrangementInput: GainNode;
  private changes: Change[] = [];

  constructor(
    private readonly context: AudioContext,
    input: AudioNode,
  ) {
    this.arrangementInput = context.createGain();
    this.arrangementInput.connect(input);
  }

  /**
   * Follow one launcher change: from `when` the track plays a Session clip (`playing`, until `endsAt` for a one-shot) or returns to Arrangement.
   * The returned handle withdraws the change (it was cancelled, replaced or reset); the previous change then applies again.
   */
  follow(when: number, playing: boolean, endsAt: number | null): ScheduleHandle {
    const change: Change = { when, playing, end: endsAt ?? undefined };
    this.changes.push(change);
    this.apply();
    const remove = () => {
      const index = this.changes.indexOf(change);
      if (index < 0) return;
      this.changes.splice(index, 1);
      this.apply();
    };
    return { cancel: remove, reset: remove };
  }

  /** Arrangement gain at audio time `time`: 0 while the latest change at or before it is a clip that has not ended. */
  private levelAt(time: number): number {
    let level = 1;
    for (const change of this.changes) {
      if (change.when > time) break;
      level = change.playing && !(change.end !== undefined && change.end <= time) ? 0 : 1;
    }
    return level;
  }

  private apply(): void {
    const now = this.context.currentTime;
    this.changes.sort((left, right) => left.when - right.when);
    const lastPast = this.changes.findLastIndex((change) => change.when <= now);
    if (lastPast > 0) this.changes.splice(0, lastPast);
    const times = new Set<number>();
    for (const { when, end } of this.changes) {
      if (when > now) times.add(when);
      if (end !== undefined && end > now) times.add(end);
    }
    const gain = this.arrangementInput.gain;
    gain.cancelScheduledValues(now);
    gain.setValueAtTime(this.levelAt(now), now);
    for (const time of [...times].sort((left, right) => left - right)) gain.setValueAtTime(this.levelAt(time), time);
  }

  dispose(): void {
    this.changes = [];
    this.arrangementInput.disconnect();
  }
}
