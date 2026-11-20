import { afterEach, describe, expect, test, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { cell } from "@audiorective/core";
import { StepSequencer, type ParamRange } from "@audiorective/sequencer";
import { mountStepGrid, type StepGridLane, type StepGridPluginContext, type StepGridSequencer, type StepGridStep } from "../src";
import { cleanup, host, own, pointer } from "./helpers";

afterEach(async () => {
  await cleanup();
  vi.restoreAllMocks();
});

const CUTOFF: ParamRange = { min: 100, max: 1100, default: 600, step: 10 };
const PARAMS = { cutoff: CUTOFF };
const capitalize = (name: string) => name[0].toUpperCase() + name.slice(1);

const velocities = (length: number, at: Record<number, number> = {}) => Array.from({ length }, (_, step) => at[step] ?? 0);

function real(options: { params?: boolean } = { params: true }) {
  return new StepSequencer({
    kick: { pattern: velocities(16, { 0: 0.4, 4: 1 }), ...(options.params ? { params: PARAMS } : {}) },
    snare: { pattern: velocities(8, { 2: 0.8 }), rate: "1/8", ...(options.params ? { params: PARAMS } : {}) },
    hat: velocities(16),
  });
}

function mount(sequencer: StepGridSequencer = real()) {
  const root = host();
  root.style.height = "auto";
  const grid = mountStepGrid(root, { sequencer, laneLabel: capitalize });
  own(() => grid.destroy());
  return { root, grid, sequencer };
}

const cellAt = (root: HTMLElement, laneId: string, step: number) =>
  root.querySelector<HTMLElement>(`.ar-sg-cell[data-lane="${laneId}"][data-step="${step}"]`)!;
const laneAt = (root: HTMLElement, laneId: string) => root.querySelector<HTMLElement>(`.ar-sg-lane[data-lane="${laneId}"]`)!;
const tab = (root: HTMLElement, id: string) => root.querySelector<HTMLButtonElement>(`.ar-sg-tab[data-parameter="${id}"]`)!;
const valueOf = (sequencer: StepGridSequencer, id: string, step: number) => sequencer.lanes[id].steps[step];
const toggle = (sequencer: StepGridSequencer, id: string, step: number) => {
  const target = valueOf(sequencer, id, step);
  target.velocity = target.velocity > 0 ? 0 : 1;
};

async function drag(element: HTMLElement, dy: number, finish = true): Promise<void> {
  const rect = element.getBoundingClientRect();
  const x = rect.x + rect.width / 2;
  const y = rect.y + rect.height / 2;
  await pointer({ action: "down", x, y });
  await pointer({ action: "move", x, y: y - dy });
  if (finish) await pointer({ action: "up" });
}

function key(element: HTMLElement, name: string, init: KeyboardEventInit = {}): void {
  element.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true, ...init }));
}

/** The lanes of `source` with `playhead` and `progress` driven by signals (as a transport publishes them) and a `tick` that re-notifies readers. */
function withPlayback(source: StepSequencer) {
  const heads = cell<Readonly<Record<string, number | null>>>({});
  const progress = cell<Readonly<Record<string, number | null>>>({});
  const tick = cell(0);
  const lanes = Object.fromEntries(
    Object.entries(source.lanes).map(([name, live]) => [
      name,
      {
        get length() {
          tick.$();
          return live.length;
        },
        set length(value: number) {
          live.length = value;
        },
        get rate() {
          return live.rate;
        },
        set rate(value: string | number) {
          live.rate = value as typeof live.rate;
        },
        get swing() {
          return live.swing;
        },
        set swing(value: number) {
          live.swing = value;
        },
        get direction() {
          return live.direction;
        },
        set direction(value) {
          live.direction = value;
        },
        get mute() {
          return live.mute;
        },
        set mute(value: boolean) {
          live.mute = value;
        },
        get solo() {
          return live.solo;
        },
        set solo(value: boolean) {
          live.solo = value;
        },
        get params() {
          return live.params;
        },
        get steps() {
          return live.steps;
        },
        get playhead() {
          return heads.value[name] ?? null;
        },
        get progress() {
          return progress.value[name] ?? null;
        },
      } satisfies StepGridLane,
    ]),
  );
  return { sequencer: { lanes } satisfies StepGridSequencer, heads, progress, tick };
}

