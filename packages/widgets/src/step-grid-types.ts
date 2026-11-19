import type { Readable } from "@audiorective/core";
import type { PluginTarget, Unsubscribe, WidgetPlugin, WidgetPluginContext } from "./types";

export type StepGridRate = "1/2" | "1/4" | "1/8" | "1/16" | "1/32" | "1/64" | "1/2T" | "1/4T" | "1/8T" | "1/16T" | "1/32T" | "1/64T";
export type StepGridDirection = "forward" | "backward" | "bounce";

/** The values the grid reads from one step. `custom` carries one number per declared param. */
export type StepGridCell = Readonly<{
  velocity: number;
  offset: number;
  length: number;
  repeat: number;
  pitch: number;
  chance: number;
  custom?: Readonly<Record<string, number>>;
}>;

export type StepGridLane = Readonly<{
  id: string;
  label: string;
  steps: number;
  rate: StepGridRate;
  direction: StepGridDirection;
  /** 0..1, shown as a percentage. */
  swing: number;
  mute: boolean;
  solo: boolean;
  /** One entry per pattern step; entries beyond `steps` are shown dimmed. */
  cells: readonly StepGridCell[];
}>;

export type StepGridPattern = Readonly<{ size: number; lanes: readonly StepGridLane[] }>;

/** A caller-defined per-step number; the grid shows it as an extra tab. */
export type StepGridParamSpec = Readonly<{ id: string; label?: string; min: number; max: number; default: number; step?: number }>;

export type StepGridCellPatch = Partial<Omit<StepGridCell, "custom">> & { custom?: Readonly<Record<string, number>> };
export type StepGridLanePatch = Partial<Omit<StepGridLane, "id" | "cells">>;

/** What the grid reads and drives. A `StepSequencer` satisfies it, and so can any model with these members. */
export interface StepGridSequencer {
  readonly pattern: Readable<StepGridPattern>;
  readonly playheads: Readable<Readonly<Record<string, number | null>>>;
  readonly loopProgress: Readable<number | null>;
  /** Custom per-step parameters, shown as tabs after the built-in ones. */
  readonly params?: readonly StepGridParamSpec[];
  /** Ranges for the built-in cell values, matched by id (`velocity`, `offset`, `length`, `repeat`, `pitch`, `chance`). Absent ids keep the built-in range. */
  readonly cellParams?: readonly StepGridParamSpec[];
  /** The rates offered in each lane's Rate picker. Defaults to the twelve straight and triplet rates. */
  readonly rates?: readonly StepGridRate[];
  setCell(laneId: string, step: number, patch: StepGridCellPatch): void;
  toggle(laneId: string, step: number): void;
  setLane(laneId: string, patch: StepGridLanePatch): void;
}

/** User-facing strings; each key overrides the English default. */
export type StepGridLabels = {
  grid: string;
  velocity: string;
  offset: string;
  length: string;
  repeat: string;
  pitch: string;
  chance: string;
  fold: string;
  mute: string;
  solo: string;
  steps: string;
  rate: string;
  direction: string;
  swing: string;
  /** Short caption of the direction column. */
  dir: string;
};

export type StepGridOptions = {
  sequencer: StepGridSequencer;
  /** Accessible name of one step, for example `Kick step 3`. */
  formatStep?(label: string, step: number): string;
  labels?: Partial<StepGridLabels>;
};

/** The built-in cell values the tabs edit. Custom params use their declared `id`. */
export type StepGridBuiltInParameter = "velocity" | "offset" | "length" | "repeat" | "pitch" | "chance";

/** Resources registered by a step grid plugin are released when its attachment is destroyed. */
export interface StepGridPluginContext extends WidgetPluginContext {
  /** The positioned element holding the lanes. Overlays are mounted inside it. */
  readonly surface: HTMLElement;
  /** The sequencer the grid reads and drives; plugins write cells through it. */
  readonly sequencer: StepGridSequencer;
  /** The step's element, or `null` for an unknown lane or step. */
  cellElement(laneId: string, step: number): HTMLElement | null;
  /** The step's box in CSS pixels relative to `surface`, or `null` for an unknown lane or step. */
  cellRect(laneId: string, step: number): Readonly<{ x: number; y: number; width: number; height: number }> | null;
  /** Mount a full-surface overlay; position children with `cellRect()`. */
  mountOverlay(element: HTMLElement): Unsubscribe;
  /** Add an element to the toolbar strip next to the parameter tabs. */
  addToolbarItem(element: HTMLElement): Unsubscribe;
  /** The id of the parameter tab being shown and edited. */
  readonly activeParameter: Readable<string>;
  /** Select a tab by id: a built-in parameter or a declared custom param. Throws for an unknown id. */
  setActiveParameter(id: string): void;
  /** Called after the grid has updated for each pattern change. */
  onPatternChange(listener: (pattern: StepGridPattern) => void): Unsubscribe;
}

export type StepGridPlugin = WidgetPlugin<StepGridPluginContext>;

export interface StepGridHandle extends PluginTarget<StepGridPluginContext> {
  destroy(): void;
}
