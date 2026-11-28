/**
 * midiBytes.ts — builds Standard MIDI File bytes by hand, for tests of the parser and piano-roll views. Pure; nothing in the product imports it.
 *
 * Adapted from tactus-ui-dev core/midiBytes.ts. Reads: nothing
 */
const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const u16 = (n: number) => [(n >> 8) & 255, n & 255];
export const vlq = (n: number) => {
  const out = [n & 0x7f];
  for (n >>= 7; n > 0; n >>= 7) out.unshift((n & 0x7f) | 0x80);
  return out;
};
export const track = (...events: number[][]) => {
  const body = events.flat();
  return [...Array.from("MTrk", (c) => c.charCodeAt(0)), ...u32(body.length), ...body];
};
export const file = (format: number, ppq: number, ...tracks: number[][]) =>
  new Uint8Array([...Array.from("MThd", (c) => c.charCodeAt(0)), ...u32(6), ...u16(format), ...u16(tracks.length), ...u16(ppq), ...tracks.flat()]);
export const tempo = (delta: number, us: number) => [...vlq(delta), 0xff, 0x51, 3, (us >> 16) & 255, (us >> 8) & 255, us & 255];
export const sig = (delta: number, n: number, d: number) => [...vlq(delta), 0xff, 0x58, 4, n, Math.log2(d), 24, 8];
export const on = (delta: number, pitch: number, vel = 100, ch = 0) => [...vlq(delta), 0x90 | ch, pitch, vel];
export const off = (delta: number, pitch: number, ch = 0) => [...vlq(delta), 0x80 | ch, pitch, 0];
export const end = (delta = 0) => [...vlq(delta), 0xff, 0x2f, 0];
