const directoryEndSize = 22;
const tailSize = directoryEndSize + 0xffff;
const invalid = () => new Error("Project archive is incomplete or corrupt.");
const view = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const decoder = new TextDecoder("utf-8", { fatal: true });
/** The characters of code page 437 from 0x80, the encoding a name has when general purpose bit 11 is not set. */
const cp437 =
  "\u00c7\u00fc\u00e9\u00e2\u00e4\u00e0\u00e5\u00e7\u00ea\u00eb\u00e8\u00ef\u00ee\u00ec\u00c4\u00c5\u00c9\u00e6\u00c6\u00f4\u00f6\u00f2\u00fb\u00f9\u00ff\u00d6\u00dc\u00a2\u00a3\u00a5\u20a7\u0192" +
  "\u00e1\u00ed\u00f3\u00fa\u00f1\u00d1\u00aa\u00ba\u00bf\u2310\u00ac\u00bd\u00bc\u00a1\u00ab\u00bb\u2591\u2592\u2593\u2502\u2524\u2561\u2562\u2556\u2555\u2563\u2551\u2557\u255d\u255c\u255b\u2510" +
  "\u2514\u2534\u252c\u251c\u2500\u253c\u255e\u255f\u255a\u2554\u2569\u2566\u2560\u2550\u256c\u2567\u2568\u2564\u2565\u2559\u2558\u2552\u2553\u256b\u256a\u2518\u250c\u2588\u2584\u258c\u2590\u2580" +
  "\u03b1\u00df\u0393\u03c0\u03a3\u03c3\u00b5\u03c4\u03a6\u0398\u03a9\u03b4\u221e\u03c6\u03b5\u2229\u2261\u00b1\u2265\u2264\u2320\u2321\u00f7\u2248\u00b0\u2219\u00b7\u221a\u207f\u00b2\u25a0\u00a0";

/** The name fflate, which unpacks the entries, gives the same entry: UTF-8 with bit 11, Latin-1 without. */
function zipReaderName(bytes: Uint8Array, flags: number): string {
  return flags & 0x800 ? new TextDecoder().decode(bytes) : Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");
}

/**
 * An entry name. Bit 11 of the flags says UTF-8; without it the specification says code page 437, but many tools write UTF-8 anyway, so valid UTF-8 is
 * taken as UTF-8 and only bytes that are not valid UTF-8 are read as code page 437.
 */
function decodeName(bytes: Uint8Array, flags: number): string {
  try {
    return decoder.decode(bytes);
  } catch {
    if (flags & 0x800) throw invalid();
    return Array.from(bytes, (byte) => (byte < 0x80 ? String.fromCharCode(byte) : cp437[byte - 0x80])).join("");
  }
}

