import {
  AudioProcessor,
  batch,
  cell,
  readonlyCell,
  registerWorklet,
  untracked,
  type BeatTiming,
  type Cell,
  type ReadonlyCell,
} from "@audiorective/core";
import type { PCMData } from "@audiorective/core/peaks";
import { AUDIO_RECORDER_WORKLET, AUDIO_RECORDER_WORKLET_NAME } from "./recording/audio-recorder.worklet";
export * from "./MicrophoneInput";

/** "none" starts at once; otherwise the next boundary of an attached playing clock: "1m" a bar of its meter (4 beats in 4/4), "2m" two bars, "4n" a beat, "8n" half a beat. A call exactly on a boundary starts there, not on the next one. */
export type Quantize = "none" | `${number}m` | `${number}n`;
/** A length measured at the clock's tempo from the take's start: "4m" four bars, "4n" one beat. */
export type NoteLength = Exclude<Quantize, "none">;
/** The part of a clock's `SchedulerHandle` a recorder reads; `clock.attach(recorder)` supplies it. */
export type RecorderTransport = Readonly<{
  timeline: BeatTiming;
  state: Readonly<{ value: "stopped" | "playing" | "paused" }>;
  meter: Readonly<{ value: readonly [number, number] }>;
  detach(): void;
}>;
/** Why a clock resets its schedulers: it started, stopped, paused or jumped, or the scheduler is leaving. */
export type RecorderResetReason = "start" | "stop" | "pause" | "seek" | "detach";

/** Seconds of lead a quantized start keeps, so the capture graph exists before the boundary. */
const QUANTIZE_LEAD = 0.05;
const EPS = 1e-7;
function noteBeats(value: string, barBeats: number): number {
  const m = /^(\d+(?:\.\d+)?)([mn])$/.exec(value);
  if (!m || !(Number(m[1]) > 0)) throw new RangeError(`AudioRecorder requires a note value such as "4n" or "1m", got "${value}".`);
  return m[2] === "m" ? Number(m[1]) * barBeats : 4 / Number(m[1]);
}

export type AudioRecorderState = "idle" | "armed" | "recording" | "stopping" | "disposed";
export interface AudioRecorderOptions {
  /** Captured channel count, with discrete up/down-mixing by Web Audio. Default: 2. */
  channels?: number;
  /** Aborting the signal calls `dispose()`. */
  signal?: AbortSignal;
}
export interface RecordOptions {
  /** Absolute AudioContext seconds the take starts at; a past time starts at the first available frame. Default: now. Not with `quantize`. */
  when?: number;
  /**
   * Start at the next boundary of the attached, playing clock (`"1m"` the next bar line); a call exactly on a boundary starts there, not on the next one.
   * Default `"none"`. `record()` rejects with `InvalidStateError` when the recorder is not attached to a Clock (`clock.attach(recorder)`) or the clock is not playing.
   */
  quantize?: Quantize;
  /** Take length: seconds, or a note value from the start (`"4m"` four bars at the clock's tempo, which needs the clock). Default: until `stop()`. */
  length?: number | NoteLength;
  /** Aborting discards the take and rejects `record()` with `AbortError`, like `cancel()`. */
  signal?: AbortSignal;
}
export interface RecordedAudio extends PCMData {
  /** Inclusive first captured sample frame on the AudioContext clock. */
  readonly startFrame: number;
  /** Exclusive final captured sample frame on the AudioContext clock. */
  readonly endFrame: number;
  /** `startFrame` in AudioContext seconds (`startFrame / sampleRate`). */
  readonly startTime: number;
  /** `endFrame` in AudioContext seconds (`endFrame / sampleRate`). */
  readonly endTime: number;
  /** The clock beat, in beats from the clock's beat 0, at `startTime` when the recorder was attached to a playing clock at the start, else null. */
  readonly startBeat: number | null;
  readonly dropouts?: readonly Readonly<{ startFrame: number; endFrame: number }>[];
}
export interface RecordedAudioSpan {
  readonly channelCount: number;
  readonly sampleRate: number;
  readonly startFrame: number;
  readonly endFrame: number;
  readonly startTime: number;
  readonly endTime: number;
  /** Missing browser render frames, represented as silence in streamed PCM. */
  readonly dropouts?: readonly Readonly<{ startFrame: number; endFrame: number }>[];
}
export interface RecordedAudioChunk {
  readonly startFrame: number;
  readonly channels: readonly Float32Array[];
}

