import { afterEach, expect, test } from "vitest";
import { BufferPlayer, type BeatTiming } from "@audiorective/core";
import { ClipLauncher, type ClipLaunch, type ClipLaunchTransition, type ClipLaunchTransport } from "../src/ClipLauncher";

const SAMPLE_RATE = 8000;
const SECONDS = 4;
/** 120 bpm from audio time zero. */
const timing: BeatTiming = { beatToTime: (beat) => beat * 0.5, timeToBeat: (time) => time * 2 };
const levels: Record<string, number> = { a: 0.25, b: 0.5 };

const disposers: Array<() => void> = [];
afterEach(() => {
  for (const dispose of disposers.splice(0).reverse()) dispose();
});

/** A minimal live-launcher transport: one BufferPlayer per launched clip, no DAW. */
function fixture() {
  const context = new OfflineAudioContext(1, SAMPLE_RATE * SECONDS, SAMPLE_RATE);
  const players = new Map<string, BufferPlayer>();
  const transport: ClipLaunchTransport = {
    ...timing,
    now: () => context.currentTime,
    schedule(changes: readonly ClipLaunch[], when: number): ClipLaunchTransition {
      const started: BufferPlayer[] = [];
      for (const { clipId } of changes) {
        if (clipId === null) continue;
        const buffer = context.createBuffer(1, SAMPLE_RATE * SECONDS, SAMPLE_RATE);
        buffer.getChannelData(0).fill(levels[clipId]);
        const player = new BufferPlayer(context, { buffer });
        player.output.connect(context.destination);
        player.start(when);
        players.set(clipId, player);
        started.push(player);
      }
      return {
        cancel: () => {
          for (const player of started) player.destroy();
        },
        commit() {},
      };
    },
    reset: () => {},
  };
  disposers.push(() => players.forEach((player) => player.destroy()));
  return { context, launcher: new ClipLauncher(transport) };
}

async function render(context: OfflineAudioContext): Promise<Float32Array> {
  return (await context.startRendering()).getChannelData(0);
}
const firstSound = (samples: Float32Array) => samples.findIndex((value) => Math.abs(value) > 1e-4);

test("a queued clip starts at the next quantized beat", async () => {
  const { context, launcher } = fixture();
  const queued = launcher.queue([{ trackId: "t", clipId: "a" }], 4);
  expect(queued.beat).toBe(4);
  expect(queued.when).toBe(2);
  const samples = await render(context);
  expect(firstSound(samples)).toBe(2 * SAMPLE_RATE);
  expect(samples[2 * SAMPLE_RATE - 1]).toBe(0);
  expect(samples[2 * SAMPLE_RATE + 10]).toBeCloseTo(levels.a, 5);
});

test("cancelling a queued launch leaves the render silent", async () => {
  const { context, launcher } = fixture();
  launcher.queue([{ trackId: "t", clipId: "a" }], 4);
  expect(launcher.cancel()).toBe(true);
  expect(launcher.state.value.queued).toBeNull();
  expect(firstSound(await render(context))).toBe(-1);
});

test("a replacement launch supersedes the first, which never sounds", async () => {
  const { context, launcher } = fixture();
  launcher.queue([{ trackId: "t", clipId: "a" }], 4);
  const second = launcher.queue([{ trackId: "t", clipId: "b" }], 4);
  expect(launcher.state.value.queued).toEqual(second);
  const samples = await render(context);
  expect(firstSound(samples)).toBe(2 * SAMPLE_RATE);
  expect(samples.every((value) => value === 0 || Math.abs(value - levels.b) < 1e-5)).toBe(true);
});
