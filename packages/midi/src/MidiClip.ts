/** MIDI notes in beats that play into an instrument in time with a clock; the one note model for playback and editing.
 * Reads: ./midi-data for note validation and the beat/length helpers. Layering: core only; the clock contract is structural.
 */
import {
  batch,
  cell,
  hash01,
  readonlyCell,
  resolveHitEdit,
  untracked,
  type BeatTiming,
  type CancellableEvent,
  type Random,
  type ReadonlyCell,
} from "@audiorective/core";
import { noteBeats, normalizeNotes, type NoteDraft, type Instrument, type MidiNote, type NoteInit } from "./midi-data";
import { chaseMessages, controllerStateKey, restOf } from "./midi-rest";

/** A clip length in beats, or a note value of the clock's meter: "2m" two bars, "4n" one beat. */
export type ClipLength = number | `${number}m` | `${number}n`;
/** Why a clock resets its schedulers: it started, stopped, paused or jumped, or the scheduler is leaving. */
export type ClipResetReason = "start" | "stop" | "pause" | "seek" | "detach";
/** The part of a tick window `schedule` reads (a clock's `SchedulerWindow`). */
export type ClipWindow = Readonly<{
  /** Clip-relative quarter-note beat interval to schedule, half-open [start, end). */
  beat: {
    /** Inclusive lower boundary in quarter-note beats. */
    start: number;
    /** Exclusive upper boundary in quarter-note beats. */
    end: number;
  };
  /** `current`: the audio-context time of the tick, in seconds. */
  time: {
    /** Absolute AudioContext seconds at this scheduling tick. */
    current: number;
  };
  /** Registers an event at absolute AudioContext `when` seconds for transport cancellation. */
  own(event: CancellableEvent, when: number): void;
}>;
/** What a clock or launcher hands a scheduler on attach; the clock's `SchedulerHandle` is one. */
export type ClipTransport = Readonly<{
  /** Retracts and refills pending clip events after an edit. */
  refresh(): void;
  /** Stops following the clock and cancels the clip's owned events. */
  detach(): void;
  /** A ClipLauncher's answer for the clip: the beats its `loop` and `length` repeat every, or null when the launcher clip does not loop. Present only in a launcher. */
  loopBeats?(): number | null;
  /** The audio-context time now, when the transport can tell (a ClipLauncher's handle). A clock's handle has `timeline.now`. */
  now?(): number;
  /** The clock's timeline: `timeline.now` is the audio-context time now. */
  timeline?: Readonly<{
    /** Current absolute AudioContext time in seconds. */
    now: number;
  }>;
  /** The clock's time signature, when the transport has one: bars ("1m") are measured in it. */
  meter?: Readonly<{
    /** Meter tuple [numerator, denominator]; used to interpret bar-based note values. */
    value: readonly [number, number];
  }>;
}>;
/** One change of the transport, reported after it is applied. */
export type ClipTransportChange = Readonly<{
  /** Transport operation identifier; tempo changes retime pending note events. */
  type: string;
  /** Absolute AudioContext seconds at which the change takes effect. */
  when: number;
  /** Quarter-note transport beat at the effective audio time. */
  beat: number;
}>;

/** One note as `transform` sees it, in beats and seconds. `when` and `duration` follow `beat` and `durationBeats` through the transport's timing. */
export type NoteHit = Readonly<{
  /** Stable note identifier, preserved across edits and transformed playback. */
  id: string;
  /** Read-only: a changed `pitch` or `channel` is ignored. */
  pitch: number;
  /** Zero-based MIDI channel, 0..15. */
  channel: number;
  /** 0..1. */
  velocity: number;
  /** Beat position in the transport's beats (the loop pass's start plus the note's `start`); move it to shift the note and stay on the grid when the tempo changes. */
  beat: number;
  /** Length in beats; change it to resize the note tempo-locked. */
  durationBeats: number;
  /** Audio-context seconds; move it for millisecond nudges. */
  when: number;
  /** Seconds. */
  duration: number;
  /** The loop pass the note plays in (0 when the clip does not loop). */
  loop: number;
}>;
/** Returns the note to play, or `null` to drop it. `random(key?)` is in [0, 1) and fixed by `seed`, the note's id and `key`, so every pass and every re-queue draws the same numbers. */
export type NoteTransform = (note: NoteHit, random: Random) => NoteHit | null;

