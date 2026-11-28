import { describe, expect, test } from "vitest";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { Project, openDawProject, rackDeviceId, saveDawProject, type DeviceParameterRecord, type RackEffect } from "../src";
import { rackSlotParameters } from "../src/device-parameters";
import { captureDeviceParameters, captureDeviceState } from "../src/model";

const table = (): DeviceParameterRecord[] => [
  { id: "3", name: "Cutoff", min: 0, max: 127, default: 64, value: 64 },
  { id: "5", name: "Mode", min: 0, max: 4, default: 1, value: 1, step: 1 },
  { id: "9", name: "Gain", min: -24, max: 24, default: 0, value: 0 },
];

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
    parameters: table(),
  });
  project.setTrackEffects(track.id, [
    { id: "lp", type: "filter", enabled: true, wet: 1, mode: "lowpass", frequency: 1000, q: 1 },
    { id: "echo", type: "delay", enabled: true, wet: 0.5, delayTime: 0.25, feedback: 0.3 },
    { id: "eq", type: "eq", enabled: true, wet: 1, bands: [{ frequency: 100, gain: 0, q: 1 }] },
  ]);
  return { project, track, device };
}
/** One Undo step: like every Project edit method, `setDeviceParameter` joins a step only inside `project.edit` or `applyEdits`. */
const set = (project: Project, deviceId: string, parameterId: string, to: number, label = "Set parameter") =>
  project.edit(label, () => project.setDeviceParameter(deviceId, parameterId, to));
const value = (project: Project, id: string, trackIndex = 0) =>
  project.tracks[trackIndex].devices[0].parameters.find((item) => item.id === id)!.value;
const effect = (project: Project, id: string) => project.tracks[0].effects.find((item) => item.id === id) as RackEffect & Record<string, unknown>;