describe("rendering", () => {
  test("each lane shows its header with the model's values", () => {
    const { root } = mount();
    const snare = laneAt(root, "snare");
    expect(snare.querySelector(".ar-sg-name")!.textContent).toBe("Snare");
    const [steps, swing] = snare.querySelectorAll<HTMLElement>("[role=spinbutton]");
    expect(steps.textContent).toBe("8");
    expect(steps.getAttribute("aria-valuenow")).toBe("8");
    expect(steps.getAttribute("aria-valuemax")).toBe("128");
    expect(steps.getAttribute("aria-label")).toBe("Snare Steps");
    expect(swing.textContent).toBe("0%");
    expect(swing.getAttribute("aria-valuemax")).toBe("100");
    expect(snare.querySelector<HTMLSelectElement>("select")!.value).toBe("1/8");
    expect(snare.querySelectorAll("select option")).toHaveLength(12);
    expect(snare.querySelector(".ar-sg-dir")!.textContent).toBe("→");
    expect(root.querySelectorAll(".ar-sg-lane")).toHaveLength(3);
    expect(root.querySelectorAll(".ar-sg-cell")).toHaveLength(48);
  });

  test("an active cell at full value still shows the on colour beside the value band", () => {
    const { root } = mount();
    const on = cellAt(root, "kick", 4);
    expect(on.dataset.on).toBe("true");
    expect((on.querySelector(".ar-sg-fill") as HTMLElement).style.height).toBe("100%");
    const cap = getComputedStyle(on, "::after");
    expect(parseFloat(cap.height)).toBeGreaterThan(0);
    expect(cap.backgroundColor).toBe(getComputedStyle(on).backgroundColor);
    const fill = getComputedStyle(on.querySelector(".ar-sg-fill")!);
    expect(parseFloat(fill.left)).toBeGreaterThan(0);
  });

  test("a column header row labels the controls and each lane row matches its cell height", () => {
    const { root } = mount();
    expect([...root.querySelectorAll(".ar-sg-colname")].map((item) => item.textContent)).toEqual(["Steps", "Rate", "Dir", "Swing"]);
    const lane = laneAt(root, "kick");
    const height = cellAt(root, "kick", 0).getBoundingClientRect().height;
    expect(lane.getBoundingClientRect().height).toBe(height);
    expect(lane.querySelector(".ar-sg-name")!.getBoundingClientRect().height).toBe(height);
    const heads = [...root.querySelectorAll(".ar-sg-head")].map((item) => item.getBoundingClientRect().width);
    expect(new Set(heads).size).toBe(1);
  });

  test("header controls write the lane", async () => {
    const { root, sequencer } = mount();
    const head = laneAt(root, "snare");
    head.querySelector<HTMLButtonElement>(".ar-sg-mute")!.click();
    expect(sequencer.lanes.snare.mute).toBe(true);
    expect(head.querySelector(".ar-sg-mute")!.getAttribute("aria-pressed")).toBe("true");
    head.querySelector<HTMLButtonElement>(".ar-sg-solo")!.click();
    expect(sequencer.lanes.snare.solo).toBe(true);
    const dir = head.querySelector<HTMLButtonElement>(".ar-sg-dir")!;
    const seen: string[] = [];
    for (let i = 0; i < 3; i++) {
      dir.click();
      seen.push(sequencer.lanes.snare.direction);
    }
    expect(seen).toEqual(["backward", "bounce", "forward"]);
    const rate = head.querySelector<HTMLSelectElement>("select")!;
    rate.value = "1/16T";
    rate.dispatchEvent(new Event("change", { bubbles: true }));
    expect(sequencer.lanes.snare.rate).toBe("1/16T");
    const [steps, swing] = head.querySelectorAll<HTMLElement>("[role=spinbutton]");
    key(steps, "ArrowDown");
    expect(sequencer.lanes.snare.length).toBe(7);
    key(steps, "PageUp");
    expect(sequencer.lanes.snare.length).toBe(17);
    expect(steps.textContent).toBe("17");
    key(steps, "End");
    key(steps, "Home");
    expect(sequencer.lanes.snare.length).toBe(1);
    key(swing, "ArrowUp", { shiftKey: true });
    expect(sequencer.lanes.snare.swing).toBeCloseTo(0.1);
    expect(swing.textContent).toBe("10%");
    steps.focus();
    steps.dispatchEvent(new WheelEvent("wheel", { deltaY: -1, bubbles: true, cancelable: true }));
    expect(sequencer.lanes.snare.length).toBe(2);
  });

  test("a number box is dragged vertically and typed into on double-click", async () => {
    const { root, sequencer } = mount();
    const [steps, swing] = laneAt(root, "snare").querySelectorAll<HTMLElement>("[role=spinbutton]");
    await drag(swing, 30);
    expect(sequencer.lanes.snare.swing).toBeCloseTo(0.1);
    await drag(steps, -16);
    expect(sequencer.lanes.snare.length).toBe(6);
    steps.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    const input = steps.querySelector("input")!;
    expect(steps.dataset.editing).toBe("true");
    input.value = "12";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(sequencer.lanes.snare.length).toBe(12);
    expect(steps.querySelector("input")).toBeNull();
    expect(steps.textContent).toBe("12");
    steps.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    const again = steps.querySelector("input")!;
    again.value = "999";
    again.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(sequencer.lanes.snare.length).toBe(128);
    steps.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    const cancelled = steps.querySelector("input")!;
    cancelled.value = "3";
    cancelled.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(sequencer.lanes.snare.length).toBe(128);
    expect(steps.textContent).toBe("128");
  });

  test("cells beyond a lane's steps are dimmed and inert", () => {
    const { root, sequencer } = mount();
    const beyond = cellAt(root, "snare", 8);
    expect(beyond.dataset.inert).toBe("true");
    expect(beyond.getAttribute("aria-disabled")).toBe("true");
    expect(cellAt(root, "snare", 7).dataset.inert).toBe("false");
    beyond.click();
    expect(sequencer.lanes.snare.steps).toHaveLength(8);
    sequencer.lanes.snare.length = 12;
    expect(beyond.dataset.inert).toBe("false");
    expect(cellAt(root, "snare", 12).dataset.inert).toBe("true");
  });

  test("bar markers and the ruler follow every 4 steps", () => {
    const { root } = mount();
    const ticks = [...root.querySelectorAll(".ar-sg-tick")].map((tick) => tick.textContent);
    expect(ticks.filter(Boolean)).toEqual(["1", "5", "9", "13"]);
    expect(cellAt(root, "kick", 4).dataset.bar).toBe("true");
    expect(cellAt(root, "kick", 3).dataset.bar).toBe("false");
  });

  test("themes through custom properties and uses the root's document", () => {
    const { root } = mount();
    const view = root.querySelector<HTMLElement>(".ar-step-grid")!;
    expect(view.ownerDocument).toBe(root.ownerDocument);
    expect(view.querySelector("style")!.textContent).toContain("--ar-step-cell-on-background");
    view.style.setProperty("--ar-step-cell-height", "50px");
    expect(cellAt(root, "kick", 0).getBoundingClientRect().height).toBe(50);
  });
});

