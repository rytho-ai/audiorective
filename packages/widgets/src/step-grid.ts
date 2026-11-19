import { cell, effect, readonlyCell, untracked } from "@audiorective/core";
import { createPluginHost } from "./plugin-host";
import { stepGridStyles } from "./step-grid-style";
import type {
  StepGridCell,
  StepGridCellPatch,
  StepGridDirection,
  StepGridHandle,
  StepGridLabels,
  StepGridLane,
  StepGridOptions,
  StepGridParamSpec,
  StepGridPattern,
  StepGridPluginContext,
  StepGridRate,
} from "./step-grid-types";
import type { Unsubscribe } from "./types";

export type * from "./step-grid-types";

const RATES: readonly StepGridRate[] = ["1/2", "1/4", "1/8", "1/16", "1/32", "1/64", "1/2T", "1/4T", "1/8T", "1/16T", "1/32T", "1/64T"];
const DIRECTIONS: readonly StepGridDirection[] = ["forward", "backward", "bounce"];
const ARROWS: Record<StepGridDirection, string> = { forward: "→", backward: "←", bounce: "↔" };
const DRAG_THRESHOLD = 3;
const HEADER_FIELDS = ["label", "steps", "rate", "direction", "swing", "mute", "solo"] as const;

const DEFAULT_LABELS: StepGridLabels = {
  grid: "Step sequencer",
  velocity: "Velocity",
  offset: "Offset",
  length: "Length",
  repeat: "Repeat",
  pitch: "Pitch",
  chance: "Chance",
  fold: "Fold",
  mute: "Mute",
  solo: "Solo",
  steps: "Steps",
  rate: "Rate",
  direction: "Direction",
  swing: "Swing",
};

type Kind = "fill" | "centre" | "segments";
type ParamDef = {
  id: string;
  label: string;
  min: number;
  max: number;
  kind: Kind;
  integer: boolean;
  quantum: number;
  fine: number;
  coarse: number;
  /** Pixels of vertical drag that cover the whole range, given the cell height. */
  span(height: number): number;
  fallback: number;
  custom: boolean;
  text(value: number): string;
};

const percent = (value: number) => `${Math.round(value * 100)}%`;
const trim = (value: number) => String(+value.toPrecision(3));

function builtIns(labels: StepGridLabels): ParamDef[] {
  const fit = (height: number) => Math.max(24, height);
  return [
    {
      id: "velocity",
      label: labels.velocity,
      min: 0,
      max: 1,
      kind: "fill",
      integer: false,
      quantum: 0.01,
      fine: 0.05,
      coarse: 0.25,
      span: fit,
      fallback: 0,
      custom: false,
      text: percent,
    },
    {
      id: "offset",
      label: labels.offset,
      min: -0.5,
      max: 0.5,
      kind: "centre",
      integer: false,
      quantum: 0.01,
      fine: 0.05,
      coarse: 0.125,
      span: fit,
      fallback: 0,
      custom: false,
      text: (value) => `${value > 0 ? "+" : value < 0 ? "-" : ""}${Math.round(Math.abs(value) * 100)}%`,
    },
    {
      id: "length",
      label: labels.length,
      min: 1 / 16,
      max: 4,
      kind: "fill",
      integer: false,
      quantum: 1 / 16,
      fine: 0.25,
      coarse: 1,
      span: fit,
      fallback: 1,
      custom: false,
      text: (value) => `${+value.toFixed(2)} ${value === 1 ? "step" : "steps"}`,
    },
    {
      id: "repeat",
      label: labels.repeat,
      min: 1,
      max: 8,
      kind: "segments",
      integer: true,
      quantum: 1,
      fine: 1,
      coarse: 2,
      span: () => 84,
      fallback: 1,
      custom: false,
      text: (value) => `x${value}`,
    },
    {
      id: "pitch",
      label: labels.pitch,
      min: -24,
      max: 24,
      kind: "centre",
      integer: true,
      quantum: 1,
      fine: 1,
      coarse: 12,
      span: () => 144,
      fallback: 0,
      custom: false,
      text: (value) => `${value > 0 ? "+" : ""}${value} st`,
    },
    {
      id: "chance",
      label: labels.chance,
      min: 0,
      max: 1,
      kind: "fill",
      integer: false,
      quantum: 0.01,
      fine: 0.05,
      coarse: 0.25,
      span: fit,
      fallback: 1,
      custom: false,
      text: percent,
    },
  ];
}

