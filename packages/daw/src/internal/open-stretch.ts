import type { AudioClip, Project } from "../model";

/**
 * The clips an opened file stretched, which the reader gave varispeed audio (right length, changed pitch): `openWorkspace`, `workspace.open` and
 * `Workspace.create` render them with the app's stretch processor before the song plays. Keyed by the opened Project and taken once.
 */
export type OpenedStretch = Readonly<{
  /** Opened stretched clip currently using varispeed, awaiting the app stretch engine. */
  clip: AudioClip;
  /** The file asked for a pitch-preserving stretch; a clip whose algorithm is varispeed by intent is not listed. */
  name: string;
}>;

const pending = new WeakMap<Project, OpenedStretch[]>();

export const noteOpenedStretch = (project: Project, entry: OpenedStretch): void =>
  void pending.set(project, [...(pending.get(project) ?? []), entry]);

/** The clips waiting for their render, once: a second call for the same Project returns none. */
export function takeOpenedStretches(project: Project): readonly OpenedStretch[] {
  const list = pending.get(project) ?? [];
  pending.delete(project);
  return list;
}