/** A message other than a note, at a beat from the start of a pass: a controller (sustain, mod wheel), pitch bend, program change or pressure. */
export type ClipMessage = Readonly<{
  /** Clip-relative event position in quarter-note beats. */
  beat: number;
  /** Raw MIDI wire bytes; velocity bytes are normalized when converted into note data. */
  data: Uint8Array;
}>;

export interface MidiClipOptions {
  /**
   * Controller, pitch-bend, program-change and pressure messages that play with the notes: each is sent to `instrument.scheduleMidi` at its beat, and a looping clip repeats them every pass. Default none.
   * See `setMessages`.
   */
  messages?: readonly ClipMessage[];
  /** Adjust or drop each note just before it is scheduled: move `beat` (tempo-locked) or `when` (ms), change `velocity` or `durationBeats`, or return `null`. The same shape as `StepSequencer`'s `transform`. */
  transform?: NoteTransform;
  /** Seeds `transform`'s `random`. Default 0. */
  seed?: number;
  /** Where the notes play. Assignable later through `clip.instrument`. */
  instrument?: Instrument;
  /** Repeat every `length` while attached to a clock directly (`clock.attach(clip)`). Default false. In a ClipLauncher only the launcher clip's `loop` and `length` apply and this is ignored. */
  loop?: boolean;
  /** Where a loop wraps when attached to a clock directly. Default: the end of the last note, rounded up to a whole bar. In a ClipLauncher the launcher clip's `length` applies and this is ignored. */
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
  /** Sends the note-on when it is still waiting for its place in the window's message order. */
  sendOn?: () => void;
  cancelOn?: () => void;
  cancelOff?: () => void;
  /** The beat transport the note was scheduled on: its off is sent in the window that contains it, at whatever tempo then. */
  timing: BeatTiming;
  /** False until the natural note-off is sent; a cut before then sends only the cut. */
  offSent: boolean;
  done: boolean;
  ended: Array<() => void>;
};
/** A controller message the clip sent: what puts that controller back at rest, and the sink event that withdraws it. */
type Emitted = { key: string; data: Uint8Array; rest: Uint8Array; atRest: boolean; when: number; cancelled: boolean; event?: unknown };
/** The clip that sent the latest message of each controller to an instrument: a clip that stops puts back only the controllers no later clip has taken over. */
const controllerOwners = new WeakMap<object, Map<string, { owner: object; when: number }>>();
/**
 * Records that something other than a MidiClip (the Arrangement handing a track back from a Session clip) set the controller `data` on `instrument` at `when`, so a
 * clip that is cut at or before `when` does not put that controller back at rest over it.
 */