describe("setDeviceParameter on a WebCLAP device", () => {
  test("sets a value inside the range as one Undo step and Undo restores it", () => {
    const { project, device } = song();
    const version = project.cells.version.value;
    set(project, device.id, "3", 100);
    expect(value(project, "3")).toBe(100);
    expect(project.cells.version.value).not.toBe(version);
    expect(project.cells.history.value.undo).toBeDefined();
    expect(project.undo().status).toBe("applied");
    expect(value(project, "3")).toBe(64);
    expect(project.redo().status).toBe("applied");
    expect(value(project, "3")).toBe(100);
    project.dispose();
  });

  test("joins the surrounding project.edit step with other changes", () => {
    const { project, device, track } = song();
    project.edit("Brighter", () => {
      project.setDeviceParameter(device.id, "3", 120);
      project.setTrackVolume(track.id, 0.5);
    });
    expect(project.cells.history.value.undo).toBe("Brighter");
    project.undo();
    expect(value(project, "3")).toBe(64);
    expect(project.tracks[0].volume).toBe(1);
    project.dispose();
  });

  test("setting the value it already has is no change", () => {
    const { project, device } = song();
    const version = project.cells.version.value;
    project.setDeviceParameter(device.id, "3", 64);
    expect(project.cells.version.value).toBe(version);
    expect(project.cells.history.value.undo).toBeUndefined();
    project.dispose();
  });

  test("a stepped parameter snaps to the nearest whole step and reports it; a continuous one and a rack parameter keep the value", () => {
    const { project, device, track } = song();
    expect(project.setDeviceParameter(device.id, "5", 2.4)).toBe(2);
    expect(value(project, "5")).toBe(2);
    expect(project.setDeviceParameter(device.id, "5", 2.5)).toBe(3);
    expect(project.setDeviceParameter(device.id, "3", 53.9)).toBe(53.9);
    expect(value(project, "3")).toBe(53.9);
    expect(project.setDeviceParameter(rackDeviceId(track.id, "lp"), "frequency", 1234.5)).toBe(1234.5);
    expect(project.setDeviceParameter(rackDeviceId(track.id, "lp"), "mode", 0.7)).toBe(1);
    expect(effect(project, "lp").mode).toBe("highpass");
    project.dispose();
  });

  test("a stepped range that does not end on a step never snaps past max", () => {
    const project = new Project({ bpm: 120 });
    const track = project.addTrack("K", "midi");
    const device = project.addDevice(track.id, {
      kind: "webclap",
      pluginId: "p",
      name: "P",
      vendor: "v",
      version: "1",
      bundleUrl: "/p",
      parameters: [{ id: "1", name: "S", min: 0.5, max: 2.3, default: 0.5, value: 0.5, step: 1 }],
    });
    expect(project.setDeviceParameter(device.id, "1", 2.3)).toBe(1.5);
    expect(project.setDeviceParameter(device.id, "1", 2.2)).toBe(1.5);
    project.dispose();
  });

  test("refuses a value outside the range, an unknown parameter and an empty table", () => {
    const { project, device, track } = song();
    expect(() => project.setDeviceParameter(device.id, "3", 128)).toThrow('Project device parameter "3" needs a number from 0 to 127.');
    expect(() => project.setDeviceParameter(device.id, "3", Number.NaN)).toThrow(RangeError);
    expect(() => project.setDeviceParameter(device.id, "5", 4.5)).toThrow('Project device parameter "5" needs a number from 0 to 4.');
    expect(() => project.setDeviceParameter(device.id, "77", 1)).toThrow(`Project device "${device.id}" has no parameter "77".`);
    const bare = project.addDevice(track.id, { kind: "webclap", pluginId: "b", name: "B", vendor: "v", version: "1", bundleUrl: "/b" });
    expect(() => project.setDeviceParameter(bare.id, "1", 1)).toThrow("has no parameter table yet");
    expect(() => project.setDeviceParameter("nope", "1", 1)).toThrow('Project device "nope" does not exist');
    expect(value(project, "3")).toBe(64);
    project.dispose();
  });

  test("a value the plug-in moves by itself is not an Undo step and does not roll back with another step", () => {
    const { project, device } = song();
    set(project, device.id, "3", 100);
    const version = project.cells.version.value;
    const undoLabel = project.cells.history.value.undo;
    // The plug-in's own automation or its GUI moves Gain.
    captureDeviceParameters(
      project,
      device.id,
      project.tracks[0].devices[0].parameters.map((item) => (item.id === "9" ? { ...item, value: 6 } : item)),
    );
    expect(project.cells.version.value).toBe(version);
    expect(project.cells.history.value.undo).toBe(undoLabel);
    expect(value(project, "9")).toBe(6);
    project.undo();
    expect(value(project, "3")).toBe(64);
    expect(value(project, "9")).toBe(6);
    project.dispose();
  });

  test("Undo is a conflict when the same parameter moved since, and leaves that value", () => {
    const { project, device } = song();
    set(project, device.id, "3", 100);
    captureDeviceParameters(
      project,
      device.id,
      project.tracks[0].devices[0].parameters.map((item) => (item.id === "3" ? { ...item, value: 33 } : item)),
    );
    expect(project.undo().status).toBe("conflict");
    expect(value(project, "3")).toBe(33);
    project.dispose();
  });

  test("setDeviceState empties the table (the bytes carry their own values) and Undo brings both back", () => {
    const { project, device } = song();
    set(project, device.id, "3", 100);
    project.edit("Preset", () => project.setDeviceState(device.id, new Uint8Array([1, 2, 3])));
    expect(project.tracks[0].devices[0].parameters).toEqual([]);
    project.undo();
    expect(project.tracks[0].devices[0].state).toEqual(new Uint8Array());
    expect(value(project, "3")).toBe(100);
    project.redo();
    expect(project.tracks[0].devices[0].parameters).toEqual([]);
    project.dispose();
  });

  test("a captured state keeps the table", () => {
    const { project, device } = song();
    captureDeviceState(project, device.id, new Uint8Array([9]));
    expect(project.tracks[0].devices[0].parameters).toHaveLength(3);
    project.dispose();
  });

  test("addDevice rejects a table with duplicate IDs or a value outside its range", () => {
    const { project, track } = song();
    const add = (parameters: DeviceParameterRecord[]) =>
      project.addDevice(track.id, { kind: "webclap", pluginId: "x", name: "X", vendor: "v", version: "1", bundleUrl: "/x", parameters });
    expect(() => add([...table(), table()[0]])).toThrow("unique IDs");
    expect(() => add([{ id: "1", name: "A", min: 0, max: 1, default: 0, value: 2 }])).toThrow("unique IDs");
    project.dispose();
  });
});

