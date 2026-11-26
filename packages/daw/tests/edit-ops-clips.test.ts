import { describe, expect, it } from "vitest";
import { MidiClip } from "../src/project";
import { apply, applyAndUndo, fingerprint, reject, version, world } from "./edit-ops-support";

const timeline = (w: ReturnType<typeof world>, trackId: string) => w.project.tracks.find((track) => track.id === trackId)!.clips;

describe("clip edit operations", () => {
  it("splitClip cuts a MIDI clip at a project beat and names the right piece", () => {
    const w = world();
    const receipt = applyAndUndo(w.project, [
      { type: "splitClip", clip: { clipId: w.pattern.id }, atBeat: 12, as: "right" },
      { type: "setClipName", clip: { fromCopy: "right" }, name: "Second half" },
    ]);
    const [left, right] = timeline(w, w.keys.id);
    expect([left.id, left.time, left.duration]).toEqual([w.pattern.id, 8, 4]);
    expect([right.time, right.duration]).toEqual([12, 4]);
    expect(receipt.created).toEqual([right.id]);
    expect(receipt.copies.right).toEqual([{ from: w.pattern.id, id: right.id, trackId: w.keys.id }]);
    expect(w.project.clipName(right.id)).toBe("Second half");
  });

  it("splitClip takes project seconds for an audio clip", () => {
    const w = world();
    applyAndUndo(w.project, [{ type: "splitClip", clip: { clipId: w.take.id }, atSeconds: 3 }]);
    expect(timeline(w, w.drums.id).map((clip) => [clip.time, clip.duration])).toEqual([
      [2, 1],
      [3, 3],
    ]);
  });

  it("duplicateClip copies to a position, another track and a linked group", () => {
    const w = world();
    const receipt = applyAndUndo(w.project, [
      { type: "duplicateClip", clip: { clipId: w.pattern.id }, atBeat: 0, trackId: w.bass.id, linked: true, as: "twin" },
      { type: "duplicateClip", clip: { clipId: w.take.id }, atBeat: 12 },
    ]);
    const twin = timeline(w, w.bass.id)[0] as MidiClip;
    expect(twin.id).toBe(receipt.copies.twin[0].id);
    expect(receipt.copies.twin[0]).toEqual({ from: w.pattern.id, id: twin.id, trackId: w.bass.id });
    expect(w.project.linkedClips(w.pattern.id).map(({ id }) => id)).toEqual([twin.id]);
    // 12 beats at 120 BPM is 6 seconds, where the 4-second take ends.
    expect(timeline(w, w.drums.id).map((clip) => clip.time)).toEqual([2, 6]);
  });

  it("removeClip deletes a timeline clip and Undo brings it back", () => {
    const w = world();
    const receipt = applyAndUndo(w.project, [{ type: "removeClip", clip: { clipId: w.pattern.id } }]);
    expect(timeline(w, w.keys.id)).toEqual([]);
    expect(receipt.removed).toEqual([w.pattern.id]);
  });

  it("moveClip moves a clip to another track of the same kind", () => {
    const w = world();
    applyAndUndo(w.project, [{ type: "moveClip", clip: { clipId: w.pattern.id }, trackId: w.bass.id, position: { atBeat: 2 } }]);
    expect(timeline(w, w.keys.id)).toEqual([]);
    expect(timeline(w, w.bass.id)[0]).toMatchObject({ id: w.pattern.id, time: 2 });
  });

  it("setClipLoop loops MIDI content in beats and audio content in seconds, and null stops", () => {
    const w = world();
    applyAndUndo(w.project, [
      { type: "setClipLoop", clip: { clipId: w.pattern.id }, loop: { startBeat: 0, endBeat: 2 } },
      { type: "setClipLoop", clip: { clipId: w.take.id }, loop: { startSeconds: 0, endSeconds: 1 } },
    ]);
    expect(timeline(w, w.keys.id)[0].loop).toEqual({ startBeat: 0, endBeat: 2 });
    expect(timeline(w, w.drums.id)[0].loop).toEqual({ startSeconds: 0, endSeconds: 1 });
    applyAndUndo(w.project, [{ type: "setClipLoop", clip: { clipId: w.pattern.id }, loop: null }]);
    expect(timeline(w, w.keys.id)[0].loop).toBeUndefined();
  });

  it("addMidiClip adds a clip with notes, or a clip linked to another one", () => {
    const w = world();
    const receipt = applyAndUndo(w.project, [
      {
        type: "addMidiClip",
        trackId: w.bass.id,
        atBeat: 4,
        duration: 4,
        notes: [{ pitch: 36, start: 0, duration: 1 }],
        name: "Line",
        as: "line",
      },
      { type: "addMidiClip", trackId: w.bass.id, atBeat: 12, duration: 4, linkedTo: { fromCopy: "line" }, as: "again" },
    ]);
    const [line, again] = timeline(w, w.bass.id) as MidiClip[];
    expect(line.midi.notes.value).toMatchObject([{ pitch: 36, velocity: 0.8 }]);
    expect(w.project.clipName(line.id)).toBe("Line");
    expect(w.project.linkedClips(line.id).map(({ id }) => id)).toEqual([again.id]);
    expect(receipt.created).toEqual([line.id, again.id]);
  });

  it("setAudioClipEnvelope keeps the fields it does not name", () => {
    const w = world();
    applyAndUndo(w.project, [{ type: "setAudioClipEnvelope", clip: { clipId: w.take.id }, gain: 0.5, fadeIn: 0.25 }]);
    expect(timeline(w, w.drums.id)[0]).toMatchObject({ envelope: { gain: 0.5, fadeIn: 0.25, fadeOut: 0 } });
    apply(w.project, [{ type: "setAudioClipEnvelope", clip: { clipId: w.take.id }, fadeOut: 0.5 }]);
    expect(timeline(w, w.drums.id)[0]).toMatchObject({ envelope: { gain: 0.5, fadeIn: 0.25, fadeOut: 0.5 } });
  });

  it("setAudioClipGainAutomation replaces the clip's gain curve", () => {
    const w = world();
    applyAndUndo(w.project, [
      {
        type: "setAudioClipGainAutomation",
        clip: { clipId: w.take.id },
        points: [
          { atSourceSeconds: 0, value: 0 },
          { atSourceSeconds: 1, value: 1, shape: "hold" },
        ],
      },
    ]);
    expect(timeline(w, w.drums.id)[0]).toMatchObject({
      gainAutomation: {
        points: [
          { time: 0, value: 0, shape: "linear" },
          { time: 1, value: 1, shape: "hold" },
        ],
      },
    });
  });

  it("setVolumeAutomation takes beats or seconds for each point", () => {
    const w = world();
    applyAndUndo(w.project, [
      {
        type: "setVolumeAutomation",
        trackId: w.drums.id,
        points: [
          { atBeat: 0, value: 1 },
          { atSeconds: 2, value: 0.5, shape: "hold" },
        ],
      },
    ]);
    expect(w.project.tracks[0].volumeAutomation).toEqual([
      { time: 0, value: 1, shape: "linear" },
      { time: 2, value: 0.5, shape: "hold" },
    ]);
  });

  it("renames a clip with setClipName and edits a velocity with editNotes", () => {
    const w = world();
    applyAndUndo(w.project, [
      { type: "setClipName", clip: { clipId: w.pattern.id }, name: "Intro" },
      { type: "editNotes", clip: { clipId: w.pattern.id }, notes: [{ id: "n1", velocity: 0.9 }] },
    ]);
    expect(w.project.clipName(w.pattern.id)).toBe("Intro");
    expect((timeline(w, w.keys.id)[0] as MidiClip).midi.notes.value[0].velocity).toBe(0.9);
  });

  it("rejects bad clip operations and leaves the project as it was", () => {
    const w = world();
    const clip = { clipId: w.pattern.id };
    expect(reject(w.project, { type: "splitClip", clip, atBeat: 99 })).toMatchObject({ code: "edit-failed" });
    expect(reject(w.project, { type: "splitClip", clip, atBeat: 10, atSeconds: 4 }).reason).toContain("disagree");
    expect(reject(w.project, { type: "splitClip", clip })).toMatchObject({ code: "invalid-operation" });
    expect(reject(w.project, { type: "splitClip", clip, time: 1 }).reason).toContain('unknown field "time"');
    expect(reject(w.project, { type: "splitClip", clip: { clipId: "nope" }, atBeat: 10 })).toMatchObject({ code: "clip-not-found" });
    expect(reject(w.project, { type: "duplicateClip", clip, atBeat: 0, trackId: w.drums.id })).toMatchObject({ code: "edit-failed" });
    expect(reject(w.project, { type: "duplicateClip", clip, atBeat: 0, trackId: "nope" })).toMatchObject({ code: "track-not-found" });
    expect(reject(w.project, { type: "duplicateClip", clip, atBeat: 0, trackId: { fromCopy: "ghost" } })).toMatchObject({ code: "track-not-found" });
    expect(reject(w.project, { type: "removeClip", clip: { clipId: w.hook.id } })).toMatchObject({ code: "clip-not-found" });
    expect(reject(w.project, { type: "setClipLoop", clip, loop: { startSeconds: 0, endSeconds: 1 } }).reason).toContain("unknown field");
    expect(reject(w.project, { type: "setClipLoop", clip, loop: { startBeat: 2, endBeat: 1 } })).toMatchObject({ code: "edit-failed" });
    expect(reject(w.project, { type: "addMidiClip", trackId: w.keys.id, atBeat: 0, duration: 0 })).toMatchObject({ code: "invalid-operation" });
    expect(reject(w.project, { type: "addMidiClip", trackId: w.drums.id, atBeat: 0, duration: 4 })).toMatchObject({ code: "edit-failed" });
    expect(
      reject(w.project, { type: "addMidiClip", trackId: w.keys.id, atBeat: 0, duration: 4, notes: [], linkedTo: { clipId: w.pattern.id } }),
    ).toMatchObject({ code: "invalid-operation" });
    expect(reject(w.project, { type: "setAudioClipEnvelope", clip: { clipId: w.take.id } })).toMatchObject({ code: "invalid-operation" });
    expect(reject(w.project, { type: "setAudioClipEnvelope", clip: { clipId: w.take.id }, gain: -1 })).toMatchObject({ code: "invalid-operation" });
    expect(reject(w.project, { type: "setAudioClipEnvelope", clip, gain: 1, fadeIn: 1 })).toMatchObject({ code: "edit-failed" });
    expect(
      reject(w.project, {
        type: "setAudioClipGainAutomation",
        clip: { clipId: w.take.id },
        points: [{ atSourceSeconds: 0, value: 1, shape: "curvy" }],
      }),
    ).toMatchObject({ code: "invalid-operation" });
    expect(reject(w.project, { type: "setVolumeAutomation", trackId: w.drums.id, points: [{ value: 1 }] })).toMatchObject({
      code: "invalid-operation",
    });
    expect(reject(w.project, { type: "setClipName", clip, name: "  " })).toMatchObject({ code: "edit-failed" });
  });

  it("stops a request at the first bad step, rolling back the good ones before it", () => {
    const w = world();
    const before = fingerprint(w.project);
    const receipt = w.project.applyEdits({
      expectedVersion: version(w.project),
      label: "Mixed",
      ops: [
        { type: "removeClip", clip: { clipId: w.pattern.id } },
        { type: "addTrack", name: "X", kind: "audio" },
        { type: "splitClip", clip: { clipId: w.pattern.id }, atBeat: 10 },
      ],
    });
    expect(receipt).toMatchObject({ status: "rejected", opIndex: 2, code: "clip-not-found" });
    expect(fingerprint(w.project)).toBe(before);
  });

  it("returns conflict for a stale version and changes nothing", () => {
    const w = world();
    const stale = version(w.project);
    apply(w.project, [{ type: "setTitle", title: "Other" }]);
    const before = fingerprint(w.project);
    const receipt = w.project.applyEdits({ expectedVersion: stale, label: "Late", ops: [{ type: "removeClip", clip: { clipId: w.pattern.id } }] });
    expect(receipt.status).toBe("conflict");
    expect(fingerprint(w.project)).toBe(before);
  });
});
