/** Conventional stored ZIP with CRC/size in each local header. Media can be read twice without buffering it. */
export type StoredZipEntry = Readonly<{
  path: string;
  size: number;
  chunks(): AsyncIterable<Uint8Array>;
}>;

const encoder = new TextEncoder();
const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let value = n;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  crcTable[n] = value >>> 0;
}

function crc32(previous: number, bytes: Uint8Array): number {
  let value = previous;
  for (const byte of bytes) value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8);
  return value >>> 0;
}

function localHeader(name: Uint8Array, crc: number, size: number): Uint8Array {
  const bytes = new Uint8Array(30 + name.length);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x04034b50, true);
  view.setUint16(4, 20, true);
  view.setUint16(10, 0, true); // stored, no data descriptor
  view.setUint16(12, 0x21, true); // 1980-01-01
  view.setUint32(14, crc, true);
  view.setUint32(18, size, true);
  view.setUint32(22, size, true);
  view.setUint16(26, name.length, true);
  bytes.set(name, 30);
  return bytes;
}

function centralHeader(name: Uint8Array, crc: number, size: number, offset: number): Uint8Array {
  const bytes = new Uint8Array(46 + name.length);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x02014b50, true);
  view.setUint16(4, 20, true);
  view.setUint16(6, 20, true);
  view.setUint16(14, 0x21, true);
  view.setUint32(16, crc, true);
  view.setUint32(20, size, true);
  view.setUint32(24, size, true);
  view.setUint16(28, name.length, true);
  view.setUint32(42, offset, true);
  bytes.set(name, 46);
  return bytes;
}

/** Stored entries trade compression for a two-pass, bounded-memory ZIP compatible with readers needing local CRCs. */
export async function writeStoredZip(
  entries: readonly StoredZipEntry[],
  destination: WritableStream<Uint8Array>,
  signal?: AbortSignal,
): Promise<void> {
  const writer = destination.getWriter();
  const names = new Set<string>();
  let offset = 0;
  const central: Uint8Array[] = [];
  const checkAbort = () => {
    if (signal?.aborted) throw new DOMException("Project portable ZIP was cancelled.", "AbortError");
  };
  try {
    if (entries.length > 0xffff) throw new RangeError("Project portable ZIP needs at most 65535 entries.");
    for (const entry of entries) {
      checkAbort();
      const name = encoder.encode(entry.path);
      if (
        !entry.path ||
        entry.path.startsWith("/") ||
        entry.path.split("/").some((part) => part === "." || part === ".." || !part) ||
        entry.path.includes("\\") ||
        names.has(entry.path) ||
        name.length > 0xffff
      )
        throw new Error("Project portable ZIP needs unique safe paths.");
      names.add(entry.path);
      if (!Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > 0xffffffff)
        throw new RangeError("Project portable ZIP entry exceeds 4 GiB.");
      let size = 0;
      let crc = 0xffffffff;
      for await (const chunk of entry.chunks()) {
        checkAbort();
        size += chunk.length;
        if (size > entry.size) throw new Error("Project portable ZIP source size changed.");
        crc = crc32(crc, chunk);
      }
      if (size !== entry.size) throw new Error("Project portable ZIP source size changed.");
      crc = (crc ^ 0xffffffff) >>> 0;
      const header = localHeader(name, crc, size);
      if (offset + header.length + size > 0xffffffff) throw new RangeError("Project portable ZIP exceeds 4 GiB.");
      const fileOffset = offset;
      checkAbort();
      await writer.write(header);
      offset += header.length;
      let written = 0;
      let writtenCrc = 0xffffffff;
      for await (const chunk of entry.chunks()) {
        checkAbort();
        written += chunk.length;
        if (written > size) throw new Error("Project portable ZIP source size changed.");
        writtenCrc = crc32(writtenCrc, chunk);
        await writer.write(chunk);
        offset += chunk.length;
      }
      if (written !== size || (writtenCrc ^ 0xffffffff) >>> 0 !== crc) throw new Error("Project portable ZIP source changed while saving.");
      central.push(centralHeader(name, crc, size, fileOffset));
    }
    const centralStart = offset;
    for (const header of central) {
      checkAbort();
      await writer.write(header);
      offset += header.length;
    }
    const centralSize = offset - centralStart;
    if (offset + 22 > 0xffffffff) throw new RangeError("Project portable ZIP exceeds 4 GiB.");
    const end = new Uint8Array(22);
    const view = new DataView(end.buffer);
    view.setUint32(0, 0x06054b50, true);
    view.setUint16(8, entries.length, true);
    view.setUint16(10, entries.length, true);
    view.setUint32(12, centralSize, true);
    view.setUint32(16, centralStart, true);
    checkAbort();
    await writer.write(end);
    await writer.close();
  } catch (error) {
    await writer.abort(error).catch(() => undefined);
    throw error;
  }
}
