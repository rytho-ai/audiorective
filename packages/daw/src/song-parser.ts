import type { Project } from "./model";

/** What `workspace.open` needs from the DAWproject codec, which the runtime may not import: the root entry registers it. */
export type SongParser = (
  source: Uint8Array | Blob,
  context: AudioContext,
) =>
  | Promise<
      Readonly<{
        /** Opened project, with browser audio decoded before it is handed to the runtime. */
        project: Project;
        /** File-open and decoding limitations; empty when none were found. */
        warnings: readonly string[];
      }>
    >
  | Readonly<{
      /** Opened project, with browser audio decoded before it is handed to the runtime. */
      project: Project;
      /** File-open and decoding limitations; empty when none were found. */
      warnings: readonly string[];
    }>;

let parser: SongParser | undefined;

export const registerSongParser = (next: SongParser): void => {
  parser = next;
};

export const songParser = (): SongParser | undefined => parser;
