import { afterEach, expect, test } from "vitest";
import { BufferPlayer, type BeatTiming } from "@audiorective/core";
import { ClipLauncher, type ClipLaunch, type ClipLaunchTransition, type ClipLaunchTransport } from "../src/ClipLauncher";

const SAMPLE_RATE = 8000;
const SECONDS = 4;
/** 120 bpm from audio time zero. */
const timing: BeatTiming = { beatToTime: (beat) => beat * 0.5, timeToBeat: (time) => time * 2 };
const levels: Record<string, number> = { a: 0.25, b: 0.5, c: 0.125 };

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
    schedule({ clipId }: ClipLaunch, when: number): ClipLaunchTransition {
      if (clipId === null) return { cancel() {}, commit() {} };
      const buffer = context.createBuffer(1, SAMPLE_RATE * SECONDS, SAMPLE_RATE);
      buffer.getChannelData(0).fill(levels[clipId]);
      const player = new BufferPlayer(context, { buffer });
      player.output.connect(context.destination);
      player.start(when);
      players.set(`${clipId}@${when}`, player);
      return { cancel: () => player.destroy(), commit() {} };
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
  expect(queued).toEqual([{ trackId: "t", clipId: "a", beat: 4, when: 2 }]);
  const samples = await render(context);
  expect(firstSound(samples)).toBe(2 * SAMPLE_RATE);
  expect(samples[2 * SAMPLE_RATE - 1]).toBe(0);
  expect(samples[2 * SAMPLE_RATE + 10]).toBeCloseTo(levels.a, 5);
});

