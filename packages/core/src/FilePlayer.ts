import { AudioProcessor } from "./AudioProcessor";
import type { SchedulableParam } from "./SchedulableParam";
import { batch, cell, readonlyCell, type Cell, type ReadonlyCell } from "./Cell";
import type { Param } from "./Param";

export interface FilePlayerOptions {
  /** Stream URL. Settable later via `.src`. */
  src?: string;
  /** Loop the stream (sets audio.loop). Default false. */
  loop?: boolean;
  /** Output gain (0..1). Default 1. */
  volume?: number;
  /** Playback rate. Default 1. */
  playbackRate?: number;
  /** Element crossOrigin (needed for MediaElementSource on remote URLs). Default "anonymous". */
  crossOrigin?: string | null;
  /** Element preload hint. Default "metadata". */
  preload?: "none" | "metadata" | "auto";
}

/**
 * Streaming sound source — the "track". You operate it: play/pause/seek/stop
 * over a single moving playhead, with reactive isPlaying/currentTime/duration.
 * Backed by an HTMLAudioElement (streams; no full decode) — for music and
 * long-form audio. For polyphonic SFX use Sampler; for an in-memory single playhead, BufferPlayer. Spatial/EQ compose
 * externally via `player.output -> ...`.
 */
export class FilePlayer extends AudioProcessor<
  { volume: SchedulableParam; loop: Param<boolean>; playbackRate: Param<number> },
  {
    isPlaying: ReadonlyCell<boolean>;
    /** The playhead in seconds, updated on the element's `timeupdate` (about 4 Hz) and on seeks: right for a time label, too coarse to animate a playhead; read `position` per frame for that. */
    currentTime: ReadonlyCell<number>;
    duration: ReadonlyCell<number>;
    /** The element's `MediaError` after a load or decode failure, `null` otherwise and again once `src` is set. */
    error: ReadonlyCell<MediaError | null>;
  }
> {
  /**
   * The underlying media element — a deliberate escape hatch for advanced needs
   * (e.g. reading `audio.paused` for synchronous play-state, or native attrs the
   * wrapper doesn't surface). The internal event listeners keep the reactive
   * cells in sync even if a caller drives the element directly.
   */
  readonly audio: HTMLAudioElement;

  private readonly _source: MediaElementAudioSourceNode;
  private readonly _output: GainNode;
  private readonly _disposers: Array<() => void> = [];
  private readonly _endedCbs: Array<() => void> = [];
  private readonly _playing: Cell<boolean>;
  private readonly _time: Cell<number>;
  private readonly _duration: Cell<number>;
  private readonly _error: Cell<MediaError | null>;
  private readonly _srcCell: Cell<string | null> = cell<string | null>(null);

  constructor(ctx: AudioContext, opts: FilePlayerOptions = {}) {
    const audio = new Audio();
    audio.crossOrigin = opts.crossOrigin === undefined ? "anonymous" : opts.crossOrigin;
    audio.preload = opts.preload ?? "metadata";
    audio.loop = opts.loop ?? false;
    audio.playbackRate = opts.playbackRate ?? 1;

    const source = ctx.createMediaElementSource(audio);
    const outputGain = new GainNode(ctx, { gain: opts.volume ?? 1 });
    source.connect(outputGain);

    const playing = cell(false);
    const time = cell(0);
    const duration = cell(NaN);
    const error = cell<MediaError | null>(null);

    super(ctx, ({ param }) => ({
      params: {
        volume: param({ default: opts.volume ?? 1, bind: outputGain.gain, min: 0, max: 1 }),
        loop: param<boolean>({
          default: opts.loop ?? false,
          bind: {
            set: (v) => {
              audio.loop = v;
            },
          },
        }),
        playbackRate: param<number>({
          default: opts.playbackRate ?? 1,
          bind: {
            set: (v) => {
              audio.playbackRate = v;
            },
          },
        }),
      },
      cells: { isPlaying: readonlyCell(playing), currentTime: readonlyCell(time), duration: readonlyCell(duration), error: readonlyCell(error) },
    }));
    this._playing = playing;
    this._time = time;
    this._duration = duration;
    this._error = error;

    this.audio = audio;
    this._source = source;
    this._output = outputGain;

    const on = (type: string, fn: () => void) => {
      audio.addEventListener(type, fn);
      this._disposers.push(() => audio.removeEventListener(type, fn));
    };
    on("play", () => {
      this._playing.value = true;
    });
    on("playing", () => {
      this._playing.value = true;
    });
    on("pause", () => {
      this._playing.value = false;
    });
    on("timeupdate", () => {
      this._time.value = audio.currentTime;
    });
    on("seeking", () => {
      this._time.value = audio.currentTime;
    });
    on("loadedmetadata", () => {
      this._duration.value = audio.duration;
    });
    on("error", () => {
      this._error.value = audio.error;
    });
    on("ended", () => {
      this._playing.value = false;
      for (const cb of [...this._endedCbs]) cb();
    });

    if (opts.src != null) this.src = opts.src;
  }

  /** The playhead in seconds, read live from the element (a plain getter, not tracked): read it per frame to animate; `cells.currentTime` only changes at `timeupdate`. */
  get position(): number {
    return this.audio.currentTime;
  }

  get output(): AudioNode {
    return this._output;
  }

  get src(): string | null {
    return this._srcCell.value;
  }

  set src(url: string | null) {
    batch(() => {
      this._srcCell.value = url;
      this.audio.pause();
      if (url == null) this.audio.removeAttribute("src");
      else this.audio.src = url;
      this.audio.load();
      this._playing.value = false;
      this._time.value = 0;
      this._duration.value = NaN;
      this._error.value = null;
    });
  }

  /** Loop the stream. Reads and writes `params.loop`. */
  get loop(): boolean {
    return this.params.loop.value;
  }

  set loop(v: boolean) {
    this.params.loop.value = v;
  }

  /** Playback rate. Reads and writes `params.playbackRate`. */
  get playbackRate(): number {
    return this.params.playbackRate.value;
  }

  set playbackRate(v: number) {
    this.params.playbackRate.value = v;
  }

  /**
   * Starts playback like `HTMLMediaElement.play()` and rejects with the element's own `DOMException`: `NotAllowedError` when the browser blocks
   * autoplay (play again from a user gesture), `AbortError` when a `src` change or `pause()` interrupts it, `NotSupportedError` with no `src` or an
   * undecodable one. Nothing is swallowed.
   */
  async play(): Promise<void> {
    if (!this.audio.src) throw new DOMException("FilePlayer has no src to play.", "NotSupportedError");
    await this.audio.play();
  }

  pause(): void {
    this.audio.pause();
  }

  seek(t: number): void {
    const d = this.audio.duration;
    const clamped = Math.max(0, Number.isFinite(d) ? Math.min(d, t) : t);
    this.audio.currentTime = clamped;
    this._time.value = this.audio.currentTime;
  }

  stop(): void {
    batch(() => {
      this.audio.pause();
      this.audio.currentTime = 0;
      this._playing.value = false;
      this._time.value = 0;
    });
  }

  /** Run `cb` each time playback reaches the end. Returns a function that removes it. */
  onEnded(cb: () => void): () => void {
    this._endedCbs.push(cb);
    return () => {
      const i = this._endedCbs.indexOf(cb);
      if (i !== -1) this._endedCbs.splice(i, 1);
    };
  }

  override dispose(): void {
    this.audio.pause();
    for (const d of this._disposers.splice(0)) d();
    this._endedCbs.length = 0;
    this._source.disconnect();
    this._output.disconnect();
    this.src = null;
    super.dispose();
  }
}
