import { AudioProcessor } from "./AudioProcessor";
import type { Param } from "./Param";
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
  /** Start value of `params.release`: seconds of fade-out applied when a voice is released (`noteOff`, `voice.stop`, steal, `stopAll`); changes apply to voices released afterwards. Default 0.005. */
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
export class Sampler extends AudioProcessor<
  { volume: SchedulableParam; release: Param<number>; sustain: Param<boolean> },
  { activeVoices: ReadonlyCell<number>; heldNotes: ReadonlyCell<readonly number[]> }
> {
  private readonly _output: GainNode;
  private readonly _active: Cell<number>;
  private readonly _held: Cell<readonly number[]>;
  private readonly _sound: Cell<Sound | null>;
  private readonly _rootNote: number;
  private readonly _lowNote: number;
  private readonly _highNote: number;
  private readonly _polyphony: number;
  private readonly _steal: "oldest" | "none";
  private readonly _signal: AbortSignal | undefined;
  private readonly _onAbort = () => this.dispose();
  private _voices: Voice[] = [];
  /** Voices a `noteOff` kept sounding because `params.sustain` was on; they release when it turns off. */
  private readonly _sustained = new Set<Voice>();
  /** Voices a `noteOff` already released, so a later `noteOff` does not move their stop. */
  private readonly _released = new WeakSet<Voice>();
  private _closed = false;

  constructor(context: BaseAudioContext, options: SamplerOptions = {}) {
    const output = new GainNode(context, { gain: options.volume ?? 1 });
    const active = cell(0);
    const held = cell<readonly number[]>([]);
    super(context, ({ param }) => ({
      params: {
        volume: param({ default: options.volume ?? 1, bind: output.gain, min: 0, max: 1 }),
        release: param({ default: Math.max(0, options.release ?? 0.005), min: 0 }),
        sustain: param({ default: false }),
      },
      cells: { activeVoices: readonlyCell(active), heldNotes: readonlyCell(held) },
    }));
    if (options.sound !== undefined) assertSound(options.sound);
    this._output = output;
    this._active = active;
    this._held = held;
    this._sound = cell<Sound | null>(options.sound ?? null);
    this._rootNote = options.rootNote !== undefined ? noteNumber(options.rootNote) : 60;
    this._lowNote = options.lowNote ?? 0;
    this._highNote = options.highNote ?? 127;
    this._polyphony = Math.max(1, options.polyphony ?? 32);
    this._steal = options.steal ?? "oldest";
    // Letting the pedal up releases every sustained voice at the current time.
    this.effect(() => {
      if (this.params.sustain.value) return;
      untracked(() => this.releaseSustained());
    });
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

  /** While `params.sustain` is on, `noteOff` keeps the held voices sounding; turning it off releases them (MIDI CC64). */
  private releaseSustained(): void {
    for (const voice of [...this._sustained]) {
      this._sustained.delete(voice);
      this._released.add(voice);
      voice.stop();
    }
  }

  /** Releases the held voices of `note` started by `when` (default now) over `params.release`; other notes keep sounding. With `params.sustain` on, the voices keep sounding until it turns off. */
  noteOff(note: number | NoteName, when?: number): void {
    const number = noteNumber(note);
    const time = when ?? this.context.currentTime;
    const sustain = untracked(() => this.params.sustain.value);
    for (const voice of [...this._voices]) {
      if (voice.note !== number || this._released.has(voice) || this._sustained.has(voice) || voice.when > time) continue;
      if (sustain) this._sustained.add(voice);
      else {
        this._released.add(voice);
        voice.stop(when);
      }
    }
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

  /** Commit the sounding-voice count and held notes together; a voice scheduled ahead counts from its start time. */
  private publish(): void {
    const sounding = this._voices.filter((voice) => untracked(() => voice.started.value && voice.playing.value));
    const notes = [...new Set(sounding.map((voice) => voice.note).filter((note): note is number => note !== null))].sort((a, b) => a - b);
    batch(() => {
      this._active.value = sounding.length;
      const current = untracked(() => this._held.value);
      if (current.length !== notes.length || current.some((note, index) => note !== notes[index])) this._held.value = notes;
    });
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
    const voice: Voice = playSound(
      this.context,
      sound,
      this._output,
      { when: options.when ?? this.context.currentTime, velocity: options.velocity ?? 1, pitch, duration: options.duration ?? Infinity },
      {
        release: () => untracked(() => this.params.release.value),
        note,
        offset: options.offset,
        span: options.duration,
      },
    );
    // The new voice joins before the victim leaves and the counts are published once afterwards, so a steal never shows a count above the cap.
    batch(() => {
      if (victim) this._voices.shift();
      this._voices.push(voice);
      voice.started.subscribe(() => this.publish());
      const off = voice.playing.subscribe((playing) => {
        if (playing) return;
        off();
        const index = this._voices.indexOf(voice);
        if (index !== -1) this._voices.splice(index, 1);
        this._sustained.delete(voice);
        this.publish();
      });
      victim?.stop();
      this.publish();
    });
    return voice;
  }
}