describe("setDeviceParameter on a built-in effect", () => {
  test("lists the same row shape and writes the same data setTrackEffects does", () => {
    const { project, track } = song();
    const lp = effect(project, "lp");
    const rows = rackSlotParameters(lp);
    expect(rows.map((row) => row.id)).toEqual(["enabled", "wet", "mode", "frequency", "q"]);
    expect(rows.find((row) => row.id === "frequency")).toMatchObject({
      kind: "rack",
      min: 20,
      max: 20000,
      default: 350,
      value: 1000,
      unit: "hertz",
    });
    expect(rows.find((row) => row.id === "mode")).toMatchObject({ value: 0, step: 1, text: "lowpass" });
    set(project, rackDeviceId(track.id, "lp"), "frequency", 4000);
    const viaParameter = JSON.stringify(project.tracks[0].effects);
    project.undo();
    expect(effect(project, "lp").frequency).toBe(1000);
    project.setTrackEffects(
      track.id,
      project.tracks[0].effects.map((item) => (item.id === "lp" ? { ...item, frequency: 4000 } : item)) as RackEffect[],
    );
    expect(JSON.stringify(project.tracks[0].effects)).toBe(viaParameter);
    project.dispose();
  });

  test("sets enabled, mode, delay and equalizer band parameters", () => {
    const { project, track } = song();
    project.setDeviceParameter(rackDeviceId(track.id, "lp"), "enabled", 0);
    project.setDeviceParameter(rackDeviceId(track.id, "lp"), "mode", 1);
    project.setDeviceParameter(rackDeviceId(track.id, "echo"), "feedback", 0.6);
    project.setDeviceParameter(rackDeviceId(track.id, "eq"), "band0.gain", -6);
    expect(effect(project, "lp")).toMatchObject({ enabled: false, mode: "highpass" });
    expect(effect(project, "echo").feedback).toBe(0.6);
    expect((effect(project, "eq").bands as { gain: number }[])[0].gain).toBe(-6);
    project.dispose();
  });

  test("refuses a bad value, an unknown parameter, a bare slot ID and a macro-driven parameter", () => {
    const { project, track } = song();
    expect(() => project.setDeviceParameter(rackDeviceId(track.id, "lp"), "frequency", 5)).toThrow(
      'Project device parameter "frequency" needs a number from 20 to 20000.',
    );
    expect(() => project.setDeviceParameter(rackDeviceId(track.id, "lp"), "feedback", 0.1)).toThrow('has no parameter "feedback"; it has "enabled"');
    expect(() => project.setDeviceParameter("lp", "frequency", 500)).toThrow(`a built-in effect is addressed as "${track.id}:lp"`);
    project.setTrackRackPreset(track.id, {
      effects: project.tracks[0].effects,
      macros: [{ id: "tone", value: 0.5, targets: [{ slotId: "lp", parameter: "frequency", min: 200, max: 8000 }] }],
    });
    expect(() => project.setDeviceParameter(rackDeviceId(track.id, "lp"), "frequency", 500)).toThrow('driven by macro "tone"');
    project.setDeviceParameter(rackDeviceId(track.id, "lp"), "q", 2);
    expect(effect(project, "lp").q).toBe(2);
    project.dispose();
  });
});

describe("Undo of a built-in effect parameter", () => {
  test("is applied when another parameter of the same track changed since, and keeps that change", () => {
    const { project, track } = song();
    set(project, rackDeviceId(track.id, "lp"), "frequency", 4000, "Agent");
    project.setDeviceParameter(rackDeviceId(track.id, "echo"), "feedback", 0.7);
    expect(project.undo().status).toBe("applied");
    expect(effect(project, "lp").frequency).toBe(1000);
    expect(effect(project, "echo").feedback).toBe(0.7);
    expect(project.redo().status).toBe("applied");
    expect(effect(project, "lp").frequency).toBe(4000);
    expect(effect(project, "echo").feedback).toBe(0.7);
    project.dispose();
  });

  test("undoes the older step while a later change to another parameter stays", () => {
    const { project, track } = song();
    set(project, rackDeviceId(track.id, "lp"), "frequency", 4000, "Agent");
    // A change outside history: the person's own edit made after the agent's step.
    project.setTrackEffects(
      track.id,
      project.tracks[0].effects.map((item) => (item.id === "echo" ? { ...item, feedback: 0.7 } : item)) as RackEffect[],
    );
    expect(project.undo().status).toBe("applied");
    expect(effect(project, "lp").frequency).toBe(1000);
    expect(effect(project, "echo").feedback).toBe(0.7);
    project.dispose();
  });

  test("is a conflict when the same parameter changed since, and keeps that value", () => {
    const { project, track } = song();
    set(project, rackDeviceId(track.id, "lp"), "frequency", 4000, "Agent");
    project.setTrackEffects(
      track.id,
      project.tracks[0].effects.map((item) => (item.id === "lp" ? { ...item, frequency: 5000 } : item)) as RackEffect[],
    );
    expect(project.undo().status).toBe("conflict");
    expect(effect(project, "lp").frequency).toBe(5000);
    project.dispose();
  });

  test("a whole-rack replace still conflicts with any change of the rack since", () => {
    const { project, track } = song();
    project.edit("Replace rack", () =>
      project.setTrackEffects(
        track.id,
        project.tracks[0].effects.map((item) => (item.id === "lp" ? { ...item, frequency: 4000 } : item)) as RackEffect[],
      ),
    );
    project.setTrackEffects(
      track.id,
      project.tracks[0].effects.map((item) => (item.id === "echo" ? { ...item, feedback: 0.7 } : item)) as RackEffect[],
    );
    expect(project.undo().status).toBe("conflict");
    expect(effect(project, "lp").frequency).toBe(4000);
    project.dispose();
  });
});

