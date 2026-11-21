/** MIDI notes in beats that play into an instrument in time with a clock; the one note model for playback and editing.
 * Reads: ./midi-data for note validation and the beat/length helpers. Layering: core only; the clock contract is structural.
 */
import { batch, cell, readonlyCell, untracked, type BeatTiming, type CancellableEvent, type ReadonlyCell } from "@audiorective/core";
import { noteBeats, normalizeNotes, type DraftNote, type Instrument, type MidiNote, type NoteInit } from "./midi-data";

/** A clip length in beats, or a note value of the clock's meter: "2m" two bars, "4n" one beat. */
export type ClipLength = number | `${number}m` | `${number}n`;
/** Why a clock resets its schedulers: it started, stopped, paused or jumped, or the scheduler is leaving. */
export type ClipResetReason = "start" | "stop" | "pause" | "seek" | "detach";
/** The part of a tick window `schedule` reads (a clock's `SchedulerWindow`). */
export type ClipWindow = Readonly<{
  beat: { start: number; end: number };
  time: { current: number };
  own(event: CancellableEvent, when: number): void;
}>;
/** What a clock or launcher hands a scheduler on attach; the clock's `SchedulerHandle` is one. */
export type ClipTransport = Readonly<{
  refresh(): void;
  detach(): void;
  /** The clock's time signature, when the transport has one: bars ("1m") are measured in it. */
  meter?: Readonly<{ value: readonly [number, number] }>;
}>;
/** One change of the transport, reported after it is applied. */
export type ClipTransportChange = Readonly<{ type: string; when: number; beat: number }>;

export interface MidiClipOptions {
  /** Where the notes play. Assignable later through `clip.instrument`. */
  instrument?: Instrument;
  /** Repeat every `length` while attached to a clock directly. Default false. In a ClipLauncher the launcher clip's `loop` and `length` decide instead. */
  loop?: boolean;
  /** Where a loop wraps. Default: the end of the last note, rounded up to a whole bar. */
  length?: ClipLength;
  /** Aborting the signal calls `dispose()`. */
  signal?: AbortSignal;
}

type Sent = {
  instrument: Instrument;
  pitch: number;
  on: number;
  off: number;
  cancelOn?: () => void;
  cancelOff?: () => void;
  done: boolean;
  ended: Array<() => void>;
};
const EPS = 1e-8;
const cancelOf = (result: unknown): (() => void) | undefined => {
  const cancel = (result as { cancel?: unknown } | null | undefined)?.cancel;
  return typeof cancel === "function" ? () => (cancel as () => void).call(result) : undefined;
};

/**
 * MIDI notes in beats that play into an instrument in time with a clock: `clock.attach(clip)` (the clip's beat 0 is the transport's beat 0),
 * or `{ scheduler: clip }` as a ClipLauncher clip (beat 0 is the launch). The clip pairs every note-on with its note-off and cuts notes at a loop's wrap.
 * On stop, reset or detach it sends every note-on it already sent a note-off at `max(now, that note's start time)`, so no note hangs. A tempo change re-times the notes not yet played.
 */
export class MidiClip {
  /** Where the notes play. Writable; a change applies to notes scheduled afterwards. */
  instrument: Instrument | null;
  /** Every note, sorted by `start`. Tracked; replaced in one write per commit. */
  readonly notes: ReadonlyCell<readonly MidiNote[]>;
  /** Increments once per commit (`edit`, `setNotes`); a view that re-renders on it renders once per edit. */
  readonly revision: ReadonlyCell<number>;

  private readonly store = cell<readonly MidiNote[]>(Object.freeze([]));
  private readonly revisionStore = cell(0);
  private readonly loop: boolean;
  private readonly length: ClipLength | undefined;
  private readonly sent = new Set<Sent>();
  private readonly handles = new Set<ClipTransport>();
  private readonly signal: AbortSignal | undefined;
  private lastNow = 0;
  private disposed = false;
  private readonly onAbort = () => this.dispose();

  constructor(notes: readonly NoteInit[] = [], options: MidiClipOptions = {}) {
    this.instrument = options.instrument ?? null;
    this.loop = options.loop ?? false;
    this.length = options.length;
    if (typeof this.length === "string") noteBeats(this.length, 4);
    else if (this.length !== undefined && !(Number.isFinite(this.length) && this.length > 0))
      throw new RangeError("MidiClip length must be positive beats or a note value.");
    this.notes = readonlyCell(this.store);
    this.revision = readonlyCell(this.revisionStore);
    this.store.value = normalizeNotes(notes, "MidiClip");
    this.signal = options.signal;
    if (this.signal) {
      if (this.signal.aborted) this.dispose();
      else this.signal.addEventListener("abort", this.onAbort, { once: true });
    }
  }

  private commit(notes: readonly NoteInit[]): void {
    if (this.disposed) throw new Error("MidiClip is disposed.");
    const next = normalizeNotes(notes, "MidiClip");
    batch(() => {
      this.store.value = next;
      this.revisionStore.value = untracked(() => this.revisionStore.value) + 1;
    });
  }

