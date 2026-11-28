/**
 * Rerun determinism (goal clause 1.4): the same project range renders to the same PCM every time, also after a save and reopen.
 * The mix has audio clips, MIDI clips, a tempo change, built-in effects and a send; one case adds a WebCLAP device.
 */
import type { SoundFactory } from "@audiorective/core";
import { afterEach, describe, expect, test } from "vitest";
import { Project, Workspace, openDawProject, renderMixRange, saveWorkspace, type WorkspaceOptions } from "../src";

const RATE = 48_000;
const worklet = "/@fs" + new URL("../../host/dist/webclap-worklet.js", import.meta.url).pathname.replace(/^\/@fs/, "");
const bundle = "/@fs" + new URL("../../../apps/daw-demo/public/plugin/oxo-synth2.wclap", import.meta.url).pathname.replace(/^\/@fs/, "");
const pluginId = "com.oxo.music.oxosynth2";

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A decaying 600 Hz tone, so a render has a tail the effects can ring on. */
const tone: SoundFactory = (context, hit) => {
  const osc = new OscillatorNode(context, { frequency: 220 * 2 ** ((hit.pitch - 57) / 12), type: "sawtooth" });
  const env = new GainNode(context, { gain: 0 });
  env.gain.setValueAtTime(0, hit.when);
  env.gain.linearRampToValueAtTime(0.3 * hit.velocity, hit.when + 0.005);
  env.gain.exponentialRampToValueAtTime(0.001, hit.when + 0.4);
  osc.connect(env);
  return { output: env, sources: [osc], duration: 0.4 };
};

const noise = (seconds: number) => {
  let seed = 12345;
  return Float32Array.from({ length: Math.round(seconds * RATE) }, () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return (seed / 2 ** 32 - 0.5) * 0.4;
  });
};

function build(withDevice: boolean) {
  const project = new Project({ bpm: 120 });
  project.setTempoChanges([{ beat: 8, bpm: 90 }]);
  const audio = project.addTrack("Audio", "audio");
  const midi = project.addTrack("Midi", "midi");
  const bus = project.addTrack("Echo bus", "bus", { busRole: "effect" });
  project.addAudioClip(audio.id, { sampleRate: RATE, channels: [noise(3), noise(3)] }, 0.5);
  project.addAudioClip(audio.id, { sampleRate: RATE, channels: [noise(1)] }, 4);
  project.addMidiClip(
    midi.id,
    { duration: 16, notes: [0, 1.5, 4, 8.25, 10, 12].map((start, index) => ({ pitch: 55 + index * 2, velocity: 0.8, start, duration: 0.75 })) },
    0,
  );
  project.setTrackEffects(audio.id, [
    { id: "f", type: "filter", enabled: true, wet: 1, mode: "lowpass", frequency: 1500, q: 2 },
    { id: "d", type: "delay", enabled: true, wet: 0.4, delayTime: 0.21, feedback: 0.4 },
  ]);
  project.setTrackEffects(bus.id, [{ id: "d2", type: "delay", enabled: true, wet: 1, delayTime: 0.33, feedback: 0.3 }]);
  project.setTrackRouting(audio.id, { outputBusId: null, sends: [{ busId: bus.id, gain: 0.5 }] });
  if (withDevice) project.addDevice(midi.id, { kind: "webclap", pluginId, name: "Synth", vendor: "", version: "", bundleUrl: bundle });
  cleanups.push(() => project.dispose());
  return project;
}

const instrumentsFor = (project: Project, withDevice: boolean): WorkspaceOptions =>
  withDevice
    ? { workletUrl: worklet, resolveBundle: () => bundle }
    : { workletUrl: worklet, instruments: Object.fromEntries(project.tracks.filter((t) => t.kind === "midi").map((t) => [t.id, { sound: tone }])) };

async function open(project: Project, withDevice: boolean) {
  const context = new AudioContext({ sampleRate: RATE });
  const workspace = await Workspace.create(context, project, instrumentsFor(project, withDevice));
  cleanups.push(async () => {
    workspace.dispose();
    await context.close();
  });
  expect(workspace.cells.warnings.value).toEqual([]);
  return workspace;
}

async function mix(workspace: Workspace, startSeconds: number, endSeconds: number) {
  const result = await renderMixRange(workspace, {
    expectedVersion: workspace.project.cells.version.value,
    range: { startSeconds, endSeconds },
    prerollSeconds: 1,
  });
  if (result.status !== "rendered") throw new Error(result.status);
  return result.audio.channels.map((channel) => Float32Array.from(channel));
}

const maxDifference = (a: Float32Array[], b: Float32Array[]) => {
  expect(b.length).toBe(a.length);
  let worst = 0;
  let peak = 0;
  for (let c = 0; c < a.length; c++) {
    expect(b[c]!.length).toBe(a[c]!.length);
    for (let i = 0; i < a[c]!.length; i++) {
      worst = Math.max(worst, Math.abs(a[c]![i]! - b[c]![i]!));
      peak = Math.max(peak, Math.abs(a[c]![i]!));
    }
  }
  return { worst, peak };
};

describe.each([
  ["sampler instrument, no plug-in", false],
  ["WebCLAP device on the MIDI track", true],
])("rerender determinism: %s", (_name, withDevice) => {
  test("two renders of the same range are identical, and so is a render after save and reopen", async () => {
    const project = build(withDevice);
    const workspace = await open(project, withDevice);
    // Range crosses the tempo change at beat 8 (4 s) and holds the effects' tails.
    const first = await mix(workspace, 2, 9);
    const second = await mix(workspace, 2, 9);
    const again = maxDifference(first, second);
    console.info(`[determinism ${_name}] rerender max |diff| = ${again.worst} (peak ${again.peak})`);
    expect(again.peak).toBeGreaterThan(0.05);
    // Not always bit-identical: reruns differ by one float32 ULP near 0.1 (1.49e-8 = 2^-26) on some runs. Measured by rendering the same range repeatedly with parts removed:
    // dry audio, the sampler, the plug-in, the filter, a track delay with feedback 0 and the sends are bit-exact; the difference appears only where PingPongDelay has feedback
    // (the cycle delayL -> fbL -> delayR -> fbR -> delayL). The same topology built from plain DelayNode/GainNode/ChannelSplitter/ChannelMerger nodes with no audiorective code
    // differs the same way (7 of 12 reruns), while one DelayNode with a feedback gain on itself and two DelayNodes in series without a cycle stay exact. So the source is
    // Chromium's offline processing of a cycle of two DelayNodes, not our graph; why (summing or processing order inside the cycle) is not verified.
    // The bound is therefore a few ULP, 1e-7, about -140 dBFS.
    expect(again.worst).toBeLessThanOrEqual(1e-7);

    const bytes = await saveWorkspace(workspace);
    const opened = openDawProject(bytes);
    const reopenedProject = opened.project;
    cleanups.push(() => reopenedProject.dispose());
    const reopened = await open(reopenedProject, withDevice);
    const third = await mix(reopened, 2, 9);
    const reopenedDiff = maxDifference(first, third);
    console.info(`[determinism ${_name}] reopen max |diff| = ${reopenedDiff.worst}`);
    // Audio clips are stored as 32-bit float WAV and parameters as numbers, so a reopen is expected to be exact; keep a tiny bound as a guard.
    expect(reopenedDiff.worst).toBeLessThanOrEqual(1e-7);
  }, 120_000);
});
