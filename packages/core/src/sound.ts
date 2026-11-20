import { cell, readonlyCell, type Cell, type ReadonlyCell } from "./Cell";

/** A note name such as "C4" or "F#3" (C4 is MIDI 60). */
export type NoteName = `${"A" | "B" | "C" | "D" | "E" | "F" | "G"}${"#" | "b" | ""}${number}`;

/** One hit as a sound factory sees it. */
export type SoundHit = Readonly<{
  /** Audio-context seconds the voice starts; never in the past. */
  when: number;
  /** 0..1. The player already scales the voice's level by it after the factory's output; use it only to shape timbre. */
  velocity: number;
  /** Semitones from the sound's natural pitch (note minus `rootNote`, plus any `pitch` option or step pitch). A factory applies it itself; a buffer follows it automatically. */
  pitch: number;
  /** Seconds the hit is held: a step's or clip's length, or Infinity for `trigger` and `noteOn` (held until `noteOff` or `stop`). */
  duration: number;
}>;

/** A voice made of several nodes, returned unconnected and unstarted. */
export type SoundVoice = Readonly<{
  /** The last node of the chain; the player connects it (velocity and release are applied after it). */
  output: AudioNode;
  /** Sources the player starts at `hit.when` and stops when the voice ends; the voice is freed once all have ended. */
  sources: readonly AudioScheduledSourceNode[];
  /** Seconds after `hit.when` at which a one-shot ends by itself, however long the hit is held. Default: the voice is held for `hit.duration`, then faded over `release`. */
  duration?: number;
}>;

/**
 * Builds one voice per hit without connecting or starting it: return a single source node (it is also the output), or `{ output, sources, duration? }` for a chain.
 * Schedule envelopes from `hit.when`; the player does the connecting, starting, holding for `hit.duration`, stopping, release fade and cleanup.
 */
export type SoundFactory = (context: BaseAudioContext, hit: SoundHit) => AudioScheduledSourceNode | SoundVoice;

/** What a player plays per hit: a decoded sample or a sound factory. `Sampler`, `PadBank` pads, sequencer lanes and launcher clips all take it. */
export type Sound = AudioBuffer | SoundFactory;

/** Per-hit options shared by `Sampler.trigger`, `Sampler.noteOn` and `PadBank.trigger`. */
export type PlayOptions = Readonly<{
  /** 0..1, scales this voice's level. Default 1. */
  velocity?: number;
  /** Audio-context seconds to start. Default now; a time in the past plays now. */
  when?: number;
  /** Semitones added to the hit's transposition. Default 0. */
  pitch?: number;
}>;

/** One sounding hit, returned by `trigger` and `noteOn`. Freed by the player when it ends. */
export interface Voice {
  /** MIDI note it plays, or null when made by `trigger`. */
  readonly note: number | null;
  /** Audio-context seconds it starts. */
  readonly when: number;
  /** True until it has ended (stopped, stolen, choked, or ran out). */
  readonly playing: ReadonlyCell<boolean>;
  /** Fades out over the player's `release` from `when` (default now), then ends. Stopping a voice that has not started yet drops it silently. Idempotent. */
  stop(when?: number): void;
}

/** Throws unless `sound` is an AudioBuffer or a function. */
export function assertSound(sound: unknown): asserts sound is Sound {
  if (typeof sound === "function") return;
  if (typeof AudioBuffer !== "undefined" && sound instanceof AudioBuffer) return;
  throw new Error("Sound needs an AudioBuffer or a sound factory function.");
}

