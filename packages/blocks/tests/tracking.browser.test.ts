import { afterEach, describe, expect, test } from "vitest";
import { effect } from "@audiorective/core";
import { AutomationBinding, AutomationCurve, audioParamTarget } from "@audiorective/core/automation";
import { AudioRecorder } from "../src/AudioRecorder";
import { ClipLauncher, type ClipLaunchTransport } from "../src/ClipLauncher";
import { PadBank } from "../src/PadBank";
import { Lane, StepSequencer } from "../src/StepSequencer";
import { WavePlayer } from "../src/WavePlayer";
import * as audioRecorderSourceModule from "../src/AudioRecorder.ts?raw";
import * as clipLauncherSourceModule from "../src/ClipLauncher.ts?raw";
import * as padBankSourceModule from "../src/PadBank.ts?raw";
import * as stepSequencerSourceModule from "../src/StepSequencer.ts?raw";
import * as wavePlayerSourceModule from "../src/WavePlayer.ts?raw";
import { coverageGaps, watch } from "../../../scripts/tracking-coverage.mjs";

const touched = {
  wavePlayer: new Set<string>(),
  audioRecorder: new Set<string>(),
  padBank: new Set<string>(),
  stepSequencer: new Set<string>(),
  lane: new Set<string>(),
  clipLauncher: new Set<string>(),
};

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
    const watched = watch(player, touched.wavePlayer);
    disposers.push(
      () => context.close(),
      () => player.destroy(),
    );
    return { context, player: watched };
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
    ["sourceToOutput (load)", (p) => p.sourceToOutput(1), (p, c) => p.load(tone(c, 8000))],
    ["outputToSource (load)", (p) => p.outputToSource(1), (p, c) => p.load(tone(c, 8000))],
    ["sourceToOutput (stretch)", (p) => p.sourceToOutput(1), (p) => p.setStretch(2)],
    ["outputToSource (stretch)", (p) => p.outputToSource(0.5), (p) => p.setStretch(2)],
    ["isLooping", (p) => p.isLooping, (p) => p.setLooping(true)],
    ["getSelection()", (p) => p.getSelection(), (p) => p.setSelection({ start: 0.1, end: 0.5 })],
    ["getState()", (p) => p.getState(), (p) => p.setLooping(true)],
    ["getState() (load)", (p) => p.getState(), (p, c) => p.load(tone(c, 8000))],
    ["isPlaying (play)", (p) => p.isPlaying, (p) => p.play()],
  ];
  test.each(rows)("%s", async (_name, read, mutate) => {
    const { context, player } = await loaded();
    await expectTracked(
      () => read(player),
      () => mutate(player, context),
    );
  });
  test("isPlaying follows pause and stop", async () => {
    const { player } = await loaded();
    await player.play();
    await expectTracked(
      () => player.isPlaying,
      () => player.pause(),
    );
    await player.play();
    await expectTracked(
      () => player.isPlaying,
      () => player.stop(),
    );
  });
  test("subscribe notifies on change", async () => {
    const { context, player } = await loaded();
    let notified = 0;
    const unsubscribe = player.subscribe(() => notified++);
    await player.load(tone(context, 8000));
    unsubscribe();
    expect(notified).toBeGreaterThan(0);
  });
  test("playback commands called inside an effect do not subscribe it", async () => {
    const { context, player } = await loaded();
    const target = context.createGain();
    const binding = new AutomationBinding(context, new AutomationCurve([{ time: 0, value: 0, shape: "linear" }]), audioParamTarget(target.gain));
    let runs = 0;
    const stop = effect(() => {
      runs++;
      player.attachSourceAutomation(binding)();
      void player.play();
      player.seek(0.1);
      player.pause();
      player.stop();
      player.cancelLoad();
      player.subscribe(() => {})();
      void player.audition();
    });
    await player.load(tone(context, 8000));
    player.setLooping(false);
    player.setSelection({ start: 0.1, end: 0.4 });
    player.seek(0.2);
    stop();
    expect(runs).toBe(1);
    binding.destroy();
  });
  test("destroy called inside an effect does not subscribe it", async () => {
    const { player } = await loaded();
    let runs = 0;
    const stop = effect(() => {
      runs++;
      player.destroy();
    });
    stop();
    expect(runs).toBe(1);
  });
  test("owner methods called inside an effect do not subscribe it to buffer or duration", async () => {
    const { context, player } = await loaded();
    let runs = 0;
    const stop = effect(() => {
      runs++;
      player.setSelection({ start: 0, end: 0.5 });
    });
    await player.load(tone(context, 8000));
    stop();
    expect(runs).toBe(1);
  });
});

