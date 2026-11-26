import { describe, expect, it } from "vitest";
import { MidiClip, sessionFor } from "../src/project";
import { applyAndUndo, reject, world } from "./edit-ops-support";

describe("Session grid edit operations", () => {
  it("adds, renames, moves and removes scenes", () => {
    const w = world();
    const names = () => w.session.scenes.map(({ name }) => name);
    const receipt = applyAndUndo(w.project, [
      { type: "addScene", name: "Bridge", afterSceneId: w.verse.id, as: "bridge" },
      { type: "renameScene", sceneId: { fromCopy: "bridge" }, name: "Break" },
    ]);
    expect(names()).toEqual(["Verse", "Break", "Chorus"]);
    expect(receipt.createdScenes).toEqual([{ id: w.session.scenes[1].id, as: "bridge" }]);
    applyAndUndo(w.project, [{ type: "moveScene", sceneId: w.chorus.id, index: 0 }]);
    expect(names()).toEqual(["Chorus", "Verse", "Break"]);
    applyAndUndo(w.project, [{ type: "removeScene", sceneId: w.verse.id }]);
    expect(names()).toEqual(["Chorus", "Break"]);
    expect(w.session.clipAt({ sceneId: w.verse.id, trackId: w.keys.id })).toBeNull();
  });

  it("duplicates a scene with its slot clips", () => {
    const w = world();
    const receipt = applyAndUndo(w.project, [{ type: "duplicateScene", sceneId: w.verse.id, as: "again" }]);
    const copy = receipt.createdScenes[0];
    expect(copy.as).toBe("again");
    expect(w.session.scenes.map(({ name }) => name)).toEqual(["Verse", "Verse copy", "Chorus"]);
    const clip = w.session.clipAt({ sceneId: copy.id, trackId: w.keys.id })!;
    expect(clip.id).not.toBe(w.hook.id);
    expect(receipt.created).toContain(clip.id);
  });

  it("fills, moves, copies and clears slots, and places a slot clip on the timeline", () => {
    const w = world();
    const receipt = applyAndUndo(w.project, [
      {
        type: "setMidiClip",
        slot: { sceneId: w.chorus.id, trackId: w.bass.id },
        duration: 4,
        notes: [{ pitch: 36, start: 0, duration: 1 }],
        name: "Riff",
        as: "riff",
      },
      { type: "copyToSlot", clip: { fromCopy: "riff" }, slot: { sceneId: w.verse.id, trackId: w.bass.id }, linked: true, as: "riffTwin" },
      { type: "moveSlotClip", from: { sceneId: w.verse.id, trackId: w.keys.id }, to: { sceneId: w.chorus.id, trackId: w.keys.id } },
      { type: "copyToArrangement", slot: { sceneId: w.chorus.id, trackId: w.bass.id }, atBeat: 8, as: "placed" },
    ]);
    const riff = w.session.midiClipAt({ sceneId: w.chorus.id, trackId: w.bass.id })!;
    expect(w.project.clipName(riff.id)).toBe("Riff");
    expect(receipt.copies.riff).toEqual([{ id: riff.id, trackId: w.bass.id }]);
    expect(w.session.clipAt({ sceneId: w.chorus.id, trackId: w.keys.id })!.id).toBe(w.hook.id);
    expect(w.session.clipAt({ sceneId: w.verse.id, trackId: w.keys.id })).toBeNull();
    const twin = w.session.midiClipAt({ sceneId: w.verse.id, trackId: w.bass.id })!;
    expect(w.project.linkedClips(riff.id).map(({ id }) => id)).toContain(twin.id);
    const placed = w.project.tracks.find((track) => track.id === w.bass.id)!.clips[0] as MidiClip;
    expect(placed).toMatchObject({ time: 8 });
    expect(receipt.copies.placed[0].id).toBe(placed.id);
    applyAndUndo(w.project, [{ type: "clearSlot", slot: { sceneId: w.chorus.id, trackId: w.bass.id } }]);
    expect(w.session.clipAt({ sceneId: w.chorus.id, trackId: w.bass.id })).toBeNull();
  });

  it("copyToArrangement takes seconds for an audio slot clip's track kind check", () => {
    const w = world();
    applyAndUndo(w.project, [{ type: "copyToArrangement", slot: { sceneId: w.verse.id, trackId: w.keys.id }, atSeconds: 10, trackId: w.keys.id }]);
    expect(w.project.tracks.find((track) => track.id === w.keys.id)!.clips.map((clip) => clip.time)).toEqual([8, 20]);
  });

  it("edits notes of a slot clip made in the same request", () => {
    const w = world();
    const receipt = applyAndUndo(w.project, [
      { type: "setMidiClip", slot: { sceneId: w.chorus.id, trackId: w.bass.id }, duration: 2, as: "empty" },
      { type: "addNotes", clip: { fromCopy: "empty" }, notes: [{ pitch: 40, start: 0, duration: 1 }] },
    ]);
    expect(receipt.createdNotes).toHaveLength(1);
    expect(w.session.midiClipAt({ sceneId: w.chorus.id, trackId: w.bass.id })!.midi.notes.value).toHaveLength(1);
  });

  it("rejects bad Session operations and leaves the project as it was", () => {
    const w = world();
    const slot = { sceneId: w.verse.id, trackId: w.keys.id };
    expect(reject(w.project, { type: "addScene", afterSceneId: "nope" })).toMatchObject({ code: "scene-not-found" });
    expect(reject(w.project, { type: "addScene", name: " " })).toMatchObject({ code: "invalid-operation" });
    expect(reject(w.project, { type: "renameScene", sceneId: { fromCopy: "ghost" }, name: "x" })).toMatchObject({ code: "scene-not-found" });
    expect(reject(w.project, { type: "moveScene", sceneId: w.verse.id, index: 9 })).toMatchObject({ code: "edit-failed" });
    expect(reject(w.project, { type: "moveScene", sceneId: w.verse.id, index: 0.5 })).toMatchObject({ code: "invalid-operation" });
    expect(reject(w.project, { type: "removeScene", sceneId: "nope" })).toMatchObject({ code: "scene-not-found" });
    expect(reject(w.project, { type: "setMidiClip", slot: { sceneId: w.verse.id, trackId: w.drums.id }, duration: 4 })).toMatchObject({
      code: "edit-failed",
    });
    expect(reject(w.project, { type: "setMidiClip", slot: { sceneId: w.verse.id }, duration: 4 })).toMatchObject({ code: "invalid-operation" });
    expect(reject(w.project, { type: "moveSlotClip", from: { sceneId: w.chorus.id, trackId: w.keys.id }, to: slot })).toMatchObject({
      code: "edit-failed",
    });
    expect(reject(w.project, { type: "moveSlotClip", from: slot, to: { sceneId: w.chorus.id, trackId: w.drums.id } })).toMatchObject({
      code: "edit-failed",
    });
    expect(reject(w.project, { type: "copyToSlot", clip: { clipId: w.hook.id }, slot: { sceneId: w.chorus.id, trackId: w.drums.id } })).toMatchObject(
      {
        code: "edit-failed",
      },
    );
    expect(reject(w.project, { type: "copyToArrangement", slot, atBeat: 1, atSeconds: 1 })).toMatchObject({ code: "invalid-operation" });
    expect(reject(w.project, { type: "copyToArrangement", slot: { sceneId: w.chorus.id, trackId: w.keys.id }, atBeat: 1 })).toMatchObject({
      code: "edit-failed",
    });
    expect(reject(w.project, { type: "clearSlot", slot: { sceneId: "nope", trackId: w.keys.id } })).toMatchObject({ code: "scene-not-found" });
    expect(sessionFor(w.project).scenes).toHaveLength(2);
  });
});