describe("editing", () => {
  test("click toggles a step", () => {
    const { root, sequencer } = mount();
    const element = cellAt(root, "hat", 2);
    element.click();
    expect(valueOf(sequencer, "hat", 2).velocity).toBe(1);
    expect(element.getAttribute("aria-pressed")).toBe("true");
    element.click();
    expect(valueOf(sequencer, "hat", 2).velocity).toBe(0);
  });

  test("dragging up raises velocity and shows the value without toggling", async () => {
    const { root, sequencer } = mount();
    const element = cellAt(root, "kick", 0);
    const height = element.getBoundingClientRect().height;
    await drag(element, height / 4, false);
    expect(element.dataset.editing).toBe("true");
    expect(valueOf(sequencer, "kick", 0).velocity).toBeCloseTo(0.65, 2);
    expect(element.querySelector(".ar-sg-value")!.textContent).toBe("65%");
    await pointer({ action: "up" });
    expect(element.dataset.editing).toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve));
    expect(valueOf(sequencer, "kick", 0).velocity).toBeCloseTo(0.65, 2);
    await drag(element, -height * 2);
    expect(valueOf(sequencer, "kick", 0).velocity).toBe(0);
  });

  test("a drag past the range clamps", async () => {
    const { root, sequencer } = mount();
    await drag(cellAt(root, "kick", 0), 200);
    expect(valueOf(sequencer, "kick", 0).velocity).toBe(1);
  });

  test("offset, chance and length drags stay in range and round", async () => {
    const { root, sequencer } = mount();
    const element = cellAt(root, "kick", 0);
    const height = element.getBoundingClientRect().height;
    tab(root, "offset").click();
    await drag(element, height / 4);
    expect(valueOf(sequencer, "kick", 0).offset).toBeCloseTo(0.25, 2);
    expect(element.querySelector(".ar-sg-value")!.textContent).toBe("+25%");
    await drag(element, 300);
    expect(valueOf(sequencer, "kick", 0).offset).toBe(0.5);
    tab(root, "chance").click();
    await drag(element, -height / 2);
    expect(valueOf(sequencer, "kick", 0).chance).toBeCloseTo(0.5, 2);
    tab(root, "length").click();
    await drag(element, -300);
    expect(valueOf(sequencer, "kick", 0).length).toBe(1 / 16);
    await drag(element, 300);
    expect(valueOf(sequencer, "kick", 0).length).toBe(4);
  });

  test("repeat and pitch drags snap to integers", async () => {
    const { root, sequencer } = mount();
    const element = cellAt(root, "kick", 0);
    tab(root, "repeat").click();
    await drag(element, 25); // 12px per repeat: 1 + 2.08 rounds to 3
    expect(valueOf(sequencer, "kick", 0).repeat).toBe(3);
    expect(element.querySelector(".ar-sg-value")!.textContent).toBe("x3");
    await drag(element, 500);
    expect(valueOf(sequencer, "kick", 0).repeat).toBe(8);
    tab(root, "pitch").click();
    await drag(element, 20); // 3px per semitone: 6.67 rounds to 7
    expect(valueOf(sequencer, "kick", 0).pitch).toBe(7);
    expect(element.querySelector(".ar-sg-value")!.textContent).toBe("+7 st");
    await drag(element, -1000);
    expect(valueOf(sequencer, "kick", 0).pitch).toBe(-24);
    expect(Number.isInteger(valueOf(sequencer, "kick", 0).pitch)).toBe(true);
  });

  test("a custom parameter drags within its own range and step", async () => {
    const { root, sequencer } = mount();
    const element = cellAt(root, "kick", 0);
    tab(root, "cutoff").click();
    const height = element.getBoundingClientRect().height;
    await drag(element, height / 2); // 600 + 500 clamps at 1100
    expect(valueOf(sequencer, "kick", 0).values.cutoff).toBe(1100);
    await drag(element, -height / 2);
    expect(valueOf(sequencer, "kick", 0).values.cutoff).toBeCloseTo(600, 5);
    expect(element.querySelector(".ar-sg-value")!.textContent).toBe("600");
  });

  test("keyboard moves focus with a roving tab stop and edits the active parameter", () => {
    const { root, sequencer } = mount();
    const stops = () => [...root.querySelectorAll<HTMLElement>(".ar-sg-cell")].filter((element) => element.tabIndex === 0);
    expect(stops()).toHaveLength(1);
    const first = cellAt(root, "kick", 0);
    first.focus();
    expect(stops()).toEqual([first]);
    key(first, "ArrowRight");
    expect(document.activeElement).toBe(cellAt(root, "kick", 1));
    expect(stops()).toEqual([cellAt(root, "kick", 1)]);
    key(document.activeElement as HTMLElement, "ArrowLeft");
    key(first, "ArrowLeft");
    expect(document.activeElement).toBe(first);
    key(first, "ArrowUp");
    expect(valueOf(sequencer, "kick", 0).velocity).toBeCloseTo(0.45);
    key(first, "ArrowDown");
    key(first, "ArrowDown");
    expect(valueOf(sequencer, "kick", 0).velocity).toBeCloseTo(0.35);
    key(first, "PageUp");
    expect(valueOf(sequencer, "kick", 0).velocity).toBeCloseTo(0.6);
    key(first, "PageDown");
    key(first, "PageDown");
    key(first, "PageDown");
    expect(valueOf(sequencer, "kick", 0).velocity).toBe(0);
    key(first, "Enter");
    expect(valueOf(sequencer, "kick", 0).velocity).toBe(1);
    key(first, " ");
    expect(valueOf(sequencer, "kick", 0).velocity).toBe(0);
    key(first, "End");
    expect(document.activeElement).toBe(cellAt(root, "kick", 15));
    key(document.activeElement as HTMLElement, "ArrowRight");
    expect(document.activeElement).toBe(cellAt(root, "kick", 15));
    key(document.activeElement as HTMLElement, "ArrowDown", { altKey: true });
    expect(document.activeElement).toBe(cellAt(root, "snare", 7));
    key(document.activeElement as HTMLElement, "ArrowUp", { altKey: true });
    expect(document.activeElement).toBe(cellAt(root, "kick", 7));
  });

  test("keyboard edits snap integers and respect the active tab", () => {
    const { root, sequencer } = mount();
    const first = cellAt(root, "kick", 0);
    first.focus();
    tab(root, "pitch").click();
    key(first, "ArrowUp");
    key(first, "PageUp");
    expect(valueOf(sequencer, "kick", 0).pitch).toBe(13);
    tab(root, "repeat").click();
    key(first, "ArrowUp");
    expect(valueOf(sequencer, "kick", 0).repeat).toBe(2);
    key(first, "ArrowDown");
    key(first, "ArrowDown");
    expect(valueOf(sequencer, "kick", 0).repeat).toBe(1);
  });

  test("a real keypress reaches the grid", async () => {
    const { root, sequencer } = mount();
    cellAt(root, "kick", 1).focus();
    await userEvent.keyboard("{Enter}");
    expect(valueOf(sequencer, "kick", 1).velocity).toBe(1);
    await userEvent.keyboard("{ArrowRight}");
    expect(document.activeElement).toBe(cellAt(root, "kick", 2));
  });

  test("the cells carry accessible names", () => {
    const { root } = mount();
    expect(cellAt(root, "kick", 0).getAttribute("aria-label")).toBe("Kick step 1, Velocity 40%");
    tab(root, "pitch").click();
    expect(cellAt(root, "kick", 0).getAttribute("aria-label")).toBe("Kick step 1, Pitch 0 st");
  });
});

