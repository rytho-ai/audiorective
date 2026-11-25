import { ManualTickSource } from "@audiorective/clock";
import type { SoundFactory } from "@audiorective/core";
import { afterEach, expect, test } from "vitest";
import { Project, Workspace, renderMixRange, renderSession, sessionFor, type MidiClip } from "../src";

const RATE = 48_000;
const worklet = "/@fs" + new URL("../../host/dist/webclap-worklet.js", import.meta.url).pathname.replace(/^\/@fs/, "");
const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const click: SoundFactory = (context) => {
  const osc = new OscillatorNode(context, { frequency: 1000 });
  const gain = new GainNode(context, { gain: 0.5 });
  osc.connect(gain);
  return { output: gain, sources: [osc], duration: 0.02 };
};

const onsets = (x: ArrayLike<number>, threshold = 0.05) => {
  const found: number[] = [];
  let last = -Infinity;
  for (let i = 0; i < x.length; i++)
    if (Math.abs(x[i]!) > threshold) {
      if (i - last > RATE * 0.05) found.push(Math.round((i / RATE) * 20) / 20);
      last = i;
    }
  return found;
};

/** 120 BPM (a beat is 0.5 s). One pattern in scene one with a click on beat 0, placed linked on the timeline at beat 4 (2 s). */
async function setup(tracks = 1) {
  const project = new Project({ bpm: 120 });
  const drums = project.addTrack("Drums", "midi");
  const extra = tracks > 1 ? project.addTrack("Perc", "midi") : undefined;
  const session = sessionFor(project);
  const scene = session.addScene();
  const slot = { sceneId: scene.id, trackId: drums.id };
  const stored = session.setMidiClip(slot, { duration: 4, notes: [{ pitch: 60, velocity: 1, start: 0, duration: 0.25 }] });
  const placed = session.copyToArrangement(slot, { atBeat: 4, linked: true }) as MidiClip;
  const instruments: Record<string, { sound: SoundFactory }> = { [drums.id]: { sound: click } };
  if (extra) instruments[extra.id] = { sound: click };
  const context = new AudioContext({ sampleRate: RATE });
  const workspace = await Workspace.create(context, project, { workletUrl: worklet, instruments });
  cleanups.push(async () => {
    workspace.dispose();
    project.dispose();
    await context.close();
  });
  expect(workspace.warnings).toEqual([]);
  return { project, workspace, drums, extra, scene, slot, stored, placed, instruments };
}

async function timeline(project: Project, workspace: Workspace) {
  const result = await renderMixRange(workspace, {
    expectedVersion: project.cells.version.value,
    range: { startSeconds: 0, endSeconds: 6 },
    prerollSeconds: 0,
  });
  if (result.status !== "rendered") throw new Error(result.reason);
  return onsets(result.audio.channels[0]!);
}

test("renderSession and the timeline both hear an edit made through either side of a slot-and-timeline link, with no rebuild", async () => {
  const { project, workspace, scene, stored, placed } = await setup();
  const scene1 = async () => {
    const result = await renderSession(workspace, { scenes: [scene.id], tailSeconds: 0 });
    if (result.status !== "rendered") throw new Error(result.status);
    return onsets(result.audio.channels[0]!);
  };
  expect(await scene1()).toEqual([0]);
  expect(await timeline(project, workspace)).toEqual([2]);
  // Edit through the timeline clip: the scene's hit moves too.
  placed.midi.edit((notes) => {
    notes[0].start = 1;
  });
  expect(workspace.cells.needsSync.value).toBe(false);
  expect(await scene1()).toEqual([0.5]);
  expect(await timeline(project, workspace)).toEqual([2.5]);
  // Edit through the slot clip: the timeline moves.
  stored.midi.edit((notes) => {
    notes[0].start = 2;
  });
  expect(await scene1()).toEqual([1]);
  expect(await timeline(project, workspace)).toEqual([3]);
  // Leaving the group keeps each side's notes.
  project.makeClipUnique(stored.id);
  placed.midi.edit((notes) => {
    notes[0].start = 0;
  });
  expect(await scene1()).toEqual([1]);
  expect(await timeline(project, workspace)).toEqual([2]);
}, 60_000);

/** What the live Session plays: an offline Workspace, Arrangement off, the chain from the start. */
async function live(project: Project, instruments: Record<string, { sound: SoundFactory }>, scenes: string[], seconds: number) {
  const frames = Math.round(seconds * RATE);
  const context = new OfflineAudioContext(2, frames, RATE);
  const ticks = new ManualTickSource();
  const workspace = await Workspace.create(context as unknown as AudioContext, project, {
    destination: context.destination,
    tickSource: ticks,
    workletUrl: worklet,
    instruments,
    arrangement: false,
  });
  workspace.session.value.playChain(scenes.map((id) => sessionFor(project).scenes.findIndex((scene) => scene.id === id)));
  await workspace.play();
  ticks.tick();
  await workspace.renderSettled();
  let index = 1;
  let previous = 0;
  const next = () => {
    previous = Math.max(Math.ceil((index++ * 0.025 * RATE) / 128) * 128, previous + 128);
    return previous < frames ? previous : undefined;
  };
  let stop = next();
  let suspended = stop === undefined ? undefined : context.suspend((stop - 64) / RATE);
  const rendering = context.startRendering();
  while (stop !== undefined && suspended) {
    await suspended;
    ticks.tick();
    await workspace.renderSettled();
    stop = next();
    suspended = stop === undefined ? undefined : context.suspend((stop - 64) / RATE);
    await context.resume();
  }
  const buffer = await rendering;
  workspace.dispose();
  return buffer.getChannelData(0);
}

test("live Session playback plays a linked slot clip with the notes an edit through the timeline clip left in it", async () => {
  const { project, scene, placed, instruments } = await setup();
  placed.midi.edit((notes) => {
    notes[0].start = 1;
    notes.push({ id: "extra", pitch: 60, velocity: 1, start: 3, duration: 0.25 });
  });
  // The clip is two seconds long and plays twice: hits at beats 1 and 3 of each pass.
  expect(onsets(await live(project, instruments, [scene.id, scene.id], 4))).toEqual([0.5, 1.5, 2.5, 3.5]);
}, 60_000);

test("slot clips on two tracks that share notes each play into their own track", async () => {
  const { project, drums, extra, scene, stored, instruments } = await setup(2);
  const linked = sessionFor(project).copyToSlot(stored.id, { sceneId: scene.id, trackId: extra!.id }, { linked: true });
  expect(project.linkedClips(stored.id).map(({ id }) => id)).toContain(linked.id);
  // Each track alone must still sound: neither clip's notes end up in the other track's instrument.
  project.setTrackMuted(extra!.id, true);
  expect(onsets(await live(project, instruments, [scene.id], 2))).toEqual([0]);
  project.setTrackMuted(extra!.id, false);
  project.setTrackMuted(drums.id, true);
  expect(onsets(await live(project, instruments, [scene.id], 2))).toEqual([0]);
}, 60_000);
