/** A `StepGridSequencer` over the notes of a MIDI clip: one lane per pitch, one step per grid slot. No DOM.
 * Reads: @audiorective/midi note types, core cells.
 */
import { cell, untracked, type Cell, type Readable } from "@audiorective/core";
import type { MidiNote, NoteDraft } from "@audiorective/midi";
import type { StepGridLane, StepGridSequencer, StepGridStep } from "./step-grid-types";

/** The notes a step grid edits: any object with tracked `notes` and the edit methods below, such as a `MidiClip` from `@audiorective/midi`. */
export interface StepGridNoteSource {
  /** Tracked notes; external changes redraw the grid. */
  readonly notes: Readable<readonly MidiNote[]>;
  /** Commits one change to the notes. Used when `options.edit` is not given. */
  edit?(recipe: (draft: NoteDraft) => void): void;
}

export interface StepGridModelOptions {
  /** Lane name to MIDI pitch (0..127), top to bottom in key order: `{ hat: 42, snare: 38, kick: 36 }`. */
  lanes: Readonly<Record<string, number>>;
  /** Steps in one bar. Default 16. */
  stepsPerBar?: number;
  /** Bars the grid shows, or a tracked getter for them. Default 1. The lane length is `stepsPerBar * bars`. */
  bars?: number | (() => number);
  /** Quarter-note beats in a bar (`numerator * 4 / denominator`). Default 4. */
  beatsPerBar?: number;
  /** Length in beats of a note the grid adds. Default: one step. */
  noteLength?: number;
  /** Commits a note change. Pass the app's edit wrapper so one grid edit is one Undo step: `(recipe) => history.record("Edit pattern", () => clip.midi.edit(recipe))`. Default: `source.edit`. */
  edit?(recipe: (draft: NoteDraft) => void): void;
  /** Tracked position in beats from the clip's start, or null while stopped; drives each lane's `playhead` and `progress`. */
  position?(): number | null;
}

/** What `stepGridModel` returns: pass it as `mountStepGrid(root, { sequencer })`. */
export type StepGridModel = StepGridSequencer;

const MIN_LENGTH = 1 / 16;
const MAX_LENGTH = 4;
const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

function parseVelocities(pattern: string | readonly number[]): number[] {
  const bad = () => new RangeError("Step grid model pattern needs X, x, 1-9 or . characters, or velocities from 0 to 1.");
  if (typeof pattern !== "string") {
    if (!Array.isArray(pattern) || pattern.some((value) => typeof value !== "number" || !(value >= 0 && value <= 1))) throw bad();
    return [...pattern];
  }
  const out: number[] = [];
  for (const char of pattern) {
    if (/\s/.test(char)) continue;
    if (char === "X") out.push(1);
    else if (char === "x") out.push(0.8);
    else if (char === "." || char === "0") out.push(0);
    else if (char >= "1" && char <= "9") out.push(Number(char) / 10);
    else throw bad();
  }
  return out;
}

/**
 * Edit a MIDI clip's notes with the step grid: `mountStepGrid(root, { sequencer: stepGridModel(clip.midi, { lanes: { kick: 36 } }) })`.
 * A step is the note of the lane's pitch nearest that grid slot: velocity 0 means no note, setting a velocity adds or updates it, and offset and length edit its start and duration.
 * Repeat, pitch and chance have no MIDI counterpart: they read as 1, 0 and 1 and ignore writes. Each write is one `edit` commit, so an app wrapper gets one Undo step per grid edit.
 */
