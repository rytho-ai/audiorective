import type { SoundFactory } from "@audiorective/core";
import { afterEach, expect, test } from "vitest";
import { Project, Workspace, renderMixRange, type MidiClip } from "../src";

const RATE = 48_000;
const worklet = "/@fs" + new URL("../../host/dist/webclap-worklet.js", import.meta.url).pathname.replace(/^\/@fs/, "");
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A 1 kHz click 20 ms long. */
const click: SoundFactory = (context) => {
  const osc = new OscillatorNode(context, { frequency: 1000 });
  const gain = new GainNode(context, { gain: 0.5 });
  osc.connect(gain);
  return { output: gain, sources: [osc], duration: 0.02 };
};

const onsets = (x: Float32Array, threshold = 0.05) => {
  const found: number[] = [];
  let last = -Infinity;
  for (let i = 0; i < x.length; i++)
    if (Math.abs(x[i]) > threshold) {
      if (i - last > RATE * 0.05) found.push(Math.round((i / RATE) * 20) / 20);
      last = i;
    }
  return found;
};

test("a linked group plays the shared notes at each placement, an edit reaches all of them, and makeClipUnique leaves one out", async () => {
  // 120 BPM: a beat is 0.5 s. One click at the clip's start, placed at 0 s, 2 s and 4 s.
  const project = new Project({ bpm: 120 });
  const track = project.addTrack("Drums", "midi");
  const source = project.addMidiClip(track.id, { duration: 4, notes: [{ pitch: 60, velocity: 1, start: 0, duration: 0.25 }] }, 0);
  const second = project.duplicateClip(source.id, 4, { linked: true });
  const third = project.duplicateClip(source.id, 8, { linked: true });
  const context = new AudioContext({ sampleRate: RATE });
  const workspace = await Workspace.create(context, project, { workletUrl: worklet, instruments: { [track.id]: { sound: click } } });
  cleanups.push(async () => {
    workspace.dispose();
    project.dispose();
    await context.close();
  });
  const render = async () => {
    const result = await renderMixRange(workspace, {
      expectedVersion: project.cells.version.value,
      range: { startSeconds: 0, endSeconds: 6 },
      prerollSeconds: 0,
    });
    if (result.status !== "rendered") throw new Error(result.reason);
    return onsets(result.audio.channels[0]);
  };

  expect(await render()).toEqual([0, 2, 4]);

  // One edit moves the click in every placement, with no rebuild.
  source.midi.edit((notes) => {
    notes[0].start = 1;
  });
  expect(workspace.cells.needsSync.value).toBe(false);
  expect(await render()).toEqual([0.5, 2.5, 4.5]);

  // The second placement leaves the group; a later edit changes the other two only.
  const own = project.makeClipUnique(second.id) as MidiClip;
  expect(workspace.cells.needsSync.value).toBe(false);
  source.midi.edit((notes) => {
    notes[0].start = 2;
  });
  expect(own.midi.notes.value[0].start).toBe(1);
  expect(await render()).toEqual([1, 2.5, 5]);
  expect((project.tracks[0].clips.find(({ id }) => id === third.id) as MidiClip).midi.notes.value[0].start).toBe(2);
}, 60_000);
