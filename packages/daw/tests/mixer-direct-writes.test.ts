import { describe, expect, it } from "vitest";
import { Project, rackDeviceId, type DeviceParameterRecord } from "../src";

function song() {
  const project = new Project({ bpm: 120 });
  const track = project.addTrack("Keys", "midi");
  const device = project.addDevice(track.id, {
    kind: "webclap",
    pluginId: "com.example.synth",
    name: "Synth",
    vendor: "v",
    version: "1",
    bundleUrl: "/synth.wclap",
    parameters: [{ id: "3", name: "Cutoff", min: 0, max: 127, default: 64, value: 64 } satisfies DeviceParameterRecord],
  });
  project.setTrackEffects(track.id, [{ id: "lp", type: "filter", enabled: true, wet: 1, mode: "lowpass", frequency: 1000, q: 1 }]);
  return { project, track, device };
}

const track = (project: Project) => project.tracks[0];

describe("a direct mixer write is not a new song version", () => {
  it("leaves the version alone while the value and the revision change", () => {
    const { project, device } = song();
    const writes: Array<[string, () => void]> = [
      ["setTrackVolume", () => project.setTrackVolume(track(project).id, 0.4)],
      ["setTrackPan", () => project.setTrackPan(track(project).id, 0.3)],
      ["setTrackMuted", () => project.setTrackMuted(track(project).id, true)],
      ["setTrackSolo", () => project.setTrackSolo(track(project).id, true)],
      ["masterVolume", () => project.setMasterVolume(0.7)],
      ["setDeviceParameter (plug-in)", () => project.setDeviceParameter(device.id, "3", 100)],
      ["setDeviceParameter (rack)", () => project.setDeviceParameter(rackDeviceId(track(project).id, "lp"), "frequency", 2000)],
    ];
    for (const [name, write] of writes) {
      const version = project.cells.version.value;
      const revision = project.cells.revision.value;
      write();
      expect(project.cells.version.value, name).toBe(version);
      expect(project.cells.revision.value, name).toBeGreaterThan(revision);
      expect(project.cells.history.value.undo, name).toBeUndefined();
    }
    expect(track(project)).toMatchObject({ volume: 0.4, pan: 0.3, muted: true, solo: true });
    expect(project.masterVolume).toBe(0.7);
    expect(track(project).devices[0].parameters[0].value).toBe(100);
  });

  it("leaves the version alone for a rack macro", () => {
    const { project } = song();
    const id = track(project).id;
    project.setTrackRackPreset(id, {
      effects: [{ id: "lp", type: "filter", enabled: true, wet: 1, mode: "lowpass", frequency: 1000, q: 1 }],
      macros: [{ id: "tone", value: 0, targets: [{ slotId: "lp", parameter: "frequency", min: 200, max: 4000 }] }],
    });
    const version = project.cells.version.value;
    const revision = project.cells.revision.value;
    project.setTrackMacroValue(id, "tone", 0.5);
    expect(project.cells.version.value).toBe(version);
    expect(project.cells.revision.value).toBeGreaterThan(revision);
    expect(track(project).effectMacros[0].value).toBe(0.5);
  });

  it("does not turn another writer's applyEdits into a conflict", () => {
    const { project } = song();
    const id = track(project).id;
    const expectedVersion = project.cells.version.value;
    for (let step = 1; step <= 10; step++) project.setTrackVolume(id, step / 10);
    const receipt = project.applyEdits({ expectedVersion, label: "Rename", ops: [{ type: "setTrackName", trackId: id, name: "Lead" }] });
    expect(receipt.status).toBe("applied");
    expect(track(project)).toMatchObject({ name: "Lead", volume: 1 });
  });

  it("still advances the version and records one Undo step for an applyEdits that sets the level", () => {
    const { project } = song();
    const id = track(project).id;
    const expectedVersion = project.cells.version.value;
    const receipt = project.applyEdits({ expectedVersion, label: "Quieter", ops: [{ type: "setTrackVolume", trackId: id, volume: 0.25 }] });
    if (receipt.status !== "applied") throw new Error(receipt.reason);
    expect(receipt.version).not.toBe(expectedVersion);
    expect(project.cells.version.value).toBe(receipt.version);
    expect(project.cells.history.value.undo).toBe("Quieter");
    expect(project.undo().status).toBe("applied");
    expect(track(project).volume).toBe(1);
  });

  it("an edit that sets the same value overwrites a direct move without a conflict", () => {
    const { project } = song();
    const id = track(project).id;
    const expectedVersion = project.cells.version.value;
    project.setTrackVolume(id, 0.9);
    const receipt = project.applyEdits({ expectedVersion, label: "Set", ops: [{ type: "setTrackVolume", trackId: id, volume: 0.25 }] });
    expect(receipt.status).toBe("applied");
    expect(track(project).volume).toBe(0.25);
  });

  it("advances the version inside project.edit", () => {
    const { project } = song();
    const id = track(project).id;
    const version = project.cells.version.value;
    project.edit("Fader", () => project.setTrackVolume(id, 0.5));
    expect(project.cells.version.value).not.toBe(version);
    expect(project.cells.history.value.undo).toBe("Fader");
    const next = project.cells.version.value;
    project.edit("Master", () => project.setMasterVolume(0.5));
    expect(project.cells.version.value).not.toBe(next);
  });

  it("undo of an edit that set a level conflicts after a later direct write of that level", () => {
    const { project } = song();
    const id = track(project).id;
    project.edit("Fader", () => project.setTrackVolume(id, 0.5));
    project.setTrackVolume(id, 0.8);
    expect(project.undo().status).toBe("conflict");
    expect(track(project).volume).toBe(0.8);
  });
});
