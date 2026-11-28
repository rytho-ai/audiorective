import { describe, expect, test } from "vitest";
import { MeterMap, Project } from "../src";

const pcm = () => ({ sampleRate: 48000, channels: [new Float32Array(4800)] });
const ids = (project: Project) => project.tracks.map((track) => track.id);

describe("track add and remove in project.edit", () => {
  test("adding tracks with clips is one Undo step; redo brings tracks, clips and mixer settings back", () => {
    const project = new Project({ bpm: 120 });
    const keep = project.addTrack("Keep", "audio");
    let drums = "";
    let clip = "";
    project.edit("Import", () => {
      const track = project.addTrack("Drums", "midi", { volume: 0.5, pan: -0.25, muted: true });
      drums = track.id;
      clip = project.addMidiClip(track.id, { notes: [{ pitch: 36, velocity: 1, start: 0, duration: 1 }], duration: 4 }, 0, { name: "Beat" }).id;
      project.addAudioClip(project.addTrack("Loop", "audio").id, pcm(), 0);
    });
    expect(project.cells.history.value.undo).toBe("Import");
    expect(ids(project)).toHaveLength(3);
    expect(project.undo().status).toBe("applied");
    expect(ids(project)).toEqual([keep.id]);
    // The ids are free while the tracks are gone.
    expect(() => project.addTrack("probe", "audio", { id: drums })).not.toThrow();
    project.removeTrack(drums);
    expect(project.redo().status).toBe("applied");
    expect(project.tracks.map((track) => track.name)).toEqual(["Keep", "Drums", "Loop"]);
    const restored = project.tracks[1];
    expect(restored).toMatchObject({ id: drums, volume: 0.5, pan: -0.25, muted: true });
    expect(restored.clips[0]).toMatchObject({ id: clip });
    expect(project.clipName(clip)).toBe("Beat");
    project.dispose();
  });

  test("removing a track is undoable and restores its clips, devices, volume automation, routing and the routes that pointed at it", () => {
    const project = new Project({ bpm: 120 });
    const bus = project.addTrack("Reverb", "bus", { busRole: "effect" });
    const lead = project.addTrack("Lead", "midi");
    const other = project.addTrack("Other", "midi");
    project.setTrackRouting(lead.id, { outputBusId: null, sends: [{ busId: bus.id, gain: 0.3 }] });
    project.setTrackRouting(other.id, { outputBusId: bus.id, sends: [] });
    const clip = project.addMidiClip(lead.id, { notes: [{ pitch: 60, velocity: 0.8, start: 0, duration: 2 }], duration: 4 }, 8);
    project.setVolumeAutomation(lead.id, [{ time: 0, value: 1, shape: "linear" }]);
    const device = project.addDevice(lead.id, {
      kind: "webclap",
      pluginId: "p",
      name: "Synth",
      vendor: "v",
      version: "1",
      bundleUrl: "/s.wclap",
      state: new Uint8Array([7]),
    });

    project.edit("Remove bus", () => project.removeTrack(bus.id));
    expect(project.tracks.find((track) => track.id === other.id)!.routing.outputBusId).toBeNull();
    expect(project.tracks.find((track) => track.id === lead.id)!.routing.sends).toEqual([]);
    expect(project.undo().status).toBe("applied");
    expect(ids(project)).toEqual([bus.id, lead.id, other.id]);
    expect(project.tracks[2].routing.outputBusId).toBe(bus.id);
    expect(project.tracks[1].routing.sends).toEqual([{ busId: bus.id, gain: 0.3 }]);
    expect(project.redo().status).toBe("applied");
    expect(ids(project)).toEqual([lead.id, other.id]);

    project.edit("Remove Lead", () => project.removeTrack(lead.id));
    expect(project.undo().status).toBe("applied");
    const back = project.tracks.find((track) => track.id === lead.id)!;
    expect(project.tracks.indexOf(back)).toBe(0);
    expect(back.clips).toHaveLength(1);
    expect(back.clips[0].id).toBe(clip.id);
    expect(back.clips[0].kind === "midi" && back.clips[0].midi.notes.value).toHaveLength(1);
    expect(back.volumeAutomation).toEqual([{ time: 0, value: 1, shape: "hold" }]);
    expect(back.devices).toHaveLength(1);
    expect(back.devices[0]).toMatchObject({ id: device.id, state: new Uint8Array([7]) });
    // The restored clip still plays: its notes are intact and it is not disposed.
    expect((back.clips[0] as typeof clip).playbackEvents().length).toBe(2);
    project.dispose();
  });

  test("undo conflicts when a later change touched the track, and leaves everything in place", () => {
    const project = new Project({ bpm: 120 });
    let id = "";
    project.edit("Add", () => {
      id = project.addTrack("New", "midi").id;
    });
    // A clip added to the track after the edit blocks undoing its creation.
    const clip = project.addMidiClip(id, { notes: [], duration: 2 }, 0);
    expect(project.undo().status).toBe("conflict");
    expect(ids(project)).toEqual([id]);
    project.removeClip(clip.id);
    // A track routed to a bus created by the edit blocks removing it too.
    const other = project.addTrack("Other", "audio");
    let bus = "";
    project.edit("Add bus", () => {
      bus = project.addTrack("Bus", "bus", { busRole: "submix" }).id;
    });
    project.setTrackRouting(other.id, { outputBusId: bus, sends: [] });
    expect(project.undo().status).toBe("conflict");
    expect(ids(project)).toContain(bus);

    const p2 = new Project({ bpm: 120 });
    const t = p2.addTrack("T", "audio");
    p2.edit("Remove", () => p2.removeTrack(t.id));
    // Another track took the id in between.
    p2.addTrack("Squatter", "audio", { id: t.id });
    expect(p2.undo().status).toBe("conflict");
    expect(p2.tracks).toHaveLength(1);
    // Undo with expectedVersion refuses a moved project.
    const version = p2.cells.version.value;
    p2.setTitle("Moved");
    expect(p2.undo({ expectedVersion: version }).status).toBe("conflict");
    project.dispose();
    p2.dispose();
  });

  test("redo conflicts when a restored clip's neighbour arrived, and a failed edit rolls the tracks back", () => {
    const project = new Project({ bpm: 120 });
    const track = project.addTrack("A", "midi");
    expect(() =>
      project.edit("Boom", () => {
        project.removeTrack(track.id);
        project.addTrack("B", "audio");
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(ids(project)).toEqual([track.id]);
    expect(project.cells.history.value.undo).toBeUndefined();
    // Track settings join an edit like anything else.
    project.edit("Rename", () => project.setTrackName(track.id, "Z"));
    expect(project.tracks[0].name).toBe("Z");
    expect(project.undo().status).toBe("applied");
    expect(project.tracks[0].name).toBe("A");
    project.dispose();
  });

  test("track edits inside applyEdits-style operations join one step with note edits and the history list stays ordered", () => {
    const project = new Project({ bpm: 120 });
    project.edit("One", () => project.addTrack("1", "audio"));
    project.edit("Two", () => project.addTrack("2", "audio"));
    expect(project.undo().status).toBe("applied");
    expect(project.tracks.map((t) => t.name)).toEqual(["1"]);
    expect(project.undo().status).toBe("applied");
    expect(project.tracks).toHaveLength(0);
    expect(project.redo().status).toBe("applied");
    expect(project.redo().status).toBe("applied");
    expect(project.tracks.map((t) => t.name)).toEqual(["1", "2"]);
    project.dispose();
  });
});

describe("time signature changes", () => {
  test("MeterMap counts bars across changes and a change inside a bar cuts that bar short", () => {
    const meter = new MeterMap(
      [4, 4],
      [
        { beat: 32, numerator: 3, denominator: 4 },
        { beat: 41, numerator: 6, denominator: 8 },
      ],
    );
    expect(meter.beatToBar(0)).toEqual({ bar: 1, beatInBar: 0, barStart: 0 });
    expect(meter.beatToBar(31.5)).toMatchObject({ bar: 8, beatInBar: 3.5 });
    expect(meter.beatToBar(32)).toMatchObject({ bar: 9, beatInBar: 0 });
    expect(meter.beatToBar(36)).toMatchObject({ bar: 10, beatInBar: 1 });
    expect(meter.barToBeat(9)).toBe(32);
    expect(meter.barToBeat(12)).toBe(41);
    // 6/8 is three quarter-note beats per bar.
    expect(meter.barToBeat(13)).toBe(44);
    expect(meter.barBeatsAt(42)).toBe(3);
    expect(meter.signatureAtBeat(40.9)).toEqual([3, 4]);
    expect(meter.ceilToBar(33)).toBe(35);
    expect(meter.ceilToBar(35)).toBe(35);
    expect(() => new MeterMap([4, 4], [{ beat: 8, numerator: 4, denominator: 3 }])).toThrow(/time signatures/);
    expect(() => meter.barToBeat(0)).toThrow(/count from 1/);
  });

  test("Project time signature changes are one undoable step; a beat-0 change sets the starting signature", () => {
    const project = new Project({ bpm: 120 });
    project.edit("Meter", () =>
      project.setTimeSignatureChanges([
        { beat: 0, numerator: 7, denominator: 8 },
        { beat: 14, numerator: 4, denominator: 4 },
      ]),
    );
    expect(project.signature).toEqual([7, 8]);
    expect(project.meterMap.changes).toEqual([{ beat: 14, numerator: 4, denominator: 4 }]);
    expect(project.meterMap.barToBeat(5)).toBe(14);
    expect(project.undo().status).toBe("applied");
    expect(project.signature).toEqual([4, 4]);
    expect(project.meterMap.changes).toEqual([]);
    expect(project.redo().status).toBe("applied");
    expect(project.signature).toEqual([7, 8]);
    project.setTimeSignatureChanges([{ beat: 8, numerator: 3, denominator: 4 }]);
    expect(project.signature).toEqual([7, 8]);
    // A later meter edit blocks undoing the earlier one.
    expect(project.undo().status).toBe("conflict");
    const copy = project.snapshot();
    expect(copy.meterMap.changes).toEqual(project.meterMap.changes);
    expect(copy.signature).toEqual([7, 8]);
    expect(() =>
      project.setTimeSignatureChanges([
        { beat: 0, numerator: 4, denominator: 4 },
        { beat: 0, numerator: 3, denominator: 4 },
      ]),
    ).toThrow(/time signatures/);
    copy.dispose();
    project.dispose();
  });
});
