import { afterEach, expect, test } from "vitest";
import { Project, Workspace, renderMixRange } from "../src";

const RATE = 48_000;
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const sine = (seconds: number, hz = 200) =>
  Float32Array.from({ length: Math.round(seconds * RATE) }, (_, i) => 0.5 * Math.sin((2 * Math.PI * hz * i) / RATE));
const largestStep = (samples: Float32Array, from: number, to: number) => {
  let worst = 0;
  for (let i = Math.max(1, from); i < Math.min(samples.length, to); i++) worst = Math.max(worst, Math.abs(samples[i] - samples[i - 1]));
  return worst;
};

async function renderCut(crossfade: number) {
  const project = new Project({ bpm: 120 });
  const track = project.addTrack("Tone", "audio");
  project.addAudioClip(track.id, { sampleRate: RATE, channels: [sine(3)] }, 0);
  // A cut length that is not a whole number of periods, so the pieces meet out of phase.
  project.rippleDelete({ startSeconds: 1, endSeconds: 1.3023 }, { crossfade });
  const context = new AudioContext({ sampleRate: RATE });
  const workspace = await Workspace.create(context, project);
  cleanups.push(async () => {
    workspace.dispose();
    project.dispose();
    await context.close();
  });
  const result = await renderMixRange(workspace, {
    expectedVersion: project.cells.version.value,
    range: { startSeconds: 0.5, endSeconds: 1.5 },
    prerollSeconds: 0,
  });
  if (result.status !== "rendered") throw new Error(result.reason);
  return result;
}

test("a crossfaded ripple delete renders without a discontinuity, and renderMixRange takes seconds", async () => {
  const result = await renderCut(0.02);
  expect(result.durationSeconds).toBeCloseTo(1, 9);
  expect(result.audio.channels[0].length).toBe(RATE);
  expect(result.startSeconds).toBeCloseTo(0.5, 9);
  const samples = result.audio.channels[0];
  const join = Math.round(0.5 * RATE);
  const normal = largestStep(samples, 0, join - 2000);
  expect(normal).toBeGreaterThan(0.001);
  expect(largestStep(samples, join - 1500, join + 1500)).toBeLessThan(normal * 1.5);
}, 30_000);

test("without a crossfade the same cut jumps, so the check above can fail", async () => {
  const result = await renderCut(0);
  const samples = result.audio.channels[0];
  const join = Math.round(0.5 * RATE);
  expect(largestStep(samples, join - 1500, join + 1500)).toBeGreaterThan(largestStep(samples, 0, join - 2000) * 3);
}, 30_000);
