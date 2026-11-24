import { Cell, readonlyCell, type ReadonlyCell } from "@audiorective/core";
import type { ProjectClip } from "./model";
import type { BeatRange } from "./project-edits";

export type LoopSegment = Readonly<{
  /** Continuous transport beats. */
  transportStart: number;
  transportEnd: number;
  /** Arrangement beats these transport beats play. */
  beatStart: number;
  beatEnd: number;
  /** -1 before the first wrap, then 0, 1, ... for each repeat. */
  cycle: number;
}>;

/**
 * Folds the continuous transport axis onto the arrangement. The transport never jumps: from `originTransport`, which plays `originBeat`, it runs
 * straight to the region's end and then repeats the region. Without a region, or from past its end, the fold is a plain offset.
 */
export class LoopFold {
  readonly region: BeatRange | null;
  /** Transport beat of the first wrap, or null when this fold never wraps. */
  readonly wrapTransport: number | null;

  constructor(
    readonly originTransport: number,
    readonly originBeat: number,
    region: BeatRange | null,
  ) {
    this.region = region && originBeat < region.endBeat ? region : null;
    this.wrapTransport = this.region ? originTransport + (this.region.endBeat - originBeat) : null;
  }

  private get length(): number {
    return this.region!.endBeat - this.region!.startBeat;
  }

  private cycleAt(transport: number): number {
    return Math.floor((transport - this.wrapTransport!) / this.length + 1e-12);
  }

  /** The arrangement beat a transport beat plays. */
  toBeat(transport: number): number {
    if (this.wrapTransport === null || transport < this.wrapTransport) return this.originBeat + (transport - this.originTransport);
    const cycle = this.cycleAt(transport);
    return Math.min(this.region!.endBeat, this.region!.startBeat + Math.max(0, transport - this.wrapTransport - cycle * this.length));
  }

  /** Split a half-open transport window at each wrap. */
  segments(from: number, to: number): LoopSegment[] {
    if (!(to > from)) return [];
    const out: LoopSegment[] = [];
    let at = from;
    while (at < to - 1e-12) {
      if (this.wrapTransport === null || at < this.wrapTransport - 1e-12) {
        const end = this.wrapTransport === null ? to : Math.min(to, this.wrapTransport);
        out.push({
          transportStart: at,
          transportEnd: end,
          beatStart: this.toBeat(at),
          beatEnd: this.originBeat + (end - this.originTransport),
          cycle: -1,
        });
        at = end;
        continue;
      }
      // Rounding at a large transport beat can land just before a boundary; always move on to a cycle that ends after `at`.
      let cycle = Math.max(0, this.cycleAt(at));
      const cycleEnd = (index: number) => this.wrapTransport! + (index + 1) * this.length;
      while (cycleEnd(cycle) <= at) cycle++;
      const cycleStart = this.wrapTransport + cycle * this.length;
      const end = Math.min(to, cycleEnd(cycle));
      const { startBeat } = this.region!;
      out.push({
        transportStart: at,
        transportEnd: end,
        beatStart: Math.min(this.region!.endBeat, startBeat + Math.max(0, at - cycleStart)),
        beatEnd: Math.min(this.region!.endBeat, startBeat + (end - cycleStart)),
        cycle,
      });
      at = end;
    }
    return out;
  }

  /** Transport beats of the wraps inside a half-open window. */
  wraps(from: number, to: number): number[] {
    if (this.wrapTransport === null) return [];
    const out: number[] = [];
    let cycle = Math.max(0, Math.ceil((from - this.wrapTransport) / this.length - 1e-12));
    for (let at = this.wrapTransport + cycle * this.length; at < to - 1e-12; at = this.wrapTransport + ++cycle * this.length) out.push(at);
    return out;
  }
}

const noteKey = (channel: number, pitch: number) => (channel << 8) | pitch;

/**
 * MIDI to send at a wrap so nothing hangs: a note-off for each note still held at the region's end, and each controller or pitch bend the region
 * changed put back to its value at the region's start.
 */
