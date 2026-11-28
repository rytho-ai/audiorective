import { afterEach, expect, test } from "vitest";
import { Workspace, openDawProject, renderMixRange } from "../src";
import { foreignGainFile, type CurvePoint } from "./helpers/foreign-gain";

const RATE = 48_000;
const worklet = "/@fs" + new URL("../../host/dist/webclap-worklet.js", import.meta.url).pathname.replace(/^\/@fs/, "");
const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** The left channel of the first four seconds of a foreign file's mix. */
async function mixOf(points: readonly CurvePoint[], timeUnit: "seconds" | "beats") {
  const { project, warnings } = openDawProject(foreignGainFile(points, { timeUnit, rate: RATE }).bytes);
  expect(warnings.join()).not.toContain("gain curve");
  cleanups.push(() => project.dispose());
  const context = new AudioContext({ sampleRate: RATE });
  const workspace = await Workspace.create(context, project, { workletUrl: worklet });
  cleanups.push(async () => {
    workspace.dispose();
    await context.close();
  });
  const result = await renderMixRange(workspace, { expectedVersion: project.cells.version.value, range: { startSeconds: 0, endSeconds: 4 } });
  if (result.status !== "rendered") throw new Error(result.status);
  return Float32Array.from(result.audio.channels[0]);
}

const mean = (x: Float32Array, from: number, to: number) => {
  let sum = 0;
  for (let i = Math.round(from * RATE); i < Math.round(to * RATE); i++) sum += Math.abs(x[i]);
  return sum / ((to - from) * RATE);
};

// Levels relative to the 0.2 segment: the clip is constant, so a segment's mean is the curve times one fixed factor.
test.each([
  ["seconds", 1],
  ["beats", 2],
] as const)(
  "a moving gain curve in %s plays: hold steps, then a linear ramp",
  async (timeUnit, scale) => {
    const x = await mixOf(
      [
        { time: 0, value: 0.2, interpolation: "hold" },
        { time: 1 * scale, value: 0.8, interpolation: "hold" },
        { time: 2 * scale, value: 0.8, interpolation: "linear" },
        { time: 3 * scale, value: 0.2, interpolation: "linear" },
      ],
      timeUnit,
    );
    const unit = mean(x, 0.2, 0.8) / 0.2;
    expect(unit).toBeGreaterThan(0.05);
    // A hold point keeps its level until the next point instead of ramping to it.
    expect(mean(x, 0.9, 0.99) / unit).toBeCloseTo(0.2, 2);
    expect(mean(x, 1.2, 1.8) / unit).toBeCloseTo(0.8, 2);
    expect(mean(x, 2.4, 2.6) / unit).toBeCloseTo(0.5, 2);
    expect(mean(x, 3.2, 3.8) / unit).toBeCloseTo(0.2, 2);
  },
  60_000,
);
