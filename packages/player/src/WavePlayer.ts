import {
  AudioProcessor,
  BufferPlayer,
  batch,
  cell,
  readonlyCell,
  untracked,
  type Cell,
  type ReadonlyCell,
  type SchedulableParam,
} from "@audiorective/core";
import { summarizePeaks, type PCMData, type PeakSummary } from "@audiorective/core/peaks";
import type { AutomationBinding } from "@audiorective/core/automation";
import { loadSource, type WaveLoadProgress, type WaveSourceLoader } from "./source";
export type { WaveLoadProgress, WaveSourceLoader } from "./source";

export type WaveStretchAnchor = Readonly<{ sourceFrame: number; outputFrame: number }>;
/** A processor is borrowed; its lifetime belongs to the caller. */
export interface WaveStretchProcessor {
  process(input: PCMData, options: { ratio: number; anchors?: readonly WaveStretchAnchor[]; signal?: AbortSignal }): Promise<PCMData>;
}
export interface WavePlayerOptions {
  stretch?: WaveStretchProcessor;
  /** Optional URL/cache adapter. Files use native loading; the player owns lifecycle and summary. */
  loadSource?: WaveSourceLoader;
  /** Aborting the signal calls `dispose()`. */
  signal?: AbortSignal;
}
/** "none" starts at once; otherwise the next boundary of an attached playing clock: "1m" a bar of its meter (4 beats in 4/4), "2m" two bars, "4n" a beat, "8n" half a beat. A call exactly on a boundary starts there, not on the next one; otherwise the first boundary at least 50 ms ahead. During a count-in (negative beats) a boundary can fall inside the count-in; to start at bar 1 pass `when: clock.timeline.beatToTime(0)`. */
export type Quantize = "none" | `${number}m` | `${number}n`;
/** The part of a clock's `SchedulerHandle` a player reads; `clock.attach(player)` supplies it. */
export type PlayerTransport = Readonly<{
  timeline: { timeToBeat(time: number): number; beatToTime(beat: number): number };
  state: Readonly<{ value: "stopped" | "playing" | "paused" }>;
  meter: Readonly<{ value: readonly [number, number] }>;
  detach(): void;
}>;
/** Why a clock resets its schedulers: it started, stopped, paused or jumped, or the scheduler is leaving. */
export type PlayerResetReason = "start" | "stop" | "pause" | "seek" | "detach";
/** Seconds of lead a quantized start keeps, so the start is scheduled before the boundary. */
const QUANTIZE_LEAD = 0.05;
const EPS = 1e-7;
function noteBeats(value: string, barBeats: number): number {
  const m = /^(\d+(?:\.\d+)?)([mn])$/.exec(value);
  if (!m || !(Number(m[1]) > 0)) throw new RangeError(`WavePlayer requires a note value such as "4n" or "1m", got "${value}".`);
  return m[2] === "m" ? Number(m[1]) * barBeats : 4 / Number(m[1]);
}
export interface WavePlayOptions {
  /** Absolute audio-context seconds at which sound starts. A past time clamps to now. Default: now. Not with `quantize`. */
  when?: number;
  /**
   * Start at the next boundary of the attached, playing clock (`"1m"` the next bar line); a call exactly on a boundary starts there, not on the next one.
   * Default `"none"`. `play()` rejects with `InvalidStateError` when the player is not attached to a Clock (`clock.attach(player)`) or the clock is not playing.
   * During a count-in (negative beats) a boundary can fall inside the count-in; to start at bar 1 pass `when: clock.timeline.beatToTime(0)`.
   */
  quantize?: Quantize;
}
export interface PlaybackVersion {
  readonly revision: number;
  readonly sourceRevision: number;
  readonly buffer: AudioBuffer;
  readonly peaks: PeakSummary;
  /** Requested output duration / original duration, rounded to a whole frame. */
  readonly ratio: number;
}

