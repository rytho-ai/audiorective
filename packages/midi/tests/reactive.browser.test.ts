import { afterEach, expect, expectTypeOf, test, vi } from "vitest";
import { effect, type Readable } from "@audiorective/core";
import { MidiSequence, type MidiSequenceState, type MidiNote } from "../src";

const disposers: Array<() => void | Promise<unknown>> = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0).reverse()) await dispose();
  vi.restoreAllMocks();
});
function watch<T>(source: Readable<T>) {
  const seen: T[] = [];
  const stop = effect(() => {
    seen.push(source.value);
  });
  disposers.push(stop);
  return seen;
}

const note = (id: string, start: number, end: number): MidiNote => ({ id, start, end, pitch: 60, velocity: 90, channel: 0, track: 0 });
function midi() {
  const m = new MidiSequence({ duration: 4, notes: [note("a", 0, 1), note("b", 1, 2)] });
  disposers.push(() => m.destroy());
  return m;
}

test("every MidiSequence cell re-runs an effect through the owner's methods, without subscribe", () => {
  const m = midi();
  const r = m.cells;
  const notes = watch(r.notes);
  const duration = watch(r.duration);
  const selection = watch(r.selection);
  const revision = watch(r.revision);
  const state = watch(r.state);

  m.setSelection({ start: 1, end: 2 });
  expect(selection.at(-1)).toEqual({ start: 1, end: 2 });
  expect(notes).toHaveLength(1); // a selection change leaves the notes slice quiet
  expect(duration).toHaveLength(1);

  m.updateNote("a", { end: 5 });
  expect(duration.at(-1)).toBe(5);
  expect(notes).toHaveLength(2);
  expect(notes.at(-1)?.[0].end).toBe(5);

  m.setData({ duration: 3, notes: [note("c", 0, 3)] });
  expect(notes.at(-1)?.map((n) => n.id)).toEqual(["c"]);
  expect(selection.at(-1)).toBeNull();
  expect(revision.at(-1)).toBe(m.getState().revision);
  expect(state.at(-1)).toBe(m.getState());
});

test("MidiSequence commits are atomic and subscribe keeps its semantics", () => {
  const m = midi();
  const runs: Array<{ state: MidiSequenceState; notes: readonly MidiNote[]; selection: unknown; revision: number; duration: number }> = [];
  disposers.push(
    effect(() => {
      runs.push({
        state: m.cells.state.value,
        notes: m.cells.notes.value,
        selection: m.cells.selection.value,
        revision: m.cells.revision.value,
        duration: m.cells.duration.value,
      });
    }),
  );
  m.setSelection({ start: 0, end: 1 });
  runs.length = 0;
  const listener = vi.fn();
  const bad = vi.fn(() => {
    throw new Error("listener");
  });
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  disposers.push(m.subscribe(bad), m.subscribe(listener));
  expect(listener).not.toHaveBeenCalled();

  m.setData({ duration: 2, notes: [note("z", 0, 2)] });
  expect(runs).toHaveLength(1);
  expect(runs[0]).toMatchObject({ selection: null, duration: 2, revision: m.getState().revision });
  expect(runs[0].notes.map((n) => n.id)).toEqual(["z"]);
  expect(runs[0].state).toBe(m.getState());
  expect(listener).toHaveBeenCalledTimes(1);
  expect(log).toHaveBeenCalled();

  expect(() => m.setSelection({ start: 0, end: 99 })).toThrow(RangeError);
  expect(runs).toHaveLength(1);

  expectTypeOf(m.cells.notes).toExtend<Readable<readonly MidiNote[]>>();
  // @ts-expect-error read-only: no setter on `.value`
  expect(() => (m.cells.notes.value = [])).toThrow(TypeError);
  // @ts-expect-error read-only: `$` takes no argument
  m.cells.selection.$({ start: 0, end: 1 });
  expect(m.cells.selection.value).toBeNull();
});

test("MidiSequence owner methods called inside an effect do not subscribe it", () => {
  const m = midi();
  let midiRuns = 0;
  disposers.push(
    effect(() => {
      midiRuns++;
      m.setSelection({ start: 0, end: 1 });
      m.updateNote("a", { end: 1.5 });
      m.setData({ duration: 4, notes: [note("a", 0, 1)] });
    }),
  );
  m.setSelection(null);
  m.updateNote("a", { end: 2 });
  expect(midiRuns).toBe(1);
});

test("MidiSequence public readers are tracked", () => {
  const m = midi();
  const seen: MidiSequenceState[] = [];
  const picked: unknown[] = [];
  const queried: number[] = [];
  disposers.push(
    effect(() => {
      seen.push(m.getState());
    }),
    effect(() => {
      picked.push(m.getSelection());
    }),
    effect(() => {
      queried.push(m.query({ start: 0, end: 4 }).length);
    }),
  );
  m.setSelection({ start: 0, end: 1 });
  expect(seen.at(-1)?.selection).toEqual({ start: 0, end: 1 });
  expect(picked.at(-1)).toEqual({ start: 0, end: 1 });
  m.setData({ duration: 4, notes: [note("z", 0, 1)] });
  expect(queried.at(-1)).toBe(1);
});

test("MidiSequence listener reading state is notified once per operation", () => {
  const m = midi();
  const midiListener = vi.fn(() => {
    m.getState();
  });
  disposers.push(m.subscribe(midiListener));
  m.setSelection({ start: 0, end: 1 });
  m.updateNote("a", { end: 1.5 });
  expect(midiListener).toHaveBeenCalledTimes(2);
});
