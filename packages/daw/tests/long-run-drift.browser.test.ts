/**
 * Gates G3.2 and G3.3: long-run timing drift and audio-thread dropouts.
 *
 * 16 tracks play for a while on a real 48 kHz AudioContext. Each carries single-sample clicks at known times, spread over the whole run, through a
 * tempo map that changes several times: 8 MIDI tracks through an impulse instrument (positions in beats) and 8 audio tracks with one short clip per click
 * (positions in seconds). The master is captured sample-accurately (`helpers/live-capture.ts`); every captured click is located (energy centroid, so a click
 * that starts between two frames is still placed to a fraction of a frame) and compared with where the project says it is. The drift is the largest change
 * of that error relative to the first click, in samples. Dropouts are jumps of `currentFrame` between audio-thread callbacks, as the recorder worklet counts them.
 *
 * The short variant (16 tracks, 20 s) always runs. The long variant runs only with `VITE_AR_LONG=1` (Vite exposes only `VITE_`-prefixed variables to browser tests),
 * 10 minutes by default or `VITE_AR_LONG_SECONDS`:
 *   VITE_AR_LONG=1 pnpm --filter @audiorective/daw exec vitest run --project browser tests/long-run-drift.browser.test.ts
 */
import type { SoundFactory } from "@audiorective/core";
import { afterEach, describe, expect, test } from "vitest";
import { Project, Workspace } from "../src";
import { LiveCapture, sleep } from "./helpers/live-capture";

const RATE = 48_000;
const TRACKS = 16;
const worklet = "/@fs" + new URL("../../host/dist/webclap-worklet.js", import.meta.url).pathname.replace(/^\/@fs/, "");
const env = (import.meta as unknown as { env: Record<string, string | undefined> }).env;
const LONG = env.VITE_AR_LONG === "1";
const LONG_SECONDS = Number(env.VITE_AR_LONG_SECONDS ?? 600);

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** One sample at 0.5, played by the sampler at the hit's time. */
const impulse: SoundFactory = (context) => {
  const buffer = new AudioBuffer({ length: 64, sampleRate: RATE });
  buffer.getChannelData(0)[0] = 0.5;
  const source = new AudioBufferSourceNode(context, { buffer });
  return { output: source, sources: [source], duration: 0.01 };
};

const CLICK_AT = 100; // frame of the click inside an audio clip
const clickBuffer = () => {
  const data = new Float32Array(4800);
  data[CLICK_AT] = 0.5;
  return data;
};

type Plan = { project: Project; expected: number[]; instruments: Record<string, { sound: SoundFactory }> };

/** Every track clicks every `TRACKS * gap` seconds, track `i` offset by `i * gap`, so each click in the master is alone. Times are project seconds. */
function plan(seconds: number, gap: number, tempoEveryBeats: number): Plan {
  const project = new Project({ bpm: 120 });
  const bpms = [150, 90, 130, 110, 120];
  project.setTempoChanges(
    Array.from({ length: Math.floor((seconds * 2.5) / tempoEveryBeats) }, (_, index) => ({
      beat: (index + 1) * tempoEveryBeats,
      bpm: bpms[index % bpms.length]!,
    })),
  );
  const map = project.tempoMap;
  const expected: number[] = [];
  const instruments: Plan["instruments"] = {};
  const period = TRACKS * gap;
  const clip = clickBuffer();
  for (let i = 0; i < TRACKS; i++) {
    const midi = i < TRACKS / 2;
    const track = project.addTrack(`T${i}`, midi ? "midi" : "audio");
    const times: number[] = [];
    for (let t = 0.5 + i * gap; t < seconds - 0.5; t += period) times.push(t);
    expected.push(...times);
    if (midi) {
      instruments[track.id] = { sound: impulse };
      const beats = times.map((t) => map.secondsToBeat(t));
      project.addMidiClip(
        track.id,
        { duration: Math.ceil(map.secondsToBeat(seconds)), notes: beats.map((start) => ({ pitch: 60, velocity: 1, start, duration: 0.01 })) },
        0,
      );
    } else {
      for (const t of times) project.addAudioClip(track.id, { sampleRate: RATE, channels: [clip] }, t - CLICK_AT / RATE);
    }
  }
  expected.sort((a, b) => a - b);
  return { project, expected, instruments };
}

