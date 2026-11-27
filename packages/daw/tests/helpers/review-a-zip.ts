import { deflateSync } from "fflate";

const table = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let bit = 0; bit < 8; bit++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  return c >>> 0;
});

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = table[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export type ZipFile = { name: string; data: Uint8Array; method?: 0 | 8; declaredSize?: number };
export type Zip64Mode = "none" | "directory" | "full";

const text = new TextEncoder();

function put(parts: number[][], size: 1 | 2 | 4 | 8, value: number): void {
  const bytes: number[] = [];
  for (let i = 0; i < size; i++) bytes.push(Math.floor(value / 2 ** (8 * i)) % 256);
  parts.push(bytes);
}

/**
 * A ZIP archive written by hand, so a test can choose how it is laid out: `directory` writes zip64 central directory fields and end records,
 * `full` also writes zip64 local headers (as `zip -fz` does). `declaredSize` states a size the data does not have.
 */
export function buildZip(files: ZipFile[], zip64: Zip64Mode = "none"): Uint8Array {
  const out: number[][] = [];
  let length = 0;
  const push = (bytes: number[]) => {
    out.push(bytes);
    length += bytes.length;
  };
  const central: number[][] = [];
  for (const file of files) {
    const method = file.method ?? 8;
    const name = text.encode(file.name);
    const body = method === 8 ? deflateSync(file.data) : file.data;
    const usize = file.declaredSize ?? file.data.length;
    const crc = crc32(file.data);
    const offset = length;
    const header: number[][] = [];
    const extra: number[][] = [];
    if (zip64 === "full") {
      put(extra, 2, 1);
      put(extra, 2, 16);
      put(extra, 8, usize);
      put(extra, 8, body.length);
    }
    const extraBytes = extra.flat();
    put(header, 4, 0x04034b50);
    put(header, 2, zip64 === "none" ? 20 : 45);
    put(header, 2, 0);
    put(header, 2, method);
    put(header, 2, 0);
    put(header, 2, 0x21);
    put(header, 4, crc);
    put(header, 4, zip64 === "full" ? 0xffffffff : body.length);
    put(header, 4, zip64 === "full" ? 0xffffffff : usize);
    put(header, 2, name.length);
    put(header, 2, extraBytes.length);
    push([...header.flat(), ...name, ...extraBytes]);
    push([...body]);

    const entry: number[][] = [];
    const entryExtra: number[][] = [];
    if (zip64 !== "none") {
      put(entryExtra, 2, 1);
      put(entryExtra, 2, 24);
      put(entryExtra, 8, usize);
      put(entryExtra, 8, body.length);
      put(entryExtra, 8, offset);
    }
    const entryExtraBytes = entryExtra.flat();
    put(entry, 4, 0x02014b50);
    put(entry, 2, zip64 === "none" ? 20 : 45);
    put(entry, 2, zip64 === "none" ? 20 : 45);
    put(entry, 2, 0);
    put(entry, 2, method);
    put(entry, 2, 0);
    put(entry, 2, 0x21);
    put(entry, 4, crc);
    put(entry, 4, zip64 === "none" ? body.length : 0xffffffff);
    put(entry, 4, zip64 === "none" ? usize : 0xffffffff);
    put(entry, 2, name.length);
    put(entry, 2, entryExtraBytes.length);
    put(entry, 2, 0);
    put(entry, 2, 0);
    put(entry, 2, 0);
    put(entry, 4, 0);
    put(entry, 4, zip64 === "none" ? offset : 0xffffffff);
    central.push([...entry.flat(), ...name, ...entryExtraBytes]);
  }
  const directoryStart = length;
  for (const entry of central) push(entry);
  const directorySize = length - directoryStart;
  const tail: number[][] = [];
  if (zip64 !== "none") {
    const recordAt = length;
    put(tail, 4, 0x06064b50);
    put(tail, 8, 44);
    put(tail, 2, 45);
    put(tail, 2, 45);
    put(tail, 4, 0);
    put(tail, 4, 0);
    put(tail, 8, files.length);
    put(tail, 8, files.length);
    put(tail, 8, directorySize);
    put(tail, 8, directoryStart);
    put(tail, 4, 0x07064b50);
    put(tail, 4, 0);
    put(tail, 8, recordAt);
    put(tail, 4, 1);
  }
  put(tail, 4, 0x06054b50);
  put(tail, 2, 0);
  put(tail, 2, 0);
  put(tail, 2, zip64 === "none" ? files.length : 0xffff);
  put(tail, 2, zip64 === "none" ? files.length : 0xffff);
  put(tail, 4, zip64 === "none" ? directorySize : 0xffffffff);
  put(tail, 4, zip64 === "none" ? directoryStart : 0xffffffff);
  put(tail, 2, 0);
  push(tail.flat());
  return Uint8Array.from(out.flat());
}