describe("applyEdits setDeviceParameter", () => {
  const apply = (project: Project, ops: unknown[]) =>
    project.applyEdits({ expectedVersion: project.cells.version.value, label: "Tweak", ops: ops as never });

  test("sets a plug-in and a built-in effect parameter in one Undo step", () => {
    const { project, device, track } = song();
    const receipt = apply(project, [
      { type: "setDeviceParameter", deviceId: device.id, parameterId: "3", value: 90, expectedValue: 64 },
      { type: "setDeviceParameter", deviceId: rackDeviceId(track.id, "lp"), parameterId: "frequency", value: 2500, expectedValue: 1000 },
    ]);
    expect(receipt.status).toBe("applied");
    if (receipt.status === "applied") expect(receipt.changedTracks).toEqual([track.id]);
    expect(value(project, "3")).toBe(90);
    expect(effect(project, "lp").frequency).toBe(2500);
    expect(project.undo().status).toBe("applied");
    expect(value(project, "3")).toBe(64);
    expect(effect(project, "lp").frequency).toBe(1000);
    project.dispose();
  });

  test("a stepped value snaps and the receipt reports the value applied for each operation", () => {
    const { project, device, track } = song();
    const receipt = apply(project, [
      { type: "setDeviceParameter", deviceId: device.id, parameterId: "5", value: 2.695, expectedValue: 1 },
      { type: "setDeviceParameter", deviceId: device.id, parameterId: "3", value: 53.9 },
      { type: "setDeviceParameter", deviceId: rackDeviceId(track.id, "lp"), parameterId: "mode", value: 0.6 },
    ]);
    expect(receipt.status).toBe("applied");
    if (receipt.status === "applied")
      expect(receipt.deviceParameters).toEqual([
        { deviceId: device.id, parameterId: "5", value: 3 },
        { deviceId: device.id, parameterId: "3", value: 53.9 },
        { deviceId: rackDeviceId(track.id, "lp"), parameterId: "mode", value: 1 },
      ]);
    expect(value(project, "5")).toBe(3);
    const rejected = apply(project, [{ type: "setDeviceParameter", deviceId: device.id, parameterId: "5", value: 4.6 }]);
    expect(rejected.status).toBe("rejected");
    project.dispose();
  });

  test("a changed value is a conflict that names the current value, changes nothing and keeps the person's value", () => {
    const { project, device, track } = song();
    project.setDeviceParameter(device.id, "3", 10);
    const before = JSON.stringify(project.tracks);
    const receipt = apply(project, [
      { type: "setTrackVolume", trackId: track.id, volume: 0.2 },
      { type: "setDeviceParameter", deviceId: device.id, parameterId: "3", value: 90, expectedValue: 64 },
    ]);
    expect(receipt.status).toBe("conflict");
    if (receipt.status === "conflict") expect(receipt.reason).toContain("is 10 now, not the 64 you read");
    expect(value(project, "3")).toBe(10);
    expect(JSON.stringify(project.tracks)).toBe(before);
    project.dispose();
  });

  test("without expectedValue it just sets; a built-in effect conflict reads the same way", () => {
    const { project, device, track } = song();
    expect(apply(project, [{ type: "setDeviceParameter", deviceId: device.id, parameterId: "9", value: 3 }]).status).toBe("applied");
    const receipt = apply(project, [
      { type: "setDeviceParameter", deviceId: rackDeviceId(track.id, "echo"), parameterId: "feedback", value: 0.1, expectedValue: 0.9 },
    ]);
    expect(receipt).toMatchObject({ status: "conflict" });
    expect(effect(project, "echo").feedback).toBe(0.3);
    project.dispose();
  });

  test("expectedValue matches within a relative 1e-6 (absolute 1e-9 near 0), so a printed float32 value is not a conflict", () => {
    const { project, device, track } = song();
    const echo = rackDeviceId(track.id, "echo");
    expect(
      apply(project, [{ type: "setDeviceParameter", deviceId: echo, parameterId: "feedback", value: 0.5, expectedValue: 0.30000001 }]).status,
    ).toBe("applied");
    expect(effect(project, "echo").feedback).toBe(0.5);
    expect(apply(project, [{ type: "setDeviceParameter", deviceId: echo, parameterId: "feedback", value: 0.4, expectedValue: 0.5001 }]).status).toBe(
      "conflict",
    );
    expect(apply(project, [{ type: "setDeviceParameter", deviceId: device.id, parameterId: "9", value: 3, expectedValue: 1e-10 }]).status).toBe(
      "applied",
    );
    expect(apply(project, [{ type: "setDeviceParameter", deviceId: device.id, parameterId: "9", value: 4, expectedValue: 3.1 }]).status).toBe(
      "conflict",
    );
    project.dispose();
  });

  test("rejects an unknown device, an unknown parameter, a value out of range and stray fields", () => {
    const { project, device, track } = song();
    const reject = (op: Record<string, unknown>) => {
      const receipt = apply(project, [{ type: "setDeviceParameter", ...op }]);
      if (receipt.status !== "rejected") throw new Error(`expected a rejection, got ${receipt.status}`);
      return receipt;
    };
    expect(reject({ deviceId: "nope", parameterId: "3", value: 1 })).toMatchObject({ code: "device-not-found", opIndex: 0 });
    expect(reject({ deviceId: "lp", parameterId: "frequency", value: 1 }).reason).toContain(`"${track.id}:lp"`);
    expect(reject({ deviceId: device.id, parameterId: "404", value: 1 })).toMatchObject({ code: "invalid-operation" });
    expect(reject({ deviceId: device.id, parameterId: "3", value: 500 })).toMatchObject({ code: "invalid-operation" });
    expect(reject({ deviceId: device.id, parameterId: "3", value: "1" })).toMatchObject({ code: "invalid-operation" });
    expect(reject({ deviceId: device.id, parameterId: "3", value: 1, extra: true }).reason).toContain("allowed");
    expect(value(project, "3")).toBe(64);
    project.dispose();
  });
});

