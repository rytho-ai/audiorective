import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { strFromU8, unzipSync, zipSync } from "fflate";
import { Project, defineRackEffect, openDawProject, rackDeviceId, saveDawProject, type RackCustom, type RackEffect } from "../src";
import { normalizeRackEffects, normalizeRackPreset, rackMacroRange } from "../src/rack-preset";
import { rackSlotParameters } from "../src/device-parameters";

const fx = defineRackEffect({
  id: "demo.shaper",
  name: "Shaper",
  parameters: [
    { id: "drive", name: "Drive", min: 0, max: 10, default: 2, unit: "decibel" },
    { id: "mode", name: "Mode", min: 0, max: 3, default: 1, step: 1 },
  ],
  create: () => {
    throw new Error("not built in a pure test");
  },
});
const custom = (over: Partial<RackCustom> = {}): RackCustom => ({ ...fx.slot({ id: "shape", values: { drive: 4 } }), ...over });
const bad = (slot: unknown) => () => normalizeRackEffects([slot as RackEffect]);

function song() {
  const project = new Project({ bpm: 120 });
  const track = project.addTrack("Keys", "audio");
  project.setTrackEffects(track.id, [{ id: "lp", type: "filter", enabled: true, wet: 1, mode: "lowpass", frequency: 1000, q: 1 }, custom()]);
  return { project, track };
}
const slot = (project: Project) => project.tracks[0].effects.find((item) => item.id === "shape") as RackCustom;
const driveOf = (project: Project) => slot(project).parameters.find((row) => row.id === "drive")!.value;

describe("defineRackEffect", () => {
  test("freezes the definition and builds a slot from its defaults", () => {
    expect(Object.isFrozen(fx)).toBe(true);
    expect(fx.slot({ id: "a" })).toEqual({
      id: "a",
      enabled: true,
      wet: 1,
      type: "custom",
      effect: "demo.shaper",
      parameters: [
        { id: "drive", name: "Drive", min: 0, max: 10, default: 2, value: 2, unit: "decibel" },
        { id: "mode", name: "Mode", min: 0, max: 3, default: 1, value: 1, step: 1 },
      ],
    });
    expect(fx.slot({ id: "b", enabled: false, wet: 0.5, values: { mode: 3 } })).toMatchObject({ enabled: false, wet: 0.5 });
  });

  test("slot output passes normalizeRackEffects unchanged", () => {
    const made = fx.slot({ id: "a", values: { drive: 9 } });
    expect(normalizeRackEffects([made])[0]).toEqual(made);
  });

  test("refuses an unknown value name, a value out of range and bad definitions", () => {
    expect(() => fx.slot({ id: "a", values: { nope: 1 } })).toThrow('Rack effect "demo.shaper" has no parameter "nope".');
    expect(() => fx.slot({ id: "a", values: { drive: 11 } })).toThrow('TrackRack custom effect slot "a"');
    const create = () => {
      throw new Error("x");
    };
    expect(() => defineRackEffect({ id: " ", name: "n", parameters: [], create })).toThrow("Rack effect needs a non-empty id and name.");
    expect(() => defineRackEffect({ id: "x", name: "n", parameters: [], create: undefined as never })).toThrow(
      'Rack effect "x" needs a create function.',
    );
    for (const parameters of [
      [{ id: "wet", name: "W", min: 0, max: 1, default: 0 }],
      [{ id: "enabled", name: "E", min: 0, max: 1, default: 0 }],
      [{ id: "a:b", name: "C", min: 0, max: 1, default: 0 }],
      [
        { id: "a", name: "A", min: 0, max: 1, default: 0 },
        { id: "a", name: "A", min: 0, max: 1, default: 0 },
      ],
      [{ id: "a", name: "A", min: 1, max: 0, default: 0 }],
      [{ id: "a", name: "A", min: 0, max: 1, default: 2 }],
      [{ id: "a", name: "A", min: 0, max: Infinity, default: 0 }],
    ])
      expect(() => defineRackEffect({ id: "x", name: "n", parameters, create })).toThrow(/needs parameters with unique IDs/);
  });
});

