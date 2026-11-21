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
  noteId: string;
  onBeat: number;
  offBeat: number;
  /** A sounding note whose cancel arrived: it is cut at this time unless the next window re-emits it (a refresh), decided after the current task. */
  cutAt: number | null;
  timer?: ReturnType<typeof setTimeout>;
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
 * When the transport stops, pauses, seeks or the clip detaches, and when a ClipLauncher stops or replaces the clip, every note-on already sent gets a note-off at `max(that time, the note's start time)` and its pending natural note-off is cancelled, so no note hangs or rings on. A refresh never cuts a sounding note. A tempo change re-times the notes not yet played.
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
      this.adopt(window, notes, timing);
      const play = (note: MidiNote, onBeat: number, offBeat: number) => {
        if (!(offBeat > onBeat) || onBeat < from || onBeat >= to) return;
        const on = Math.max(timing.beatToTime(onBeat), now);
        const off = Math.max(timing.beatToTime(offBeat), on);
        const sent: Sent = { instrument, noteId: note.id, onBeat, offBeat, cutAt: null, pitch: note.pitch, on, off, done: false, ended: [] };
        sent.cancelOn = cancelOf(instrument.noteOn(note.pitch, { velocity: note.velocity, when: on, channel: note.channel }));
        sent.cancelOff = cancelOf(instrument.noteOff(note.pitch, off));
        this.sent.add(sent);
        this.own(window, sent);
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

  /** Registers the note with the clock at its end time, so a cancel from any time up to it reaches the note whether or not it has started. */
  private own(window: ClipWindow, sent: Sent): void {
    sent.ended = [];
    window.own({ cancel: (time) => this.cancel(sent, time), onEnded: (listener) => void sent.ended.push(listener) }, sent.off);
  }

  /** A window that starts inside a note a refresh just retracted continues it: nothing is cut or doubled. */
  private adopt(window: ClipWindow, notes: readonly MidiNote[], timing: BeatTiming): void {
    const reaches = timing.beatToTime(window.beat.end);
    for (const sent of this.sent) {
      // only a window that reaches past the cut continues the note: the last window of a stopped clip ends at its stop
      if (sent.cutAt === null || sent.done || !(sent.offBeat > window.beat.start - EPS) || !(reaches > sent.cutAt + EPS)) continue;
      const note = notes.find((n) => n.id === sent.noteId);
      if (!note || note.pitch !== sent.pitch) continue;
      clearTimeout(sent.timer);
      sent.cutAt = null;
      this.own(window, sent);
    }
  }

  private finish(sent: Sent): void {
    if (sent.done) return;
    sent.done = true;
    clearTimeout(sent.timer);
    this.sent.delete(sent);
    for (const listener of sent.ended.splice(0)) listener();
  }

  /**
   * The clock retracts a note: `time` is when. A note that has not started is revoked (its note-on is cancelled if the instrument can);
   * one that is sounding is cut at `time` unless the next window continues it, which a refresh does.
   */
  private cancel(sent: Sent, time?: number): void {
    if (sent.done) return;
    const at = Math.max(time ?? this.lastNow, sent.on);
    if (sent.on > this.lastNow) return this.release(sent, at, true);
    if (sent.cutAt !== null && sent.cutAt <= at) return; // an earlier cut is already pending
    sent.cutAt = at;
    clearTimeout(sent.timer);
    sent.timer = setTimeout(() => untracked(() => this.release(sent, at)), 0);
  }

  /**
   * Sends the note-off of a sent note-on at `at` (default `max(now, its start)`) in place of the pending natural one. A cut that lies ahead leaves the note
   * tracked until it passes, so a still earlier cut (a stop inside the same look-ahead) can move it again. `final` ends the record now.
   */
  private release(sent: Sent, at = Math.max(this.lastNow, sent.on), final = false): void {
    if (sent.done) return;
    if (sent.off <= at) return final ? this.finish(sent) : undefined;
    sent.cancelOff?.();
    if (sent.on > this.lastNow) sent.cancelOn?.();
    sent.cancelOn = undefined;
    const when = Math.max(at, sent.on);
    sent.off = when;
    sent.cutAt = null;
    try {
      sent.cancelOff = cancelOf(sent.instrument.noteOff(sent.pitch, when));
    } finally {
      if (final || when <= this.lastNow) this.finish(sent);
    }
  }

  /** Clock scheduler contract: sends the note-off of every note-on already sent, at `max(now, its start)`. */
  reset(_reason?: ClipResetReason): void {
    untracked(() => {
      for (const sent of [...this.sent]) this.release(sent, sent.cutAt ?? undefined, true);
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
