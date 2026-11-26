import { Cell, effect, readonlyCell, untracked, type ReadonlyCell } from "@audiorective/core";
import type { Project, ProjectClip } from "./model";
import type { BeatRange } from "./project-edits";

/** What a person or agent has selected. JSON-serializable, never saved, and not part of undo or the Project version. */
export type ProjectSelectionState = Readonly<{
  trackId: string | null;
  clipIds: readonly string[];
  /** The clip open in an editor such as a piano roll. */
  openClipId: string | null;
  /** Selected notes of the open MIDI clip. */
  noteIds: readonly string[];
  /** A half-open beat range, such as a drag on the ruler. */
  range: BeatRange | null;
}>;

const emptySelection: ProjectSelectionState = Object.freeze({
  trackId: null,
  clipIds: Object.freeze([]),
  openClipId: null,
  noteIds: Object.freeze([]),
  range: null,
});
const sameIds = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((id, index) => id === b[index]);
const sameSelection = (a: ProjectSelectionState, b: ProjectSelectionState) =>
  a.trackId === b.trackId &&
  a.openClipId === b.openClipId &&
  sameIds(a.clipIds, b.clipIds) &&
  sameIds(a.noteIds, b.noteIds) &&
  a.range?.startBeat === b.range?.startBeat &&
  a.range?.endBeat === b.range?.endBeat;

const selections = new WeakMap<Project, ProjectSelection>();
let createSelection: (project: Project) => ProjectSelection;

/**
 * The selection shared by everything working on one Project. It always names content that exists: a deleted clip, track or note
 * leaves it for good, even if an undo later restores the content.
 */
export class ProjectSelection {
  /** Tracked. Notifies only when the selection really changes. */
  readonly state: ReadonlyCell<ProjectSelectionState>;
  private readonly store = new Cell<ProjectSelectionState>(emptySelection);

  static {
    createSelection = (project) => new ProjectSelection(project);
  }

  private constructor(
    /** The Project this selection follows; it drops anything that leaves it. */
    readonly project: Project,
  ) {
    this.state = readonlyCell(this.store);
    // Detached: the selection lives as long as its Project, even if first requested inside an effect that later re-runs.
    untracked(() =>
      effect(() => {
        const current = this.store.value;
        const next = this.resolve(current);
        if (!sameSelection(current, next)) untracked(() => (this.store.value = next));
      }),
    );
  }

  private resolve(wanted: ProjectSelectionState): ProjectSelectionState {
    const tracks = this.project.tracks;
    const clips = new Map<string, ProjectClip>(tracks.flatMap((track) => track.clips.map((clip) => [clip.id, clip] as const)));
    const open = wanted.openClipId === null ? undefined : clips.get(wanted.openClipId);
    const notes = open?.kind === "midi" ? new Set(open.midi.notes.value.map(({ id }) => id)) : undefined;
    return Object.freeze({
      trackId: wanted.trackId !== null && tracks.some(({ id }) => id === wanted.trackId) ? wanted.trackId : null,
      clipIds: Object.freeze(wanted.clipIds.filter((id) => clips.has(id))),
      openClipId: open ? wanted.openClipId : null,
      noteIds: Object.freeze(notes ? wanted.noteIds.filter((id) => notes.has(id)) : []),
      range: wanted.range,
    });
  }

  private owner(clipId: string) {
    return this.project.tracks.find((track) => track.clips.some((clip) => clip.id === clipId));
  }

  private write(patch: Partial<ProjectSelectionState>): void {
    this.store.value = Object.freeze({ ...untracked(() => this.store.value), ...patch });
  }

  /** Replace the selected clips; also selects the first clip's track. */
  selectClips(clipIds: readonly string[]): void {
    untracked(() => {
      if (clipIds.some((id) => !this.owner(id))) throw new Error("ProjectSelection needs existing clips.");
      const first = clipIds.length ? this.owner(clipIds[0])!.id : this.store.value.trackId;
      this.write({ trackId: first, clipIds: Object.freeze([...new Set(clipIds)]) });
    });
  }

  /** Add the clip to the selection, or remove it if already selected. */
  toggleClip(clipId: string): void {
    untracked(() => {
      const { clipIds } = this.store.value;
      if (clipIds.includes(clipId)) this.write({ clipIds: Object.freeze(clipIds.filter((id) => id !== clipId)) });
      else {
        const owner = this.owner(clipId);
        if (!owner) throw new Error("ProjectSelection needs existing clips.");
        this.write({ trackId: clipIds.length ? this.store.value.trackId : owner.id, clipIds: Object.freeze([...clipIds, clipId]) });
      }
    });
  }

  /** Select a track by ID, or clear the track with `null`. Throws if the ID is not a track of the Project. */
  selectTrack(trackId: string | null): void {
    untracked(() => {
      if (trackId !== null && !this.project.tracks.some(({ id }) => id === trackId)) throw new Error("ProjectSelection needs an existing track.");
      this.write({ trackId });
    });
  }

  /** Select a half-open beat range, or clear it with `null`. */
  selectRange(range: BeatRange | null): void {
    if (range && (!Number.isFinite(range.startBeat) || !Number.isFinite(range.endBeat) || range.startBeat < 0 || range.startBeat >= range.endBeat))
      throw new RangeError("ProjectSelection range needs 0 <= startBeat < endBeat.");
    this.write({ range: range && Object.freeze({ startBeat: range.startBeat, endBeat: range.endBeat }) });
  }

  /** Open a clip for detailed editing, or close it with `null`. Changing the open clip clears the note selection. */
  openClip(clipId: string | null): void {
    untracked(() => {
      if (clipId !== null && !this.owner(clipId)) throw new Error("ProjectSelection needs an existing clip.");
      if (this.store.value.openClipId !== clipId) this.write({ openClipId: clipId, noteIds: Object.freeze([]) });
    });
  }

  /** Replace the selected notes of the open MIDI clip. */
  selectNotes(noteIds: readonly string[]): void {
    untracked(() => {
      if (noteIds.length) {
        const { openClipId } = this.store.value;
        const open = openClipId === null ? undefined : this.owner(openClipId)?.clips.find(({ id }) => id === openClipId);
        if (open?.kind !== "midi") throw new Error("ProjectSelection note selection needs an open MIDI clip.");
        const known = new Set(open.midi.notes.value.map(({ id }) => id));
        if (noteIds.some((id) => !known.has(id))) throw new Error("ProjectSelection needs existing notes of the open clip.");
      }
      this.write({ noteIds: Object.freeze([...new Set(noteIds)]) });
    });
  }

  /** Clear the whole selection and close the open clip. */
  clear(): void {
    this.store.value = emptySelection;
  }
}

/** The one shared selection of this Project: every call with the same Project returns the same object. */
export function selectionFor(project: Project): ProjectSelection {
  let selection = selections.get(project);
  if (!selection) selections.set(project, (selection = createSelection(project)));
  return selection;
}
