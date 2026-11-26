/** Builds Standard MIDI File bytes by hand for the exchange tests. */
const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const u16 = (n: number) => [(n >> 8) & 255, n & 255];
export const vlq = (n: number) => {
  const out = [n & 0x7f];
  for (n >>= 7; n > 0; n >>= 7) out.unshift((n & 0x7f) | 0x80);
  return out;
};
export const smfTrack = (...events: number[][]) => {
  const body = events.flat();
  return [...Array.from("MTrk", (c) => c.charCodeAt(0)), ...u32(body.length), ...body];
};
export const smfFile = (format: number, ppq: number, ...tracks: number[][]) =>
  new Uint8Array([...Array.from("MThd", (c) => c.charCodeAt(0)), ...u32(6), ...u16(format), ...u16(tracks.length), ...u16(ppq), ...tracks.flat()]);
export const trackName = (text: string) => [0, 0xff, 0x03, text.length, ...Array.from(text, (c) => c.charCodeAt(0))];
export const tempoAt = (delta: number, bpm: number) => {
  const us = Math.round(60_000_000 / bpm);
  return [...vlq(delta), 0xff, 0x51, 3, (us >> 16) & 255, (us >> 8) & 255, us & 255];
};
export const signatureAt = (delta: number, n: number, d: number) => [...vlq(delta), 0xff, 0x58, 4, n, Math.log2(d), 24, 8];
export const noteOn = (delta: number, pitch: number, vel = 100, ch = 0) => [...vlq(delta), 0x90 | ch, pitch, vel];
export const noteOff = (delta: number, pitch: number, ch = 0) => [...vlq(delta), 0x80 | ch, pitch, 0];
export const controller = (delta: number, number: number, value: number, ch = 0) => [...vlq(delta), 0xb0 | ch, number, value];
export const pitchBend = (delta: number, lsb: number, msb: number, ch = 0) => [...vlq(delta), 0xe0 | ch, lsb, msb];
export const endOfTrack = (delta = 0) => [...vlq(delta), 0xff, 0x2f, 0];

export const PPQ = 480;
/** Ticks for beats at PPQ 480. */
export const ticks = (beats: number) => Math.round(beats * PPQ);

/**
 * A type 1 file as another DAW writes it: a conductor track (96 BPM, 120 BPM at bar 9, 3/4 from bar 17) and four tracks.
 * Drums on channel 10 (index 9), Bass, Keys with sustain pedal and mod wheel, Strings.
 */
export function songFixture(): Uint8Array {
  return smfFile(
    1,
    PPQ,
    smfTrack(
      trackName("Conductor"),
      signatureAt(0, 4, 4),
      tempoAt(0, 96),
      tempoAt(ticks(32), 120),
      signatureAt(ticks(32), 3, 4),
      endOfTrack(ticks(36)),
    ),
    smfTrack(
      trackName("Drums"),
      noteOn(0, 36, 100, 9),
      noteOff(ticks(0.5), 36, 9),
      noteOn(ticks(0.5), 38, 80, 9),
      noteOff(ticks(0.5), 38, 9),
      endOfTrack(ticks(7)),
    ),
    smfTrack(trackName("Bass"), noteOn(ticks(32), 40, 90), noteOff(ticks(2), 40), endOfTrack(ticks(2))),
    smfTrack(
      trackName("Keys"),
      controller(0, 64, 127, 1),
      controller(ticks(2), 1, 50, 1),
      noteOn(ticks(62), 60, 100, 1),
      noteOff(ticks(3), 60, 1),
      controller(0, 64, 0, 1),
      pitchBend(0, 0, 96, 1),
      endOfTrack(0),
    ),
    smfTrack(trackName("Strings"), noteOn(ticks(66), 72, 70, 2), noteOff(ticks(1), 72, 2), endOfTrack(ticks(0.5))),
  );
}
