import { ManualTickSource } from "@audiorective/clock";
import type { SoundFactory } from "@audiorective/core";
import { afterEach, describe, expect, test } from "vitest";
import { Project, Workspace, type WorkspaceOptions } from "../src";
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

/**
 * 120 BPM. Scene 0: a one-bar clip with a hit on beat 1; scene 1: a one-bar clip with a hit on beat 2; scene 2: a two-bar clip with hits on beats 1 and 5.
 * The Arrangement plays the same three clips at beats 0, 4 and 8. The "Pad" track holds one long note from beat 0 in the Arrangement and nothing in the Session.
 */
function scenes() {
  const project = new Project({ bpm: 120 });
  const drums = project.addTrack("Drums", "midi");
  const clips = [
    { duration: 4, notes: [{ pitch: 60, velocity: 1, start: 0, duration: 0.25 }] },
    { duration: 4, notes: [{ pitch: 60, velocity: 1, start: 1, duration: 0.25 }] },
    {
      duration: 8,
      notes: [
        { pitch: 60, velocity: 1, start: 0, duration: 0.25 },
        { pitch: 60, velocity: 1, start: 4, duration: 0.25 },
      ],
    },
  ];
  clips.forEach((data, index) => project.addMidiClip(drums.id, data, index * 4));
  fillSession(project, drums.id, clips);
  const pad = project.addTrack("Pad", "midi");
  project.addMidiClip(pad.id, { duration: 24, notes: [{ pitch: 64, velocity: 1, start: 0, duration: 24 }] }, 0);
  cleanups.push(() => project.dispose());
  return { project, drums, pad, instruments: { [drums.id]: { sound: click }, [pad.id]: { sound: tone, rootNote: 64 } } };
}

describe("arrangement off: a Session-only Workspace", () => {
  test("only launched clips sound; tracks with nothing launched stay silent", async () => {
    const { project, drums, instruments } = scenes();
    const x = await render(project, 6, [{ at: 0.2, run: (w) => w.session.value.tracks[drums.id]!.clips[1]!.launch() }], {
      instruments,
      arrangement: false,
    });
    // The launched clip (hit on its beat 2) starts at bar 1: hits at 2.5 and 4.5 s. Nothing at 0 s (Arrangement hit), and the Pad never sounds.
    expect(onsets(x).map((t) => Math.round(t * 1000) / 1000)).toEqual([2.5, 4.5]);
    expect(rms(x, 0, 2.4)).toBe(0);
  }, 30_000);

  test("switching it off while playing releases Arrangement sound at once; on brings it back", async () => {
    const { project, instruments } = scenes();
    const x = await render(
      project,
      6,
      [
        { at: 1, run: (w) => (w.arrangement.value = false) },
        { at: 3, run: (w) => (w.arrangement.value = true) },
      ],
      { instruments },
    );
    expect(rms(x, 0.5, 0.95)).toBeGreaterThan(0.05);
    expect(rms(x, 1.1, 2.9)).toBe(0);
    // The Pad note started at beat 0 does not restart; the next Arrangement hit (slot 1 at beat 4, its beat 2: 2.5 s) was skipped, slot 2's hit at beat 8 (4 s) plays.
    expect(
      onsets(x, 0.2)
        .filter((t) => t > 3)
        .map((t) => Math.round(t * 1000) / 1000),
    ).toEqual([4]);
  }, 30_000);

  test("session.playChain plays Project clips for their lengths, back to back, then stops", async () => {
    const { project, drums } = scenes();
    // Only the drums have a sound, and the Pad track has no Session clips, so its long Arrangement clip does not set a scene's length.
    const x = await render(project, 13, [{ at: 0.2, run: (w) => w.session.value.playChain([0, 0, 1, 2]) }], {
      instruments: { [drums.id]: { sound: click } },
      arrangement: false,
    });
    // Bars from 2 s: scene 0 (hit at 2.0), scene 0 (4.0), scene 1 (hit on beat 2: 6.5), scene 2 for two bars (8.0 and 10.0); nothing after 12 s.
    expect(onsets(x).map((t) => Math.round(t * 1000) / 1000)).toEqual([2, 4, 6.5, 8, 10]);
  }, 30_000);
});
