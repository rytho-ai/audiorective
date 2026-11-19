import { afterEach, describe, expect, test } from "vitest";
import { effect } from "@audiorective/core";
import { AudioRecorder } from "../src/AudioRecorder";
import { ClipLauncher, type ClipLaunchTransport } from "../src/ClipLauncher";
import { PadBank } from "../src/PadBank";
import { StepSequencer } from "../src/StepSequencer";
import { WavePlayer } from "../src/WavePlayer";

const disposers: Array<() => void | Promise<unknown>> = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0).reverse()) await dispose();
});

const tone = (context: BaseAudioContext, frames = 16000) => {
  const buffer = context.createBuffer(1, frames, 16000);
  buffer.getChannelData(0).fill(0.25);
  return buffer;
};

/**
 * Reads the value inside an effect, changes it through the owner's public method, and checks that the effect
 * re-ran and saw a new value. Public readers must never be plain fields.
 */
async function expectTracked(read: () => unknown, mutate: () => void | Promise<unknown>) {
  const seen: unknown[] = [];
  const stop = effect(() => void seen.push(read()));
  const first = seen[0];
  try {
    await mutate();
  } finally {
    stop();
  }
  expect(seen.length).toBeGreaterThan(1);
  expect(Object.is(seen[seen.length - 1], first)).toBe(false);
}

describe("WavePlayer public getters are tracked", () => {
  const fixture = async () => {
    const context = new AudioContext();
    const player = new WavePlayer(context, {
      stretch: {
        process: async (input, { ratio }) => ({
          sampleRate: input.sampleRate,
          channels: input.channels.map((c) => new Float32Array(Math.round(c.length * ratio))),
        }),
      },
    });
    disposers.push(
      () => context.close(),
      () => player.destroy(),
    );
    return { context, player };
  };
  const loaded = async () => {
    const f = await fixture();
    await f.player.load(tone(f.context));
    return f;
  };
  const rows: Array<[string, (p: WavePlayer) => unknown, (p: WavePlayer, c: AudioContext) => void | Promise<unknown>]> = [
    ["buffer (load)", (p) => p.buffer, (p, c) => p.load(tone(c, 8000))],
    ["duration (load)", (p) => p.duration, (p, c) => p.load(tone(c, 8000))],
    ["sourceBuffer (load)", (p) => p.sourceBuffer, (p, c) => p.load(tone(c, 8000))],
    ["version (load)", (p) => p.version, (p, c) => p.load(tone(c, 8000))],
    ["buffer (stretch)", (p) => p.buffer, (p) => p.setStretch(2)],
    ["duration (stretch)", (p) => p.duration, (p) => p.setStretch(2)],
    ["version (stretch)", (p) => p.version, (p) => p.setStretch(2)],
    ["isLooping", (p) => p.isLooping, (p) => p.setLooping(true)],
    ["getSelection()", (p) => p.getSelection(), (p) => p.setSelection({ start: 0.1, end: 0.5 })],
    ["getState()", (p) => p.getState(), (p) => p.setLooping(true)],
    ["getState() (load)", (p) => p.getState(), (p, c) => p.load(tone(c, 8000))],
  ];
  test.each(rows)("%s", async (_name, read, mutate) => {
    const { context, player } = await loaded();
    await expectTracked(
      () => read(player),
      () => mutate(player, context),
    );
  });
  test("owner methods called inside an effect do not subscribe it to buffer or duration", async () => {
    const { context, player } = await loaded();
    let runs = 0;
    const stop = effect(() => {
      runs++;
      player.setSelection({ start: 0, end: 0.5 });
      player.sourceToOutput(0.5);
      player.outputToSource(0.5);
    });
    await player.load(tone(context, 8000));
    stop();
    expect(runs).toBe(1);
  });
});

describe("AudioRecorder readers are tracked", () => {
  test("cells.state follows start and cancel", async () => {
    const context = new OfflineAudioContext(1, 48_000, 48_000);
    const recorder = new AudioRecorder(context, { channels: 1 });
    disposers.push(() => recorder.destroy());
    const states: string[] = [];
    const stop = effect(() => void states.push(recorder.cells.state.value));
    const started = recorder.start({ when: 0.1 });
    started.catch(() => undefined);
    await new Promise((done) => setTimeout(done, 20));
    recorder.cancel();
    await started.catch(() => undefined);
    stop();
    expect(states[0]).toBe("idle");
    expect(states).toContain("armed");
    expect(states[states.length - 1]).toBe("idle");
  });
});

describe("PadBank readers are tracked", () => {
  test("cells.activeEvents follows trigger and stopAll", async () => {
    const context = new AudioContext();
    const bank = new PadBank(context, [{ id: "kick", buffer: tone(context) }]);
    disposers.push(
      () => context.close(),
      () => bank.destroy(),
    );
    await expectTracked(
      () => bank.cells.activeEvents.value,
      () => void bank.trigger("kick", 1, context.currentTime + 5),
    );
    await expectTracked(
      () => bank.cells.activeEvents.value,
      () => bank.stopAll(),
    );
  });
  test("cells.pads follows assign", async () => {
    const context = new AudioContext();
    const bank = new PadBank(context, [{ id: "kick", buffer: tone(context) }]);
    disposers.push(
      () => context.close(),
      () => bank.destroy(),
    );
    await expectTracked(
      () => bank.cells.pads.value,
      () => bank.assign("kick", tone(context, 8000)),
    );
  });
});

describe("command methods called inside an effect do not subscribe it", () => {
  test("StepSequencer.setVelocity and schedule", () => {
    const pattern = { steps: 4, beatsPerStep: 1, lanes: [{ id: "k", label: "K", velocities: [1, 0, 0, 0] }] };
    const sequencer = new StepSequencer(pattern, () => null);
    const timing = { timeToBeat: (t: number) => t, beatToTime: (b: number) => b };
    const window = { beat: { start: 0, end: 2 }, time: { current: 0 }, own() {} };
    let runs = 0;
    const stop = effect(() => {
      runs++;
      sequencer.setVelocity("k", 1, 0.5);
      sequencer.schedule(window, timing);
    });
    sequencer.setVelocity("k", 2, 0.5);
    sequencer.reset();
    stop();
    expect(runs).toBe(1);
  });

  test("ClipLauncher.queue, cancel and advance", () => {
    let now = 0;
    const transport: ClipLaunchTransport = {
      now: () => now,
      timeToBeat: (t) => t,
      beatToTime: (b) => b,
      schedule: () => ({ cancel() {}, commit() {} }),
      reset() {},
    };
    const launcher = new ClipLauncher(transport);
    let runs = 0;
    const stop = effect(() => {
      runs++;
      launcher.queue([{ trackId: "a", clipId: "x" }]);
      launcher.advance();
      launcher.cancel();
    });
    launcher.queue([{ trackId: "a", clipId: "y" }]);
    now = 5;
    launcher.advance();
    launcher.reset();
    stop();
    expect(runs).toBe(1);
  });
});
