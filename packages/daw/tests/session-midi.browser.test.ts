import { ManualTickSource } from "@audiorective/clock";
import { afterEach, describe, expect, test } from "vitest";
import { Project, Workspace, openWorkspace, saveWorkspace } from "../src";
import { fillSession } from "./session-slots";

const RATE = 48_000;
const QUANTUM = 128;
const worklet = "/@fs" + new URL("../../host/dist/webclap-worklet.js", import.meta.url).pathname.replace(/^\/@fs/, "");
const bundle = "/@fs" + new URL("../../../apps/daw-demo/public/plugin/oxo-synth2.wclap", import.meta.url).pathname.replace(/^\/@fs/, "");
const pluginId = "com.oxo.music.oxosynth2";
const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** Offline render with actions at given seconds; the transport ticks every 25 ms as live. */
async function render(project: Project, seconds: number, actions: Array<{ at: number; run: (workspace: Workspace) => void }>) {
  const frames = Math.round(seconds * RATE);
  const context = new OfflineAudioContext(2, frames, RATE);
  const ticks = new ManualTickSource();
  const workspace = await Workspace.create(context as unknown as AudioContext, project, {
    destination: context.destination,
    tickSource: ticks,
    workletUrl: worklet,
  });
  expect(workspace.warnings).toEqual([]);
  const pending = [...actions].sort((a, b) => a.at - b.at);
  while (pending[0]?.at === 0) pending.shift()!.run(workspace);
  await workspace.play();
  ticks.tick();
  await workspace.renderSettled();
  let index = 1;
  let previous = 0;
  const next = () => {
    previous = Math.max(Math.ceil((index++ * 0.025 * RATE) / QUANTUM) * QUANTUM, previous + QUANTUM);
    return previous < frames ? previous : undefined;
  };
  let stop = next();
  let suspended = stop === undefined ? undefined : context.suspend((stop - QUANTUM / 2) / RATE);
  const rendering = context.startRendering();
  while (stop !== undefined && suspended) {
    await suspended;
    while (pending.length && pending[0].at <= stop / RATE) pending.shift()!.run(workspace);
    ticks.tick();
    await workspace.renderSettled();
    stop = next();
    suspended = stop === undefined ? undefined : context.suspend((stop - QUANTUM / 2) / RATE);
    await context.resume();
  }
  const buffer = await rendering;
  workspace.dispose();
  return buffer.getChannelData(0);
}

const rms = (x: Float32Array, from: number, to: number) => {
  let energy = 0;
  for (let i = Math.round(from * RATE); i < Math.round(to * RATE); i++) energy += x[i] * x[i];
  return Math.sqrt(energy / Math.max(1, Math.round((to - from) * RATE)));
};

/**
 * 120 BPM: a bar is 2 s. The Arrangement holds one long note. The Session holds, in scene 0 an empty clip, in scene 1 a one-beat note per bar, and in scene 2 a note held
 * all bar.
 */
function song() {
  const project = new Project({ bpm: 120 });
  const track = project.addTrack("Synth", "midi");
  project.addWebClapDevice(track.id, { pluginId, name: "Synth", vendor: "", version: "", bundleUrl: bundle });
  project.addMidiClip(track.id, { duration: 16, notes: [{ pitch: 48, velocity: 0.9, start: 0, duration: 16 }] }, 0);
  fillSession(project, track.id, [
    { duration: 4, notes: [] },
    { duration: 4, notes: [{ pitch: 60, velocity: 0.9, start: 0, duration: 1 }] },
    { duration: 4, notes: [{ pitch: 64, velocity: 0.9, start: 0, duration: 4 }] },
  ]);
  cleanups.push(() => project.dispose());
  return { project, track };
}
const slot = (workspace: Workspace, trackId: string, index: number) => workspace.session.value.tracks[trackId]!.clips[index]!;

