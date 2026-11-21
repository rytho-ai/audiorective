import { cell, effect, readonlyCell, untracked, type ValueRange } from "@audiorective/core";
import { createPluginHost } from "./plugin-host";
import { stepGridStyles } from "./step-grid-style";
import type {
  StepGridCellContext,
  StepGridDirection,
  StepGridHandle,
  StepGridLabels,
  StepGridLane,
  StepGridOptions,
  StepGridParamSpec,
  StepGridPluginContext,
  StepGridRate,
  StepGridSequencer,
  StepGridStep,
} from "./step-grid-types";
import type { Unsubscribe } from "./types";

export type * from "./step-grid-types";

const RATES: readonly StepGridRate[] = ["1/2", "1/4", "1/8", "1/16", "1/32", "1/64", "1/2T", "1/4T", "1/8T", "1/16T", "1/32T", "1/64T"];
const DIRECTIONS: readonly StepGridDirection[] = ["forward", "backward", "bounce"];
const ARROWS: Record<StepGridDirection, string> = { forward: "→", backward: "←", bounce: "↔" };
const DRAG_THRESHOLD = 3;
const BOX_DRAG = 3;
const HEADER_FIELDS = ["length", "rate", "direction", "swing", "muted", "solo"] as const;
const MAX_LENGTH = 128;

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
  dir: "Dir",
};

type Kind = "fill" | "centre" | "segments";
type ParamDef = ValueRange & {
  id: string;
  label: string;
  kind: Kind;
  integer: boolean;
  quantum: number;
  fine: number;
  coarse: number;
  /** Pixels of vertical drag that cover the whole range, given the cell height. */
  span(height: number): number;
  /** Pixels of drag per unit for integer values; their span follows the range. */
  unitPx?: number;
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
      unitPx: 12,
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
      unitPx: 3,
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

function readValue(def: ParamDef, source: StepGridStep): number {
  if (def.custom) return source.values[def.id] ?? def.fallback;
  return (source as unknown as Record<string, number>)[def.id] ?? def.fallback;
}

type Snap = Readonly<{
  length: number;
  rate: string;
  direction: StepGridDirection;
  swing: number;
  muted: boolean;
  solo: boolean;
  params: StepGridLane["params"];
  /** One entry per visible step (the first `length`). */
  cells: readonly Readonly<StepGridStep>[];
}>;

function readLane(lane: StepGridLane): Snap {
  const { length, rate, direction, swing, muted, solo, params } = lane;
  const cells = lane.steps.map(({ velocity, offset, length, repeat, pitch, chance, values }) => ({
    velocity,
    offset,
    length,
    repeat,
    pitch,
    chance,
    values: { ...values },
  }));
  return { length, rate: String(rate), direction, swing, muted, solo, params, cells };
}

type NumberBox = {
  el: HTMLElement;
  update(state: { value: number; min: number; max: number; text: string; label: string }): void;
};

/** A compact spinbutton: drag vertically, arrow keys or wheel (when focused) adjust it, double-click or Enter types a value. */
function createNumberBox(doc: Document, pxPerUnit: number, onChange: (value: number) => void): NumberBox {
  const el = doc.createElement("div");
  el.className = "ar-sg-box";
  el.tabIndex = 0;
  el.setAttribute("role", "spinbutton");
  let value = 0;
  let min = 0;
  let max = 0;
  let text = "";
  let editing = false;
  let press: { y: number; start: number; id: number; moved: boolean } | undefined;
  const attr = (name: string, next: string) => {
    if (el.getAttribute(name) !== next) el.setAttribute(name, next);
  };
  const commit = (next: number) => {
    const clamped = clamp(Math.round(next), min, max);
    if (clamped !== value) onChange(clamped);
  };
  function edit(): void {
    if (editing) return;
    editing = true;
    el.dataset.editing = "true";
    const input = doc.createElement("input");
    input.type = "text";
    input.inputMode = "numeric";
    input.value = String(value);
    input.setAttribute("aria-label", el.getAttribute("aria-label") ?? "");
    el.replaceChildren(input);
    input.focus();
    input.select();
    let done = false;
    const finish = (apply: boolean) => {
      if (done) return;
      done = true;
      editing = false;
      delete el.dataset.editing;
      if (apply) {
        const typed = parseFloat(input.value);
        if (Number.isFinite(typed)) commit(typed);
      }
      el.textContent = text;
      if (doc.activeElement === input || doc.activeElement === doc.body) el.focus();
    };
    input.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "Enter") finish(true);
      else if (event.key === "Escape") finish(false);
    });
    input.addEventListener("blur", () => finish(true));
  }
  el.addEventListener("pointerdown", (event) => {
    if (editing || event.button !== 0) return;
    press = { y: event.clientY, start: value, id: event.pointerId, moved: false };
    try {
      el.setPointerCapture(event.pointerId);
    } catch {
      // A synthetic pointer cannot be captured.
    }
  });
  el.addEventListener("pointermove", (event) => {
    if (!press || event.pointerId !== press.id) return;
    const delta = press.y - event.clientY;
    if (!press.moved && Math.abs(delta) < BOX_DRAG) return;
    press.moved = true;
    commit(press.start + Math.round(delta / pxPerUnit));
  });
  const release = (event: PointerEvent) => {
    if (press && event.pointerId === press.id) press = undefined;
  };
  el.addEventListener("pointerup", release);
  el.addEventListener("pointercancel", release);
  el.addEventListener("dblclick", edit);
  el.addEventListener("wheel", (event) => {
    if (editing || doc.activeElement !== el || event.deltaY === 0) return;
    event.preventDefault();
    commit(value + (event.deltaY < 0 ? 1 : -1));
  });
  el.addEventListener("keydown", (event) => {
    if (editing || event.target !== el || event.ctrlKey || event.metaKey || event.altKey) return;
    const unit = event.shiftKey ? 10 : 1;
    switch (event.key) {
      case "ArrowUp":
      case "ArrowRight":
        commit(value + unit);
        break;
      case "ArrowDown":
      case "ArrowLeft":
        commit(value - unit);
        break;
      case "PageUp":
        commit(value + 10);
        break;
      case "PageDown":
        commit(value - 10);
        break;
      case "Home":
        commit(min);
        break;
      case "End":
        commit(max);
        break;
      case "Enter":
        edit();
        break;
      default:
        return;
    }
    event.preventDefault();
  });
  return {
    el,
    update(state) {
      value = state.value;
      min = state.min;
      max = state.max;
      text = state.text;
      attr("aria-valuemin", String(min));
      attr("aria-valuemax", String(max));
      attr("aria-valuenow", String(value));
      attr("aria-valuetext", text);
      attr("aria-label", state.label);
      if (!editing && el.textContent !== text) el.textContent = text;
    },
  };
}