type RecorderMessage =
  | { type: "begin"; frame: number }
  | { type: "chunk"; startFrame: number; channels: Float32Array[] }
  | { type: "done"; startFrame: number; endFrame: number; dropouts?: Array<{ startFrame: number; endFrame: number }> }
  | { type: "gap"; startFrame: number; endFrame: number };

type Session = {
  startFrame: number;
  /** In-memory `record()` takes settle one promise created up front; streams settle at `stopStream()`. */
  promise?: Promise<RecordedAudio>;
  /** A `stop()` that arrived while the capture graph was still being built. */
  pendingStop?: { when?: number };
  /** A length, as seconds or beats, applied once the start is fixed. */
  length?: number | NoteLength;
  /** Started at a clock boundary: leaving the transport before it arrives cancels the take. */
  quantized?: boolean;
  startBeat?: number | null;
  node?: AudioWorkletNode;
  capture?: AudioParam;
  sink?: GainNode;
  onContextState?: () => void;
  chunks: Array<{ startFrame: number; channels: Float32Array[] }>;
  writeChunk?: (chunk: RecordedAudioChunk) => void | Promise<void>;
  nextFrame?: number;
  pendingWrites: Set<Promise<void>>;
  resolve?: (take: RecordedAudio | RecordedAudioSpan) => void;
  reject?: (error: unknown) => void;
};

function registerRecorder(context: BaseAudioContext): Promise<void> {
  if (!context.audioWorklet) return Promise.reject(new Error("AudioRecorder requires AudioWorklet support."));
  return registerWorklet(context, AUDIO_RECORDER_WORKLET_NAME, AUDIO_RECORDER_WORKLET);
}

function abortError(): DOMException {
  return new DOMException("AudioRecorder recording was cancelled.", "AbortError");
}

export type AudioRecorderCells = {
  state: ReadonlyCell<AudioRecorderState>;
  error: ReadonlyCell<string | null>;
  /** AudioContext time the armed take starts at; null unless a take is armed. */
  startsAt: ReadonlyCell<number | null>;
  /** AudioContext time the capture began; null unless a take is recording. */
  startedAt: ReadonlyCell<number | null>;
};

/**
 * Borrowed input capture; the result retains raw AudioContext frame positions for later track placement.
 * It is also a clock scheduler: `clock.attach(recorder)` lets `record({ quantize, length })` start on a bar line and run for bars.
 */
export class AudioRecorder extends AudioProcessor<{}, AudioRecorderCells> {
  private readonly source: GainNode;
  private readonly stateStore: Cell<AudioRecorderState>;
  private readonly errorStore: Cell<string | null>;
  private readonly startsAtStore: Cell<number | null>;
  private readonly startedAtStore: Cell<number | null>;
  private follow: RecorderTransport | null = null;
  private readonly abortSignal?: AbortSignal;
  private readonly onAbort = () => this.dispose();
  private readonly channels: number;
  private active: Session | null = null;
  private disposed = false;
  private registration: Promise<void> | null = null;

  constructor(context: BaseAudioContext, options: AudioRecorderOptions = {}) {
    const channels = options.channels ?? 2;
    if (!Number.isInteger(channels) || channels < 1 || channels > 32) throw new RangeError("AudioRecorder channels must be an integer from 1 to 32.");
    const source = new GainNode(context, { channelCount: channels, channelCountMode: "explicit", channelInterpretation: "discrete" });
    const stateStore = cell<AudioRecorderState>("idle");
    const errorStore = cell<string | null>(null);
    const startsAtStore = cell<number | null>(null);
    const startedAtStore = cell<number | null>(null);
    super(context, () => ({
      params: {},
      cells: {
        state: readonlyCell(stateStore),
        error: readonlyCell(errorStore),
        startsAt: readonlyCell(startsAtStore),
        startedAt: readonlyCell(startedAtStore),
      },
    }));
    this.source = source;
    this.stateStore = stateStore;
    this.errorStore = errorStore;
    this.startsAtStore = startsAtStore;
    this.startedAtStore = startedAtStore;
    this.channels = channels;
    this.abortSignal = options.signal;
    if (this.abortSignal?.aborted) this.dispose();
    else this.abortSignal?.addEventListener("abort", this.onAbort, { once: true });
  }

