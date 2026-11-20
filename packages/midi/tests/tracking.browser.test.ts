import { afterEach, describe, expect, test, vi } from "vitest";
import { effect } from "@audiorective/core";
import { MidiSequence } from "../src";
import { MidiRecorder } from "../src/web";
import * as recorderSourceModule from "../src/MidiRecorder.ts?raw";
import * as sequenceSourceModule from "../src/MidiSequence.ts?raw";
import { coverageGaps, watch } from "../../../scripts/tracking-coverage.mjs";

const touchedSequence = new Set<string>();
const touchedRecorder = new Set<string>();

afterEach(() => vi.restoreAllMocks());

/** One middle-C note, 480 ticks long, in a format 0 file. */
const smf = new Uint8Array([
  ...[0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, 0x01, 0xe0],
  ...[0x4d, 0x54, 0x72, 0x6b, 0, 0, 0, 13, 0, 0x90, 0x3c, 0x40, 0x83, 0x60, 0x80, 0x3c, 0x40, 0, 0xff, 0x2f, 0],
]);

const note = (id: string) => ({ id, start: 0.1, end: 0.5, pitch: 60, velocity: 90, channel: 0, track: 0 });

/** Reads inside an effect, mutates through the owner's public method, expects a re-run with a new value. */
function expectTracked(read: () => unknown, mutate: () => void) {
  const seen: unknown[] = [];
  const stop = effect(() => void seen.push(read()));
  const first = seen[0];
  mutate();
  stop();
  expect(seen.length).toBeGreaterThan(1);
  expect(Object.is(seen[seen.length - 1], first)).toBe(false);
}

describe("MidiSequence readers are tracked", () => {
  const rows: Array<[string, (s: MidiSequence) => unknown, (s: MidiSequence) => void]> = [
    ["getState() (setData)", (s) => s.getState(), (s) => s.setData({ duration: 2, notes: [note("a")] })],
    ["getState() (updateNote)", (s) => s.getState(), (s) => s.updateNote("n", { pitch: 62 })],
    ["getSelection()", (s) => s.getSelection(), (s) => s.setSelection({ start: 0, end: 1 })],
    ["query()", (s) => s.query({ start: 0, end: 1 }), (s) => s.updateNote("n", { pitch: 64 })],
    ["cells.notes", (s) => s.cells.notes.value, (s) => s.updateNote("n", { start: 0.2 })],
    ["cells.duration", (s) => s.cells.duration.value, (s) => s.setData({ duration: 5, notes: [note("n")] })],
    ["cells.selection", (s) => s.cells.selection.value, (s) => s.setSelection({ start: 0.2, end: 0.8 })],
    ["cells.revision", (s) => s.cells.revision.value, (s) => s.setData({ duration: 1, notes: [note("n")] })],
    ["getState() (load)", (s) => s.getState(), (s) => void s.load(smf)],
    ["cells.notes (load)", (s) => s.cells.notes.value, (s) => void s.load(smf)],
  ];
  test.each(rows)("%s", (_name, read, mutate) => {
    const sequence = watch(new MidiSequence({ duration: 1, notes: [note("n")] }), touchedSequence);
    expectTracked(
      () => read(sequence),
      () => mutate(sequence),
    );
    sequence.dispose();
  });
});

describe("MidiSequence.subscribe", () => {
  test("notifies on change and does not subscribe a calling effect", () => {
    const sequence = watch(new MidiSequence({ duration: 1, notes: [note("n")] }), touchedSequence);
    let notified = 0;
    let runs = 0;
    const stopEffect = effect(() => {
      runs++;
      sequence.subscribe(() => notified++);
    });
    sequence.setData({ duration: 2, notes: [note("m")] });
    stopEffect();
    expect(runs).toBe(1);
    expect(notified).toBeGreaterThan(0);
    sequence.dispose();
  });
});

describe("MidiRecorder readers are tracked", () => {
  test("cells.state follows start, stop and dispose", () => {
    const input = new EventTarget();
    const clock = { state: "running", currentTime: 10, getOutputTimestamp: () => ({ contextTime: 10, performanceTime: 1000 }) };
    vi.spyOn(performance, "now").mockReturnValue(1000);
    const recorder = watch(new MidiRecorder(clock as unknown as AudioContext, input as MIDIInput), touchedRecorder);
    const states: string[] = [];
    const stop = effect(() => void states.push(recorder.cells.state.value));
    recorder.start({ when: 10 });
    vi.spyOn(performance, "now").mockReturnValue(1500);
    recorder.stop();
    vi.spyOn(performance, "now").mockReturnValue(1000);
    recorder.start({ when: 10 });
    recorder.cancel();
    recorder.dispose();
    stop();
    expect(states).toEqual(["idle", "recording", "idle", "recording", "idle", "disposed"]);
  });
});

describe("every public MidiSequence and MidiRecorder member is covered", () => {
  test("MidiSequence", () => {
    expect(coverageGaps(MidiSequence, sequenceSourceModule.default, touchedSequence, {})).toEqual([]);
  });
  test("MidiRecorder", () => {
    expect(coverageGaps(MidiRecorder, recorderSourceModule.default, touchedRecorder, {})).toEqual([]);
  });
});