/** Seconds in the currently committed playback buffer, independent of any view. */
export type AudioRange = { start: number; end: number };
export type WavePlayerSource = string | File | AudioBuffer;
/** Observable state. Effects and `useValue` track these; they are read-only, and change through the player's methods. */
export type WavePlayerCells = {
  /** Committed selection in output seconds; the object is frozen. */
  selection: ReadonlyCell<Readonly<AudioRange> | null>;
  isLooping: ReadonlyCell<boolean>;
  /** Transport flag: true from the moment a start is issued, including one queued for a future `when`, until playback stops. */
  isPlaying: ReadonlyCell<boolean>;
  loading: ReadonlyCell<boolean>;
  loadProgress: ReadonlyCell<WaveLoadProgress | null>;
  error: ReadonlyCell<string | null>;
  processing: ReadonlyCell<boolean>;
  /** The committed audio/peaks revision; null while empty or loading. */
  version: ReadonlyCell<PlaybackVersion | null>;
  /**
   * Changes whenever the playhead is moved or restarted (play, pause, stop, seek, loop or selection change, load, stretch): `position` is the playhead at that moment
   * and `startedAt` the audio-context time it began advancing, null while it holds still. While advancing, read `player.position` per frame.
   */
  playhead: ReadonlyCell<Readonly<{ position: number; startedAt: number | null }>>;
  /** Audio-context time a queued start (a future `when` or a quantize boundary) begins sounding; null once it has begun or when none is queued. */
  startsAt: ReadonlyCell<number | null>;
};
type Store = {
  selection: Cell<Readonly<AudioRange> | null>;
  isLooping: Cell<boolean>;
  loading: Cell<boolean>;
  loadProgress: Cell<WaveLoadProgress | null>;
  error: Cell<string | null>;
  processing: Cell<boolean>;
  version: Cell<PlaybackVersion | null>;
  /** Playhead position while not advancing; `position` derives from it and the audio clock. */
  held: Cell<number>;
  /** The running play anchor, replaced on every start, seek or loop change. */
  anchor: Cell<Anchor | null>;
  startsAt: Cell<number | null>;
};
type Anchor = { time: number; offset: number; start: number; end: number };

/**
 * Headless audio loading, range playback and non-destructive stretch. The caller owns context and routing.
 * It is also a clock scheduler: `clock.attach(player)` lets `play({ quantize })` start on a bar line.
 */
export class WavePlayer extends AudioProcessor<{ volume: SchedulableParam }, WavePlayerCells> {
  private readonly player: BufferPlayer;
  private readonly gain: GainNode;
  private readonly audioContext: AudioContext;
  /** The only store. Writable here, read-only on `cells`. */
  private readonly store: Store;
  private request = 0;
  private command = 0;
  private abort: AbortController | null = null;
  private disposed = false;
  private follow: PlayerTransport | null = null;
  private startTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly abortSignal?: AbortSignal;
  private readonly onAbort = () => this.dispose();
  private readonly sourceAutomations = new Set<AutomationBinding>();
  private original: AudioBuffer | null = null;
  private sourceRevision = 0;
  private revision = 0;
  private editRequest = 0;
  private editAbort: AbortController | null = null;
  constructor(
    context: AudioContext,
    private readonly options: WavePlayerOptions = {},
  ) {
    const gain = new GainNode(context);
    const player = new BufferPlayer(context);
    const store: Store = {
      selection: cell<Readonly<AudioRange> | null>(null),
      isLooping: cell(false),
      loading: cell(false),
      loadProgress: cell<WaveLoadProgress | null>(null),
      error: cell<string | null>(null),
      processing: cell(false),
      version: cell<PlaybackVersion | null>(null),
      held: cell(0),
      anchor: cell<Anchor | null>(null),
      startsAt: cell<number | null>(null),
    };
    super(context, ({ param }) => ({
      params: { volume: param({ default: 1, bind: gain.gain, min: 0, max: 1 }) },
      cells: {
        selection: readonlyCell(store.selection),
        isLooping: readonlyCell(store.isLooping),
        isPlaying: readonlyCell(() => player.cells.isPlaying.value),
        loading: readonlyCell(store.loading),
        loadProgress: readonlyCell(store.loadProgress),
        error: readonlyCell(store.error),
        processing: readonlyCell(store.processing),
        version: readonlyCell(store.version),
        playhead: readonlyCell(() => {
          const anchor = store.anchor.value;
          return Object.freeze({ position: anchor ? anchor.offset : store.held.value, startedAt: anchor ? anchor.time : null });
        }),
        startsAt: readonlyCell(store.startsAt),
      },
    }));
    this.gain = gain;
    this.audioContext = context;
    this.player = player;
    this.store = store;
    this.defineGraph(() => [[this.player, gain]]);
    this.abortSignal = options.signal;
    if (this.abortSignal?.aborted) this.dispose();
    else this.abortSignal?.addEventListener("abort", this.onAbort, { once: true });
  }

