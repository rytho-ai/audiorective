import {
  AudioProcessor,
  batch,
  cell,
  readonlyCell,
  registerWorklet,
  untracked,
  type BeatTiming,
  type PCMData,
  type Cell,
  type ReadonlyCell,
} from "@audiorective/core";
import { AUDIO_RECORDER_WORKLET, AUDIO_RECORDER_WORKLET_NAME } from "./recording/audio-recorder.worklet";
export * from "./MicrophoneInput";
export * from "./placement";

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
const RENDER_QUANTUM = 128;
/** Seconds past `now` a queued begin message can still report as the first captured frame. */
const BEGIN_MESSAGE_MARGIN = 0.25;
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
  /** Buffered captures have no chunk writer. */
  onChunk?: never;
  /** Absolute AudioContext seconds the take starts at; a past time starts at the first available frame. Default: now. Not with `quantize`. */
  when?: number;
  /**
   * Start at the next boundary of the attached, playing clock (`"1m"` the next bar line); a call exactly on a boundary starts there, not on the next one.
   * Default `"none"`. `record()` rejects with `InvalidStateError` when the recorder is not attached to a Clock (`clock.attach(recorder)`) or the clock is not playing.
   * During a count-in (negative beats) a quantized start can land inside the count-in; to start at bar 1 pass `when: clock.timeline.beatToTime(0)` instead.
   */
  quantize?: Quantize;
  /** Take length: seconds, or a note value from the start (`"4m"` four bars at the clock's tempo, which needs the clock). Default: until `stop()`. */
  length?: number | NoteLength;
  /** Aborting discards the take and rejects `record()` with `AbortError`, like `cancel()`. */
  signal?: AbortSignal;
}
export interface StreamRecordOptions extends Omit<RecordOptions, "onChunk"> {
  /** Serial writer; up to 4096 frames/chunk and 64 pending chunks. Buffers are borrowed until settled; failure ends capture. */
  onChunk(chunk: RecordedAudioChunk): void | Promise<void>;
}
type CaptureOptions = Omit<RecordOptions, "onChunk"> & { onChunk?: StreamRecordOptions["onChunk"] };

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
  /** Buffered and streamed takes settle one completion created up front. */
  promise: Promise<RecordedAudio | RecordedAudioSpan>;
  /** A `stop()` that arrived while the capture graph was still being built. */
  pendingStop?: { when?: number };
  /** The transport moved after capture began, so `timeToBeat` holds the mapping from before that move. */
  beatMapRetained?: boolean;
  /** A length, as seconds or beats, applied once the start is fixed. */
  length?: number | NoteLength;
  /** Started at a clock boundary: leaving the transport before it arrives cancels the take. */
  quantized?: boolean;
  startBeat?: number | null;
  timeToBeat?: (time: number) => number;
  node?: AudioWorkletNode;
  capture?: AudioParam;
  sink?: GainNode;
  onContextState?: () => void;
  chunks: Array<{ startFrame: number; channels: Float32Array[] }>;
  writeChunk?: (chunk: RecordedAudioChunk) => void | Promise<void>;
  nextFrame?: number;
  writeTail: Promise<void>;
  pendingCount: number;
  failed?: { error: unknown };
  captureEnded?: boolean;
  graphReleased?: boolean;
  resolve: (take: RecordedAudio | RecordedAudioSpan) => void;
  reject: (error: unknown) => void;
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
  private registered = false;

  constructor(context: BaseAudioContext, options: AudioRecorderOptions = {}) {
    const channels = options.channels ?? 2;
    if (!Number.isInteger(channels) || channels < 1 || channels > 32) throw new RangeError("AudioRecorder channels must be an integer from 1 to 32.");
    const source = new GainNode(context, { channelCount: channels, channelCountMode: "explicit", channelInterpretation: "discrete" });
    // A silent pull path keeps everything wired to `input` processed even while no take is armed: sources and automation upstream then run on the
    // audio clock from the start, so a take holds what played at that time and not material that began late. It sends nothing to the destination.
    source.connect(new GainNode(context, { gain: 0 })).connect(context.destination);
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
  /**
   * Clock scheduler contract: leaving the transport (stop, pause, seek, detach) cancels a take whose first frame is still ahead on the audio clock, quantized or `when`.
   * A transport `start` also cancels a quantized take whose first frame is still ahead, because its boundary was computed on the previous transport anchor; a take armed with an
   * explicit `when` survives `start`, so `record({ when }); clock.start(when)` works. A take past its first frame continues until `stop()` or its length, even while its begin notification is queued.
   */
  reset(reason: RecorderResetReason): void {
    const session = this.active;
    if (!session || untracked(() => this.startedAtStore.value) !== null) return;
    const now = this.context.currentTime;
    if (!session.node || Math.ceil(now * this.context.sampleRate) <= session.startFrame) {
      if (reason !== "start" || session.quantized) this.cancel();
      return;
    }
    this.retainBeatMap(session, now);
  }
  /**
   * Capture has begun but its begin message is queued, and reset runs before the transport moves.
   * The first frame is the planned start or a later render-quantum boundary, so sampling those frames keeps its beat exact on a tempo curve.
   */
  private retainBeatMap(session: Session, now: number): void {
    const timeToBeat = session.timeToBeat;
    if (!timeToBeat || session.beatMapRetained) return;
    session.beatMapRetained = true;
    const rate = this.context.sampleRate;
    const firstQuantum = Math.floor(session.startFrame / RENDER_QUANTUM);
    const lastFrame = Math.ceil((now + BEGIN_MESSAGE_MARGIN) * rate);
    const frames = [session.startFrame];
    for (let quantum = firstQuantum + 1; quantum * RENDER_QUANTUM < lastFrame; quantum++) frames.push(quantum * RENDER_QUANTUM);
    frames.push(lastFrame);
    const beats = frames.map((frame) => timeToBeat(frame / rate));
    session.timeToBeat = (time) => {
      const frame = time * rate;
      const index = Math.max(0, Math.min(frames.length - 2, Math.floor(frame / RENDER_QUANTUM) - firstQuantum));
      return beats[index] + ((frame - frames[index]) * (beats[index + 1] - beats[index])) / (frames[index + 1] - frames[index]);
    };
  }
  /** Clock scheduler contract: called by `clock.attach`. */
  attached(handle: RecorderTransport): () => void {
    this.follow = handle;
    return () => {
      if (this.follow === handle) this.follow = null;
    };
  }

  /** The node to connect audio into; the recorder captures what arrives here. */
  get input(): GainNode {
    return this.source;
  }
  /** Always undefined: a recorder is a sink and passes no audio on. */
  get output(): undefined {
    return undefined;
  }
  /** Preload worklet registration; actual live capture begins when `cells.startedAt` becomes non-null after `record()`. */
  get ready(): Promise<void> {
    if (this.disposed) return Promise.reject(new Error("AudioRecorder is disposed."));
    return (this.registration ??= registerRecorder(this.context)
      .then(() => {
        this.registered = true;
      })
      .catch((error: unknown) => {
        this.registration = null;
        throw error;
      }));
  }

  /**
   * While attached to a Clock, the clock stopping, pausing, seeking or detaching cancels a take that is armed but has not started (a `when` or `quantize` start still ahead), rejecting with `AbortError`; a take already recording continues until `stop()` or its `length`.
   * Records one take and resolves with it after it ends, at `length` or at `stop()`. A quantized start waits for the clock's next boundary, and the take
   * reports the actual first captured frame's beat as `startBeat` for buffered PCM, including a late quantized start. With `quantize` (or a note-value `length`) it rejects with `InvalidStateError` when the recorder is not attached to a Clock or, for `quantize`, the clock is not playing. Late worklet registration starts at the first available frame. Call it from a gesture on a running context.
   * Streaming returns a PCM-free span after capture and writes settle; failure/AbortError waits for an in-flight writer before rejecting.
   */
  record(options: StreamRecordOptions): Promise<RecordedAudioSpan>;
  /** Buffered take: resolves with PCM at length or early stop; Clock, signal and startBeat semantics apply. */
  record(options?: RecordOptions): Promise<RecordedAudio>;
  /** A dynamic writer option returns PCM or a span according to the selected mode. */
  record(options: CaptureOptions): Promise<RecordedAudio | RecordedAudioSpan>;
  record(options: CaptureOptions = {}): Promise<RecordedAudio | RecordedAudioSpan> {
    let settle!: Session["resolve"];
    let fail!: Session["reject"];
    const promise = new Promise<RecordedAudio | RecordedAudioSpan>((resolve, reject) => {
      settle = resolve;
      fail = reject;
    });
    // Observe autonomous writer failures even before the caller awaits its take.
    void promise.catch(() => {});
    const quantize = options.quantize ?? "none";
    try {
      if (options.onChunk !== undefined && typeof options.onChunk !== "function") throw new TypeError("AudioRecorder stream needs a chunk writer.");
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
      void this.startCapture({ when: options.when }, options.onChunk, {
        promise,
        settle,
        fail,
        quantize,
        length: options.length,
        signal: options.signal,
      }).catch(fail);
    } catch (error) {
      fail(error);
    }
    return promise;
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
  /** Exactly on a boundary starts there, like the launcher; otherwise the first boundary at least QUANTIZE_LEAD ahead. */
  private quantizedBeat(clock: RecorderTransport, quantize: Exclude<Quantize, "none">): number {
    const size = noteBeats(quantize, this.barBeats(clock));
    const nowBeat = clock.timeline.timeToBeat(this.context.currentTime);
    if (Math.abs(nowBeat / size - Math.round(nowBeat / size)) < EPS) return Math.round(nowBeat / size) * size;
    return Math.ceil(clock.timeline.timeToBeat(this.context.currentTime + QUANTIZE_LEAD) / size - EPS) * size;
  }

  private async startCapture(
    options: { when?: number },
    writeChunk: StreamRecordOptions["onChunk"] | undefined,
    take: {
      promise: Promise<RecordedAudio | RecordedAudioSpan>;
      settle: (take: RecordedAudio | RecordedAudioSpan) => void;
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
      writeTail: Promise.resolve(),
      pendingCount: 0,
      promise: take.promise,
      resolve: take.settle,
      reject: take.fail,
    };
    this.active = session;
    batch(() => {
      this.errorStore.value = null;
      this.stateStore.value = "armed";
    });
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
    try {
      // A Stop during preparation is judged against the boundary requested now, not one a slow preparation moves it to.
      if (take.quantize !== "none") {
        const clock = this.requirePlayingClock("quantize");
        const requested = clock.timeline.beatToTime(this.quantizedBeat(clock, take.quantize));
        session.startFrame = Math.ceil(Math.max(requested, this.context.currentTime) * this.context.sampleRate);
      }
      // A preloaded recorder wires its native graph before the caller resumes an offline render.
      if (!this.registered) await this.ready;
      if (this.active !== session || session.failed) return;
      let when = options.when ?? this.context.currentTime;
      let boundaryBeat: number | null = null;
      if (take.quantize !== "none") {
        const clock = this.requirePlayingClock("quantize");
        boundaryBeat = this.quantizedBeat(clock, take.quantize);
        when = clock.timeline.beatToTime(boundaryBeat);
      }
      if (!Number.isFinite(when) || when < 0) throw new RangeError("AudioRecorder time must be finite, non-negative seconds.");
      // The start frame, beat and length are fixed before the worklet exists: the worklet counts a `length` from its own first captured frame,
      // so a take is exactly `length` frames however late the gate opens or the render thread runs.
      const planned = Math.ceil(Math.max(when, this.context.currentTime) * this.context.sampleRate);
      const plannedTime = planned / this.context.sampleRate;
      const clock = this.follow;
      const startBeat = boundaryBeat ?? (clock && untracked(() => clock.state.value) === "playing" ? clock.timeline.timeToBeat(plannedTime) : null);
      let lengthFrames: number | null = null;
      if (session.length !== undefined) {
        if (typeof session.length === "number") lengthFrames = Math.max(1, Math.round(session.length * this.context.sampleRate));
        else {
          if (startBeat === null) throw new DOMException("AudioRecorder length needs a playing clock.", "InvalidStateError");
          const end = clock!.timeline.beatToTime(startBeat + noteBeats(session.length, this.barBeats(clock!)));
          lengthFrames = Math.round((end - clock!.timeline.beatToTime(startBeat)) * this.context.sampleRate);
          if (lengthFrames < 1) throw new RangeError("AudioRecorder stop must follow its start time.");
        }
      }
      const node = new AudioWorkletNode(this.context, AUDIO_RECORDER_WORKLET_NAME, {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        channelCount: this.channels,
        channelCountMode: "explicit",
        channelInterpretation: "discrete",
        processorOptions: { channels: this.channels, startFrame: planned, length: lengthFrames },
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
      session.startFrame = planned;
      capture.setValueAtTime(1, Math.max(this.context.currentTime, (planned - 0.5) / this.context.sampleRate));
      session.startBeat = startBeat;
      session.timeToBeat = clock && startBeat !== null ? (time) => clock.timeline.timeToBeat(time) : undefined;
      this.startsAtStore.value = plannedTime;
      if (session.pendingStop) {
        // Accepted after the requested start. If the prepared start has overtaken it, no audio can fall before this Stop.
        const now = this.context.currentTime;
        const frame = Math.ceil(Math.max(session.pendingStop.when ?? now, now) * this.context.sampleRate);
        if (frame <= session.startFrame) this.fail(session, abortError());
        else this.scheduleEnd(session, frame);
      }
    } catch (error) {
      if (this.active === session) this.fail(session, error);
    }
  }

  /**
   * Ends the current take early at `when` (default now) and resolves it, the same partial take `record()` resolves with what was captured; `cancel()` instead discards the take and rejects `record()` with `AbortError`.
   * On a take with `length` it can only shorten it.
   * A valid future `when` is retained while the capture graph is being built. Streaming completion drains accepted writes.
   * Uses effective = max(when ?? now, now), rounded up to a sample frame. If it is after the first frame, keeps captured audio even while state is armed and the begin notification is queued.
   * Otherwise an omitted or past/present `when` cancels both promises with AbortError without setting cells.error; a future `when` rejects only Stop with RangeError and preserves the take. While preparing, the requested `when` or quantized boundary is the first frame: a future Stop not after it rejects at once, and a Stop after it that a later prepared start overtakes cancels.
   * The result selector must match the active take, otherwise this rejects with InvalidStateError. All Stop failures reject its Promise.
   */
  stop(options: { result: "span"; when?: number }): Promise<RecordedAudioSpan>;
  /** Buffered take: returns PCM at the clamped audio time; immediate Stop before the first frame cancels with AbortError without setting cells.error. Valid timed stops are retained during preparation. */
  stop(options?: { when?: number; result?: never }): Promise<RecordedAudio>;
  /** A dynamic selector returns the matching mode or rejects with InvalidStateError for a mismatched take. */
  stop(options: { when?: number; result?: "span" }): Promise<RecordedAudio | RecordedAudioSpan>;
  stop(options: { when?: number; result?: "span" } = {}): Promise<RecordedAudio | RecordedAudioSpan> {
    try {
      if (this.disposed) throw new Error("AudioRecorder is disposed.");
      if (this.active && Boolean(this.active.writeChunk) !== (options.result === "span"))
        throw new DOMException("AudioRecorder stop result does not match active take.", "InvalidStateError");
      return this.stopCapture(options);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  /** The closing frame, or null for immediate cancellation before any frame; invalid future intervals reject only the request. */
  private endFrame(session: Session, options: { when?: number }): number | null {
    const now = this.context.currentTime;
    const when = options.when ?? now;
    if (!Number.isFinite(when) || when < 0) throw new RangeError("AudioRecorder time must be finite, non-negative seconds.");
    const frame = Math.ceil(Math.max(when, now) * this.context.sampleRate);
    if (frame > session.startFrame) return frame;
    if (when <= now) return null;
    throw new RangeError("AudioRecorder stop must follow its start time.");
  }

  /** Writes the capture gate's closing edge already validated against the audio clock. */
  private scheduleEnd(session: Session, frame: number): void {
    session.capture!.setValueAtTime(0, (frame - 0.5) / this.context.sampleRate);
  }

  private stopCapture(options: { when?: number }): Promise<RecordedAudio | RecordedAudioSpan> {
    if (this.disposed) throw new Error("AudioRecorder is disposed.");
    const session = this.active;
    if (!session) throw new Error("AudioRecorder has no started take to stop.");
    if (untracked(() => this.stateStore.value) === "stopping") {
      if (session.writeChunk) return session.promise;
      throw new Error("AudioRecorder has no started take to stop.");
    }
    const frame = this.endFrame(session, options);
    if (frame === null) {
      this.fail(session, abortError());
      return session.promise;
    }
    if (!session.node) {
      session.pendingStop = options;
      this.stateStore.value = "stopping";
      return session.promise;
    }
    this.stateStore.value = "stopping";
    try {
      this.scheduleEnd(session, frame);
    } catch (error) {
      this.fail(session, error);
    }
    return session.promise;
  }

  /** Discards the active take and rejects its `record()` with `AbortError` (use `stop()` to end it early and keep what was captured). Borrowed input nodes and the AudioContext keep running. */
  cancel(): void {
    if (!this.active) return;
    this.fail(this.active, abortError());
  }

  private receive(session: Session, message: RecorderMessage): void {
    if (this.active !== session || session.failed || session.captureEnded) return;
    if (message.type === "begin") {
      try {
        session.startBeat = session.timeToBeat?.(message.frame / this.context.sampleRate) ?? null;
      } catch (error) {
        this.fail(session, error);
        return;
      }
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
          if (session.pendingCount >= 64) throw new Error("AudioRecorder stream writer fell behind.");
          session.nextFrame = message.startFrame + size;
          session.pendingCount++;
          session.writeTail = session.writeTail
            .then(() => {
              if (!session.failed) return session.writeChunk!({ startFrame: message.startFrame, channels: message.channels });
            })
            .then(
              () => {
                session.pendingCount--;
              },
              (error) => {
                session.pendingCount--;
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
      session.captureEnded = true;
      if (session.writeChunk) this.stateStore.value = "stopping";
      this.disconnectCapture(session);
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
          session.writeTail.then(
            () => {
              if (this.active !== session || session.failed) return;
              this.release(session);
              session.resolve(span);
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
        session.resolve(take);
        this.release(session);
      } catch (error) {
        this.fail(session, error);
      }
    }
  }

  private disconnectCapture(session: Session): void {
    if (session.graphReleased) return;
    session.graphReleased = true;
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
      session.node.port.onmessage = null;
      session.node.onprocessorerror = null;
      session.node.port.close();
      session.node.disconnect();
    }
    session.sink?.disconnect();
  }

  private release(session: Session): void {
    this.disconnectCapture(session);
    session.chunks.length = 0;
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
    if (this.active !== session || session.failed) return;
    // First failure wins, including its original identity. Stop audio now, but do not
    // release the owner or settle completion while the caller still holds borrowed PCM.
    session.failed = { error };
    this.disconnectCapture(session);
    if (!this.disposed)
      batch(() => {
        if (session.pendingCount > 0) this.stateStore.value = "stopping";
        if (!(error instanceof DOMException && error.name === "AbortError"))
          this.errorStore.value = error instanceof Error ? error.message : String(error);
      });
    const reject = () => {
      this.release(session);
      session.reject(error);
    };
    // Preserve immediate buffered cancellation/reuse. Only borrowed writer chunks
    // require asynchronous draining before the owner can be released.
    if (session.pendingCount === 0) reject();
    else void session.writeTail.then(reject);
  }

  /** Rejects an active take with an error, detaches from the clock and sets `cells.state` to `"disposed"`; safe to call twice. */
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
