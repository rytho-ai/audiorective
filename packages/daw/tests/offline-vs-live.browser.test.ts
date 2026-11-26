/**
 * Gate G1.1: the offline render and the realtime output of the same project are the same audio.
 *
 * Each case plays the Workspace live on a 48 kHz AudioContext, captures its output sample-accurately (`helpers/live-capture.ts`), and renders the same range
 * with `renderMixRange` (or `renderSession` for scenes). The live stream is aligned by the context frame of beat 0 (`timeline.beatToTime(0)`), then the
 * largest absolute sample difference is measured.
 */
import type { SoundFactory } from "@audiorective/core";
import { afterEach, describe, expect, test } from "vitest";
import { Project, Workspace, renderMixRange, renderSession, sessionFor, type WorkspaceOptions } from "../src";
import { LiveCapture, sleep } from "./helpers/live-capture";
import { fillSession } from "./session-slots";

const RATE = 48_000;
const TARGET = 1e-6;
const worklet = "/@fs" + new URL("../../host/dist/webclap-worklet.js", import.meta.url).pathname.replace(/^\/@fs/, "");
const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A sine with a 5 ms attack and an exponential decay, at a pitch-dependent frequency. */
const tone: SoundFactory = (context, hit) => {
  const osc = new OscillatorNode(context, { frequency: 220 * 2 ** ((hit.pitch - 57) / 12) });
  const env = new GainNode(context, { gain: 0 });
  env.gain.setValueAtTime(0, hit.when);
  env.gain.linearRampToValueAtTime(0.3 * hit.velocity, hit.when + 0.005);
  env.gain.exponentialRampToValueAtTime(0.001, hit.when + 0.4);
  osc.connect(env);
  return { output: env, sources: [osc], duration: 0.4 };
};

const noise = (seconds: number, seed = 7) => {
  let state = seed;
  return Float32Array.from({ length: Math.round(seconds * RATE) }, () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return (state / 2 ** 32 - 0.5) * 0.5;
  });
};

type Result = { diff: number; peak: number; alignment: number; dropouts: number };

/** Play `project` live for `seconds`, capture the master, and return it from the frame of beat 0. */
async function live(project: Project, options: WorkspaceOptions, seconds: number, prepare?: (workspace: Workspace) => void) {
  const context = new AudioContext({ sampleRate: RATE, latencyHint: "interactive" });
  const workspace = await Workspace.create(context, project, { workletUrl: worklet, ...options });
  cleanups.push(async () => {
    workspace.dispose();
    await context.close();
  });
  expect(workspace.warnings).toEqual([]);
  await context.resume();
  const capture = await LiveCapture.on(context, workspace.output);
  prepare?.(workspace);
  await workspace.play();
  const startTime = workspace.timeline.beatToTime(0);
  await sleep((startTime - context.currentTime + seconds + 0.2) * 1000);
  workspace.stop();
  const { first, data, dropouts } = await capture.stop();
  const start = Math.round(startTime * RATE);
  // The warm-up before beat 0 can drop a quantum or two (the context starts while the graph is built); only a gap inside the compared range counts.
  const inRange = dropouts.filter((gap) => gap.endFrame > start);
  const offset = start - first;
  expect(offset).toBeGreaterThanOrEqual(0);
  const frames = Math.round(seconds * RATE);
  expect(data[0]!.length).toBeGreaterThanOrEqual(offset + frames);
  return {
    workspace,
    data: data.map((x) => x.subarray(offset, offset + frames)),
    alignment: startTime * RATE - start,
    dropouts: inRange.length,
    gaps: inRange.map((g) => `${g.startFrame - start}..${g.endFrame - start}`),
  };
}

