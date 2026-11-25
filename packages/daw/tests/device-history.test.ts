import { describe, expect, test } from "vitest";
import { Project, openDawProject, saveDawProject } from "../src";
import { captureDeviceState } from "../src/model";

const details = (name: string, state?: number[]) => ({
  pluginId: `com.example.${name}`,
  name,
  vendor: "v",
  version: "1",
  bundleUrl: `/${name}.wclap`,
  ...(state ? { state: new Uint8Array(state) } : {}),
});

function song() {
  const project = new Project({ bpm: 120 });
  const track = project.addTrack("Keys", "midi");
  const other = project.addTrack("Bass", "midi");
  return { project, track, other };
}
const names = (project: Project, index = 0) => project.tracks[index].devices.map((device) => device.name);

describe("device add, remove and reorder in project.edit", () => {
  test("add is one Undo step: undo removes the device and frees its id, redo brings it back with its state", () => {
    const { project, track } = song();
    let id = "";
    project.edit("Add Synth", () => {
      id = project.addWebClapDevice(track.id, details("synth", [1, 2, 3])).id;
    });
    expect(project.cells.history.value.undo).toBe("Add Synth");
    expect(names(project)).toEqual(["synth"]);
    expect(project.undo().status).toBe("applied");
    expect(names(project)).toEqual([]);
    expect(project.cells.history.value.redo).toBe("Add Synth");
    // The id is free again while the device is gone.
    expect(() => project.addWebClapDevice(track.id, { ...details("probe"), id })).not.toThrow();
    project.removeDevice(id);
    expect(project.redo().status).toBe("applied");
    expect(project.tracks[0].devices).toHaveLength(1);
    expect(project.tracks[0].devices[0]).toMatchObject({ id, pluginId: "com.example.synth", state: new Uint8Array([1, 2, 3]) });
    project.dispose();
  });

  test("remove and reorder are Undo steps that restore the list order and each device's state", () => {
    const { project, track } = song();
    const a = project.addWebClapDevice(track.id, details("a", [1]));
    const b = project.addWebClapDevice(track.id, details("b", [2]));
    const c = project.addWebClapDevice(track.id, details("c", [3]));
    project.edit("Remove B", () => project.removeDevice(b.id));
    expect(names(project)).toEqual(["a", "c"]);
    project.edit("Move C first", () => project.moveDevice(c.id, 0));
    expect(names(project)).toEqual(["c", "a"]);
    project.undo();
    expect(names(project)).toEqual(["a", "c"]);
    project.undo();
    expect(project.tracks[0].devices.map((device) => [device.name, [...device.state]])).toEqual([
      ["a", [1]],
      ["b", [2]],
      ["c", [3]],
    ]);
    project.redo();
    project.redo();
    expect(names(project)).toEqual(["c", "a"]);
    expect(a.id).not.toBe(c.id);
    project.dispose();
  });

  test("setDeviceState inside an edit is an Undo step too", () => {
    const { project, track } = song();
    const device = project.addWebClapDevice(track.id, details("a", [1]));
    project.edit("Tweak", () => project.setDeviceState(device.id, new Uint8Array([9])));
    expect([...project.tracks[0].devices[0].state]).toEqual([9]);
    project.undo();
    expect([...project.tracks[0].devices[0].state]).toEqual([1]);
    project.dispose();
  });

  test("moveDevice validates, and the same position is no change", () => {
    const { project, track } = song();
    const a = project.addWebClapDevice(track.id, details("a"));
    project.addWebClapDevice(track.id, details("b"));
    const version = project.cells.version.value;
    project.moveDevice(a.id, 0);
    expect(project.cells.version.value).toBe(version);
    project.moveDevice(a.id, 1);
    expect(names(project)).toEqual(["b", "a"]);
    expect(() => project.moveDevice(a.id, 2)).toThrow("Project moveDevice needs a position from 0 to 1.");
    expect(() => project.moveDevice(a.id, 0.5)).toThrow("Project moveDevice needs a position from 0 to 1.");
    expect(() => project.moveDevice("nope", 0)).toThrow("Project device needs an existing track.");
    project.dispose();
  });

  test("outside project.edit a device change is still not an Undo step", () => {
    const { project, track } = song();
    project.addWebClapDevice(track.id, details("a"));
    expect(project.cells.history.value).toEqual({});
    project.dispose();
  });

  test("a failed edit puts the devices back", () => {
    const { project, track } = song();
    const a = project.addWebClapDevice(track.id, details("a", [1]));
    expect(() =>
      project.edit("Broken", () => {
        project.removeDevice(a.id);
        project.addWebClapDevice(track.id, details("b"));
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(project.tracks[0].devices).toEqual([a]);
    expect(project.cells.history.value).toEqual({});
    // The rolled-back ids are reserved again.
    expect(() => project.addWebClapDevice(track.id, { ...details("x"), id: a.id })).toThrow("Project IDs must be unique XML IDs.");
    project.dispose();
  });

  test("an edit that also touches clips is one step", () => {
    const { project, track } = song();
    project.edit("Both", () => {
      project.addWebClapDevice(track.id, details("a"));
      project.addMidiClip(track.id, { notes: [], duration: 1 }, 0);
    });
    project.undo();
    expect(project.tracks[0].devices).toEqual([]);
    expect(project.tracks[0].clips).toEqual([]);
    project.redo();
    expect(names(project)).toEqual(["a"]);
    expect(project.tracks[0].clips).toHaveLength(1);
    project.dispose();
  });

  test("undo reports a conflict once the track is gone, and a live state refresh does not block it", () => {
    const { project, track, other } = song();
    project.edit("Add", () => void project.addWebClapDevice(other.id, details("a", [1])));
    project.edit("Add on keys", () => void project.addWebClapDevice(track.id, details("k")));
    // A state change that is not an edit leaves the step undoable (below).
    project.removeTrack(track.id);
    expect(project.undo().status).toBe("conflict");
    project.dispose();
    const second = song();
    second.project.edit("Add", () => void second.project.addWebClapDevice(second.other.id, details("a", [1])));
    second.project.setDeviceState(second.project.tracks[1].devices[0].id, new Uint8Array([7]));
    expect(second.project.undo().status).toBe("applied");
    expect(names(second.project, 1)).toEqual([]);
    second.project.dispose();
  });

  test("the last state of a device Undo took away is kept for Redo", () => {
    const { project, track } = song();
    const device = project.edit("Add", () => project.addWebClapDevice(track.id, details("a", [1])));
    project.undo();
    // The runtime reads the running plug-in's state as it removes it.
    captureDeviceState(project, device.id, new Uint8Array([8, 8]));
    expect(project.cells.history.value).toEqual({ redo: "Add" });
    project.redo();
    expect([...project.tracks[0].devices[0].state]).toEqual([8, 8]);
    project.undo();
    captureDeviceState(project, device.id, new Uint8Array([6]));
    project.redo();
    project.undo();
    expect(project.tracks[0].devices).toEqual([]);
    project.dispose();
  });

  test("a device change survives save and reopen after undo and redo", () => {
    const { project, track } = song();
    project.edit("Add", () => void project.addWebClapDevice(track.id, details("a", [5])));
    project.undo();
    project.redo();
    const reopened = openDawProject(saveDawProject(project)).project;
    expect(reopened.tracks[0].devices.map((device) => [device.name, [...device.state]])).toEqual([["a", [5]]]);
    project.dispose();
    reopened.dispose();
  });
  test("undoing another device's add or move keeps a tuned device's state", () => {
    const { project, track } = song();
    const a = project.addWebClapDevice(track.id, details("a", [1]));
    // The running plug-in is tuned after the edit starts: a live capture, not an edit.
    project.edit("Add B", () => void project.addWebClapDevice(track.id, details("b", [2])));
    captureDeviceState(project, a.id, new Uint8Array([9]));
    expect(project.undo().status).toBe("applied");
    expect(names(project)).toEqual(["a"]);
    expect([...project.tracks[0].devices[0].state]).toEqual([9]);
    project.redo();
    expect(project.tracks[0].devices.map((device) => [device.name, [...device.state]])).toEqual([
      ["a", [9]],
      ["b", [2]],
    ]);
    project.edit("Move B first", () => project.moveDevice(project.tracks[0].devices[1].id, 0));
    captureDeviceState(project, a.id, new Uint8Array([7]));
    project.undo();
    expect(project.tracks[0].devices.map((device) => [device.name, [...device.state]])).toEqual([
      ["a", [7]],
      ["b", [2]],
    ]);
    project.dispose();
  });

  test("undoing setDeviceState still restores that device's state", () => {
    const { project, track } = song();
    const a = project.addWebClapDevice(track.id, details("a", [1]));
    project.addWebClapDevice(track.id, details("b", [2]));
    project.edit("Tweak a", () => project.setDeviceState(a.id, new Uint8Array([5])));
    project.undo();
    expect([...project.tracks[0].devices[0].state]).toEqual([1]);
    project.redo();
    expect([...project.tracks[0].devices[0].state]).toEqual([5]);
    project.dispose();
  });
});