describe("normalizeRackEffects with a custom slot", () => {
  test("accepts a valid custom slot next to the built-in kinds and freezes a copy", () => {
    const out = normalizeRackEffects([custom(), { id: "d", type: "delay", enabled: true, wet: 1, delayTime: 0.2, feedback: 0.1 }]);
    expect(out).toHaveLength(2);
    expect(Object.isFrozen(out[0])).toBe(true);
    expect(Object.isFrozen((out[0] as RackCustom).parameters)).toBe(true);
  });

  test("rejects an empty effect, a missing table and every invalid row", () => {
    const row = { id: "p", name: "P", min: 0, max: 1, default: 0.5, value: 0.5 };
    expect(bad({ ...custom(), effect: "" })).toThrow(RangeError);
    expect(bad({ ...custom(), effect: 3 })).toThrow(RangeError);
    expect(bad({ ...custom(), parameters: undefined })).toThrow(RangeError);
    for (const parameters of [
      [row, row],
      [{ ...row, id: "wet" }],
      [{ ...row, id: "enabled" }],
      [{ ...row, id: "" }],
      [{ ...row, id: "a:b" }],
      [{ ...row, name: "" }],
      [{ ...row, min: 2 }],
      [{ ...row, value: 2 }],
      [{ ...row, value: -1 }],
      [{ ...row, default: 5 }],
      [{ ...row, value: Number.NaN }],
      [{ ...row, max: Number.POSITIVE_INFINITY }],
      [{ ...row, step: 2 }],
      [{ ...row, unit: 4 }],
      [null],
    ])
      expect(bad({ ...custom(), parameters }), JSON.stringify(parameters)).toThrow(/custom effect slot "shape" needs a non-empty effect ID/);
    expect(bad({ ...custom(), wet: 2 })).toThrow("TrackRack needs unique slot IDs");
    expect(() => normalizeRackEffects([custom(), custom()])).toThrow("TrackRack needs unique slot IDs");
  });

  test("a table may be empty", () => {
    const none = defineRackEffect({ id: "none", name: "None", parameters: [], create: () => undefined as never });
    expect(normalizeRackEffects([none.slot({ id: "n" })])).toHaveLength(1);
  });
});

describe("custom slot as Project data", () => {
  test("setTrackEffects with a custom slot is one Undo step, and undo and redo restore it", () => {
    const { project, track } = song();
    project.setTrackEffects(track.id, []);
    const before = project.cells.version.value;
    project.edit("Add shaper", () => project.setTrackEffects(track.id, [custom()]));
    expect(project.cells.version.value).not.toBe(before);
    expect(project.cells.history.value.undo).toBe("Add shaper");
    expect(slot(project).effect).toBe("demo.shaper");
    expect(project.undo().status).toBe("applied");
    expect(project.tracks[0].effects).toEqual([]);
    expect(project.redo().status).toBe("applied");
    expect(driveOf(project)).toBe(4);
    project.dispose();
  });

  test("lists enabled, wet and the table, in that order, in the one row shape", () => {
    const { project, track } = song();
    const rows = rackSlotParameters(slot(project));
    expect(rows.map((row) => row.id)).toEqual(["enabled", "wet", "drive", "mode"]);
    expect(rows[2]).toMatchObject({ kind: "rack", name: "Drive", min: 0, max: 10, default: 2, value: 4, unit: "decibel" });
    expect(rows[3]).toMatchObject({ step: 1, value: 1 });
    expect(rackDeviceId(track.id, "shape")).toBe(`${track.id}:shape`);
    project.dispose();
  });

  test("setDeviceParameter checks the range, snaps a stepped value and is one Undo step", () => {
    const { project, track } = song();
    const id = rackDeviceId(track.id, "shape");
    project.edit("Drive", () => project.setDeviceParameter(id, "drive", 7.5));
    expect(driveOf(project)).toBe(7.5);
    expect(() => project.setDeviceParameter(id, "drive", 11)).toThrow('Project device parameter "drive" needs a number from 0 to 10.');
    expect(() => project.setDeviceParameter(id, "nope", 1)).toThrow(
      'Project effect "shape" has no parameter "nope"; it has "enabled", "wet", "drive", "mode".',
    );
    // Called directly a write is no Undo step; inside project.edit it is one.
    expect(project.setDeviceParameter(id, "mode", 2.4)).toBe(2);
    expect(project.setDeviceParameter(id, "mode", 2.5)).toBe(3);
    project.edit("Wet", () => project.setDeviceParameter(id, "wet", 0.25));
    expect(slot(project).wet).toBe(0.25);
    project.undo();
    expect(slot(project).wet).toBe(1);
    expect(slot(project).parameters.find((row) => row.id === "mode")!.value).toBe(3);
    project.undo();
    expect(driveOf(project)).toBe(4);
    project.dispose();
  });

  test("applyEdits sets a custom parameter, reports the applied value and conflicts on a changed expectedValue", () => {
    const { project, track } = song();
    const id = rackDeviceId(track.id, "shape");
    const apply = (ops: unknown[]) => project.applyEdits({ expectedVersion: project.cells.version.value, label: "Tweak", ops: ops as never });
    const receipt = apply([
      { type: "setDeviceParameter", deviceId: id, parameterId: "drive", value: 6, expectedValue: 4 },
      { type: "setDeviceParameter", deviceId: id, parameterId: "mode", value: 2.6 },
    ]);
    expect(receipt.status).toBe("applied");
    if (receipt.status === "applied")
      expect(receipt.deviceParameters).toEqual([
        { deviceId: id, parameterId: "drive", value: 6 },
        { deviceId: id, parameterId: "mode", value: 3 },
      ]);
    expect(project.undo().status).toBe("applied");
    expect(driveOf(project)).toBe(4);
    const before = JSON.stringify(project.tracks);
    const conflict = apply([{ type: "setDeviceParameter", deviceId: id, parameterId: "drive", value: 8, expectedValue: 9 }]);
    expect(conflict).toMatchObject({ status: "conflict" });
    if (conflict.status === "conflict") expect(conflict.reason).toContain("is 4 now, not the 9 you read");
    expect(JSON.stringify(project.tracks)).toBe(before);
    const out = apply([{ type: "setDeviceParameter", deviceId: id, parameterId: "drive", value: 20 }]);
    expect(out.status).toBe("rejected");
    project.dispose();
  });

  test("the setTrackEffects operation takes a custom slot", () => {
    const { project, track } = song();
    const receipt = project.applyEdits({
      expectedVersion: project.cells.version.value,
      label: "Swap",
      ops: [{ type: "setTrackEffects", trackId: track.id, effects: [fx.slot({ id: "only", values: { drive: 1 } })] }],
    });
    expect(receipt.status).toBe("applied");
    expect(project.tracks[0].effects.map((item) => item.id)).toEqual(["only"]);
    project.dispose();
  });

  test("a macro cannot target a custom slot", () => {
    const { project, track } = song();
    expect(rackMacroRange(custom(), "wet")).toBeUndefined();
    const macro = (slotId: string) => ({ id: "m", value: 0.5, targets: [{ slotId, parameter: "wet" as const, min: 0, max: 1 }] });
    expect(() => project.setTrackRackPreset(track.id, { effects: project.tracks[0].effects, macros: [macro("shape")] })).toThrow(
      "TrackRack macros cannot target a custom effect slot.",
    );
    expect(() => normalizeRackPreset({ effects: [custom()], macros: [macro("shape")] })).toThrow(RangeError);
    project.setTrackRackPreset(track.id, { effects: project.tracks[0].effects, macros: [macro("lp")] });
    // Replacing the mapped slot by a custom one drops the mapping, as for any replaced slot.
    project.setTrackEffects(track.id, [custom({ id: "lp" })]);
    expect(project.tracks[0].effectMacros[0].targets).toEqual([]);
    project.dispose();
  });
});