describe("tabs and fold", () => {
  test("built-in tabs come first, then the sequencer's custom params", () => {
    const { root } = mount();
    const names = [...root.querySelectorAll(".ar-sg-tab")].map((element) => element.textContent);
    expect(names).toEqual(["Velocity", "Offset", "Length", "Repeat", "Pitch", "Chance", "cutoff"]);
    expect(tab(root, "velocity").getAttribute("aria-selected")).toBe("true");
    tab(root, "cutoff").click();
    expect(tab(root, "cutoff").getAttribute("aria-selected")).toBe("true");
    expect(tab(root, "velocity").getAttribute("aria-selected")).toBe("false");
    const fill = cellAt(root, "kick", 0).querySelector<HTMLElement>(".ar-sg-fill")!;
    expect(fill.style.height).toBe("50%");
  });

  test("no custom tabs without params, and the views follow the parameter kind", () => {
    const { root } = mount(real({ params: false }));
    expect(root.querySelectorAll(".ar-sg-tab")).toHaveLength(6);
    const view = root.querySelector<HTMLElement>(".ar-step-grid")!;
    expect(view.dataset.kind).toBe("fill");
    tab(root, "pitch").click();
    expect(view.dataset.kind).toBe("centre");
    tab(root, "repeat").click();
    expect(view.dataset.kind).toBe("segments");
    expect(cellAt(root, "kick", 0).querySelector<HTMLElement>(".ar-sg-fill")!.style.getPropertyValue("--ar-sg-n")).toBe("1");
  });

  test("a centre bar grows from the middle in both directions", () => {
    const { root, sequencer } = mount();
    tab(root, "pitch").click();
    sequencer.lanes.kick.steps[0].pitch = 12;
    sequencer.lanes.kick.steps[1].pitch = -12;
    const fills = [0, 1].map((step) => cellAt(root, "kick", step).querySelector<HTMLElement>(".ar-sg-fill")!);
    expect([fills[0].style.height, fills[0].style.bottom]).toEqual(["25%", "50%"]);
    expect([fills[1].style.height, fills[1].style.bottom]).toEqual(["25%", "25%"]);
  });

  test("fold hides lanes with no active step", () => {
    const { root, sequencer } = mount();
    const fold = root.querySelector<HTMLButtonElement>(".ar-sg-fold")!;
    fold.click();
    expect(fold.getAttribute("aria-pressed")).toBe("true");
    expect(laneAt(root, "hat").hidden).toBe(true);
    expect(laneAt(root, "kick").hidden).toBe(false);
    toggle(sequencer, "hat", 3);
    expect(laneAt(root, "hat").hidden).toBe(false);
    toggle(sequencer, "hat", 3);
    expect(laneAt(root, "hat").hidden).toBe(true);
    fold.click();
    expect(laneAt(root, "hat").hidden).toBe(false);
  });
});