export function stepGridModel(source: StepGridNoteSource, options: StepGridModelOptions): StepGridModel {
  const entries = Object.entries(options.lanes ?? {});
  if (entries.length === 0 || entries.some(([, pitch]) => !Number.isInteger(pitch) || pitch < 0 || pitch > 127))
    throw new RangeError("Step grid model needs at least one lane with a MIDI pitch from 0 to 127.");
  const stepsPerBar = options.stepsPerBar ?? 16;
  const beatsPerBar = options.beatsPerBar ?? 4;
  const barsOf = (): number => (typeof options.bars === "function" ? options.bars() : (options.bars ?? 1));
  const bars = untracked(barsOf);
  if (!Number.isInteger(stepsPerBar) || stepsPerBar <= 0 || !Number.isInteger(bars) || bars <= 0 || !Number.isFinite(beatsPerBar) || beatsPerBar <= 0)
    throw new RangeError("Step grid model needs a positive integer stepsPerBar and bars, and a positive beatsPerBar.");
  const edit = options.edit ?? (source.edit ? source.edit.bind(source) : undefined);
  if (!edit) throw new TypeError("Step grid model needs an edit function or a source with edit().");

  const stepBeats = beatsPerBar / stepsPerBar;
  const noteLength = options.noteLength ?? stepBeats;
  const lengthOf = () => stepsPerBar * Math.max(1, Math.floor(barsOf()) || 1);
  const rate = Number.isInteger(4 / stepBeats) ? `1/${4 / stepBeats}` : String(stepBeats);

  /** The notes of one slot, lowest start first. */
  const slot = <T extends { pitch: number; start: number }>(notes: readonly T[], pitch: number, index: number): T[] =>
    notes.filter((note) => note.pitch === pitch && Math.round(note.start / stepBeats) === index).sort((a, b) => a.start - b.start);

  function write(pitch: number, index: number, change: (notes: NoteDraft, here: NoteDraft[number][]) => void): void {
    edit!((draft) => change(draft, slot(draft, pitch, index)));
  }
  function setVelocity(draft: NoteDraft, here: NoteDraft[number][], pitch: number, index: number, velocity: number): void {
    if (velocity <= 0) {
      for (const note of here) draft.splice(draft.indexOf(note), 1);
    } else if (here.length > 0) here[0].velocity = velocity;
    else draft.push({ pitch, velocity, start: index * stepBeats, duration: noteLength });
  }

  const laneViews = new Map<string, StepGridLane>();
  for (const [id, pitch] of entries) {
    const muted: Cell<boolean> = cell(false);
    const solo: Cell<boolean> = cell(false);
    let steps: StepGridStep[] = [];
    const first = (index: number) => slot(source.notes.value, pitch, index)[0];
    const makeStep = (index: number): StepGridStep => ({
      get velocity() {
        return first(index)?.velocity ?? 0;
      },
      set velocity(value: number) {
        const next = clamp(Number.isFinite(value) ? value : 0, 0, 1);
        const current = untracked(() => first(index));
        if ((current?.velocity ?? 0) === next || (!current && next <= 0)) return;
        write(pitch, index, (draft, here) => setVelocity(draft, here, pitch, index, next));
      },
      get offset() {
        const note = first(index);
        return note ? clamp(note.start / stepBeats - index, -0.5, 0.5) : 0;
      },
      set offset(value: number) {
        const note = untracked(() => first(index));
        if (!note || !Number.isFinite(value)) return;
        const start = Math.max(0, (index + clamp(value, -0.5, 0.5)) * stepBeats);
        if (start === note.start) return;
        write(pitch, index, (_, here) => {
          if (here[0]) here[0].start = start;
        });
      },
      get length() {
        const note = first(index);
        return note ? clamp(note.duration / stepBeats, MIN_LENGTH, MAX_LENGTH) : noteLength / stepBeats;
      },
      set length(value: number) {
        const note = untracked(() => first(index));
        if (!note || !Number.isFinite(value)) return;
        const duration = clamp(value, MIN_LENGTH, MAX_LENGTH) * stepBeats;
        if (duration === note.duration) return;
        write(pitch, index, (_, here) => {
          if (here[0]) here[0].duration = duration;
        });
      },
      get repeat() {
        return 1;
      },
      set repeat(_value: number) {},
      get pitch() {
        return 0;
      },
      set pitch(_value: number) {},
      get chance() {
        return 1;
      },
      set chance(_value: number) {},
      values: Object.freeze({}),
    });
    const stepList = (): readonly StepGridStep[] => {
      const length = lengthOf();
      if (steps.length !== length) steps = Array.from({ length }, (_, index) => steps[index] ?? makeStep(index));
      return steps;
    };
    const lane: StepGridLane = {
      get length() {
        return lengthOf();
      },
      set length(_value: number) {},
      get pattern() {
        return stepList().map((step) => step.velocity);
      },
      set pattern(value: string | readonly number[]) {
        const velocities = parseVelocities(value);
        const length = untracked(lengthOf);
        edit((draft) => {
          for (let index = 0; index < length && index < velocities.length; index++)
            setVelocity(draft, slot(draft, pitch, index), pitch, index, clamp(velocities[index], 0, 1));
        });
      },
      get rate() {
        return rate;
      },
      set rate(_value: string | number) {},
      get swing() {
        return 0;
      },
      set swing(_value: number) {},
      get direction() {
        return "forward" as const;
      },
      set direction(_value) {},
      get muted() {
        return muted.value;
      },
      set muted(value: boolean) {
        muted.value = !!value;
      },
      get solo() {
        return solo.value;
      },
      set solo(value: boolean) {
        solo.value = !!value;
      },
      params: Object.freeze({}),
      get playhead() {
        const beat = options.position?.() ?? null;
        return beat === null || !Number.isFinite(beat) || beat < 0 ? null : Math.floor(beat / stepBeats) % lengthOf();
      },
      get progress() {
        const beat = options.position?.() ?? null;
        return beat === null || !Number.isFinite(beat) || beat < 0 ? null : (beat / (lengthOf() * stepBeats)) % 1;
      },
      get steps() {
        return stepList();
      },
    };
    laneViews.set(id, lane);
  }
  return { lanes: Object.freeze(Object.fromEntries(laneViews)) };
}
