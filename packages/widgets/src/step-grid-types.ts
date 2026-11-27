import type { ParamRange, ParamSpec, Readable } from "@audiorective/core";
import type { PluginTarget, Unsubscribe, WidgetPlugin, WidgetPluginContext } from "./types";

export type StepGridRate = "1/2" | "1/4" | "1/8" | "1/16" | "1/32" | "1/64" | "1/2T" | "1/4T" | "1/8T" | "1/16T" | "1/32T" | "1/64T";
export type StepGridDirection = "forward" | "backward" | "bounce";

/** A caller-defined per-step number; the grid shows it as an extra tab. */
export type StepGridParamSpec = ParamSpec;

/** One step of a lane: the six built-in values plus the lane's custom per-step values. Writes take effect on the sequencer at once. */
export interface StepGridStep {
  /** 0..1; 0 is a rest. */
  velocity: number;
  /** -0.5..0.5 of one lane step. */
  offset: number;
  /** 1/16..4 lane steps. */
  length: number;
  /** Integer 1..8. */
  repeat: number;
  /** Integer semitones -24..24. */
  pitch: number;
  /** 0..1. */
  chance: number;
  /** One number per param the lane declares. */
  readonly values: Record<string, number>;
}

/** What the grid reads and writes of one lane. Every read is tracked by core effects. */
export interface StepGridLane {
  /** Steps this lane loops over; assigning it resizes the lane. */
  length: number;
  /** The lane's velocities as text ("X.x.") or one number per step; assigning sets the length too. Plugins write whole patterns through it. */
  pattern: string | readonly number[];
  /** A rate such as "1/16" or "1/8T" (a `StepRate`), or any other value the model accepts (shown as is). */
  rate: string | number;
  /** 0..1, shown as a percentage: delays every odd step by that share of half a step. */
  swing: number;
  /** Playback traversal order; forwarded to the borrowed lane without changing step data. */
  direction: StepGridDirection;
  /** Whether this lane is silenced; step content remains intact. */
  muted: boolean;
  /** Whether this lane participates in solo playback; step content remains intact. */
  solo: boolean;
  /** Custom per-step numbers this lane declares, by id; they become tabs after the built-in ones. */
  readonly params: Readonly<Record<string, ParamRange>>;
  /** The step the transport is on, or `null` while stopped. */
  readonly playhead: number | null;
  /** 0..1 through the lane's loop, or `null` while stopped; the top progress bar follows the first lane that has one. */
  readonly progress?: number | null;
  /** The first `length` steps. */
  readonly steps: readonly StepGridStep[];
}

/** What the grid reads and drives. A `StepSequencer` satisfies it, and so can any model with these members. */
export interface StepGridSequencer {
  /** Borrowed lanes keyed by stable identifiers; display order follows the widget's lane configuration. */
  readonly lanes: Readonly<Record<string, StepGridLane>>;
}

/** User-facing strings; each key overrides the English default. */
export type StepGridLabels = {
  /** Accessible sequencer caption; defaults to "Step sequencer". */
  grid: string;
  /** Normalized strike-strength caption; defaults to "Velocity". */
  velocity: string;
  /** Beat-offset caption; defaults to "Offset". */
  offset: string;
  /** Event beat-length caption; defaults to "Length". */
  length: string;
  /** Retrigger-count caption; defaults to "Repeat". */
  repeat: string;
  /** MIDI-note caption; defaults to "Pitch". */
  pitch: string;
  /** Probability caption; defaults to "Chance". */
  chance: string;
  /** Lane-collapse caption; defaults to "Fold". */
  fold: string;
  /** Lane-silencing caption; defaults to "Mute". */
  mute: string;
  /** Lane-isolation caption; defaults to "Solo". */
  solo: string;
  /** Pattern step-count caption; defaults to "Steps". */
  steps: string;
  /** Step-rate caption; defaults to "Rate". */
  rate: string;
  /** Traversal-order caption; defaults to "Direction". */
  direction: string;
  /** Swing-amount caption; defaults to "Swing". */
  swing: string;
  /** Short caption of the direction column. */
  dir: string;
};

export type StepGridOptions = {
  /** Borrowed live lanes; the custom parameter tab set is fixed from the parameters present at mount. */
  sequencer: StepGridSequencer;
  /** Display name of a lane. Defaults to the lane's name. */
  laneLabel?(name: string): string;
  /** Zero-based step index; add one for visible numbering. */
  formatStep?(label: string, step: number): string;
  /** Optional control-caption overrides; missing entries use the built-in English labels. */
  labels?: Partial<StepGridLabels>;
};

/** The built-in cell values the tabs edit. Custom params use their declared `id`. */
export type StepGridBuiltInParameter = "velocity" | "offset" | "length" | "repeat" | "pitch" | "chance";

/** Resources live until this step is removed or its cell attachment is detached. */
export interface StepGridCellContext extends WidgetPluginContext {
  /** Stable identifier of the lane containing this cell. */
  readonly laneId: string;
  /** Zero-based step index. */
  readonly stepIndex: number;
  /** Tracked caller-owned step; read it in a core effect. */
  readonly step: StepGridStep;
  /** Dedicated cell overlay slot; geometry follows the cell automatically. */
  readonly root: HTMLElement;
}

/** Resources registered by a step grid plugin are released when its attachment is disposed. */
export interface StepGridPluginContext extends WidgetPluginContext {
  /** Attach once per live step; returned cleanup and registered resources end on cell removal or detach. */
  onCell(attach: (cell: StepGridCellContext) => void | Unsubscribe): Unsubscribe;
  /** The positioned element holding the lanes. Overlays are mounted inside it. */
  readonly surface: HTMLElement;
  /** The sequencer the grid reads and drives; plugins write cells through it. */
  readonly sequencer: StepGridSequencer;
  /** The step's element, or `null` for an unknown lane or step. */
  cellElement(laneId: string, step: number): HTMLElement | null;
  /** The step's box in CSS pixels relative to `surface`, or `null` for an unknown lane or step. */
  cellRect(
    laneId: string,
    step: number,
  ): Readonly<{
    /** Horizontal boundary in CSS pixels relative to the grid surface. */
    x: number;
    /** Vertical boundary in CSS pixels relative to the grid surface. */
    y: number;
    /** Cell width in CSS pixels. */
    width: number;
    /** Cell height in CSS pixels. */
    height: number;
  }> | null;
  /** Mount a full-surface overlay; position children with `cellRect()`. */
  mountOverlay(element: HTMLElement): Unsubscribe;
  /** Add an element to the toolbar strip next to the parameter tabs. */
  addToolbarItem(element: HTMLElement): Unsubscribe;
  /** The id of the parameter tab being shown and edited. */
  readonly activeParameter: Readable<string>;
  /** Select a tab by id: a built-in parameter or a declared custom param. Throws for an unknown id. */
  setActiveParameter(id: string): void;
  /** Called after the grid has updated for any change to the lanes, with the sequencer's lanes. */
  onPatternChange(listener: (lanes: StepGridSequencer["lanes"]) => void): Unsubscribe;
}

export type StepGridPlugin = WidgetPlugin<StepGridPluginContext>;

export interface StepGridHandle extends PluginTarget<StepGridPluginContext> {
  /** Releases resources owned by this attachment or view; safe to call twice. */
  dispose(): void;
}