  /** Clock scheduler contract: a recorder schedules nothing per window; `clock.attach(recorder)` only gives it the transport `record({ quantize })` reads. */
  schedule(): void {}
  /** Clock scheduler contract: leaving the transport (stop, pause, seek, detach) before a quantized start arrives cancels that take; a take already recording continues. */
  reset(reason: RecorderResetReason): void {
    if (reason !== "start" && this.active?.quantized && untracked(() => this.stateStore.value) === "armed") this.cancel();
  }
  /** Clock scheduler contract: called by `clock.attach`. */
  attached(handle: RecorderTransport): () => void {
    this.follow = handle;
    return () => {
      if (this.follow === handle) this.follow = null;
    };
  }

  get input(): GainNode {
    return this.source;
  }
  get output(): undefined {
    return undefined;
  }
  /** Preload the worklet when a gesture or a transport countdown gives time to do so. */
  get ready(): Promise<void> {
    if (this.disposed) return Promise.reject(new Error("AudioRecorder is disposed."));
    return (this.registration ??= registerRecorder(this.context).catch((error: unknown) => {
      this.registration = null;
      throw error;
    }));
  }

  /**
   * Records one take and resolves with it after it ends, at `length` or at `stop()`. A quantized start waits for the clock's next boundary, and the take
   * reports it as `startBeat`. With `quantize` (or a note-value `length`) it rejects with `InvalidStateError` when the recorder is not attached to a Clock or, for `quantize`, the clock is not playing. Late worklet registration starts at the first available frame. Call it from a gesture on a running context.
   */
  record(options: RecordOptions = {}): Promise<RecordedAudio> {
    return new Promise<RecordedAudio>((resolve, reject) => {
      const quantize = options.quantize ?? "none";
      try {
        if (quantize !== "none") {
          if (options.when !== undefined) throw new RangeError("AudioRecorder record() takes `when` or `quantize`, not both.");
          noteBeats(quantize, 4);
          this.requirePlayingClock("quantize");
        }
        if (typeof options.length === "string") {
          noteBeats(options.length, 4);
          this.requireClock("length");
        } else if (options.length !== undefined && !(Number.isFinite(options.length) && options.length > 0)) {
          throw new RangeError("AudioRecorder length must be positive seconds or a note value.");
        }
      } catch (error) {
        reject(error);
        return;
      }
      const promise = new Promise<RecordedAudio>((settle, fail) => {
        this.startCapture({ when: options.when }, undefined, { settle, fail, quantize, length: options.length, signal: options.signal }).catch(fail);
      });
      promise.then(resolve, reject);
    });
  }

  private requireClock(what: string): RecorderTransport {
    if (!this.follow) throw new DOMException(`AudioRecorder ${what} needs clock.attach(recorder).`, "InvalidStateError");
    return this.follow;
  }
  private requirePlayingClock(what: string): RecorderTransport {
    const clock = this.requireClock(what);
    if (untracked(() => clock.state.value) !== "playing") throw new DOMException(`AudioRecorder ${what} needs a playing clock.`, "InvalidStateError");
    return clock;
  }
  private barBeats(clock: RecorderTransport): number {
    const [n, d] = untracked(() => clock.meter.value);
    return (n * 4) / d;
  }

  /** Sends bounded chunks to an external writer without retaining the take's PCM in memory. */
  async startStream(writeChunk: (chunk: RecordedAudioChunk) => void | Promise<void>, options: { when?: number } = {}): Promise<void> {
    if (typeof writeChunk !== "function") throw new TypeError("AudioRecorder stream needs a chunk writer.");
    return this.startCapture(options, writeChunk);
  }

