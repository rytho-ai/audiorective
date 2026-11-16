import { AudioProcessor, cell, readonlyCell, untracked, type Cell, type ReadonlyCell } from "@audiorective/core";
import type { PCMData } from "@audiorective/core/peaks";
import { AUDIO_RECORDER_WORKLET, AUDIO_RECORDER_WORKLET_NAME } from "./recording/audio-recorder.worklet";

export type AudioRecorderState = "idle" | "armed" | "recording" | "stopping" | "destroyed";
export interface AudioRecorderOptions {
  /** Captured channel count, with discrete up/down-mixing by Web Audio. Default: 2. */
  channels?: number;
}
export interface RecordedAudio extends PCMData {
  /** Inclusive first captured sample frame on the AudioContext clock. */
  readonly startFrame: number;
  /** Exclusive final captured sample frame on the AudioContext clock. */
  readonly endFrame: number;
  readonly startTime: number;
  readonly endTime: number;
}

type RecorderMessage =
  | { type: "begin"; frame: number }
  | { type: "chunk"; startFrame: number; channels: Float32Array[] }
  | { type: "done"; startFrame: number; endFrame: number };

type Session = {
  startFrame: number;
  node?: AudioWorkletNode;
  capture?: AudioParam;
  sink?: GainNode;
  onContextState?: () => void;
  chunks: Array<{ startFrame: number; channels: Float32Array[] }>;
  resolve?: (take: RecordedAudio) => void;
  reject?: (error: unknown) => void;
};

const modules = new WeakMap<BaseAudioContext, Promise<void>>();
function registerRecorder(context: BaseAudioContext): Promise<void> {
  if (!context.audioWorklet) return Promise.reject(new Error("AudioRecorder requires AudioWorklet support."));
  const existing = modules.get(context);
  if (existing) return existing;
  const url = URL.createObjectURL(new Blob([AUDIO_RECORDER_WORKLET], { type: "application/javascript" }));
  const pending = context.audioWorklet
    .addModule(url)
    .finally(() => URL.revokeObjectURL(url))
    .catch((error: unknown) => {
      modules.delete(context);
      throw error;
    });
  modules.set(context, pending);
  return pending;
}

function abortError(): DOMException {
  return new DOMException("AudioRecorder recording was cancelled.", "AbortError");
}

/** Borrowed input capture; the result retains raw AudioContext frame positions for later track placement. */
export class AudioRecorder extends AudioProcessor<{}, { state: ReadonlyCell<AudioRecorderState>; error: ReadonlyCell<string | null> }> {
  private readonly source: GainNode;
  private readonly stateStore: Cell<AudioRecorderState>;
  private readonly errorStore: Cell<string | null>;
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
    super(context, () => ({ params: {}, cells: { state: readonlyCell(stateStore), error: readonlyCell(errorStore) } }));
    this.source = source;
    this.stateStore = stateStore;
    this.errorStore = errorStore;
    this.channels = channels;
  }

  get input(): GainNode {
    return this.source;
  }
  get output(): undefined {
    return undefined;
  }
  /** Preload the worklet when a gesture or a transport countdown gives time to do so. */
  get ready(): Promise<void> {
    if (this.disposed) return Promise.reject(new Error("AudioRecorder is destroyed."));
    return (this.registration ??= registerRecorder(this.context).catch((error: unknown) => {
      this.registration = null;
      throw error;
    }));
  }

  /** Arms one take at an absolute AudioContext time. Late worklet registration starts at the first available frame. */
  async start(options: { when?: number } = {}): Promise<void> {
    if (this.disposed) throw new Error("AudioRecorder is destroyed.");
    if (this.active) throw new Error("AudioRecorder already has an active take.");
    const when = options.when ?? this.context.currentTime;
    if (!Number.isFinite(when) || when < 0) throw new RangeError("AudioRecorder time must be finite, non-negative seconds.");
    const session: Session = {
      startFrame: Math.ceil(Math.max(when, this.context.currentTime) * this.context.sampleRate),
      chunks: [],
    };
    this.active = session;
    this.errorStore.value = null;
    this.stateStore.value = "armed";
    try {
      await this.ready;
      if (this.active !== session) throw abortError();
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
      capture.setValueAtTime(1, effectiveWhen);
    } catch (error) {
      if (this.active === session) this.fail(session, error);
      throw error;
    }
  }

  /** Schedule the exclusive end of the current take; resolves with PCM and actual frame timing. */
  stop(options: { when?: number } = {}): Promise<RecordedAudio> {
    if (this.disposed) throw new Error("AudioRecorder is destroyed.");
    const session = this.active;
    if (!session?.node || untracked(() => this.stateStore.value) === "stopping") throw new Error("AudioRecorder has no started take to stop.");
    const when = options.when ?? this.context.currentTime;
    if (!Number.isFinite(when) || when < 0) throw new RangeError("AudioRecorder time must be finite, non-negative seconds.");
    const frame = Math.ceil(Math.max(when, this.context.currentTime) * this.context.sampleRate);
    if (frame <= session.startFrame) throw new RangeError("AudioRecorder stop must follow its start time.");
    this.stateStore.value = "stopping";
    return new Promise((resolve, reject) => {
      session.resolve = resolve;
      session.reject = reject;
      try {
        session.capture!.setValueAtTime(0, frame / this.context.sampleRate);
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
      if (untracked(() => this.stateStore.value) === "armed") this.stateStore.value = "recording";
    } else if (message.type === "chunk") {
      session.chunks.push({ startFrame: message.startFrame, channels: message.channels });
    } else if (message.type === "done") {
      try {
        const frameCount = message.endFrame - message.startFrame;
        if (frameCount < 1) throw new Error("AudioRecorder captured no frames.");
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
    if (!this.disposed) this.stateStore.value = "idle";
  }

  private fail(session: Session, error: unknown): void {
    if (!this.disposed && !(error instanceof DOMException && error.name === "AbortError")) {
      this.errorStore.value = error instanceof Error ? error.message : String(error);
    }
    session.reject?.(error);
    this.release(session);
  }

  override destroy(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.active) this.fail(this.active, new Error("AudioRecorder is destroyed."));
    this.source.disconnect();
    this.stateStore.value = "destroyed";
    super.destroy();
  }
}
