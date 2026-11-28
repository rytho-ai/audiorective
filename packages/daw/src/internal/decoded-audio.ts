import type { Project, ProjectAudio } from "../model";

/**
 * How `openWorkspace` hands browser-decoded audio to the reader without a public option. A file stored in a format the reader does not decode
 * itself opens as pending media; the runtime decodes every pending file, registers the PCM here for the same input bytes or Blob, and opens the file
 * again, so the second reading builds ordinary PCM clips. A path mapped to `null` is a file the browser could not decode.
 */
export type DecodedAudioFiles = ReadonlyMap<string, ProjectAudio | null>;

/**
 * The two readers behind `openDawProject` and `openDawProjectBlob` with the decoded files as an explicit argument, registered by the codec: concurrent
 * opens of one source each read with their own map, so none can see another's audio (a context at another sample rate decodes the same file differently).
 */
export type ArchiveRead = {
  /** Opened project owned by the caller, including preserved content from the archive. */
  project: Project;
  /** Non-fatal file-reading or playback limitations in plain sentences; empty when none were found. */
  warnings: readonly string[];
};
export type ArchiveReaders = {
  /** Synchronously opens archive bytes using the optional per-open decoded-audio map. */
  bytes(bytes: Uint8Array, decoded?: DecodedAudioFiles): ArchiveRead;
  /** Opens a Blob archive using the optional per-open decoded-audio map without retaining the full archive in memory. */
  blob(blob: Blob, decoded?: DecodedAudioFiles): Promise<ArchiveRead>;
};
let readers: ArchiveReaders | undefined;
export const registerArchiveReaders = (next: ArchiveReaders): void => void (readers = next);
export const archiveReaders = (): ArchiveReaders => readers!;

/** The archive paths of the pending (not yet decoded) audio an opened project holds, one entry per file. */
export const pendingAudioFiles = new WeakMap<Project, ReadonlyMap<string, Blob>>();

/**
 * The file-backed WAVs of an opened project whose PCM a stretched clip needs, by the key the second reading finds them under: `openDawProjectBlob` reads
 * each and opens the archive again. A `window` (frames of the file) is the part a stretched clip plays from its original, which stays file-backed; a
 * file without one (a stored render) is read whole.
 */
export const wavPcmFiles = new WeakMap<Project, ReadonlyMap<string, Readonly<{ blob: Blob; window?: Readonly<{ from: number; to: number }> }>>>();
