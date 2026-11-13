/** Standard MIDI note data, adapted from tactus-ui-dev core/midi.ts.
 * Pure seconds-based projection; controllers/program changes are not synthesized.
 * Reads: no runtime dependencies. Track/channel/pitch pairing uses reference FIFO policy.
 */
export type MidiRange = Readonly<{ start: number; end: number }>;
export type MidiNote = Readonly<{ id: string; start: number; end: number; pitch: number; velocity: number; channel: number; track: number }>;
export type MidiTempo = Readonly<{ tick: number; usPerQuarter: number }>;
export type MidiSignature = Readonly<{ tick: number; numerator: number; denominator: number }>;
export type MidiData = Readonly<{ notes: readonly MidiNote[]; duration: number }>;
export type ParsedMidi = MidiData & Readonly<{ ppq: number; tempos: readonly MidiTempo[]; signatures: readonly MidiSignature[]; endTick: number }>;
const fail = (): never => {
  throw new Error("Invalid MIDI file.");
};
const freeze = <T extends object>(v: T): Readonly<T> => Object.freeze(v);
export function tickToSeconds(tempos: readonly MidiTempo[], ppq: number, tick: number): number {
  if (!Number.isInteger(ppq) || ppq <= 0 || !Number.isFinite(tick) || tick < 0)
    throw new RangeError("MIDI ticks need positive PPQ and finite non-negative time.");
  let seconds = 0,
    from = 0,
    us = 500_000;
  for (const t of tempos) {
    if (t.tick >= tick) break;
    seconds += ((t.tick - from) * us) / ppq / 1e6;
    from = t.tick;
    us = t.usPerQuarter;
  }
  return seconds + ((tick - from) * us) / ppq / 1e6;
}
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
  const tempos: MidiTempo[] = [],
    signatures: MidiSignature[] = [];
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
        start: tickToSeconds(map, ppq, on.tick),
        end: tickToSeconds(map, ppq, tick),
        pitch: on.pitch,
        velocity: on.velocity,
        channel: on.channel,
        track: on.track,
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
    tempos: freeze(map.map(freeze)),
    signatures: freeze(signatures.map(freeze)),
    notes: freeze(notes),
    duration: tickToSeconds(map, ppq, endTick),
    endTick,
  });
}
const prefixes = new WeakMap<readonly MidiNote[], number[]>();
/** Inclusive intersection for display. Notes must be sorted by start and immutable. */
export function visibleMidiNotes(
  notes: readonly MidiNote[],
  range: MidiRange,
  pitches?: Readonly<{ low: number; high: number }>,
): readonly MidiNote[] {
  let ends = prefixes.get(notes);
  if (!ends) {
    let end = -Infinity;
    ends = notes.map((n) => (end = Math.max(end, n.end)));
    prefixes.set(notes, ends);
  }
  const first = (past: (i: number) => boolean) => {
    let lo = 0,
      hi = notes.length;
    while (lo < hi) {
      const m = (lo + hi) >>> 1;
      if (past(m)) hi = m;
      else lo = m + 1;
    }
    return lo;
  };
  const start = first((i) => ends![i] >= range.start),
    stop = first((i) => notes[i].start > range.end),
    out: MidiNote[] = [];
  for (let i = start; i < stop; i++) {
    const n = notes[i];
    if (n.end >= range.start && (!pitches || (n.pitch >= pitches.low && n.pitch <= pitches.high))) out.push(n);
  }
  return out;
}
/** Denominator-beat and bar grid, expressed in the same source seconds as notes. */
export function midiGrid(data: ParsedMidi): Readonly<{ beats: readonly number[]; downbeats: readonly number[] }> {
  if (
    !Number.isInteger(data.ppq) ||
    data.ppq <= 0 ||
    !Number.isSafeInteger(data.endTick) ||
    data.endTick < 0 ||
    data.signatures.some(
      (s) =>
        !Number.isInteger(s.tick) ||
        s.tick < 0 ||
        !Number.isInteger(s.numerator) ||
        s.numerator <= 0 ||
        !Number.isFinite(s.denominator) ||
        s.denominator <= 0,
    )
  )
    throw new RangeError("MIDI grid needs valid PPQ, end tick and time signatures.");
  const beats: number[] = [],
    downbeats: number[] = [];
  let tick = 0,
    index = 0,
    within = 0;
  let signature: MidiSignature = { tick: 0, numerator: 4, denominator: 4 };
  while (tick <= data.endTick) {
    if (beats.length >= 100_000) throw new RangeError("MIDI grid exceeds 100000 points.");
    while (index < data.signatures.length && data.signatures[index].tick <= tick) {
      signature = data.signatures[index++];
      within = 0;
    }
    const time = tickToSeconds(data.tempos, data.ppq, tick);
    beats.push(time);
    if (within === 0) downbeats.push(time);
    const next = tick + (data.ppq * 4) / signature.denominator,
      nextChange = data.signatures[index]?.tick;
    if (nextChange !== undefined && nextChange < next) {
      tick = nextChange;
      within = 0;
    } else {
      tick = next;
      within = (within + 1) % signature.numerator;
    }
  }
  return freeze({ beats: freeze(beats), downbeats: freeze(downbeats) });
}