describe("saving and reopening", () => {
  const archive = (project: Project) => unzipSync(saveDawProject(project));

  test("the parameter table is written as DAWproject Parameters and reads back with defaults and steps", () => {
    const { project, device } = song();
    set(project, device.id, "3", 100);
    captureDeviceState(project, device.id, new Uint8Array([1, 2]));
    const xml = strFromU8(archive(project)["project.xml"]);
    expect(xml).toContain(`<RealParameter id="${device.id}-param-3" parameterID="3" name="Cutoff" unit="linear" min="0" max="127" value="100"/>`);
    // The schema orders Parameters before State.
    expect(xml.indexOf("<Parameters>")).toBeLessThan(xml.indexOf(`<State path="plugins/${device.id}.bin"`));
    const reopened = openDawProject(saveDawProject(project));
    expect(reopened.warnings).toEqual([]);
    expect(reopened.project.tracks[0].devices[0].parameters).toEqual(project.tracks[0].devices[0].parameters);
    expect(value(reopened.project, "3")).toBe(100);
    reopened.project.dispose();
    project.dispose();
  });

  test("a file saved after opening carries a parameter edit, and Parameters from another application are read and kept", () => {
    const { project, device } = song();
    const saved = unzipSync(saveDawProject(project));
    // Another application knows no sidecar: defaults are the values, steps are unknown, an integer and a bool parameter are read too.
    const foreign = { ...saved };
    delete foreign["audiorective/host.json"];
    foreign["project.xml"] = strToU8(
      strFromU8(saved["project.xml"]).replace(
        "</Parameters>",
        '<IntegerParameter id="x1" parameterID="12" name="Voices" min="1" max="8" value="4"/><BoolParameter id="x2" parameterID="13" name="Sync" value="true"/><RealParameter id="x3" parameterID="14" unit="linear" min="0" max="1" value="2"/></Parameters>',
      ),
    );
    const opened = openDawProject(zipSync(foreign));
    expect(opened.warnings.some((line) => line.includes("1 parameter in the file could not be read"))).toBe(true);
    const parameters = opened.project.tracks[0].devices[0].parameters;
    expect(parameters.map((item) => item.id)).toEqual(["3", "5", "9", "12", "13"]);
    expect(parameters.find((item) => item.id === "3")).toMatchObject({ default: 64, value: 64 });
    expect(parameters.find((item) => item.id === "12")).toMatchObject({ min: 1, max: 8, value: 4, step: 1 });
    expect(parameters.find((item) => item.id === "13")).toMatchObject({ min: 0, max: 1, value: 1, step: 1 });
    opened.project.setDeviceParameter(device.id, "3", 7);
    const resaved = openDawProject(saveDawProject(opened.project));
    expect(value(resaved.project, "3")).toBe(7);
    expect(resaved.project.tracks[0].devices[0].parameters.map((item) => item.id)).toEqual(["3", "5", "9", "12", "13"]);
    resaved.project.dispose();
    opened.project.dispose();
    project.dispose();
  });

  test("Parameters from another application: normalized rows wait for the plug-in's range, linear and unitless are plain, other units are skipped with one warning", () => {
    const { project } = song();
    const saved = unzipSync(saveDawProject(project));
    const foreign = { ...saved };
    delete foreign["audiorective/host.json"];
    foreign["project.xml"] = strToU8(
      strFromU8(saved["project.xml"]).replace(
        /<Parameters>[\s\S]*<\/Parameters>/,
        [
          "<Parameters>",
          '<RealParameter id="n1" parameterID="1" name="Norm" unit="normalized" min="0" max="1" value="0.25"/>',
          '<RealParameter id="n2" parameterID="2" name="Plain" unit="linear" min="0" max="127" value="90"/>',
          '<RealParameter id="n3" parameterID="3" name="Unitless" min="0" max="127" value="40"/>',
          '<RealParameter id="n4" parameterID="4" name="Pct" unit="percent" min="0" max="100" value="50"/>',
          '<RealParameter id="n5" parameterID="5" name="Hz" unit="hertz" min="20" max="20000" value="440"/>',
          "</Parameters>",
        ].join(""),
      ),
    );
    const opened = openDawProject(zipSync(foreign));
    const unitWarnings = opened.warnings.filter((line) => line.includes("cannot be mapped"));
    expect(unitWarnings).toHaveLength(1);
    expect(unitWarnings[0]).toContain('"percent"');
    expect(unitWarnings[0]).toContain('"hertz"');
    const parameters = opened.project.tracks[0].devices[0].parameters;
    expect(parameters.map((item) => item.id)).toEqual(["1", "2", "3"]);
    expect(parameters[0]).toMatchObject({ min: 0, max: 1, value: 0.25, normalized: true });
    expect(parameters[1]).toMatchObject({ min: 0, max: 127, value: 90 });
    expect(parameters[1].normalized).toBeUndefined();
    expect(parameters[2]).toMatchObject({ value: 40 });
    expect(parameters[2].normalized).toBeUndefined();
    // Saved before any plug-in loaded, the fraction stays marked as normalized.
    opened.project.setDeviceParameter(opened.project.tracks[0].devices[0].id, "2", 91);
    expect(strFromU8(unzipSync(saveDawProject(opened.project))["project.xml"])).toContain(
      'name="Norm" unit="normalized" min="0" max="1" value="0.25"',
    );
    opened.project.dispose();
    project.dispose();
  });

  test("a built-in effect parameter edit survives save and reopen", () => {
    const { project, track } = song();
    project.setDeviceParameter(rackDeviceId(track.id, "lp"), "frequency", 3300);
    const reopened = openDawProject(saveDawProject(project));
    expect(effect(reopened.project, "lp").frequency).toBe(3300);
    reopened.project.dispose();
    project.dispose();
  });
});
