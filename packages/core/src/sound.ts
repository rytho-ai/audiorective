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

/** What a player plays per hit: a note name (the built-in triangle tone), a decoded sample or a sound factory. `Sampler`, `PadBank` pads, sequencer lanes and launcher clips all take it. */
export type Sound = NoteName | AudioBuffer | SoundFactory;

/** Per-hit options shared by `Sampler.trigger`, `Sampler.noteOn` and `PadBank.trigger`. */
export type PlayOptions = Readonly<{
  /** 0..1, scales this voice's level. Default 1. */
  velocity?: number;
  /** Audio-context seconds to start. Default now; a time in the past plays now. */
  when?: number;
  /** Semitones added to the hit's transposition. Default 0. */
  pitch?: number;
  /** Seconds into a buffer where playback starts, like `AudioBufferSourceNode.start`'s offset. Default 0; ignored by factories and tones. */
  offset?: number;
  /** Seconds to play: a buffer's portion length (default to its end), or `hit.duration` for a factory or tone (default held until stop). */
  duration?: number;
}>;

/** One sounding hit, returned by `trigger` and `noteOn`. Freed by the player when it ends. */
export interface Voice {
  /** MIDI note it plays, or null when made by `trigger`. */
  readonly note: number | null;
  /** Audio-context seconds it starts. */
  readonly when: number;
  /** True from `when` until it has ended (stopped, stolen, choked, or ran out); false while it is still scheduled. */
  readonly playing: ReadonlyCell<boolean>;
  /** Fades out over the player's `release` from `when` (default now), then ends. Stopping a voice that has not started yet drops it silently. Idempotent. */
  stop(when?: number): void;
}

