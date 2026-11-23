import { openDawProject, openDawProjectBlob, saveDawProject, saveDawProjectTo } from "./dawproject";
import { Workspace, type WorkspaceOptions } from "./runtime";
import type { OpenDawProjectResult } from "./dawproject";
import type { Project } from "./model";
import type { ProjectVersion } from "./project-edits";

/** `expectedVersion` refuses to save if the Project has moved on, so a file always holds the state the caller checked. */
export type SaveWorkspaceOptions = Readonly<{ expectedVersion?: ProjectVersion }>;

function assertSaveVersion(project: Project, options: SaveWorkspaceOptions): void {
  if (options.expectedVersion !== undefined && project.cells.version.value !== options.expectedVersion)
    throw new Error("Workspace save stopped: the project changed after expectedVersion was read.");
}

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
export async function saveWorkspace(workspace: Workspace, options: SaveWorkspaceOptions = {}): Promise<Uint8Array<ArrayBuffer>> {
  const project = await workspace.checkpoint();
  assertSaveVersion(project, options);
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
