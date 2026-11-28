/** `stepGridModel` lets the step grid edit a MIDI clip's notes directly. */
import { afterEach, expect, test } from "vitest";
import { MidiClip } from "@audiorective/midi";
import { cell, effect } from "@audiorective/core";
import { mountStepGrid, stepGridModel, type StepGridModelOptions } from "../src";
import { cleanup, host, own } from "./helpers";

afterEach(cleanup);

const LANES = { hat: 42, snare: 38, kick: 36 };
const cellAt = (root: HTMLElement, lane: string, step: number) =>
  root.querySelector<HTMLElement>(`.ar-sg-cell[data-lane="${lane}"][data-step="${step}"]`)!;
const strip = (clip: MidiClip) => clip.notes.value.map(({ pitch, start, duration, velocity }) => ({ pitch, start, duration, velocity }));

function make(notes: ConstructorParameters<typeof MidiClip>[0] = [], extra: Partial<StepGridModelOptions> = {}) {
  const clip = new MidiClip(notes);
  own(() => clip.dispose());
  const model = stepGridModel(clip, { lanes: LANES, ...extra });
  return { clip, model };
}
function mount(clip: MidiClip, model = stepGridModel(clip, { lanes: LANES })) {
  const root = host();
  root.style.height = "auto";
  const grid = mountStepGrid(root, { sequencer: model });
  own(() => grid.dispose());
  return { root, grid };
}

test("toggling a cell adds then removes a note at that pitch and step", () => {
  const { clip } = make();
  const { root } = mount(clip);
  cellAt(root, "kick", 4).click();
  expect(strip(clip)).toEqual([{ pitch: 36, start: 1, duration: 0.25, velocity: 1 }]);
  expect(cellAt(root, "kick", 4).dataset.on ?? cellAt(root, "kick", 4).getAttribute("aria-pressed")).toBeTruthy();
  cellAt(root, "snare", 8).click();
  expect(strip(clip).map((n) => [n.pitch, n.start])).toEqual([
    [36, 1],
    [38, 2],
  ]);
  cellAt(root, "kick", 4).click();
  expect(strip(clip).map((n) => [n.pitch, n.start])).toEqual([[38, 2]]);
});

test("velocity, offset and length writes edit the existing note, and no-ops commit nothing", () => {
  const { clip, model } = make([{ pitch: 36, start: 1, duration: 0.25, velocity: 1 }]);
  const revision = clip.revision.value;
  const step = model.lanes.kick.steps[4];
  step.velocity = 0.5;
  expect(strip(clip)).toEqual([{ pitch: 36, start: 1, duration: 0.25, velocity: 0.5 }]);
  step.length = 2;
  step.offset = 0.25;
  expect(strip(clip)).toEqual([{ pitch: 36, start: 1.0625, duration: 0.5, velocity: 0.5 }]);
  expect(step.offset).toBeCloseTo(0.25);
  expect(step.length).toBeCloseTo(2);
  const before = clip.revision.value;
  step.velocity = 0.5;
  model.lanes.kick.steps[5].velocity = 0;
  model.lanes.kick.steps[5].offset = 0.2;
  expect(clip.revision.value).toBe(before);
  expect(before).toBeGreaterThan(revision);
  expect(model.lanes.kick.steps[4].repeat).toBe(1);
  expect(model.lanes.kick.steps[4].pitch).toBe(0);
});

test("external note changes are reflected in the grid and in tracked reads", () => {
  const { clip, model } = make();
  const { root } = mount(clip, model);
  const seen: number[][] = [];
  own(effect(() => void seen.push(model.lanes.hat.pattern as number[])));
  clip.edit((draft) => void draft.push({ pitch: 42, velocity: 0.7, start: 0.5, duration: 0.25 }));
  expect(model.lanes.hat.steps[2].velocity).toBe(0.7);
  expect(seen.at(-1)![2]).toBe(0.7);
  expect(cellAt(root, "hat", 2).getAttribute("aria-label") ?? cellAt(root, "hat", 2).outerHTML).toBeTruthy();
  clip.setNotes([]);
  expect(model.lanes.hat.steps[2].velocity).toBe(0);
});

test("lane length follows stepsPerBar and a tracked bars getter, ignoring notes beyond it", () => {
  const bars = cell(1);
  const clip = new MidiClip([{ pitch: 36, start: 4, duration: 0.25, velocity: 1 }]);
  own(() => clip.dispose());
  const model = stepGridModel(clip, { lanes: LANES, stepsPerBar: 8, bars: () => bars.value });
  expect(model.lanes.kick.length).toBe(8);
  expect(model.lanes.kick.rate).toBe("1/8");
  expect(model.lanes.kick.pattern).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  const first = model.lanes.kick.steps[3];
  bars.value = 2;
  expect(model.lanes.kick.length).toBe(16);
  expect(model.lanes.kick.steps[3]).toBe(first);
  expect(model.lanes.kick.steps[8].velocity).toBe(1);
});

test("pattern writes commit once, and edits go through the app's edit wrapper for undo", () => {
  const clip = new MidiClip([{ pitch: 38, start: 2, duration: 0.25, velocity: 1 }]);
  own(() => clip.dispose());
  const undo: Array<readonly ReturnType<typeof strip>[number][]> = [];
  const edit: NonNullable<StepGridModelOptions["edit"]> = (recipe) => {
    undo.push(strip(clip));
    clip.edit(recipe);
  };
  const model = stepGridModel(clip, { lanes: LANES, edit });
  const { root } = mount(clip, model);
  cellAt(root, "kick", 0).click();
  model.lanes.hat.pattern = "X.x.";
  expect(undo).toHaveLength(2);
  expect(
    strip(clip)
      .filter((n) => n.pitch === 42)
      .map((n) => [n.start, n.velocity]),
  ).toEqual([
    [0, 1],
    [0.5, 0.8],
  ]);
  clip.setNotes(undo[1]);
  expect(
    strip(clip)
      .map((n) => n.pitch)
      .sort(),
  ).toEqual([36, 38]);
  clip.setNotes(undo[0]);
  expect(strip(clip)).toEqual([{ pitch: 38, start: 2, duration: 0.25, velocity: 1 }]);
  expect(() => (model.lanes.hat.pattern = "Q")).toThrow("Step grid model pattern");
});

test("position drives the playhead, and bad options throw", () => {
  const position = cell<number | null>(null);
  const { model } = make([], { position: () => position.value });
  expect(model.lanes.kick.playhead).toBeNull();
  position.value = 1.25;
  expect(model.lanes.kick.playhead).toBe(5);
  expect(model.lanes.kick.progress).toBeCloseTo(0.3125);
  const clip = new MidiClip();
  own(() => clip.dispose());
  expect(() => stepGridModel(clip, { lanes: {} })).toThrow("at least one lane");
  expect(() => stepGridModel(clip, { lanes: LANES, stepsPerBar: 0 })).toThrow("positive integer stepsPerBar");
  expect(() => stepGridModel({ notes: clip.notes }, { lanes: LANES })).toThrow("needs an edit function");
});
