import { ManualTickSource } from "@audiorective/clock";
import type { SoundFactory } from "@audiorective/core";
import { afterEach, describe, expect, test } from "vitest";
import { AudioMedia, Project, Workspace, renderMixRange, sessionFor, type MidiClip, type WorkspaceOptions } from "../src";

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
const rounded = (times: number[]) => times.map((t) => Math.round(t * 100) / 100);
const rms = (x: Float32Array, from: number, to: number) => {
  let energy = 0;
  for (let i = Math.round(from * RATE); i < Math.round(to * RATE); i++) energy += x[i] * x[i];
  return Math.sqrt(energy / Math.max(1, Math.round((to - from) * RATE)));
};

/** Deterministic PCM whose every frame differs from its neighbours. */
const pattern = (frames: number) => Float32Array.from({ length: frames }, (_, i) => (((i * 7919 + 104729) % 2003) / 2003 - 0.5) * 0.9);

/** 120 BPM; one bar is 2 s. */
function audioLoop() {
  const project = new Project({ bpm: 120 });
  const track = project.addTrack("Take", "audio");
  const clip = project.addAudioClip(track.id, { sampleRate: RATE, channels: [pattern(4 * RATE)] }, 0);
  cleanups.push(() => project.dispose());
  return { project, track, clip };
}

function midiLoop(notes: Array<{ start: number }>, duration = 4) {
  const project = new Project({ bpm: 120 });
  const track = project.addTrack("Drums", "midi");
  const clip = project.addMidiClip(track.id, { duration, notes: notes.map(({ start }) => ({ pitch: 60, velocity: 1, start, duration: 0.25 })) }, 0);
  cleanups.push(() => project.dispose());
  return { project, track, clip, instruments: { [track.id]: { sound: click } } };
}

/** Like `midiLoop`, with the clip in scene 0 of the Session instead of on the timeline. */
function sessionMidiLoop(notes: Array<{ start: number }>, duration = 4) {
  const project = new Project({ bpm: 120 });
  const track = project.addTrack("Drums", "midi");
  const session = sessionFor(project);
  const scene = session.addScene();
  session.setMidiClip(
    { trackId: track.id, sceneId: scene.id },
    { duration, notes: notes.map(({ start }) => ({ pitch: 60, velocity: 1, start, duration: 0.25 })) },
  );
  cleanups.push(() => project.dispose());
  return { project, track, instruments: { [track.id]: { sound: click } } };
}

describe("looping audio clips", () => {
  test("a 4 s loop extended to 12 s repeats its samples with no seam", async () => {
    const { project, clip } = audioLoop();
    project.setClipLoop(clip.id, { startSeconds: 0, endSeconds: 4 });
    project.resizeClip(clip.id, { end: 12 });
    const x = await render(project, 13, []);
    let worst = 0;
    // The first and last samples of every pass are compared, so a gap or a doubled sample at a seam shows.
    for (const pass of [1, 2])
      for (let k = -64; k < 4096; k++) worst = Math.max(worst, Math.abs(x[pass * 4 * RATE + k] - x[k < 0 ? 4 * RATE + k : k]));
    expect(rms(x, 0, 1)).toBeGreaterThan(0.05);
    expect(worst).toBeLessThan(1e-6);
    // The clip ends at 12 s.
    expect(rms(x, 12.1, 13)).toBe(0);
  }, 60_000);

  test("a loop inside the recording plays the lead-in once, then repeats the loop region", async () => {
    const { project, clip } = audioLoop();
    project.setClipLoop(clip.id, { startSeconds: 1, endSeconds: 2 });
    project.resizeClip(clip.id, { end: 6 });
    const x = await render(project, 7, []);
    let worst = 0;
    // 0-2 s is the recording; then 2-3, 3-4, 4-5 and 5-6 s play 1-2 s again.
    for (const pass of [2, 3, 4, 5]) for (let k = 0; k < 4096; k++) worst = Math.max(worst, Math.abs(x[pass * RATE + k] - x[RATE + k]));
    expect(worst).toBeLessThan(1e-6);
    expect(rms(x, 6.1, 7)).toBe(0);
  }, 60_000);
});

/** The mix of seconds `[0, seconds)` through `renderMixRange`, left channel. */
async function mixOf(project: Project, seconds: number): Promise<Float32Array> {
  const context = new AudioContext({ sampleRate: RATE });
  const workspace = await Workspace.create(context, project, { workletUrl: worklet });
  cleanups.push(async () => {
    workspace.dispose();
    await context.close();
  });
  const result = await renderMixRange(workspace, {
    expectedVersion: project.cells.version.value,
    range: { startSeconds: 0, endSeconds: seconds },
  });
  if (result.status !== "rendered") throw new Error(result.status);
  return Float32Array.from(result.audio.channels[0]);
}

