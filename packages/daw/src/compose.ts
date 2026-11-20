import { openDawProject, openDawProjectBlob, saveDawProject, saveDawProjectTo } from "./dawproject";
import { Workspace, type WorkspaceOptions } from "./runtime";
import type { OpenDawProjectResult } from "./dawproject";

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
  return start(context, openDawProject(bytes), options);
}

/** Open a `.dawproject` Blob or File into a running Workspace. */
export async function openWorkspaceBlob(context: AudioContext, blob: Blob, options: WorkspaceOptions = {}): Promise<Workspace> {
  return start(context, await openDawProjectBlob(blob), options);
}

/** Capture the workspace's live state and write it as `.dawproject` bytes. */
export async function saveWorkspace(workspace: Workspace): Promise<Uint8Array> {
  const project = await workspace.checkpoint();
  if (project.hasFileBackedAudio) {
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
  return saveDawProject(project);
}

/** Stream the workspace's project to a caller-owned file or other WritableStream. */
export async function saveWorkspaceTo(workspace: Workspace, destination: WritableStream<Uint8Array>): Promise<void> {
  await saveDawProjectTo(await workspace.checkpoint(), destination);
}
