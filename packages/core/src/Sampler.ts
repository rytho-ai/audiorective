import { AudioProcessor } from "./AudioProcessor";
import type { SchedulableParam } from "./SchedulableParam";
import { batch, cell, readonlyCell, untracked, type Cell, type ReadonlyCell } from "./Cell";
import { assertSound, noteNumber, playSound, type NoteName, type PlayOptions, type Sound, type Voice } from "./sound";

export interface SamplerOptions {
  /** What each voice plays. Settable later via `sampler.sound`. */
  sound?: Sound;
  /** MIDI note at which `sound` plays at its natural pitch; `noteOn(n)` transposes by `n - rootNote` semitones. Default 60. */
  rootNote?: number;
  /** Lowest MIDI note `noteOn` plays; lower notes are ignored (it returns null). Default 0. */
  lowNote?: number;
  /** Highest MIDI note `noteOn` plays; higher notes are ignored (it returns null). Default 127. */
  highNote?: number;
  /** Max voices sounding at once. Default 32. */
  polyphony?: number;
  /** At the cap: release the oldest voice and play the new hit, or drop the new hit. Default "oldest". */
  steal?: "oldest" | "none";
  /** Seconds a voice fades out when stopped (`noteOff`, `voice.stop`, steal, `stopAll`). Default 0.005. */
  release?: number;
  /** Start value of `params.volume` (0..1). Default 1. */
  volume?: number;
  /** Aborting the signal calls `dispose()`. */
  signal?: AbortSignal;
}

/**
 * Polyphonic player of one `Sound`: each `trigger` or `noteOn` starts a new voice that layers over the others, up to `polyphony`.
 * Its output is not connected: `sampler.connect(context.destination)`.
 */
export class Sampler extends AudioProcessor<{ volume: SchedulableParam }, { activeVoices: ReadonlyCell<number> }> {
  private readonly _output: GainNode;
  private readonly _active: Cell<number>;
  private readonly _sound: Cell<Sound | null>;
  private readonly _rootNote: number;
  private readonly _lowNote: number;
  private readonly _highNote: number;
  private readonly _polyphony: number;
  private readonly _steal: "oldest" | "none";
  private readonly _release: number;
  private readonly _signal: AbortSignal | undefined;
  private readonly _onAbort = () => this.dispose();
  private _voices: Voice[] = [];
  private _closed = false;

  constructor(context: BaseAudioContext, options: SamplerOptions = {}) {
    const output = new GainNode(context, { gain: options.volume ?? 1 });
    const active = cell(0);
    super(context, ({ param }) => ({
      params: { volume: param({ default: options.volume ?? 1, bind: output.gain, min: 0, max: 1 }) },
      cells: { activeVoices: readonlyCell(active) },
    }));
    if (options.sound !== undefined) assertSound(options.sound);
    this._output = output;
    this._active = active;
    this._sound = cell<Sound | null>(options.sound ?? null);
    this._rootNote = options.rootNote !== undefined ? noteNumber(options.rootNote) : 60;
    this._lowNote = options.lowNote ?? 0;
    this._highNote = options.highNote ?? 127;
    this._polyphony = Math.max(1, options.polyphony ?? 32);
    this._steal = options.steal ?? "oldest";
    this._release = Math.max(0, options.release ?? 0.005);
    this._signal = options.signal;
    if (this._signal) {
      if (this._signal.aborted) this.dispose();
      else this._signal.addEventListener("abort", this._onAbort, { once: true });
    }
  }

  override get output(): GainNode {
    return this._output;
  }

  /** The sound new voices play; applies to the next hit. */
  get sound(): Sound | null {
    return this._sound.value;
  }

  set sound(sound: Sound | null) {
    if (sound !== null) assertSound(sound);
    this._sound.value = sound;
  }

  /** Play the sound once at its natural pitch. Returns the voice, or null if there is no sound or `steal: "none"` dropped it. */
  trigger(options: PlayOptions = {}): Voice | null {
    return this.start(null, options.pitch ?? 0, options);
  }

  /** Start a voice for `note` (MIDI number or name), transposed from `rootNote`. A held note struck again adds a voice. Returns null outside `lowNote`..`highNote`. */
  noteOn(note: number | NoteName, options: PlayOptions = {}): Voice | null {
    const number = noteNumber(note);
    if (number < this._lowNote || number > this._highNote) return null;
    return this.start(number, number - this._rootNote + (options.pitch ?? 0), options);
  }

  /** Release every voice of `note` at `when` (default now) over `release`; other notes keep sounding. */
  noteOff(note: number | NoteName, when?: number): void {
    const number = noteNumber(note);
    for (const voice of [...this._voices]) if (voice.note === number) voice.stop(when);
  }

  /** Release every voice at `when` (default now). */
  stopAll(when?: number): void {
    for (const voice of [...this._voices]) voice.stop(when);
  }

  override dispose(): void {
    if (this._closed) return;
    this._closed = true;
    this._signal?.removeEventListener("abort", this._onAbort);
    for (const voice of [...this._voices]) voice.stop();
    this._output.disconnect();
    super.dispose();
  }

  private start(note: number | null, pitch: number, options: PlayOptions): Voice | null {
    if (this._closed) throw new Error("Sampler is disposed.");
    const sound = untracked(() => this._sound.value);
    if (!sound) return null;
    let victim: Voice | undefined;
    if (this._voices.length >= this._polyphony) {
      if (this._steal === "none") return null;
      victim = this._voices[0];
    }
    const voice = playSound(
      this.context,
      sound,
      this._output,
      { when: options.when ?? this.context.currentTime, velocity: options.velocity ?? 1, pitch, duration: Infinity },
      { release: this._release, note },
    );
    // The new voice joins before the victim leaves and the count is published once afterwards, so a steal never shows a count above the cap.
    batch(() => {
      if (victim) this._voices.shift();
      this._voices.push(voice);
      const off = voice.playing.subscribe((playing) => {
        if (playing) return;
        off();
        const index = this._voices.indexOf(voice);
        if (index !== -1) this._voices.splice(index, 1);
        this._active.value = this._voices.length;
      });
      victim?.stop();
      this._active.value = this._voices.length;
    });
    return voice;
  }
}
