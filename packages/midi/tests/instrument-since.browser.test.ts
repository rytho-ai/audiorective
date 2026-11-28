import { afterEach, expect, test } from "vitest";
import { Clock, ManualTickSource } from "@audiorective/clock";
import { MidiClip, type Instrument } from "../src";
import { driveOffline } from "./offline";

const SR = 8000;
type Voice = { pitch: number; on: number; off?: number };

/** An instrument that tracks its voices the way `since` asks: a release ends the latest voice that began at or before it. */
function voiceTracker() {
  const releases: Array<{ pitch: number; when: number; since: number | undefined }> = [];
  const voices: Voice[] = [];
  const inst: Instrument = {
    noteOn(pitch, options) {
      voices.push({ pitch, on: options?.when ?? 0 });
    },
    noteOff(pitch, when = 0, since) {
      releases.push({ pitch, when, since });
      // The voice this release answers: the latest one that began at or before `since` and still sounds.
      const answered = voices
        .filter((voice) => voice.pitch === pitch && voice.off === undefined && (since === undefined || voice.on <= since))
        .at(-1);
      if (answered) answered.off = when;
    },
  };
  return { inst, voices, releases };
}

const disposers: Array<() => void> = [];
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
});
function rig(seconds: number) {
  const ctx = new OfflineAudioContext(1, Math.round(seconds * SR), SR);
  const ticks = new ManualTickSource();
  const clock = new Clock({ context: ctx, tickSource: ticks, bpm: 120, lookAhead: 0.1 });
  disposers.push(() => clock.dispose());
  return { clock, run: () => driveOffline(ctx, ticks, [], () => clock.start()) };
}
const clip = (inst: Instrument, notes: Array<{ start: number; duration: number }>, extra: { loop?: boolean; length?: string } = {}) => {
  const made = new MidiClip(
    notes.map((n) => ({ pitch: 60, velocity: 1, ...n })),
    { instrument: inst, ...extra },
  );
  disposers.push(() => made.dispose());
  return made;
};

test("a note-off carries the start time of the note-on it answers", async () => {
  const { clock, run } = rig(3);
  const { inst, voices, releases } = voiceTracker();
  clock.attach(
    clip(inst, [
      { start: 0, duration: 1 },
      { start: 2, duration: 1 },
    ]),
  );
  await run();
  expect(voices.map((v) => v.on)).toEqual([0, 1]);
  expect(releases.map((r) => [r.when, r.since])).toEqual([
    [0.5, 0],
    [1.5, 1],
  ]);
});

test("a release that ends a loop pass names the note-on of that pass, not the first one", async () => {
  const { clock, run } = rig(3.2);
  const { inst, releases } = voiceTracker();
  clock.attach(clip(inst, [{ start: 0, duration: 6 }], { loop: true, length: "1m" }));
  await run();
  // The 6-beat note is cut at each seam (2 s apart): the release at 2 s answers the note-on at 0, the release at 4 s the one at 2 s.
  expect(releases.filter((r) => r.when <= 2.01).map((r) => [r.when, r.since])).toEqual([[2, 0]]);
});

test("two clips sounding one pitch on one instrument release only their own voice", async () => {
  const { clock, run } = rig(3);
  const { inst, voices, releases } = voiceTracker();
  // The first clip holds pitch 60 from 0 to 1.5 s (beats 0 to 3); the second starts the same pitch at 0.5 s and holds it to 1 s.
  clock.attach(clip(inst, [{ start: 0, duration: 3 }]));
  clock.attach(clip(inst, [{ start: 1, duration: 1 }]));
  await run();
  expect(releases.map((r) => [r.when, r.since]).sort()).toEqual([
    [1, 0.5],
    [1.5, 0],
  ]);
  // The second clip's release at 1 s ends only the voice that began at 0.5 s, so the first clip's voice sounds until its own release.
  expect(voices.map((v) => [v.on, v.off])).toEqual([
    [0, 1.5],
    [0.5, 1],
  ]);
});