export function claimController(instrument: object, data: Uint8Array | readonly number[], when: number): void {
  const key = controllerStateKey(data);
  if (key === undefined) return;
  const owners = controllerOwners.get(instrument) ?? new Map();
  controllerOwners.set(instrument, owners);
  owners.set(key, { owner: instrument, when });
}
const EPS = 1e-8;
/** Seconds within which two message times count as the same instant: round-off from `start + duration` against the next `start` (triplets, 0.1-beat grids) is far below it. */
const SAME_TIME = 1e-9;
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
  /** Controller, pitch-bend, program-change and pressure messages sent with the notes. Tracked; replaced by `setMessages`. */
  readonly messages: ReadonlyCell<readonly ClipMessage[]>;
  /** Increments once per commit (`edit`, `setNotes`); a view that re-renders on it renders once per edit. */
  readonly revision: ReadonlyCell<number>;

  private readonly store = cell<readonly MidiNote[]>(Object.freeze([]));
  private readonly revisionStore = cell(0);
  private readonly messageStore = cell<readonly ClipMessage[]>(Object.freeze([]));
  private readonly emitted: Emitted[] = [];
  /** The time a cut asked for the controllers this clip moved to be put back; a window that carries on past it (a refresh) withdraws the ask. */
  private restAt: number | null = null;
  private restTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly loop: boolean;
  private readonly length: ClipLength | undefined;
  private readonly transform: NoteTransform | undefined;
  private readonly seed: number;
  private readonly sent = new Set<Sent>();
  private readonly handles = new Set<ClipTransport>();
  private readonly signal: AbortSignal | undefined;
  /** The notes a loop pass plays, taken when the pass is first scheduled: an edit is heard from the next pass. */
  private pass: { index: number; notes: readonly MidiNote[] } | null = null;
  /** Start beat of the latest window: a window that starts earlier is a restart (stop and relaunch), and the pass snapshot is dropped. */
  private lastFrom = -Infinity;
  /** Where the next window has to start to continue the last one; null before the first window and after a seek, a stop or a pause, so the next window begins a run. */
  /** An instrument refused a message: reported once for the clip, then the clip keeps scheduling quietly. */
  private failed = false;
  private expectFrom: number | null = null;
  private lastNow = 0;
  private disposed = false;
  private writeGuard: (() => void) | null = null;
  private readonly onAbort = () => this.dispose();

  constructor(notes: readonly NoteInit[] = [], options: MidiClipOptions = {}) {
    this.instrument = options.instrument ?? null;
    this.loop = options.loop ?? false;
    this.length = options.length;
    if (options.transform !== undefined && typeof options.transform !== "function") throw new TypeError("MidiClip transform needs a function.");
    this.transform = options.transform;
    this.seed = options.seed ?? 0;
    if (typeof this.length === "string") noteBeats(this.length, 4);
    else if (this.length !== undefined && !(Number.isFinite(this.length) && this.length > 0))
      throw new RangeError("MidiClip length must be positive beats or a note value.");
    this.notes = readonlyCell(this.store);
    this.revision = readonlyCell(this.revisionStore);
    this.messages = readonlyCell(this.messageStore);
    if (options.messages) this.messageStore.value = normalizeMessages(options.messages);
    this.store.value = normalizeNotes(notes, "MidiClip");
    this.signal = options.signal;
    if (this.signal) {
      if (this.signal.aborted) this.dispose();
      else this.signal.addEventListener("abort", this.onAbort, { once: true });
    }
  }

  private commit(notes: readonly NoteInit[]): void {
    if (this.disposed) throw new Error("MidiClip is disposed.");
    this.writeGuard?.();
    const next = normalizeNotes(notes, "MidiClip");
    batch(() => {
      this.store.value = next;
      // a snapshot kept for a pass that is not playing (nothing sent is still sounding or pending) is stale
      if (![...this.sent].some((sent) => !sent.done)) this.pass = null;
      this.revisionStore.value = untracked(() => this.revisionStore.value) + 1;
    });
  }

  /** Replaces every note in one commit. */
  setNotes(notes: readonly NoteInit[]): void {
    this.commit(notes);
  }

  /**
   * Changes notes in one commit: `recipe` mutates a draft array (change fields, push, splice). A pushed note needs only `pitch`, `velocity`, `start` and `duration`: `id` is generated and `channel` defaults to 0. A looping clip keeps the notes of the pass playing and plays the edit from the next pass;
   * a clip that does not loop, or is not playing, uses it from the next window (one already scheduled keeps its notes); a note already sounding plays to its end.
   */
  edit(recipe: (draft: NoteDraft) => void): void {
    if (this.disposed) throw new Error("MidiClip is disposed.");
    this.writeGuard?.();
    const draft = untracked(() => this.store.value).map((note) => ({ ...note })) as NoteDraft;
    recipe(draft);
    this.commit(draft);
  }

  /**
   * Replaces the messages in one write. Each is `{ beat, data }`: `beat` counts from the start of a pass (the launch, or a loop's wrap) and `data` is one channel message with status 0xA0 (poly pressure), 0xB0 (controller), 0xC0 (program change), 0xD0 or 0xE0 (bend).
   * A note message throws: notes are `notes`. A message at `beat` equal to the loop length plays at the wrap. Takes effect from the next window.
   * An instrument without `scheduleMidi` ignores them; the notes play as before.
   *
   * At one time the clip sends note-offs, then program changes, then controllers, bend and pressure, then note-ons, so a note sounds with the program and controllers of its beat.
   * When the clip stops, is replaced, or the transport stops, pauses or seeks, each controller it moved off rest is put back at that time (sustain 0, bend centre, mod wheel 0, volume 100, pan 64, expression 127, pressure 0), unless a later clip has taken that controller over.
   * `transform` does not touch messages.
   */
  setMessages(messages: readonly ClipMessage[]): void {
    if (this.disposed) throw new Error("MidiClip is disposed.");
    this.messageStore.value = normalizeMessages(messages);
  }

  /**
   * Lets an owner veto note writes: `guard` runs before every `edit` and `setNotes` (before the recipe), and a throw there leaves the notes unchanged. Pass `null` to remove it.
   * Returns the guard it replaced, so a caller that installs one for a while can put the previous one back.
   */
  setWriteGuard(guard: (() => void) | null): (() => void) | null {
    const previous = this.writeGuard;
    this.writeGuard = guard;
    return previous;
  }

  /** The audio-context time now, from the transport the clip is attached to; a note is started when its on time has passed on this clock, not the last window's. */
  private currentTime(): number {
    for (const handle of this.handles) {
      const now = handle.now?.() ?? handle.timeline?.now;
      if (typeof now === "number") return Math.max(now, this.lastNow);
    }
    return this.lastNow;
  }

  private barBeats(): number {
    for (const handle of this.handles) {
      const meter = handle.meter?.value;
      if (meter) return (meter[0] * 4) / meter[1];
    }
    return 4;
  }

  /** The beats a loop wraps at, or null when the clip does not loop. A launcher clip's `loop` and `length` decide in a launcher; the clip's own options when attached to a clock directly. */
  private loopLength(notes: readonly MidiNote[]): number | null {
    for (const handle of this.handles) if (handle.loopBeats) return handle.loopBeats();
    return this.loop ? this.loopBeats(notes) : null;
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
      for (const sent of [...this.sent]) if (sent.offSent && sent.off <= now) this.finish(sent);
      const instrument = this.instrument;
      if (!instrument) return;
      const notes = this.store.value;
      const from = window.beat.start - EPS;
      const to = window.beat.end - EPS;
      if (from < this.lastFrom - EPS) this.pass = null;
      this.lastFrom = from;
      const begins = this.expectFrom === null || Math.abs(from - this.expectFrom) > 1e-6;
      this.expectFrom = to;
      this.adopt(window, notes, timing);
      this.continueRests(timing.beatToTime(window.beat.end));
      // Messages go out in time order, a note-off before a note-on at the same time (MIDI convention): an abutting same-pitch note must not be released by its predecessor.
      const starts: Sent[] = [];
      const play = (note: MidiNote, onBeat: number, offBeat: number, pass: number, end: number) => {
        if (!(offBeat > onBeat) || onBeat < from || onBeat >= to) return;
        let velocity = note.velocity;
        let when = timing.beatToTime(onBeat);
        if (this.transform) {
          const hit: NoteHit = Object.freeze({
            id: note.id,
            pitch: note.pitch,
            channel: note.channel,
            velocity,
            beat: onBeat,
            durationBeats: offBeat - onBeat,
            when,
            duration: timing.beatToTime(offBeat) - when,
            loop: pass,
          });
          const result = this.transform(hit, (key = 0) => hash01(this.seed, note.id, key));
          if (result === null) return;
          const moved = resolveHitEdit(hit, result, timing);
          if (!(Number.isFinite(result.velocity) && result.velocity >= 0 && result.velocity <= 1))
            throw new Error('Event transform "transform" returned an event whose "velocity" is not a finite number from 0 to 1.');
          if (result.velocity === 0) return;
          velocity = result.velocity;
          when = moved.when;
          onBeat = moved.beat;
          offBeat = Math.min(moved.beat + moved.durationBeats, end);
          if (!(offBeat > onBeat)) return;
        }
        const on = Math.max(when, now);
        const off = Math.max(timing.beatToTime(offBeat), on);
        const sent: Sent = {
          instrument,
          noteId: note.id,
          onBeat,
          offBeat,
          cutAt: null,
          pitch: note.pitch,
          on,
          off,
          done: false,
          ended: [],
          timing,
          offSent: false,
        };
        sent.sendOn = () => {
          sent.sendOn = undefined;
          sent.cancelOn = cancelOf(instrument.noteOn(note.pitch, { velocity, when: on, channel: note.channel }));
        };
        starts.push(sent);
        this.sent.add(sent);
        this.own(window, sent);
      };
      const length = this.loopLength(notes);
      if (length !== null && length > 0) {
        for (let pass = Math.max(0, Math.floor(from / length)); pass * length < to; pass++) {
          const base = pass * length;
          if (this.pass?.index !== pass) this.pass = { index: pass, notes };
          for (const note of this.pass.notes) {
            if (note.start >= length) break;
            play(note, base + note.start, base + Math.min(note.start + note.duration, length), pass, base + length);
          }
        }
      } else for (const note of notes) play(note, note.start, note.start + note.duration, 0, Infinity);
      // a note's note-off is sent in the window that contains it, so a cut before that window sends only the cut
      const windowEnd = timing.beatToTime(window.beat.end);
      const messages: { time: number; rank: number; send: () => void }[] = [];
      for (const sent of starts) messages.push({ time: sent.on, rank: 3, send: () => sent.sendOn?.() });
      const fresh = new Set(starts);
      for (const sent of [...this.sent]) {
        if (sent.offSent || sent.done) continue;
        const off = sent.timing.beatToTime(sent.offBeat);
        if (!(off < windowEnd)) continue;
        sent.offSent = true;
        sent.off = Math.max(off, sent.on);
        // A note that starts and ends at one time keeps its on first.
        const own = fresh.has(sent) && sent.off <= sent.on;
        messages.push({
          time: sent.off,
          rank: own ? 4 : 0,
          send: () => {
            // a cut that arrived while the window was being built has already sent its own note-off
            if (!sent.done && !sent.cancelOff) sent.cancelOff = cancelOf(sent.instrument.noteOff(sent.pitch, sent.off, sent.on));
          },
        });
      }
      this.queueMessages(window, timing, instrument, length, from, to, now, messages, begins);
      messages.sort((a, b) => (Math.abs(a.time - b.time) <= SAME_TIME ? a.rank - b.rank || a.time - b.time : a.time - b.time));
      for (const message of messages) message.send();
    });
  }

  /**
   * Queues this window's messages (see `setMessages`) behind the notes' own queue, and registers a guard that is cut with the clip: the cut puts back what the clip moved.
   * A loop pass one back from the window is included, so a message at the pass end (beat = loop length) is sent at the wrap.
   */
  private queueMessages(
    window: ClipWindow,
    timing: BeatTiming,
    instrument: Instrument,
    length: number | null,
    from: number,
    to: number,
    now: number,
    queue: { time: number; rank: number; send: () => void }[],
    begins: boolean,
  ): void {
    const source = this.messageStore.value;
    const schedule = instrument.scheduleMidi;
    if (!source.length || typeof schedule !== "function") return;
    this.pruneEmitted(now);
    const looping = length !== null && length > 0;
    const first = looping ? Math.max(0, Math.floor(from / length) - 1) : 0;
    const emit = (data: Uint8Array, time: number, rank: number) => {
      queue.push({
        time,
        rank,
        send: () => {
          const entry: Emitted = { ...(restOf(data) ?? { key: "", rest: data, atRest: true }), data, when: time, cancelled: false };
          try {
            entry.event = schedule.call(instrument, data, time);
          } catch (error) {
            // One message the instrument refuses must not cost the notes and messages after it.
            if (!this.failed) console.error("MidiClip message failed:", error);
            this.failed = true;
            return;
          }
          if (entry.key) {
            this.emitted.push(entry);
            const owners = controllerOwners.get(instrument) ?? new Map();
            controllerOwners.set(instrument, owners);
            if (time >= (owners.get(entry.key)?.when ?? -Infinity)) owners.set(entry.key, { owner: this, when: time });
          }
          window.own(
            {
              cancel: (at?: number) => {
                if (entry.cancelled || (at !== undefined && entry.when < at - SAME_TIME)) return;
                entry.cancelled = true;
                (entry.event as { cancel?: (time?: number) => void } | undefined)?.cancel?.(at);
              },
              onEnded: () => {},
            },
            time,
          );
        },
      });
    };
    if (begins) this.chase(emit, source, length, from, Math.max(timing.beatToTime(window.beat.start), now), now);
    for (let pass = first; looping ? pass * length < to : pass === 0; pass++) {
      const base = looping ? pass * length : 0;
      for (const message of source) {
        const beat = base + message.beat;
        if (beat < from || beat >= to || (looping && message.beat > length)) continue;
        const status = message.data[0] & 0xf0;
        emit(message.data, Math.max(timing.beatToTime(beat), now), status === 0xc0 ? 1 : 2);
      }
    }
    window.own({ cancel: (at?: number) => this.askRests(at ?? this.currentTime()), onEnded: () => {} }, timing.beatToTime(window.beat.end) + 1e-6);
  }

  /**
   * A window that begins a run (the first one, or one after a seek or a jump) brings the instrument to what its position needs: the latest message of each
   * controller, bend, pressure and program before `from` (the previous pass counts when the clip loops), then the rest value of every controller this clip moved
   * that nothing at the position sets. A controller the instrument already holds at that value (sent earlier, and not withdrawn) is not sent again.
   */
  private chase(
    emit: (data: Uint8Array, time: number, rank: number) => void,
    source: readonly ClipMessage[],
    length: number | null,
    from: number,
    at: number,
    now: number,
  ): void {
    if (from <= EPS) return;
    const looping = length !== null && length > 0;
    const prior: { beat: number; data: Uint8Array }[] = [];
    if (looping) {
      const pass = Math.max(0, Math.floor(from / length));
      for (let index = Math.max(0, pass - 1); index <= pass; index++)
        for (const message of source) if (message.beat <= length) prior.push({ beat: index * length + message.beat, data: message.data });
    } else for (const message of source) prior.push({ beat: message.beat, data: message.data });
    const needed = chaseMessages(prior, from);
    const held = new Map<string, Emitted>();
    for (const entry of this.emitted) if (!entry.cancelled && entry.when >= (held.get(entry.key)?.when ?? -Infinity)) held.set(entry.key, entry);
    let order = 0;
    const keys = new Set<string>();
    for (const { data } of needed) {
      const key = controllerStateKey(data)!;
      keys.add(key);
      const sent = held.get(restOf(data)?.key ?? "");
      if (sent && sent.when <= now + SAME_TIME && sent.data[0] === data[0] && sent.data[1] === data[1] && sent.data[2] === data[2]) continue;
      emit(data, at, 0.5 + order++ * 1e-6);
    }
    const owners = controllerOwners.get(this.instrument as object);
    for (const [key, entry] of held) {
      if (!key || keys.has(key) || (entry.atRest && entry.when <= now + SAME_TIME)) continue;
      const owner = owners?.get(key);
      if (owner && owner.owner !== this && owner.when >= at - SAME_TIME) continue;
      emit(entry.rest, at, 0.5 + order++ * 1e-6);
    }
  }

  /** Controller messages already past, bar the latest of each controller (the one that decides what a cut puts back). */
  private pruneEmitted(now: number): void {
    const latest = new Map<string, Emitted>();
    for (const entry of this.emitted)
      if (!entry.cancelled && entry.when <= now && entry.when >= (latest.get(entry.key)?.when ?? -Infinity)) latest.set(entry.key, entry);
    for (let i = this.emitted.length - 1; i >= 0; i--) {
      const entry = this.emitted[i]!;
      if (entry.cancelled || (entry.when <= now && latest.get(entry.key) !== entry)) this.emitted.splice(i, 1);
    }
  }

  /** A cut at `time` asks for the controllers the clip moved to be put back there, after the current task unless a window that carries on withdraws it. */
  private askRests(time: number): void {
    if (this.emitted.length === 0) return;
    this.restAt = Math.min(this.restAt ?? Infinity, time);
    clearTimeout(this.restTimer);
    this.restTimer = setTimeout(() => untracked(() => this.putBack()), 0);
  }

  /** A window that reaches past the asked-for time carries on from it: the controllers stay where they are. */
  private continueRests(reaches: number): void {
    if (this.restAt === null || !(reaches > this.restAt + EPS)) return;
    clearTimeout(this.restTimer);
    this.restAt = null;
  }

  /**
   * Sends, at `restAt` (default now), the message that puts each controller this clip moved back at rest, unless it already rests there or a later clip took it over.
   * Messages that were withdrawn do not count.
   */
  private putBack(): void {
    const cut = this.restAt ?? 0;
    const at = Math.max(cut, this.currentTime());
    clearTimeout(this.restTimer);
    this.restAt = null;
    const instrument = this.instrument;
    const latest = new Map<string, Emitted>();
    for (const entry of this.emitted) if (!entry.cancelled && entry.when >= (latest.get(entry.key)?.when ?? -Infinity)) latest.set(entry.key, entry);
    this.emitted.length = 0;
    if (!instrument || typeof instrument.scheduleMidi !== "function") return;
    const owners = controllerOwners.get(instrument);
    for (const [key, entry] of latest) {
      if (entry.atRest && entry.when <= cut) continue;
      const owner = owners?.get(key);
      if (owner && owner.owner !== this && owner.when >= cut - SAME_TIME) continue;
      try {
        instrument.scheduleMidi(entry.rest, at);
        owners?.set(key, { owner: this, when: at });
      } catch {
        // An instrument that was disposed has nothing to put back.
      }
    }
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
   * The clock retracts a note: `time` is when. A note that has not started is revoked: its note-on is cancelled when the instrument returned a cancellable event (no note-off follows), otherwise it gets a note-off at its start time;
   * one that is sounding is cut at `time` unless the next window continues it, which a refresh does.
   */
  private cancel(sent: Sent, time?: number): void {
    if (sent.done) return;
    const now = this.currentTime();
    const at = Math.max(time ?? now, sent.on);
    if (sent.on > now) return this.release(sent, at, true);
    if (sent.cutAt !== null && sent.cutAt <= at) return; // an earlier cut is already pending
    sent.cutAt = at;
    clearTimeout(sent.timer);
    sent.timer = setTimeout(() => untracked(() => this.release(sent, at)), 0);
  }

  /**
   * Sends the note-off of a sent note-on at `at` (default `max(now, its start)`) in place of the pending natural one. A cut that lies ahead leaves the note
   * tracked until it passes, so a still earlier cut (a stop inside the same look-ahead) can move it again. `final` ends the record now.
   */
  private release(sent: Sent, at = Math.max(this.currentTime(), sent.on), final = false): void {
    if (sent.done) return;
    const now = this.currentTime();
    if (sent.on > now && sent.sendOn) {
      // revoked before it was sent: the instrument never hears it
      sent.sendOn = undefined;
      sent.offSent = true;
      return this.finish(sent);
    }
    sent.sendOn?.();
    if (sent.offSent && sent.off <= at) return final ? this.finish(sent) : undefined;
    sent.cancelOff?.();
    if (sent.on > now && sent.cancelOn) {
      // the instrument honoured the revoke: the note never sounds, so it needs no note-off
      sent.cancelOn();
      sent.cancelOn = undefined;
      sent.offSent = true;
      return this.finish(sent);
    }
    sent.cancelOn = undefined;
    const when = Math.max(sent.offSent ? at : Math.min(at, sent.off), sent.on);
    sent.off = when;
    sent.offSent = true;
    sent.cutAt = null;
    try {
      sent.cancelOff = cancelOf(sent.instrument.noteOff(sent.pitch, when, sent.on));
    } finally {
      if (final || when <= now) this.finish(sent);
    }
  }

  /** Clock scheduler contract: sends the note-off of every note-on already sent, at `max(now, its start)`. */
  reset(reason?: ClipResetReason): void {
    untracked(() => {
      this.pass = null;
      this.expectFrom = null;
      for (const sent of [...this.sent]) this.release(sent, sent.cutAt ?? undefined, true);
      // messages still ahead are withdrawn, then (but for a seek) the performance controllers that moved go back to rest now
      const now = this.currentTime();
      for (const entry of this.emitted) {
        if (entry.when <= now || entry.cancelled) continue;
        entry.cancelled = true;
        (entry.event as { cancel?: () => void } | undefined)?.cancel?.();
      }
      // A seek keeps what the clip moved: the window at the new position chases what it needs and sends only what differs, so a pedal held on both sides never dips.
      if (reason === "seek") return;
      this.restAt = now;
      this.putBack();
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

function normalizeMessages(messages: readonly ClipMessage[]): readonly ClipMessage[] {
  if (!Array.isArray(messages)) throw new RangeError("MidiClip messages must be a list of { beat, data }.");
  return Object.freeze(
    messages
      .map((message, index) => {
        const data = message?.data;
        const status = data?.[0] & 0xf0;
        if (!message || !(Number.isFinite(message.beat) && message.beat >= 0))
          throw new RangeError("MidiClip messages need a finite, non-negative beat.");
        if (!(data instanceof Uint8Array) || data.length < 2 || ![0xa0, 0xb0, 0xc0, 0xd0, 0xe0].includes(status))
          throw new RangeError("MidiClip messages must be controller, pitch bend, program change or pressure bytes, not notes.");
        return { index, message: Object.freeze({ beat: message.beat, data: new Uint8Array(data) }) };
      })
      .sort((a, b) => a.message.beat - b.message.beat || a.index - b.index)
      .map(({ message }) => message),
  );
}
