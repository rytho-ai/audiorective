import { afterEach, expect, test } from "vitest";
import type { SoundFactory } from "@audiorective/core";
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

/** A 1 kHz click 20 ms long, made with plain Web Audio. */
const click: SoundFactory = (context) => {
  const osc = new OscillatorNode(context, { frequency: 1000 });
  const gain = new GainNode(context, { gain: 0.5 });
  osc.connect(gain);
  return { output: gain, sources: [osc], duration: 0.02 };
};

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
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

/** The largest sample a post-fader tap shows within `ms`. */
async function heard(workspace: Workspace, trackId: string, ms: number): Promise<number> {
  const analyser = new AnalyserNode(workspace.context, { fftSize: 2048 });
  workspace.trackMixerOutput(trackId)!.connect(analyser);
  const data = new Float32Array(analyser.fftSize);
  let loudest = 0;
  const end = performance.now() + ms;
  while (performance.now() < end) {
    analyser.getFloatTimeDomainData(data);
    loudest = Math.max(loudest, peak(data));
    await wait(10);
  }
  workspace.trackMixerOutput(trackId)!.disconnect(analyser);
  return loudest;
}

test("a device added, removed and re-added during playback never stops the transport, and is an Undo step", async () => {
  const project = new Project({ bpm: 120 });
  const synth = project.addTrack("Synth", "midi");
  const drums = project.addTrack("Drums", "midi");
  // A note on every beat for a minute, on both tracks.
  const beats = Array.from({ length: 120 }, (_, index) => ({ pitch: 60, start: index, duration: 0.5, velocity: 0.9 }));
  project.addMidiClip(synth.id, { notes: beats, duration: 120 }, 0);
  project.addMidiClip(drums.id, { notes: beats, duration: 120 }, 0);
  const context = new AudioContext({ sampleRate: 48_000 });
  const workspace = await Workspace.create(context, project, { workletUrl: worklet, instruments: { [drums.id]: { sound: click } } });
  cleanups.push(async () => {
    workspace.dispose();
    project.dispose();
    await context.close();
  });
  const stops: boolean[] = [];
  workspace.player.isPlaying.subscribe((playing) => void (playing || stops.push(playing)));
  await workspace.play();
  await wait(400);
  expect(workspace.player.isPlaying.value).toBe(true);
  expect(await heard(workspace, synth.id, 600)).toBeLessThan(0.0005);
  const drumsOutput = workspace.trackMixerOutput(drums.id);
  const before = workspace.position;

  const device = await workspace.addWebClapDevice(synth.id, bundle);
  expect(workspace.cells.needsSync.value).toBe(false);
  await wait(150);
  expect(workspace.player.isPlaying.value).toBe(true);
  expect(workspace.position).toBeGreaterThan(before);
  expect(project.cells.history.value.undo).toMatch(/^Add /);
  expect(workspace.host(device.id)).toBeDefined();
  expect(await heard(workspace, synth.id, 1500)).toBeGreaterThan(0.001);
  // The other track kept its own graph and keeps sounding.
  expect(workspace.trackMixerOutput(drums.id)).toBe(drumsOutput);
  expect(await heard(workspace, drums.id, 1200)).toBeGreaterThan(0.001);

  // Tweak the running plug-in so its state differs from the saved one, then take it away with Undo.
  const host = workspace.host(device.id)!;
  const param = host.parameterInfo.find((info) => info.max > info.min)!;
  host.param(param.id)!.value = param.value === param.max ? param.min : param.max;
  const tweaked = await host.saveState();
  const position = workspace.position;
  expect(project.undo().status).toBe("applied");
  await workspace.flush();
  expect(project.tracks[0].devices).toEqual([]);
  expect(workspace.host(device.id)).toBeUndefined();
  await wait(150);
  expect(workspace.player.isPlaying.value).toBe(true);
  expect(workspace.position).toBeGreaterThan(position);
  expect(workspace.cells.needsSync.value).toBe(false);
  expect(await heard(workspace, synth.id, 800)).toBeLessThan(0.0005);

  // Redo brings the same device back with the state it had when it went.
  expect(project.redo().status).toBe("applied");
  await workspace.flush();
  const again = workspace.host(device.id);
  expect(again).toBeDefined();
  expect(project.tracks[0].devices[0].id).toBe(device.id);
  expect([...(await again!.saveState())]).toEqual([...tweaked]);
  expect(await heard(workspace, synth.id, 1500)).toBeGreaterThan(0.001);
  expect(workspace.player.isPlaying.value).toBe(true);
  expect(stops).toEqual([]);

  const reopened = await openWorkspace(context, await saveWorkspace(workspace), { workletUrl: worklet, resolveBundle: () => bundle });
  cleanups.push(() => reopened.dispose());
  expect(reopened.project.tracks[0].devices.map((item) => item.id)).toEqual([device.id]);
}, 60_000);

test("a track's sampler comes back when its last device goes, and devices can be reordered while playing", async () => {
  const project = new Project({ bpm: 120 });
  const keys = project.addTrack("Keys", "midi");
  const beats = Array.from({ length: 120 }, (_, index) => ({ pitch: 60, start: index, duration: 0.5, velocity: 0.9 }));
  project.addMidiClip(keys.id, { notes: beats, duration: 120 }, 0);
  const context = new AudioContext({ sampleRate: 48_000 });
  const workspace = await Workspace.create(context, project, { workletUrl: worklet, instruments: { [keys.id]: { sound: click } } });
  cleanups.push(async () => {
    workspace.dispose();
    project.dispose();
    await context.close();
  });
  await workspace.play();
  await wait(300);
  expect(await heard(workspace, keys.id, 800)).toBeGreaterThan(0.001);
  const first = await workspace.addWebClapDevice(keys.id, bundle);
  // The synth takes the track over from its sampler.
  expect(await heard(workspace, keys.id, 1500)).toBeGreaterThan(0.001);
  const second = await workspace.addWebClapDevice(keys.id, bundle);
  expect(project.tracks[0].devices.map((device) => device.id)).toEqual([first.id, second.id]);
  const hosts = [workspace.host(first.id), workspace.host(second.id)];
  expect(hosts.every(Boolean)).toBe(true);

  project.edit("Reorder", () => project.moveDevice(second.id, 0));
  await workspace.flush();
  expect(project.tracks[0].devices.map((device) => device.id)).toEqual([second.id, first.id]);
  expect([workspace.host(first.id), workspace.host(second.id)]).toEqual(hosts);
  expect(workspace.cells.needsSync.value).toBe(false);
  expect(workspace.player.isPlaying.value).toBe(true);
  project.undo();
  await workspace.flush();
  expect(project.tracks[0].devices.map((device) => device.id)).toEqual([first.id, second.id]);
  expect([workspace.host(first.id), workspace.host(second.id)]).toEqual(hosts);

  // Taking the tail device away leaves the synth playing into the rack again.
  project.undo();
  await workspace.flush();
  expect(workspace.host(second.id)).toBeUndefined();
  expect(workspace.host(first.id)).toBe(hosts[0]);
  expect(await heard(workspace, keys.id, 1500)).toBeGreaterThan(0.001);

  // Undo the first addition too: the track plays its instrument again.
  project.undo();
  await workspace.flush();
  expect(project.tracks[0].devices).toEqual([]);
  expect(workspace.host(first.id)).toBeUndefined();
  expect(workspace.player.isPlaying.value).toBe(true);
  expect(await heard(workspace, keys.id, 1500)).toBeGreaterThan(0.001);
}, 60_000);
