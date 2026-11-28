/** Records one Web MIDI input as a clock-aligned take. Mirrors AudioRecorder: a clock scheduler whose `record()` resolves a take.
 * Reads: ./midi-data for take and note types and note-value lengths.
 */
import { batch, cell, readonlyCell, untracked, type BeatTiming, type Cell, type ReadonlyCell } from "@audiorective/core";
import { noteBeats, type MidiNote, type MidiTake, type MidiTakeEvent } from "./midi-data";
import type { MidiSource } from "./MidiKeyboard";

export type { MidiTake, MidiTakeEvent } from "./midi-data";

/** "none" starts at once; otherwise the next boundary of an attached playing clock: "1m" a bar of its meter (4 beats in 4/4), "2m" two bars, "4n" a beat, "8n" half a beat. A call exactly on a boundary starts there, not on the next one. */
export type Quantize = "none" | `${number}m` | `${number}n`;
/** A length measured at the clock's tempo from the take's start: "4m" four bars, "4n" one beat. */
export type NoteLength = Exclude<Quantize, "none">;
export type MidiRecorderState = "idle" | "armed" | "recording" | "disposed";
/** The part of a clock's `SchedulerHandle` a recorder reads; `clock.attach(recorder)` supplies it. */
export type RecorderTransport = Readonly<{
  /** Borrowed beat/audio-time mapping; tempo metadata may be absent. */
  timeline: BeatTiming &
    Readonly<{
      /** Optional live tempo reader in quarter-note beats per minute. */
      bpm?: Readonly<{
        /** Current tempo in quarter-note beats per minute. */
        value: number;
      }>;
    }>;
  /** Borrowed transport-state reader; recording follows its playing state. */
  state: Readonly<{
    /** Current playback phase: stopped, playing or paused. */
    value: "stopped" | "playing" | "paused";
  }>;
  /** Borrowed meter reader used to resolve bar-based recording lengths. */
  meter: Readonly<{
    /** Meter tuple [numerator, denominator]; [4, 4] means four quarter notes per bar. */
    value: readonly [number, number];
  }>;
  /** Stops following the transport; subsequent transport changes no longer reach the recorder. */
  detach(): void;
}>;
/** Why a clock resets its schedulers: it started, stopped, paused or jumped, or the scheduler is leaving. */
export type RecorderResetReason = "start" | "stop" | "pause" | "seek" | "detach";

export interface MidiRecordOptions {
  /** Absolute AudioContext seconds the take starts at (`clock.timeline.beatToTime(beat)` for a beat); a past time starts now, as audible (a notes played just after `record()` count). Default: now. Not with `quantize`. */
  when?: number;
  /**
   * Start at the next boundary of the attached, playing clock (`"1m"` the next bar line); a call exactly on a boundary starts there, not on the next one, otherwise the first boundary at least 50 ms ahead.
   * Default `"none"`. `record()` rejects with `InvalidStateError` when the recorder is not attached to a Clock (`clock.attach(recorder)`) or the clock is not playing.
   */
  quantize?: Quantize;
  /** Take length: seconds, or a note value from the start (`"4m"` four bars at the clock's tempo, which needs the playing clock). Default: until `stop()`. */
  length?: number | NoteLength;
  /** Aborting discards the take and rejects `record()` with `AbortError`, like `cancel()`. */
  signal?: AbortSignal;
}

/** Seconds of lead a quantized start keeps, so the first boundary is still ahead when `record()` arrives. */
const QUANTIZE_LEAD = 0.05;
/** Seconds a scheduled end waits for late messages stamped before it. */
const END_GRACE = 0.02;
const EPS = 1e-7;
const abortError = () => new DOMException("MidiRecorder recording was cancelled.", "AbortError");
const invalidState = (message: string) => new DOMException(message, "InvalidStateError");

type Held = { start: number; pitch: number; velocity: number; channel: number; id: string };
type Session = {
  startTime: number;
  endTime: number | null;
  startBeat: number | null;
  quantized: boolean;
  /** Seconds to beats from the take's start. */
  toBeat(time: number): number;
  held: Map<number, Held[]>;
  closed: Array<Held & { end: number }>;
  events: Array<{ time: number; data: Uint8Array }>;
  startTimer?: ReturnType<typeof setTimeout>;
  endTimer?: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  onAbort?: () => void;
  promise: Promise<MidiTake>;
  resolve(take: MidiTake): void;
  reject(error: unknown): void;
};
let nextRecorderId = 0;