describe("per-lane lengths and params", () => {
  test("the grid grows to the longest lane and never shrinks", () => {
    const { root, sequencer } = mount();
    expect(root.querySelectorAll(".ar-sg-tick")).toHaveLength(16);
    sequencer.lanes.snare.length = 24;
    expect(root.querySelectorAll(".ar-sg-tick")).toHaveLength(24);
    expect(root.querySelectorAll(".ar-sg-cell")).toHaveLength(72);
    expect(cellAt(root, "snare", 23).dataset.inert).toBe("false");
    expect(cellAt(root, "kick", 16).dataset.inert).toBe("true");
    expect(cellAt(root, "kick", 16).getAttribute("aria-disabled")).toBe("true");
    sequencer.lanes.snare.length = 4;
    expect(root.querySelectorAll(".ar-sg-cell")).toHaveLength(72);
    expect(cellAt(root, "snare", 4).dataset.inert).toBe("true");
    expect(cellAt(root, "snare", 3).dataset.inert).toBe("false");
  });

  test("lanes of different lengths keep their own steps and edit only visible ones", () => {
    const { root, sequencer } = mount();
    cellAt(root, "snare", 9).click();
    expect(sequencer.lanes.snare.pattern).toBe("..x.....");
    cellAt(root, "snare", 1).click();
    expect(sequencer.lanes.snare.steps[1].velocity).toBe(1);
    expect(sequencer.lanes.kick.steps[1].velocity).toBe(0);
  });

  test("custom tabs are the union by id, the first declaration's range wins, and lanes without the param are dimmed", () => {
    const sequencer = new StepSequencer({
      a: { pattern: "X...", params: { cutoff: { min: 0, max: 10, default: 5 } } },
      b: { pattern: "X...", params: { cutoff: { min: 0, max: 100, default: 50 }, drive: { min: 0, max: 1, default: 0.5 } } },
      c: "X...",
    });
    const { root } = mount(sequencer);
    expect([...root.querySelectorAll(".ar-sg-tab")].map((element) => element.textContent).slice(6)).toEqual(["cutoff", "drive"]);
    tab(root, "cutoff").click();
    expect(cellAt(root, "a", 0).getAttribute("aria-label")).toBe("A step 1, cutoff 5");
    expect(cellAt(root, "b", 0).getAttribute("aria-label")).toBe("B step 1, cutoff 50");
    expect(cellAt(root, "c", 0).dataset.inert).toBe("true");
    tab(root, "drive").click();
    expect(cellAt(root, "a", 0).dataset.inert).toBe("true");
    expect(cellAt(root, "b", 0).dataset.inert).toBe("false");
    cellAt(root, "a", 0).click();
    expect(sequencer.lanes.a.steps[0].velocity).toBe(1);
    cellAt(root, "b", 0).click();
    expect(sequencer.lanes.b.steps[0].velocity).toBe(0);
    tab(root, "velocity").click();
    expect(cellAt(root, "c", 0).dataset.inert).toBe("false");
  });

  test("a lane's own narrower range clamps a custom write", () => {
    const sequencer = new StepSequencer({
      a: { pattern: "X...", params: { cutoff: { min: 0, max: 10, default: 5 } } },
      b: { pattern: "X...", params: { cutoff: { min: 0, max: 4, default: 2 } } },
    });
    const { root } = mount(sequencer);
    tab(root, "cutoff").click();
    for (let i = 0; i < 40; i++) key(cellAt(root, "b", 0), "ArrowUp");
    expect(sequencer.lanes.b.steps[0].values.cutoff).toBe(4);
  });

  test("a rate outside the list is shown as is", () => {
    const { root, sequencer } = mount();
    sequencer.lanes.kick.rate = "16n.";
    expect(laneAt(root, "kick").querySelector<HTMLSelectElement>("select")!.value).toBe("16n.");
    sequencer.lanes.kick.rate = "1/8T";
    expect(laneAt(root, "kick").querySelector<HTMLSelectElement>("select")!.value).toBe("1/8T");
  });

  test("lane names are the labels unless laneLabel renames them", () => {
    const root = host();
    const grid = mountStepGrid(root, { sequencer: real() });
    own(() => grid.destroy());
    expect(laneAt(root, "kick").querySelector(".ar-sg-name")!.textContent).toBe("kick");
    expect(cellAt(root, "kick", 0).getAttribute("aria-label")).toBe("kick step 1, Velocity 40%");
    const named = mount();
    expect(laneAt(named.root, "kick").querySelector(".ar-sg-name")!.textContent).toBe("Kick");
  });
});