const SOUND_ERROR = 'Sound needs a note name like "C4", an AudioBuffer or a sound factory function.';
const TONE_NOTE = /^([A-G])([#b]?)(-?\d+)$/;
const SEMITONES: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** Frequency in Hz of a note name (A4 = 440), or undefined when `text` is not a note name. */
function noteHz(text: string): number | undefined {
  const match = TONE_NOTE.exec(text);
  if (!match) return undefined;
  const midi = 12 * (Number(match[3]) + 1) + SEMITONES[match[1]!]! + (match[2] === "#" ? 1 : match[2] === "b" ? -1 : 0);
  return 440 * Math.pow(2, (midi - 69) / 12);
}

/** Throws unless `sound` is a note name, an AudioBuffer or a function. */
export function assertSound(sound: unknown): asserts sound is Sound {
  if (typeof sound === "function") return;
  if (typeof sound === "string" && noteHz(sound) !== undefined) return;
  if (typeof AudioBuffer !== "undefined" && sound instanceof AudioBuffer) return;
  throw new Error(SOUND_ERROR);
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
  /** Seconds a stopped voice fades out. Default 0.005. A function is read each time the voice is released, so the fade follows a live value. */
  release?: number | (() => number);
  /** MIDI note the voice reports. Default null. */
  note?: number | null;
  /** Hold an open-ended voice for `hit.duration` before fading it. Default true; false leaves `hit.duration` informational and only `stop` ends the voice. */
  hold?: boolean;
  /** Seconds into a buffer where playback starts. Default 0. */
  offset?: number;
  /** Seconds of a buffer to play. Default to its end. */
  span?: number;
  /** Called once when every node of the voice is disconnected, after a release has rung out. */
  onFree?: () => void;
  /** Called once when the voice is over for its callers (`playing` is false for good), including a voice stopped before it started. */
  onEnd?: () => void;
}>;

const isSourceNode = (value: unknown): value is AudioScheduledSourceNode =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as AudioScheduledSourceNode).start === "function" &&
  typeof (value as AudioScheduledSourceNode).stop === "function";

/** Peak gain of a full-velocity tone before the player's velocity: leaves headroom for several voices summing. */
const TONE_PEAK = 0.5;
const TONE_ATTACK = 0.004;
const TONE_MIN_BODY = 0.05;
const TONE_RELEASE = 0.02;

function resolveVoice(
  context: BaseAudioContext,
  sound: Sound,
  hit: SoundHit,
  region: { offset: number; span: number | undefined },
): { output: AudioNode; sources: readonly AudioScheduledSourceNode[]; own: number | undefined; start?: [number, number | undefined] } {
  if (typeof sound === "string") {
    const osc = new OscillatorNode(context, { type: "triangle", frequency: noteHz(sound)! * 2 ** (hit.pitch / 12) });
    const env = new GainNode(context);
    osc.connect(env);
    const { when } = hit;
    env.gain.setValueAtTime(0, when);
    env.gain.linearRampToValueAtTime(TONE_PEAK, when + TONE_ATTACK);
    if (!Number.isFinite(hit.duration)) return { output: env, sources: [osc], own: undefined };
    const body = Math.max(hit.duration, TONE_MIN_BODY);
    env.gain.exponentialRampToValueAtTime(Math.max(TONE_PEAK * 0.001, 1e-5), when + body);
    env.gain.setValueAtTime(0, when + body + 1e-4);
    return { output: env, sources: [osc], own: body + TONE_RELEASE };
  }
  if (typeof sound !== "function") {
    const rate = 2 ** (hit.pitch / 12);
    const source = new AudioBufferSourceNode(context, { buffer: sound, playbackRate: rate });
    const left = Math.max(0, sound.duration - region.offset);
    const played = region.span === undefined ? left : Math.min(region.span, left);
    return { output: source, sources: [source], own: played / rate, start: [region.offset, region.span] };
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
  private readonly release: () => number;
  private readonly onFree: (() => void) | undefined;
  private readonly onEnd: (() => void) | undefined;
  private startTimer: ReturnType<typeof setTimeout> | undefined;
  private freed = false;
  private readonly context: BaseAudioContext;
  private readonly limit: number;
  private heldEnd = Infinity;
  private explicit: number | null = null;
  private open = 0;
  private done = false;

  constructor(context: BaseAudioContext, sound: Sound, destination: AudioNode, hit: SoundHit, release: () => number, options: PlaySoundOptions) {
    const hold = options.hold ?? true;
    this.onFree = options.onFree;
    this.onEnd = options.onEnd;
    this.context = context;
    this.note = options.note ?? null;
    this.when = hit.when;
    this.release = release;
    this.velocity = hit.velocity;
    const { output, sources, own, start } = resolveVoice(context, sound, hit, { offset: options.offset ?? 0, span: options.span });
    this.output = output;
    this.sources = sources;
    this.limit = own === undefined ? Infinity : hit.when + own;
    this.gain = new GainNode(context, { gain: hit.velocity });
    output.connect(this.gain);
    this.gain.connect(destination);
    // A voice scheduled ahead is not playing until its start time; a timer aligned to audio time, like PadBank's cleanup timer, flips the cell.
    if (hit.when > context.currentTime) {
      this.state.value = false;
      this.awaitStart();
    }
    this.open = sources.length;
    for (const source of sources) {
      source.addEventListener("ended", () => this.ended(), { once: true });
      if (start && source instanceof AudioBufferSourceNode) source.start(hit.when, start[0], start[1]);
      else source.start(hit.when);
    }
    if (own !== undefined) for (const source of sources) source.stop(hit.when + own);
    else if (hold && Number.isFinite(hit.duration)) {
      this.heldEnd = hit.when + Math.max(0, hit.duration);
      this.fade();
    }
  }

  /** Schedule the release at the earlier of the held end and the explicit stop; a later `stop(when)` replaces an earlier pending one, like `AudioScheduledSourceNode.stop`. */
  private fade(): void {
    const at = Math.min(this.heldEnd, this.explicit ?? Infinity);
    if (!Number.isFinite(at)) return;
    const { gain } = this.gain;
    gain.cancelScheduledValues(0);
    gain.setValueAtTime(this.velocity, at);
    const release = Math.max(0, this.release());
    gain.linearRampToValueAtTime(0, at + release);
    for (const source of this.sources) {
      try {
        source.stop(Math.min(at + release, this.limit));
      } catch {
        // already stopped
      }
    }
  }

  /** Wait for the context clock to reach `when`, then mark the voice playing. */
  private awaitStart(): void {
    const wait = Math.max(1, Math.ceil((this.when - this.context.currentTime) * 1000));
    this.startTimer = setTimeout(() => {
      this.startTimer = undefined;
      if (this.done) return;
      if (this.context.currentTime >= this.when) this.state.value = true;
      else this.awaitStart();
    }, wait);
  }

  stop(when?: number): void {
    if (this.done) return;
    const now = this.context.currentTime;
    if (this.explicit !== null && this.explicit <= now) return;
    const at = Math.max(when ?? now, now);
    this.explicit = at;
    if (at <= this.when) {
      // Not started yet: Web Audio's stop before start, nothing is ever heard.
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
    this.fade();
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
    if (this.startTimer !== undefined) clearTimeout(this.startTimer);
    this.startTimer = undefined;
    this.state.value = false;
    this.onEnd?.();
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
  for (const seconds of [options.offset, options.span])
    if (seconds !== undefined && (!Number.isFinite(seconds) || seconds < 0))
      throw new Error("Sound hit needs finite seconds from 0 for offset and duration.");
  const setting = options.release;
  const release = typeof setting === "function" ? setting : () => setting ?? 0.005;
  const at = Math.max(hit.when, context.currentTime);
  return new PlayedVoice(context, sound, destination, { ...hit, when: at, velocity: Math.min(1, Math.max(0, hit.velocity)) }, release, options);
}