/**
 * Records one `MidiSource`: a Web MIDI input, or a `MidiKeyboard` (every input and the on-screen keys). Note-on with velocity 0 counts as note-off; each message's Web MIDI timestamp (performance.now() based) is mapped onto the AudioContext clock.
 * It is also a clock scheduler: `clock.attach(recorder)` lets `record({ quantize, length })` start on a bar line and run for bars, like `AudioRecorder`.
 */
export class MidiRecorder {
  readonly cells: Readonly<{
    state: ReadonlyCell<MidiRecorderState>;
    /** AudioContext time the armed take starts at; null unless a take is armed. */
    startsAt: ReadonlyCell<number | null>;
    /** AudioContext time the take began; null unless recording. */
    startedAt: ReadonlyCell<number | null>;
  }>;
  private readonly stateStore: Cell<MidiRecorderState> = cell<MidiRecorderState>("idle");
  private readonly startsAtStore: Cell<number | null> = cell<number | null>(null);
  private readonly startedAtStore: Cell<number | null> = cell<number | null>(null);
  private active: Session | null = null;
  private follow: RecorderTransport | null = null;
  private readonly recorderId = ++nextRecorderId;
  private takeNumber = 0;
  private noteNumber = 0;
  private disposed = false;
  private readonly signal: AbortSignal | undefined;
  private readonly onAbort = () => this.dispose();

  constructor(
    readonly context: AudioContext,
    readonly input: MidiSource,
    options: { signal?: AbortSignal } = {},
  ) {
    this.cells = Object.freeze({
      state: readonlyCell(this.stateStore),
      startsAt: readonlyCell(this.startsAtStore),
      startedAt: readonlyCell(this.startedAtStore),
    });
    this.signal = options.signal;
    if (this.signal) {
      if (this.signal.aborted) this.dispose();
      else this.signal.addEventListener("abort", this.onAbort, { once: true });
    }
  }

  /** Clock scheduler contract, called by `clock.attach(recorder)`; a recorder schedules nothing. */
  schedule(): void {}
  /** Clock scheduler contract: leaving the transport (stop, pause, seek, detach) while a take is armed, quantized or scheduled with `when`, cancels it (`record()` rejects with `AbortError`); a take already recording continues. */
  reset(reason: RecorderResetReason): void {
    if (reason !== "start" && untracked(() => this.stateStore.value) === "armed") this.cancel();
  }
  /** Clock scheduler contract, called by `clock.attach(recorder)`. */
  attached(handle: RecorderTransport): () => void {
    this.follow = handle;
    return () => {
      if (this.follow === handle) this.follow = null;
    };
  }

  /** Map the Web MIDI performance timestamp to the audible AudioContext output position. */
  private audioTime(performanceTime: number): number {
    const pair = this.context.getOutputTimestamp?.();
    if (typeof pair?.contextTime === "number" && typeof pair.performanceTime === "number" && (pair.contextTime > 0 || pair.performanceTime > 0)) {
      return Math.max(0, pair.contextTime + (performanceTime - pair.performanceTime) / 1000);
    }
    return Math.max(0, this.context.currentTime + (performanceTime - performance.now()) / 1000);
  }

  private barBeats(clock: RecorderTransport): number {
    const [n, d] = untracked(() => clock.meter.value);
    return (n * 4) / d;
  }

  private readonly onMessage = (event: MIDIMessageEvent): void => {
    const session = this.active;
    if (!session || !event.data || !Number.isFinite(event.timeStamp)) return;
    const time = this.audioTime(event.timeStamp);
    if (time < session.startTime || (session.endTime !== null && time > session.endTime)) return;
    const data = new Uint8Array(event.data);
    const status = data[0];
    if (status === undefined || status < 0x80 || status >= 0xf0) return;
    const kind = status & 0xf0;
    if ((kind === 0x80 || kind === 0x90) && data.length >= 3 && data[1] <= 127 && data[2] <= 127) {
      const channel = status & 0x0f;
      const pitch = data[1];
      const key = channel * 128 + pitch;
      if (kind === 0x90 && data[2] > 0) {
        const held = session.held.get(key) ?? [];
        held.push({ start: time, pitch, velocity: data[2] / 127, channel, id: `${this.recorderId}:${this.takeNumber}:${++this.noteNumber}` });
        session.held.set(key, held);
      } else {
        const held = session.held.get(key);
        const note = held?.shift();
        if (note) session.closed.push({ ...note, end: Math.max(note.start, time) });
        if (held?.length === 0) session.held.delete(key);
      }
      return;
    }
    session.events.push({ time, data });
  };

