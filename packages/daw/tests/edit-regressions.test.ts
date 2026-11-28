import { describe, expect, it } from "vitest";
import { Project, type ProjectEditOperation } from "../src/project";
import { apply, applyAndUndo, fingerprint, reject, version, world } from "./edit-ops-support";

const edit = (project: Project, ops: ProjectEditOperation[]) => project.applyEdits({ expectedVersion: version(project), label: "Edit", ops });
const track = (project: Project, id: string) => project.tracks.find((item) => item.id === id)!;

describe("Undo and Redo compare the values an edit changed, not the whole track", () => {
  it("keeps a later change to another key of the same track and restores only the edited key", () => {
    const w = world();
    expect(edit(w.project, [{ type: "setTrackVolume", trackId: w.drums.id, volume: 0.4 }]).status).toBe("applied");
    w.project.setTrackMuted(w.drums.id, true);
    expect(w.project.undo().status).toBe("applied");
    expect(track(w.project, w.drums.id)).toMatchObject({ volume: 1, muted: true });
    expect(w.project.redo().status).toBe("applied");
    expect(track(w.project, w.drums.id)).toMatchObject({ volume: 0.4, muted: true });
  });

  it("is not blocked by a later macro or insert change on the same track", () => {
    const w = world();
    const preset = {
      effects: [{ id: "f2", type: "filter", enabled: true, wet: 0.5, mode: "highpass", frequency: 200, q: 0.7 } as const],
      macros: [{ id: "tone", value: 0.4, targets: [{ slotId: "f2", parameter: "frequency", min: 200, max: 8000, scale: "exponential" as const }] }],
    };
    w.project.setTrackRackPreset(w.keys.id, preset);
    expect(edit(w.project, [{ type: "setTrackPan", trackId: w.keys.id, pan: 0.5 }]).status).toBe("applied");
    w.project.setTrackMacroValue(w.keys.id, "tone", 0.9);
    w.project.setTrackEffects(w.keys.id, []);
    expect(w.project.undo().status).toBe("applied");
    expect(track(w.project, w.keys.id)).toMatchObject({ pan: 0, effects: [] });
  });

  it("reports a conflict when a later change touched the same key, on Undo and on Redo", () => {
    const w = world();
    apply(w.project, [
      { type: "setTrackVolume", trackId: w.drums.id, volume: 0.4 },
      { type: "setTrackPan", trackId: w.drums.id, pan: -0.5 },
    ]);
    w.project.setTrackPan(w.drums.id, 0.25);
    expect(w.project.undo().status).toBe("conflict");
    expect(track(w.project, w.drums.id)).toMatchObject({ volume: 0.4, pan: 0.25 });
    w.project.setTrackPan(w.drums.id, -0.5);
    expect(w.project.undo().status).toBe("applied");
    w.project.setTrackVolume(w.drums.id, 0.7);
    expect(w.project.redo().status).toBe("conflict");
    w.project.setTrackVolume(w.drums.id, 1);
    expect(w.project.redo().status).toBe("applied");
  });

  it("applies the same rule to the title and the master level", () => {
    const w = world();
    apply(w.project, [{ type: "setTitle", title: "Demo" }]);
    w.project.setMasterVolume(0.5);
    expect(w.project.undo().status).toBe("applied");
    expect([w.project.title, w.project.masterVolume]).toEqual(["Song", 0.5]);
    apply(w.project, [{ type: "setMasterVolume", volume: 0.8 }]);
    w.project.setTitle("Other");
    expect(w.project.undo().status).toBe("applied");
    expect([w.project.title, w.project.masterVolume]).toEqual(["Other", 0.5]);
    apply(w.project, [{ type: "setTitle", title: "Demo" }]);
    w.project.setTitle("Later");
    expect(w.project.undo().status).toBe("conflict");
    apply(w.project, [{ type: "setMasterVolume", volume: 0.2 }]);
    w.project.setMasterVolume(0.3);
    expect(w.project.undo().status).toBe("conflict");
  });
});

