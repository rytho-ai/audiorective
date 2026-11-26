import { resamplePCM } from "@audiorective/core";
import { preservedEntries } from "./project-persistence";
import { sourceXml } from "./internal/source-xml";
import type { WorkspaceSource } from "./runtime";
import { pendingAudioFiles, provideDecodedAudio } from "./internal/decoded-audio";
import type { DecodedAudioFiles } from "./internal/decoded-audio";
import { openDawProject, openDawProjectBlob, saveDawProject, saveDawProjectTo } from "./dawproject";
import { Workspace, type WorkspaceOptions } from "./runtime";
import { registerSongParser } from "./song-parser";
import type { OpenDawProjectResult } from "./dawproject";
import type { Project, ProjectAudio } from "./model";
import type { ProjectVersion } from "./project-edits";

/** `expectedVersion` refuses to save if the Project has moved on, so a file always holds the state the caller checked. */
export type SaveWorkspaceOptions = Readonly<{ expectedVersion?: ProjectVersion }>;

function assertSaveVersion(project: Project, options: SaveWorkspaceOptions): void {
  if (options.expectedVersion !== undefined && project.cells.version.value !== options.expectedVersion)
    throw new Error("Workspace save stopped: the project changed after expectedVersion was read.");
}

/**
 * Read `source`, and when it holds audio the reader does not decode itself (Ogg, MP3, FLAC, AAC, ...) let the browser decode it: each such file goes through
 * `decodeAudioData` and core's `resamplePCM` to the context's rate, as `importAudioFiles` does, and the file is read again so its clips are ordinary PCM clips.
 * A file the browser cannot decode keeps its clips in the file, unplayed, and the warnings name it.
 */
async function readSong(context: AudioContext, source: WorkspaceSource): Promise<OpenDawProjectResult> {
  const first = source instanceof Uint8Array ? openDawProject(source) : await openDawProjectBlob(source);
  const pending = pendingAudioFiles.get(first.project);
  if (!pending) return first;
  const files = new Map<string, ProjectAudio | null>();
  try {
    const queue = [...pending];
    const worker = async () => {
      for (let next = queue.shift(); next; next = queue.shift()) {
        const [path, blob] = next;
        try {
          const buffer = await context.decodeAudioData(await blob.arrayBuffer());
          const audio = {
            sampleRate: buffer.sampleRate,
            channels: Array.from({ length: buffer.numberOfChannels }, (_, index) => new Float32Array(buffer.getChannelData(index))),
          };
          files.set(path, audio.channels[0]?.length ? resamplePCM(audio, context.sampleRate) : null);
        } catch {
          files.set(path, null);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, pending.size) }, worker));
  } catch (error) {
    first.project.dispose();
    throw error;
  }
  first.project.dispose();
  provideDecodedAudio(source, files as DecodedAudioFiles);
  try {
    return source instanceof Uint8Array ? openDawProject(source) : await openDawProjectBlob(source);
  } finally {
    provideDecodedAudio(source, undefined);
  }
}

// `workspace.open` reads files through the codec, which the runtime may not import.
registerSongParser((source, context) => readSong(context, source));

async function start(context: AudioContext, opened: OpenDawProjectResult, options: WorkspaceOptions): Promise<Workspace> {
  try {
    return await Workspace.create(context, opened.project, {
      ...options,
      ownsProject: true,
      warnings: [...opened.warnings, ...(options.warnings ?? [])],
    });
  } catch (error) {
    opened.project.dispose();
    throw error;
  }
}

/**
 * Open a `.dawproject` file, as bytes or as a picked Blob or File, into a Workspace that is ready to play. Use it to load a song from a file; the Workspace owns the Project it read and disposes it.
 * Warnings from the file lead `workspace.cells.warnings`.
 */
export async function openWorkspace(context: AudioContext, source: WorkspaceSource, options: WorkspaceOptions = {}): Promise<Workspace> {
  return start(context, await readSong(context, source), options);
}

/** Whether a Project holds archive entries or audio that are still files on disk, which only a streaming save can write. */
function holdsFileBackedEntries(project: Project): boolean {
  const own = sourceXml.get(project);
  return (
    [...(preservedEntries.get(project)?.values() ?? [])].some((entry) => !(entry instanceof Uint8Array)) ||
    (own?.overlay === true && [...own.entries.values()].some((entry) => !(entry instanceof Uint8Array)))
  );
}

/**
 * Save the song a Workspace is playing as `.dawproject` file bytes, including the plug-in settings as they are now. Use it for a song you will download or store; for a very large song, or to write
 * straight into a picked file, use `saveWorkspaceTo`. File-backed audio is read into the returned bytes, never dropped.
 */
export async function saveWorkspace(workspace: Workspace, options: SaveWorkspaceOptions = {}): Promise<Uint8Array<ArrayBuffer>> {
  const project = await workspace.checkpoint();
  assertSaveVersion(project, options);
  if (project.hasFileBackedAudio || holdsFileBackedEntries(project)) {
    const chunks: Uint8Array[] = [];
    let length = 0;
    await saveDawProjectTo(
      project,
      new WritableStream({
        write: (chunk) => {
          chunks.push(chunk);
          length += chunk.length;
        },
      }),
    );
    const bytes = new Uint8Array(length);
    let at = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, at);
      at += chunk.length;
    }
    return bytes;
  }
  // The archive is a fresh ArrayBuffer, so callers can pass it straight to `new Blob([bytes])`.
  return saveDawProject(project) as Uint8Array<ArrayBuffer>;
}

/** Save the song a Workspace is playing as a `.dawproject` file into a stream (a file you picked, a download) without holding the whole file in memory. Use it for large songs. */
export async function saveWorkspaceTo(
  workspace: Workspace,
  destination: WritableStream<Uint8Array>,
  options: SaveWorkspaceOptions = {},
): Promise<void> {
  let project: Project;
  try {
    project = await workspace.checkpoint();
    assertSaveVersion(project, options);
  } catch (error) {
    await destination.abort(error).catch(() => undefined);
    throw error;
  }
  await saveDawProjectTo(project, destination);
}
