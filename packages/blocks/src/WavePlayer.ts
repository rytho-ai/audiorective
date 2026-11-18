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

/** A processor is borrowed; its lifetime belongs to the caller. */
export interface WaveStretchProcessor {
  process(input: PCMData, options: { ratio: number; signal?: AbortSignal }): Promise<PCMData>;
}
export interface WavePlayerOptions {
  stretch?: WaveStretchProcessor;
  /** Optional URL/cache adapter. Files use native loading; the player owns lifecycle and summary. */
  loadSource?: WaveSourceLoader;
}
export interface WavePlayOptions {
  /** Absolute audio-context seconds at which sound starts. A past time clamps to now. Default: now. */
  when?: number;
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
export type WavePlayerState = {
  duration: number;
  selection: AudioRange | null;
  position: number;
  isPlaying: boolean;
  isLooping: boolean;
  loading: boolean;
  /** Null when idle or before a custom loader reports its first phase. */
  loadProgress: WaveLoadProgress | null;
  error: string | null;
  processing: boolean;
  stretchRatio: number;
  sourceDuration: number;
  revision: number;
};

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
};
type Store = {
  selection: Cell<Readonly<AudioRange> | null>;
  isLooping: Cell<boolean>;
  loading: Cell<boolean>;
  loadProgress: Cell<WaveLoadProgress | null>;
  error: Cell<string | null>;
  processing: Cell<boolean>;
  version: Cell<PlaybackVersion | null>;
};