  private async startCapture(
    options: { when?: number },
    writeChunk?: (chunk: RecordedAudioChunk) => void | Promise<void>,
    take?: {
      settle: (take: RecordedAudio) => void;
      fail: (error: unknown) => void;
      quantize: Quantize;
      length?: number | NoteLength;
      signal?: AbortSignal;
    },
  ): Promise<void> {
    if (this.disposed) throw new Error("AudioRecorder is disposed.");
    if (this.active) throw new Error("AudioRecorder already has an active take.");
    const when = options.when ?? this.context.currentTime;
    if (!Number.isFinite(when) || when < 0) throw new RangeError("AudioRecorder time must be finite, non-negative seconds.");
    const session: Session = {
      startFrame: Math.ceil(Math.max(when, this.context.currentTime) * this.context.sampleRate),
      chunks: [],
      writeChunk,
      pendingWrites: new Set(),
    };
    this.active = session;
    batch(() => {
      this.errorStore.value = null;
      this.stateStore.value = "armed";
    });
    if (take) {
      session.promise = new Promise<RecordedAudio>((resolve, reject) => {
        session.resolve = resolve as Session["resolve"];
        session.reject = reject;
      });
      session.promise.then(take.settle, take.fail);
      session.length = take.length;
      session.quantized = take.quantize !== "none";
      const { signal } = take;
      if (signal) {
        const cancel = () => this.active === session && this.fail(session, signal.reason instanceof DOMException ? signal.reason : abortError());
        if (signal.aborted) cancel();
        else {
          signal.addEventListener("abort", cancel, { once: true });
          session.promise.then(
            () => signal.removeEventListener("abort", cancel),
            () => signal.removeEventListener("abort", cancel),
          );
        }
      }
    }
    try {
      await this.ready;
      if (this.active !== session) throw abortError();
      let when = options.when ?? this.context.currentTime;
      let boundaryBeat: number | null = null;
      if (take && take.quantize !== "none") {
        const clock = this.requirePlayingClock("quantize");
        const size = noteBeats(take.quantize, this.barBeats(clock));
        const nowBeat = clock.timeline.timeToBeat(this.context.currentTime);
        // Exactly on a boundary starts there, like the launcher; otherwise the first boundary at least QUANTIZE_LEAD ahead.
        if (Math.abs(nowBeat / size - Math.round(nowBeat / size)) < EPS) boundaryBeat = Math.round(nowBeat / size) * size;
        else {
          const base = clock.timeline.timeToBeat(this.context.currentTime + QUANTIZE_LEAD);
          boundaryBeat = Math.ceil(base / size - EPS) * size;
        }
        when = clock.timeline.beatToTime(boundaryBeat);
      }
      if (!Number.isFinite(when) || when < 0) throw new RangeError("AudioRecorder time must be finite, non-negative seconds.");
      const node = new AudioWorkletNode(this.context, AUDIO_RECORDER_WORKLET_NAME, {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        channelCount: this.channels,
        channelCountMode: "explicit",
        channelInterpretation: "discrete",
        processorOptions: { channels: this.channels },
      });
      const sink = new GainNode(this.context, { gain: 0 });
      const capture = (node.parameters as unknown as ReadonlyMap<string, AudioParam>).get("capture")!;
      session.node = node;
      session.capture = capture;
      session.sink = sink;
      node.port.onmessage = (event: MessageEvent<RecorderMessage>) => this.receive(session, event.data);
      node.onprocessorerror = () => this.fail(session, new Error("AudioRecorder worklet failed."));
      if (typeof AudioContext !== "undefined" && this.context instanceof AudioContext) {
        const onState = () => {
          if (this.context.state === "closed") this.fail(session, new Error("AudioRecorder AudioContext closed during recording."));
        };
        session.onContextState = onState;
        this.context.addEventListener("statechange", onState);
      }
      this.source.connect(node);
      node.connect(sink);
      sink.connect(this.context.destination);
      const effectiveWhen = Math.max(when, this.context.currentTime);
      session.startFrame = Math.ceil(effectiveWhen * this.context.sampleRate);
      capture.setValueAtTime(1, Math.max(this.context.currentTime, (session.startFrame - 0.5) / this.context.sampleRate));
      const startTime = session.startFrame / this.context.sampleRate;
      const clock = this.follow;
      session.startBeat = boundaryBeat ?? (clock && untracked(() => clock.state.value) === "playing" ? clock.timeline.timeToBeat(startTime) : null);
      this.startsAtStore.value = startTime;
      if (session.length !== undefined) {
        if (typeof session.length !== "number" && session.startBeat === null) {
          throw new DOMException("AudioRecorder length needs a playing clock.", "InvalidStateError");
        }
        if (typeof session.length === "number") this.scheduleEnd(session, 0, Math.max(1, Math.round(session.length * this.context.sampleRate)));
        else this.scheduleEnd(session, clock!.timeline.beatToTime(session.startBeat! + noteBeats(session.length!, this.barBeats(clock!))));
      }
      if (session.pendingStop) this.scheduleEnd(session, session.pendingStop.when ?? this.context.currentTime);
    } catch (error) {
      if (this.active === session) this.fail(session, error);
      throw error;
    }
  }

  /**
   * Ends the current take at `when` (default now) and resolves it, the same take `record()` resolves. On a take with `length` it can only shorten it.
   * Called while the capture graph is still being built, it ends the take as soon as it starts.
   */
  stop(options: { when?: number } = {}): Promise<RecordedAudio> {
    if (this.active?.writeChunk) throw new Error("AudioRecorder streaming take needs stopStream().");
    return this.stopCapture(options) as Promise<RecordedAudio>;
  }

