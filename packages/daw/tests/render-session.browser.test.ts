import { ManualTickSource } from "@audiorective/clock";
import type { SoundFactory } from "@audiorective/core";
import { afterEach, describe, expect, test } from "vitest";
import { Project, Workspace, renderSession, sessionFor } from "../src";
import { fillSession } from "./session-slots";

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
      if (i - last > RATE * 0.05) found.push(Math.round((i / RATE) * 1000) / 1000);
      last = i;
    }
  return found;
};

/** 120 BPM, 2 s bars. Scene A: one bar, hit on beat 1. B: one bar, hit on beat 2. C: two bars, hits on beats 1 and 5. The Arrangement holds a hit at 0 that must never be heard. */
async function setup(extra = false) {
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
  fillSession(project, drums.id, clips);
  project.addMidiClip(drums.id, clips[0]!, 0);
  const [a, b, c] = sessionFor(project).scenes.map((scene) => scene.id) as [string, string, string];
  const instruments: Record<string, { sound: SoundFactory }> = { [drums.id]: { sound: click } };
  if (extra) {
    // Hats: a one-bar clip with a hit on beat 3, in scene C only, so it must repeat to fill C's two bars.
    const hats = project.addTrack("Hats", "midi");
    fillSession(project, hats.id, [null, null, { duration: 4, notes: [{ pitch: 60, velocity: 1, start: 2, duration: 0.25 }] }]);
    instruments[hats.id] = { sound: click };
  }
  const context = new AudioContext({ sampleRate: RATE });
  const workspace = await Workspace.create(context, project, { workletUrl: worklet, instruments });
  cleanups.push(async () => {
    workspace.dispose();
    project.dispose();
    await context.close();
  });
  expect(workspace.warnings).toEqual([]);
  return { project, workspace, drums, a, b, c };
}

