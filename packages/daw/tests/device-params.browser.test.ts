import { decode } from "@toon-format/toon";
import { effect } from "@audiorective/core";
import { afterEach, describe, expect, test } from "vitest";
import { Project, Workspace, openWorkspace, rackDeviceId, renderMixRange, saveWorkspace, type DeviceParameter } from "../src";
import { mcpTools } from "../src/mcp";
import { LiveCapture, sleep } from "./helpers/live-capture";

const RATE = 48_000;
const worklet = "/@fs" + new URL("../../host/dist/webclap-worklet.js", import.meta.url).pathname.replace(/^\/@fs/, "");
const bundle = "/@fs" + new URL("../../../apps/daw-demo/public/plugin/oxo-synth2.wclap", import.meta.url).pathname.replace(/^\/@fs/, "");
// The WebCLAP test plug-in (oxo-synth2): 0..127 parameters, `amp gain` scales the level, `filter freq` is the cutoff.
const AMP_GAIN = "29";
const CUTOFF = "19";

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup() {
  const project = new Project({ bpm: 120 });
  const track = project.addTrack("Synth", "midi");
  // One held note for the whole test so the level can be compared before and after an edit.
  project.addMidiClip(track.id, { notes: [{ pitch: 48, start: 0, duration: 30, velocity: 0.9 }], duration: 32 }, 0);
  const context = new AudioContext({ sampleRate: RATE });
  const workspace = await Workspace.create(context, project, { workletUrl: worklet });
  cleanups.push(async () => {
    workspace.dispose();
    project.dispose();
    await context.close();
  });
  const device = await workspace.addWebClapDevice(track.id, bundle);
  return { project, track, context, workspace, deviceId: device.id };
}

const row = (rows: readonly DeviceParameter[], id: string) => rows.find((item) => item.id === id)!;
const rms = (samples: Float32Array, from = 0, to = samples.length) => {
  let sum = 0;
  for (let i = from; i < to; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / Math.max(1, to - from));
};
/** Share of the signal that is fast movement: it rises with the filter cutoff (a bright sound has more energy in first differences). */
const brightness = (samples: Float32Array, from = 0, to = samples.length) => {
  let rough = 0;
  let total = 0;
  for (let i = from + 1; i < to; i++) {
    const step = samples[i] - samples[i - 1];
    rough += step * step;
    total += samples[i] * samples[i];
  }
  return rough / Math.max(total, 1e-12);
};

async function renderOffline(workspace: Workspace, project: Project) {
  const render = await renderMixRange(workspace, {
    expectedVersion: project.cells.version.value,
    range: { startSeconds: 0.5, endSeconds: 1.5 },
    prerollSeconds: 0.5,
  });
  if (render.status !== "rendered") throw new Error(render.reason);
  return render.audio.channels[0];
}

