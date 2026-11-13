import { AudioProcessor, BufferPlayer, cell, type SchedulableParam } from "@audiorective/core";
import { summarizePeaks, type PCMData, type PeakSummary } from "@audiorective/core/peaks";
import { loadSource, type RangeLoadProgress, type RangeSourceLoader } from "./source";

/** A processor is borrowed; its lifetime belongs to the caller. */
export interface RangeStretchProcessor {
  process(input: PCMData, options: { ratio: number; signal?: AbortSignal }): Promise<PCMData>;
}
export interface RangePlayerOptions {
  stretch?: RangeStretchProcessor;
  /** Optional URL/cache adapter. Files use native loading; the player owns lifecycle and summary. */
  loadSource?: RangeSourceLoader;
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
export type RangePlayerSource = string | File | AudioBuffer;
export type RangePlayerState = {
  duration: number;
  selection: AudioRange | null;
  position: number;
  isPlaying: boolean;
  isLooping: boolean;
  loading: boolean;
  /** Null when idle or before a custom loader reports its first phase. */
  loadProgress: RangeLoadProgress | null;
  error: string | null;
  processing: boolean;
  stretchRatio: number;
  sourceDuration: number;
  revision: number;
};

/** Headless, original-speed range audition. The caller owns context and routing. */
export class RangePlayer extends AudioProcessor<{ volume: SchedulableParam }, {}> {
  private readonly player: BufferPlayer;
  private readonly gain: GainNode;
  private readonly audioContext: AudioContext;
  private range: AudioRange | null = null;
  private looping = false;
  private held = 0;
  private anchor: { time: number; offset: number; start: number; end: number } | null = null;
  private loading = false;
  private loadProgress: RangeLoadProgress | null = null;
  private error: string | null = null;
  private request = 0;
  private command = 0;
  private abort: AbortController | null = null;
  private disposed = false;
  private depth = 0;
  private readonly listeners = new Set<() => void>();
  private readonly current = cell<PlaybackVersion | null>(null);
  private original: AudioBuffer | null = null;
  private sourceRevision = 0;
  private revision = 0;
  private processing = false;
  private editRequest = 0;
  private editAbort: AbortController | null = null;

  constructor(
    context: AudioContext,
    private readonly options: RangePlayerOptions = {},
  ) {
    const gain = new GainNode(context);
    super(context, ({ param }) => ({
      params: { volume: param({ default: 1, bind: gain.gain, min: 0, max: 1 }) },
      cells: {},
    }));
    this.gain = gain;
    this.audioContext = context;
    this.player = new BufferPlayer(context);
    this.defineGraph(() => [[this.player, gain]]);
    this.effect(() => {
      void this.player.cells.isPlaying.value;
      this.notify();
    });
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
    return this.current.value;
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
    return this.player.cells.isPlaying.value && (this.looping || this.position < (this.anchor?.end ?? this.duration));
  }
  get isLooping(): boolean {
    return this.looping;
  }
  getSelection(): AudioRange | null {
    return this.range ? { ...this.range } : null;
  }
  getState(): RangePlayerState {
    return {
      duration: this.duration,
      selection: this.getSelection(),
      position: this.position,
      isPlaying: this.isPlaying,
      isLooping: this.looping,
      loading: this.loading,
      loadProgress: this.loadProgress,
      error: this.error,
      processing: this.processing,
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
  private assertAlive(): void {
    if (this.disposed) throw new Error("Range player is destroyed.");
  }
  private notify(): void {
    if (this.depth) return;
    for (const listener of [...this.listeners]) {
      if (!this.listeners.has(listener)) continue;
      try {
        listener();
      } catch (error) {
        console.error("Range player listener failed.", error);
      }
    }
  }
  private change(action: () => void): void {
    this.depth++;
    try {
      action();
    } finally {
      if (--this.depth === 0) this.notify();
    }
  }
  private bounds(): AudioRange {
    return this.range ?? { start: 0, end: this.duration };
  }
  private halt(): void {
    ++this.command;
    this.held = this.position;
    this.anchor = null;
    this.player.stop();
  }
  private begin(offset: number): void {
    this.player.stop();
    const { start, end } = this.bounds();
    offset = Math.max(start, Math.min(end, offset));
    if (offset >= end) offset = start;
    this.held = offset;
    this.player.loopStart = start;
    this.player.loopEnd = end;
    this.player.loop = this.looping;
    const time = this.context.currentTime;
    this.anchor = { time, offset, start, end };
    this.player.start(time, offset);
    if (!this.looping) this.player.stop(time + end - offset);
  }
  async play(): Promise<void> {
    this.assertAlive();
    if (!this.buffer || this.isPlaying) return;
    const command = ++this.command;
    await this.audioContext.resume();
    if (this.disposed || command !== this.command || !this.buffer) return;
    this.change(() => this.begin(this.position));
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
      const playing = this.isPlaying;
      this.halt();
      this.held = Math.max(0, Math.min(this.duration, position));
      if (playing) this.begin(this.held);
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
      this.range = selection ? { start: selection.start, end: selection.end } : null;
      if (!selection) this.looping = false;
      if (playing) {
        const { start, end } = this.bounds();
        if (this.looping && position >= start && position < end) {
          this.player.loopStart = start;
          this.player.loopEnd = end;
          this.anchor = { time: this.context.currentTime, offset: position, start, end };
        } else this.begin(position);
      }
    });
  }
  setLooping(looping: boolean): void {
    this.assertAlive();
    if (this.looping === looping) return;
    this.change(() => {
      const playing = this.isPlaying,
        position = this.position;
      this.looping = looping;
      if (playing) this.begin(position);
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
    if (ratio !== 1 && !this.options.stretch) throw new Error("RangePlayer needs a stretch processor.");
    this.cancelStretch();
    const id = this.editRequest,
      sourceRevision = this.sourceRevision;
    const controller = new AbortController();
    this.editAbort = controller;
    this.change(() => {
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
        this.current.value = Object.freeze({ revision: ++this.revision, sourceRevision, buffer, peaks, ratio });
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
  private reportLoad(request: number, progress: RangeLoadProgress): void {
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
  async load(source: RangePlayerSource): Promise<void> {
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
      this.current.value = null;
    });
    if (this.disposed || request !== this.request) return;
    try {
      let buffer: AudioBuffer;
      if (typeof source !== "string" && "getChannelData" in source) buffer = source;
      else {
        const options = {
          context: this.audioContext,
          signal: controller.signal,
          onProgress: (progress: Exclude<RangeLoadProgress, { phase: "peaks" }>) => this.reportLoad(request, progress),
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
        this.current.value = Object.freeze({ revision: ++this.revision, sourceRevision: this.sourceRevision, buffer, peaks, ratio: 1 });
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
      this.player.buffer = null;
      this.range = null;
      this.looping = false;
      this.held = 0;
      this.loading = false;
      this.loadProgress = null;
      this.original = null;
      this.current.value = null;
      this.player.destroy();
      super.destroy();
      this.gain.disconnect();
    });
    this.listeners.clear();
  }
}
