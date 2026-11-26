import type { Project } from "./model";

/** What `workspace.open` needs from the DAWproject codec, which the runtime may not import: the root entry registers it. */
export type SongParser = (
  source: Uint8Array | Blob,
  context: AudioContext,
) => Promise<Readonly<{ project: Project; warnings: readonly string[] }>> | Readonly<{ project: Project; warnings: readonly string[] }>;

let parser: SongParser | undefined;

export const registerSongParser = (next: SongParser): void => {
  parser = next;
};

export const songParser = (): SongParser | undefined => parser;