  /**
   * Records one take and resolves with it after it ends, at `length` or at `stop()`. A quantized start waits for the clock's next boundary, and the take
   * reports it as `startBeat`. While the recorder is attached to a clock, a take that is armed but has not started (a `quantize` boundary or a future `when` ahead) is cancelled when the clock stops, pauses, seeks or the recorder detaches, rejecting with `AbortError`; a running take is not affected. With `quantize` (or a note-value `length`) it rejects with `InvalidStateError` when the recorder is not attached to a Clock or, for `quantize`, the clock is not playing.
   */
  record(options: MidiRecordOptions = {}): Promise<MidiTake> {
    try {
      return this.begin(options);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  private begin(options: MidiRecordOptions): Promise<MidiTake> {
    if (this.disposed) throw new Error("MidiRecorder is disposed.");
    if (this.active) throw new Error("MidiRecorder already has an active take.");
    if (this.context.state !== "running") throw new Error("MidiRecorder needs a running AudioContext.");
    const quantize = options.quantize ?? "none";
    const length = options.length;
    if (quantize !== "none") {
      if (options.when !== undefined) throw new RangeError("MidiRecorder record() takes `when` or `quantize`, not both.");
      noteBeats(quantize, 4);
    }
    if (typeof length === "string") noteBeats(length, 4);
    else if (length !== undefined && !(Number.isFinite(length) && length > 0))
      throw new RangeError("MidiRecorder length must be positive seconds or a note value.");
    if (options.when !== undefined && (!Number.isFinite(options.when) || options.when < 0))
      throw new RangeError("MidiRecorder time must be finite, non-negative seconds.");
    const clock = this.follow;
    const playing = !!clock && untracked(() => clock.state.value) === "playing";
    if (quantize !== "none" && !clock) throw invalidState("MidiRecorder quantize needs clock.attach(recorder).");
    if (quantize !== "none" && !playing) throw invalidState("MidiRecorder quantize needs a playing clock.");
    if (typeof length === "string" && !clock) throw invalidState("MidiRecorder length needs clock.attach(recorder).");
    if (typeof length === "string" && !playing) throw invalidState("MidiRecorder length needs a playing clock.");
    if (options.signal?.aborted) throw options.signal.reason instanceof DOMException ? options.signal.reason : abortError();

    const now = this.context.currentTime;
    // "Now" for an immediate or past start is what is audible now: notes played right after `record()` carry timestamps that late.
    const heard = Math.min(now, this.audioTime(performance.now()));
    let startTime = Math.max(options.when ?? heard, heard);
    let startBeat: number | null = null;
    if (quantize !== "none" && clock) {
      const size = noteBeats(quantize, this.barBeats(clock));
      const nowBeat = clock.timeline.timeToBeat(now);
      // Exactly on a boundary starts there; otherwise the first boundary at least QUANTIZE_LEAD ahead.
      if (Math.abs(nowBeat / size - Math.round(nowBeat / size)) < EPS) startBeat = Math.round(nowBeat / size) * size;
      else startBeat = Math.ceil(clock.timeline.timeToBeat(now + QUANTIZE_LEAD) / size - EPS) * size;
      startTime = Math.max(clock.timeline.beatToTime(startBeat), now);
    } else if (playing && clock) startBeat = clock.timeline.timeToBeat(startTime);
    const bpm = untracked(() => clock?.timeline.bpm?.value ?? 120);
    const timeline = clock?.timeline;
    const beginBeat = startBeat;
    let endTime: number | null = null;
    if (typeof length === "number") endTime = startTime + length;
    else if (typeof length === "string" && clock && beginBeat !== null)
      endTime = timeline!.beatToTime(beginBeat + noteBeats(length, this.barBeats(clock)));

    const session = {
      startTime,
      endTime,
      startBeat,
      quantized: quantize !== "none",
      toBeat: (time: number) => (timeline && beginBeat !== null ? timeline.timeToBeat(time) - beginBeat : ((time - startTime) * bpm) / 60),
      held: new Map(),
      closed: [],
      events: [],
      signal: options.signal,
    } as unknown as Session;
    session.promise = new Promise<MidiTake>((resolve, reject) => {
      session.resolve = resolve;
      session.reject = reject;
    });
    this.active = session;
    this.input.addEventListener("midimessage", this.onMessage as EventListener);
    const immediate = startTime <= heard + EPS;
    batch(() => {
      this.startsAtStore.value = immediate ? null : startTime;
      this.startedAtStore.value = immediate ? startTime : null;
      this.stateStore.value = immediate ? "recording" : "armed";
    });
    if (!immediate) {
      const begin = () => {
        if (this.active !== session) return;
        if (this.context.currentTime < startTime) {
          session.startTimer = setTimeout(begin, Math.max(1, (startTime - this.context.currentTime) * 1000));
          return;
        }
        batch(() => {
          this.startsAtStore.value = null;
          this.startedAtStore.value = startTime;
          this.stateStore.value = "recording";
        });
      };
      session.startTimer = setTimeout(begin, (startTime - now) * 1000);
    }
    if (endTime !== null) this.scheduleEnd(session, endTime, END_GRACE);
    if (options.signal) {
      session.onAbort = () =>
        this.active === session && this.fail(session, options.signal!.reason instanceof DOMException ? options.signal!.reason : abortError());
      options.signal.addEventListener("abort", session.onAbort, { once: true });
    }
    return session.promise;
  }

  private scheduleEnd(session: Session, end: number, grace = 0): void {
    clearTimeout(session.endTimer);
    session.endTime = end;
    const wait = end - this.context.currentTime;
    if (wait <= 0 && grace === 0) this.finish(session);
    else
      session.endTimer = setTimeout(
        () => {
          if (this.active !== session) return;
          if (this.context.currentTime < end) this.scheduleEnd(session, end, grace);
          else this.finish(session);
        },
        Math.max(0.001, wait + grace) * 1000,
      );
  }

  /** Ends the current take at `when` (default now) and resolves it, the same take `record()` resolves; `cancel()` instead discards it. */
  stop(options: { when?: number } = {}): Promise<MidiTake> {
    const session = this.active;
    if (!session) return Promise.reject(invalidState("MidiRecorder has no active take to stop."));
    const requested = options.when ?? this.context.currentTime;
    if (!Number.isFinite(requested) || requested < 0)
      return Promise.reject(new RangeError("MidiRecorder time must be finite, non-negative seconds."));
    let end = Math.max(session.startTime, requested);
    if (session.endTime !== null) end = Math.min(end, session.endTime);
    this.scheduleEnd(session, end);
    return session.promise;
  }

  /** Discards the active take and rejects its `record()` with `AbortError` (use `stop()` to end it early and keep what was captured). */
  cancel(): void {
    const session = this.active;
    if (session) this.fail(session, abortError());
  }

  private fail(session: Session, error: unknown): void {
    this.release(session);
    session.reject(error);
  }

  private release(session: Session): void {
    clearTimeout(session.startTimer);
    clearTimeout(session.endTimer);
    if (session.signal && session.onAbort) session.signal.removeEventListener("abort", session.onAbort);
    if (this.active === session) {
      this.input.removeEventListener("midimessage", this.onMessage as EventListener);
      this.active = null;
      batch(() => {
        this.startsAtStore.value = null;
        this.startedAtStore.value = null;
        if (!this.disposed) this.stateStore.value = "idle";
      });
    }
  }

  private finish(session: Session): void {
    if (this.active !== session) return;
    const end = Math.max(session.startTime, session.endTime ?? this.context.currentTime);
    const closed = [...session.closed];
    for (const held of session.held.values()) for (const note of held) closed.push({ ...note, end: Math.max(note.start, end) });
    const notes: MidiNote[] = closed.map((note) =>
      Object.freeze({
        id: note.id,
        pitch: note.pitch,
        velocity: note.velocity,
        start: session.toBeat(note.start),
        duration: session.toBeat(note.end) - session.toBeat(note.start),
        channel: note.channel,
      }),
    );
    notes.sort((a, b) => a.start - b.start || a.pitch - b.pitch);
    const events: MidiTakeEvent[] = session.events.map((event) => Object.freeze({ beat: session.toBeat(event.time), data: event.data }));
    const take: MidiTake = Object.freeze({
      notes: Object.freeze(notes),
      duration: session.toBeat(end),
      startBeat: session.startBeat,
      startTime: session.startTime,
      endTime: end,
      events: Object.freeze(events),
    });
    this.release(session);
    session.resolve(take);
  }

  /** Cancels an active take and releases the input. Safe to call twice. */
  dispose(): void {
    if (this.disposed) return;
    this.cancel();
    this.disposed = true;
    this.signal?.removeEventListener("abort", this.onAbort);
    this.follow = null;
    this.stateStore.value = "disposed";
  }

  [Symbol.dispose](): void {
    this.dispose();
  }
}
