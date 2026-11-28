/** `pianoRollModel` follows a MidiClip, owns its selection and notifies once per commit. */
import { afterEach, expect, test, vi } from "vitest";
import { cell, effect } from "@audiorective/core";
import { MidiClip } from "@audiorective/midi";
import { pianoRollModel } from "../src/piano-roll";

const note = (id: string, start: number, duration: number) => ({ id, start, duration, pitch: 60, velocity: 0.8 });
const disposers: Array<() => void> = [];
function make(notes = [note("a", 0, 1)], options?: Parameters<typeof pianoRollModel>[1]) {
  const clip = new MidiClip(notes);
  const model = pianoRollModel(clip, options);
  disposers.push(() => {
    model.dispose();
    clip.dispose();
  });
  return { clip, model };
}
afterEach(() => {
  for (const fn of disposers.splice(0)) fn();
});

test("notes follow the clip and the snapshot is frozen and stable until something changes", () => {
  const { clip, model } = make();
  const first = model.getState();
  expect(Object.isFrozen(first)).toBe(true);
  expect(model.getState()).toBe(first);
  expect(first.notes).toBe(clip.notes.value);
  clip.edit((draft) => void (draft[0].pitch = 62));
  const second = model.getState();
  expect(second).not.toBe(first);
  expect(second.notes).toBe(clip.notes.value);
  expect(model.getState()).toBe(second);
  model.setSelection({ start: 0, end: 1 });
  const third = model.getState();
  expect(third).not.toBe(second);
  expect(third.notes).toBe(second.notes);
  expect(third.selection).toEqual({ start: 0, end: 1 });
});

test("duration defaults to the last note end rounded up to a 4-beat bar, at least 4", () => {
  const { clip, model } = make([]);
  expect(model.getState().duration).toBe(4);
  clip.setNotes([note("a", 3, 1)]);
  expect(model.getState().duration).toBe(4);
  clip.setNotes([note("a", 3, 1.5)]);
  expect(model.getState().duration).toBe(8);
  clip.setNotes([note("a", 8, 4)]);
  expect(model.getState().duration).toBe(12);
});

test("duration accepts a number or a getter that getState reads untracked and subscribe tracks", () => {
  expect(make([], { duration: 16 }).model.getState().duration).toBe(16);
  const length = cell(6);
  const { model } = make([], { duration: () => length.value });
  const reads: number[] = [];
  const stop = effect(() => void reads.push(model.getState().duration));
  length.value = 9;
  stop();
  expect(reads).toEqual([6]);
  expect(model.getState().duration).toBe(9);
  const heard = vi.fn();
  model.subscribe(heard);
  length.value = 12;
  expect(heard).toHaveBeenCalledTimes(1);
});

test("the selection is the model's own cell and nothing clears it", () => {
  const { clip, model } = make();
  model.selection.value = { start: 1, end: 2 };
  expect(model.getSelection()).toEqual({ start: 1, end: 2 });
  model.setSelection({ start: 0, end: 3 });
  expect(model.selection.value).toEqual({ start: 0, end: 3 });
  clip.setNotes([]);
  expect(model.getSelection()).toEqual({ start: 0, end: 3 });
  model.setSelection(null);
  expect(model.selection.value).toBeNull();
});

test("subscribe is not called initially, runs once per commit and stops on unsubscribe and dispose", () => {
  const { clip, model } = make();
  const heard = vi.fn(() => model.getState());
  const off = model.subscribe(heard);
  expect(heard).not.toHaveBeenCalled();
  clip.edit((draft) => void draft.push({ id: "b", pitch: 64, velocity: 1, start: 1, duration: 1, channel: 0 }));
  expect(heard).toHaveBeenCalledTimes(1);
  model.setSelection({ start: 0, end: 1 });
  expect(heard).toHaveBeenCalledTimes(2);
  off();
  clip.setNotes([]);
  expect(heard).toHaveBeenCalledTimes(2);
  const other = vi.fn();
  model.subscribe(other);
  model.dispose();
  clip.setNotes([note("c", 0, 1)]);
  expect(other).not.toHaveBeenCalled();
  expect(model.subscribe(other)).toBeTypeOf("function");
});

test("readers are tracked by effects", () => {
  const { clip, model } = make();
  const seen: unknown[] = [];
  const stop = effect(() => void seen.push(model.getState(), model.getSelection()));
  clip.setNotes([note("z", 2, 1)]);
  model.setSelection({ start: 0, end: 1 });
  stop();
  expect(seen.length).toBeGreaterThanOrEqual(6);
});

test("a window is reported in beats, follows a getter, and is absent by default", () => {
  const plain = make();
  expect(plain.model.getState()).not.toHaveProperty("window");
  let played: { start: number; end: number } | null = { start: 4, end: 8 };
  const { model } = make([note("a", 0, 1)], { duration: 16, window: () => played });
  const first = model.getState();
  expect(first.window).toEqual({ start: 4, end: 8 });
  expect(model.getState()).toBe(first);
  played = { start: 8, end: 12 };
  expect(model.getState().window).toEqual({ start: 8, end: 12 });
  played = null;
  expect(model.getState()).not.toHaveProperty("window");
});