function customDef(spec: StepGridParamSpec): ParamDef {
  const range = spec.max - spec.min;
  const step = spec.step !== undefined && spec.step > 0 ? spec.step : range / 100;
  return {
    id: spec.id,
    label: spec.label ?? spec.id,
    min: spec.min,
    max: spec.max,
    kind: "fill",
    integer: false,
    quantum: step,
    fine: Math.max(step, range / 20),
    coarse: Math.max(step, range / 4),
    span: (height) => Math.max(24, height),
    fallback: spec.default,
    custom: true,
    text: trim,
  };
}

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));

function snap(def: ParamDef, value: number): number {
  const clamped = clamp(value, def.min, def.max);
  if (def.integer) return Math.round(clamped);
  const snapped = def.min + Math.round((clamped - def.min) / def.quantum) * def.quantum;
  return +clamp(snapped, def.min, def.max).toFixed(6);
}

function readValue(def: ParamDef, source: StepGridCell): number {
  if (def.custom) return source.custom?.[def.id] ?? def.fallback;
  return (source as unknown as Record<string, number>)[def.id] ?? def.fallback;
}

function patchFor(def: ParamDef, value: number): StepGridCellPatch {
  return def.custom ? { custom: { [def.id]: value } } : ({ [def.id]: value } as StepGridCellPatch);
}

type LaneView = {
  id: string;
  el: HTMLElement;
  name: HTMLElement;
  mute: HTMLButtonElement;
  solo: HTMLButtonElement;
  steps: HTMLInputElement;
  rate: HTMLSelectElement;
  dir: HTMLButtonElement;
  swing: HTMLInputElement;
  cellsEl: HTMLElement;
  cells: HTMLElement[];
  /** The key last painted into each cell, so unchanged cells are skipped. */
  keys: string[];
  lane: StepGridLane | undefined;
  head: number | null;
};

type Drag = { view: LaneView; step: number; def: ParamDef; startY: number; startValue: number; span: number; pointerId: number; moved: boolean };

/**
 * A pluggable, lane-aware step editor over a borrowed sequencer.
 * `sequencer` is a structural contract (`pattern`, `playheads`, `loopProgress` readables and `setCell`, `toggle`, `setLane`),
 * so a `StepSequencer` or your own model fits. Destroying the grid leaves the borrowed sequencer alone.
 */