/** What the live chain plays: an offline Workspace with the Arrangement off and `playChain` from the start. */
async function liveChain(project: Project, instruments: Record<string, { sound: SoundFactory }>, chain: number[], seconds: number) {
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
  workspace.session.value.playChain(chain);
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

describe("renderSession", () => {
  test("[B,B,B,B] renders the scene four times on bar lines", async () => {
    const { workspace, b } = await setup();
    const result = await renderSession(workspace, { scenes: [b, b, b, b] });
    if (result.status !== "rendered") throw new Error(result.status);
    expect(result.starts).toEqual([0, 2, 4, 6]);
    expect(result.starts.map((s) => Math.round(s * RATE) % (2 * RATE))).toEqual([0, 0, 0, 0]);
    expect(result.durationSeconds).toBeCloseTo(8 + 2, 6);
    expect(result.audio.channels[0]!.length).toBe(Math.round(result.durationSeconds * RATE));
    // Hits on beat 2 of each bar; the Arrangement's hit at 0 is not heard.
    expect(onsets(result.audio.channels[0]!)).toEqual([0.5, 2.5, 4.5, 6.5]);
    expect(result.peakDbFS).toBeGreaterThan(-12);
  }, 60_000);

  test("[A,A,B,C] gives each scene its own length: C lasts two bars", async () => {
    const { workspace, a, b, c } = await setup();
    const result = await renderSession(workspace, { scenes: [a, a, b, c], tailSeconds: 1 });
    if (result.status !== "rendered") throw new Error(result.status);
    expect(result.starts).toEqual([0, 2, 4, 6]);
    expect(result.durationSeconds).toBeCloseTo(10 + 1, 6);
    expect(onsets(result.audio.channels[0]!)).toEqual([0, 2, 4.5, 6, 8]);
  }, 60_000);

  test("a shorter clip repeats to fill its scene, and empty slots are silent", async () => {
    const { workspace, a, c } = await setup(true);
    const inC = await renderSession(workspace, { scenes: [c], tailSeconds: 0 });
    if (inC.status !== "rendered") throw new Error(inC.status);
    // Drums hit at 0 and 2; the one-bar Hats clip hits on beat 3 of each of C's two bars (1 and 3 s).
    expect(onsets(inC.audio.channels[0]!)).toEqual([0, 1, 2, 3]);
    expect(inC.durationSeconds).toBe(4);
    const inA = await renderSession(workspace, { scenes: [a], tailSeconds: 0 });
    if (inA.status !== "rendered") throw new Error(inA.status);
    expect(onsets(inA.audio.channels[0]!)).toEqual([0]);
    expect(inA.durationSeconds).toBe(2);
  }, 60_000);

  test("audio slot clips: a scene lasts as long as its longest clip, a shorter one repeats", async () => {
    const project = new Project({ bpm: 120 });
    const track = project.addTrack("Tone", "audio");
    const other = project.addTrack("Other", "audio");
    const sine = (seconds: number) => ({
      sampleRate: RATE,
      channels: [Float32Array.from({ length: Math.round(RATE * seconds) }, (_, i) => 0.5 * Math.sin((2 * Math.PI * 220 * i) / RATE))],
    });
    fillSession(project, track.id, [sine(1), sine(3)]);
    fillSession(project, other.id, [null, sine(1)]);
    const [short, long] = sessionFor(project).scenes.map((scene) => scene.id) as [string, string];
    const context = new AudioContext({ sampleRate: RATE });
    const workspace = await Workspace.create(context, project, {});
    cleanups.push(async () => {
      workspace.dispose();
      project.dispose();
      await context.close();
    });
    const result = await renderSession(workspace, { scenes: [short, long], tailSeconds: 0 });
    if (result.status !== "rendered") throw new Error(result.status);
    // Scene one is its 1 s clip (2 beats); scene two is the 3 s clip, and the 1 s clip on the other track repeats three times inside it.
    expect(result.starts).toEqual([0, 1]);
    expect(result.durationSeconds).toBe(4);
    const x = result.audio.channels[0]!;
    const energy = (from: number, to: number) => {
      let sum = 0;
      for (let i = Math.round(from * RATE); i < Math.round(to * RATE); i++) sum += x[i]! * x[i]!;
      return Math.sqrt(sum / ((to - from) * RATE));
    };
    expect(energy(0.1, 0.9)).toBeGreaterThan(0.2);
    expect(energy(1.1, 3.9)).toBeGreaterThan(0.3);
  }, 60_000);

  test("a scene that is not whole bars lasts exactly as long as under the live chain", async () => {
    const project = new Project({ bpm: 120 });
    const drums = project.addTrack("Drums", "midi");
    // Six beats (1.5 bars): a hit on beat 1 and on beat 5. Scene two: four beats with a hit on beat 2.
    const odd = {
      duration: 6,
      notes: [
        { pitch: 60, velocity: 1, start: 0, duration: 0.25 },
        { pitch: 60, velocity: 1, start: 4, duration: 0.25 },
      ],
    };
    fillSession(project, drums.id, [odd, { duration: 4, notes: [{ pitch: 60, velocity: 1, start: 1, duration: 0.25 }] }]);
    const [odd0, bar1] = sessionFor(project).scenes.map((scene) => scene.id) as [string, string];
    const instruments = { [drums.id]: { sound: click } };
    const context = new AudioContext({ sampleRate: RATE });
    const workspace = await Workspace.create(context, project, { workletUrl: worklet, instruments });
    cleanups.push(async () => {
      workspace.dispose();
      project.dispose();
      await context.close();
    });
    const rendered = await renderSession(workspace, { scenes: [odd0, odd0, bar1], tailSeconds: 0 });
    if (rendered.status !== "rendered") throw new Error(rendered.status);
    const live = await liveChain(project, instruments, [0, 0, 1], 10);
    // Scenes start at 0, 3 and 6 s: the second scene starts where 6 beats end, not on a bar line.
    expect(rendered.starts).toEqual([0, 3, 6]);
    expect(rendered.durationSeconds).toBe(8);
    expect(onsets(rendered.audio.channels[0]!)).toEqual([0, 2, 3, 5, 6.5]);
    expect(onsets(live).filter((t) => t < 8)).toEqual(onsets(rendered.audio.channels[0]!));
  }, 60_000);

  test("a slot MIDI clip looped from beat 2 to 4 renders as the live chain plays it", async () => {
    const project = new Project({ bpm: 120 });
    const drums = project.addTrack("Drums", "midi");
    // Eight beats with hits on beats 1, 3 (inside the loop) and 6 (after it, never heard). The loop is [2, 4).
    fillSession(project, drums.id, [
      {
        duration: 8,
        notes: [
          { pitch: 60, velocity: 1, start: 0, duration: 0.25 },
          { pitch: 60, velocity: 1, start: 2.5, duration: 0.25 },
          { pitch: 60, velocity: 1, start: 6, duration: 0.25 },
        ],
      },
    ]);
    const slotClip = sessionFor(project).clipAt({ trackId: drums.id, sceneId: sessionFor(project).scenes[0]!.id })!;
    project.setClipLoop(slotClip.id, { startBeat: 2, endBeat: 4 });
    const [scene] = sessionFor(project).scenes.map((s) => s.id) as [string];
    const instruments = { [drums.id]: { sound: click } };
    const context = new AudioContext({ sampleRate: RATE });
    const workspace = await Workspace.create(context, project, { workletUrl: worklet, instruments });
    cleanups.push(async () => {
      workspace.dispose();
      project.dispose();
      await context.close();
    });
    const rendered = await renderSession(workspace, { scenes: [scene, scene], tailSeconds: 0 });
    if (rendered.status !== "rendered") throw new Error(rendered.status);
    const live = await liveChain(project, instruments, [0, 0], 6);
    const seconds = rendered.durationSeconds;
    expect(onsets(rendered.audio.channels[0]!)).toEqual(onsets(live).filter((t) => t < seconds));
  }, 60_000);

  test("track volume automation applies as under the live chain, and the Arrangement's own is not needed", async () => {
    const { project, workspace, drums, b } = await setup();
    // Full volume for the first bar, silent from 2 s on.
    project.setVolumeAutomation(drums.id, [
      { time: 0, value: 1, shape: "hold" },
      { time: 2, value: 0, shape: "hold" },
    ]);
    const rendered = await renderSession(workspace, { scenes: [b, b, b], tailSeconds: 0 });
    if (rendered.status !== "rendered") throw new Error(rendered.status);
    const live = await liveChain(project, { [drums.id]: { sound: click } }, [1, 1, 1], 8);
    expect(onsets(rendered.audio.channels[0]!)).toEqual([0.5]);
    expect(onsets(live).filter((t) => t < 6)).toEqual([0.5]);
  }, 60_000);

  test("muting a track removes it from the render, and the live song is untouched", async () => {
    const { project, workspace, drums, b } = await setup();
    const version = project.cells.version.value;
    const clipsBefore = project.tracks[0]!.clips.map((clip) => clip.id);
    const playing = workspace.transport.state.value;
    const loud = await renderSession(workspace, { scenes: [b, b], expectedVersion: version });
    if (loud.status !== "rendered") throw new Error(loud.status);
    expect(loud.version).toBe(version);
    expect(project.cells.version.value).toBe(version);
    expect(project.tracks[0]!.clips.map((clip) => clip.id)).toEqual(clipsBefore);
    expect(workspace.transport.state.value).toBe(playing);

    project.setTrackMuted(drums.id, true);
    const quiet = await renderSession(workspace, { scenes: [b, b] });
    if (quiet.status !== "rendered") throw new Error(quiet.status);
    expect(quiet.peakDbFS).toBeNull();
    expect(onsets(quiet.audio.channels[0]!)).toEqual([]);
  }, 60_000);

  test("a moved version returns conflict without rendering", async () => {
    const { project, workspace, drums, b } = await setup();
    const stale = project.cells.version.value;
    project.setTrackMuted(drums.id, true);
    const result = await renderSession(workspace, { scenes: [b], expectedVersion: stale });
    expect(result.status).toBe("conflict");
  }, 60_000);

  test("validates scenes and tailSeconds", async () => {
    const { workspace, b } = await setup();
    await expect(renderSession(workspace, { scenes: [] })).rejects.toThrow("renderSession needs scenes: a non-empty list of scene IDs.");
    await expect(renderSession(workspace, { scenes: ["nope"] })).rejects.toThrow('renderSession has no scene with id "nope".');
    await expect(renderSession(workspace, { scenes: [b], tailSeconds: -1 })).rejects.toThrow(
      "renderSession tailSeconds must be finite and non-negative.",
    );
  }, 60_000);

  test("abort rejects with AbortError", async () => {
    const { workspace, b } = await setup();
    const before = new AbortController();
    before.abort();
    await expect(renderSession(workspace, { scenes: [b], signal: before.signal })).rejects.toMatchObject({
      name: "AbortError",
      message: "renderSession was cancelled.",
    });
    const during = new AbortController();
    const pending = renderSession(workspace, { scenes: [b, b, b, b], signal: during.signal });
    setTimeout(() => during.abort(), 20);
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  }, 60_000);
});
