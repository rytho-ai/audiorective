import type { Project } from "./model";

export const nextProjectId = new WeakMap<Project, number>();
export const importedBundles = new WeakMap<Project, Set<string>>();
const disposed = new WeakSet<Project>();

export function assertProjectActive(project: Project): void {
  if (disposed.has(project)) throw new Error("Project is disposed.");
}

export function markProjectDisposed(project: Project): boolean {
  if (disposed.has(project)) return false;
  disposed.add(project);
  return true;
}

export function validateXmlText(text: string): void {
  for (const character of text) {
    const code = character.codePointAt(0)!;
    if (code === 9 || code === 10 || code === 13 || (code >= 32 && code <= 0xd7ff) || (code >= 0xe000 && code <= 0xfffd) || code >= 0x10000) continue;
    throw new RangeError("Project text contains characters that XML cannot represent.");
  }
}

const reserved = new Set([
  "masterTrack",
  "masterChannel",
  "masterVolume",
  "transportTempo",
  "transportSignature",
  "arrangement",
  "projectLanes",
  "projectMarkers",
  "projectTempo",
  "__proto__",
]);

export function validProjectId(id: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_.-]*$/.test(id) && !reserved.has(id);
}

export function collidesWithProjectId(id: string, existing: ReadonlySet<string>): boolean {
  const suffix = /-(?:channel|mute|pan|volume|lane|clips(?:-beats)?|automation|audio|content|notes|control\d+)$/.exec(id);
  if (existing.has(id) || (suffix && existing.has(id.slice(0, suffix.index)))) return true;
  for (const other of existing) {
    if (!other.startsWith(id + "-")) continue;
    const ending = other.slice(id.length);
    if (/^-(?:channel|mute|pan|volume|lane|clips(?:-beats)?|automation|audio|content|notes|control\d+)$/.test(ending)) return true;
  }
  return false;
}