describe("gain automation on looped audio clips", () => {
  test("edge fades at the recording's ends repeat on every pass", async () => {
    const { project, clip } = audioLoop();
    project.setClipLoop(clip.id, { startSeconds: 0, endSeconds: 4 });
    project.resizeClip(clip.id, { end: 12 });
    project.setAudioClipGainAutomation(clip.id, [
      { time: 0, value: 0, shape: "linear" },
      { time: 0.005, value: 1, shape: "linear" },
      { time: 3.995, value: 1, shape: "linear" },
      { time: 4, value: 0, shape: "linear" },
    ]);
    const x = await mixOf(project, 12);
    expect(rms(x, 1, 3)).toBeGreaterThan(0.05);
    // The fade at 0 is audible: the first frames are quiet.
    expect(Math.abs(x[10])).toBeLessThan(0.01);
    let worst = 0;
    for (let i = 0; i < 4 * RATE; i++) worst = Math.max(worst, Math.abs(x[i] - x[i + 4 * RATE]), Math.abs(x[i] - x[i + 8 * RATE]));
    expect(worst).toBeLessThan(1e-6);
  }, 60_000);

  test("a loop that starts after the entry reads the curve at the recording position on later passes", async () => {
    const project = new Project({ bpm: 120 });
    const track = project.addTrack("Take", "audio");
    cleanups.push(() => project.dispose());
    const clip = project.addAudioClip(track.id, { sampleRate: RATE, channels: [new Float32Array(4 * RATE).fill(0.5)] }, 0);
    project.setClipLoop(clip.id, { startSeconds: 1, endSeconds: 3 });
    project.resizeClip(clip.id, { end: 9 });
    const curve = (seconds: number) => 0.2 + (0.8 * seconds) / 4;
    project.setAudioClipGainAutomation(clip.id, [
      { time: 0, value: 0.2, shape: "linear" },
      { time: 4, value: 1, shape: "linear" },
    ]);
    const x = await mixOf(project, 9);
    const pan = x[Math.round(0.5 * RATE)] / (0.5 * curve(0.5));
    expect(pan).toBeGreaterThan(0.5);
    // The first pass plays 0-3 s of the recording; later passes (3-5, 5-7, 7-9 s) play 1-3 s again.
    for (const [local, source] of [
      [0.5, 0.5],
      [2.5, 2.5],
      [3.5, 1.5],
      [4.9, 2.9],
      [5.5, 1.5],
      [6.9, 2.9],
      [7.5, 1.5],
      [8.5, 2.5],
    ])
      expect(x[Math.round(local * RATE)]).toBeCloseTo(pan * 0.5 * curve(source), 3);
  }, 60_000);
});

describe("looping file-backed audio clips", () => {
  test("a file-backed clip with a loop renders the same samples as a PCM one", async () => {
    const source = pattern(4 * RATE);
    const loop = { startSeconds: 1, endSeconds: 2.5 };
    const render12 = async (media: boolean) => {
      const project = new Project({ bpm: 120 });
      const track = project.addTrack("Take", "audio");
      cleanups.push(() => project.dispose());
      const clip = media
        ? project.addAudioMediaClip(track.id, new AudioMedia(new Blob([source.slice().buffer]), RATE, 1, source.length), 0.5, {
            startFrame: RATE / 2,
            frameCount: 2 * RATE,
          })
        : project.addAudioClip(track.id, { sampleRate: RATE, channels: [source] }, 0);
      if (!media) project.resizeClip(clip.id, { start: 0.5, end: 2.5 });
      project.setClipLoop(clip.id, loop);
      project.resizeClip(clip.id, { end: 9 });
      return render(project, 10, []);
    };
    const [pcm, file] = [await render12(false), await render12(true)];
    expect(rms(pcm, 0, 1)).toBeGreaterThan(0.05);
    let worst = 0;
    for (let i = 0; i < 10 * RATE; i++) worst = Math.max(worst, Math.abs(pcm[i] - file[i]));
    expect(worst).toBeLessThan(1e-6);
    // The first pass reads 0.5 s to 2.5 s of the recording, then 1 s to 2.5 s repeats: the pass from 2 s equals the pass from 3.5 s.
    let seam = 0;
    for (let k = -32; k < 2048; k++) seam = Math.max(seam, Math.abs(file[2 * RATE + k + 32] - file[Math.round(3.5 * RATE) + k + 32]));
    expect(seam).toBeLessThan(1e-6);
  }, 60_000);
});

