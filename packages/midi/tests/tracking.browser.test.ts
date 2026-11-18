import { afterEach, describe, expect, test, vi } from "vitest";
import { effect } from "@audiorective/core";
import { MidiSequence } from "../src";
import { MidiRecorder } from "../src/web";

afterEach(() => vi.restoreAllMocks());

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
  ];
  test.each(rows)("%s", (_name, read, mutate) => {
    const sequence = new MidiSequence({ duration: 1, notes: [note("n")] });
    expectTracked(
      () => read(sequence),
      () => mutate(sequence),
    );
    sequence.destroy();
  });
});

describe("MidiRecorder readers are tracked", () => {
  test("cells.state follows start, stop and destroy", () => {
    const input = new EventTarget();
    const clock = { state: "running", currentTime: 10, getOutputTimestamp: () => ({ contextTime: 10, performanceTime: 1000 }) };
    vi.spyOn(performance, "now").mockReturnValue(1000);
    const recorder = new MidiRecorder(clock as unknown as AudioContext, input as MIDIInput);
    const states: string[] = [];
    const stop = effect(() => void states.push(recorder.cells.state.value));
    recorder.start({ when: 10 });
    recorder.cancel();
    recorder.destroy();
    stop();
    expect(states).toEqual(["idle", "recording", "idle", "destroyed"]);
  });
});
