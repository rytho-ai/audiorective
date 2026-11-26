import { resamplePCM } from "@audiorective/core";
import { keepsFileBackedEntries } from "./dawproject";
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
async function readSong(context: AudioContext, source: Uint8Array | Blob): Promise<OpenDawProjectResult> {
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

/** Open `.dawproject` bytes into a running Workspace. Warnings from the file lead `workspace.warnings`. */
export async function openWorkspace(context: AudioContext, bytes: Uint8Array, options: WorkspaceOptions = {}): Promise<Workspace> {
  return start(context, await readSong(context, bytes), options);
}

/** Open a `.dawproject` Blob or File into a running Workspace. */
export async function openWorkspaceBlob(context: AudioContext, blob: Blob, options: WorkspaceOptions = {}): Promise<Workspace> {
  return start(context, await readSong(context, blob), options);
}

/** Capture the workspace's live state and write it as `.dawproject` bytes. */
export async function saveWorkspace(workspace: Workspace, options: SaveWorkspaceOptions = {}): Promise<Uint8Array<ArrayBuffer>> {
  const project = await workspace.checkpoint();
  assertSaveVersion(project, options);
  if (project.hasFileBackedAudio || keepsFileBackedEntries(project)) {
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

/** Stream the workspace's project to a caller-owned file or other WritableStream. */
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