describe("looping MIDI clips", () => {
  test("a one-bar loop extended to four bars plays its hit on every bar", async () => {
    const { project, clip, instruments } = midiLoop([{ start: 0 }, { start: 3 }]);
    project.setClipLoop(clip.id, { startBeat: 0, endBeat: 4 });
    project.resizeClip(clip.id, { end: 16 });
    const x = await render(project, 9, [], { instruments });
    expect(rounded(onsets(x))).toEqual([0, 1.5, 2, 3.5, 4, 5.5, 6, 7.5]);
  }, 30_000);

  test("a note moved in the pattern moves in every repetition; notes after the loop end stay silent", async () => {
    const { project, clip, instruments } = midiLoop([{ start: 1 }, { start: 3 }], 8);
    project.setClipLoop(clip.id, { startBeat: 0, endBeat: 2 });
    const x = await render(project, 5, [], { instruments });
    // The loop is two beats (1 s): the note at beat 1 plays at 0.5 s of every pass of the 4 s clip.
    expect(rounded(onsets(x))).toEqual([0.5, 1.5, 2.5, 3.5]);
    const moved = midiLoop([{ start: 1 }, { start: 3 }], 8);
    moved.project.setClipLoop(moved.clip.id, { startBeat: 0, endBeat: 2 });
    const y = await render(
      moved.project,
      5,
      [
        {
          at: 0,
          run: () => {
            (moved.project.tracks[0].clips[0] as MidiClip).midi.edit((draft) => {
              draft[0].start = 1.5;
            });
          },
        },
      ],
      { instruments: moved.instruments },
    );
    expect(rounded(onsets(y))).toEqual([0.75, 1.75, 2.75, 3.75]);
  }, 60_000);
});

describe("looped clips in the Session", () => {
  test("a looped audio clip repeats its loop region from the launch", async () => {
    const project = new Project({ bpm: 120 });
    const track = project.addTrack("Take", "audio");
    cleanups.push(() => project.dispose());
    // 0-1 s: a steady 0.6; 1-2 s: a 220 Hz sine at 0.3; 2-4 s: silence the loop must never reach.
    const channel = new Float32Array(4 * RATE);
    for (let i = 0; i < RATE; i++) channel[i] = 0.6;
    for (let i = RATE; i < 2 * RATE; i++) channel[i] = 0.3 * Math.sin((2 * Math.PI * 220 * i) / RATE);
    const session = sessionFor(project);
    const scene = session.addScene();
    const clip = session.setAudioClip({ trackId: track.id, sceneId: scene.id }, { sampleRate: RATE, channels: [channel] });
    project.setClipLoop(clip.id, { startSeconds: 1, endSeconds: 2 });
    const x = await render(project, 9, [{ at: 0.2, run: (w) => w.session.value.tracks[track.id]!.clips[0]!.launch() }], { arrangement: false });
    // Launched on the bar at 2 s: the lead-in (0.6) plays once, then the sine repeats.
    expect(rms(x, 0, 1.9)).toBe(0);
    const lead = rms(x, 2.05, 2.95);
    const first = rms(x, 3.05, 3.95);
    expect(lead / first).toBeGreaterThan(2.6);
    expect(lead / first).toBeLessThan(3.1);
    for (const from of [4.05, 5.05, 6.05, 8.05]) expect(Math.abs(rms(x, from, from + 0.9) / first - 1)).toBeLessThan(0.03);
  }, 60_000);

  test("a MIDI loop that ends after the clip loops the clip's length, as the Arrangement plays it", async () => {
    const { project, track, instruments } = sessionMidiLoop([{ start: 0 }, { start: 3 }]);
    const clip = sessionFor(project).clipAt({ trackId: track.id, sceneId: sessionFor(project).scenes[0].id })!;
    project.setClipLoop(clip.id, { startBeat: 0, endBeat: 8 });
    const x = await render(project, 6, [{ at: 0.2, run: (w) => w.session.value.tracks[track.id]!.clips[0]!.launch() }], {
      instruments,
      arrangement: false,
    });
    // The clip is 4 beats (2 s) long: hits at beats 0 and 3 of every 2 s pass from the bar at 2 s.
    expect(rounded(onsets(x))).toEqual([2, 3.5, 4, 5.5]);
  }, 30_000);

  test("a looped MIDI clip loops the length of its loop", async () => {
    const { project, track, instruments } = sessionMidiLoop([{ start: 0 }, { start: 3 }]);
    const clip = sessionFor(project).clipAt({ trackId: track.id, sceneId: sessionFor(project).scenes[0].id })!;
    project.setClipLoop(clip.id, { startBeat: 0, endBeat: 2 });
    const x = await render(project, 6, [{ at: 0.2, run: (w) => w.session.value.tracks[track.id]!.clips[0]!.launch() }], {
      instruments,
      arrangement: false,
    });
    // The loop is one second long: a hit on each of its passes from the bar at 2 s, and none for the note after the loop end.
    expect(rounded(onsets(x))).toEqual([2, 3, 4, 5]);
  }, 30_000);
});