/** The frame (fractional) of each click in `x`: the centroid of the energy within a few frames, one entry per isolated burst. */
function findClicks(x: Float32Array, threshold = 0.02): number[] {
  const found: number[] = [];
  let i = 0;
  while (i < x.length) {
    if (Math.abs(x[i]!) <= threshold) {
      i++;
      continue;
    }
    let weight = 0;
    let moment = 0;
    let end = i;
    for (let j = Math.max(0, i - 3); j < Math.min(x.length, i + 12); j++) {
      const w = Math.abs(x[j]!);
      weight += w;
      moment += w * j;
      end = j;
    }
    found.push(moment / weight);
    i = end + 1;
  }
  return found;
}

async function run(seconds: number, gap: number, tempoEveryBeats: number) {
  const { project, expected, instruments } = plan(seconds, gap, tempoEveryBeats);
  cleanups.push(() => project.dispose());
  const context = new AudioContext({ sampleRate: RATE, latencyHint: "interactive" });
  const workspace = await Workspace.create(context, project, { workletUrl: worklet, instruments });
  cleanups.push(async () => {
    workspace.dispose();
    await context.close();
  });
  expect(workspace.cells.warnings.value).toEqual([]);
  await context.resume();
  const capture = await LiveCapture.on(context, workspace.output, 1);
  const began = performance.now();
  await workspace.play();
  const startTime = workspace.transport.timeline.beatToTime(0);
  await sleep((startTime - context.currentTime + seconds + 0.3) * 1000);
  workspace.stop();
  const wall = (performance.now() - began) / 1000;
  const { first, data, dropouts } = await capture.stop();

  const startFrame = startTime * RATE;
  const found = findClicks(data[0]!).map((frame) => frame + first);
  const errors = found.map((frame, index) => frame - (startFrame + expected[index]! * RATE));
  const relative = errors.map((error) => error - errors[0]!);
  const counted = dropouts.filter((gap) => gap.endFrame > startFrame);
  const worst = relative.reduce((max, value) => (Math.abs(value) > Math.abs(max) ? value : max), 0);
  console.info(
    `[long-run ${seconds}s] clicks ${found.length}/${expected.length}, first-click error ${errors[0]!.toFixed(3)} frames, ` +
      `max drift vs first click ${Math.abs(worst).toFixed(3)} frames (${((Math.abs(worst) / RATE) * 1e6).toFixed(1)} us), ` +
      `max |error| vs the project ${Math.max(...errors.map(Math.abs)).toFixed(3)} frames, dropouts ${counted.length} ${JSON.stringify(counted.slice(0, 5))}, wall ${wall.toFixed(1)} s`,
  );
  return { expectedCount: expected.length, found: found.length, worst: Math.abs(worst), dropouts: counted.length };
}

describe("long-run drift and dropouts", () => {
  test("16 tracks for 20 s: every click lands within 1 sample of the first click's error, with no dropouts", async () => {
    const result = await run(20, 0.1, 16);
    expect(result.found).toBe(result.expectedCount);
    expect(result.worst).toBeLessThanOrEqual(1);
    expect(result.dropouts).toBe(0);
  }, 90_000);

  test.skipIf(!LONG)(
    `16 tracks for ${LONG_SECONDS} s (VITE_AR_LONG=1)`,
    async () => {
      const result = await run(LONG_SECONDS, 0.5, 64);
      expect(result.found).toBe(result.expectedCount);
      expect(result.worst).toBeLessThanOrEqual(1);
      expect(result.dropouts).toBe(0);
    },
    LONG_SECONDS * 1000 + 120_000,
  );
});
