import { afterEach, describe, expect, test } from "vitest";
import { effect } from "@audiorective/core";
import { AutomationBinding, AutomationCurve, audioParamTarget } from "@audiorective/core/automation";
import { WavePlayer } from "../src/WavePlayer";
import * as wavePlayerSourceModule from "../src/WavePlayer.ts?raw";
import { coverageGaps, watch } from "../../../scripts/tracking-coverage.mjs";

const touched = {
  wavePlayer: new Set<string>(),
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
  ] as const)("%s", (_name, ctor, source, seen, excluded) => {
    expect(coverageGaps(ctor, source, seen, excluded)).toEqual([]);
  });
});