  /** Clock scheduler contract: a player schedules nothing per window; `clock.attach(player)` only gives it the transport `play({ quantize })` reads. */
  schedule(): void {}
  /** Clock scheduler contract: leaving the transport (stop, pause, seek, detach) cancels a start still queued, quantized or `when`; playback already sounding continues. */
  reset(reason: PlayerResetReason): void {
    if (reason !== "start" && !this.disposed && untracked(() => this.store.startsAt.value) !== null) this.change(() => this.halt());
  }
  /** Clock scheduler contract: called by `clock.attach`. */
  attached(handle: PlayerTransport): () => void {
    this.follow = handle;
    return () => {
      if (this.follow === handle) this.follow = null;
    };
  }

  private get held(): number {
    return untracked(() => this.store.held.value);
  }
  private set held(value: number) {
    this.store.held.value = value;
  }
  private get anchor(): Anchor | null {
    return untracked(() => this.store.anchor.value);
  }
  private set anchor(value: Anchor | null) {
    this.store.anchor.value = value;
  }

  // Internal reads never subscribe a caller's effect. Public readers below are tracked.
  private get range(): Readonly<AudioRange> | null {
    return untracked(() => this.store.selection.value);
  }
  private set range(value: Readonly<AudioRange> | null) {
    this.store.selection.value = value ? Object.freeze({ start: value.start, end: value.end }) : null;
  }
  private get looping(): boolean {
    return untracked(() => this.store.isLooping.value);
  }
  private set looping(value: boolean) {
    this.store.isLooping.value = value;
  }
  private get loading(): boolean {
    return untracked(() => this.store.loading.value);
  }
  private set loading(value: boolean) {
    this.store.loading.value = value;
  }
  private get loadProgress(): WaveLoadProgress | null {
    return untracked(() => this.store.loadProgress.value);
  }
  private set loadProgress(value: WaveLoadProgress | null) {
    this.store.loadProgress.value = value;
  }
  private get error(): string | null {
    return untracked(() => this.store.error.value);
  }
  private set error(value: string | null) {
    this.store.error.value = value;
  }
  private get processing(): boolean {
    return untracked(() => this.store.processing.value);
  }
  private set processing(value: boolean) {
    this.store.processing.value = value;
  }

