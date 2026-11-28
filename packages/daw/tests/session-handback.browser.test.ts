import { ManualTickSource } from "@audiorective/clock";
import type { SoundFactory } from "@audiorective/core";
import { afterEach, describe, expect, test, vi } from "vitest";
import { Project, Workspace } from "../src";
import { SamplerSink } from "../src/midi-sink";
import { fillSession } from "./session-slots";

/** A track that returns from a Session clip to the Arrangement is brought to the controller state the Arrangement needs at that position. */
const RATE = 48_000;
const QUANTUM = 128;
const worklet = "/@fs" + new URL("../../host/dist/webclap-worklet.js", import.meta.url).pathname.replace(/^\/@fs/, "");
afterEach(() => vi.restoreAllMocks());

const click: SoundFactory = (context) => {
  const osc = new OscillatorNode(context, { frequency: 1000 });
  const gain = new GainNode(context, { gain: 0.5 });
  osc.connect(gain);
  return { output: gain, sources: [osc], duration: 0.02 };
};

type Message = { data: number[]; when: number };

/** 120 BPM: the Arrangement sets CC7 = 60 at beat 0; a Session clip sets CC7 = 110 at launch (0.6 s). */
async function run(stopAt: number | "one-shot", seconds: number) {
  const sent: Message[] = [];
  const original = SamplerSink.prototype.scheduleMidi;
  vi.spyOn(SamplerSink.prototype, "scheduleMidi").mockImplementation(function (this: SamplerSink, data, when) {
    sent.push({ data: [...data], when });
    return original.call(this, data, when);
  });
  const project = new Project({ bpm: 120 });
  const track = project.addTrack("Keys", "midi");
  project.addMidiClip(track.id, { duration: 8, notes: [], events: [{ time: 0, data: Uint8Array.of(0xb0, 7, 60) }] }, 0);
  fillSession(project, track.id, [{ duration: 1, notes: [], events: [{ time: 0, data: Uint8Array.of(0xb0, 7, 110) }] }]);
  const frames = Math.round(seconds * RATE);
  const context = new OfflineAudioContext(2, frames, RATE);
  const ticks = new ManualTickSource();
  const workspace = await Workspace.create(context as unknown as AudioContext, project, {
    destination: context.destination,
    tickSource: ticks,
    workletUrl: worklet,
    instruments: { [track.id]: { sound: click } },
  });
  const slot = () => workspace.cells.session.value.tracks[track.id]!.clips[0]!;
  if (stopAt === "one-shot") slot().configure({ loop: false });
  const actions: Array<{ at: number; run: () => void }> = [{ at: 0.6, run: () => slot().launch({ quantize: "none" }) }];
  if (stopAt !== "one-shot") actions.push({ at: stopAt, run: () => workspace.cells.session.value.tracks[track.id]!.stop({ quantize: "none" }) });
  await workspace.play();
  ticks.tick();
  await workspace.renderSettled();
  let index = 1;
  let previous = 0;
  const next = () => {
    previous = Math.max(Math.ceil((index++ * 0.025 * RATE) / QUANTUM) * QUANTUM, previous + QUANTUM);
    return previous < frames ? previous : undefined;
  };
  let stop = next();
  let suspended = stop === undefined ? undefined : context.suspend((stop - QUANTUM / 2) / RATE);
  const rendering = context.startRendering();
  while (stop !== undefined && suspended) {
    await suspended;
    while (actions.length && actions[0]!.at <= stop / RATE) actions.shift()!.run();
    ticks.tick();
    await workspace.renderSettled();
    stop = next();
    suspended = stop === undefined ? undefined : context.suspend((stop - QUANTUM / 2) / RATE);
    await context.resume();
  }
  await rendering;
  workspace.dispose();
  project.dispose();
  return sent.filter(({ data }) => data[0] === 0xb0 && data[1] === 7);
}

describe("a Session clip handing the track back chases the Arrangement", () => {
  test("a stop sends the Arrangement's CC7 at the hand-back, and the Session clip's rest value does not follow it", async () => {
    const volume = await run(1.0, 1.6);
    expect(volume.some(({ data, when }) => data[2] === 60 && when > 0.9 && when < 1.05)).toBe(true);
    expect(volume.some(({ data }) => data[2] === 100)).toBe(false);
  }, 60_000);

  test("the end of a one-shot sends it at the end", async () => {
    const volume = await run("one-shot", 2.4);
    expect(volume.some(({ data, when }) => data[2] === 60 && when > 1.0 && when < 1.2)).toBe(true);
    expect(volume.some(({ data }) => data[2] === 100)).toBe(false);
  }, 60_000);
});