describe("AudioRecorder readers are tracked", () => {
  test("cells.state follows start and cancel", async () => {
    const context = new OfflineAudioContext(1, 48_000, 48_000);
    const recorder = watch(new AudioRecorder(context, { channels: 1 }), touched.audioRecorder);
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

describe("AudioRecorder commands drive tracked state", () => {
  const take = async (stream: boolean) => {
    const sampleRate = 48_000;
    const context = new OfflineAudioContext(1, sampleRate / 2, sampleRate);
    const recorder = watch(new AudioRecorder(context, { channels: 1 }), touched.audioRecorder);
    disposers.push(() => recorder.destroy());
    const states: string[] = [];
    let runs = 0;
    const stopEffect = effect(() => {
      runs++;
      states.push(recorder.cells.state.value);
    });
    await recorder.ready;
    if (stream) {
      await recorder.startStream(() => {}, { when: 0.1 });
      const pending = recorder.stopStream({ when: 0.3 });
      await context.startRendering();
      await pending;
    } else {
      await recorder.start({ when: 0.1 });
      const pending = recorder.stop({ when: 0.3 });
      await context.startRendering();
      await pending;
    }
    stopEffect();
    return { states, runs };
  };
  test.each([
    ["start and stop", false],
    ["startStream and stopStream", true],
  ])("cells.state follows %s", async (_name, stream) => {
    const { states, runs } = await take(stream);
    expect(states[0]).toBe("idle");
    expect(states.some((state) => state !== "idle")).toBe(true);
    expect(states[states.length - 1]).toBe("idle");
    expect(runs).toBe(states.length);
  });
});

describe("PadBank readers are tracked", () => {
  test("cells.activeEvents follows trigger and stopAll", async () => {
    const context = new AudioContext();
    const bank = watch(new PadBank(context, [{ id: "kick", buffer: tone(context) }]), touched.padBank);
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
    const bank = watch(new PadBank(context, [{ id: "kick", buffer: tone(context) }]), touched.padBank);
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

describe("StepSequencer readers are tracked", () => {
  const make = () =>
    watch(new StepSequencer({ size: 4, lanes: [{ id: "k", label: "K", cells: [{ velocity: 1 }] }] }, () => null), touched.stepSequencer);
  test("pattern follows setCell, toggle, setLane and setSize", () => {
    const sequencer = make();
    expectTracked(
      () => sequencer.pattern.value,
      () => sequencer.setCell("k", 1, { velocity: 0.5 }),
    );
    expectTracked(
      () => sequencer.pattern.value,
      () => sequencer.toggle("k", 2),
    );
    expectTracked(
      () => sequencer.pattern.value,
      () => sequencer.setLane("k", { swing: 0.3 }),
    );
    expectTracked(
      () => sequencer.pattern.value,
      () => sequencer.setSize(8),
    );
  });
  test("transforms follows setTransforms", () => {
    const sequencer = make();
    expectTracked(
      () => sequencer.transforms.value,
      () => sequencer.setTransforms([]),
    );
  });
});

describe("lane-record StepSequencer readers are tracked", () => {
  const ctx = new OfflineAudioContext(1, 128, 8000);
  const make = () => {
    const sequencer = watch(
      new StepSequencer({ k: { pattern: "X...", params: { p: { min: 0, max: 1, default: 0 } } } }, { context: ctx }),
      touched.stepSequencer,
    );
    return { sequencer, lane: watch(sequencer.lanes.k!, touched.lane) };
  };
  test("lane readers follow their setters and the step objects follow cell writes", () => {
    const { sequencer, lane } = make();
    expectTracked(
      () => lane.pattern,
      () => (lane.pattern = "XX.."),
    );
    expectTracked(
      () => lane.length,
      () => (lane.pattern = "XX..X"),
    );
    expectTracked(
      () => lane.rate,
      () => (lane.rate = "8t"),
    );
    expectTracked(
      () => lane.swing,
      () => (lane.swing = "20%"),
    );
    expectTracked(
      () => lane.mute,
      () => (lane.mute = true),
    );
    expectTracked(
      () => lane.sound,
      () => (lane.sound = "C4"),
    );
    expectTracked(
      () => lane.steps.length,
      () => (lane.pattern = "X"),
    );
    expectTracked(
      () => lane.steps[0]!.velocity,
      () => (lane.steps[0]!.velocity = 0.5),
    );
    expectTracked(
      () => lane.steps[0]!.values.p,
      () => (lane.steps[0]!.values.p = 0.7),
    );
    expect(Object.keys(lane.params)).toEqual(["p"]);
    expect(sequencer.lane("k")).toBe(sequencer.lanes.k);
    expect(sequencer.context).toBe(ctx);
  });
  test("output, connect and disconnect", () => {
    const { lane } = make();
    const node = new GainNode(ctx);
    expect(lane.connect(node)).toBe(node);
    lane.disconnect();
    expect(lane.output).toBeInstanceOf(GainNode);
  });
  test("attached, onhit, addEventListener, dispose and Symbol.dispose", () => {
    const { sequencer } = make();
    let refreshes = 0;
    const cleanup = sequencer.attached({ refresh: () => refreshes++, detach() {} });
    sequencer.lanes.k!.mute = true;
    expect(refreshes).toBe(1);
    cleanup();
    sequencer.lanes.k!.mute = false;
    expect(refreshes).toBe(1);
    sequencer.onhit = () => {};
    expect(sequencer.onhit).toBeTypeOf("function");
    sequencer.addEventListener("hit", () => {});
    sequencer.dispose();
    sequencer[Symbol.dispose]();
  });
});

describe("command methods called inside an effect do not subscribe it", () => {
  test("PadBank commands", async () => {
    const context = new AudioContext();
    const bank = watch(new PadBank(context, [{ id: "kick", buffer: tone(context) }]), touched.padBank);
    disposers.push(
      () => context.close(),
      () => bank.destroy(),
    );
    const destination = context.createGain();
    let runs = 0;
    const stop = effect(() => {
      runs++;
      bank.trigger("kick", 1, context.currentTime + 5);
      bank.routePad("kick", destination);
      bank.assign("kick", tone(context, 8000));
      bank.stopAll();
    });
    bank.assign("kick", tone(context, 4000));
    bank.routePad("kick", null);
    stop();
    expect(runs).toBe(1);
  });

  test("StepSequencer commands and schedule", () => {
    const pattern = { size: 4, lanes: [{ id: "k", label: "K", cells: [{ velocity: 1 }] }] };
    const sequencer = watch(new StepSequencer(pattern, () => null), touched.stepSequencer);
    const timing = { timeToBeat: (t: number) => t, beatToTime: (b: number) => b };
    const window = { beat: { start: 0, end: 2 }, time: { current: 0 }, own() {} };
    let runs = 0;
    const stop = effect(() => {
      runs++;
      sequencer.setCell("k", 1, { velocity: 0.5 });
      sequencer.toggle("k", 3);
      sequencer.setLane("k", { swing: 0.2 });
      sequencer.setSize(8);
      sequencer.setTransforms([]);
      sequencer.schedule(window, timing);
    });
    sequencer.setCell("k", 2, { velocity: 0.5 });
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
    const launcher = watch(new ClipLauncher(transport), touched.clipLauncher);
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

describe("every public member of a tracked block is covered", () => {
  test.each([
    [
      "WavePlayer",
      WavePlayer,
      wavePlayerSourceModule.default,
      touched.wavePlayer,
      {
        output: "constant gain node the caller wires; not state",
        position: "clock-derived playhead; a plain getter by design, read per frame (AGENTS.md rule 10)",
      },
    ],
    [
      "AudioRecorder",
      AudioRecorder,
      audioRecorderSourceModule.default,
      touched.audioRecorder,
      {
        input: "constant gain node the caller wires; not state",
        output: "always undefined; the recorder is a sink",
      },
    ],
    ["PadBank", PadBank, padBankSourceModule.default, touched.padBank, { output: "constant gain node the caller wires; not state" }],
    ["StepSequencer", StepSequencer, stepSequencerSourceModule.default, touched.stepSequencer, {}],
    ["Lane", Lane, stepSequencerSourceModule.default, touched.lane, {}],
    ["ClipLauncher", ClipLauncher, clipLauncherSourceModule.default, touched.clipLauncher, {}],
  ] as const)("%s", (_name, ctor, source, seen, excluded) => {
    expect(coverageGaps(ctor, source, seen, excluded)).toEqual([]);
  });
});
