import { afterEach, describe, expect, test, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { cell, effect } from "@audiorective/core";
import { StepSequencer } from "@audiorective/sequencer";
import { mountStepGrid } from "../src/step-grid";
import type { StepGridLane } from "../src/step-grid-types";
import { cleanup, host, own } from "./helpers";

afterEach(async () => {
  await cleanup();
  vi.restoreAllMocks();
});

describe("step grid cell attachments", () => {
  test("keeps real step subscriptions alive across renders and releases removed cells exactly once", () => {
    const sequencer = new StepSequencer({ kick: "X.", snare: "." });
    own(() => sequencer.dispose());
    const disposeOwner = vi.spyOn(sequencer, "dispose");
    const root = host();
    const grid = mountStepGrid(root, { sequencer });
    own(() => grid.dispose());
    const roots = new Map<string, HTMLElement>();
    const returned = vi.fn();
    const registered = vi.fn();
    const setup = vi.fn();
    const attachment = grid.attach({
      attach(context) {
        return context.onCell((cell) => {
          const key = `${cell.laneId}:${cell.stepIndex}`;
          setup(key);
          expect(cell.step).toBe(sequencer.lanes[cell.laneId as "kick" | "snare"].steps[cell.stepIndex]);
          roots.set(key, cell.root);
          cell.onCleanup(effect(() => (cell.root.textContent = String(cell.step.repeat))));
          cell.onCleanup(() => registered(key));
          return () => returned(key);
        });
      },
    });

    expect([...roots.keys()]).toEqual(["kick:0", "kick:1", "snare:0"]);
    const first = roots.get("kick:0")!;
    sequencer.lanes.snare.muted = true;
    sequencer.lanes.kick.steps[0].velocity = 0.25;
    sequencer.lanes.kick.steps[0].repeat = 3;
    expect(first.textContent).toBe("3");
    expect(setup).toHaveBeenCalledTimes(3);
    expect(registered).not.toHaveBeenCalled();

    sequencer.lanes.kick.length = 1;
    expect(returned.mock.calls).toEqual([["kick:1"]]);
    expect(registered.mock.calls).toEqual([["kick:1"]]);
    expect(roots.get("kick:1")!.isConnected).toBe(false);

    attachment.dispose();
    attachment.dispose();
    grid.dispose();
    grid.dispose();
    expect(returned.mock.calls.map(([key]) => key).sort()).toEqual(["kick:0", "kick:1", "snare:0"]);
    expect(registered.mock.calls.map(([key]) => key).sort()).toEqual(["kick:0", "kick:1", "snare:0"]);
    sequencer.lanes.kick.steps[0].repeat = 5;
    expect(first.textContent).toBe("3");
    expect(disposeOwner).not.toHaveBeenCalled();
  });

  test("follows live lane membership and replaces scopes when the caller replaces a step owner", () => {
    const first = new StepSequencer({ kick: "X.", snare: "X" });
    const replacement = new StepSequencer({ kick: "X" });
    own(() => first.dispose());
    own(() => replacement.dispose());
    const lanes = cell<Record<string, StepGridLane>>({ kick: first.lanes.kick });
    const root = host();
    const grid = mountStepGrid(root, {
      sequencer: {
        get lanes() {
          return lanes.value;
        },
      },
    });
    own(() => grid.dispose());
    const roots = new Map<string, HTMLElement>();
    const attached = vi.fn();
    const released = vi.fn();
    grid.attach({
      attach(context) {
        context.onCell((cell) => {
          const key = `${cell.laneId}:${cell.stepIndex}`;
          roots.set(key, cell.root);
          attached(key);
          cell.onCleanup(effect(() => (cell.root.textContent = String(cell.step.repeat))));
          return () => released(key);
        });
      },
    });
    const initial = roots.get("kick:0")!;
    lanes.value = { kick: first.lanes.kick, snare: first.lanes.snare };
    expect(attached).toHaveBeenCalledTimes(3);
    expect(roots.get("kick:0")).toBe(initial);
    expect(roots.get("snare:0")!.isConnected).toBe(true);

    lanes.value = { kick: replacement.lanes.kick, snare: first.lanes.snare };
    expect(released.mock.calls).toEqual([["kick:0"], ["kick:1"]]);
    expect(initial.isConnected).toBe(false);
    const current = roots.get("kick:0")!;
    replacement.lanes.kick.steps[0].repeat = 4;
    expect(current.textContent).toBe("4");
    first.lanes.kick.steps[0].repeat = 2;
    expect(initial.textContent).toBe("1");
    expect(current.textContent).toBe("4");

    lanes.value = { kick: replacement.lanes.kick };
    expect(roots.get("snare:0")!.isConnected).toBe(false);
    expect(root.querySelector('.ar-sg-lane[data-lane="snare"]')).toBeNull();
    expect(released.mock.calls).toEqual([["kick:0"], ["kick:1"], ["snare:0"]]);
  });

  test("keeps dedicated overlays aligned through resize, tabs and live length without replacing their contents", async () => {
    const sequencer = new StepSequencer({ kick: "X...............", snare: "........" });
    own(() => sequencer.dispose());
    const root = host();
    const indices: number[] = [];
    const grid = mountStepGrid(root, {
      sequencer,
      formatStep: (label, step) => {
        indices.push(step);
        return `${label} ${step + 1}`;
      },
    });
    own(() => grid.dispose());
    const slots = new Map<string, HTMLElement>();
    const setup = vi.fn();
    const click = vi.fn();
    let stopCells!: () => void;
    grid.attach({
      attach(context) {
        stopCells = context.onCell((cell) => {
          setup();
          slots.set(`${cell.laneId}:${cell.stepIndex}`, cell.root);
          const badge = document.createElement("span");
          cell.root.append(badge);
          cell.onCleanup(effect(() => (badge.textContent = `repeat ${cell.step.repeat}`)));
          cell.listen(cell.root, "probe", click);
        });
      },
    });
    const slot = slots.get("kick:0")!;
    const element = root.querySelector<HTMLElement>('.ar-sg-cell[data-lane="kick"][data-step="0"]')!;
    const before = slot.getBoundingClientRect();
    expect(before.width).toBeCloseTo(element.getBoundingClientRect().width - 2 * element.clientLeft, 2);
    expect(before.height).toBeCloseTo(element.getBoundingClientRect().height - 2 * element.clientTop, 2);
    expect(before.left).toBeCloseTo(element.getBoundingClientRect().left + element.clientLeft, 1);
    expect(indices[0]).toBe(0);

    await userEvent.click(root.querySelector<HTMLElement>('[data-parameter="repeat"]')!);
    sequencer.lanes.kick.steps[0].repeat = 5;
    expect(slot.textContent).toBe("repeat 5");
    expect(element.getAttribute("aria-label")).toContain("Repeat x5");
    expect(element.querySelector(".ar-sg-value")!.textContent).toBe("x5");
    expect(setup).toHaveBeenCalledTimes(24);

    root.style.width = "1040px";
    root.style.maxWidth = "none";
    await expect.poll(() => slot.getBoundingClientRect().width).toBeGreaterThan(before.width);
    expect(slot.getBoundingClientRect().width).toBeCloseTo(element.getBoundingClientRect().width - 2 * element.clientLeft, 2);
    sequencer.lanes.snare.length = 20;
    expect(setup).toHaveBeenCalledTimes(36);
    expect(slots.get("kick:0")).toBe(slot);
    expect(slots.has("kick:16")).toBe(false);
    expect(slots.get("snare:19")!.isConnected).toBe(true);
    slot.dispatchEvent(new Event("probe"));
    expect(click).toHaveBeenCalledTimes(1);
    stopCells();
    stopCells();
    slot.dispatchEvent(new Event("probe"));
    expect(click).toHaveBeenCalledTimes(1);
    expect(slot.isConnected).toBe(false);
    expect(element.isConnected).toBe(true);
    expect(sequencer.lanes.kick.steps[0].repeat).toBe(5);
  });

  test("handles disposal during setup and immediately releases late scoped resources", () => {
    const sequencer = new StepSequencer({ kick: "X." });
    own(() => sequencer.dispose());
    const root = host();
    const grid = mountStepGrid(root, { sequencer });
    const registered = vi.fn();
    const returned = vi.fn();
    const outer = vi.fn();
    const late = vi.fn();
    const listener = vi.fn();
    let saved!: import("../src/step-grid-types").StepGridCellContext;
    const setup = vi.fn();
    const attachment = grid.attach({
      attach(context) {
        context.onCell((cell) => {
          setup();
          saved = cell;
          cell.onCleanup(registered);
          grid.dispose();
          return returned;
        });
        return outer;
      },
    });
    attachment.dispose();
    grid.dispose();
    expect(setup).toHaveBeenCalledTimes(1);
    expect(registered).toHaveBeenCalledTimes(1);
    expect(returned).toHaveBeenCalledTimes(1);
    expect(outer).toHaveBeenCalledTimes(1);
    expect(saved.root.isConnected).toBe(false);
    saved.onCleanup(late);
    saved.listen(document, "probe", listener);
    document.dispatchEvent(new Event("probe"));
    expect(late).toHaveBeenCalledTimes(1);
    expect(listener).not.toHaveBeenCalled();
  });

  test("rolls back a failed initial attachment without disturbing other plugins or the grid", () => {
    const sequencer = new StepSequencer({ kick: "X." });
    own(() => sequencer.dispose());
    const root = host();
    const grid = mountStepGrid(root, { sequencer });
    own(() => grid.dispose());
    const survivor = document.createElement("span");
    grid.attach({
      attach(context) {
        context.addToolbarItem(survivor);
      },
    });
    const returned = vi.fn();
    const registered = vi.fn();
    const listener = vi.fn();
    const slots: HTMLElement[] = [];
    expect(() =>
      grid.attach({
        attach(context) {
          context.onCell((cell) => {
            slots.push(cell.root);
            cell.onCleanup(registered);
            cell.listen(document, "probe", listener);
            if (cell.stepIndex === 1) throw new Error("cell setup failed");
            return returned;
          });
        },
      }),
    ).toThrow("cell setup failed");
    expect(registered).toHaveBeenCalledTimes(2);
    expect(returned).toHaveBeenCalledTimes(1);
    expect(slots.every((slot) => !slot.isConnected)).toBe(true);
    expect(survivor.isConnected).toBe(true);
    document.dispatchEvent(new Event("probe"));
    expect(listener).not.toHaveBeenCalled();
    root.querySelector<HTMLElement>('.ar-sg-cell[data-step="1"]')!.click();
    expect(sequencer.lanes.kick.steps[1].velocity).toBe(1);
  });

  test("can detach reentrantly during cell removal without running cleanup twice", () => {
    const sequencer = new StepSequencer({ kick: "X." });
    own(() => sequencer.dispose());
    const grid = mountStepGrid(host(), { sequencer });
    own(() => grid.dispose());
    const cleanupCell = vi.fn();
    const setup = vi.fn();
    let stop!: () => void;
    grid.attach({
      attach(context) {
        stop = context.onCell((cell) => {
          setup();
          return () => {
            cleanupCell(cell.stepIndex);
            if (cell.stepIndex === 1) stop();
          };
        });
      },
    });
    sequencer.lanes.kick.length = 1;
    expect(cleanupCell.mock.calls.map(([step]) => step).sort()).toEqual([0, 1]);
    sequencer.lanes.kick.length = 3;
    stop();
    grid.dispose();
    expect(setup).toHaveBeenCalledTimes(2);
    expect(cleanupCell).toHaveBeenCalledTimes(2);
  });

  test("retires a failing growth observer while other scoped attachments stay usable", () => {
    const sequencer = new StepSequencer({ kick: "X" });
    own(() => sequencer.dispose());
    const root = host();
    const grid = mountStepGrid(root, { sequencer });
    own(() => grid.dispose());
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const registered = vi.fn();
    const returned = vi.fn();
    const failingRoots: HTMLElement[] = [];
    const surviving = new Map<number, HTMLElement>();
    grid.attach({
      attach(context) {
        context.onCell((cell) => {
          failingRoots.push(cell.root);
          cell.onCleanup(registered);
          if (cell.stepIndex === 1) throw new Error("new cell failed");
          return returned;
        });
        context.onCell((cell) => {
          surviving.set(cell.stepIndex, cell.root);
          cell.onCleanup(effect(() => (cell.root.textContent = String(cell.step.repeat))));
        });
      },
    });
    expect(grid.error.value).toBeNull();
    sequencer.lanes.kick.length = 2;
    expect(errors).toHaveBeenCalledTimes(1);
    expect(grid.error.value?.message).toBe("new cell failed");
    expect(registered).toHaveBeenCalledTimes(2);
    expect(returned).toHaveBeenCalledTimes(1);
    expect(surviving.get(1)!.isConnected).toBe(true);
    sequencer.lanes.kick.steps[1].repeat = 3;
    expect(surviving.get(1)!.textContent).toBe("3");
    expect(failingRoots.every((slot) => !slot.isConnected)).toBe(true);
    expect(surviving.get(0)!.isConnected).toBe(true);
    expect(surviving.get(1)!.isConnected).toBe(true);
    sequencer.lanes.kick.length = 3;
    expect(failingRoots).toHaveLength(2);
    expect(surviving.get(2)!.isConnected).toBe(true);
    root.querySelector<HTMLElement>('.ar-sg-cell[data-step="2"]')!.click();
    expect(sequencer.lanes.kick.steps[2].velocity).toBe(1);
  });

  test("does not attach stale sibling cells after setup removes its own lane", () => {
    const owner = new StepSequencer({ kick: "X." });
    own(() => owner.dispose());
    const lanes = cell<Record<string, StepGridLane>>({ kick: owner.lanes.kick });
    const grid = mountStepGrid(host(), {
      sequencer: {
        get lanes() {
          return lanes.value;
        },
      },
    });
    own(() => grid.dispose());
    const setup = vi.fn();
    const cleanupCell = vi.fn();
    grid.attach({
      attach(context) {
        context.onCell((cell) => {
          setup(cell.stepIndex);
          if (cell.stepIndex === 0) lanes.value = {};
          return () => cleanupCell(cell.stepIndex);
        });
      },
    });
    expect(setup.mock.calls).toEqual([[0]]);
    expect(cleanupCell.mock.calls).toEqual([[0]]);
    lanes.value = { kick: owner.lanes.kick };
    expect(setup.mock.calls).toEqual([[0], [0]]);
    expect(cleanupCell.mock.calls).toEqual([[0], [0]]);
  });
});
