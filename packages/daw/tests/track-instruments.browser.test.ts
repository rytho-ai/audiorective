import { ManualTickSource } from "@audiorective/clock";
import type { SoundFactory } from "@audiorective/core";
import { afterEach, describe, expect, test } from "vitest";
import { Project, Workspace, openWorkspace, renderMixRange, saveWorkspace, type WorkspaceOptions } from "../src";
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

/** A 1 kHz click 20 ms long, made with plain Web Audio. */
const click: SoundFactory = (context) => {
  const osc = new OscillatorNode(context, { frequency: 1000 });
  const gain = new GainNode(context, { gain: 0.5 });
  osc.connect(gain);
  return { output: gain, sources: [osc], duration: 0.02 };
};

/** Offline render with actions at given seconds; the transport ticks every 25 ms as live. */
async function render(
  project: Project,
  seconds: number,
  actions: Array<{ at: number; run: (workspace: Workspace) => void }>,
  options: WorkspaceOptions = {},
) {
  const frames = Math.round(seconds * RATE);
  const context = new OfflineAudioContext(2, frames, RATE);
  const ticks = new ManualTickSource();
  const workspace = await Workspace.create(context as unknown as AudioContext, project, {
    destination: context.destination,
    tickSource: ticks,
    workletUrl: worklet,
    ...options,
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

const onsets = (x: Float32Array, threshold = 0.05) => {
  const found: number[] = [];
  let last = -Infinity;
  for (let i = 0; i < x.length; i++)
    if (Math.abs(x[i]) > threshold) {
      if (i - last > RATE * 0.05) found.push(i / RATE);
      last = i;
    }
  return found;
};
const peak = (x: Float32Array, from: number, to: number) => {
  let max = 0;
  for (let i = Math.round(from * RATE); i < Math.round(to * RATE); i++) max = Math.max(max, Math.abs(x[i]));
  return max;
};

/** 120 BPM: a beat is 0.5 s. A drum track with no plug-in: hits at beats 2 and 4, the second at half velocity; scene 0 of the Session holds a one-hit loop. */
function drums() {
  const project = new Project({ bpm: 120 });
  const track = project.addTrack("Drums", "midi");
  project.addMidiClip(
    track.id,
    {
      duration: 8,
      notes: [
        { pitch: 60, velocity: 1, start: 2, duration: 0.25 },
        { pitch: 60, velocity: 0.5, start: 4, duration: 0.25 },
      ],
    },
    0,
  );
  fillSession(project, track.id, [{ duration: 4, notes: [{ pitch: 60, velocity: 1, start: 1, duration: 0.25 }] }]);
  cleanups.push(() => project.dispose());
  return { project, track, instruments: { [track.id]: { sound: click } } };
}

describe("instruments: page-made sound on a MIDI track without a plug-in", () => {
  test("Arrangement notes start on their sample with velocity, through the track's channel", async () => {
    const { project, track, instruments } = drums();
    const x = await render(project, 3, [], { instruments });
    const hits = onsets(x);
    expect(hits.length).toBe(2);
    expect(Math.abs(hits[0] - 1)).toBeLessThan(3 / RATE);
    expect(Math.abs(hits[1] - 2)).toBeLessThan(3 / RATE);
    expect(peak(x, 1.9, 2.1) / peak(x, 0.9, 1.1)).toBeCloseTo(0.5, 1);
    project.setTrackMuted(track.id, true);
    const muted = await render(project, 3, [], { instruments });
    expect(peak(muted, 0, 3)).toBe(0);
    expect(await render(project, 1, [])).toBeTruthy();
  }, 30_000);

  test("Session launches the track's clip and loops it on the bar", async () => {
    const { project, track, instruments } = drums();
    const x = await render(project, 7, [{ at: 0.5, run: (w) => w.session.value.tracks[track.id]!.clips[0]!.launch() }], { instruments });
    // Arrangement hit at 1 s is held back from bar 1 (2 s); Session hits at beat 1 of each bar: 2.5, 4.5, 6.5 s.
    const hits = onsets(x).filter((t) => t >= 2);
    expect(hits.map((t) => Math.round(t * 1000) / 1000)).toEqual([2.5, 4.5, 6.5]);
  }, 30_000);

  test("renderMixRange, save and reopen play the instrument again; a track with a plug-in keeps its plug-in", async () => {
    const { project, track, instruments } = drums();
    const synth = project.addTrack("Synth", "midi");
    project.addWebClapDevice(synth.id, { pluginId, name: "Synth", vendor: "", version: "", bundleUrl: bundle });
    const context = new AudioContext({ sampleRate: RATE });
    const workspace = await Workspace.create(context, project, {
      workletUrl: worklet,
      instruments: { ...instruments, [synth.id]: { sound: click } },
    });
    cleanups.push(async () => {
      workspace.dispose();
      await context.close();
    });
    expect(workspace.warnings).toEqual([]);
    const first = await renderMixRange(workspace, { expectedVersion: project.cells.version.value, range: { startBeat: 0, endBeat: 6 } });
    if (first.status !== "rendered") throw new Error(first.status);
    expect(onsets(Float32Array.from(first.audio.channels[0])).map((t) => Math.round(t * 1000) / 1000)).toEqual([1, 2]);
    const bytes = await saveWorkspace(workspace);
    const second = new AudioContext({ sampleRate: RATE });
    const reopened = await openWorkspace(second, bytes, { workletUrl: worklet, resolveBundle: () => bundle, instruments });
    cleanups.push(async () => {
      reopened.dispose();
      await second.close();
    });
    const again = await renderMixRange(reopened, { expectedVersion: reopened.project.cells.version.value, range: { startBeat: 0, endBeat: 6 } });
    if (again.status !== "rendered") throw new Error(again.status);
    expect(onsets(Float32Array.from(again.audio.channels[0])).map((t) => Math.round(t * 1000) / 1000)).toEqual([1, 2]);
    expect(reopened.project.tracks.find((t) => t.name === "Drums")!.id).toBe(track.id);
  }, 30_000);
});

describe("instruments: chosen by a function of the track", () => {
  test("a reopened song and a track added before sync() get their sound by name and kind, without an id lookup", async () => {
    const { project } = drums();
    const context = new AudioContext({ sampleRate: RATE });
    const workspace = await Workspace.create(context, project, { workletUrl: worklet });
    cleanups.push(async () => {
      workspace.dispose();
      await context.close();
    });
    const bytes = await saveWorkspace(workspace);
    const sounds: Record<string, { sound: SoundFactory }> = { Drums: { sound: click } };
    const seen: string[] = [];
    const second = new AudioContext({ sampleRate: RATE });
    const reopened = await openWorkspace(second, bytes, {
      workletUrl: worklet,
      instruments: (track) => {
        seen.push(`${track.name}:${track.kind}`);
        return sounds[track.name];
      },
    });
    cleanups.push(async () => {
      reopened.dispose();
      await second.close();
    });
    expect(reopened.warnings).toEqual([]);
    expect(seen).toContain("Drums:midi");
    const first = await renderMixRange(reopened, { expectedVersion: reopened.project.cells.version.value, range: { startBeat: 0, endBeat: 6 } });
    if (first.status !== "rendered") throw new Error(first.status);
    expect(onsets(Float32Array.from(first.audio.channels[0])).map((t) => Math.round(t * 1000) / 1000)).toEqual([1, 2]);

    // A track added later is picked up by the same function when sync() builds it.
    sounds.Bass = { sound: click };
    const bass = reopened.project.addTrack("Bass", "midi");
    reopened.project.addMidiClip(bass.id, { duration: 8, notes: [{ pitch: 60, velocity: 1, start: 5, duration: 0.25 }] }, 0);
    await reopened.sync();
    const second2 = await renderMixRange(reopened, { expectedVersion: reopened.project.cells.version.value, range: { startBeat: 0, endBeat: 6 } });
    if (second2.status !== "rendered") throw new Error(second2.status);
    expect(onsets(Float32Array.from(second2.audio.channels[0])).map((t) => Math.round(t * 1000) / 1000)).toEqual([1, 2, 2.5]);
    expect(seen).toContain("Bass:midi");
  }, 30_000);
});

describe("instruments: releases behave like a device queue", () => {
  const tone = (() => {
    const buffer = new AudioBuffer({ length: RATE * 8, sampleRate: RATE });
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = 0.3 * Math.sin((2 * Math.PI * 220 * i) / RATE);
    return buffer;
  })();
  const rms = (x: Float32Array, from: number, to: number) => {
    let energy = 0;
    for (let i = Math.round(from * RATE); i < Math.round(to * RATE); i++) energy += x[i] * x[i];
    return Math.sqrt(energy / Math.max(1, Math.round((to - from) * RATE)));
  };
  /** One held note (beats) in Arrangement and an empty Session clip in scene 0. */
  function held(start: number, duration: number) {
    const project = new Project({ bpm: 120 });
    const track = project.addTrack("Keys", "midi");
    project.addMidiClip(track.id, { duration: 16, notes: [{ pitch: 64, velocity: 1, start, duration }] }, 0);
    fillSession(project, track.id, [{ duration: 4, notes: [] }]);
    cleanups.push(() => project.dispose());
    return { project, track, instruments: { [track.id]: { sound: tone, rootNote: 64 } } };
  }

  test("a note starting inside the look-ahead before a Session handover is released at the handover", async () => {
    const { project, track, instruments } = held(3.9, 1.1);
    const x = await render(project, 4, [{ at: 0.5, run: (w) => w.session.value.tracks[track.id]!.clips[0]!.launch() }], { instruments });
    expect(rms(x, 1.96, 1.99)).toBeGreaterThan(0.05);
    expect(rms(x, 2.1, 4)).toBe(0);
  }, 30_000);

  test("a withdrawn launch does not cut the Arrangement note", async () => {
    const { project, track, instruments } = held(1, 6);
    const x = await render(
      project,
      4,
      [
        { at: 0.75, run: (w) => w.session.value.tracks[track.id]!.clips[0]!.launch() },
        { at: 1.9, run: (w) => w.session.value.tracks[track.id]!.cancelQueued() },
      ],
      { instruments },
    );
    expect(rms(x, 2.1, 3.4)).toBeGreaterThan(0.05);
  }, 30_000);

  test("a handover never makes an earlier note-off later", async () => {
    const { project, track, instruments } = held(1, 2.9);
    const x = await render(project, 3, [{ at: 1.9, run: (w) => w.session.value.tracks[track.id]!.clips[0]!.launch() }], { instruments });
    expect(rms(x, 1.0, 1.9)).toBeGreaterThan(0.05);
    expect(rms(x, 1.96, 1.995)).toBe(0);
  }, 30_000);
});
