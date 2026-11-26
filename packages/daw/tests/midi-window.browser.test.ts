import { ManualTickSource } from "@audiorective/clock";
import type { SoundFactory } from "@audiorective/core";
import { afterEach, describe, expect, test } from "vitest";
import { Project, Workspace, renderMixRange, renderSession, sessionFor, type MidiClip, type WorkspaceOptions } from "../src";

const RATE = 48_000;
const QUANTUM = 128;
const worklet = "/@fs" + new URL("../../host/dist/webclap-worklet.js", import.meta.url).pathname.replace(/^\/@fs/, "");
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
  expect(workspace.cells.warnings.value).toEqual([]);
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
const rounded = (times: number[]) => times.map((t) => Math.round(t * 100) / 100);
const rms = (x: Float32Array, from: number, to: number) => {
  let energy = 0;
  for (let i = Math.round(from * RATE); i < Math.round(to * RATE); i++) energy += x[i] * x[i];
  return Math.sqrt(energy / Math.max(1, Math.round((to - from) * RATE)));
};

const bundle = "/@fs" + new URL("../../../apps/daw-demo/public/plugin/oxo-synth2.wclap", import.meta.url).pathname.replace(/^\/@fs/, "");
const pluginId = "com.oxo.music.oxosynth2";

const hit = (start: number, pitch = 60, duration = 0.25) => ({ pitch, velocity: 1, start, duration });

/** 120 BPM, a beat is 0.5 s. A 16-beat clip at beat 0 with a hit every four beats (2 s). */
function bars() {
  const project = new Project({ bpm: 120 });
  const track = project.addTrack("Drums", "midi");
  const clip = project.addMidiClip(track.id, { duration: 16, notes: [0, 4, 8, 12].map((start) => hit(start)) }, 0);
  cleanups.push(() => project.dispose());
  return { project, track, clip, instruments: { [track.id]: { sound: click } } };
}

describe("MIDI clip windows in the Arrangement", () => {
  test("a trimmed clip plays only its window, and extending it again brings the hits back", async () => {
    const { project, clip, instruments } = bars();
    project.resizeClip(clip.id, { start: 4, end: 12 });
    const windowed = await render(project, 9, [], { instruments });
    // Hits at content beats 4 and 8 sound at project beats 4 and 8 (2 s and 4 s); the hits at 0 and 12 are hidden, not deleted.
    expect(rounded(onsets(windowed))).toEqual([2, 4]);
    expect((project.tracks[0].clips[0] as MidiClip).midi.notes.value).toHaveLength(4);
    project.resizeClip(clip.id, { start: 0, end: 16 });
    expect(rounded(onsets(await render(project, 9, [], { instruments })))).toEqual([0, 2, 4, 6]);
  }, 60_000);

  test("a slid window plays another part of the content from the same place", async () => {
    const { project, clip, instruments } = bars();
    project.resizeClip(clip.id, { start: 2, end: 6 });
    project.setClipSourceRange(clip.id, { start: 7.5, end: 11.5 });
    // The window is content beats [7.5, 11.5): the hit at 8 plays 0.5 beats into the clip, which starts at beat 2 (1 s).
    expect(rounded(onsets(await render(project, 5, [], { instruments })))).toEqual([1.25]);
  }, 30_000);

  test("a note crossing the window start sounds from it; a note crossing its end is cut with no hung note", async () => {
    const project = new Project({ bpm: 120 });
    const track = project.addTrack("Synth", "midi");
    project.addDevice(track.id, { kind: "webclap", pluginId, name: "Synth", vendor: "", version: "", bundleUrl: bundle });
    const clip = project.addMidiClip(track.id, { duration: 16, notes: [{ pitch: 48, velocity: 0.9, start: 0, duration: 16 }] }, 0);
    cleanups.push(() => project.dispose());
    const held = await render(project, 8, [], { workletUrl: worklet });
    project.resizeClip(clip.id, { start: 2, end: 6 });
    // Beats 2 to 6 are 1 s to 3 s: the held note starts at 1 s inside the window and is released at 3 s.
    const cut = await render(project, 8, [], { workletUrl: worklet });
    expect(rms(held, 0.2, 0.9)).toBeGreaterThan(0.01);
    expect(rms(cut, 0, 0.9)).toBeLessThan(0.001);
    expect(rms(cut, 1.2, 2.8)).toBeGreaterThan(0.01);
    expect(rms(cut, 4.5, 7.5)).toBeLessThan(rms(cut, 1.2, 2.8) / 20);
  }, 60_000);

  test("an offline mix and the live render agree on a windowed clip", async () => {
    const { project, clip, instruments } = bars();
    project.resizeClip(clip.id, { start: 4, end: 12 });
    const context = new AudioContext({ sampleRate: RATE });
    const workspace = await Workspace.create(context, project, { workletUrl: worklet, instruments });
    cleanups.push(async () => {
      workspace.dispose();
      await context.close();
    });
    const rendered = await renderMixRange(workspace, { expectedVersion: project.cells.version.value, range: { startSeconds: 0, endSeconds: 6 } });
    if (rendered.status !== "rendered") throw new Error(rendered.status);
    expect(rounded(onsets(Float32Array.from(rendered.audio.channels[0])))).toEqual([2, 4]);
  }, 60_000);
});