const compare = (
  a: readonly ArrayLike<number>[],
  b: readonly ArrayLike<number>[],
  skip = 0,
): { diff: number; peak: number; at: number; over: number; first: number; last: number } => {
  let over = 0;
  let first = -1;
  let last = -1;
  let diff = 0;
  let peak = 0;
  let at = 0;
  for (let c = 0; c < a.length; c++)
    for (let i = skip; i < Math.min(a[c]!.length, b[c]!.length); i++) {
      peak = Math.max(peak, Math.abs(b[c]![i]!));
      const d = Math.abs(a[c]![i]! - b[c]![i]!);
      if (d > TARGET) {
        over++;
        if (first < 0) first = i;
        last = i;
      }
      if (d > diff) {
        diff = d;
        at = i;
      }
    }
  return { diff, peak, at, over, first, last };
};

const report = (name: string, result: Result & { at: number; over: number; first: number; last: number }) =>
  console.info(
    `[offline-vs-live ${name}] max |diff| = ${result.diff.toExponential(3)} at frame ${result.at}, peak ${result.peak.toFixed(4)}, ` +
      `start alignment ${result.alignment.toFixed(4)} frame, samples over ${TARGET}: ${result.over} (frames ${result.first}..${result.last}), dropouts ${result.dropouts} ${JSON.stringify((result as { gaps?: string[] }).gaps ?? [])}`,
  );

const midiTrackOptions = (project: Project): WorkspaceOptions => ({
  instruments: Object.fromEntries(project.tracks.filter((t) => t.kind === "midi").map((t) => [t.id, { sound: tone }])),
});

async function offline(workspace: Workspace, seconds: number) {
  const result = await renderMixRange(workspace, {
    expectedVersion: workspace.project.cells.version.value,
    range: { startSeconds: 0, endSeconds: seconds },
    prerollSeconds: 0,
  });
  if (result.status !== "rendered") throw new Error(result.status);
  return result.audio.channels;
}