describe("clips an edit makes answer to the overlap rule", () => {
  /** The clip `occupied` put on Bass. */
  const bassClipId = (w: ReturnType<typeof world>) => w.project.tracks.find((item) => item.id === w.bass.id)!.clips[0].id;
  /** A MIDI clip on Bass at beats 8 to 12, where `pattern` (Keys, beats 8 to 16) can land. */
  function occupied() {
    const w = world();
    w.project.addMidiClip(w.bass.id, { duration: 4, notes: [] }, 8);
    return w;
  }
  const cases: [string, (w: ReturnType<typeof occupied>) => ProjectEditOperation][] = [
    ["duplicateClip", (w) => ({ type: "duplicateClip", clip: { clipId: w.pattern.id }, atBeat: 10, trackId: w.bass.id })],
    ["duplicateClip on its own track", (w) => ({ type: "duplicateClip", clip: { clipId: w.pattern.id }, atBeat: 12 })],
    ["addMidiClip", (w) => ({ type: "addMidiClip", trackId: w.keys.id, atBeat: 12, duration: 2 })],
    ["copyToArrangement", (w) => ({ type: "copyToArrangement", slot: { sceneId: w.verse.id, trackId: w.keys.id }, atBeat: 8 })],
    ["moveClip to another track", (w) => ({ type: "moveClip", clip: { clipId: w.pattern.id }, trackId: w.bass.id, position: { atBeat: 10 } })],
  ];
  it.each(cases)("rejects %s onto an occupied place and changes nothing", (_name, make) => {
    const w = occupied();
    const before = fingerprint(w.project);
    const receipt = reject(w.project, make(w));
    expect(receipt.code).toBe("overlap");
    expect(receipt.reason).toContain("would overlap");
    expect(fingerprint(w.project)).toBe(before);
  });

  it("accepts the same operations next to the clip, and a copied range and a split still work", () => {
    const w = occupied();
    applyAndUndo(w.project, [
      { type: "duplicateClip", clip: { clipId: w.pattern.id }, atBeat: 12, trackId: w.bass.id },
      { type: "addMidiClip", trackId: w.keys.id, atBeat: 16, duration: 2 },
      { type: "copyToArrangement", slot: { sceneId: w.verse.id, trackId: w.keys.id }, atBeat: 18 },
      { type: "splitClip", clip: { clipId: w.pattern.id }, atBeat: 12, as: "right" },
      { type: "copyRange", range: { startBeat: 8, endBeat: 12 }, atBeat: 30, placement: "insert", as: "again" },
    ]);
  });

  it("judges a clip a request made on the final arrangement, so a later step can clear the place", () => {
    const w = occupied();
    applyAndUndo(w.project, [
      { type: "duplicateClip", clip: { clipId: w.pattern.id }, atBeat: 8, trackId: w.bass.id, as: "twin" },
      { type: "removeClip", clip: { clipId: bassClipId(w) } },
    ]);
  });
});

describe("the applied receipt names what the edit changed outside clips", () => {
  it("lists changed and removed tracks and scenes and the song settings", () => {
    const w = world();
    const receipt = apply(w.project, [
      { type: "setTrackName", trackId: w.drums.id, name: "Kit" },
      { type: "setTrackRouting", trackId: w.keys.id, routing: { outputBusId: w.aux.id, sends: [] } },
      { type: "setTempoChanges", changes: [{ beat: 8, bpm: 90 }] },
      { type: "setTimeSignatureChanges", changes: [{ beat: 4, numerator: 3, denominator: 4 }] },
      { type: "setMarkers", markers: [{ name: "A", atBeat: 2 }] },
      { type: "setTitle", title: "Demo" },
      { type: "setMasterVolume", volume: 0.7 },
      { type: "renameScene", sceneId: w.verse.id, name: "Intro" },
      { type: "removeScene", sceneId: w.chorus.id },
      { type: "removeTrack", trackId: w.bass.id },
    ]);
    expect([...receipt.changedTracks].sort()).toEqual([w.drums.id, w.keys.id].sort());
    expect(receipt.removedTracks).toEqual([w.bass.id]);
    expect(receipt.changedScenes).toEqual([w.verse.id]);
    expect(receipt.removedScenes).toEqual([w.chorus.id]);
    expect(receipt.song).toEqual(["tempo", "timeSignature", "markers", "title", "masterVolume"]);
  });

  it("is empty for an edit that touches only clips, and Undo reports what it took away", () => {
    const w = world();
    const clips = apply(w.project, [{ type: "setClipName", clip: { clipId: w.take.id }, name: "Loud" }]);
    expect([clips.changedTracks, clips.removedTracks, clips.changedScenes, clips.removedScenes, clips.song]).toEqual([[], [], [], [], []]);
    const added = apply(w.project, [{ type: "addTrack", name: "New", kind: "audio", as: "n" }]);
    expect(added.removedTracks).toEqual([]);
    const undone = w.project.undo();
    if (undone.status !== "applied") throw new Error(undone.status);
    expect(undone.removedTracks).toEqual([added.createdTracks[0].id]);
    const volume = apply(w.project, [{ type: "setTrackVolume", trackId: w.drums.id, volume: 0.5 }]);
    expect(volume.changedTracks).toEqual([w.drums.id]);
    const back = w.project.undo();
    if (back.status !== "applied") throw new Error(back.status);
    expect(back.changedTracks).toEqual([w.drums.id]);
  });
});