export function mountStepGrid(root: HTMLElement, options: StepGridOptions): StepGridHandle {
  const { sequencer } = options;
  const labels = { ...DEFAULT_LABELS, ...options.labels };
  const formatStep = options.formatStep ?? ((label: string, step: number) => `${label} step ${step + 1}`);
  const doc = root.ownerDocument;
  const defs = [...builtIns(labels), ...(sequencer.params ?? []).map(customDef)];
  const defById = new Map(defs.map((def) => [def.id, def]));
  const make = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, parent?: HTMLElement): HTMLElementTagNameMap[K] => {
    const element = doc.createElement(tag);
    if (className) element.className = className;
    parent?.append(element);
    return element;
  };

  const view = make("div", "ar-step-grid");
  view.setAttribute("role", "group");
  view.setAttribute("aria-label", labels.grid);
  const style = make("style", undefined, view);
  style.textContent = stepGridStyles;
  const scroll = make("div", "ar-sg-scroll", view);
  const surface = make("div", "ar-sg-surface", scroll);
  const progressTrack = make("div", "ar-sg-progress", surface);
  progressTrack.setAttribute("aria-hidden", "true");
  const progressFill = make("div", "ar-sg-progress-fill", progressTrack);
  const ruler = make("div", "ar-sg-ruler", surface);
  ruler.setAttribute("aria-hidden", "true");
  const lanesEl = make("div", "ar-sg-lanes", surface);
  const footer = make("div", "ar-sg-footer", view);
  const tabs = make("div", "ar-sg-tabs", footer);
  tabs.setAttribute("role", "tablist");
  tabs.setAttribute("aria-label", labels.grid);
  const tools = make("div", "ar-sg-tools", footer);
  const toolbar = make("div", "ar-sg-toolbar", tools);
  const foldButton = make("button", "ar-sg-fold", tools);
  foldButton.type = "button";
  foldButton.textContent = labels.fold;
  foldButton.setAttribute("aria-pressed", "false");
  foldButton.title = labels.fold;

  const active = cell<string>("velocity");
  const activeReadable = readonlyCell(active);
  const tabButtons = new Map<string, HTMLButtonElement>();
  for (const def of defs) {
    const tab = make("button", "ar-sg-tab", tabs);
    tab.type = "button";
    tab.setAttribute("role", "tab");
    tab.dataset.parameter = def.id;
    tab.textContent = def.label;
    tabButtons.set(def.id, tab);
  }

  const views = new Map<string, LaneView>();
  let pattern: StepGridPattern | undefined;
  let rulerSize = -1;
  let folded = false;
  let tabCell: HTMLElement | undefined;
  let drag: Drag | undefined;
  let suppressClick = false;
  let destroyed = false;
  const patternListeners = new Set<(pattern: StepGridPattern) => void>();
  const disposers: Unsubscribe[] = [];
  const timers = new Set<ReturnType<typeof setTimeout>>();

  function on(target: EventTarget, type: string, listener: (event: any) => void): void {
    target.addEventListener(type, listener);
    disposers.push(() => target.removeEventListener(type, listener));
  }

  const defOf = () => defById.get(active.value)!;
  const laneOf = (id: string) => views.get(id)?.lane;
  const hasActive = (lane: StepGridLane) => lane.cells.some((value, step) => step < lane.steps && value.velocity > 0);

  function cellKey(def: ParamDef, lane: StepGridLane, step: number): string {
    const value = lane.cells[step];
    return `${step < lane.steps ? 1 : 0}|${value.velocity > 0 ? 1 : 0}|${readValue(def, value)}|${def.id}|${lane.label}`;
  }

  function paint(laneView: LaneView, lane: StepGridLane, step: number, def: ParamDef): void {
    const key = cellKey(def, lane, step);
    if (laneView.keys[step] === key) return;
    laneView.keys[step] = key;
    const element = laneView.cells[step];
    const value = lane.cells[step];
    const on = value.velocity > 0;
    const inert = step >= lane.steps;
    const current = readValue(def, value);
    element.dataset.on = String(on);
    element.dataset.inert = String(inert);
    element.setAttribute("aria-pressed", String(on));
    if (inert) element.setAttribute("aria-disabled", "true");
    else element.removeAttribute("aria-disabled");
    if (inert) element.tabIndex = -1;
    const text = def.text(current);
    element.setAttribute("aria-label", `${formatStep(lane.label, step)}, ${def.label} ${text}`);
    (element.lastElementChild as HTMLElement).textContent = text;
    const fill = element.firstElementChild as HTMLElement;
    const half = (def.max - def.min) / 2;
    if (def.kind === "fill") {
      fill.style.height = `${((current - def.min) / (def.max - def.min)) * 100}%`;
      fill.style.bottom = "0";
    } else if (def.kind === "centre") {
      const fraction = (current - (def.max + def.min) / 2) / half;
      const height = Math.abs(fraction) * 50;
      fill.style.height = `${height}%`;
      fill.style.bottom = `${fraction >= 0 ? 50 : 50 - height}%`;
    } else {
      fill.style.removeProperty("height");
      fill.style.bottom = "0";
      fill.style.setProperty("--ar-sg-n", String(current));
    }
  }

  function paintLane(laneView: LaneView, lane: StepGridLane, all: boolean): void {
    const def = defOf();
    const previous = laneView.lane;
    for (let step = 0; step < laneView.cells.length; step++) {
      if (all || !previous || previous.cells[step] !== lane.cells[step] || previous.steps !== lane.steps || previous.label !== lane.label)
        paint(laneView, lane, step, def);
    }
  }

  function createLane(lane: StepGridLane): LaneView {
    const el = make("div", "ar-sg-lane");
    el.setAttribute("role", "group");
    el.dataset.lane = lane.id;
    const head = make("div", "ar-sg-head", el);
    const name = make("span", "ar-sg-name", head);
    const mute = make("button", "ar-sg-mute", head);
    mute.type = "button";
    mute.textContent = "M";
    const solo = make("button", "ar-sg-solo", head);
    solo.type = "button";
    solo.textContent = "S";
    const field = (caption: string) => {
      const wrap = make("label", "ar-sg-field", head);
      wrap.append(caption);
      return wrap;
    };
    const stepsField = field("n");
    const steps = make("input", undefined, stepsField);
    steps.type = "number";
    steps.min = "1";
    steps.step = "1";
    const rateField = field("");
    const rate = make("select", undefined, rateField);
    for (const value of RATES) {
      const option = make("option", undefined, rate);
      option.value = option.textContent = value;
    }
    const dir = make("button", "ar-sg-dir", head);
    dir.type = "button";
    const swingField = field("");
    const swing = make("input", undefined, swingField);
    swing.type = "number";
    swing.min = "0";
    swing.max = "100";
    swing.step = "1";
    swingField.append("%");
    const cellsEl = make("div", "ar-sg-cells", el);
    const laneView: LaneView = {
      id: lane.id,
      el,
      name,
      mute,
      solo,
      steps,
      rate,
      dir,
      swing,
      cellsEl,
      cells: [],
      keys: [],
      lane: undefined,
      head: null,
    };
    mute.addEventListener("click", () => {
      const current = laneOf(lane.id);
      if (current) sequencer.setLane(lane.id, { mute: !current.mute });
    });
    solo.addEventListener("click", () => {
      const current = laneOf(lane.id);
      if (current) sequencer.setLane(lane.id, { solo: !current.solo });
    });
    dir.addEventListener("click", () => {
      const current = laneOf(lane.id);
      if (current) sequencer.setLane(lane.id, { direction: DIRECTIONS[(DIRECTIONS.indexOf(current.direction) + 1) % DIRECTIONS.length] });
    });
    rate.addEventListener("change", () => sequencer.setLane(lane.id, { rate: rate.value as StepGridRate }));
    steps.addEventListener("change", () => {
      const current = laneOf(lane.id);
      const next = Math.round(steps.valueAsNumber);
      if (current && Number.isFinite(next)) sequencer.setLane(lane.id, { steps: clamp(next, 1, pattern?.size ?? current.cells.length) });
      refreshHeader(laneView, laneOf(lane.id)!);
    });
    swing.addEventListener("change", () => {
      const current = laneOf(lane.id);
      const next = swing.valueAsNumber;
      if (current && Number.isFinite(next)) sequencer.setLane(lane.id, { swing: clamp(next, 0, 100) / 100 });
      refreshHeader(laneView, laneOf(lane.id)!);
    });
    // Stored for destroy(): the lane's own control listeners die with its elements.
    return laneView;
  }

  function setText(element: HTMLElement, text: string): void {
    if (element.textContent !== text) element.textContent = text;
  }

  function refreshHeader(laneView: LaneView, lane: StepGridLane): void {
    const size = pattern?.size ?? lane.cells.length;
    setText(laneView.name, lane.label);
    laneView.el.setAttribute("aria-label", lane.label);
    laneView.mute.setAttribute("aria-pressed", String(lane.mute));
    laneView.mute.setAttribute("aria-label", `${lane.label} ${labels.mute}`);
    laneView.mute.title = labels.mute;
    laneView.solo.setAttribute("aria-pressed", String(lane.solo));
    laneView.solo.setAttribute("aria-label", `${lane.label} ${labels.solo}`);
    laneView.solo.title = labels.solo;
    const stepsText = String(lane.steps);
    if (laneView.steps.value !== stepsText) laneView.steps.value = stepsText;
    laneView.steps.max = String(size);
    laneView.steps.setAttribute("aria-label", `${lane.label} ${labels.steps}`);
    laneView.steps.title = labels.steps;
    if (laneView.rate.value !== lane.rate) laneView.rate.value = lane.rate;
    laneView.rate.setAttribute("aria-label", `${lane.label} ${labels.rate}`);
    laneView.rate.title = labels.rate;
    setText(laneView.dir, ARROWS[lane.direction]);
    laneView.dir.setAttribute("aria-label", `${lane.label} ${labels.direction}: ${lane.direction}`);
    laneView.dir.title = `${labels.direction}: ${lane.direction}`;
    const swingText = String(Math.round(lane.swing * 100));
    if (laneView.swing.value !== swingText) laneView.swing.value = swingText;
    laneView.swing.setAttribute("aria-label", `${lane.label} ${labels.swing} %`);
    laneView.swing.title = labels.swing;
  }

  function syncRuler(size: number): void {
    if (rulerSize === size) return;
    rulerSize = size;
    view.style.setProperty("--ar-sg-size", String(size));
    ruler.replaceChildren();
    for (let step = 0; step < size; step++) {
      const tick = make("span", "ar-sg-tick", ruler);
      if (step % 4 === 0) {
        tick.dataset.bar = String(step > 0);
        tick.textContent = String(step + 1);
      }
      if (step === 0) tick.dataset.first = "true";
    }
  }

  function syncCells(laneView: LaneView, size: number): void {
    while (laneView.cells.length > size) {
      laneView.cells.pop()!.remove();
      laneView.keys.pop();
    }
    while (laneView.cells.length < size) {
      const step = laneView.cells.length;
      const element = make("div", "ar-sg-cell", laneView.cellsEl);
      element.setAttribute("role", "button");
      element.tabIndex = -1;
      element.dataset.lane = laneView.id;
      element.dataset.step = String(step);
      element.dataset.bar = String(step > 0 && step % 4 === 0);
      if (step === 0) element.dataset.first = "true";
      make("span", "ar-sg-fill", element);
      make("span", "ar-sg-value", element).setAttribute("aria-hidden", "true");
      laneView.cells.push(element);
      laneView.keys.push("");
    }
  }

  function setHead(laneView: LaneView, next: number | null): void {
    if (laneView.head === next) return;
    if (laneView.head !== null) delete laneView.cells[laneView.head]?.dataset.current;
    laneView.head = next;
    if (next !== null && laneView.cells[next]) laneView.cells[next].dataset.current = "true";
  }

  function applyHeads(heads: Readonly<Record<string, number | null>>): void {
    for (const laneView of views.values()) setHead(laneView, heads[laneView.id] ?? null);
  }

  function focusable(element: HTMLElement | undefined): element is HTMLElement {
    return !!element && lanesEl.contains(element) && element.dataset.inert !== "true" && !element.closest("[hidden]");
  }

  function setTabCell(element: HTMLElement | undefined): void {
    if (tabCell === element) return;
    if (tabCell) tabCell.tabIndex = -1;
    tabCell = element;
    if (element) element.tabIndex = 0;
  }

  function ensureTabCell(): void {
    if (focusable(tabCell)) return;
    tabCell = undefined;
    for (const laneView of views.values()) {
      const candidate = laneView.cells.find((element) => focusable(element));
      if (candidate) return setTabCell(candidate);
    }
  }

  function applyFold(): void {
    for (const laneView of views.values()) laneView.el.hidden = folded && !!laneView.lane && !hasActive(laneView.lane);
    ensureTabCell();
  }

  function applyPattern(next: StepGridPattern): void {
    const previous = pattern;
    pattern = next;
    const ids = new Set(next.lanes.map((lane) => lane.id));
    for (const [id, laneView] of views) {
      if (ids.has(id)) continue;
      if (drag?.view === laneView) drag = undefined;
      laneView.el.remove();
      views.delete(id);
    }
    const forceCells = previous?.size !== next.size;
    syncRuler(next.size);
    let order = false;
    next.lanes.forEach((lane, index) => {
      let laneView = views.get(lane.id);
      if (!laneView) {
        laneView = createLane(lane);
        views.set(lane.id, laneView);
        order = true;
      }
      if (lanesEl.children[index] !== laneView.el) order = true;
    });
    if (order) lanesEl.append(...next.lanes.map((lane) => views.get(lane.id)!.el));
    for (const lane of next.lanes) {
      const laneView = views.get(lane.id)!;
      if (laneView.lane === lane && !forceCells) continue;
      const before = laneView.lane;
      if (!before || before.cells.length !== next.size) syncCells(laneView, next.size);
      if (forceCells || !before || HEADER_FIELDS.some((field) => before[field] !== lane[field])) refreshHeader(laneView, lane);
      paintLane(laneView, lane, false);
      laneView.lane = lane;
      laneView.el.hidden = folded && !hasActive(lane);
    }
    applyHeads(untracked(() => sequencer.playheads.value));
    ensureTabCell();
    for (const listener of [...patternListeners]) {
      try {
        listener(next);
      } catch (error) {
        console.error("Step grid pattern listener failed:", error);
      }
    }
  }

  function selectParameter(id: string): void {
    if (!defById.has(id))
      throw new Error(
        `Step grid has no parameter "${id}". Use a built-in id (velocity, offset, length, repeat, pitch, chance) or a declared custom param id.`,
      );
    active.value = id;
  }

  const stopActive = effect(() => {
    const id = active.value;
    const def = defById.get(id)!;
    view.dataset.kind = def.kind;
    view.dataset.parameter = id;
    for (const [key, tab] of tabButtons) {
      tab.setAttribute("aria-selected", String(key === id));
      tab.tabIndex = key === id ? 0 : -1;
    }
    untracked(() => {
      for (const laneView of views.values()) if (laneView.lane) paintLane(laneView, laneView.lane, true);
    });
  });
  const stopPattern = effect(() => {
    const next = sequencer.pattern.value;
    untracked(() => applyPattern(next));
  });
  const stopHeads = effect(() => {
    const heads = sequencer.playheads.value;
    untracked(() => applyHeads(heads));
  });
  const stopProgress = effect(() => {
    const progress = sequencer.loopProgress.value;
    progressFill.style.width = progress === null ? "0" : `${clamp(progress, 0, 1) * 100}%`;
    progressTrack.dataset.active = String(progress !== null);
  });

  function adjust(laneView: LaneView, step: number, def: ParamDef, delta: number): void {
    const lane = laneView.lane;
    if (!lane || step >= lane.steps) return;
    const current = readValue(def, lane.cells[step]);
    const next = snap(def, current + delta);
    if (next !== current) sequencer.setCell(lane.id, step, patchFor(def, next));
  }

  function target(event: Event): { laneView: LaneView; step: number; element: HTMLElement } | undefined {
    const element = (event.target as Element | null)?.closest?.<HTMLElement>(".ar-sg-cell");
    if (!element || !lanesEl.contains(element)) return undefined;
    const laneView = views.get(element.dataset.lane!);
    return laneView ? { laneView, step: Number(element.dataset.step), element } : undefined;
  }

  const releaseDrag = () => {
    if (!drag) return;
    delete drag.view.cells[drag.step]?.dataset.editing;
    drag = undefined;
  };

  on(lanesEl, "pointerdown", (event: PointerEvent) => {
    const hit = target(event);
    suppressClick = false;
    if (!hit || event.button !== 0 || hit.element.dataset.inert === "true" || !hit.laneView.lane) return;
    const def = defOf();
    const rect = hit.element.getBoundingClientRect();
    drag = {
      view: hit.laneView,
      step: hit.step,
      def,
      startY: event.clientY,
      startValue: readValue(def, hit.laneView.lane.cells[hit.step]),
      span: def.span(rect.height),
      pointerId: event.pointerId,
      moved: false,
    };
    try {
      hit.element.setPointerCapture(event.pointerId);
    } catch {
      // A synthetic pointer cannot be captured; its events still reach the lanes.
    }
  });
  on(lanesEl, "pointermove", (event: PointerEvent) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const delta = drag.startY - event.clientY;
    if (!drag.moved) {
      if (Math.abs(delta) < DRAG_THRESHOLD) return;
      drag.moved = true;
      drag.view.cells[drag.step].dataset.editing = "true";
    }
    const lane = drag.view.lane;
    if (!lane) return;
    const next = snap(drag.def, drag.startValue + (delta / drag.span) * (drag.def.max - drag.def.min));
    if (next !== readValue(drag.def, lane.cells[drag.step])) sequencer.setCell(lane.id, drag.step, patchFor(drag.def, next));
  });
  const endDrag = (event: PointerEvent) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    if (drag.moved) {
      suppressClick = true;
      const timer = setTimeout(() => {
        timers.delete(timer);
        suppressClick = false;
      }, 0);
      timers.add(timer);
    }
    releaseDrag();
  };
  on(lanesEl, "pointerup", endDrag);
  on(lanesEl, "pointercancel", endDrag);
  on(lanesEl, "click", (event: MouseEvent) => {
    const hit = target(event);
    if (!hit) return;
    if (suppressClick) {
      suppressClick = false;
      return;
    }
    if (hit.element.dataset.inert === "true" || !hit.laneView.lane) return;
    sequencer.toggle(hit.laneView.id, hit.step);
  });
  on(lanesEl, "focusin", (event: FocusEvent) => {
    const hit = target(event);
    if (hit && hit.element.dataset.inert !== "true") setTabCell(hit.element);
  });
  on(lanesEl, "keydown", (event: KeyboardEvent) => {
    const hit = target(event);
    const lane = hit?.laneView.lane;
    if (!hit || !lane || event.ctrlKey || event.metaKey || hit.element.dataset.inert === "true") return;
    const { laneView, step } = hit;
    const focusStep = (nextLane: LaneView, nextStep: number) => {
      const next = nextLane.lane;
      const element = next && nextLane.cells[clamp(nextStep, 0, next.steps - 1)];
      if (element) {
        setTabCell(element);
        element.focus();
      }
    };
    const def = defOf();
    switch (event.key) {
      case "ArrowLeft":
      case "ArrowRight":
        focusStep(laneView, step + (event.key === "ArrowRight" ? 1 : -1));
        break;
      case "Home":
      case "End":
        focusStep(laneView, event.key === "Home" ? 0 : lane.steps - 1);
        break;
      case "ArrowUp":
      case "ArrowDown":
        if (event.altKey) {
          const visible = [...views.values()].filter((item) => !item.el.hidden);
          const next = visible[visible.indexOf(laneView) + (event.key === "ArrowDown" ? 1 : -1)];
          if (next) focusStep(next, step);
        } else adjust(laneView, step, def, (event.key === "ArrowUp" ? 1 : -1) * def.fine);
        break;
      case "PageUp":
      case "PageDown":
        adjust(laneView, step, def, (event.key === "PageUp" ? 1 : -1) * def.coarse);
        break;
      case "Enter":
      case " ":
        sequencer.toggle(laneView.id, step);
        break;
      default:
        return;
    }
    event.preventDefault();
  });
  for (const [id, tab] of tabButtons) on(tab, "click", () => selectParameter(id));
  on(foldButton, "click", () => {
    folded = !folded;
    foldButton.setAttribute("aria-pressed", String(folded));
    applyFold();
  });
  root.append(view);

  const plugins = createPluginHost<StepGridPluginContext>("step grid", ({ isActive, own }) => ({
    surface,
    sequencer,
    cellElement: (laneId, step) => views.get(laneId)?.cells[step] ?? null,
    cellRect(laneId, step) {
      const element = views.get(laneId)?.cells[step];
      if (!element) return null;
      const box = element.getBoundingClientRect();
      const origin = surface.getBoundingClientRect();
      return { x: box.left - origin.left, y: box.top - origin.top, width: box.width, height: box.height };
    },
    mountOverlay(element) {
      if (!isActive()) throw new Error("Plugin attachment is destroyed.");
      Object.assign(element.style, { position: "absolute", inset: "0", pointerEvents: "none" });
      surface.append(element);
      return own(() => element.remove());
    },
    addToolbarItem(element) {
      if (!isActive()) throw new Error("Plugin attachment is destroyed.");
      toolbar.append(element);
      return own(() => element.remove());
    },
    activeParameter: activeReadable,
    setActiveParameter(id) {
      if (isActive()) selectParameter(id);
    },
    onPatternChange(listener) {
      patternListeners.add(listener);
      return own(() => patternListeners.delete(listener));
    },
    listen(eventTarget, type, listener) {
      eventTarget.addEventListener(type, listener);
      return own(() => eventTarget.removeEventListener(type, listener));
    },
    onCleanup: own,
  }));

  return {
    attach: (plugin) => plugins.attach(plugin),
    destroy() {
      if (destroyed) return;
      destroyed = true;
      plugins.destroy();
      stopActive();
      stopPattern();
      stopHeads();
      stopProgress();
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      for (const dispose of disposers.splice(0)) dispose();
      patternListeners.clear();
      view.remove();
    },
  };
}
