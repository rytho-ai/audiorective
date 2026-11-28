import { describe, expect, it } from "vitest";
import { MidiClip } from "../src/project";
import { apply, applyAndUndo, fingerprint, reject, version, world } from "./edit-ops-support";

const track = (w: ReturnType<typeof world>, id: string) => w.project.tracks.find((item) => item.id === id)!;
const filter = { id: "f2", type: "filter", enabled: true, wet: 0.5, mode: "highpass", frequency: 200, q: 0.7 } as const;

describe("mixer, track and song edit operations", () => {
  it("sets a track's name, level, mute, solo and pan", () => {
    const w = world();
    applyAndUndo(w.project, [
      { type: "setTrackName", trackId: w.drums.id, name: "Kit" },
      { type: "setTrackVolume", trackId: w.drums.id, volume: 0.5 },
      { type: "setTrackMuted", trackId: w.drums.id, muted: true },
      { type: "setTrackSolo", trackId: w.keys.id, solo: true },
      { type: "setTrackPan", trackId: w.drums.id, pan: -0.25 },
    ]);
    expect(track(w, w.drums.id)).toMatchObject({ name: "Kit", volume: 0.5, muted: true, pan: -0.25 });
    expect(track(w, w.keys.id).solo).toBe(true);
  });

  it("sets the master level and the title", () => {
    const w = world();
    applyAndUndo(w.project, [
      { type: "setMasterVolume", volume: 0.7 },
      { type: "setTitle", title: "Demo" },
    ]);
    expect([w.project.masterVolume, w.project.title]).toEqual([0.7, "Demo"]);
  });

  it("routes a track to a bus with sends, and a request can route to a bus it adds", () => {
    const w = world();
    const receipt = applyAndUndo(w.project, [
      { type: "addTrack", name: "Room", kind: "bus", busRole: "effect", as: "room" },
      {
        type: "setTrackRouting",
        trackId: w.drums.id,
        routing: {
          outputBusId: w.aux.id,
          sends: [
            { busId: w.reverb.id, gain: 0.3 },
            { busId: { fromCopy: "room" }, gain: 1 },
          ],
        },
      },
    ]);
    const room = receipt.createdTracks[0];
    expect(room).toMatchObject({ as: "room" });
    expect(track(w, w.drums.id).routing).toEqual({
      outputBusId: w.aux.id,
      sends: [
        { busId: w.reverb.id, gain: 0.3 },
        { busId: room.id, gain: 1 },
      ],
    });
  });

  it("sets effects, a rack preset and a macro", () => {
    const w = world();
    applyAndUndo(w.project, [{ type: "setTrackEffects", trackId: w.drums.id, effects: [filter] }]);
    expect(track(w, w.drums.id).effects).toEqual([filter]);
    const preset = {
      effects: [filter],
      macros: [{ id: "tone", value: 0.4, targets: [{ slotId: "f2", parameter: "frequency", min: 200, max: 8000, scale: "exponential" }] }],
    };
    applyAndUndo(w.project, [{ type: "setTrackRackPreset", trackId: w.keys.id, preset }]);
    applyAndUndo(w.project, [{ type: "setTrackMacroValue", trackId: w.keys.id, macroId: "tone", value: 0.9 }]);
    expect(track(w, w.keys.id).effectMacros[0].value).toBe(0.9);
  });

  it("replaces tempo changes, time signatures and markers", () => {
    const w = world();
    applyAndUndo(w.project, [
      {
        type: "setTempoChanges",
        changes: [
          { beat: 0, bpm: 100 },
          { beat: 16, bpm: 140 },
        ],
      },
      {
        type: "setTimeSignatureChanges",
        changes: [
          { beat: 0, numerator: 3, denominator: 4 },
          { beat: 12, numerator: 4, denominator: 4 },
        ],
      },
      {
        type: "setMarkers",
        markers: [
          { name: "Drop", atBeat: 16 },
          { name: "Start", atSeconds: 0 },
        ],
      },
    ]);
    expect(w.project.bpm).toBe(100);
    expect(w.project.tempoMap.changes).toEqual([{ beat: 16, bpm: 140 }]);
    expect(w.project.signature).toEqual([3, 4]);
    expect(w.project.meterMap.changes).toEqual([{ beat: 12, numerator: 4, denominator: 4 }]);
    expect(w.project.markers.map(({ name }) => name)).toEqual(["Start", "Drop"]);
    // Beat 16 is 9.6 s at 100 BPM for 16 beats.
    expect(w.project.markers[1].time).toBeCloseTo(9.6);
  });

  it("adds a track and works with it in the same request, as one Undo step", () => {
    const w = world();
    const receipt = applyAndUndo(w.project, [
      { type: "addTrack", name: "Lead", kind: "midi", volume: 0.8, pan: 0.5, as: "lead" },
      { type: "addMidiClip", trackId: { fromCopy: "lead" }, atBeat: 0, duration: 4, as: "hook" },
      {
        type: "addNotes",
        clip: { fromCopy: "hook" },
        notes: [
          { pitch: 72, start: 0, duration: 1 },
          { pitch: 74, start: 1, duration: 1 },
        ],
      },
      { type: "setTrackName", trackId: { fromCopy: "lead" }, name: "Lead synth" },
    ]);
    const lead = w.project.tracks.at(-1)!;
    expect(receipt.createdTracks).toEqual([{ id: lead.id, as: "lead" }]);
    expect(lead).toMatchObject({ name: "Lead synth", volume: 0.8, pan: 0.5 });
    expect((lead.clips[0] as MidiClip).midi.notes.value.map(({ pitch }) => pitch)).toEqual([72, 74]);
    expect(receipt.createdNotes).toEqual([{ clipId: lead.clips[0].id, ids: expect.any(Array) }]);
    expect(receipt.created).toEqual([lead.clips[0].id]);
    expect(w.project.cells.history.value.undo).toBe("Test");
  });

  it("removes a track with its clips and clears the routes to a removed bus", () => {
    const w = world();
    apply(w.project, [{ type: "setTrackRouting", trackId: w.drums.id, routing: { outputBusId: w.aux.id } }]);
    applyAndUndo(w.project, [
      { type: "removeTrack", trackId: w.aux.id },
      { type: "removeTrack", trackId: w.keys.id },
    ]);
    expect(w.project.tracks.map(({ id }) => id)).toEqual([w.drums.id, w.bass.id, w.reverb.id]);
    expect(track(w, w.drums.id).routing.outputBusId).toBeNull();
  });

  it("removes and moves devices", () => {
    const w = world();
    applyAndUndo(w.project, [{ type: "moveDevice", deviceId: w.other.id, index: 0 }]);
    expect(track(w, w.keys.id).devices.map(({ id }) => id)).toEqual([w.other.id, w.synth.id]);
    applyAndUndo(w.project, [{ type: "removeDevice", deviceId: w.synth.id }]);
    expect(track(w, w.keys.id).devices.map(({ id }) => id)).toEqual([w.other.id]);
  });

  it("rejects bad mixer operations and leaves the project as it was", () => {
    const w = world();
    const t = w.drums.id;
    expect(reject(w.project, { type: "setTrackVolume", trackId: t, volume: -1 })).toMatchObject({ code: "invalid-operation" });
    expect(reject(w.project, { type: "setTrackVolume", trackId: t, volume: "loud" })).toMatchObject({ code: "invalid-operation" });
    expect(reject(w.project, { type: "setTrackVolume", trackId: t, value: 1 }).reason).toContain('unknown field "value"');
    expect(reject(w.project, { type: "setTrackVolume", trackId: "nope", volume: 1 })).toMatchObject({ code: "track-not-found" });
    expect(reject(w.project, { type: "setTrackPan", trackId: t, pan: 2 })).toMatchObject({ code: "invalid-operation" });
    expect(reject(w.project, { type: "setTrackMuted", trackId: t, muted: "yes" })).toMatchObject({ code: "invalid-operation" });
    expect(reject(w.project, { type: "setTrackSolo", trackId: t })).toMatchObject({ code: "invalid-operation" });
    expect(reject(w.project, { type: "setTrackName", trackId: t, name: " " })).toMatchObject({ code: "invalid-operation" });
    expect(reject(w.project, { type: "setMasterVolume", volume: -0.1 })).toMatchObject({ code: "invalid-operation" });
    expect(reject(w.project, { type: "setTitle", title: "" })).toMatchObject({ code: "invalid-operation" });
    expect(reject(w.project, { type: "setTrackRouting", trackId: t, routing: { outputBusId: w.keys.id } })).toMatchObject({ code: "edit-failed" });
    expect(reject(w.project, { type: "setTrackRouting", trackId: w.reverb.id, routing: { sends: [{ busId: w.reverb.id, gain: 1 }] } })).toMatchObject(
      {
        code: "edit-failed",
      },
    );
    expect(reject(w.project, { type: "setTrackEffects", trackId: t, effects: [{ id: "x", type: "nope" }] })).toMatchObject({ code: "edit-failed" });
    expect(reject(w.project, { type: "setTrackMacroValue", trackId: t, macroId: "none", value: 0.5 })).toMatchObject({ code: "edit-failed" });
    expect(reject(w.project, { type: "setTempoChanges", changes: [{ beat: 4, bpm: 0 }] })).toMatchObject({ code: "invalid-operation" });
    expect(reject(w.project, { type: "setTempoChanges", changes: [{ beat: 4, bpm: 90, curve: 1 }] }).reason).toContain('unknown field "curve"');
    expect(reject(w.project, { type: "setTimeSignatureChanges", changes: [{ beat: 4, numerator: 4, denominator: 3 }] })).toMatchObject({
      code: "edit-failed",
    });
    expect(reject(w.project, { type: "setMarkers", markers: [{ name: "A", time: 1 }] }).reason).toContain('unknown field "time"');
    expect(reject(w.project, { type: "setMarkers", markers: [{ name: "A" }] })).toMatchObject({ code: "invalid-operation" });
    expect(reject(w.project, { type: "addTrack", name: "X", kind: "synth" })).toMatchObject({ code: "invalid-operation" });
    expect(reject(w.project, { type: "addTrack", name: "X", kind: "audio", busRole: "submix" })).toMatchObject({ code: "edit-failed" });
    expect(reject(w.project, { type: "removeTrack", trackId: "nope" })).toMatchObject({ code: "track-not-found" });
    expect(reject(w.project, { type: "removeDevice", deviceId: "nope" })).toMatchObject({ code: "device-not-found" });
    expect(reject(w.project, { type: "moveDevice", deviceId: w.synth.id, index: 5 })).toMatchObject({ code: "edit-failed" });
  });

  it("rejects an `as` name used twice, and a name no step made", () => {
    const w = world();
    const before = fingerprint(w.project);
    const twice = w.project.applyEdits({
      expectedVersion: version(w.project),
      label: "Twice",
      ops: [
        { type: "addTrack", name: "A", kind: "audio", as: "x" },
        { type: "addScene", as: "x" },
      ],
    });
    expect(twice).toMatchObject({ status: "rejected", opIndex: 1, code: "invalid-operation" });
    expect(fingerprint(w.project)).toBe(before);
  });

  it("returns conflict for a stale version and changes nothing", () => {
    const w = world();
    const stale = version(w.project);
    apply(w.project, [{ type: "setTrackVolume", trackId: w.drums.id, volume: 0.2 }]);
    const before = fingerprint(w.project);
    expect(w.project.applyEdits({ expectedVersion: stale, label: "Late", ops: [{ type: "setMasterVolume", volume: 0.1 }] }).status).toBe("conflict");
    expect(fingerprint(w.project)).toBe(before);
  });

  it("refuses to undo a mixer step after a later change to the same track and keeps the later value", () => {
    const w = world();
    apply(w.project, [{ type: "setTrackVolume", trackId: w.drums.id, volume: 0.5 }]);
    w.project.setTrackVolume(w.drums.id, 0.9);
    expect(w.project.undo().status).toBe("conflict");
    expect(track(w, w.drums.id).volume).toBe(0.9);
  });
});
