/** What a MIDI track plays into: its first WebCLAP device, or a `Sampler` from `WorkspaceOptions.instruments` adapted to the same calls.
 * Reads: core `Sampler`/`Voice`, midi `Instrument`. Owns no audio routing; the Workspace connects the sampler.
 */
import { untracked, type CancellableEvent, type Sampler, type Voice } from "@audiorective/core";
import type { Instrument } from "@audiorective/midi";

export interface MidiSink extends Instrument {
  /** One MIDI message at audio-context time `when`; the returned event withdraws it when it can. */
  scheduleMidi(data: Uint8Array | readonly number[], when: number): CancellableEvent;
  /** Silence every held note now. */
  allNotesOff(): void;
  /** Resolves once every message sent so far has reached the instrument. */
  messagesHandled(): Promise<void>;
}

type Held = { voice: Voice; note: number; release: number; seq: number };
type NoteOff = { time: number; seq: number; /** Only voices that started at or before this time are released. */ since?: number };
type Pedal = { time: number; seq: number; down: boolean };

/** A note velocity (0 to 1) as the MIDI byte every path sends: 1 to 127, so a note-on never reads as a note-off. */
export const midiVelocityByte = (velocity: number): number => Math.max(1, Math.min(127, Math.round(velocity * 127)));

/** A release far enough ahead to stand for "not released": a voice's pending stop can be moved later but not removed. */
const NEVER = 1e9;
/** Seconds within which two message times are one instant: `start + duration` against the next `start` differs by round-off, which must not decide which came first. */
const SAME_TIME = 1e-9;
const done: CancellableEvent = { cancel() {}, onEnded: (listener) => listener() };

/**
 * Plays MIDI on a `Sampler` the way a device queue would: note-on starts a voice (velocity 0..127 → 0..1), and note-off and CC120/CC123 are releases pending at their
 * time. Each voice is released at the earliest pending release that reaches it; a withdrawn release gives the voice back its next one, and a voice started later still
 * meets the releases already pending.
 *
 * The sustain pedal (CC64, down from value 64) is honoured at its own time: a note-off that falls while the pedal is down releases at the next pedal-up instead
 * (never, until one arrives), and CC120/CC123 release at once whatever the pedal does. The sampler has one pedal for every channel. Everything else is ignored:
 * pitch bend, mod wheel and other controllers, channel and polyphonic pressure, and program change (a sampler plays one sound, at the velocity of the note-on).
 */
export class SamplerSink implements MidiSink {
  private readonly held = new Set<Held>();
  /** Pending note-offs by note: they release that note's voices started by then. */
  private readonly noteOffs = new Map<number, NoteOff[]>();
  /** Call order: a note-off at a voice's start time releases it only when it was sent after the note-on. */
  private seq = 0;
  /** Pending all-notes-off times: they release every voice started before then. */
  private readonly allOffs: NoteOff[] = [];
  /** Sustain pedal moves, in time then call order. */
  private readonly pedals: Pedal[] = [];

  constructor(
    readonly sampler: Sampler,
    private readonly context: BaseAudioContext,
  ) {}

  noteOn(note: number, options: Readonly<{ velocity?: number; when?: number; channel?: number }> = {}): CancellableEvent {
    this.prune();
    // A note plays at the level its MIDI byte gives, whether it came as bytes or as a velocity, so live and offline renders agree.
    const velocity = options.velocity !== undefined && options.velocity > 0 ? midiVelocityByte(options.velocity) / 127 : options.velocity;
    const voice = this.sampler.noteOn(note, { when: options.when, velocity });
    if (!voice) return done;
    const held: Held = { voice, note, release: Infinity, seq: this.seq++ };
    this.held.add(held);
    this.apply(held);
    return {
      // Withdrawn before it starts, the voice is dropped silently; withdrawn while sounding, it is released at `time`.
      cancel: (time) => {
        this.held.delete(held);
        voice.stop(time);
      },
      onEnded: (listener) => {
        const stop = voice.playing.subscribe(
          (playing) => {
            if (playing) return;
            queueMicrotask(() => stop());
            listener();
          },
          { immediate: true },
        );
      },
    };
  }

  noteOff(note: number, when: number = this.context.currentTime, since?: number): CancellableEvent {
    this.prune();
    const times = this.noteOffs.get(note) ?? [];
    this.noteOffs.set(note, times);
    return this.pending(times, when, (held) => held.note === note, since);
  }

