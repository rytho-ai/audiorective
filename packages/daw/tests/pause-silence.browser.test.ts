import { ManualTickSource } from "@audiorective/clock";
import { expect, test } from "vitest";
import { Project, Workspace } from "../src";

const RATE = 48_000;
const QUANTUM = 128;
/** A live pause starts its fade 10 ms ahead of the context clock and lasts 12 ms. */
const SILENT_BY = 0.022;

/**
 * Pause an audio clip at an exact graph time and report when its output is silent for good. Graph time, not wall time: a live page reads an analyser
 * a wall-clock delay after `pause()`, and the audio clock can lag the wall by a render callback, so only graph time is stable enough to assert on.
 */
async function silenceAfterPause(pauseAt: number) {
  const project = new Project({ bpm: 120 });
  const track = project.addTrack("Sustained", "audio");
  const tone = new Float32Array(RATE).fill(0.5);
  project.addAudioClip(track.id, { sampleRate: RATE, channels: [tone] }, 0);
  const context = new OfflineAudioContext(2, RATE, RATE);
  const ticks = new ManualTickSource();
  const workspace = await Workspace.create(context as unknown as AudioContext, project, { destination: context.destination, tickSource: ticks });
  await workspace.play();
  ticks.tick();
  await workspace.renderSettled();
  const suspended = context.suspend(Math.round((pauseAt * RATE) / QUANTUM) * (QUANTUM / RATE));
  const rendering = context.startRendering();
  await suspended;
  const at = context.currentTime;
  workspace.pause();
  await context.resume();
  const data = (await rendering).getChannelData(0);
  workspace.dispose();
  project.dispose();
  let last = -1;
  for (let i = 0; i < data.length; i++) if (Math.abs(data[i]) > 1e-4) last = i;
  return { at, lastAudible: (last + 1) / RATE - at, before: Math.abs(data[Math.floor((at - 0.005) * RATE)]) };
}

test("pause silences an audio clip within its 22 ms fade, whatever the quantum it lands in", async () => {
  for (const pauseAt of [0.2, 0.2 + 37 / RATE, 0.2 + 77 / RATE, 0.2 + 100 / RATE]) {
    const { lastAudible, before } = await silenceAfterPause(pauseAt);
    expect(before, "the clip sounds right up to the pause").toBeGreaterThan(0.1);
    expect(lastAudible, `silent ${SILENT_BY} s after a pause at ${pauseAt}`).toBeLessThanOrEqual(SILENT_BY + QUANTUM / RATE);
    expect(lastAudible, "the fade does not cut the sound at once").toBeGreaterThan(0.01);
  }
});
