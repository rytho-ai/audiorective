import type { Project } from "./model";
import type { TempoMap } from "./tempo-map";

export const nextProjectId = new WeakMap<Project, number>();
export const importedBundles = new WeakMap<Project, Set<string>>();
/** Archive files an opened project did not use, written back unchanged on save so other apps' and extensions' data survives. */
export const preservedEntries = new WeakMap<Project, ReadonlyMap<string, Uint8Array | Blob>>();
const disposed = new WeakSet<Project>();

/** A song-wide time edit, in both units, with the tempo maps that relate them: what `rippleDelete` and an inserting `copyRange` do to the whole song. */
export type SongEdit =
  | {
      kind: "delete";
      /** Song-wide edit positions in project seconds, paired with the corresponding beat positions. */
      seconds: Readonly<{
        /** Inclusive deletion start in project seconds. */
        from: number;
        /** Exclusive deletion end in project seconds. */
        to: number;
      }>;
      /** Song-wide edit positions in project beats, paired with the corresponding second positions. */
      beats: Readonly<{
        /** Inclusive deletion start in project beats. */
        from: number;
        /** Exclusive deletion end in project beats. */
        to: number;
      }>;
    }
  | {
      kind: "insert";
      /** Song-wide edit positions in project seconds, paired with the corresponding beat positions. */
      seconds: Readonly<{
        /** Inclusive copied-range start in project seconds before insertion. */
        start: number;
        /** Exclusive copied-range end in project seconds before insertion. */
        end: number;
        /** Insertion position in project seconds before insertion. */
        at: number;
      }>;
      /** Song-wide edit positions in project beats, paired with the corresponding second positions. */
      beats: Readonly<{
        /** Inclusive copied-range start in project beats before insertion. */
        start: number;
        /** Exclusive copied-range end in project beats before insertion. */
        end: number;
        /** Insertion position in project beats before insertion. */
        at: number;
      }>;
      /** Tempo map before insertion, used to interpret the original second positions. */
      before: TempoMap;
      /** Tempo map after insertion, used to convert shifted beat positions to seconds. */
      after: TempoMap;
    };

/**
 * What a project opened from a file does about the content the file keeps and the model does not carry (the DAWproject codec registers it): a song-wide edit
 * moves that content too or is refused (`shift`, which throws before anything changes), a clip an edit places must not land on a kept clip (`spans`, in
 * seconds), and the move follows the Undo step of the edit that made it (`commit`, `discard`, `step`). Without a codec every hook does nothing.
 */
export type KeptContentHooks = {
  /** Validates and stages song-wide movement of preserved XML content; throws before the model changes on failure. */
  shift(project: Project, edit: SongEdit, verb: string): void;
  /** Returns preserved clip spans on the track in project seconds for overlap validation. */
  spans(
    project: Project,
    trackId: string,
  ): Array<{
    name: string;
    /** Inclusive preserved clip start in project seconds. */
    start: number;
    /** Exclusive preserved clip end in project seconds. */
    end: number;
  }>;
  /** Associates staged XML movement with an Undo entry, or applies it without history when the entry is undefined. */
  commit(project: Project, entry: object | undefined): void;
  /** Drops staged preserved-content movement after an edit fails. */
  discard(project: Project): void;
  /** Applies or undoes the preserved-content movement associated with a history entry. */
  step(project: Project, entry: object, applied: boolean): void;
};
const idle: KeptContentHooks = { shift: () => undefined, spans: () => [], commit: () => undefined, discard: () => undefined, step: () => undefined };
export const keptContent: KeptContentHooks = { ...idle };
export function registerKeptContent(hooks: KeptContentHooks): void {
  Object.assign(keptContent, hooks);
}

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