  get output(): AudioNode {
    return this.gain;
  }
  /** Borrowed decoded source. Treat its PCM as immutable while in use. */
  get buffer(): AudioBuffer | null {
    void this.cells.version.value;
    return this.loadedBuffer;
  }
  /** Internal untracked read of the committed buffer: `BufferPlayer.buffer` is a tracked Param read. */
  private get loadedBuffer(): AudioBuffer | null {
    return untracked(() => this.player.buffer);
  }
  /** Internal untracked read of the committed duration. */
  private get length(): number {
    return this.loadedBuffer?.duration ?? 0;
  }
  /** Tracked. */
  get duration(): number {
    return this.buffer?.duration ?? 0;
  }
  get sourceBuffer(): AudioBuffer | null {
    void this.cells.version.value;
    return this.original;
  }
  private pcm(buffer: AudioBuffer): PCMData {
    return { sampleRate: buffer.sampleRate, channels: Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c)) };
  }
  /** Tracked: re-evaluates when a load or stretch changes the source/output mapping. */
  sourceToOutput(seconds: number): number {
    void this.cells.version.value;
    return this.mapSourceToOutput(seconds);
  }
  /** Tracked: re-evaluates when a load or stretch changes the source/output mapping. */
  outputToSource(seconds: number): number {
    void this.cells.version.value;
    return this.mapOutputToSource(seconds);
  }
  private mapSourceToOutput(seconds: number): number {
    if (!Number.isFinite(seconds)) throw new RangeError("Time must be finite seconds.");
    return this.original ? (Math.max(0, Math.min(this.original.duration, seconds)) * this.length) / this.original.duration : 0;
  }
  private mapOutputToSource(seconds: number): number {
    if (!Number.isFinite(seconds)) throw new RangeError("Time must be finite seconds.");
    return this.length ? (Math.max(0, Math.min(this.length, seconds)) * (this.original?.duration ?? 0)) / this.length : 0;
  }
  get position(): number {
    if (!this.anchor) return this.held;
    const a = this.anchor;
    const time = a.offset + Math.max(0, this.context.currentTime - a.time);
    return this.looping ? a.start + ((((time - a.start) % (a.end - a.start)) + a.end - a.start) % (a.end - a.start)) : Math.min(a.end, time);
  }
  /** Internal untracked check for commands: the transport flag, or false once a non-looping run has reached its end. */
  private get running(): boolean {
    return untracked(() => this.cells.isPlaying.value && (this.looping || this.position < (this.anchor?.end ?? this.length)));
  }
  /** Borrow a source-time binding and follow this player's non-looping playback. Detach before manual target writes. */
  attachSourceAutomation(binding: AutomationBinding): () => void {
    this.assertAlive();
    if (binding.context !== this.context) throw new Error("Source automation must use the player's AudioContext.");
    if (this.looping) throw new Error("Source automation requires non-looping playback.");
    if (!this.sourceAutomations.has(binding)) {
      binding.stop();
      this.sourceAutomations.add(binding);
      try {
        if (this.anchor && this.running) this.startSourceAutomation(binding, this.position, this.anchor.end, this.startTime());
      } catch (error) {
        this.sourceAutomations.delete(binding);
        throw error;
      }
    }
    return () => {
      if (this.sourceAutomations.delete(binding)) this.stopSourceAutomation(binding);
    };
  }
  private stopSourceAutomation(binding: AutomationBinding): void {
    try {
      binding.stop();
    } catch (error) {
      console.error("WavePlayer source automation stop failed:", error);
    }
  }
  private startSourceAutomation(binding: AutomationBinding, offset: number, end: number, when: number): void {
    const source = this.original;
    if (!source) return;
    binding.start({
      when,
      from: this.mapOutputToSource(offset),
      to: this.mapOutputToSource(end),
      secondsPerUnit: this.length / source.duration,
    });
  }
  private assertAlive(): void {
    if (this.disposed) throw new Error("WavePlayer is disposed.");
  }
  private change(action: () => void): void {
    batch(() => untracked(action));
  }
  private bounds(): AudioRange {
    return this.range ?? { start: 0, end: this.length };
  }
  /** The audio time a restart must keep: a queued start's `when`, otherwise now. */
  private startTime(): number {
    return Math.max(this.context.currentTime, this.anchor?.time ?? 0);
  }
  private halt(): void {
    ++this.command;
    for (const binding of this.sourceAutomations) this.stopSourceAutomation(binding);
    this.held = this.position;
    this.anchor = null;
    this.player.stop();
    this.clearQueued();
  }
  private clearQueued(): void {
    clearTimeout(this.startTimer);
    this.startTimer = undefined;
    if (untracked(() => this.store.startsAt.value) !== null) this.store.startsAt.value = null;
  }
  /** Publishes a start still ahead of the audio clock and clears it once it has begun. */
  private queue(time: number): void {
    clearTimeout(this.startTimer);
    this.startTimer = undefined;
    if (time <= this.context.currentTime) return void (this.store.startsAt.value = null);
    this.store.startsAt.value = time;
    const check = () => {
      if (this.disposed || untracked(() => this.store.startsAt.value) !== time) return;
      if (this.context.currentTime >= time) {
        this.store.startsAt.value = null;
      } else this.startTimer = setTimeout(check, Math.max(5, (time - this.context.currentTime) * 1000));
    };
    this.startTimer = setTimeout(check, Math.max(5, (time - this.context.currentTime) * 1000));
  }
  /** The audio time of the boundary `play({ quantize })` starts at. */
  private boundary(clock: PlayerTransport, quantize: Exclude<Quantize, "none">): number {
    const [n, d] = untracked(() => clock.meter.value);
    const size = noteBeats(quantize, (n * 4) / d);
    const nowBeat = clock.timeline.timeToBeat(this.context.currentTime);
    // Exactly on a boundary starts there; otherwise the first boundary at least QUANTIZE_LEAD ahead.
    if (Math.abs(nowBeat / size - Math.round(nowBeat / size)) < EPS) return clock.timeline.beatToTime(Math.round(nowBeat / size) * size);
    const base = clock.timeline.timeToBeat(this.context.currentTime + QUANTIZE_LEAD);
    return clock.timeline.beatToTime(Math.ceil(base / size - EPS) * size);
  }
  private requireClock(): PlayerTransport {
    if (!this.follow) throw new DOMException("WavePlayer quantize needs clock.attach(player).", "InvalidStateError");
    if (untracked(() => this.follow!.state.value) !== "playing")
      throw new DOMException("WavePlayer quantize needs a playing clock.", "InvalidStateError");
    return this.follow;
  }
  /** Starts at `when`, clamped to now; null means a reentrant command superseded this start. */
  private begin(offset: number, when = 0): number | null {
    const command = ++this.command;
    this.player.stop();
    const { start, end } = this.bounds();
    offset = Math.max(start, Math.min(end, offset));
    if (offset >= end) offset = start;
    this.held = offset;
    this.player.loopStart = start;
    this.player.loopEnd = end;
    this.player.loop = this.looping;
    const time = Math.max(this.context.currentTime, when);
    this.anchor = null;
    try {
      for (const binding of this.sourceAutomations) {
        this.startSourceAutomation(binding, offset, end, time);
        if (this.command !== command || this.disposed) return null; // a target adapter may re-enter the player
      }
      this.player.start(time, offset);
      if (this.command !== command || this.disposed) return null;
      if (!this.looping) this.player.stop(time + end - offset);
      this.anchor = { time, offset, start, end };
      this.queue(time);
    } catch (error) {
      if (this.command === command) {
        for (const binding of this.sourceAutomations) this.stopSourceAutomation(binding);
        this.player.stop();
      }
      throw error;
    }
    return time;
  }
  /**
   * Starts playback and resolves with the audio time at which sound starts, or null when this call started nothing (nothing loaded, already playing, or superseded by a newer command).
   * It starts at the playhead (`position`) clamped into the selection: a playhead before the selection or at/past its end starts at the selection start, otherwise it continues from where it is; `stop()` rewinds the playhead to the selection start.
   * `quantize` waits for the clock's next boundary (see `WavePlayOptions`); `stop()` or, while attached, the clock stopping, pausing, seeking or detaching cancels a start still queued (`when` or `quantize`), resolving this call `null`; sound already playing continues.
   * With `quantize` it rejects with `InvalidStateError` when the player is not attached to a Clock or the clock is not playing, and with `RangeError` when `when` is also given.
   */
  async play(options: WavePlayOptions = {}): Promise<number | null> {
    this.assertAlive();
    const quantize = options.quantize ?? "none";
    let when = options.when ?? 0;
    if (quantize !== "none") {
      if (options.when !== undefined) throw new RangeError("WavePlayer play() takes `when` or `quantize`, not both.");
      noteBeats(quantize, 4);
      this.requireClock();
    }
    if (!Number.isFinite(when) || when < 0) throw new RangeError("Start time must be finite, non-negative seconds.");
    if (!this.loadedBuffer || this.running) return null;
    const command = ++this.command;
    await this.audioContext.resume();
    if (this.disposed || command !== this.command || !this.loadedBuffer) return null;
    if (quantize !== "none") when = this.boundary(this.requireClock(), quantize);
    // Fix this start's identity inside the change: observers notified by it may pause, seek or play again.
    let started = 0,
      time: number | null = null;
    this.change(() => {
      time = this.begin(this.position, when);
      started = time === null ? 0 : this.command;
    });
    return started === this.command ? time : null;
  }
  /** Pauses at the playhead, keeping it; also cancels a start still queued. */
  pause(): void {
    this.assertAlive();
    this.change(() => this.halt());
  }
  /** Stops and rewinds the playhead to the selection start (or 0); also cancels a start still queued. */
  stop(): void {
    this.assertAlive();
    this.change(() => {
      this.halt();
      this.held = this.range?.start ?? 0;
    });
  }
  /** Moves the playhead (seconds, clamped to the duration). While playing, playback continues from there (clamped into the selection, so a position outside it starts at the selection start); while stopped or paused it only moves the playhead. Throws `RangeError` for a non-finite position. */
  seek(position: number): void {
    this.assertAlive();
    if (!Number.isFinite(position)) throw new RangeError("Position must be finite seconds.");
    this.change(() => {
      const playing = this.running,
        when = this.startTime();
      this.halt();
      this.held = Math.max(0, Math.min(this.length, position));
      if (playing) this.begin(this.held, when);
    });
  }
  /**
   * Commits the playback range in output seconds (`0 <= start < end <= duration`), or `null` for the whole buffer (which also turns looping off). It can change while playing:
   * a looping run whose playhead is inside the new range keeps going without a gap, anything else restarts from the playhead clamped into the new range. Throws `RangeError` for an invalid range.
   */
  setSelection(selection: AudioRange | null): void {
    this.assertAlive();
    if (
      selection &&
      (!Number.isFinite(selection.start) ||
        !Number.isFinite(selection.end) ||
        selection.start < 0 ||
        selection.start >= selection.end ||
        selection.end > this.length)
    ) {
      throw new RangeError("Selection must satisfy 0 <= start < end <= duration (finite seconds).");
    }
    if (selection?.start === this.range?.start && selection?.end === this.range?.end && (selection !== null || !this.looping)) return;
    this.change(() => {
      const playing = this.running,
        position = this.position;
      if (!playing && this.sourceAutomations.size) ++this.command; // invalidate a play still awaiting context.resume()
      this.range = selection ? { start: selection.start, end: selection.end } : null;
      if (!selection) this.looping = false;
      if (playing) {
        const { start, end } = this.bounds();
        if (this.looping && position >= start && position < end) {
          this.player.loopStart = start;
          this.player.loopEnd = end;
          this.anchor = { time: this.startTime(), offset: position, start, end };
        } else this.begin(position, this.startTime());
      }
    });
  }
  /** Loops the selection (or the whole buffer). While playing it restarts from the current position, so expect a re-trigger rather than a seamless switch. Throws while source automation is attached. */
  setLooping(looping: boolean): void {
    this.assertAlive();
    if (looping && this.sourceAutomations.size) throw new Error("Source automation requires non-looping playback.");
    if (this.looping === looping) return;
    this.change(() => {
      const playing = this.running,
        position = this.position;
      this.looping = looping;
      if (playing) this.begin(position, this.startTime());
    });
  }
  async audition(): Promise<void> {
    this.assertAlive();
    if (!this.range) return;
    this.setLooping(true);
    this.seek(this.range.start);
    await this.play();
  }
  private cancelStretch(): void {
    ++this.editRequest;
    this.editAbort?.abort();
    this.editAbort = null;
    this.processing = false;
  }
  /**
   * Re-renders the output from the immutable original at `ratio` (output duration / original duration; 1 restores it) and commits audio and peaks, stopping playback at the committed playhead.
   * It rejects with the cause on failure (and the previous playable version stays); a request superseded by a newer `setStretch()`, `load()` or `dispose()` resolves without publishing.
   * Rejects with `RangeError` for a non-positive ratio and `Error` when nothing is loaded or no stretch processor was given.
   */
  async setStretch(ratio: number): Promise<void> {
    this.assertAlive();
    if (!Number.isFinite(ratio) || ratio <= 0) throw new RangeError("Stretch ratio must be finite and positive.");
    const original = this.original;
    if (!original) throw new Error("No audio source is loaded.");
    if (ratio !== 1 && !this.options.stretch) throw new Error("WavePlayer needs a stretch processor.");
    const controller = new AbortController();
    // Fix this request's identity before observers run: `change` commits, then notifies subscribers,
    // and one of them may start a newer stretch re-entrantly.
    let id = 0,
      sourceRevision = 0;
    this.change(() => {
      if (this.sourceAutomations.size) {
        if (this.anchor && this.anchor.time > this.context.currentTime) this.halt();
        else ++this.command; // invalidate a play still awaiting context.resume()
      }
      this.cancelStretch();
      id = this.editRequest;
      sourceRevision = this.sourceRevision;
      this.editAbort = controller;
      this.processing = true;
    });
    if (this.disposed || id !== this.editRequest || sourceRevision !== this.sourceRevision) return;
    try {
      const pcm = ratio === 1 ? this.pcm(original) : await this.options.stretch!.process(this.pcm(original), { ratio, signal: controller.signal });
      if (this.disposed || id !== this.editRequest || sourceRevision !== this.sourceRevision) return;
      const expected = Math.round(original.length * ratio);
      if (
        pcm.sampleRate !== original.sampleRate ||
        pcm.channels.length !== original.numberOfChannels ||
        pcm.channels.some((channel) => channel.length !== expected)
      ) {
        throw new Error("Stretch processor returned incompatible PCM.");
      }
      const peaks = summarizePeaks(pcm);
      const buffer = ratio === 1 ? original : this.audioContext.createBuffer(pcm.channels.length, expected, pcm.sampleRate);
      if (buffer !== original) for (let c = 0; c < pcm.channels.length; c++) buffer.getChannelData(c).set(pcm.channels[c]);
      this.change(() => {
        const scale = buffer.duration / this.length,
          position = this.position;
        const selection = this.range;
        this.halt();
        this.player.buffer = buffer;
        this.held = Math.min(buffer.duration, position * scale);
        this.range = selection ? { start: selection.start * scale, end: Math.min(buffer.duration, selection.end * scale) } : null;
        this.processing = false;
        this.store.version.value = Object.freeze({ revision: ++this.revision, sourceRevision, buffer, peaks, ratio });
      });
    } catch (reason) {
      if (this.disposed || id !== this.editRequest || sourceRevision !== this.sourceRevision) return;
      this.change(() => {
        this.processing = false;
      });
      throw reason;
    } finally {
      if (id === this.editRequest) this.editAbort = null;
    }
  }
  /** Cancel this load without publishing an error. Late decode/cache results are ignored. */
  cancelLoad(): void {
    this.assertAlive();
    if (!this.loading) return;
    this.change(() => {
      ++this.request;
      this.abort?.abort();
      this.abort = null;
      this.loading = false;
      this.loadProgress = null;
      this.error = null;
    });
  }
  private reportLoad(request: number, progress: WaveLoadProgress): void {
    if (this.disposed || request !== this.request || !this.loading) return;
    if (progress.phase === "download" || progress.phase === "read") {
      const { loadedBytes, totalBytes } = progress;
      if (
        !Number.isSafeInteger(loadedBytes) ||
        loadedBytes < 0 ||
        (totalBytes !== null && (!Number.isSafeInteger(totalBytes) || totalBytes < loadedBytes))
      ) {
        throw new RangeError("Load progress needs non-negative byte counts and a null or matching total.");
      }
      progress = { phase: progress.phase, loadedBytes, totalBytes };
    } else if (progress.phase === "decode" || progress.phase === "peaks") progress = { phase: progress.phase };
    else throw new RangeError("Unknown audio loading phase.");
    this.change(() => {
      this.loadProgress = Object.freeze(progress);
    });
  }
  /**
   * Replacing the source cancels playback, selection, loop and any older load. A failed load rejects with the cause and also writes `cells.error`, so handle it in one place.
   * A load superseded by a newer `load()`, `cancelLoad()` or `dispose()` resolves silently and touches neither `cells.error` nor the new load's state.
   */
  async load(source: WavePlayerSource): Promise<void> {
    this.assertAlive();
    const request = ++this.request;
    this.abort?.abort();
    const controller = new AbortController();
    this.abort = controller;
    this.change(() => {
      this.cancelStretch();
      ++this.sourceRevision;
      this.halt();
      this.player.buffer = null;
      this.range = null;
      this.looping = false;
      this.held = 0;
      this.loading = true;
      this.loadProgress = null;
      this.error = null;
      this.original = null;
      this.store.version.value = null;
    });
    if (this.disposed || request !== this.request) return;
    try {
      let buffer: AudioBuffer;
      if (typeof source !== "string" && "getChannelData" in source) buffer = source;
      else {
        const options = {
          context: this.audioContext,
          signal: controller.signal,
          onProgress: (progress: Exclude<WaveLoadProgress, { phase: "peaks" }>) => this.reportLoad(request, progress),
        };
        buffer = await (typeof source === "string" && this.options.loadSource
          ? this.options.loadSource(source, options)
          : loadSource(source, options));
      }
      if (this.disposed || request !== this.request) return;
      if (!Number.isFinite(buffer.duration) || buffer.duration <= 0) throw new Error("Audio file has no playable duration.");
      this.reportLoad(request, { phase: "peaks" });
      if (this.disposed || request !== this.request) return;
      const peaks = summarizePeaks(this.pcm(buffer));
      this.change(() => {
        this.player.buffer = buffer;
        this.original = buffer;
        this.loading = false;
        this.loadProgress = null;
        this.store.version.value = Object.freeze({ revision: ++this.revision, sourceRevision: this.sourceRevision, buffer, peaks, ratio: 1 });
      });
    } catch (reason) {
      if (this.disposed || request !== this.request) return;
      this.change(() => {
        this.loading = false;
        this.loadProgress = null;
        this.error = reason instanceof Error ? reason.message : String(reason);
      });
      throw reason;
    } finally {
      if (request === this.request) this.abort = null;
    }
  }
  override dispose(): void {
    if (this.disposed) return;
    this.abortSignal?.removeEventListener("abort", this.onAbort);
    this.follow?.detach();
    this.change(() => {
      this.disposed = true;
      ++this.request;
      this.cancelStretch();
      this.abort?.abort();
      this.abort = null;
      this.halt();
      this.sourceAutomations.clear();
      this.player.buffer = null;
      this.range = null;
      this.looping = false;
      this.held = 0;
      this.loading = false;
      this.loadProgress = null;
      this.original = null;
      this.store.version.value = null;
      this.player.dispose();
      super.dispose();
      this.gain.disconnect();
    });
  }
}