  scheduleMidi(data: Uint8Array | readonly number[], when: number): CancellableEvent {
    const status = data[0] & 0xf0;
    if (status === 0x90 && data[2] > 0) return this.noteOn(data[1], { when, velocity: data[2] / 127 });
    if (status === 0x80 || status === 0x90) return this.noteOff(data[1], when);
    if (status === 0xb0 && (data[1] === 120 || data[1] === 123)) {
      this.prune();
      return this.pending(this.allOffs, when, () => true);
    }
    if (status === 0xb0 && data[1] === 64) return this.pedal(when, data[2] >= 64);
    return done;
  }

  allNotesOff(): void {
    this.pedals.length = 0;
    this.sampler.stopAll();
    this.held.clear();
    this.noteOffs.clear();
    this.allOffs.length = 0;
  }

  messagesHandled(): Promise<void> {
    return Promise.resolve();
  }

  /** A pedal move at `when`, kept in time order; the event withdraws it. */
  private pedal(when: number, down: boolean): CancellableEvent {
    this.prune();
    const entry: Pedal = { time: when, seq: this.seq++, down };
    const at = this.pedals.findIndex((other) => other.time > when + SAME_TIME);
    this.pedals.splice(at < 0 ? this.pedals.length : at, 0, entry);
    const reapply = () => {
      for (const held of this.held) this.apply(held);
    };
    reapply();
    let withdrawn = false;
    return {
      cancel: () => {
        if (withdrawn) return;
        withdrawn = true;
        const index = this.pedals.indexOf(entry);
        if (index >= 0) this.pedals.splice(index, 1);
        reapply();
      },
      onEnded: (listener) => listener(),
    };
  }

  /** When a note-off at `off` really releases: at once with the pedal up, else at the next pedal-up after it (`Infinity` until one is scheduled). */
  private effective(off: NoteOff): number {
    let down = false;
    for (const pedal of this.pedals) {
      const before = pedal.time < off.time - SAME_TIME || (pedal.time <= off.time + SAME_TIME && pedal.seq < off.seq);
      if (before) down = pedal.down;
      else if (down && !pedal.down) return pedal.time;
    }
    return down ? Infinity : off.time;
  }

  /** Add a pending release at `when` to `times` and apply it to the voices `reaches`; the event withdraws it. */
  private pending(times: NoteOff[], when: number, reaches: (held: Held) => boolean, since?: number): CancellableEvent {
    const entry: NoteOff = { time: when, seq: this.seq++, since };
    times.push(entry);
    const reapply = () => {
      for (const held of this.held) if (reaches(held)) this.apply(held);
    };
    reapply();
    let withdrawn = false;
    return {
      cancel: () => {
        if (withdrawn) return;
        withdrawn = true;
        const index = times.indexOf(entry);
        if (index >= 0) times.splice(index, 1);
        reapply();
      },
      onEnded: (listener) => listener(),
    };
  }

  /** Move the voice's stop to its earliest pending release. */
  private apply(held: Held): void {
    const start = held.voice.when;
    let release = Infinity;
    for (const off of this.noteOffs.get(held.note) ?? [])
      if (
        !(off.since !== undefined && start > off.since + SAME_TIME) &&
        (off.time > start + SAME_TIME || (off.time >= start - SAME_TIME && off.seq > held.seq))
      )
        release = Math.min(release, this.effective(off));
    for (const off of this.allOffs) if (off.time > start + SAME_TIME) release = Math.min(release, off.time);
    if (release === held.release) return;
    held.release = release;
    held.voice.stop(Number.isFinite(release) ? release : NEVER);
  }

  /** Forget ended voices and releases already past: a voice's stop cannot change once its time has passed. */
  private prune(): void {
    const now = this.context.currentTime;
    for (const held of this.held) if (!untracked(() => held.voice.playing.value)) this.held.delete(held);
    // In place: a pending event withdraws its time from the same array.
    // A note-off the pedal still holds stays until the pedal comes up.
    const drop = (times: NoteOff[], pedalled: boolean) => {
      for (let i = times.length - 1; i >= 0; i--) if ((pedalled ? this.effective(times[i]) : times[i].time) < now) times.splice(i, 1);
    };
    for (const [note, times] of this.noteOffs) {
      drop(times, true);
      if (!times.length) this.noteOffs.delete(note);
    }
    drop(this.allOffs, false);
    // The last move already past still says where the pedal stands.
    if (!this.noteOffs.size) while (this.pedals.length > 1 && this.pedals[1].time < now) this.pedals.shift();
  }
}