  /** Finish streaming after every accepted chunk has reached the caller's writer. */
  stopStream(options: { when?: number } = {}): Promise<RecordedAudioSpan> {
    if (this.disposed) throw new Error("AudioRecorder is disposed.");
    if (!this.active?.writeChunk) throw new Error("AudioRecorder has no started stream to stop.");
    return this.stopCapture(options) as Promise<RecordedAudioSpan>;
  }

  private endFrame(options: { when?: number }): number {
    const when = options.when ?? this.context.currentTime;
    if (!Number.isFinite(when) || when < 0) throw new RangeError("AudioRecorder time must be finite, non-negative seconds.");
    return Math.ceil(Math.max(when, this.context.currentTime) * this.context.sampleRate);
  }

  /** Writes the capture gate's closing edge for a frame after the take's start. */
  private scheduleEnd(session: Session, when: number, frames?: number): void {
    const frame = frames === undefined ? Math.ceil(Math.max(when, this.context.currentTime) * this.context.sampleRate) : session.startFrame + frames;
    if (frame <= session.startFrame) throw new RangeError("AudioRecorder stop must follow its start time.");
    session.capture!.setValueAtTime(0, (frame - 0.5) / this.context.sampleRate);
  }

  private stopCapture(options: { when?: number }): Promise<RecordedAudio | RecordedAudioSpan> {
    if (this.disposed) throw new Error("AudioRecorder is disposed.");
    const session = this.active;
    if (!session || untracked(() => this.stateStore.value) === "stopping") throw new Error("AudioRecorder has no started take to stop.");
    if (!session.node) {
      if (!session.promise) throw new Error("AudioRecorder has no started take to stop.");
      this.endFrame(options);
      session.pendingStop = options;
      this.stateStore.value = "stopping";
      return session.promise;
    }
    const frame = this.endFrame(options);
    if (frame <= session.startFrame) throw new RangeError("AudioRecorder stop must follow its start time.");
    this.stateStore.value = "stopping";
    if (session.promise) {
      try {
        session.capture!.setValueAtTime(0, (frame - 0.5) / this.context.sampleRate);
      } catch (error) {
        this.fail(session, error);
      }
      return session.promise;
    }
    return new Promise((resolve, reject) => {
      session.resolve = resolve;
      session.reject = reject;
      try {
        session.capture!.setValueAtTime(0, (frame - 0.5) / this.context.sampleRate);
      } catch (error) {
        this.fail(session, error);
      }
    });
  }

  /** Discard the active take. Borrowed input nodes and the AudioContext keep running. */
  cancel(): void {
    if (!this.active) return;
    this.fail(this.active, abortError());
  }