export function loopWrapMessages(clips: readonly ProjectClip[], region: BeatRange): Uint8Array[] {
  const events: { beat: number; data: Uint8Array }[] = [];
  for (const clip of clips) {
    if (clip.kind !== "midi") continue;
    for (const event of clip.playbackEvents()) events.push({ beat: clip.time + event.beat, data: event.data });
  }
  events.sort((a, b) => a.beat - b.beat);
  const held = new Set<number>();
  const atStart = new Map<number, Uint8Array>();
  const changed = new Map<number, number>();
  for (const { beat, data } of events) {
    const status = data[0] & 0xf0;
    const channel = data[0] & 15;
    if (beat < region.endBeat - 1e-9 && (status === 0x90 || status === 0x80)) {
      if (status === 0x90 && data[2] > 0) held.add(noteKey(channel, data[1]));
      else held.delete(noteKey(channel, data[1]));
    }
    const control = status === 0xb0 && data[1] < 120 ? (channel << 8) | data[1] : status === 0xe0 ? (channel << 8) | 0x1000 : undefined;
    if (control === undefined) continue;
    if (beat <= region.startBeat + 1e-9) atStart.set(control, data);
    else if (beat < region.endBeat - 1e-9) changed.set(control, status === 0xe0 ? -1 : data[1]);
  }
  const out: Uint8Array[] = [];
  for (const key of held) out.push(Uint8Array.of(0x80 | (key >> 8), key & 0xff, 0));
  for (const [control, controller] of changed) {
    const restored = atStart.get(control);
    const channel = (control >> 8) & 15;
    if (restored) out.push(restored);
    else if (controller === -1) out.push(Uint8Array.of(0xe0 | channel, 0, 0x40));
    else if (controller === 64) out.push(Uint8Array.of(0xb0 | channel, 64, 0));
  }
  return out;
}

let createLoop: (apply: () => void, validate: (region: BeatRange) => void) => WorkspaceLoop;

/** Sample-accurate loop of arrangement playback. Playback state only: not saved, not in undo, not in exports or `renderMixRange`. */
export class WorkspaceLoop {
  readonly cells: Readonly<{
    /** Half-open project beats; kept while the loop is off. */
    region: ReadonlyCell<BeatRange | null>;
    enabled: ReadonlyCell<boolean>;
  }>;
  private readonly regionStore = new Cell<BeatRange | null>(null);
  private readonly enabledStore = new Cell(false);

  static {
    createLoop = (apply, validate) => new WorkspaceLoop(apply, validate);
  }

  private constructor(
    private readonly apply: () => void,
    private readonly validate: (region: BeatRange) => void,
  ) {
    this.cells = Object.freeze({ region: readonlyCell(this.regionStore), enabled: readonlyCell(this.enabledStore) });
  }

  /** Set or clear the region; a running transport follows it at once. Clearing the region turns the loop off. */
  setRegion(region: BeatRange | null): void {
    if (region) {
      if (!Number.isFinite(region.startBeat) || !Number.isFinite(region.endBeat) || region.startBeat < 0 || region.startBeat >= region.endBeat)
        throw new RangeError("Workspace loop region needs 0 <= startBeat < endBeat.");
      this.validate(region);
    }
    const old = this.regionStore.value;
    if (old?.startBeat === region?.startBeat && old?.endBeat === region?.endBeat) return;
    this.regionStore.value = region && Object.freeze({ startBeat: region.startBeat, endBeat: region.endBeat });
    if (!region) this.enabledStore.value = false;
    this.apply();
  }

  /** Turn looping on or off without stopping playback. Turning it on needs a region. */
  setEnabled(enabled: boolean): void {
    if (enabled && !this.regionStore.value) throw new Error("Workspace loop needs a region before it is enabled.");
    if (this.enabledStore.value === enabled) return;
    this.enabledStore.value = enabled;
    this.apply();
  }
}

/** @internal The Workspace owns its loop. */
export const createWorkspaceLoop = (apply: () => void, validate: (region: BeatRange) => void): WorkspaceLoop => createLoop(apply, validate);
