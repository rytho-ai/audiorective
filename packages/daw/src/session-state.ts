import type { ProjectClip } from "./model";

/** One row of the Session grid. */
export type SessionScene = Readonly<{ id: string; name: string }>;

/** The Session grid a Project saves: its scenes in order, and the clip held by each scene and track, at most one per slot. */
export type SessionState = Readonly<{
  /** Session rows in launch and display order; empty for a project without scenes. */
  scenes: readonly SessionScene[];
  /** Slot clips by `slotKey(sceneId, trackId)`. A slot clip is not on the timeline: its `time` is 0. */
  slots: ReadonlyMap<string, ProjectClip>;
}>;

export const emptySession: SessionState = Object.freeze({ scenes: Object.freeze([]), slots: new Map<string, ProjectClip>() });

/** XML IDs cannot hold a line break, so it separates the two ids. */
export const slotKey = (sceneId: string, trackId: string): string => `${sceneId}\n${trackId}`;

export function splitSlotKey(key: string): { sceneId: string; trackId: string } {
  const at = key.indexOf("\n");
  return { sceneId: key.slice(0, at), trackId: key.slice(at + 1) };
}

const readers = new WeakMap<object, () => SessionState>();

/** Lets modules that cannot import the model (it imports them) read a Project's Session grid. */
export function registerSessionReader(project: object, read: () => SessionState): void {
  readers.set(project, read);
}

/** The slot clip with this ID, untracked, or undefined. */
export function findSlotClip(project: object, clipId: string): ProjectClip | undefined {
  for (const clip of readers.get(project)?.().slots.values() ?? []) if (clip.id === clipId) return clip;
  return undefined;
}

/** The Session grid of a Project, untracked; empty for an object that is not a Project. */
export function readSession(project: object): SessionState {
  return readers.get(project)?.() ?? emptySession;
}
