import { AudioProcessor, cell, readonlyCell, type Cell, type ReadonlyCell } from "@audiorective/core";

export type MicrophoneState = "live" | "ended";
export interface MicrophoneOptions {
  /** The `audio` member of the `getUserMedia` constraints: `true`, or `MediaTrackConstraints` such as `{ deviceId, echoCancellation: false }`. Default: `true`. */
  audio?: boolean | MediaTrackConstraints;
  /** Aborting before the stream arrives rejects `open` with the signal's reason; aborting afterwards calls `dispose()`. */
  signal?: AbortSignal;
}

/**
 * A microphone as an audio source: `await MicrophoneInput.open(context)` asks for permission and resolves with a live input whose `output`
 * connects like any node (`mic.connect(recorder)`). `dispose()` stops every track and releases the device.
 */
export class MicrophoneInput extends AudioProcessor<{}, { state: ReadonlyCell<MicrophoneState>; monitoring: Cell<boolean> }> {
  /** The `MediaStream` from `getUserMedia`, for track settings or constraints. */
  readonly stream: MediaStream;
  private readonly source: MediaStreamAudioSourceNode;
  private readonly monitor: GainNode;
  private readonly stateStore: Cell<MicrophoneState>;
  private readonly abortSignal?: AbortSignal;
  private readonly onAbort = () => this.dispose();
  private readonly onTrackEnded = () => {
    if (this.stream.getAudioTracks().every((track) => track.readyState === "ended")) this.stateStore.value = "ended";
  };

  /**
   * Asks for microphone access and resolves with the live input. Rejects with the `DOMException` `getUserMedia` raises, unchanged: `NotAllowedError`
   * (permission denied), `NotFoundError` (no device), `NotReadableError` (device busy), `OverconstrainedError`, `SecurityError`. Call it from a click.
   */
  static async open(context: AudioContext, options: MicrophoneOptions = {}): Promise<MicrophoneInput> {
    const { audio = true, signal } = options;
    signal?.throwIfAborted();
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new DOMException("MicrophoneInput needs navigator.mediaDevices.getUserMedia (a secure context).", "NotSupportedError");
    }
    const stream = await navigator.mediaDevices.getUserMedia({ audio });
    try {
      signal?.throwIfAborted();
      return new MicrophoneInput(context, stream, signal);
    } catch (error) {
      for (const track of stream.getTracks()) track.stop();
      throw error;
    }
  }

  private constructor(context: AudioContext, stream: MediaStream, signal?: AbortSignal) {
    const source = context.createMediaStreamSource(stream);
    const monitor = new GainNode(context, { gain: 0 });
    const stateStore = cell<MicrophoneState>("live");
    const monitoring = cell(false);
    super(context, () => ({ params: {}, cells: { state: readonlyCell(stateStore), monitoring } }));
    this.stream = stream;
    this.source = source;
    this.monitor = monitor;
    this.stateStore = stateStore;
    source.connect(monitor);
    monitor.connect(context.destination);
    this.effect(() => {
      monitor.gain.value = this.cells.monitoring.value ? 1 : 0;
    });
    for (const track of stream.getAudioTracks()) track.addEventListener("ended", this.onTrackEnded);
    this.abortSignal = signal;
    signal?.addEventListener("abort", this.onAbort, { once: true });
  }

  get output(): AudioNode {
    return this.source;
  }

  override dispose(): void {
    this.abortSignal?.removeEventListener("abort", this.onAbort);
    for (const track of this.stream.getTracks()) {
      track.removeEventListener("ended", this.onTrackEnded);
      track.stop();
    }
    this.stateStore.value = "ended";
    this.source.disconnect();
    this.monitor.disconnect();
    super.dispose();
  }
}