type LaneView = {
  id: string;
  label: string;
  el: HTMLElement;
  name: HTMLElement;
  mute: HTMLButtonElement;
  solo: HTMLButtonElement;
  steps: NumberBox;
  rate: HTMLSelectElement;
  dir: HTMLButtonElement;
  swing: NumberBox;
  cellsEl: HTMLElement;
  cells: HTMLElement[];
  /** The key last painted into each cell, so unchanged cells are skipped. */
  keys: string[];
  snap: Snap | undefined;
  head: number | null;
};

type Drag = { view: LaneView; step: number; def: ParamDef; startY: number; startValue: number; span: number; pointerId: number; moved: boolean };

/**
 * A pluggable, lane-aware step editor over a borrowed sequencer.
 * `sequencer` is a structural contract (`lanes`: per lane `length`, `rate`, `swing`, `direction`, `muted`, `solo`, `params`, `playhead` and `steps`),
 * so a `StepSequencer` or your own model fits. Disposeing the grid leaves the borrowed sequencer alone.
 */
export function mountStepGrid(root: HTMLElement, options: StepGridOptions): StepGridHandle {
  const { sequencer } = options;
  const labels = { ...DEFAULT_LABELS, ...options.labels };
  const formatStep = options.formatStep ?? ((label: string, step: number) => `${label} step ${step + 1}`);
  const laneLabel = options.laneLabel ?? ((name: string) => name);
  const doc = root.ownerDocument;
  const customSpecs = new Map<string, StepGridParamSpec>();
  for (const id of Object.keys(sequencer.lanes))
    for (const [param, range] of Object.entries(untracked(() => sequencer.lanes[id].params)))
      if (!customSpecs.has(param)) customSpecs.set(param, { id: param, ...range });
  const defs = [...builtIns(labels), ...[...customSpecs.values()].map(customDef)];
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
  const top = make("div", "ar-sg-top", surface);
  top.setAttribute("aria-hidden", "true");
  const colHead = make("div", "ar-sg-colhead", top);
  [labels.steps, labels.rate, labels.dir, labels.swing].forEach((caption, index) => {
    make("span", "ar-sg-colname", colHead).style.gridColumn = String(index + 4);
    colHead.lastElementChild!.textContent = caption;
  });
  const timeline = make("div", "ar-sg-timeline", top);
  const ruler = make("div", "ar-sg-ruler", timeline);
  const progressTrack = make("div", "ar-sg-progress", timeline);
  const progressFill = make("div", "ar-sg-progress-fill", progressTrack);
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
  /** Columns shown: the longest lane length seen so far; it grows and never shrinks. */
  let columns = 0;
  let rulerSize = -1;
  let folded = false;
  let tabCell: HTMLElement | undefined;
  let drag: Drag | undefined;
  let suppressClick = false;
  let disposed = false;
  const patternListeners = new Set<(lanes: StepGridSequencer["lanes"]) => void>();
  type CellObserver = {
    active: boolean;
    attach: (cell: StepGridCellContext) => void | Unsubscribe;
    cells: Map<HTMLElement, { step: StepGridStep; dispose(): void }>;
    detach(): void;
  };
  const cellObservers = new Set<CellObserver>();
  const disposers: Unsubscribe[] = [];
  const timers = new Set<ReturnType<typeof setTimeout>>();

  function on(target: EventTarget, type: string, listener: (event: any) => void): void {
    target.addEventListener(type, listener);
    disposers.push(() => target.removeEventListener(type, listener));
  }

  const defOf = () => defById.get(active.value)!;
  const hasActive = (snap: Snap) => snap.cells.some((value) => value.velocity > 0);
  const missing = (def: ParamDef, snap: Snap) => def.custom && !(def.id in snap.params);
  /** The live step when it is visible and editable under `def`, else `undefined`. */
  function stepOf(laneView: LaneView, step: number, def: ParamDef): StepGridStep | undefined {
    const snap = laneView.snap;
    if (!snap || step >= snap.length || missing(def, snap)) return undefined;
    return untracked(() => sequencer.lanes[laneView.id].steps[step]);
  }
  /** Write `value` (clamped to the lane's own range for a custom param) to one step. */
  function write(laneView: LaneView, step: number, def: ParamDef, value: number): void {
    const target = stepOf(laneView, step, def);
    if (!target) return;
    const own = def.custom ? laneView.snap!.params[def.id] : undefined;
    const next = own ? clamp(value, own.min, own.max) : value;
    if (def.custom) target.values[def.id] = next;
    else (target as unknown as Record<string, number>)[def.id] = next;
  }

  function paint(laneView: LaneView, snap: Snap, step: number, def: ParamDef): void {
    const value = snap.cells[step];
    const shown = value && !missing(def, snap) ? value : undefined;
    const current = shown ? readValue(def, shown) : undefined;
    const key = `${value ? (value.velocity > 0 ? 1 : 0) : 2}|${shown ? 1 : 0}|${current}|${def.id}`;
    if (laneView.keys[step] === key) return;
    laneView.keys[step] = key;
    const element = laneView.cells[step];
    const on = !!value && value.velocity > 0;
    const inert = !shown;
    element.dataset.on = String(on);
    element.dataset.inert = String(inert);
    element.setAttribute("aria-pressed", String(on));
    if (inert) {
      element.setAttribute("aria-disabled", "true");
      element.tabIndex = -1;
    } else element.removeAttribute("aria-disabled");
    const text = current === undefined ? "" : def.text(current);
    element.setAttribute("aria-label", text ? `${formatStep(laneView.label, step)}, ${def.label} ${text}` : formatStep(laneView.label, step));
    (element.lastElementChild as HTMLElement).textContent = text;
    const fill = element.firstElementChild as HTMLElement;
    const half = (def.max - def.min) / 2;
    if (current === undefined) {
      fill.style.height = "0%";
      fill.style.bottom = "0";
    } else if (def.kind === "fill") {
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

  function paintLane(laneView: LaneView, snap: Snap): void {
    const def = defOf();
    for (let step = 0; step < laneView.cells.length; step++) paint(laneView, snap, step, def);
  }

  function createLane(id: string): LaneView {
    const label = laneLabel(id);
    const el = make("div", "ar-sg-lane");
    el.setAttribute("role", "group");
    el.dataset.lane = id;
    const head = make("div", "ar-sg-head", el);
    const name = make("span", "ar-sg-name", head);
    const mute = make("button", "ar-sg-mute", head);
    mute.type = "button";
    mute.textContent = "M";
    const solo = make("button", "ar-sg-solo", head);
    solo.type = "button";
    solo.textContent = "S";
    const live = () => sequencer.lanes[id];
    const steps = createNumberBox(doc, 8, (value) => {
      live().length = clamp(value, 1, MAX_LENGTH);
    });
    steps.el.classList.add("ar-sg-steps");
    head.append(steps.el);
    const rateWrap = make("span", "ar-sg-select", head);
    const rate = make("select", undefined, rateWrap);
    for (const value of RATES) {
      const option = make("option", undefined, rate);
      option.value = option.textContent = value;
    }
    const dir = make("button", "ar-sg-dir", head);
    dir.type = "button";
    const swing = createNumberBox(doc, 3, (value) => {
      live().swing = clamp(value, 0, 100) / 100;
    });
    swing.el.classList.add("ar-sg-swing");
    head.append(swing.el);
    const cellsEl = make("div", "ar-sg-cells", el);
    const laneView: LaneView = {
      id,
      label,
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
      snap: undefined,
      head: null,
    };
    mute.addEventListener("click", () => {
      const lane = untracked(live);
      lane.muted = !untracked(() => lane.muted);
    });
    solo.addEventListener("click", () => {
      const lane = untracked(live);
      lane.solo = !untracked(() => lane.solo);
    });
    dir.addEventListener("click", () => {
      const lane = untracked(live);
      const current = untracked(() => lane.direction);
      lane.direction = DIRECTIONS[(DIRECTIONS.indexOf(current) + 1) % DIRECTIONS.length];
    });
    rate.addEventListener("change", () => {
      const lane = untracked(live);
      if (rate.value !== String(untracked(() => lane.rate))) lane.rate = rate.value;
    });
    // The lane's own control listeners die with its elements.
    return laneView;
  }

  function setText(element: HTMLElement, text: string): void {
    if (element.textContent !== text) element.textContent = text;
  }

  function refreshHeader(laneView: LaneView, snap: Snap): void {
    const label = laneView.label;
    setText(laneView.name, label);
    laneView.el.setAttribute("aria-label", label);
    laneView.mute.setAttribute("aria-pressed", String(snap.muted));
    laneView.mute.setAttribute("aria-label", `${label} ${labels.mute}`);
    laneView.mute.title = labels.mute;
    laneView.solo.setAttribute("aria-pressed", String(snap.solo));
    laneView.solo.setAttribute("aria-label", `${label} ${labels.solo}`);
    laneView.solo.title = labels.solo;
    laneView.steps.update({ value: snap.length, min: 1, max: MAX_LENGTH, text: String(snap.length), label: `${label} ${labels.steps}` });
    if (!Array.from(laneView.rate.options).some((option) => option.value === snap.rate)) {
      const option = doc.createElement("option");
      option.value = option.textContent = snap.rate;
      laneView.rate.append(option);
    }
    if (laneView.rate.value !== snap.rate) laneView.rate.value = snap.rate;
    laneView.rate.setAttribute("aria-label", `${label} ${labels.rate}`);
    laneView.rate.title = labels.rate;
    setText(laneView.dir, ARROWS[snap.direction]);
    laneView.dir.setAttribute("aria-label", `${label} ${labels.direction}: ${snap.direction}`);
    laneView.dir.title = `${labels.direction}: ${snap.direction}`;
    const swing = Math.round(snap.swing * 100);
    laneView.swing.update({ value: swing, min: 0, max: 100, text: `${swing}%`, label: `${label} ${labels.swing} %` });
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
    if (laneView.head !== next && laneView.head !== null) delete laneView.cells[laneView.head]?.dataset.current;
    laneView.head = next;
    const element = next === null ? undefined : laneView.cells[next];
    if (element && element.dataset.current !== "true") element.dataset.current = "true";
  }

  function applyHeads(heads: Readonly<Record<string, number | null>>): void {
    for (const laneView of views.values()) setHead(laneView, heads[laneView.id] ?? null);
  }

  const readHeads = () => Object.fromEntries(Object.entries(sequencer.lanes).map(([id, lane]) => [id, lane.playhead ?? null]));

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
    for (const laneView of views.values()) laneView.el.hidden = folded && !!laneView.snap && !hasActive(laneView.snap);
    ensureTabCell();
  }

  function isLiveCell(element: HTMLElement, laneId: string, stepIndex: number, step: StepGridStep): boolean {
    const lane = sequencer.lanes[laneId];
    return !!lane && stepIndex < lane.length && lane.steps[stepIndex] === step && views.get(laneId)?.cells[stepIndex] === element;
  }

  function syncCellObserver(observer: CellObserver): void {
    const live = new Map<HTMLElement, { laneId: string; stepIndex: number; step: StepGridStep }>();
    for (const laneView of views.values()) {
      const lane = sequencer.lanes[laneView.id];
      if (!lane) continue;
      const steps = lane.steps;
      for (let stepIndex = 0; stepIndex < (laneView.snap?.length ?? 0); stepIndex++) {
        const step = steps[stepIndex];
        if (step) live.set(laneView.cells[stepIndex], { laneId: laneView.id, stepIndex, step });
      }
    }
    for (const [element, cell] of [...observer.cells]) {
      if (observer.cells.get(element) !== cell) continue;
      if (live.get(element)?.step === cell.step) continue;
      observer.cells.delete(element);
      cell.dispose();
    }
    for (const [element, { laneId, stepIndex, step }] of live) {
      if (!observer.active || disposed) return;
      if (observer.cells.has(element)) continue;
      // A prior callback/cleanup may have synchronously replaced the owner or its view.
      if (!isLiveCell(element, laneId, stepIndex, step)) continue;
      const slot = doc.createElement("div");
      slot.className = "ar-sg-cell-overlay";
      Object.assign(slot.style, { position: "absolute", inset: "0", pointerEvents: "none", zIndex: "2" });
      // Keep the fill first and the value last: the existing painter owns those nodes.
      element.insertBefore(slot, element.lastElementChild);
      const scope = createPluginHost<StepGridCellContext>("step grid cell", ({ own }) => {
        own(() => slot.remove());
        return {
          laneId,
          stepIndex,
          step,
          root: slot,
          listen(target, type, listener) {
            target.addEventListener(type, listener);
            return own(() => target.removeEventListener(type, listener));
          },
          onCleanup: own,
        };
      });
      // Publish before user code: removal/disposal can reenter while attach is running.
      const cell = { step, dispose: () => scope.dispose() };
      observer.cells.set(element, cell);
      scope.attach({ attach: (context) => untracked(() => observer.attach(context)) });
      if (!isLiveCell(element, laneId, stepIndex, step)) {
        if (observer.cells.get(element) === cell) observer.cells.delete(element);
        scope.dispose();
      }
    }
  }

  function syncCellObservers(): void {
    for (const observer of [...cellObservers]) {
      if (!observer.active) continue;
      try {
        syncCellObserver(observer);
      } catch (error) {
        observer.detach();
        console.error("Step grid cell attachment failed:", error);
      }
    }
  }

  function applyLanes(snaps: ReadonlyMap<string, Snap>): void {
    columns = Math.max(columns, ...[...snaps.values()].map((snap) => snap.length));
    syncRuler(columns);
    for (const [id, laneView] of views) {
      if (snaps.has(id)) continue;
      if (drag?.view === laneView) releaseDrag();
      views.delete(id);
      laneView.el.remove();
    }
    let next = lanesEl.firstElementChild;
    for (const [id, snap] of snaps) {
      let laneView = views.get(id);
      if (!laneView) {
        laneView = createLane(id);
        views.set(id, laneView);
      }
      if (laneView.el !== next) lanesEl.insertBefore(laneView.el, next);
      next = laneView.el.nextElementSibling;
      const before = laneView.snap;
      if (laneView.cells.length !== columns) syncCells(laneView, columns);
      if (!before || HEADER_FIELDS.some((field) => before[field] !== snap[field])) refreshHeader(laneView, snap);
      laneView.snap = snap;
      paintLane(laneView, snap);
      laneView.el.hidden = folded && !hasActive(snap);
    }
    applyHeads(untracked(readHeads));
    ensureTabCell();
    syncCellObservers();
    for (const listener of [...patternListeners]) {
      try {
        listener(sequencer.lanes);
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
      for (const laneView of views.values()) if (laneView.snap) paintLane(laneView, laneView.snap);
    });
  });
  const stopLanes = effect(() => {
    const snaps = new Map(Object.entries(sequencer.lanes).map(([id, lane]) => [id, readLane(lane)]));
    untracked(() => applyLanes(snaps));
  });
  const stopHeads = effect(() => {
    const heads = readHeads();
    untracked(() => applyHeads(heads));
  });
  const stopProgress = effect(() => {
    let progress: number | null = null;
    for (const lane of Object.values(sequencer.lanes)) {
      progress = lane.progress ?? null;
      if (progress !== null) break;
    }
    progressFill.style.width = progress === null ? "0" : `${clamp(progress, 0, 1) * 100}%`;
    progressTrack.dataset.active = String(progress !== null);
  });

  function adjust(laneView: LaneView, step: number, def: ParamDef, delta: number): void {
    const target = stepOf(laneView, step, def);
    if (!target) return;
    const current = readValue(def, target);
    const next = snap(def, current + delta);
    if (next !== current) write(laneView, step, def, next);
  }

  function toggle(laneView: LaneView, step: number): void {
    const target = stepOf(laneView, step, defOf());
    if (target) target.velocity = target.velocity > 0 ? 0 : 1;
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
    if (!hit || event.button !== 0 || hit.element.dataset.inert === "true") return;
    const def = defOf();
    const current = stepOf(hit.laneView, hit.step, def);
    if (!current) return;
    const rect = hit.element.getBoundingClientRect();
    drag = {
      view: hit.laneView,
      step: hit.step,
      def,
      startY: event.clientY,
      startValue: untracked(() => readValue(def, current)),
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
    const current = stepOf(drag.view, drag.step, drag.def);
    if (!current) return;
    const next = snap(drag.def, drag.startValue + (delta / drag.span) * (drag.def.max - drag.def.min));
    if (next !== untracked(() => readValue(drag!.def, current))) write(drag.view, drag.step, drag.def, next);
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
    if (hit.element.dataset.inert === "true") return;
    toggle(hit.laneView, hit.step);
  });
  on(lanesEl, "focusin", (event: FocusEvent) => {
    const hit = target(event);
    if (hit && hit.element.dataset.inert !== "true") setTabCell(hit.element);
  });
  on(lanesEl, "keydown", (event: KeyboardEvent) => {
    const hit = target(event);
    const lane = hit?.laneView.snap;
    if (!hit || !lane || event.ctrlKey || event.metaKey || hit.element.dataset.inert === "true") return;
    const { laneView, step } = hit;
    const focusStep = (nextLane: LaneView, nextStep: number) => {
      const next = nextLane.snap;
      const element = next && nextLane.cells[clamp(nextStep, 0, next.length - 1)];
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
        focusStep(laneView, event.key === "Home" ? 0 : lane.length - 1);
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
        toggle(laneView, step);
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
    onCell(attach) {
      if (!isActive() || disposed) return () => {};
      const observer: CellObserver = { active: true, attach, cells: new Map(), detach: () => {} };
      observer.detach = own(() => {
        observer.active = false;
        cellObservers.delete(observer);
        for (const [element, cell] of [...observer.cells]) {
          observer.cells.delete(element);
          cell.dispose();
        }
      });
      cellObservers.add(observer);
      try {
        untracked(() => syncCellObserver(observer));
      } catch (error) {
        observer.detach();
        throw error;
      }
      return observer.detach;
    },
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
      if (!isActive()) throw new Error("Plugin attachment is disposed.");
      Object.assign(element.style, { position: "absolute", inset: "0", pointerEvents: "none" });
      surface.append(element);
      return own(() => element.remove());
    },
    addToolbarItem(element) {
      if (!isActive()) throw new Error("Plugin attachment is disposed.");
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
    dispose() {
      if (disposed) return;
      disposed = true;
      plugins.dispose();
      stopActive();
      stopLanes();
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
