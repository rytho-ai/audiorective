import { ManualTickSource } from "@audiorective/clock";
import type { SoundFactory } from "@audiorective/core";
import { afterEach, describe, expect, test } from "vitest";
import { Project, Workspace, sessionFor, type WorkspaceOptions } from "../src";

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

/** `bursts` seconds of a recording that is `seconds` long: 20 ms of a constant 0.8 at each time. */
const burstsAt = (seconds: number, bursts: number[]) => {
  const data = new Float32Array(Math.round(seconds * RATE));
  for (const time of bursts) data.fill(0.8, Math.round(time * RATE), Math.round((time + 0.02) * RATE));
  return data;
};

const hit = (start: number) => ({ pitch: 60, velocity: 1, start, duration: 0.25 });

describe("setClipSourceRange on looped and stretched clips plays the new part", () => {
  test("a looped MIDI clip loops the new range from the same place, and so does its Session slot", async () => {
    const project = new Project({ bpm: 120 });
    const track = project.addTrack("Drums", "midi");
    // 120 BPM: a beat is 0.5 s. Hits at content beat 0 and 9; the clip lasts 16 beats (8 s).
    const clip = project.addMidiClip(track.id, { duration: 16, notes: [hit(0), hit(9)] }, 0);
    cleanups.push(() => project.dispose());
    const instruments = { [track.id]: { sound: click } };
    project.setClipLoop(clip.id, { startBeat: 0, endBeat: 4 });
    expect(rounded(onsets(await render(project, 9, [], { instruments })))).toEqual([0, 2, 4, 6]);
    project.setClipSourceRange(clip.id, { start: 8, end: 12 });
    // The loop is content beats [8, 12): the hit at 9 is beat 1 of every 4-beat pass, so 0.5 s, 2.5 s, ...
    expect(rounded(onsets(await render(project, 9, [], { instruments })))).toEqual([0.5, 2.5, 4.5, 6.5]);

    const session = sessionFor(project);
    const scene = session.addScene();
    const slot = session.copyToSlot(clip.id, { trackId: track.id, sceneId: scene.id });
    project.removeClip(clip.id);
    project.setClipSourceRange(slot.id, { start: 0, end: 4 });
    project.edit("Slip", () => void project.setClipSourceRange(slot.id, { start: 8, end: 12 }));
    const played = await render(project, 9, [{ at: 0.2, run: (w) => w.cells.session.value.launchScene(0) }], { instruments });
    // Launched on the bar at 2 s, the slot loops the same range.
    expect(rounded(onsets(played))).toEqual([2.5, 4.5, 6.5, 8.5]);
    project.undo();
    const before = await render(project, 9, [{ at: 0.2, run: (w) => w.cells.session.value.launchScene(0) }], { instruments });
    expect(rounded(onsets(before))).toEqual([2, 4, 6, 8]);
  }, 60_000);

  test("a looped audio clip loops the new recording range from the same place", async () => {
    const project = new Project({ bpm: 120 });
    const track = project.addTrack("Take", "audio");
    const clip = project.addAudioClip(track.id, { sampleRate: RATE, channels: [burstsAt(4, [0.25, 1.5, 2.75, 3.5])] }, 0);
    cleanups.push(() => project.dispose());
    project.setClipLoop(clip.id, { startSeconds: 0, endSeconds: 1 });
    project.resizeClip(clip.id, { end: 4 });
    expect(rounded(onsets(await render(project, 4.5, [])))).toEqual([0.25, 1.25, 2.25, 3.25]);
    project.setClipSourceRange(clip.id, { start: 2, end: 3 });
    expect(project.tracks[0].clips[0]).toMatchObject({ time: 0, duration: 4 });
    // The loop is recording seconds [2, 3): the burst at 2.75 is 0.75 s into every pass.
    expect(rounded(onsets(await render(project, 4.5, [])))).toEqual([0.75, 1.75, 2.75, 3.75]);
  }, 60_000);

  test("a time-stretched audio clip plays the chosen part of its stretched audio at its own place", async () => {
    const project = new Project({ bpm: 120 });
    const track = project.addTrack("Take", "audio");
    const clip = project.addAudioClip(track.id, { sampleRate: RATE, channels: [burstsAt(4, [0.5, 1.5, 2.5, 3.5])] }, 1);
    cleanups.push(() => project.dispose());
    // Stretched to twice the length: the bursts are at 1, 3, 5 and 7 s of the stored audio.
    const stretched = project.applyAudioClipStretch(clip, 2, { sampleRate: RATE, channels: [burstsAt(8, [1, 3, 5, 7])] });
    expect(rounded(onsets(await render(project, 10, [])))).toEqual([2, 4, 6, 8]);
    project.setClipSourceRange(stretched.id, { start: 2, end: 6 });
    // Stored seconds [2, 6) hold the bursts at 3 and 5: 1 s and 3 s into the clip, which still starts at 1 s.
    expect(rounded(onsets(await render(project, 10, [])))).toEqual([2, 4]);
  }, 60_000);
});
