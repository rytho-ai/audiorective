import { afterEach, expect, test } from "vitest";
import { Project, Workspace, openWorkspace, renderMixRange, saveWorkspace } from "../src";

const worklet = "/@fs" + new URL("../../host/dist/webclap-worklet.js", import.meta.url).pathname.replace(/^\/@fs/, "");
const bundle = "/@fs" + new URL("../../../apps/daw-demo/public/plugin/oxo-synth2.wclap", import.meta.url).pathname.replace(/^\/@fs/, "");
const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup() {
  const project = new Project({ bpm: 120 });
  const track = project.addTrack("Synth", "midi");
  project.addMidiClip(track.id, { notes: [{ pitch: 60, start: 0, duration: 2, velocity: 0.9 }], duration: 4 }, 0);
  const context = new AudioContext({ sampleRate: 48_000 });
  const workspace = await Workspace.create(context, project, { workletUrl: worklet });
  cleanups.push(async () => {
    workspace.dispose();
    project.dispose();
    await context.close();
  });
  return { project, track, context, workspace };
}

const peak = (samples: Float32Array) => samples.reduce((worst, value) => Math.max(worst, Math.abs(value)), 0);

test("addWebClapDevice reads the identity from the bundle, plays, saves and reopens", async () => {
  const { project, track, context, workspace } = await setup();
  const device = await workspace.addWebClapDevice(track.id, bundle);
  expect(device).toMatchObject({ pluginId: "com.oxo.music.oxosynth2", bundleUrl: bundle });
  expect(device.name).toBeTruthy();
  expect(device.vendor).toBe("chab (Oxo Music)");
  expect(device.version).toBe("1.1.1");
  expect(project.tracks[0].devices).toEqual([device]);
  expect(workspace.cells.needsSync.value).toBe(false);
  expect(workspace.host(device.id)).toBeDefined();

  const render = await renderMixRange(workspace, {
    expectedVersion: project.cells.version.value,
    range: { startSeconds: 0, endSeconds: 1.5 },
    prerollSeconds: 0,
  });
  if (render.status !== "rendered") throw new Error(render.reason);
  expect(peak(render.audio.channels[0])).toBeGreaterThan(0.001);

  const bytes = await saveWorkspace(workspace);
  const reopened = await openWorkspace(context, bytes, { workletUrl: worklet, resolveBundle: () => bundle });
  cleanups.push(() => {
    reopened.dispose();
  });
  expect(reopened.warnings).toEqual([]);
  expect(reopened.project.tracks[0].devices[0]).toMatchObject({
    pluginId: device.pluginId,
    name: device.name,
    vendor: device.vendor,
    version: device.version,
  });

  project.removeDevice(device.id);
  await workspace.sync();
  expect(project.tracks[0].devices).toEqual([]);
});

test("a bad bundle URL rejects and leaves the project unchanged", async () => {
  const { project, track, workspace } = await setup();
  const version = project.cells.version.value;
  await expect(workspace.addWebClapDevice(track.id, "/plugin/missing.wclap")).rejects.toThrow(/WebCLAP bundle HTTP/);
  await expect(workspace.addWebClapDevice("nope", bundle)).rejects.toThrow("Workspace device needs an existing track.");
  expect(project.tracks[0].devices).toEqual([]);
  expect(project.cells.version.value).toBe(version);
  expect(workspace.cells.needsSync.value).toBe(false);
});