test("cancelling a queued launch leaves the render silent", async () => {
  const { context, launcher } = fixture();
  launcher.queue([{ trackId: "t", clipId: "a" }], 4);
  expect(launcher.cancel()).toBe(true);
  expect(launcher.state.value.queued).toEqual([]);
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

test("independent launches on different tracks coexist and fire on their own boundaries", async () => {
  const { context, launcher } = fixture();
  launcher.queue([{ trackId: "t1", clipId: "a" }], 4);
  launcher.queue([{ trackId: "t2", clipId: "b" }], 2);
  expect(launcher.state.value.queued.map(({ trackId, when }) => [trackId, when])).toEqual([
    ["t1", 2],
    ["t2", 1],
  ]);
  const samples = await render(context);
  expect(samples[1 * SAMPLE_RATE - 1]).toBe(0);
  expect(samples[1 * SAMPLE_RATE + 10]).toBeCloseTo(levels.b, 5);
  expect(samples[2 * SAMPLE_RATE + 10]).toBeCloseTo(levels.a + levels.b, 5);
});

test("re-queueing one track leaves the other tracks' pending launches", async () => {
  const { context, launcher } = fixture();
  launcher.queue([{ trackId: "t1", clipId: "a" }], 4);
  launcher.queue([{ trackId: "t2", clipId: "b" }], 4);
  launcher.queue([{ trackId: "t2", clipId: "c" }], 4);
  expect(launcher.state.value.queued.map(({ trackId, clipId }) => [trackId, clipId])).toEqual([
    ["t1", "a"],
    ["t2", "c"],
  ]);
  const samples = await render(context);
  expect(firstSound(samples)).toBe(2 * SAMPLE_RATE);
  expect(samples[2 * SAMPLE_RATE + 10]).toBeCloseTo(levels.a + levels.c, 5);
});

test("a scene lands every track on the same sample", async () => {
  const { context, launcher } = fixture();
  const queued = launcher.queue(
    [
      { trackId: "t1", clipId: "a" },
      { trackId: "t2", clipId: "b" },
    ],
    4,
  );
  expect(new Set(queued.map(({ when }) => when))).toEqual(new Set([2]));
  const samples = await render(context);
  expect(samples[2 * SAMPLE_RATE - 1]).toBe(0);
  expect(samples[2 * SAMPLE_RATE]).toBeCloseTo(levels.a + levels.b, 5);
});

test("withdrawing one track from a pending scene leaves the rest", async () => {
  const { context, launcher } = fixture();
  launcher.queue(
    [
      { trackId: "t1", clipId: "a" },
      { trackId: "t2", clipId: "b" },
    ],
    4,
  );
  expect(launcher.cancel("t1")).toBe(true);
  expect(launcher.cancel("t1")).toBe(false);
  expect(launcher.state.value.queued.map(({ trackId }) => trackId)).toEqual(["t2"]);
  const samples = await render(context);
  expect(samples[2 * SAMPLE_RATE + 10]).toBeCloseTo(levels.b, 5);
});

test("cancel without a track withdraws every pending launch", async () => {
  const { context, launcher } = fixture();
  launcher.queue([{ trackId: "t1", clipId: "a" }], 4);
  launcher.queue([{ trackId: "t2", clipId: "b" }], 2);
  expect(launcher.cancel()).toBe(true);
  expect(launcher.cancel()).toBe(false);
  expect(launcher.state.value.queued).toEqual([]);
  expect(firstSound(await render(context))).toBe(-1);
});

test("quantum 0 launches at the current audio time", async () => {
  const { context, launcher } = fixture();
  const [queued] = launcher.queue([{ trackId: "t", clipId: "a" }], 0);
  expect(queued).toMatchObject({ beat: 0, when: 0 });
  expect(firstSound(await render(context))).toBe(0);
});

test("a negative or non-finite quantum throws", () => {
  const { launcher } = fixture();
  for (const quantum of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
    expect(() => launcher.queue([{ trackId: "t", clipId: "a" }], quantum)).toThrow("Clip Launcher requires a non-negative launch quantum.");
  }
});

/** A stub transport with a manual clock, recording what the driver was asked to do. */
function stub() {
  const log: string[] = [];
  const clock = { now: 0 };
  const transport: ClipLaunchTransport = {
    now: () => clock.now,
    timeToBeat: (time) => time,
    beatToTime: (beat) => beat,
    schedule: ({ trackId, clipId, mode }, when) => {
      log.push(`schedule ${trackId} ${clipId} @${when}`);
      return {
        cancel: () => log.push(`cancel ${trackId}`),
        commit: () => log.push(`commit ${trackId}`),
        endsAt: mode === "one-shot" ? when + 2 : undefined,
      };
    },
    reset: () => log.push("reset"),
  };
  return { clock, log, launcher: new ClipLauncher(transport) };
}

test("a one-shot override ends at its audio time", () => {
  const { clock, launcher } = stub();
  launcher.queue([{ trackId: "t", clipId: "a", mode: "one-shot" }], 1);
  clock.now = 1;
  launcher.advance();
  expect(launcher.state.value.active).toEqual([{ trackId: "t", clipId: "a", mode: "one-shot" }]);
  clock.now = 3;
  launcher.advance();
  expect(launcher.state.value.active).toEqual([]);
});

test("each track commits on its own boundary and a replaced launch is cancelled by the launcher", () => {
  const { clock, log, launcher } = stub();
  launcher.queue([{ trackId: "t1", clipId: "a" }], 4);
  launcher.queue([{ trackId: "t2", clipId: "b" }], 1);
  launcher.queue([{ trackId: "t1", clipId: "c" }], 4);
  expect(log).toEqual(["schedule t1 a @4", "schedule t2 b @1", "cancel t1", "schedule t1 c @4"]);
  clock.now = 1;
  launcher.advance();
  expect(launcher.state.value.active.map(({ clipId }) => clipId)).toEqual(["b"]);
  expect(launcher.state.value.queued.map(({ clipId }) => clipId)).toEqual(["c"]);
  clock.now = 4;
  launcher.advance();
  expect(launcher.state.value.active.map(({ clipId }) => clipId)).toEqual(["b", "c"]);
  expect(log.slice(4)).toEqual(["commit t2", "commit t1"]);
});

test("a scene whose driver throws leaves nothing half-scheduled", () => {
  const { log, launcher } = stub();
  const failing = new ClipLauncher({
    now: () => 0,
    timeToBeat: (time) => time,
    beatToTime: (beat) => beat,
    schedule: ({ trackId }) => {
      if (trackId === "bad") throw new Error("driver failed");
      return { cancel: () => log.push(`cancel ${trackId}`), commit() {} };
    },
    reset() {},
  });
  expect(() =>
    failing.queue([
      { trackId: "ok", clipId: "a" },
      { trackId: "bad", clipId: "b" },
    ]),
  ).toThrow("driver failed");
  expect(log).toEqual(["cancel ok"]);
  expect(failing.state.value.queued).toEqual([]);
  expect(launcher.state.value.queued).toEqual([]);
});

test("reset clears every pending and active launch", () => {
  const { clock, log, launcher } = stub();
  launcher.queue([{ trackId: "t1", clipId: "a" }], 1);
  clock.now = 1;
  launcher.advance();
  launcher.queue([{ trackId: "t2", clipId: "b" }], 4);
  launcher.queue([{ trackId: "t3", clipId: "c" }], 4);
  log.length = 0;
  launcher.reset();
  expect(log).toEqual(["cancel t2", "cancel t3", "reset"]);
  expect(launcher.state.value).toEqual({ active: [], queued: [] });
});