/** Headless audio loading, range playback and non-destructive stretch. The caller owns context and routing. */
export class WavePlayer extends AudioProcessor<{ volume: SchedulableParam }, WavePlayerCells> {
  private readonly player: BufferPlayer;
  private readonly gain: GainNode;
  private readonly audioContext: AudioContext;
  /** The only store. Writable here, read-only on `cells`. */
  private readonly store: Store;
  private held = 0;
  private anchor: { time: number; offset: number; start: number; end: number } | null = null;
  private request = 0;
  private command = 0;
  private abort: AbortController | null = null;
  private disposed = false;
  private depth = 0;
  private readonly listeners = new Set<() => void>();
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
      },
    }));
    this.gain = gain;
    this.audioContext = context;
    this.player = player;
    this.store = store;
    this.defineGraph(() => [[this.player, gain]]);
    this.effect(() => {
      void this.player.cells.isPlaying.value;
      this.notify();
    });
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
    return this.player.buffer;
  }
  get duration(): number {
    return this.buffer?.duration ?? 0;
  }
  /** One coherent audio/peaks revision. Treat its borrowed data as read-only. */
  get version(): PlaybackVersion | null {
    return this.cells.version.value;
  }
  get sourceBuffer(): AudioBuffer | null {
    return this.original;
  }
  private pcm(buffer: AudioBuffer): PCMData {
    return { sampleRate: buffer.sampleRate, channels: Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c)) };
  }
  sourceToOutput(seconds: number): number {
    if (!Number.isFinite(seconds)) throw new RangeError("Time must be finite seconds.");
    return this.original ? (Math.max(0, Math.min(this.original.duration, seconds)) * this.duration) / this.original.duration : 0;
  }
  outputToSource(seconds: number): number {
    if (!Number.isFinite(seconds)) throw new RangeError("Time must be finite seconds.");
    return this.duration ? (Math.max(0, Math.min(this.duration, seconds)) * (this.original?.duration ?? 0)) / this.duration : 0;
  }
  get position(): number {
    if (!this.anchor) return this.held;
    const a = this.anchor;
    const time = a.offset + Math.max(0, this.context.currentTime - a.time);
    return this.looping ? a.start + ((((time - a.start) % (a.end - a.start)) + a.end - a.start) % (a.end - a.start)) : Math.min(a.end, time);
  }
  get isPlaying(): boolean {
    return this.cells.isPlaying.value && (this.cells.isLooping.value || this.position < (this.anchor?.end ?? this.duration));
  }
  get isLooping(): boolean {
    return this.cells.isLooping.value;
  }
  getSelection(): AudioRange | null {
    const range = this.cells.selection.value;
    return range ? { ...range } : null;
  }
  getState(): WavePlayerState {
    return {
      duration: this.duration,
      selection: this.getSelection(),
      position: this.position,
      isPlaying: this.isPlaying,
      isLooping: this.isLooping,
      loading: this.cells.loading.value,
      loadProgress: this.cells.loadProgress.value,
      error: this.cells.error.value,
      processing: this.cells.processing.value,
      stretchRatio: this.version?.ratio ?? 1,
      sourceDuration: this.original?.duration ?? 0,
      revision: this.version?.revision ?? 0,
    };
  }
  /** Change notifications exclude clock-only playhead movement. Read position per frame. */
  subscribe(listener: () => void): () => void {
    this.assertAlive();
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
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
        if (this.anchor && this.isPlaying) this.startSourceAutomation(binding, this.position, this.anchor.end, this.startTime());
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
      from: this.outputToSource(offset),
      to: this.outputToSource(end),
      secondsPerUnit: this.duration / source.duration,
    });
  }
  private assertAlive(): void {
    if (this.disposed) throw new Error("WavePlayer is destroyed.");
  }
  private notify(): void {
    if (this.depth) return;
    for (const listener of [...this.listeners]) {
      if (!this.listeners.has(listener)) continue;
      try {
        untracked(listener);
      } catch (error) {
        console.error("WavePlayer listener failed.", error);
      }
    }
  }
  private change(action: () => void): void {
    this.depth++;
    try {
      batch(() => untracked(action));
    } finally {
      if (--this.depth === 0) this.notify();
    }
  }
  private bounds(): AudioRange {
    return this.range ?? { start: 0, end: this.duration };
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
    } catch (error) {
      if (this.command === command) {
        for (const binding of this.sourceAutomations) this.stopSourceAutomation(binding);
        this.player.stop();
      }
      throw error;
    }
    return time;
  }
  /** Resolves with the audio time at which sound starts, or null when this call started nothing. */
  async play(options: WavePlayOptions = {}): Promise<number | null> {
    this.assertAlive();
    const when = options.when ?? 0;
    if (!Number.isFinite(when) || when < 0) throw new RangeError("Start time must be finite, non-negative seconds.");
    if (!this.buffer || untracked(() => this.isPlaying)) return null;
    const command = ++this.command;
    await this.audioContext.resume();
    if (this.disposed || command !== this.command || !this.buffer) return null;
    // Fix this start's identity inside the change: observers notified by it may pause, seek or play again.
    let started = 0,
      time: number | null = null;
    this.change(() => {
      time = this.begin(this.position, when);
      started = time === null ? 0 : this.command;
    });
    return started === this.command ? time : null;
  }
  pause(): void {
    this.assertAlive();
    this.change(() => this.halt());
  }
  stop(): void {
    this.assertAlive();
    this.change(() => {
      this.halt();
      this.held = this.range?.start ?? 0;
    });
  }
  seek(position: number): void {
    this.assertAlive();
    if (!Number.isFinite(position)) throw new RangeError("Position must be finite seconds.");
    this.change(() => {
      const playing = this.isPlaying,
        when = this.startTime();
      this.halt();
      this.held = Math.max(0, Math.min(this.duration, position));
      if (playing) this.begin(this.held, when);
    });
  }
  setSelection(selection: AudioRange | null): void {
    this.assertAlive();
    if (
      selection &&
      (!Number.isFinite(selection.start) ||
        !Number.isFinite(selection.end) ||
        selection.start < 0 ||
        selection.start >= selection.end ||
        selection.end > this.duration)
    ) {
      throw new RangeError("Selection must satisfy 0 <= start < end <= duration (finite seconds).");
    }
    if (selection?.start === this.range?.start && selection?.end === this.range?.end && (selection !== null || !this.looping)) return;
    this.change(() => {
      const playing = this.isPlaying,
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
  setLooping(looping: boolean): void {
    this.assertAlive();
    if (looping && this.sourceAutomations.size) throw new Error("Source automation requires non-looping playback.");
    if (this.looping === looping) return;
    this.change(() => {
      const playing = this.isPlaying,
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
  /** Render from the immutable original, then commit audio + peaks while stopped.
   * Superseded jobs settle without publishing; failures keep the playable version. */
  async setStretch(ratio: number): Promise<void> {
    this.assertAlive();
    if (!Number.isFinite(ratio) || ratio <= 0) throw new RangeError("Stretch ratio must be finite and positive.");
    const original = this.original;
    if (!original) throw new Error("No audio source is loaded.");
    if (ratio !== 1 && !this.options.stretch) throw new Error("WavePlayer needs a stretch processor.");
    const controller = new AbortController();
    // Fix this request's identity before observers run: `change` notifies effects and listeners,
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
      this.error = null;
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
        const scale = buffer.duration / this.duration,
          position = this.position;
        const selection = this.getSelection();
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
        this.error = reason instanceof Error ? reason.message : String(reason);
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
  /** Replacing the source cancels playback, selection, loop and any older load. */
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
  override destroy(): void {
    if (this.disposed) return;
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
      this.player.destroy();
      super.destroy();
      this.gain.disconnect();
    });
    this.listeners.clear();
  }
}