describe("device parameters with a WebCLAP plug-in", () => {
  test("lists a plug-in and a built-in effect in one row shape, and loading the table is not an edit", async () => {
    const { project, track, workspace, deviceId } = await setup();
    const rows = workspace.deviceParameters(deviceId);
    expect(rows).toHaveLength(100);
    expect(row(rows, CUTOFF)).toMatchObject({ kind: "webclap", name: "filter freq", min: 0, max: 127, default: 32, value: 32, step: 1 });
    expect(row(rows, CUTOFF).text).toBe("32");
    expect(project.tracks[0].devices[0].parameters).toHaveLength(100);
    // Only the Add step is in the history: the table was stored as a capture.
    expect(project.cells.history.value.undo).toMatch(/^Add /);
    // Undo of the Add takes the device out; its last table goes into the history step, so Redo brings the same table back at once.
    project.undo();
    await workspace.flush();
    expect(project.tracks[0].devices).toEqual([]);
    project.redo();
    expect(project.tracks[0].devices[0].parameters).toHaveLength(100);
    await workspace.flush();
    expect(workspace.deviceParameters(deviceId)).toHaveLength(100);

    project.setTrackEffects(track.id, [{ id: "lp", type: "filter", enabled: true, wet: 1, mode: "lowpass", frequency: 800, q: 1 }]);
    const rack = workspace.deviceParameters(rackDeviceId(track.id, "lp"));
    for (const item of [...rows, ...rack])
      expect(Object.keys(item)).toEqual(expect.arrayContaining(["id", "name", "kind", "min", "max", "default", "value"]));
    expect(row(rack, "frequency")).toMatchObject({ kind: "rack", min: 20, max: 20000, value: 800, unit: "hertz" });
    expect(() => workspace.deviceParameters("nope")).toThrow('Workspace device "nope" does not exist');
  });

  test("a normalized row from another application is mapped into the plug-in's range at load; plain rows keep their value", async () => {
    const project = new Project({ bpm: 120 });
    const track = project.addTrack("Synth", "midi");
    const context = new AudioContext({ sampleRate: RATE });
    const device = project.addDevice(track.id, {
      kind: "webclap",
      pluginId: "com.oxo.music.oxosynth2",
      name: "oxo",
      vendor: "",
      version: "",
      bundleUrl: bundle,
      parameters: [
        { id: CUTOFF, name: "filter freq", min: 0, max: 1, default: 0.5, value: 0.5, normalized: true },
        { id: AMP_GAIN, name: "amp gain", min: 0, max: 127, default: 100, value: 20 },
      ],
    });
    const workspace = await Workspace.create(context, project, { workletUrl: worklet });
    cleanups.push(async () => {
      workspace.dispose();
      project.dispose();
      await context.close();
    });
    await workspace.flush();
    const rows = workspace.deviceParameters(device.id);
    expect(row(rows, CUTOFF)).toMatchObject({ min: 0, max: 127, value: 64 });
    expect(row(rows, AMP_GAIN).value).toBe(20);
    expect(workspace.host(device.id)!.param(CUTOFF)!.value).toBe(64);
    expect(project.tracks[0].devices[0].parameters.some((item) => item.normalized)).toBe(false);
  });

  test("an effect that reads deviceParameters re-runs on an edit and on a value the plug-in moves by itself", async () => {
    const { project, workspace, deviceId } = await setup();
    const seen: number[] = [];
    const stop = effect(() => void seen.push(row(workspace.deviceParameters(deviceId), CUTOFF).value));
    project.edit("Cutoff", () => project.setDeviceParameter(deviceId, CUTOFF, 90));
    await workspace.flush();
    // The person turning the plug-in's own knob: the Param changes on the host, not through the Project.
    const version = project.cells.version.value;
    const undo = project.cells.history.value.undo;
    workspace.host(deviceId)!.param(CUTOFF)!.value = 50;
    await sleep(50);
    stop();
    expect(seen).toEqual([32, 90, 50]);
    expect(project.cells.version.value).toBe(version);
    expect(project.cells.history.value.undo).toBe(undo);
  });

  test("a changed parameter changes the sound live and offline, and Undo puts the sound back", async () => {
    const { project, workspace, context, deviceId } = await setup();
    const before = await renderOffline(workspace, project);
    expect(rms(before)).toBeGreaterThan(0.005);

    // Offline: the saved song's value is what a render hears.
    project.edit("Quieter", () => project.setDeviceParameter(deviceId, AMP_GAIN, 20));
    const quiet = await renderOffline(workspace, project);
    const offlineDrop = rms(quiet) / rms(before);
    expect(offlineDrop).toBeLessThan(0.5);
    project.undo();
    const restored = await renderOffline(workspace, project);
    expect(Math.abs(rms(restored) / rms(before) - 1)).toBeLessThan(0.05);

    // Live: the running page applies the edit without a rebuild.
    await context.resume();
    const capture = await LiveCapture.on(context, workspace.output);
    await workspace.play();
    await sleep(1200);
    const marks: Record<string, number> = { a: context.currentTime };
    project.edit("Quieter", () => project.setDeviceParameter(deviceId, AMP_GAIN, 20));
    await workspace.flush();
    await sleep(600);
    marks.b = context.currentTime;
    await sleep(700);
    marks.c = context.currentTime;
    project.undo();
    await workspace.flush();
    await sleep(600);
    marks.d = context.currentTime;
    await sleep(700);
    marks.e = context.currentTime;
    workspace.stop();
    const { first, data, dropouts } = await capture.stop();
    const at = (seconds: number) => Math.round(seconds * RATE) - first;
    const channel = data[0];
    const level = {
      before: rms(channel, at(marks.a - 0.5), at(marks.a)),
      during: rms(channel, at(marks.b), at(marks.c)),
      after: rms(channel, at(marks.d), at(marks.e)),
    };
    // A large jump on a plug-in without smoothing of its own is a step in the sound; the host moves a continuous parameter over 20 ms as several value events, so the edit and its Undo are no rougher than the steady sound.
    const worstStep = (from: number, to: number) => {
      let worst = 0;
      for (let i = from + 1; i < to; i++) worst = Math.max(worst, Math.abs(channel[i] - channel[i - 1]));
      return worst;
    };
    const steadyStep = worstStep(at(marks.a - 0.5), at(marks.a));
    const editStep = Math.max(worstStep(at(marks.a), at(marks.a + 0.3)), worstStep(at(marks.c), at(marks.c + 0.3)));
    // eslint-disable-next-line no-console
    console.info(`device-params worst sample step: steady ${steadyStep.toFixed(5)}, in the 300 ms after an edit or Undo ${editStep.toFixed(5)}`);
    expect(editStep).toBeLessThanOrEqual(steadyStep * 2);
    expect(level.before).toBeGreaterThan(0.005);
    expect(level.during / level.before).toBeLessThan(0.5);
    expect(Math.abs(level.after / level.before - 1)).toBeLessThan(0.1);
    expect(dropouts.filter((gap) => gap.startFrame > at(marks.a) + first - 1000).length).toBe(0);
    // eslint-disable-next-line no-console
    console.info(
      `device-params live level before ${level.before.toFixed(4)} edited ${level.during.toFixed(4)} undone ${level.after.toFixed(4)}; offline edited/before ${offlineDrop.toFixed(3)}`,
    );
  }, 30_000);

  test("the cutoff changes the spectrum of a render and Undo restores it", async () => {
    const { project, workspace, deviceId } = await setup();
    const normal = await renderOffline(workspace, project);
    project.edit("Dark", () => project.setDeviceParameter(deviceId, CUTOFF, 0));
    const dark = await renderOffline(workspace, project);
    project.undo();
    const again = await renderOffline(workspace, project);
    expect(brightness(dark)).toBeLessThan(brightness(normal) * 0.7);
    expect(Math.abs(brightness(again) / brightness(normal) - 1)).toBeLessThan(0.1);
  }, 30_000);

  test("a stale expectedValue is a conflict that keeps the value the person turned", async () => {
    const { project, workspace, deviceId } = await setup();
    const read = row(workspace.deviceParameters(deviceId), CUTOFF).value;
    // The person turns the plug-in's own knob after the agent read the value.
    workspace.host(deviceId)!.param(CUTOFF)!.value = 90;
    await sleep(50);
    const request = (expectedValue: number) => ({
      expectedVersion: project.cells.version.value,
      label: "Darker",
      ops: [{ type: "setDeviceParameter" as const, deviceId, parameterId: CUTOFF, value: 10, expectedValue }],
    });
    const stale = project.applyEdits(request(read));
    expect(stale.status).toBe("conflict");
    if (stale.status === "conflict") expect(stale.reason).toContain("is 90 now, not the 32 you read");
    expect(row(workspace.deviceParameters(deviceId), CUTOFF).value).toBe(90);
    await workspace.flush();
    expect(workspace.host(deviceId)!.param(CUTOFF)!.value).toBe(90);
    expect(project.applyEdits(request(90)).status).toBe("applied");
    await workspace.flush();
    expect(workspace.host(deviceId)!.param(CUTOFF)!.value).toBe(10);
    // One undo takes the agent's step back to the value the person had set, not to the one the agent read.
    expect(project.undo().status).toBe("applied");
    await workspace.flush();
    expect(workspace.host(deviceId)!.param(CUTOFF)!.value).toBe(90);
  });

  test("saved, reopened: the file carries the values and the reopened song plays them", async () => {
    const { project, workspace, context, deviceId } = await setup();
    project.edit("Settings", () => {
      project.setDeviceParameter(deviceId, AMP_GAIN, 20);
      project.setDeviceParameter(deviceId, CUTOFF, 100);
    });
    await workspace.flush();
    const expected = await renderOffline(workspace, project);
    const bytes = await saveWorkspace(workspace);
    const reopened = await openWorkspace(context, bytes, { workletUrl: worklet, resolveBundle: () => bundle });
    cleanups.push(() => reopened.dispose());
    expect(reopened.cells.warnings.value).toEqual([]);
    const values = (w: Workspace) => Object.fromEntries(w.deviceParameters(deviceId).map((item) => [item.id, item.value]));
    expect(values(reopened)).toEqual(values(workspace));
    expect(row(reopened.deviceParameters(deviceId), AMP_GAIN).value).toBe(20);
    expect(reopened.host(deviceId)!.param(AMP_GAIN)!.value).toBe(20);
    expect(reopened.host(deviceId)!.param(CUTOFF)!.value).toBe(100);
    const heard = await renderOffline(reopened, reopened.project);
    expect(Math.abs(rms(heard) / rms(expected) - 1)).toBeLessThan(0.05);
  }, 30_000);
});