describe("a position row with both atBeat and atSeconds", () => {
  it("is accepted when they name the same moment and rejected, with a reason, when they differ", () => {
    const w = world();
    // 120 BPM: beat 10 is 5 seconds.
    apply(w.project, [{ type: "setMarkers", markers: [{ name: "Both", atBeat: 10, atSeconds: 5 }] }]);
    expect(w.project.markers).toEqual([{ time: 5, name: "Both" }]);
    const bad = reject(w.project, { type: "setMarkers", markers: [{ name: "Off", atBeat: 10, atSeconds: 5.01 }] });
    expect(bad.code).toBe("invalid-operation");
    expect(bad.reason).toContain("disagree");
    for (const op of [
      { type: "setVolumeAutomation", trackId: w.drums.id, points: [{ atBeat: 4, atSeconds: 3, value: 1 }] },
      { type: "splitClip", clip: { clipId: w.take.id }, atBeat: 8, atSeconds: 3 },
      { type: "duplicateClip", clip: { clipId: w.take.id }, atBeat: 20, atSeconds: 11 },
      { type: "copyToArrangement", slot: { sceneId: w.verse.id, trackId: w.keys.id }, atBeat: 40, atSeconds: 19 },
    ])
      expect(reject(w.project, op).reason).toContain("disagree");
    applyAndUndo(w.project, [{ type: "splitClip", clip: { clipId: w.take.id }, atBeat: 8, atSeconds: 4 }]);
  });
});

describe("a whole-list edit that sends the current list back changes nothing", () => {
  it("returns noop for tempo, signatures, markers, automation, effects and routing", () => {
    const w = world();
    apply(w.project, [
      { type: "setTempoChanges", changes: [{ beat: 8, bpm: 97 }] },
      { type: "setTimeSignatureChanges", changes: [{ beat: 4, numerator: 3, denominator: 4 }] },
      { type: "setMarkers", markers: [{ name: "A", atBeat: 5.5 }] },
      {
        type: "setVolumeAutomation",
        trackId: w.drums.id,
        points: [
          { atBeat: 1, value: 0.5 },
          { atBeat: 3.3, value: 1, shape: "hold" },
        ],
      },
      { type: "setTrackRouting", trackId: w.drums.id, routing: { outputBusId: w.aux.id, sends: [{ busId: w.reverb.id, gain: 0.3 }] } },
    ]);
    const p = w.project;
    const before = fingerprint(p);
    const v = version(p);
    const receipt = edit(p, [
      { type: "setTempoChanges", changes: [...p.tempoMap.changes] },
      { type: "setTimeSignatureChanges", changes: [...p.meterMap.changes] },
      { type: "setMarkers", markers: p.markers.map(({ name, time }) => ({ name, atSeconds: time })) },
      {
        type: "setVolumeAutomation",
        trackId: w.drums.id,
        points: track(p, w.drums.id).volumeAutomation.map(({ time, value, shape }) => ({ atSeconds: time, value, shape })),
      },
      { type: "setTrackEffects", trackId: w.drums.id, effects: [...track(p, w.drums.id).effects] },
      { type: "setTrackRouting", trackId: w.drums.id, routing: track(p, w.drums.id).routing },
    ]);
    expect(receipt).toMatchObject({ status: "applied", version: v });
    expect(version(p)).toBe(v);
    expect(fingerprint(p)).toBe(before);
    expect(p.cells.history.value.undo).not.toBe("Edit");
  });
});
