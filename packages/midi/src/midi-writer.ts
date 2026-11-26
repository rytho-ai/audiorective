/** Standard MIDI file encoding (format 1) from beats, the counterpart of `parseMidi`. Pure bytes; no DOM, no AudioContext. */
import type { MidiFileEvent, NoteInit } from "./midi-data";

/** One track chunk to write. */
export type MidiWriteTrack = Readonly<{
  /** Written as the track-name meta event. */
  name?: string;
  /** Notes in beats (velocity 0..1). A note shorter than one tick is written one tick long; a note with velocity 0 is skipped. */
  notes?: readonly NoteInit[];
  /** Raw channel messages in beats: note on/off, controllers, pitch bend, program change, pressure. Status 0x80-0xEF with its data bytes, no running status. */
  events?: readonly MidiFileEvent[];
  /** Beats where the track ends (its end-of-track meta event); default the last event. A later value keeps trailing silence. */
  end?: number;
}>;

export type WriteMidiInput = Readonly<{
  /** Ticks per quarter note, integer 1..32767. Default 960. */
  ppq?: number;
  /** Tempo steps from a beat on; one at beat 0 sets the starting tempo (default 120 BPM). */
  tempos?: readonly Readonly<{ beat: number; bpm: number }>[];
  /** Time signatures from a beat on; one at beat 0 sets the first (default 4/4). The denominator is a power of two up to 128. */
  signatures?: readonly Readonly<{ beat: number; numerator: number; denominator: number }>[];
  /** Name of the conductor track (the first chunk, which carries tempo and meter). */
  title?: string;
  tracks: readonly MidiWriteTrack[];
  /** Omit repeated status bytes. Default false. */
  runningStatus?: boolean;
}>;

type Out = { tick: number; rank: number; order: number; bytes: number[] };

const bad = (message: string): never => {
  throw new RangeError(`writeMidi ${message}`);
};

const vlq = (value: number): number[] => {
  const out = [value & 127];
  for (let rest = Math.floor(value / 128); rest > 0; rest = Math.floor(rest / 128)) out.unshift((rest & 127) | 128);
  return out;
};
const u32 = (value: number) => [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255];
const meta = (type: number, data: readonly number[]) => [0xff, type, ...vlq(data.length), ...data];
const utf8 = (text: string) => [...new TextEncoder().encode(text)];

function chunk(events: Out[], endTick: number, name: string | undefined, runningStatus: boolean): number[] {
  events.sort((a, b) => a.tick - b.tick || a.rank - b.rank || a.order - b.order);
  const body: number[] = [];
  if (name) body.push(0, ...meta(0x03, utf8(name)));
  let tick = 0;
  let status = -1;
  for (const event of events) {
    body.push(...vlq(event.tick - tick));
    tick = event.tick;
    const lead = event.bytes[0];
    if (lead < 0xf0 && runningStatus && lead === status) body.push(...event.bytes.slice(1));
    else body.push(...event.bytes);
    status = lead < 0xf0 ? lead : -1;
  }
  body.push(...vlq(Math.max(0, endTick - tick)), ...meta(0x2f, []));
  return [0x4d, 0x54, 0x72, 0x6b, ...u32(body.length), ...body];
}

/**
 * Encodes a Standard MIDI File, format 1: a conductor track (title, tempo steps, time signatures) followed by one chunk per entry of `tracks`.
 * Beats become ticks by rounding at `ppq`. At one tick note-offs come first, then other messages, then note-ons, so a note that ends where the next starts stays two notes.
 * Throws `writeMidi ...` RangeErrors on values a file cannot hold.
 */
