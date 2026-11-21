import type { AudioClip, Project, ProjectClip, ProjectMidiEvent, ProjectTrack } from "@audiorective/daw";
import type { MidiNote } from "@audiorective/midi";

type ClipSnapshot =
  | { kind: "audio"; id: string; trackId: string; time: number; source: AudioClip }
  | {
      kind: "midi";
      id: string;
      trackId: string;
      time: number;
      source: ProjectClip;
      duration: number;
      notes: readonly MidiNote[];
      events: readonly ProjectMidiEvent[];
    };

type ClipEdit = { label: string; ids: readonly string[]; before: readonly ClipSnapshot[]; after: readonly ClipSnapshot[] };
type VolumePoints = ProjectTrack["volumeAutomation"];
type AutomationEdit = { label: string; trackId: string; before: VolumePoints; after: VolumePoints };
type Edit = ClipEdit | AutomationEdit;

const capture = (project: Project): Map<string, ClipSnapshot> => {
  const clips = new Map<string, ClipSnapshot>();
  for (const track of project.tracks)
    for (const clip of track.clips)
      clips.set(
        clip.id,
        clip.kind === "audio"
          ? { kind: "audio", id: clip.id, trackId: track.id, time: clip.time, source: clip }
          : {
              kind: "midi",
              id: clip.id,
              trackId: track.id,
              time: clip.time,
              source: clip,
              duration: clip.duration,
              notes: clip.midi.notes.value,
              events: clip.events,
            },
      );
  return clips;
};

const same = (a: ClipSnapshot | undefined, b: ClipSnapshot | undefined): boolean =>
  a === b ||
  (!!a &&
    !!b &&
    a.kind === b.kind &&
    a.id === b.id &&
    a.trackId === b.trackId &&
    a.time === b.time &&
    a.source === b.source &&
    (a.kind === "audio" || (b.kind === "midi" && a.duration === b.duration && a.notes === b.notes)));

/** Session-local content history. PCM is borrowed from immutable project clips until an edit is replayed. */
export class EditHistory {
  private undoStack: Edit[] = [];
  private redoStack: Edit[] = [];

  constructor(
    private readonly project: () => Project,
    private readonly changed: () => void,
    private readonly onState: (undo: string | undefined, redo: string | undefined) => void,
  ) {}

  private publish(): void {
    this.onState(this.undoStack.at(-1)?.label, this.redoStack.at(-1)?.label);
  }

  private push(edit: Edit): void {
    this.undoStack.push(edit);
    if (this.undoStack.length > 50) this.undoStack.shift();
    this.redoStack = [];
    this.publish();
  }

  recordVolumeAutomation(trackId: string, points: VolumePoints): void {
    const project = this.project();
    const before = project.tracks.find((track) => track.id === trackId)?.volumeAutomation ?? [];
    project.setVolumeAutomation(trackId, points);
    const after = project.tracks.find((track) => track.id === trackId)!.volumeAutomation;
    this.push({ label: "編輯音量自動化", trackId, before, after });
  }

  record<T>(label: string, action: () => T): T {
    const project = this.project();
    const before = capture(project);
    const result = action();
    const after = capture(project);
    const ids = [...new Set([...before.keys(), ...after.keys()])].filter((id) => !same(before.get(id), after.get(id)));
    if (ids.length) {
      this.push({
        label,
        ids,
        before: ids.flatMap((id) => (before.has(id) ? [before.get(id)!] : [])),
        after: ids.flatMap((id) => (after.has(id) ? [after.get(id)!] : [])),
      });
    }
    return result;
  }

  private apply(edit: Edit, side: "before" | "after"): void {
    const project = this.project();
    if ("trackId" in edit) {
      project.setVolumeAutomation(edit.trackId, edit[side]);
      this.changed();
      return;
    }
    for (const id of edit.ids) if (project.tracks.some((track) => track.clips.some((clip) => clip.id === id))) project.removeClip(id);
    for (const clip of edit[side]) {
      if (clip.kind === "audio") {
        const audio = clip.source;
        if (audio.media)
          project.addAudioMediaClip(clip.trackId, audio.media, clip.time, {
            id: clip.id,
            startFrame: audio.startFrame,
            frameCount: audio.frameCount,
            envelope: audio.envelope,
            stretch: audio.stretch,
            gainAutomation: audio.gainAutomation,
          });
        else
          project.addAudioClip(clip.trackId, audio, clip.time, {
            id: clip.id,
            envelope: audio.envelope,
            stretch: audio.stretch,
            gainAutomation: audio.gainAutomation,
          });
      } else project.addMidiClip(clip.trackId, { duration: clip.duration, notes: clip.notes, events: clip.events }, clip.time, { id: clip.id });
    }
    this.changed();
  }

  undo(): string | undefined {
    const edit = this.undoStack.at(-1);
    if (!edit) return;
    this.apply(edit, "before");
    this.undoStack.pop();
    this.redoStack.push(edit);
    this.publish();
    return edit.label;
  }

  redo(): string | undefined {
    const edit = this.redoStack.at(-1);
    if (!edit) return;
    this.apply(edit, "after");
    this.redoStack.pop();
    this.undoStack.push(edit);
    this.publish();
    return edit.label;
  }

  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
    this.publish();
  }
}
