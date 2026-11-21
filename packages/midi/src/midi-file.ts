/** Standard MIDI file decoding into beats (ticks / ppq), adapted from tactus-ui-dev core/midi.ts.
 * Track/channel/pitch pairing uses the reference FIFO policy.
 */
import type { MidiNote, ParsedMidi } from "./midi-data";

const fail = (): never => {
  throw new Error("Invalid MIDI file.");
};
const freeze = <T extends object>(v: T): Readonly<T> => Object.freeze(v);
type RawTempo = { tick: number; usPerQuarter: number };
type RawSignature = { tick: number; numerator: number; denominator: number };
/** Parses a standard MIDI file (type 0 or 1). Notes are in beats and velocity 0..1; the file's own tempo is not applied. Throws `Invalid MIDI file.` on malformed bytes. */
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
  let at = 8 + headerLength,
    endTick = 0;
  for (let track = 0; track < tracks; track++) {
    if (at + 8 > bytes.length || text(at) !== "MTrk") fail();
    const stop = at + 8 + view.getUint32(at + 4);
    if (stop > bytes.length) fail();
    at += 8;
    let tick = 0,
      status = 0;
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
      }
    }
    endTick = Math.max(endTick, tick);
    at = stop;
  }
  tempos.sort((a, b) => a.tick - b.tick);
  signatures.sort((a, b) => a.tick - b.tick);
  const map = tempos.filter((t, i) => i === tempos.length - 1 || tempos[i + 1].tick !== t.tick);
  const open = new Map<string, Raw[]>(),
    notes: MidiNote[] = [];
  let id = 0;
  const close = (on: Raw, tick: number) =>
    notes.push(
      freeze({
        id: `note-${id++}`,
        pitch: on.pitch,
        velocity: on.velocity / 127,
        start: on.tick / ppq,
        duration: (tick - on.tick) / ppq,
        channel: on.channel,
      }),
    );
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
  notes.sort((a, b) => a.start - b.start || a.pitch - b.pitch);
  return freeze({
    ppq,
    tempos: freeze(map.map((t) => freeze({ beat: t.tick / ppq, bpm: 60_000_000 / t.usPerQuarter }))),
    signatures: freeze(signatures.map((s) => freeze({ beat: s.tick / ppq, numerator: s.numerator, denominator: s.denominator }))),
    notes: freeze(notes),
    duration: endTick / ppq,
  });
}
