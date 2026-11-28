import { afterEach, expect, test } from "vitest";
import { Workspace, openDawProject, renderMixRange } from "../src";

/**
 * Playback of Bitwig's moving clip gain curve (`bitwig-6.1.7-interpolation.dawproject`, track `GainCurve`: a 12 s sine at 330 Hz, gain 0.2 held to 4 s,
 * a jump to 0.8, a ramp to 0.5 at 8 s). The clip's level is measured in the offline mix at two times; ratios cancel the sine's and the mixer's constants.
 */
const RATE = 48_000;
const worklet = "/@fs" + new URL("../../host/dist/webclap-worklet.js", import.meta.url).pathname.replace(/^\/@fs/, "");
const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const mean = (x: Float32Array, from: number, to: number) => {
  let sum = 0;
  for (let i = Math.round(from * RATE); i < Math.round(to * RATE); i++) sum += Math.abs(x[i]);
  return sum / ((to - from) * RATE);
};

test("the curve Bitwig wrote is applied by playback: 0.2 until 4 s, then a ramp from 0.8 to 0.5", async () => {
  const response = await fetch(new URL("./fixtures/dawproject/bitwig-6.1.7-interpolation.dawproject", import.meta.url).href);
  const { project, warnings } = openDawProject(new Uint8Array(await response.arrayBuffer()));
  cleanups.push(() => project.dispose());
  expect(warnings.join()).not.toContain("gain curve");
  // Leave only the clip under test in the mix.
  project.setTrackMuted(project.tracks.find((track) => track.name === "VolCurve")!.id, true);
  const context = new AudioContext({ sampleRate: RATE });
  const workspace = await Workspace.create(context, project, { workletUrl: worklet });
  cleanups.push(async () => {
    workspace.dispose();
    await context.close();
  });
  const result = await renderMixRange(workspace, { expectedVersion: project.cells.version.value, range: { startSeconds: 0, endSeconds: 8 } });
  if (result.status !== "rendered") throw new Error(result.status);
  const x = Float32Array.from(result.audio.channels[0]);
  const held = mean(x, 1, 3);
  expect(held).toBeGreaterThan(0.01);
  // 4.9 to 5.1 s is the middle of the ramp (0.8 down to 0.5 over 4 to 8 s: 0.725 at 5 s) and 7.4 to 7.6 s near its end (0.5375).
  expect(mean(x, 4.9, 5.1) / held).toBeCloseTo(0.725 / 0.2, 1);
  expect(mean(x, 7.4, 7.6) / held).toBeCloseTo(0.5375 / 0.2, 1);
  // A hold keeps its level to the jump: just before 4 s it is still 0.2.
  expect(mean(x, 3.8, 3.98) / held).toBeCloseTo(1, 1);
}, 60_000);