describe("MIDI clip windows in the Session", () => {
  /** A Session clip of eight beats (4 s) with hits at beats 1, 3, 5 and 7; it plays in scene 0. */
  function slotClip(window: { sourceOffset?: number; duration: number }) {
    const project = new Project({ bpm: 120 });
    const track = project.addTrack("Drums", "midi");
    const session = sessionFor(project);
    const scene = session.addScene();
    const clip = session.setMidiClip({ trackId: track.id, sceneId: scene.id }, { notes: [1, 3, 5, 7].map((start) => hit(start)), ...window });
    cleanups.push(() => project.dispose());
    return { project, track, clip, instruments: { [track.id]: { sound: click } } };
  }
  const launch = (trackId: string) => ({ at: 0.2, run: (w: Workspace) => w.cells.session.value.tracks[trackId]!.clips[0]!.launch() });

  test("a slot clip with a sourceOffset plays exactly its window on every pass", async () => {
    const { project, track, instruments } = slotClip({ sourceOffset: 4, duration: 4 });
    const x = await render(project, 8, [launch(track.id)], { instruments, arrangement: false });
    // Launched on the bar at 2 s; the window is content beats [4, 8): hits at its beats 1 and 3, every 2 s pass.
    expect(rounded(onsets(x))).toEqual([2.5, 3.5, 4.5, 5.5, 6.5, 7.5]);
  }, 30_000);

  test("a looped slot clip plays its loop alone, not the lead-in before it", async () => {
    const { project, track, clip, instruments } = slotClip({ duration: 8 });
    project.setClipLoop(clip.id, { startBeat: 4, endBeat: 8 });
    const x = await render(project, 8, [launch(track.id)], { instruments, arrangement: false });
    // The loop [4, 8) is 2 s long with hits at beats 1 and 3 of it. Hits at content beats 1 and 3 never sound.
    expect(rounded(onsets(x))).toEqual([2.5, 3.5, 4.5, 5.5, 6.5, 7.5]);
  }, 30_000);

  test("renderSession plays the same window as the live Session", async () => {
    const { project, track, instruments } = slotClip({ sourceOffset: 4, duration: 4 });
    const context = new AudioContext({ sampleRate: RATE });
    const workspace = await Workspace.create(context, project, { workletUrl: worklet, instruments });
    cleanups.push(async () => {
      workspace.dispose();
      await context.close();
    });
    const [scene] = sessionFor(project).scenes;
    const rendered = await renderSession(workspace, { scenes: [scene.id, scene.id], tailSeconds: 0 });
    if (rendered.status !== "rendered") throw new Error(rendered.status);
    expect(rounded(onsets(Float32Array.from(rendered.audio.channels[0])))).toEqual([0.5, 1.5, 2.5, 3.5]);
    void track;
  }, 60_000);
});

describe("editing a held note while it sounds", () => {
  /** A sine that holds until the note ends, at a frequency that follows the pitch. */
  const tone: SoundFactory = (context, hit) => {
    const osc = new OscillatorNode(context, { frequency: 250 * 2 ** (hit.pitch / 12) });
    const env = new GainNode(context, { gain: 0.3 });
    osc.connect(env);
    return { output: env, sources: [osc] };
  };
  /** Upward zero crossings per second inside a window: the pitch of a pure tone. */
  const hertz = (x: Float32Array, from: number, to: number) => {
    let crossings = 0;
    for (let i = Math.round(from * RATE) + 1; i < Math.round(to * RATE); i++) if (x[i - 1] < 0 && x[i] >= 0) crossings++;
    return crossings / (to - from);
  };
  function held() {
    const project = new Project({ bpm: 120 });
    const track = project.addTrack("Lead", "midi");
    const clip = project.addMidiClip(track.id, { duration: 16, notes: [{ pitch: 60, velocity: 1, start: 0, duration: 12 }] }, 0);
    cleanups.push(() => project.dispose());
    return { project, clip, instruments: { [track.id]: { sound: tone } } };
  }

  test("a re-pitched note ends the old pitch and sounds the new one at once, to the note's end", async () => {
    const { project, clip, instruments } = held();
    const x = await render(project, 7, [{ at: 2, run: () => clip.midi.edit((notes) => void (notes[0].pitch = 67)) }], { instruments });
    const before = hertz(x, 1, 1.9);
    expect(hertz(x, 2.1, 2.2) / before).toBeCloseTo(2 ** (7 / 12), 1);
    expect(hertz(x, 2.1, 5.9) / before).toBeCloseTo(2 ** (7 / 12), 1);
    // Sounding without a gap from the edit on, and silent after the note ends at 6 s.
    expect(rms(x, 2.05, 5.95)).toBeGreaterThan(0.1);
    expect(rms(x, 6.2, 6.9)).toBeLessThan(0.005);
  }, 30_000);

  test("a start edit that still covers the playhead restarts the note: same pitch keeps sounding, released once at the end", async () => {
    const { project, clip, instruments } = held();
    const x = await render(project, 7, [{ at: 2, run: () => clip.midi.edit((notes) => void (notes[0].start = 1)) }], { instruments });
    expect(rms(x, 2.05, 6.4)).toBeGreaterThan(0.1);
    expect(rms(x, 6.7, 6.95)).toBeLessThan(0.005);
    expect(rounded(onsets(x))[0]).toBeLessThan(0.01);
  }, 30_000);

  test("a note shortened to end before the playhead goes silent at the edit", async () => {
    const { project, clip, instruments } = held();
    const x = await render(project, 7, [{ at: 2, run: () => clip.midi.edit((notes) => void (notes[0].duration = 3)) }], { instruments });
    // Shortened to end at beat 3 (1.5 s): it is already over at the edit.
    expect(rms(x, 1.0, 1.4)).toBeGreaterThan(0.1);
    expect(rms(x, 2.1, 5.9)).toBeLessThan(0.005);
  }, 30_000);
});