/** A relative path with no backslash, control or reserved character and no `.` or `..` part: spaces and non-ASCII letters, as DAWs name their audio files, are fine. */
export function safeArchivePath(name: string): boolean {
  if (!name) return false;
  for (let i = 0; i < name.length; i++) {
    const code = name.charCodeAt(i);
    if (code < 32 || code === 127 || '\\:*?"<>|'.includes(name[i])) return false;
  }
  return name.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

/** `nameBytes` is the name as the directory spells it, which is what the local header must repeat. */
type Entry = {
  name: string;
  zipName: string;
  size: number;
  crc: number;
  offset: number;
  compressedSize: number;
  flags: number;
  method: number;
  nameBytes: Uint8Array;
};

function directoryLocation(tail: Uint8Array, length: number) {
  const data = view(tail);
  for (let at = tail.length - directoryEndSize; at >= 0; at--) {
    if (data.getUint32(at, true) !== 0x06054b50 || at + directoryEndSize + data.getUint16(at + 20, true) !== tail.length) continue;
    const start = data.getUint32(at + 16, true);
    const size = data.getUint32(at + 12, true);
    const count = data.getUint16(at + 10, true);
    if (data.getUint32(at + 4, true) || data.getUint16(at + 8, true) !== count || start + size !== length - tail.length + at) throw invalid();
    if (count > 10_000 || size > 16 * 1024 * 1024) throw new Error("Project archive is too large.");
    return { start, size, count };
  }
  throw invalid();
}

function parseDirectory(bytes: Uint8Array, location: ReturnType<typeof directoryLocation>) {
  const data = view(bytes);
  const entries = new Map<string, Entry>();
  const offsets = new Set<number>();
  let at = 0;
  for (let i = 0; i < location.count; i++) {
    if (at + 46 > bytes.length || data.getUint32(at, true) !== 0x02014b50 || data.getUint16(at + 34, true)) throw invalid();
    const flags = data.getUint16(at + 8, true);
    const method = data.getUint16(at + 10, true);
    const crc = data.getUint32(at + 16, true);
    const compressedSize = data.getUint32(at + 20, true);
    const size = data.getUint32(at + 24, true);
    const nameEnd = at + 46 + data.getUint16(at + 28, true);
    const end = nameEnd + data.getUint16(at + 30, true) + data.getUint16(at + 32, true);
    const offset = data.getUint32(at + 42, true);
    if (
      end > bytes.length ||
      offset + 30 + compressedSize > location.start ||
      offsets.has(offset) ||
      flags & 1 ||
      (method !== 0 && method !== 8) ||
      (method === 0 && size !== compressedSize)
    )
      throw invalid();
    const nameBytes = bytes.slice(at + 46, nameEnd);
    const name = decodeName(nameBytes, flags);
    // A folder entry holds nothing: other tools write one for `audio/` and `plugins/`.
    if (name.endsWith("/") && size === 0 && safeArchivePath(name.slice(0, -1))) {
      offsets.add(offset);
      at = end;
      continue;
    }
    if (!safeArchivePath(name) || entries.has(name) || name === "__proto__") throw new Error("Project archive has duplicate or unsafe paths.");
    entries.set(name, { name, zipName: zipReaderName(nameBytes, flags), size, crc, offset, compressedSize, flags, method, nameBytes });
    offsets.add(offset);
    at = end;
  }
  if (at !== bytes.length) throw invalid();
  return entries;
}

function verifyLocalHeader(bytes: Uint8Array, entry: Entry, directoryStart: number): void {
  const data = view(bytes);
  const { nameBytes } = entry;
  if (
    bytes.length !== 30 + nameBytes.length ||
    data.getUint32(0, true) !== 0x04034b50 ||
    data.getUint16(6, true) !== entry.flags ||
    data.getUint16(8, true) !== entry.method ||
    data.getUint16(26, true) !== nameBytes.length ||
    !nameBytes.every((byte, index) => bytes[30 + index] === byte) ||
    entry.offset + bytes.length + data.getUint16(28, true) + entry.compressedSize > directoryStart
  )
    throw invalid();
  // With a data descriptor, the authoritative CRC and sizes are in the directory.
  if (
    !(entry.flags & 8) &&
    (data.getUint32(14, true) !== entry.crc || data.getUint32(18, true) !== entry.compressedSize || data.getUint32(22, true) !== entry.size)
  )
    throw invalid();
}

export function zipDirectory(bytes: Uint8Array) {
  const location = directoryLocation(bytes.subarray(Math.max(0, bytes.length - tailSize)), bytes.length);
  const entries = parseDirectory(bytes.subarray(location.start, location.start + location.size), location);
  for (const entry of entries.values())
    verifyLocalHeader(bytes.subarray(entry.offset, entry.offset + 30 + entry.nameBytes.length), entry, location.start);
  return entries;
}

export async function zipBlobDirectory(blob: Blob) {
  const tail = new Uint8Array(await blob.slice(Math.max(0, blob.size - tailSize)).arrayBuffer());
  const location = directoryLocation(tail, blob.size);
  const entries = parseDirectory(new Uint8Array(await blob.slice(location.start, location.start + location.size).arrayBuffer()), location);
  await Promise.all(
    [...entries.values()].map(async (entry) => {
      const header = new Uint8Array(await blob.slice(entry.offset, entry.offset + 30 + entry.nameBytes.length).arrayBuffer());
      verifyLocalHeader(header, entry, location.start);
    }),
  );
  return entries;
}
