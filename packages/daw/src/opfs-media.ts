import { AudioMediaWriter } from "./media";

/**
 * Browser disk-backed target for long recordings; the returned File is borrowed by clips. `sampleRate` is in Hz (the recorder's context rate) and `channelCount`
 * is the number of channels in each frame written: it must equal the recorder's channel count (mono is 1), because the file stores interleaved 32-bit floats and a
 * different count reads back as the wrong length and channel layout. Needs browser OPFS storage, else it throws.
 */
export async function createOpfsAudioMediaWriter(sampleRate: number, channelCount: number): Promise<AudioMediaWriter> {
  if (typeof navigator === "undefined" || !navigator.storage?.getDirectory) throw new Error("AudioMediaWriter needs browser OPFS storage.");
  const root = await navigator.storage.getDirectory();
  const directory = await root.getDirectoryHandle("audiorective-takes", { create: true });
  const name = `${crypto.randomUUID()}.f32`;
  const handle = await directory.getFileHandle(name, { create: true });
  let writable: FileSystemWritableFileStream;
  try {
    writable = await handle.createWritable();
  } catch (error) {
    await directory.removeEntry(name).catch(() => undefined);
    throw error;
  }
  let finished = false;
  return new AudioMediaWriter(sampleRate, channelCount, {
    write: async (bytes) => {
      await writable.write(bytes as Uint8Array<ArrayBuffer>);
    },
    finish: async () => {
      await writable.close();
      finished = true;
      return handle.getFile();
    },
    abort: async () => {
      if (!finished) await writable.abort().catch(() => undefined);
      await directory.removeEntry(name).catch(() => undefined);
    },
  });
}
