/** Standard MIDI file decoding into beats (ticks / ppq), adapted from tactus-ui-dev core/midi.ts.
 * Track/channel/pitch pairing uses the reference FIFO policy.
 */
import type { MidiFileEvent, MidiNote, ParsedMidi, ParsedMidiTrack } from "./midi-data";

const fail = (): never => {
  throw new Error("Invalid MIDI file.");
};
const freeze = <T extends object>(v: T): Readonly<T> => Object.freeze(v);
type RawTempo = { tick: number; usPerQuarter: number };
type RawSignature = { tick: number; numerator: number; denominator: number };
/** Meta text as UTF-8, or Latin-1 when the bytes are not valid UTF-8; control characters are dropped. */
function metaText(bytes: Uint8Array): string {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    text = String.fromCharCode(...bytes);
  }
  return [...text]
    .filter((char) => char.charCodeAt(0) > 31 && char.charCodeAt(0) !== 127)
    .join("")
    .trim();
}

/** Parses a standard MIDI file (type 0 or 1). Notes are in beats and velocity 0..1; the file's own tempo is not applied. `tracks` keeps each track's name, notes and non-note channel messages. Throws `Invalid MIDI file.` on malformed bytes. */
export function parseMidi(input: ArrayBuffer | Uint8Array): ParsedMidi {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input),
    view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const text = (at: number) => String.fromCharCode(...bytes.subarray(at, at + 4));
  if (bytes.length < 14 || text(0) !== "MThd") fail();
  const headerLength = view.getUint32(4),
    format = view.getUint16(8),
    tracks = view.getUint16(10),
    ppq = view.getUint16(12);
  if (headerLength < 6 || 8 + headerLength > bytes.length || !tracks || (format === 0 && tracks !== 1)) fail();
  if (format > 1) throw new Error("Only MIDI format 0 and 1 are supported.");
  if (ppq & 0x8000) throw new Error("SMPTE MIDI time division is not supported.");
  if (!ppq) fail();
  const tempos: RawTempo[] = [],
    signatures: RawSignature[] = [];
  type Raw = { tick: number; on: boolean; pitch: number; velocity: number; channel: number; track: number };
  const raws: Raw[] = [];
  const trackInfo: { name?: string; events: { tick: number; data: Uint8Array }[]; endTick: number }[] = [];
  let at = 8 + headerLength,
    endTick = 0;
  for (let track = 0; track < tracks; track++) {
    if (at + 8 > bytes.length || text(at) !== "MTrk") fail();
    const stop = at + 8 + view.getUint32(at + 4);
    if (stop > bytes.length) fail();
    at += 8;
    let tick = 0,
      status = 0;
    const info: (typeof trackInfo)[number] = { events: [], endTick: 0 };
    trackInfo.push(info);
    const byte = () => {
      if (at >= stop) fail();
      return bytes[at++];
    };
    const vlq = () => {
      let n = 0;
      for (let i = 0; i < 4; i++) {
        const b = byte();
        n = n * 128 + (b & 127);
        if (!(b & 128)) return n;
      }
      return fail();
    };
    while (at < stop) {
      tick += vlq();
      if (!Number.isSafeInteger(tick)) fail();
      let event = bytes[at];
      if (event === undefined || at >= stop) fail();
      if (event & 128) {
        at++;
        if (event < 0xf0) status = event;
      } else {
        if (!status) fail();
        event = status;
      }
      if (event === 0xff) {
        const type = byte(),
          length = vlq();
        if (at + length > stop) fail();
        if (type === 0x51) {
          if (length !== 3) fail();
          const us = bytes[at] * 65536 + bytes[at + 1] * 256 + bytes[at + 2];
          if (!us) fail();
          tempos.push({ tick, usPerQuarter: us });
        }
        if (type === 0x03 && info.name === undefined) info.name = metaText(bytes.subarray(at, at + length));
        if (type === 0x58) {
          if (length < 2 || !bytes[at] || bytes[at + 1] > 7) fail();
          signatures.push({ tick, numerator: bytes[at], denominator: 2 ** bytes[at + 1] });
        }
        at += length;
        if (type === 0x2f) {
          if (length !== 0) fail();
          at = stop;
          break;
        }
      } else if (event === 0xf0 || event === 0xf7) {
        const length = vlq();
        if (at + length > stop) fail();
        at += length;
      } else if (event >= 0xf0) fail();
      else {
        const kind = event & 0xf0,
          channel = event & 15,
          size = kind === 0xc0 || kind === 0xd0 ? 1 : 2;
        const a = byte(),
          b = size === 2 ? byte() : 0;
        if (a > 127 || b > 127) fail();
        if (kind === 0x80 || kind === 0x90) raws.push({ tick, on: kind === 0x90 && b > 0, pitch: a, velocity: b, channel, track });
        else info.events.push({ tick, data: new Uint8Array(size === 2 ? [event, a, b] : [event, a]) });
      }
    }
    info.endTick = tick;
    endTick = Math.max(endTick, tick);
    at = stop;
  }
  tempos.sort((a, b) => a.tick - b.tick);
  signatures.sort((a, b) => a.tick - b.tick);
  const meters = signatures.filter((t, i) => i === signatures.length - 1 || signatures[i + 1].tick !== t.tick);
  const map = tempos.filter((t, i) => i === tempos.length - 1 || tempos[i + 1].tick !== t.tick);
  const open = new Map<string, Raw[]>(),
    notes: MidiNote[] = [];
  let id = 0;
  const byTrack = trackInfo.map(() => [] as MidiNote[]);
  const close = (on: Raw, tick: number) => {
    const note = freeze({
      id: `note-${id++}`,
      pitch: on.pitch,
      velocity: on.velocity / 127,
      start: on.tick / ppq,
      duration: (tick - on.tick) / ppq,
      channel: on.channel,
    });
    notes.push(note);
    byTrack[on.track].push(note);
  };
  for (const raw of raws.sort((a, b) => a.tick - b.tick)) {
    const key = `${raw.track}/${raw.channel}/${raw.pitch}`;
    if (raw.on) {
      const q = open.get(key) ?? [];
      q.push(raw);
      open.set(key, q);
    } else {
      const on = open.get(key)?.shift();
      if (on) close(on, raw.tick);
    }
  }
  for (const q of open.values()) for (const on of q) close(on, endTick);
  const bySort = (a: MidiNote, b: MidiNote) => a.start - b.start || a.pitch - b.pitch;
  notes.sort(bySort);
  const parsedTracks: ParsedMidiTrack[] = trackInfo.map((info, index) =>
    freeze({
      index,
      ...(info.name ? { name: info.name } : {}),
      notes: freeze(byTrack[index].sort(bySort)),
      events: freeze(info.events.map((event): MidiFileEvent => freeze({ beat: event.tick / ppq, data: event.data }))),
      end: info.endTick / ppq,
    }),
  );
  return freeze({
    ppq,
    tempos: freeze(map.map((t) => freeze({ beat: t.tick / ppq, bpm: 60_000_000 / t.usPerQuarter }))),
    signatures: freeze(meters.map((s) => freeze({ beat: s.tick / ppq, numerator: s.numerator, denominator: s.denominator }))),
    notes: freeze(notes),
    duration: endTick / ppq,
    tracks: freeze(parsedTracks),
  });
}
