import { afterEach, expect, test, vi } from "vitest";
import type { BeatTiming, CancellableEvent } from "@audiorective/core";
import { PadBank } from "@audiorective/pads";
import { StepSequencer, type Hit, type LaneOptions, type StepWindow } from "../src/StepSequencer";

const disposers: Array<() => void | Promise<unknown>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const dispose of disposers.splice(0).reverse()) await dispose();
});

const lanes: Record<string, LaneOptions> = {
  kick: { pattern: [1, 0, 0.5, 0], rate: "1/8" },
  snare: { pattern: [0, 0.75, 0, 0.25], rate: "1/8" },
};
/** 120 bpm, starting at audio time 10 so every hit lies in the future. */
const timing: BeatTiming = { beatToTime: (beat) => 10 + beat * 0.5, timeToBeat: (time) => (time - 10) * 2 };

type Owned = { event: CancellableEvent; when: number };
function windows(): { window: StepWindow; owned: Owned[] }[] {
  return [
    [0, 2],
    [2, 4],
  ].map(([start, end]) => {
    const owned: Owned[] = [];
    return {
      window: { beat: { start, end }, time: { current: timing.beatToTime(0) }, own: (event, when) => owned.push({ event, when }) },
      owned,
    };
  });
}

type Played = { lane: string; when: number; velocity: number };
const sortHits = (hits: Played[]) => [...hits].sort((a, b) => a.when - b.when || a.lane.localeCompare(b.lane));

function instrumentSource(context: AudioContext) {
  const buffer = context.createBuffer(1, context.sampleRate, context.sampleRate);
  const bank = new PadBank(context, [
    { id: "kick", buffer },
    { id: "snare", buffer },
  ]);
  disposers.push(() => bank.destroy());
  const played: Played[] = [];
  const spy = vi.spyOn(bank, "trigger");
  return {
    played: () => {
      played.length = 0;
      for (const [lane, velocity, when] of spy.mock.calls) played.push({ lane, velocity: velocity!, when: when! });
      return played;
    },
    live: () => bank.cells.activeEvents.value,
    onHit: (hit: Hit) => {
      const played = bank.trigger(hit.lane, hit.velocity, hit.when);
      return () => played?.cancel();
    },
  };
}

/** A tiny oscillator synth: one oscillator per hit, gain carries velocity. */
function synthSource(context: AudioContext) {
  const played: Played[] = [];
  let live = 0;
  return {
    played: () => played,
    live: () => live,
    onHit(hit: Hit): () => void {
      const osc = new OscillatorNode(context, { frequency: hit.lane === "kick" ? 60 : 200 });
      const gain = new GainNode(context, { gain: hit.velocity });
      osc.connect(gain).connect(context.destination);
      osc.start(hit.when);
      osc.stop(hit.when + 0.1);
      played.push({ lane: hit.lane, velocity: gain.gain.value, when: hit.when });
      live++;
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        live--;
        osc.disconnect();
        gain.disconnect();
      };
      osc.onended = finish;
      return () => {
        if (done) return;
        try {
          osc.stop();
        } catch {
          /* not started */
        }
        finish();
      };
    },
  };
}

test("a pattern yields identical hit times and velocities from any event source, and reset cancels both", async () => {
  const context = new AudioContext();
  disposers.push(() => context.close());
  const expected = sortHits([
    { lane: "kick", when: 10, velocity: 1 },
    { lane: "snare", when: 10.25, velocity: 0.75 },
    { lane: "kick", when: 10.5, velocity: 0.5 },
    { lane: "snare", when: 10.75, velocity: 0.25 },
    { lane: "kick", when: 11, velocity: 1 },
    { lane: "snare", when: 11.25, velocity: 0.75 },
    { lane: "kick", when: 11.5, velocity: 0.5 },
    { lane: "snare", when: 11.75, velocity: 0.25 },
  ]);

  const runs = [instrumentSource(context), synthSource(context)].map((source) => {
    const sequencer = new StepSequencer(lanes, { onHit: source.onHit });
    const wins = windows();
    for (const { window } of wins) sequencer.schedule(window, timing);
    return { sequencer, source, owned: wins.flatMap(({ owned }) => owned) };
  });

  const [instrument, synth] = runs;
  expect(sortHits(instrument.source.played())).toEqual(expected);
  expect(sortHits(synth.source.played())).toEqual(expected);
  const ownedTimes = (owned: Owned[]) => owned.map(({ when }) => when).sort((x, y) => x - y);
  expect(ownedTimes(instrument.owned)).toEqual(ownedTimes(synth.owned));
  for (const { source, owned } of runs) {
    expect(owned).toHaveLength(8);
    expect(source.live()).toBe(8);
  }

  const ended = runs.map(({ owned }) => {
    const counter = { count: 0 };
    for (const { event } of owned) event.onEnded(() => counter.count++);
    return counter;
  });
  for (const { sequencer, source } of runs) {
    sequencer.reset();
    expect(Object.values(sequencer.lanes).map((lane) => lane.playhead)).toEqual([null, null]);
    expect(Object.values(sequencer.lanes).map((lane) => lane.progress)).toEqual([null, null]);
    expect(source.live()).toBe(0);
  }
  expect(ended.map(({ count }) => count)).toEqual([8, 8]);
});