export function writeMidi(input: WriteMidiInput): Uint8Array {
  const ppq = input.ppq ?? 960;
  if (!Number.isInteger(ppq) || ppq < 1 || ppq > 32767) bad("ppq must be an integer from 1 to 32767.");
  const tickOf = (beat: number, what: string): number => {
    if (!Number.isFinite(beat) || beat < 0) bad(`${what} needs finite beats >= 0.`);
    return Math.round(beat * ppq);
  };
  const tracks = input.tracks;
  if (tracks.length > 65534) bad("holds at most 65534 tracks.");
  const conductor: Out[] = [];
  let order = 0;
  const steps = new Map<number, number>();
  for (const { beat, bpm } of input.tempos ?? []) {
    if (!Number.isFinite(bpm) || bpm <= 0) bad("tempo needs positive BPM.");
    const us = Math.round(60_000_000 / bpm);
    if (us < 1 || us > 0xffffff) bad("tempo must be between 3.6 and 60000000 BPM.");
    steps.set(tickOf(beat, "tempo"), us);
  }
  if (!steps.has(0)) steps.set(0, 500_000);
  for (const [tick, us] of steps) conductor.push({ tick, rank: 1, order: order++, bytes: meta(0x51, [us >> 16, (us >> 8) & 255, us & 255]) });
  const meters = new Map<number, number[]>();
  for (const { beat, numerator, denominator } of input.signatures ?? []) {
    if (!Number.isInteger(numerator) || numerator < 1 || numerator > 255) bad("time signature needs an integer numerator from 1 to 255.");
    const power = Math.log2(denominator);
    if (!Number.isInteger(power) || power < 0 || power > 7) bad("time signature needs a power-of-two denominator up to 128.");
    meters.set(tickOf(beat, "time signature"), meta(0x58, [numerator, power, 24, 8]));
  }
  if (!meters.has(0)) meters.set(0, meta(0x58, [4, 2, 24, 8]));
  for (const [tick, bytes] of meters) conductor.push({ tick, rank: 1, order: order++, bytes });
  const chunks = [chunk(conductor, 0, input.title, input.runningStatus === true)];

  for (const track of tracks) {
    const events: Out[] = [];
    let at = 0;
    let end = track.end === undefined ? 0 : tickOf(track.end, "track end");
    for (const note of track.notes ?? []) {
      if (!Number.isInteger(note.pitch) || note.pitch < 0 || note.pitch > 127) bad("note pitch must be an integer 0-127.");
      if (!(note.velocity >= 0 && note.velocity <= 1)) bad("note velocity must be 0..1.");
      const channel = note.channel ?? 0;
      if (!Number.isInteger(channel) || channel < 0 || channel > 15) bad("note channel must be an integer 0-15.");
      if (!Number.isFinite(note.duration) || note.duration < 0) bad("notes need finite durations >= 0.");
      if (note.velocity === 0) continue;
      const start = tickOf(note.start, "note");
      const stop = Math.max(start + 1, tickOf(note.start + note.duration, "note"));
      events.push({
        tick: start,
        rank: 2,
        order: at++,
        bytes: [0x90 | channel, note.pitch, Math.max(1, Math.min(127, Math.round(note.velocity * 127)))],
      });
      events.push({ tick: stop, rank: 0, order: at++, bytes: [0x80 | channel, note.pitch, 0] });
    }
    for (const { beat, data } of track.events ?? []) {
      const kind = data[0] & 0xf0;
      const size = kind === 0xc0 || kind === 0xd0 ? 2 : 3;
      if (!(data[0] >= 0x80 && data[0] < 0xf0) || data.length !== size || data[1] > 127 || (size === 3 && data[2] > 127))
        bad("events need one channel message (status 0x80-0xEF) with 7-bit data bytes.");
      const off = kind === 0x80 || (kind === 0x90 && data[2] === 0);
      events.push({ tick: tickOf(beat, "event"), rank: off ? 0 : kind === 0x90 ? 2 : 1, order: at++, bytes: [...data] });
    }
    for (const event of events) end = Math.max(end, event.tick);
    chunks.push(chunk(events, end, track.name, input.runningStatus === true));
  }
  const header = [0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 1, (chunks.length >> 8) & 255, chunks.length & 255, ppq >> 8, ppq & 255];
  const out = new Uint8Array(header.length + chunks.reduce((n, c) => n + c.length, 0));
  out.set(header);
  let offset = header.length;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}
