import { saveWorkspaceTo, type Workspace } from "@audiorective/daw";

function directory(): Promise<FileSystemDirectoryHandle> {
  return navigator.storage.getDirectory().then((root) => root.getDirectoryHandle("audiorective-recovery", { create: true }));
}

/** Keep the current checkpoint until the replacement archive has closed successfully. */
export async function checkpointTake(workspace: Workspace, name: string): Promise<void> {
  const handle = await (await directory()).getFileHandle(name, { create: true });
  const stream = await handle.createWritable();
  try {
    await saveWorkspaceTo(workspace, stream);
  } catch (error) {
    await stream.abort().catch(() => undefined);
    throw error;
  }
}

export async function listTakeCheckpoints(): Promise<File[]> {
  if (!navigator.storage?.getDirectory) return [];
  const files: File[] = [];
  const handles = (await directory()) as FileSystemDirectoryHandle & {
    values(): AsyncIterable<FileSystemFileHandle | FileSystemDirectoryHandle>;
  };
  for await (const handle of handles.values()) {
    if (handle.kind !== "file" || !handle.name.endsWith(".dawproject")) continue;
    const file = await (handle as FileSystemFileHandle).getFile().catch(() => undefined);
    if (file?.size) files.push(file);
  }
  return files.sort((left, right) => right.lastModified - left.lastModified);
}

export async function removeTakeCheckpoint(name: string): Promise<void> {
  await (await directory()).removeEntry(name);
}
