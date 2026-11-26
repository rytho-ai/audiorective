import type { Project, ProjectAudio } from "../model";

/**
 * How `openWorkspace` hands browser-decoded audio to the reader without a public option. A file stored in a format the reader does not decode
 * itself opens as pending media; the runtime decodes every pending file, registers the PCM here for the same input bytes or Blob, and opens the file
 * again, so the second reading builds ordinary PCM clips. A path mapped to `null` is a file the browser could not decode.
 */
export type DecodedAudioFiles = ReadonlyMap<string, ProjectAudio | null>;

const provided = new WeakMap<object, DecodedAudioFiles>();

export const provideDecodedAudio = (source: Uint8Array | Blob, files: DecodedAudioFiles | undefined): void =>
  void (files ? provided.set(source, files) : provided.delete(source));
export const decodedAudioFor = (source: Uint8Array | Blob): DecodedAudioFiles | undefined => provided.get(source);

/** The archive paths of the pending (not yet decoded) audio an opened project holds, one entry per file. */
export const pendingAudioFiles = new WeakMap<Project, ReadonlyMap<string, Blob>>();

/** The file-backed WAVs of an opened project whose PCM a stretched clip needs: `openDawProjectBlob` reads them into memory and opens the archive again. */
export const wavPcmFiles = new WeakMap<Project, ReadonlyMap<string, Blob>>();
