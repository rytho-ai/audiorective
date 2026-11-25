import { ManualTickSource } from "@audiorective/clock";
import type { SoundFactory } from "@audiorective/core";
import { afterEach, describe, expect, test, vi } from "vitest";
import { MidiClip as MidiNotes } from "@audiorective/midi";
import { Project, Workspace, sessionFor, type MidiClip, type WorkspaceOptions } from "../src";
import { fillSession } from "./session-slots";

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
  /** Opens the Workspace some other way, for example from a saved file; default `Workspace.create` over `project`. */
  open?: (context: AudioContext, options: WorkspaceOptions) => Promise<Workspace>,
) {
  const frames = Math.round(seconds * RATE);
  const context = new OfflineAudioContext(2, frames, RATE);
  const ticks = new ManualTickSource();
  const all = { destination: context.destination, tickSource: ticks, workletUrl: worklet, ...options };
  const workspace = open
    ? await open(context as unknown as AudioContext, all)
    : await Workspace.create(context as unknown as AudioContext, project, all);
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

const rms = (x: Float32Array, from: number, to: number) => {
  let energy = 0;
  for (let i = Math.round(from * RATE); i < Math.round(to * RATE); i++) energy += x[i] * x[i];
  return Math.sqrt(energy / Math.max(1, Math.round((to - from) * RATE)));
};
const tone = (() => {
  const buffer = new AudioBuffer({ length: RATE * 12, sampleRate: RATE });
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = 0.3 * Math.sin((2 * Math.PI * 220 * i) / RATE);
  return buffer;
})();

const slot = (workspace: Workspace, trackId: string, index: number) => workspace.session.value.tracks[trackId]!.clips[index]!;

/** 120 BPM: a beat is 0.5 s, a bar 2 s. */
function oneTrack(notes: Array<{ pitch: number; velocity: number; start: number; duration: number }>, sound: SoundFactory | AudioBuffer = click) {
  const project = new Project({ bpm: 120 });
  const track = project.addTrack("Lead", "midi");
  fillSession(project, track.id, [{ duration: 4, notes }]);
  cleanups.push(() => project.dispose());
  return { project, track, instruments: { [track.id]: { sound, rootNote: 64 } } };
}

describe("Session MIDI ordering and restarts", () => {
  test("twelve abutting triplet notes of one pitch all sound in Session playback", async () => {
    const notes = Array.from({ length: 12 }, (_, i) => ({ pitch: 64, velocity: 1, start: i / 3, duration: 1 / 3 }));
    expect(notes.some((n, i) => i > 0 && notes[i - 1].start + notes[i - 1].duration !== n.start)).toBe(true);
    const { project, track, instruments } = oneTrack(notes, tone);
    const x = await render(project, 5, [{ at: 0, run: (w) => slot(w, track.id, 0).launch() }], { instruments });
    // The clip starts on the first bar boundary; find it from the first sound.
    let first = 0;
    while (Math.abs(x[first]) < 0.01) first++;
    const start = first / RATE;
    for (let i = 0; i < 12; i++) {
      const from = start + (i / 3) * 0.5;
      expect(rms(x, from + 0.03, from + 1 / 6 - 0.03), `window ${i}`).toBeGreaterThan(0.01);
    }
  }, 30_000);

  test("the first pass after stop and relaunch plays notes edited while stopped", async () => {
    const { project, track, instruments } = oneTrack([{ pitch: 64, velocity: 1, start: 0, duration: 0.25 }]);
    const clip = sessionFor(project).clipAt({ trackId: track.id, sceneId: sessionFor(project).scenes[0].id }) as MidiClip;
    const x = await render(
      project,
      12,
      [
        { at: 0.1, run: (w) => slot(w, track.id, 0).launch() },
        { at: 3, run: (w) => w.session.value.stopAll() },
        {
          at: 3.5,
          run: () =>
            clip.midi.edit((notes) => {
              notes[0].start = 1;
            }),
        },
        { at: 4.1, run: (w) => slot(w, track.id, 0).launch() },
      ],
      { instruments },
    );
    const clicks = onsets(x, 0.2);
    // old notes: a click at each bar from 2 s; after the relaunch at the 6 s bar the new notes play one beat later each pass (7 s, 9 s)
    expect(clicks.filter((t) => t > 5).map((t) => Math.round(t))).toEqual([7, 9, 11]);
  }, 30_000);

  test("a linked clip's cross-track follower stops listening when the Workspace is disposed", async () => {
    const project = new Project({ bpm: 120 });
    const a = project.addTrack("A", "midi");
    const b = project.addTrack("B", "midi");
    const grid = sessionFor(project);
    fillSession(project, a.id, [{ duration: 4, notes: [{ pitch: 64, velocity: 1, start: 0, duration: 0.25 }] }]);
    const source = grid.clipAt({ trackId: a.id, sceneId: grid.scenes[0].id }) as MidiClip;
    grid.copyToSlot(source.id, { trackId: b.id, sceneId: grid.scenes[0].id }, { linked: true });
    cleanups.push(() => project.dispose());
    const context = new OfflineAudioContext(2, RATE, RATE);
    const setNotes = vi.spyOn(MidiNotes.prototype, "setNotes");
    cleanups.push(() => setNotes.mockRestore());
    const workspace = await Workspace.create(context as unknown as AudioContext, project, {
      destination: context.destination,
      workletUrl: worklet,
      instruments: { [a.id]: { sound: click }, [b.id]: { sound: click } },
    });
    slot(workspace, a.id, 0).launch();
    await workspace.play();
    source.midi.edit((notes) => {
      notes[0].start = 1;
    });
    expect(setNotes).toHaveBeenCalled();
    workspace.dispose();
    setNotes.mockClear();
    source.midi.edit((notes) => {
      notes[0].start = 2;
    });
    expect(setNotes).not.toHaveBeenCalled();
  }, 30_000);
});
