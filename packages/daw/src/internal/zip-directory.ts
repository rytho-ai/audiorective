const directoryEndSize = 22;
const tailSize = directoryEndSize + 0xffff;
const invalid = () => new Error("Project archive is incomplete or corrupt.");
const view = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const decoder = new TextDecoder("utf-8", { fatal: true });

type Entry = { size: number; crc: number; offset: number; compressedSize: number; flags: number; method: number };

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
    const name = decoder.decode(bytes.subarray(at + 46, nameEnd));
    if (
      !/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(name) ||
      name.split("/").some((part) => part === "." || part === "..") ||
      entries.has(name) ||
      name === "__proto__"
    )
      throw new Error("Project archive has duplicate or unsafe paths.");
    entries.set(name, { size, crc, offset, compressedSize, flags, method });
    offsets.add(offset);
    at = end;
  }
  if (at !== bytes.length) throw invalid();
  return entries;
}

function verifyLocalHeader(bytes: Uint8Array, name: string, entry: Entry, directoryStart: number): void {
  const data = view(bytes);
  if (
    bytes.length !== 30 + name.length ||
    data.getUint32(0, true) !== 0x04034b50 ||
    data.getUint16(6, true) !== entry.flags ||
    data.getUint16(8, true) !== entry.method ||
    data.getUint16(26, true) !== name.length ||
    decoder.decode(bytes.subarray(30)) !== name ||
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
  for (const [name, entry] of entries) {
    verifyLocalHeader(bytes.subarray(entry.offset, entry.offset + 30 + name.length), name, entry, location.start);
  }
  return entries;
}

export async function zipBlobDirectory(blob: Blob) {
  const tail = new Uint8Array(await blob.slice(Math.max(0, blob.size - tailSize)).arrayBuffer());
  const location = directoryLocation(tail, blob.size);
  const entries = parseDirectory(new Uint8Array(await blob.slice(location.start, location.start + location.size).arrayBuffer()), location);
  await Promise.all(
    [...entries].map(async ([name, entry]) => {
      const header = new Uint8Array(await blob.slice(entry.offset, entry.offset + 30 + name.length).arrayBuffer());
      verifyLocalHeader(header, name, entry, location.start);
    }),
  );
  return entries;
}