describe("device parameters through the MCP tools", () => {
  test("read_device_params rows go back as setDeviceParameter operations; a stale read conflicts", async () => {
    const { project, track, workspace, deviceId } = await setup();
    project.setTrackEffects(track.id, [{ id: "lp", type: "filter", enabled: true, wet: 1, mode: "lowpass", frequency: 800, q: 1 }]);
    const tools = mcpTools(workspace);
    const call = (name: string, args: unknown) => tools.find((tool) => tool.name === name)!.call(args);
    expect(tools.find((tool) => tool.name === "read_device_params")?.category).toBe("read");

    const overview = decode((await call("read_project", {})).content) as {
      devices: { id: string; parameters: number }[];
      effectDevices: { id: string; parameters: number }[];
    };
    expect(overview.devices[0]).toMatchObject({ id: deviceId, parameters: 100 });
    expect(overview.effectDevices[0]).toMatchObject({ id: rackDeviceId(track.id, "lp"), parameters: 5 });

    const read = async (id: string) =>
      decode((await call("read_device_params", { deviceId: id })).content) as {
        deviceId: string;
        version: string;
        count: number;
        parameters: DeviceParameter[];
      };
    const plugin = await read(deviceId);
    expect(plugin.count).toBe(100);
    const cutoff = row(plugin.parameters, CUTOFF);
    const apply = async (ops: unknown[]) =>
      JSON.parse((await call("apply_edits", { expectedVersion: project.cells.version.value, label: "Brighten", ops })).content) as {
        status: string;
        reason?: string;
        undoLabel?: string;
      };
    // The row goes back as the operation: id -> parameterId, value -> expectedValue.
    const applied = await apply([
      { type: "setDeviceParameter", deviceId: plugin.deviceId, parameterId: cutoff.id, value: 100, expectedValue: cutoff.value },
    ]);
    expect(applied.status).toBe("applied");
    expect(row((await read(deviceId)).parameters, CUTOFF).value).toBe(100);
    const stale = await apply([
      { type: "setDeviceParameter", deviceId: plugin.deviceId, parameterId: cutoff.id, value: 5, expectedValue: cutoff.value },
    ]);
    expect(stale.status).toBe("conflict");
    expect(stale.reason).toContain("is 100 now, not the 32 you read");

    const effectId = rackDeviceId(track.id, "lp");
    const frequency = row((await read(effectId)).parameters, "frequency");
    expect(frequency).toMatchObject({ kind: "rack", value: 800 });
    expect(
      (await apply([{ type: "setDeviceParameter", deviceId: effectId, parameterId: "frequency", value: 3000, expectedValue: 800 }])).status,
    ).toBe("applied");
    expect(project.tracks[0].effects[0]).toMatchObject({ frequency: 3000 });
    expect((await call("read_device_params", { deviceId: "nope" })).isError).toBe(true);
    // The person's single Undo takes the agent's last step back.
    project.undo();
    expect(project.tracks[0].effects[0]).toMatchObject({ frequency: 800 });
  });

  test("a read-only app lists read_device_params and refuses the edit", async () => {
    const { workspace, deviceId } = await setup();
    const tools = mcpTools(workspace, { allow: ["read"] });
    expect(tools.map((tool) => tool.name)).toContain("read_device_params");
    expect(tools.map((tool) => tool.name)).not.toContain("apply_edits");
    expect((await tools.find((tool) => tool.name === "read_device_params")!.call({ deviceId })).isError).toBeFalsy();
  });
});
