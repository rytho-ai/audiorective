const FLOAT = new DataView(new ArrayBuffer(8));

function mix(h: number, k: number): number {
  k = Math.imul(k, 0xcc9e2d51);
  k = (k << 15) | (k >>> 17);
  k = Math.imul(k, 0x1b873593);
  h ^= k;
  h = (h << 13) | (h >>> 19);
  return (Math.imul(h, 5) + 0xe6546b64) | 0;
}

function mixPart(h: number, part: number | string): number {
  if (typeof part === "string") {
    h = mix(h, part.length);
    for (let i = 0; i < part.length; i++) h = mix(h, part.charCodeAt(i));
    return mix(h, 0x9e3779b9);
  }
  if (Number.isInteger(part) && Math.abs(part) <= 0x7fffffff) return mix(mix(h, 1), part | 0);
  FLOAT.setFloat64(0, part);
  return mix(mix(mix(h, 2), FLOAT.getInt32(0)), FLOAT.getInt32(4));
}

/**
 * A pure, fast hash of `parts` to a number in [0, 1): the same parts always give the same number and nearby parts give unrelated ones.
 * Numbers (integers or floats, including `NaN` and infinities) and strings are accepted; order matters, and `1` and `"1"` differ.
 * It is a 32-bit MurmurHash3-style mix with a final avalanche, so it has 32 bits of resolution and is not cryptographic.
 * Use it to make randomness a function of an event's position instead of a stateful stream.
 */
export function hash01(...parts: readonly (number | string)[]): number {
  let h = 0x2545f491;
  for (const part of parts) h = mixPart(h, part);
  h ^= parts.length;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 0x100000000;
}