  private receive(session: Session, message: RecorderMessage): void {
    if (this.active !== session) return;
    if (message.type === "begin") {
      if (untracked(() => this.stateStore.value) === "armed") {
        batch(() => {
          this.stateStore.value = "recording";
          this.startsAtStore.value = null;
          this.startedAtStore.value = message.frame / this.context.sampleRate;
        });
      } else if (untracked(() => this.startsAtStore.value) !== null) {
        batch(() => {
          this.startsAtStore.value = null;
          this.startedAtStore.value = message.frame / this.context.sampleRate;
        });
      }
    } else if (message.type === "chunk") {
      if (!session.writeChunk) session.chunks.push({ startFrame: message.startFrame, channels: message.channels });
      else {
        try {
          const size = message.channels[0]?.length ?? 0;
          if (
            !size ||
            message.startFrame !== (session.nextFrame ?? message.startFrame) ||
            message.channels.length !== this.channels ||
            message.channels.some((channel) => channel.length !== size)
          )
            throw new Error(
              `AudioRecorder lost captured frames: expected ${session.nextFrame ?? message.startFrame}, received ${message.startFrame} (${size} frames).`,
            );
          if (session.pendingWrites.size >= 64) throw new Error("AudioRecorder stream writer fell behind.");
          session.nextFrame = message.startFrame + size;
          const pending = Promise.resolve().then(() => session.writeChunk!({ startFrame: message.startFrame, channels: message.channels }));
          session.pendingWrites.add(pending);
          pending.then(
            () => session.pendingWrites.delete(pending),
            (error) => {
              session.pendingWrites.delete(pending);
              if (this.active === session) this.fail(session, error);
            },
          );
        } catch (error) {
          this.fail(session, error);
        }
      }
    } else if (message.type === "gap") {
      this.fail(session, new Error("AudioRecorder render clock skipped more than two seconds."));
    } else if (message.type === "done") {
      try {
        const frameCount = message.endFrame - message.startFrame;
        if (frameCount < 1) throw new Error("AudioRecorder captured no frames.");
        if (session.writeChunk) {
          if (session.nextFrame !== message.endFrame) throw new Error("AudioRecorder lost captured frames.");
          const span: RecordedAudioSpan = Object.freeze({
            channelCount: this.channels,
            sampleRate: this.context.sampleRate,
            startFrame: message.startFrame,
            endFrame: message.endFrame,
            startTime: message.startFrame / this.context.sampleRate,
            endTime: message.endFrame / this.context.sampleRate,
            ...(message.dropouts?.length ? { dropouts: Object.freeze(message.dropouts.map((gap) => Object.freeze(gap))) } : {}),
          });
          Promise.all(session.pendingWrites).then(
            () => {
              if (this.active !== session) return;
              session.resolve?.(span);
              this.release(session);
            },
            (error) => this.fail(session, error),
          );
          return;
        }
        const channels = Array.from({ length: this.channels }, () => new Float32Array(frameCount));
        let cursor = message.startFrame;
        for (const chunk of session.chunks) {
          if (chunk.startFrame !== cursor || chunk.channels.length !== this.channels) throw new Error("AudioRecorder lost captured frames.");
          const size = chunk.channels[0].length;
          if (cursor + size > message.endFrame || chunk.channels.some((channel) => channel.length !== size)) {
            throw new Error("AudioRecorder lost captured frames.");
          }
          for (let index = 0; index < this.channels; index++) channels[index].set(chunk.channels[index], cursor - message.startFrame);
          cursor += size;
        }
        if (cursor !== message.endFrame) throw new Error("AudioRecorder lost captured frames.");
        const take: RecordedAudio = Object.freeze({
          channels: Object.freeze(channels),
          sampleRate: this.context.sampleRate,
          startFrame: message.startFrame,
          endFrame: message.endFrame,
          startTime: message.startFrame / this.context.sampleRate,
          endTime: message.endFrame / this.context.sampleRate,
          startBeat: session.startBeat ?? null,
          ...(message.dropouts?.length ? { dropouts: Object.freeze(message.dropouts.map((gap) => Object.freeze(gap))) } : {}),
        });
        session.resolve?.(take);
        this.release(session);
      } catch (error) {
        this.fail(session, error);
      }
    }
  }

  private release(session: Session): void {
    if (session.onContextState) this.context.removeEventListener("statechange", session.onContextState);
    if (session.node) {
      try {
        this.source.disconnect(session.node);
      } catch {
        // Registration may have failed before this edge was made.
      }
      try {
        session.node.port.postMessage({ type: "dispose" });
      } catch {
        // The context may already have closed; the graph is disconnected below.
      }
      session.node.port.close();
      session.node.disconnect();
    }
    session.sink?.disconnect();
    if (this.active === session) this.active = null;
    if (!this.disposed) {
      batch(() => {
        this.stateStore.value = "idle";
        this.startsAtStore.value = null;
        this.startedAtStore.value = null;
      });
    }
  }

  private fail(session: Session, error: unknown): void {
    if (!this.disposed && !(error instanceof DOMException && error.name === "AbortError")) {
      this.errorStore.value = error instanceof Error ? error.message : String(error);
    }
    session.reject?.(error);
    this.release(session);
  }

  override dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.abortSignal?.removeEventListener("abort", this.onAbort);
    if (this.active) this.fail(this.active, new Error("AudioRecorder is disposed."));
    this.follow?.detach();
    this.source.disconnect();
    batch(() => {
      this.stateStore.value = "disposed";
      this.startsAtStore.value = null;
      this.startedAtStore.value = null;
    });
    super.dispose();
  }
}

/** Copies a take's PCM into a new `AudioBuffer`, ready for `BufferPlayer`, a clip launcher or `decodeAudioData`-style code. */
export function toAudioBuffer(audio: PCMData, context: BaseAudioContext): AudioBuffer {
  const length = audio.channels[0]?.length ?? 0;
  const buffer = context.createBuffer(audio.channels.length, length, audio.sampleRate);
  audio.channels.forEach((channel, index) => buffer.copyToChannel(channel as Float32Array<ArrayBuffer>, index));
  return buffer;
}