const NOTE = /^([A-Ga-g])([#b]?)(-?\d+)$/;
const SEMITONE: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** MIDI number of a note name or number. Throws for anything that is not a MIDI note from 0 to 127. */
export function noteNumber(note: number | NoteName): number {
  let value: number | undefined;
  if (typeof note === "number") value = note;
  else {
    const match = NOTE.exec(String(note));
    if (match) value = 12 * (Number(match[3]) + 1) + SEMITONE[match[1]!.toUpperCase()]! + (match[2] === "#" ? 1 : match[2] === "b" ? -1 : 0);
  }
  if (value === undefined || !Number.isFinite(value) || value < 0 || value > 127) {
    throw new Error('Note needs a MIDI number from 0 to 127 or a note name like "C4".');
  }
  return value;
}

/** What `playSound` takes besides the hit. */
export type PlaySoundOptions = Readonly<{
  /** Seconds a stopped voice fades out. Default 0.005. */
  release?: number;
  /** MIDI note the voice reports. Default null. */
  note?: number | null;
  /** Called once when every node of the voice is disconnected, after a release has rung out. */
  onFree?: () => void;
}>;

const isSourceNode = (value: unknown): value is AudioScheduledSourceNode =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as AudioScheduledSourceNode).start === "function" &&
  typeof (value as AudioScheduledSourceNode).stop === "function";

function resolveVoice(
  context: BaseAudioContext,
  sound: Sound,
  hit: SoundHit,
): { output: AudioNode; sources: readonly AudioScheduledSourceNode[]; own: number | undefined } {
  if (typeof sound !== "function") {
    const rate = 2 ** (hit.pitch / 12);
    const source = new AudioBufferSourceNode(context, { buffer: sound, playbackRate: rate });
    return { output: source, sources: [source], own: sound.duration / rate };
  }
  const made = sound(context, hit) as unknown;
  if (isSourceNode(made)) return { output: made, sources: [made], own: undefined };
  const voice = made as Partial<SoundVoice> | null;
  if (
    voice &&
    typeof voice === "object" &&
    voice.output instanceof AudioNode &&
    Array.isArray(voice.sources) &&
    voice.sources.length > 0 &&
    voice.sources.every(isSourceNode)
  ) {
    if (voice.duration !== undefined && (!Number.isFinite(voice.duration) || voice.duration < 0)) {
      throw new Error("Sound factory duration needs finite seconds from 0.");
    }
    return { output: voice.output, sources: voice.sources, own: voice.duration };
  }
  throw new Error("Sound factory needs to return an AudioScheduledSourceNode or { output, sources } with at least one source.");
}

class PlayedVoice implements Voice {
  readonly note: number | null;
  readonly when: number;
  private readonly state: Cell<boolean> = cell(true);
  readonly playing: ReadonlyCell<boolean> = readonlyCell(this.state);
  private readonly gain: GainNode;
  private readonly output: AudioNode;
  private readonly sources: readonly AudioScheduledSourceNode[];
  private readonly velocity: number;
  private readonly release: number;
  private readonly onFree: (() => void) | undefined;
  private freed = false;
  private readonly context: BaseAudioContext;
  private readonly limit: number;
  private stopAt = Infinity;
  private open = 0;
  private done = false;

  constructor(
    context: BaseAudioContext,
    sound: Sound,
    destination: AudioNode,
    hit: SoundHit,
    release: number,
    note: number | null,
    onFree?: () => void,
  ) {
    this.onFree = onFree;
    this.context = context;
    this.note = note;
    this.when = hit.when;
    this.release = release;
    this.velocity = hit.velocity;
    const { output, sources, own } = resolveVoice(context, sound, hit);
    this.output = output;
    this.sources = sources;
    this.limit = own === undefined ? Infinity : hit.when + own;
    this.gain = new GainNode(context, { gain: hit.velocity });
    output.connect(this.gain);
    this.gain.connect(destination);
    this.open = sources.length;
    for (const source of sources) {
      source.addEventListener("ended", () => this.ended(), { once: true });
      source.start(hit.when);
    }
    if (own !== undefined) for (const source of sources) source.stop(hit.when + own);
    else if (Number.isFinite(hit.duration)) this.fade(hit.when + Math.max(0, hit.duration));
  }

  private fade(at: number): void {
    if (at >= this.stopAt) return;
    this.stopAt = at;
    const { gain } = this.gain;
    gain.cancelScheduledValues(at);
    gain.setValueAtTime(this.velocity, at);
    gain.linearRampToValueAtTime(0, at + this.release);
    for (const source of this.sources) {
      try {
        source.stop(Math.min(at + this.release, this.limit));
      } catch {
        // already stopped
      }
    }
  }

  stop(when?: number): void {
    if (this.done) return;
    const now = this.context.currentTime;
    const at = Math.max(when ?? now, now);
    if (at <= this.when) {
      // Not started yet: Web Audio's stop before start, nothing is ever heard.
      this.stopAt = at;
      for (const source of this.sources) {
        try {
          source.stop(at);
        } catch {
          // already stopped
        }
      }
      this.cleanup();
      this.finish();
      return;
    }
    this.fade(at);
    if (at <= now) this.finish();
  }

  private ended(): void {
    if (--this.open > 0) return;
    this.cleanup();
    this.finish();
  }

  private cleanup(): void {
    this.output.disconnect();
    this.gain.disconnect();
    if (this.freed) return;
    this.freed = true;
    this.onFree?.();
  }

  /** The voice is over for its callers; nodes still ringing out disconnect themselves when their sources end. */
  private finish(): void {
    if (this.done) return;
    this.done = true;
    this.state.value = false;
  }
}

/**
 * Plays one hit of `sound` into `destination`: connects the factory's output behind one velocity gain, starts every source at `hit.when`,
 * holds an open-ended voice for `hit.duration`, fades it over `options.release` when stopped, and frees every node when it ends.
 * This is the voice machinery under `Sampler`, `PadBank`, sequencer lanes and launcher clips.
 */
export function playSound(context: BaseAudioContext, sound: Sound, destination: AudioNode, hit: SoundHit, options: PlaySoundOptions = {}): Voice {
  assertSound(sound);
  if (!Number.isFinite(hit.when)) throw new Error("Sound hit needs a finite time in seconds.");
  if (!Number.isFinite(hit.velocity)) throw new Error("Sound hit needs a velocity from 0 to 1.");
  if (!Number.isFinite(hit.pitch)) throw new Error("Sound hit needs finite semitones for pitch.");
  const release = Math.max(0, options.release ?? 0.005);
  const at = Math.max(hit.when, context.currentTime);
  return new PlayedVoice(
    context,
    sound,
    destination,
    { ...hit, when: at, velocity: Math.min(1, Math.max(0, hit.velocity)) },
    release,
    options.note ?? null,
    options.onFree,
  );
}