describe("Session MIDI through the track's device", () => {
  test("a launched MIDI clip takes the track from Arrangement without a hung note", async () => {
    const control = song();
    const held = await render(control.project, 6, []);
    const launched = song();
    const silent = await render(launched.project, 6, [{ at: 2.5, run: (w) => slot(w, launched.track.id, 0).launch() }]);
    expect(rms(held, 4.5, 5.5)).toBeGreaterThan(0.01);
    expect(rms(silent, 2.5, 3.9)).toBeGreaterThan(0.01);
    expect(rms(silent, 4.6, 5.9)).toBeLessThan(rms(held, 4.5, 5.5) / 20);
  }, 30_000);

  test("a MIDI clip loops on its bar, and switching clips releases a held note", async () => {
    const { project, track } = song();
    const x = await render(project, 12, [
      { at: 0.5, run: (w) => slot(w, track.id, 1).launch() },
      { at: 6.5, run: (w) => slot(w, track.id, 2).launch() },
      { at: 8.5, run: (w) => slot(w, track.id, 0).launch() },
    ]);
    for (const bar of [2, 4]) {
      expect(rms(x, bar + 0.05, bar + 0.4)).toBeGreaterThan(0.01);
      expect(rms(x, bar + 1.2, bar + 1.9)).toBeLessThan(rms(x, bar + 0.05, bar + 0.4) / 10);
    }
    expect(rms(x, 8.3, 9.8)).toBeGreaterThan(0.01);
    expect(rms(x, 10.6, 11.9)).toBeLessThan(rms(x, 8.3, 9.8) / 20);
  }, 30_000);

  test("Stop hands the track back to Arrangement", async () => {
    const { project, track } = song();
    project.addMidiClip(track.id, { duration: 2, notes: [{ pitch: 55, velocity: 0.9, start: 0, duration: 2 }] }, 20);
    const x = await render(project, 12, [
      { at: 0.5, run: (w) => slot(w, track.id, 0).launch() },
      { at: 6.5, run: (w) => w.session.value.stopAll() },
    ]);
    // The Arrangement note is released at the 2 s bar; the synth's release tail fades by about 4 s.
    expect(rms(x, 4.5, 7.9)).toBeLessThan(0.001);
    expect(rms(x, 10.1, 10.9)).toBeGreaterThan(0.01);
  }, 30_000);

  test("a plug-in change made while a Session clip plays is saved and comes back", async () => {
    const { project, track } = song();
    const context = new AudioContext({ sampleRate: RATE });
    const workspace = await Workspace.create(context, project, { workletUrl: worklet });
    cleanups.push(async () => {
      workspace.dispose();
      await context.close();
    });
    await context.resume();
    slot(workspace, track.id, 1).launch();
    await workspace.play();
    await new Promise((resolve) => setTimeout(resolve, 300));
    const host = workspace.host(project.tracks[0].devices[0].id)!;
    const param = host.parameterInfo.find(({ name }) => /cutoff|freq/i.test(name)) ?? host.parameterInfo[0];
    const edited = Math.round(param.min + (param.max - param.min) * 0.25);
    const version = project.cells.version.value;
    host.params[String(param.id) as `${number}`].value = edited;
    const bytes = await saveWorkspace(workspace);
    expect(workspace.player.isPlaying.value).toBe(true);
    expect(project.cells.version.value).toBe(version);
    expect(project.cells.history.value).toEqual({});
    const second = new AudioContext({ sampleRate: RATE });
    const reopened = await openWorkspace(second, bytes, { workletUrl: worklet, resolveBundle: () => bundle });
    cleanups.push(async () => {
      reopened.dispose();
      await second.close();
    });
    const again = reopened.host(reopened.project.tracks[0].devices[0].id)!;
    expect(again.params[String(param.id) as `${number}`].value).toBeCloseTo(edited, 4);
    expect(reopened.session.value.tracks[reopened.project.tracks[0].id]!.clips[1]).toBeTruthy();
  }, 30_000);
  test("deviceOptions reopens a saved file with the plug-ins this workspace loaded, and declines other URLs", async () => {
    const { project } = song();
    const context = new AudioContext({ sampleRate: RATE });
    const workspace = await Workspace.create(context, project, { workletUrl: worklet });
    const bytes = await saveWorkspace(workspace);
    const second = new AudioContext({ sampleRate: RATE });
    const reopened = await openWorkspace(second, bytes, workspace.deviceOptions);
    cleanups.push(async () => {
      reopened.dispose();
      workspace.dispose();
      await second.close();
      await context.close();
    });
    expect(reopened.warnings).toEqual([]);
    expect(reopened.host(reopened.project.tracks[0].devices[0].id)).toBeTruthy();
    const device = { ...project.tracks[0].devices[0] };
    expect(await workspace.deviceOptions.resolveBundle!({ ...device, bundleUrl: "https://elsewhere.example/oxo.wclap" })).toBeUndefined();
    expect(await workspace.deviceOptions.resolveBundle!({ ...device, pluginId: "com.other.plugin" })).toBeUndefined();
  }, 30_000);

  test("Arrangement plays the note on the bar where Stop hands the track back", async () => {
    const make = () => {
      const project = new Project({ bpm: 120 });
      const track = project.addTrack("Synth", "midi");
      project.addWebClapDevice(track.id, { pluginId, name: "Synth", vendor: "", version: "", bundleUrl: bundle });
      project.addMidiClip(track.id, { duration: 4, notes: [] }, 0);
      project.addMidiClip(track.id, { duration: 1, notes: [{ pitch: 60, velocity: 0.9, start: 0, duration: 1 }] }, 8);
      fillSession(project, track.id, [{ duration: 4, notes: [] }]);
      cleanups.push(() => project.dispose());
      return { project, track };
    };
    const control = await render(make().project, 5, []);
    const { project, track } = make();
    const x = await render(project, 5, [
      { at: 0.5, run: (w) => slot(w, track.id, 0).launch() },
      { at: 2.5, run: (w) => w.session.value.stopAll() },
    ]);
    expect(rms(control, 4.02, 4.45)).toBeGreaterThan(0.01);
    expect(rms(x, 4.02, 4.45)).toBeGreaterThan(rms(control, 4.02, 4.45) * 0.8);
  }, 30_000);

  test("a track stopped on the bar where another track launches releases its held note", async () => {
    const project = new Project({ bpm: 120 });
    const tracks = ["A", "B"].map((name) => {
      const track = project.addTrack(name, "midi");
      project.addWebClapDevice(track.id, { pluginId, name, vendor: "", version: "", bundleUrl: bundle });
      return track;
    });
    fillSession(project, tracks[0].id, [{ duration: 8, notes: [{ pitch: 48, velocity: 0.9, start: 0, duration: 8 }] }]);
    fillSession(project, tracks[1].id, [{ duration: 4, notes: [] }]);
    cleanups.push(() => project.dispose());
    const x = await render(project, 9, [
      { at: 0.5, run: (w) => slot(w, tracks[0].id, 0).launch() },
      {
        at: 2.5,
        run: (w) => {
          w.session.value.tracks[tracks[0].id]!.stop();
          slot(w, tracks[1].id, 0).launch();
        },
      },
    ]);
    expect(rms(x, 2.5, 3.9)).toBeGreaterThan(0.01);
    // A's note is cut at the 4 s bar (its own end would be 6 s); the synth's release tail is gone well before 7 s.
    expect(rms(x, 7, 9)).toBeLessThan(0.001);
  }, 30_000);
});
