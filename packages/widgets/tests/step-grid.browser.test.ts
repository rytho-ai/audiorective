import { afterEach, describe, expect, test, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { cell, readonlyCell } from "@audiorective/core";
import { StepSequencer } from "@audiorective/blocks/sequencer";
import {
  mountStepGrid,
  type StepGridCell,
  type StepGridCellPatch,
  type StepGridLane,
  type StepGridLanePatch,
  type StepGridPattern,
  type StepGridPluginContext,
  type StepGridSequencer,
} from "../src";
import { cleanup, host, own, pointer } from "./helpers";

afterEach(async () => {
  await cleanup();
  vi.restoreAllMocks();
});

const PARAMS = [{ id: "cutoff", label: "Cutoff", min: 100, max: 1100, default: 600, step: 10 }] as const;

function real(options: { params?: boolean } = { params: true }) {
  const sequencer = new StepSequencer(
    {
      size: 16,
      lanes: [
        { id: "kick", label: "Kick", cells: [{ velocity: 0.4 }, {}, {}, {}, { velocity: 1 }] },
        { id: "snare", label: "Snare", steps: 8, rate: "1/8", cells: [{}, {}, { velocity: 0.8 }] },
        { id: "hat", label: "Hat" },
      ],
    },
    () => null,
    options.params ? { params: PARAMS } : {},
  );
  return sequencer;
}

function mount(sequencer: StepGridSequencer = real()) {
  const root = host();
  root.style.height = "auto";
  const grid = mountStepGrid(root, { sequencer });
  own(() => grid.destroy());
  return { root, grid, sequencer };
}

const cellAt = (root: HTMLElement, laneId: string, step: number) =>
  root.querySelector<HTMLElement>(`.ar-sg-cell[data-lane="${laneId}"][data-step="${step}"]`)!;
const laneAt = (root: HTMLElement, laneId: string) => root.querySelector<HTMLElement>(`.ar-sg-lane[data-lane="${laneId}"]`)!;
const tab = (root: HTMLElement, id: string) => root.querySelector<HTMLButtonElement>(`.ar-sg-tab[data-parameter="${id}"]`)!;
const lane = (sequencer: StepSequencer, id: string) => sequencer.pattern.value.lanes.find((item) => item.id === id)!;
const valueOf = (sequencer: StepSequencer, id: string, step: number) => lane(sequencer, id).cells[step];

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

describe("rendering", () => {
  test("each lane shows its header with the model's values", () => {
    const { root } = mount();
    const snare = laneAt(root, "snare");
    expect(snare.querySelector(".ar-sg-name")!.textContent).toBe("Snare");
    expect(snare.querySelector<HTMLInputElement>("input[type=number]")!.value).toBe("8");
    expect(snare.querySelector<HTMLSelectElement>("select")!.value).toBe("1/8");
    expect(snare.querySelectorAll("select option")).toHaveLength(12);
    expect(snare.querySelector(".ar-sg-dir")!.textContent).toBe("→");
    expect(snare.querySelector<HTMLInputElement>("input[max='100']")!.value).toBe("0");
    expect(root.querySelectorAll(".ar-sg-lane")).toHaveLength(3);
    expect(root.querySelectorAll(".ar-sg-cell")).toHaveLength(48);
  });

  test("header controls call setLane", () => {
    const { root, sequencer } = mount();
    const head = laneAt(root, "snare");
    head.querySelector<HTMLButtonElement>(".ar-sg-mute")!.click();
    expect(lane(sequencer, "snare").mute).toBe(true);
    expect(head.querySelector(".ar-sg-mute")!.getAttribute("aria-pressed")).toBe("true");
    head.querySelector<HTMLButtonElement>(".ar-sg-solo")!.click();
    expect(lane(sequencer, "snare").solo).toBe(true);
    const dir = head.querySelector<HTMLButtonElement>(".ar-sg-dir")!;
    const seen: string[] = [];
    for (let i = 0; i < 3; i++) {
      dir.click();
      seen.push(lane(sequencer, "snare").direction);
    }
    expect(seen).toEqual(["backward", "bounce", "forward"]);
    const rate = head.querySelector<HTMLSelectElement>("select")!;
    rate.value = "1/16T";
    rate.dispatchEvent(new Event("change", { bubbles: true }));
    expect(lane(sequencer, "snare").rate).toBe("1/16T");
    const [steps, swing] = head.querySelectorAll<HTMLInputElement>("input[type=number]");
    steps.value = "5";
    steps.dispatchEvent(new Event("change", { bubbles: true }));
    expect(lane(sequencer, "snare").steps).toBe(5);
    swing.value = "25";
    swing.dispatchEvent(new Event("change", { bubbles: true }));
    expect(lane(sequencer, "snare").swing).toBeCloseTo(0.25);
    steps.value = "999";
    steps.dispatchEvent(new Event("change", { bubbles: true }));
    expect(lane(sequencer, "snare").steps).toBe(16);
    expect(steps.value).toBe("16");
  });

  test("cells beyond a lane's steps are dimmed and inert", () => {
    const { root, sequencer } = mount();
    const beyond = cellAt(root, "snare", 8);
    expect(beyond.dataset.inert).toBe("true");
    expect(beyond.getAttribute("aria-disabled")).toBe("true");
    expect(cellAt(root, "snare", 7).dataset.inert).toBe("false");
    beyond.click();
    expect(valueOf(sequencer, "snare", 8).velocity).toBe(0);
    sequencer.setLane("snare", { steps: 12 });
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
    expect(valueOf(sequencer, "kick", 0).custom.cutoff).toBe(1100);
    await drag(element, -height / 2);
    expect(valueOf(sequencer, "kick", 0).custom.cutoff).toBeCloseTo(600, 5);
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
    expect(names).toEqual(["Velocity", "Offset", "Length", "Repeat", "Pitch", "Chance", "Cutoff"]);
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
    sequencer.setCell("kick", 0, { pitch: 12 });
    sequencer.setCell("kick", 1, { pitch: -12 });
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
    sequencer.toggle("hat", 3);
    expect(laneAt(root, "hat").hidden).toBe(false);
    sequencer.toggle("hat", 3);
    expect(laneAt(root, "hat").hidden).toBe(true);
    fold.click();
    expect(laneAt(root, "hat").hidden).toBe(false);
  });
});

function fake(initial: StepGridPattern) {
  const pattern = cell(initial);
  const heads = cell<Readonly<Record<string, number | null>>>({});
  const progress = cell<number | null>(null);
  const calls: Array<[string, ...unknown[]]> = [];
  const replace = (laneId: string, change: (current: StepGridLane) => StepGridLane) => {
    pattern.value = { ...pattern.value, lanes: pattern.value.lanes.map((item) => (item.id === laneId ? change(item) : item)) };
  };
  const sequencer: StepGridSequencer = {
    pattern: readonlyCell(pattern),
    playheads: readonlyCell(heads),
    loopProgress: readonlyCell(progress),
    setCell(laneId: string, step: number, patch: StepGridCellPatch) {
      calls.push(["setCell", laneId, step, patch]);
      replace(laneId, (item) => ({
        ...item,
        cells: item.cells.map((value, index) => (index === step ? { ...value, ...patch, custom: value.custom } : value)),
      }));
    },
    toggle(laneId: string, step: number) {
      calls.push(["toggle", laneId, step]);
      replace(laneId, (item) => ({
        ...item,
        cells: item.cells.map((value, index) => (index === step ? { ...value, velocity: value.velocity > 0 ? 0 : 1 } : value)),
      }));
    },
    setLane(laneId: string, patch: StepGridLanePatch) {
      calls.push(["setLane", laneId, patch]);
      replace(laneId, (item) => ({ ...item, ...patch }));
    },
  };
  return { sequencer, pattern, heads, progress, calls };
}
const plainCell = (velocity = 0): StepGridCell => ({ velocity, offset: 0, length: 1, repeat: 1, pitch: 0, chance: 1 });
const plainLane = (id: string, size: number, on: number[] = [], steps = size): StepGridLane => ({
  id,
  label: id.toUpperCase(),
  steps,
  rate: "1/16",
  direction: "forward",
  swing: 0,
  mute: false,
  solo: false,
  cells: Array.from({ length: size }, (_, step) => plainCell(on.includes(step) ? 0.8 : 0)),
});

describe("playback display", () => {
  test("the playhead highlight and loop progress follow the readables", () => {
    const model = fake({ size: 8, lanes: [plainLane("a", 8), plainLane("b", 8, [], 4)] });
    const { root } = mount(model.sequencer);
    const current = () => [...root.querySelectorAll<HTMLElement>(".ar-sg-cell")].filter((element) => element.dataset.current === "true");
    expect(current()).toHaveLength(0);
    const fill = root.querySelector<HTMLElement>(".ar-sg-progress-fill")!;
    expect(fill.style.width).toBe("0px");
    model.heads.value = { a: 5, b: 1 };
    expect(current().map((element) => `${element.dataset.lane}${element.dataset.step}`)).toEqual(["a5", "b1"]);
    model.heads.value = { a: 6, b: null };
    expect(current().map((element) => `${element.dataset.lane}${element.dataset.step}`)).toEqual(["a6"]);
    model.progress.value = 0.25;
    expect(fill.style.width).toBe("25%");
    model.progress.value = null;
    expect(fill.parentElement!.dataset.active).toBe("false");
    model.heads.value = {};
    expect(current()).toHaveLength(0);
  });

  test("a changed shape adds lanes, removes lanes and resizes cells", () => {
    const model = fake({ size: 4, lanes: [plainLane("a", 4, [0]), plainLane("b", 4)] });
    const { root } = mount(model.sequencer);
    const keep = cellAt(root, "a", 0);
    model.heads.value = { a: 1, c: 5 };
    model.pattern.value = { size: 8, lanes: [plainLane("c", 8), plainLane("a", 8, [0, 6])] };
    expect([...root.querySelectorAll(".ar-sg-lane")].map((element) => (element as HTMLElement).dataset.lane)).toEqual(["c", "a"]);
    expect(root.querySelectorAll(".ar-sg-cell")).toHaveLength(16);
    expect(cellAt(root, "a", 0)).toBe(keep);
    expect(cellAt(root, "c", 5).dataset.current).toBe("true");
    expect(cellAt(root, "a", 6).getAttribute("aria-pressed")).toBe("true");
    model.pattern.value = { size: 2, lanes: [plainLane("a", 2, [1])] };
    expect(root.querySelectorAll(".ar-sg-cell")).toHaveLength(2);
    expect(root.querySelectorAll(".ar-sg-tick")).toHaveLength(2);
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
    sequencer.setCell("kick", 2, { velocity: 0.9 });
    records.push(...observer.takeRecords());
    expect(records.length).toBeGreaterThan(0);
    expect(
      records.filter((record) => !edited.contains(record.target)).map((r) => `${r.type}:${r.attributeName}:${(r.target as HTMLElement).className}`),
    ).toEqual([]);
    expect([...root.querySelectorAll(".ar-sg-cell")]).toEqual(all);
    observer.disconnect();
  });

  test("a playhead move touches only the old and new cell", () => {
    const model = fake({ size: 16, lanes: [plainLane("a", 16), plainLane("b", 16)] });
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

  test("rewriting identical values paints nothing", () => {
    const model = fake({ size: 8, lanes: [plainLane("a", 8, [1])] });
    const { root } = mount(model.sequencer);
    const observer = new MutationObserver(() => undefined);
    observer.observe(root, { subtree: true, childList: true, attributes: true, characterData: true });
    const same = model.pattern.value;
    model.pattern.value = { ...same, lanes: same.lanes.map((item) => ({ ...item, cells: item.cells.map((value) => ({ ...value })) })) };
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
    context.onPatternChange((pattern) => {
      seen.push(pattern.lanes[2].cells[1].velocity);
      expect(cellAt(root, "hat", 1).getAttribute("aria-pressed")).toBe(String(pattern.lanes[2].cells[1].velocity > 0));
    });
    sequencer.toggle("hat", 1);
    sequencer.toggle("hat", 1);
    expect(seen).toEqual([1, 0]);
    attachment.destroy();
    sequencer.toggle("hat", 1);
    expect(seen).toEqual([1, 0]);
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
    context.sequencer.setCell("hat", 4, { velocity: 0.5 });
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
    sequencer.toggle("hat", 0);
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
    const model = fake({ size: 8, lanes: [plainLane("a", 8, [1])] });
    const root = host();
    const grid = mountStepGrid(root, { sequencer: model.sequencer });
    const element = cellAt(root, "a", 1);
    const lanes = element.closest(".ar-sg-lanes")!;
    grid.destroy();
    grid.destroy();
    expect(root.querySelector(".ar-step-grid")).toBeNull();
    model.pattern.value = { size: 8, lanes: [plainLane("a", 8, [2])] };
    model.heads.value = { a: 3 };
    model.progress.value = 0.5;
    expect(element.getAttribute("aria-pressed")).toBe("true");
    expect(element.dataset.current).toBeUndefined();
    lanes.append(element);
    element.click();
    key(element, "ArrowUp");
    expect(model.calls).toEqual([]);
  });

  test("works over a hand-written sequencer and reports edits through its methods", async () => {
    const model = fake({ size: 8, lanes: [plainLane("a", 8, [1])] });
    const { root } = mount(model.sequencer);
    expect(root.querySelectorAll(".ar-sg-tab")).toHaveLength(6);
    cellAt(root, "a", 0).click();
    expect(model.calls.at(-1)).toEqual(["toggle", "a", 0]);
    const element = cellAt(root, "a", 1);
    await drag(element, element.getBoundingClientRect().height / 4);
    expect(model.calls.at(-1)).toEqual(["setCell", "a", 1, { velocity: expect.closeTo(1, 5) }]);
    laneAt(root, "a").querySelector<HTMLButtonElement>(".ar-sg-mute")!.click();
    expect(model.calls.at(-1)).toEqual(["setLane", "a", { mute: true }]);
    expect(laneAt(root, "a").querySelector(".ar-sg-mute")!.getAttribute("aria-pressed")).toBe("true");
  });

  test("localizes labels and step names", () => {
    const model = fake({ size: 4, lanes: [plainLane("a", 4, [0])] });
    const root = host();
    const grid = mountStepGrid(root, {
      sequencer: model.sequencer,
      formatStep: (label, step) => `${label} 第 ${step + 1} 格`,
      labels: { velocity: "力度", fold: "收合" },
    });
    own(() => grid.destroy());
    expect(tab(root, "velocity").textContent).toBe("力度");
    expect(root.querySelector(".ar-sg-fold")!.textContent).toBe("收合");
    expect(cellAt(root, "a", 0).getAttribute("aria-label")).toBe("A 第 1 格, 力度 80%");
  });
});