describe("custom slot in a .dawproject file", () => {
  test("save and open keep order, enabled, wet, effect ID and the whole table", () => {
    const { project, track } = song();
    project.setTrackEffects(track.id, [
      custom({ enabled: false, wet: 0.4 }),
      { id: "echo", type: "delay", enabled: true, wet: 0.5, delayTime: 0.25, feedback: 0.3 },
      fx.slot({ id: "second", values: { mode: 3 } }),
    ]);
    project.setDeviceParameter(rackDeviceId(track.id, "shape"), "drive", 9.25);
    const bytes = saveDawProject(project);
    const files = unzipSync(bytes);
    const xml = strFromU8(files["project.xml"]);
    expect(xml).toContain('deviceID="audiorective.insert.custom"');
    expect(xml).toContain('deviceName="demo.shaper"');
    const opened = openDawProject(bytes);
    expect(opened.warnings).toEqual([]);
    expect(opened.project.tracks[0].effects).toEqual(project.tracks[0].effects);
    expect(JSON.stringify(opened.project.tracks[0].effects)).toBe(JSON.stringify(project.tracks[0].effects));
    expect(saveDawProject(opened.project).length).toBeGreaterThan(0);
    project.dispose();
    opened.project.dispose();
  });

  test("a file written before custom slots opens with the same built-in inserts", () => {
    const bytes = new Uint8Array(readFileSync(new URL("./fixtures/dawproject/rack-before-custom.dawproject", import.meta.url)));
    const opened = openDawProject(bytes);
    expect(opened.warnings).toEqual([]);
    expect(opened.project.tracks[0].effects).toEqual([
      { id: "lp", type: "filter", enabled: true, wet: 1, mode: "lowpass", frequency: 1000, q: 1 },
      { id: "echo", type: "delay", enabled: false, wet: 0.5, delayTime: 0.25, feedback: 0.3 },
      { id: "eq", type: "eq", enabled: true, wet: 1, bands: [{ frequency: 100, gain: 3, q: 1 }] },
    ]);
    opened.project.dispose();
  });

  test("a file whose custom table is invalid does not open", () => {
    const { project } = song();
    const files = unzipSync(saveDawProject(project));
    const path = Object.keys(files).find((name) => name.startsWith("plugins/ar-insert-2"))!;
    const data = JSON.parse(strFromU8(files[path]));
    data.effect.parameters[0].value = 99;
    files[path] = new TextEncoder().encode(JSON.stringify(data));
    expect(() => openDawProject(zipSync(files))).toThrow(/custom effect slot/);
    project.dispose();
  });
});