describe("playback display", () => {
  test("the playhead highlight and loop progress follow the lanes", () => {
    const model = withPlayback(new StepSequencer({ a: velocities(8), b: velocities(4) }));
    const { root } = mount(model.sequencer);
    const current = () => [...root.querySelectorAll<HTMLElement>(".ar-sg-cell")].filter((element) => element.dataset.current === "true");
    expect(current()).toHaveLength(0);
    const fill = root.querySelector<HTMLElement>(".ar-sg-progress-fill")!;
    expect(fill.style.width).toBe("0px");
    model.heads.value = { a: 5, b: 1 };
    expect(current().map((element) => `${element.dataset.lane}${element.dataset.step}`)).toEqual(["a5", "b1"]);
    model.heads.value = { a: 6, b: null };
    expect(current().map((element) => `${element.dataset.lane}${element.dataset.step}`)).toEqual(["a6"]);
    model.progress.value = { a: 0.25 };
    expect(fill.style.width).toBe("25%");
    model.progress.value = { b: 0.5 };
    expect(fill.style.width).toBe("50%");
    model.progress.value = {};
    expect(fill.parentElement!.dataset.active).toBe("false");
    model.heads.value = {};
    expect(current()).toHaveLength(0);
  });

  test("a playhead on a column the grid grows into is highlighted once it exists", () => {
    const source = new StepSequencer({ a: velocities(4) });
    const model = withPlayback(source);
    const { root } = mount(model.sequencer);
    source.lanes.a.length = 8;
    model.heads.value = { a: 6 };
    expect(cellAt(root, "a", 6).dataset.current).toBe("true");
  });
});

describe("efficiency", () => {
  test("a cell edit leaves every other cell element untouched", async () => {
    const { root, sequencer } = mount();
    const all = [...root.querySelectorAll<HTMLElement>(".ar-sg-cell")];
    const edited = cellAt(root, "kick", 2);
    const records: MutationRecord[] = [];
    const observer = new MutationObserver((list) => records.push(...list));
    observer.observe(root, { subtree: true, childList: true, attributes: true, characterData: true });
    sequencer.lanes.kick.steps[2].velocity = 0.9;
    records.push(...observer.takeRecords());
    expect(records.length).toBeGreaterThan(0);
    expect(
      records.filter((record) => !edited.contains(record.target)).map((r) => `${r.type}:${r.attributeName}:${(r.target as HTMLElement).className}`),
    ).toEqual([]);
    expect([...root.querySelectorAll(".ar-sg-cell")]).toEqual(all);
    observer.disconnect();
  });

  test("a playhead move touches only the old and new cell", () => {
    const model = withPlayback(new StepSequencer({ a: velocities(16), b: velocities(16) }));
    const { root } = mount(model.sequencer);
    model.heads.value = { a: 3 };
    const records: MutationRecord[] = [];
    const observer = new MutationObserver((list) => records.push(...list));
    observer.observe(root, { subtree: true, childList: true, attributes: true, characterData: true });
    model.heads.value = { a: 4 };
    records.push(...observer.takeRecords());
    observer.disconnect();
    const touched = new Set(records.map((record) => (record.target as HTMLElement).dataset.step));
    expect([...touched].sort()).toEqual(["3", "4"]);
  });

  test("a change notification with identical values paints nothing", () => {
    const model = withPlayback(new StepSequencer({ a: velocities(8, { 1: 0.8 }) }));
    const { root } = mount(model.sequencer);
    const observer = new MutationObserver(() => undefined);
    observer.observe(root, { subtree: true, childList: true, attributes: true, characterData: true });
    model.tick.value++;
    expect(observer.takeRecords().map((r) => `${r.type}:${r.attributeName}:${(r.target as HTMLElement).className}`)).toEqual([]);
    observer.disconnect();
  });
});