  /** Replaces every note in one commit. */
  setNotes(notes: readonly NoteInit[]): void {
    this.commit(notes);
  }

  /**
   * Changes notes in one commit: `recipe` mutates a draft array (change fields, push, splice). It is heard from the next window the clock schedules
   * (a window already scheduled keeps the notes it started with); a note already sounding plays to its end.
   */
  edit(recipe: (draft: DraftNote[]) => void): void {
    if (this.disposed) throw new Error("MidiClip is disposed.");
    const draft = untracked(() => this.store.value).map((note) => ({ ...note })) as DraftNote[];
    recipe(draft);
    this.commit(draft);
  }

  private barBeats(): number {
    for (const handle of this.handles) {
      const meter = handle.meter?.value;
      if (meter) return (meter[0] * 4) / meter[1];
    }
    return 4;
  }

  private loopBeats(notes: readonly MidiNote[]): number {
    if (typeof this.length === "number") return this.length;
    const bar = this.barBeats();
    if (typeof this.length === "string") return noteBeats(this.length, bar);
    let end = 0;
    for (const note of notes) end = Math.max(end, note.start + note.duration);
    return Math.max(1, Math.ceil(end / bar - EPS)) * bar;
  }

  /** Clock scheduler contract, called by `clock.attach(clip)` or a ClipLauncher; applications do not call it. */
  schedule(window: ClipWindow, timing: BeatTiming): void {
    untracked(() => {
      if (this.disposed) return;
      const now = window.time.current;
      this.lastNow = now;
      for (const sent of [...this.sent]) if (sent.off <= now) this.finish(sent);
      const instrument = this.instrument;
      if (!instrument) return;
      const notes = this.store.value;
      const from = window.beat.start - EPS;
      const to = window.beat.end - EPS;
      const play = (note: MidiNote, onBeat: number, offBeat: number) => {
        if (!(offBeat > onBeat) || onBeat < from || onBeat >= to) return;
        const on = Math.max(timing.beatToTime(onBeat), now);
        const off = Math.max(timing.beatToTime(offBeat), on);
        const sent: Sent = { instrument, pitch: note.pitch, on, off, done: false, ended: [] };
        sent.cancelOn = cancelOf(instrument.noteOn(note.pitch, { velocity: note.velocity, when: on, channel: note.channel }));
        sent.cancelOff = cancelOf(instrument.noteOff(note.pitch, off));
        this.sent.add(sent);
        window.own({ cancel: () => this.release(sent), onEnded: (listener) => void sent.ended.push(listener) }, on);
      };
      if (this.loop) {
        const length = this.loopBeats(notes);
        for (let pass = Math.max(0, Math.floor(from / length)); pass * length < to; pass++) {
          const base = pass * length;
          for (const note of notes) {
            if (note.start >= length) break;
            play(note, base + note.start, base + Math.min(note.start + note.duration, length));
          }
        }
      } else for (const note of notes) play(note, note.start, note.start + note.duration);
    });
  }

  private finish(sent: Sent): void {
    if (sent.done) return;
    sent.done = true;
    this.sent.delete(sent);
    for (const listener of sent.ended.splice(0)) listener();
  }

  /** Releases a sent note-on at `max(now, its start)`; a note that already ended is left alone. */
  private release(sent: Sent): void {
    if (sent.done) return;
    if (sent.off <= this.lastNow) return this.finish(sent);
    sent.cancelOff?.();
    if (sent.on > this.lastNow) sent.cancelOn?.();
    try {
      sent.instrument.noteOff(sent.pitch, Math.max(this.lastNow, sent.on));
    } finally {
      this.finish(sent);
    }
  }

  /** Clock scheduler contract: sends the note-off of every note-on already sent, at `max(now, its start)`. */
  reset(_reason?: ClipResetReason): void {
    untracked(() => {
      for (const sent of [...this.sent]) this.release(sent);
    });
  }

  /** Clock scheduler contract: a tempo change re-queues the look-ahead so notes not yet played are re-timed. */
  transport(change: ClipTransportChange): void {
    if (change.type !== "tempo") return;
    for (const handle of [...this.handles]) handle.refresh();
  }

  /** Clock scheduler contract, called by `clock.attach(clip)` or a ClipLauncher; applications do not call it. */
  attached(handle: ClipTransport): () => void {
    if (this.disposed) throw new Error("MidiClip is disposed.");
    this.handles.add(handle);
    return () => void this.handles.delete(handle);
  }

  /** Releases the notes already sent (see the class note) and detaches from every transport. Safe to call twice. */
  dispose(): void {
    if (this.disposed) return;
    for (const handle of [...this.handles]) handle.detach();
    this.reset("detach");
    this.disposed = true;
    this.handles.clear();
    this.signal?.removeEventListener("abort", this.onAbort);
  }

  [Symbol.dispose](): void {
    this.dispose();
  }
}
