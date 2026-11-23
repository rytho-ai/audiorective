import { effect } from "@audiorective/core";
import { describe, expect, it } from "vitest";
import { Project } from "../src/project";
import { selectionFor } from "../src/selection";

function song() {
  const project = new Project({ bpm: 120 });
  const audio = project.addTrack("Vocals", "audio");
  const midi = project.addTrack("Keys", "midi");
  const vocal = project.addAudioClip(audio.id, { sampleRate: 100, channels: [new Float32Array(100)] }, 0);
  const keys = project.addMidiClip(
    midi.id,
    {
      duration: 4,
      notes: [
        { id: "n1", pitch: 60, velocity: 0.5, start: 0, duration: 1 },
        { id: "n2", pitch: 62, velocity: 0.5, start: 1, duration: 1 },
      ],
    },
    0,
  );
  return { project, audio, midi, vocal, keys, selection: selectionFor(project) };
}

describe("ProjectSelection", () => {
  it("is one shared object per Project", () => {
    const { project, selection, vocal } = song();
    expect(selectionFor(project)).toBe(selection);
    selection.selectClips([vocal.id]);
    expect(selectionFor(project).state.value.clipIds).toEqual([vocal.id]);
    expect(selectionFor(new Project()).state.value.clipIds).toEqual([]);
  });

  it("selects clips with their track, toggles, and is JSON-serializable", () => {
    const { selection, audio, vocal, keys } = song();
    selection.selectClips([vocal.id]);
    selection.toggleClip(keys.id);
    expect(JSON.parse(JSON.stringify(selection.state.value))).toEqual({
      trackId: audio.id,
      clipIds: [vocal.id, keys.id],
      openClipId: null,
      noteIds: [],
      range: null,
    });
    selection.toggleClip(vocal.id);
    expect(selection.state.value.clipIds).toEqual([keys.id]);
  });

  it("does not change the Project version, undo history or saved content", () => {
    const { project, selection, vocal } = song();
    const version = project.cells.version.value;
    selection.selectClips([vocal.id]);
    selection.selectRange({ startBeat: 0, endBeat: 4 });
    expect(project.cells.version.value).toBe(version);
    expect(project.cells.history.value).toEqual({});
  });

  it("drops deleted content for good, even when undo restores the content", () => {
    const { project, selection, vocal, keys, midi } = song();
    selection.selectClips([vocal.id, keys.id]);
    selection.selectTrack(midi.id);
    selection.openClip(keys.id);
    selection.selectNotes(["n1", "n2"]);
    keys.midi.edit((notes) => void notes.splice(1, 1));
    expect(selection.state.value.noteIds).toEqual(["n1"]);
    project.edit("Delete", () => project.removeClip(keys.id));
    expect(selection.state.value).toMatchObject({ clipIds: [vocal.id], openClipId: null, noteIds: [] });
    project.undo();
    expect(selection.state.value).toMatchObject({ clipIds: [vocal.id], openClipId: null, noteIds: [] });
    project.removeTrack(midi.id);
    expect(selection.state.value.trackId).toBeNull();
  });

  it("keeps a note removed by undo out of the selection after redo", () => {
    const { project, selection, keys } = song();
    selection.openClip(keys.id);
    project.edit("Add", () => keys.midi.edit((notes) => void notes.push({ id: "n3", pitch: 64, velocity: 0.5, start: 2, duration: 1, channel: 0 })));
    selection.selectNotes(["n3"]);
    project.undo();
    expect(selection.state.value.noteIds).toEqual([]);
    project.redo();
    expect(selection.state.value.noteIds).toEqual([]);
  });

  it("keeps a clip selected through split, which keeps its ID", () => {
    const { project, selection, keys } = song();
    selection.selectClips([keys.id]);
    const [left] = project.splitClip(keys.id, 2);
    expect(selection.state.value.clipIds).toEqual([left.id]);
  });

  it("clears notes when another clip opens, and clears everything", () => {
    const { selection, keys, vocal } = song();
    selection.openClip(keys.id);
    selection.selectNotes(["n1"]);
    selection.openClip(vocal.id);
    expect(selection.state.value).toMatchObject({ openClipId: vocal.id, noteIds: [] });
    selection.clear();
    expect(selection.state.value).toEqual({ trackId: null, clipIds: [], openClipId: null, noteIds: [], range: null });
  });

  it("rejects content that does not exist", () => {
    const { selection, keys } = song();
    expect(() => selection.selectClips(["nope"])).toThrow(/existing clips/);
    expect(() => selection.toggleClip("nope")).toThrow(/existing clips/);
    expect(() => selection.selectTrack("nope")).toThrow(/existing track/);
    expect(() => selection.openClip("nope")).toThrow(/existing clip/);
    expect(() => selection.selectNotes(["n1"])).toThrow(/open MIDI clip/);
    selection.openClip(keys.id);
    expect(() => selection.selectNotes(["nope"])).toThrow(/existing notes/);
    expect(() => selection.selectRange({ startBeat: 2, endBeat: 1 })).toThrow(/startBeat/);
  });

  it("notifies once per real change and not for unrelated edits", () => {
    const { project, selection, vocal, audio } = song();
    const seen: unknown[] = [];
    const stop = effect(() => void seen.push(selection.state.value));
    seen.length = 0;
    selection.selectClips([vocal.id]);
    expect(seen).toHaveLength(1);
    selection.selectClips([vocal.id]);
    project.setTrackVolume(audio.id, 0.5);
    expect(seen).toHaveLength(seen.length);
    const count = seen.length;
    project.setTrackVolume(audio.id, 0.25);
    expect(seen).toHaveLength(count);
    project.removeClip(vocal.id);
    expect(seen).toHaveLength(count + 1);
    stop();
  });
});