describe("plugin host", () => {
  function plugged() {
    const mounted = mount();
    let context!: StepGridPluginContext;
    const attachment = mounted.grid.attach({
      attach(ctx) {
        context = ctx;
      },
    });
    return { ...mounted, context, attachment };
  }

  test("attach exposes the surface, sequencer and cell geometry", () => {
    const { root, context, sequencer } = plugged();
    expect(root.contains(context.surface)).toBe(true);
    expect(context.sequencer).toBe(sequencer);
    expect(context.cellElement("kick", 2)).toBe(cellAt(root, "kick", 2));
    expect(context.cellElement("nope", 0)).toBeNull();
    expect(context.cellElement("kick", 99)).toBeNull();
    const rect = context.cellRect("kick", 2)!;
    expect(rect.width).toBeGreaterThan(10);
    expect(rect.height).toBeGreaterThan(10);
    const next = context.cellRect("kick", 3)!;
    expect(next.x).toBeGreaterThan(rect.x);
    expect(context.cellRect("snare", 2)!.y).toBeGreaterThan(rect.y);
    const surface = context.surface.getBoundingClientRect();
    const box = cellAt(root, "kick", 2).getBoundingClientRect();
    expect(rect.x).toBeCloseTo(box.left - surface.left, 3);
    expect(context.cellRect("nope", 0)).toBeNull();
  });

  test("overlays and toolbar items are removed on detach", () => {
    const { root, context, attachment } = plugged();
    const overlay = document.createElement("div");
    const item = document.createElement("button");
    context.mountOverlay(overlay);
    context.addToolbarItem(item);
    expect(context.surface.contains(overlay)).toBe(true);
    expect(overlay.style.pointerEvents).toBe("none");
    expect(root.querySelector(".ar-sg-footer")!.contains(item)).toBe(true);
    attachment.destroy();
    expect(overlay.isConnected).toBe(false);
    expect(item.isConnected).toBe(false);
  });

  test("overlays, toolbar items and listeners are removed when the grid is destroyed", () => {
    const { grid, context } = plugged();
    const overlay = document.createElement("div");
    const item = document.createElement("span");
    const listener = vi.fn();
    const cleanupSpy = vi.fn();
    context.mountOverlay(overlay);
    context.addToolbarItem(item);
    context.listen(context.surface, "probe", listener);
    context.onCleanup(cleanupSpy);
    const surface = context.surface;
    grid.destroy();
    surface.dispatchEvent(new Event("probe"));
    expect(listener).not.toHaveBeenCalled();
    expect(cleanupSpy).toHaveBeenCalledTimes(1);
    expect(overlay.isConnected).toBe(false);
    expect(item.isConnected).toBe(false);
    expect(() => grid.attach({ attach() {} })).toThrow("Step grid is destroyed.");
  });

  test("onPatternChange fires after the grid updates, and stops on detach", () => {
    const { root, context, sequencer, attachment } = plugged();
    const seen: number[] = [];
    context.onPatternChange((lanes) => {
      expect(lanes).toBe(sequencer.lanes);
      seen.push(lanes.hat.steps[1].velocity);
      expect(cellAt(root, "hat", 1).getAttribute("aria-pressed")).toBe(String(lanes.hat.steps[1].velocity > 0));
    });
    toggle(sequencer, "hat", 1);
    toggle(sequencer, "hat", 1);
    expect(seen).toEqual([1, 0]);
    sequencer.lanes.hat.mute = true;
    expect(seen).toEqual([1, 0, 0]);
    seen.length = 0;
    attachment.destroy();
    toggle(sequencer, "hat", 1);
    expect(seen).toEqual([]);
  });

  test("setActiveParameter switches the tab and activeParameter tracks it", () => {
    const { root, context } = plugged();
    expect(context.activeParameter.value).toBe("velocity");
    context.setActiveParameter("pitch");
    expect(context.activeParameter.value).toBe("pitch");
    expect(tab(root, "pitch").getAttribute("aria-selected")).toBe("true");
    context.setActiveParameter("cutoff");
    expect(root.querySelector<HTMLElement>(".ar-step-grid")!.dataset.parameter).toBe("cutoff");
    tab(root, "chance").click();
    expect(context.activeParameter.value).toBe("chance");
    expect(() => context.setActiveParameter("nope")).toThrow('Step grid has no parameter "nope"');
  });

  test("a plugin can write cells through the sequencer", () => {
    const { context, sequencer } = plugged();
    context.sequencer.lanes.hat.steps[4].velocity = 0.5;
    expect(valueOf(sequencer, "hat", 4).velocity).toBe(0.5);
  });

  test("a throwing plugin is isolated and its resources are released", () => {
    const { grid, root, sequencer } = plugged();
    const overlay = document.createElement("div");
    expect(() =>
      grid.attach({
        attach(ctx) {
          ctx.mountOverlay(overlay);
          throw new Error("plugin failed");
        },
      }),
    ).toThrow("plugin failed");
    expect(overlay.isConnected).toBe(false);
    cellAt(root, "hat", 0).click();
    expect(valueOf(sequencer, "hat", 0).velocity).toBe(1);
  });

  test("a listener that throws does not break the grid or other listeners", () => {
    const { context, sequencer } = plugged();
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const good = vi.fn();
    context.onPatternChange(() => {
      throw new Error("listener failed");
    });
    context.onPatternChange(good);
    toggle(sequencer, "hat", 0);
    expect(good).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalled();
  });

  test("a cleanup that throws is logged and the rest still run", () => {
    const { context, attachment } = plugged();
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const overlay = document.createElement("div");
    context.onCleanup(() => {
      throw new Error("cleanup failed");
    });
    context.mountOverlay(overlay);
    attachment.destroy();
    expect(error).toHaveBeenCalled();
    expect(overlay.isConnected).toBe(false);
  });

  test("the same plugin cannot attach twice, and detach is independent", () => {
    const { grid, attachment, context } = plugged();
    const plugin = { attach() {} };
    const first = grid.attach(plugin);
    expect(() => grid.attach(plugin)).toThrow("Plugin is already attached to this step grid.");
    first.destroy();
    expect(() => context.mountOverlay(document.createElement("div"))).not.toThrow();
    attachment.destroy();
    expect(() => context.mountOverlay(document.createElement("div"))).toThrow("destroyed");
  });
});