describe("offline render equals the realtime output", () => {
  test("audio clips only", async () => {
    const project = new Project({ bpm: 120 });
    const a = project.addTrack("A", "audio", { volume: 0.8, pan: -0.4 });
    const b = project.addTrack("B", "audio", { volume: 0.6, pan: 0.5 });
    project.addAudioClip(a.id, { sampleRate: RATE, channels: [noise(1.2, 1), noise(1.2, 2)] }, 0);
    project.addAudioClip(b.id, { sampleRate: RATE, channels: [noise(1.5, 3)] }, 0.7);
    project.addAudioClip(a.id, { sampleRate: RATE, channels: [noise(0.6, 4)] }, 2.0);
    cleanups.push(() => project.dispose());
    const seconds = 3;
    const run = await live(project, {}, seconds);
    const rendered = await offline(run.workspace, seconds);
    const result = { ...compare(run.data, rendered), alignment: run.alignment, dropouts: run.dropouts, gaps: run.gaps };
    report("audio clips", result);
    expect(result.peak).toBeGreaterThan(0.1);
    expect(result.dropouts).toBe(0);
    expect(result.diff).toBeLessThanOrEqual(TARGET);
  }, 60_000);

  test("MIDI through an instrument", async () => {
    const project = new Project({ bpm: 120 });
    const track = project.addTrack("Keys", "midi", { volume: 0.9, pan: 0.2 });
    project.addMidiClip(
      track.id,
      { duration: 8, notes: [0, 1, 2.5, 3, 4, 6].map((start, i) => ({ pitch: 57 + i * 2, velocity: 0.7 + i * 0.05, start, duration: 0.5 })) },
      0,
    );
    cleanups.push(() => project.dispose());
    const seconds = 4;
    const run = await live(project, midiTrackOptions(project), seconds);
    const rendered = await offline(run.workspace, seconds);
    const result = { ...compare(run.data, rendered), alignment: run.alignment, dropouts: run.dropouts, gaps: run.gaps };
    report("MIDI instrument", result);
    expect(result.peak).toBeGreaterThan(0.05);
    expect(result.dropouts).toBe(0);
    expect(result.diff).toBeLessThanOrEqual(TARGET);
  }, 60_000);

  test("filter and delay on a track with a send to an effect bus", async () => {
    const project = new Project({ bpm: 120 });
    const track = project.addTrack("FX", "audio", { volume: 0.7 });
    const bus = project.addTrack("Echo", "bus", { busRole: "effect", volume: 0.9 });
    project.addAudioClip(track.id, { sampleRate: RATE, channels: [noise(0.5, 9), noise(0.5, 10)] }, 0.2);
    project.setTrackEffects(track.id, [
      { id: "f", type: "filter", enabled: true, wet: 1, mode: "lowpass", frequency: 1800, q: 2 },
      { id: "d", type: "delay", enabled: true, wet: 0.4, delayTime: 0.21, feedback: 0.35 },
    ]);
    project.setTrackEffects(bus.id, [{ id: "d2", type: "delay", enabled: true, wet: 1, delayTime: 0.33, feedback: 0.3 }]);
    project.setTrackRouting(track.id, { outputBusId: null, sends: [{ busId: bus.id, gain: 0.5 }] });
    cleanups.push(() => project.dispose());
    const seconds = 3;
    const run = await live(project, {}, seconds);
    const rendered = await offline(run.workspace, seconds);
    const result = { ...compare(run.data, rendered), alignment: run.alignment, dropouts: run.dropouts, gaps: run.gaps };
    report("effects and send", result);
    expect(result.peak).toBeGreaterThan(0.05);
    expect(result.dropouts).toBe(0);
    expect(result.diff).toBeLessThanOrEqual(TARGET);
  }, 60_000);

  test.each([
    ["MIDI clips", true, false],
    ["an audio clip", false, true],
    ["MIDI and audio clips", true, true],
  ])(
    "Session scenes with %s: live playChain equals renderSession",
    async (name, withMidi, withAudio) => {
      const project = new Project({ bpm: 120 });
      const keys = project.addTrack("Keys", "midi");
      const loop = project.addTrack("Loop", "audio", { volume: 0.5 });
      if (withMidi)
        fillSession(project, keys.id, [
          { duration: 4, notes: [0, 1, 2, 3].map((start, i) => ({ pitch: 57 + i, velocity: 0.8, start, duration: 0.4 })) },
          { duration: 4, notes: [0, 2].map((start, i) => ({ pitch: 64 + i, velocity: 0.9, start, duration: 1 })) },
        ]);
      if (withAudio) fillSession(project, loop.id, [{ sampleRate: RATE, channels: [noise(2, 5)] }, null]);
      if (!withMidi) sessionFor(project).addScene();
      const [a, b] = sessionFor(project).scenes.map((scene) => scene.id) as [string, string];
      cleanups.push(() => project.dispose());
      const seconds = 4;
      const run = await live(project, { ...midiTrackOptions(project), arrangement: false }, seconds, (workspace) =>
        workspace.session.value.playChain([0, 1]),
      );
      const rendered = await renderSession(run.workspace, { scenes: [a, b], tailSeconds: 0 });
      if (rendered.status !== "rendered") throw new Error(rendered.status);
      const result = { ...compare(run.data, rendered.audio.channels), alignment: run.alignment, dropouts: run.dropouts, gaps: run.gaps };
      report(`session scenes, ${name}`, result);
      expect(result.peak).toBeGreaterThan(0.05);
      expect(result.dropouts).toBe(0);
      // Session MIDI notes reach the instrument through the same MIDI bytes as the Arrangement, so live and rendered levels agree. Before, live Session passed the raw
      // velocity (0.8) where the render used its MIDI byte (round(0.8 * 127) / 127 = 0.8031): a 0.4% level difference, 7.6e-4 on a 0.19 peak, not a timing offset.
      expect(result.diff).toBeLessThanOrEqual(TARGET);
    },
    60_000,
  );
});