describe("lifecycle and contract", () => {
  test("destroy removes the view and releases effects and listeners", () => {
    const source = new StepSequencer({ a: velocities(8, { 1: 0.8 }) });
    const model = withPlayback(source);
    const root = host();
    const grid = mountStepGrid(root, { sequencer: model.sequencer });
    const element = cellAt(root, "a", 1);
    const lanes = element.closest(".ar-sg-lanes")!;
    grid.destroy();
    grid.destroy();
    expect(root.querySelector(".ar-step-grid")).toBeNull();
    source.lanes.a.steps[1].velocity = 0;
    source.lanes.a.length = 12;
    model.heads.value = { a: 3 };
    model.progress.value = { a: 0.5 };
    expect(element.getAttribute("aria-pressed")).toBe("true");
    expect(element.dataset.current).toBeUndefined();
    lanes.append(element);
    source.lanes.a.steps[1].velocity = 0.8;
    element.click();
    key(element, "ArrowUp");
    expect(source.lanes.a.steps[1].velocity).toBe(0.8);
  });

  test("works over a hand-written sequencer and reports edits through its members", () => {
    const writes: string[] = [];
    const state = cell({ length: 8, mute: false, velocity: [0, 0.8, 0, 0, 0, 0, 0, 0] });
    const steps: StepGridStep[] = state.value.velocity.map((_, index) => ({
      get velocity() {
        return state.value.velocity[index];
      },
      set velocity(value: number) {
        writes.push(`velocity ${index} ${+value.toFixed(2)}`);
        state.value = { ...state.value, velocity: state.value.velocity.map((item, at) => (at === index ? value : item)) };
      },
      offset: 0,
      length: 1,
      repeat: 1,
      pitch: 0,
      chance: 1,
      values: {},
    }));
    const only: StepGridLane = {
      get length() {
        return state.value.length;
      },
      set length(value: number) {
        writes.push(`length ${value}`);
      },
      rate: "1/16",
      swing: 0,
      direction: "forward",
      get mute() {
        return state.value.mute;
      },
      set mute(value: boolean) {
        writes.push(`mute ${value}`);
        state.value = { ...state.value, mute: value };
      },
      solo: false,
      params: {},
      playhead: null,
      get steps() {
        return steps.slice(0, state.value.length);
      },
    };
    const { root } = mount({ lanes: { a: only } });
    expect(root.querySelectorAll(".ar-sg-tab")).toHaveLength(6);
    expect(laneAt(root, "a").querySelectorAll("select option")).toHaveLength(12);
    cellAt(root, "a", 0).click();
    expect(writes.at(-1)).toBe("velocity 0 1");
    const element = cellAt(root, "a", 1);
    key(element, "ArrowDown");
    expect(writes.at(-1)).toBe("velocity 1 0.75");
    expect(element.getAttribute("aria-label")).toContain("75%");
    laneAt(root, "a").querySelector<HTMLButtonElement>(".ar-sg-mute")!.click();
    expect(writes.at(-1)).toBe("mute true");
    expect(laneAt(root, "a").querySelector(".ar-sg-mute")!.getAttribute("aria-pressed")).toBe("true");
    key(laneAt(root, "a").querySelector<HTMLElement>("[role=spinbutton]")!, "ArrowUp");
    expect(writes.at(-1)).toBe("length 9");
  });

  test("localizes labels and step names", () => {
    const root = host();
    const grid = mountStepGrid(root, {
      sequencer: new StepSequencer({ a: "x..." }),
      laneLabel: (name) => name.toUpperCase(),
      formatStep: (label, step) => `${label} 第 ${step + 1} 格`,
      labels: { velocity: "力度", fold: "收合" },
    });
    own(() => grid.destroy());
    expect(tab(root, "velocity").textContent).toBe("力度");
    expect(root.querySelector(".ar-sg-fold")!.textContent).toBe("收合");
    expect(cellAt(root, "a", 0).getAttribute("aria-label")).toBe("A 第 1 格, 力度 80%");
  });
});
