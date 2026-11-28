import { cell } from "@audiorective/core";
import { AutomationCurve, type AutomationPoint } from "@audiorective/core/automation";
import { afterEach, expect, test, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { mountAutomationLane } from "../src/automation-lane";
import { cleanup, host, own, pointer } from "./helpers";

afterEach(cleanup);

test("Escape cancels a curve drag before release without writing authored points", async () => {
  const curve = new AutomationCurve([{ time: 1, value: 0.5, shape: "linear" }]);
  const before = curve.value;
  const commit = vi.fn((next) => {
    curve.value = next;
  });
  const root = host();
  const lane = mountAutomationLane(root, { duration: () => 4, points: curve, maxValue: 2, defaultValue: 1, onCommit: commit });
  own(() => lane.dispose());
  const graph = root.querySelector("canvas")!;
  const rect = graph.getBoundingClientRect();
  await pointer({ action: "down", x: rect.left + rect.width / 4, y: rect.top + rect.height * 0.75 });
  await pointer({ action: "move", x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
  await userEvent.keyboard("{Escape}");
  await pointer({ action: "up" });
  expect(commit).not.toHaveBeenCalled();
  expect(curve.value).toBe(before);
});

test("a borrowed curve and tracked beat duration update the same focused controls", () => {
  const curve = new AutomationCurve([{ time: 1, value: 0.5, shape: "linear" }]);
  const duration = cell(4);
  const root = host();
  const lane = mountAutomationLane(root, {
    points: curve,
    duration: () => duration.value,
    timeUnit: "beats",
    maxValue: 2,
    defaultValue: 1,
    onCommit: (next) => {
      curve.value = next;
    },
  });
  own(() => lane.dispose());
  const time = root.querySelector<HTMLInputElement>('[aria-label="Time (beats)"]')!;
  const value = root.querySelector<HTMLInputElement>('[aria-label="Value"]')!;
  const picker = root.querySelector<HTMLSelectElement>('[aria-label="Automation points"]')!;
  expect(time.max).toBe("4");
  expect(picker.options[0].textContent).toBe("1 beats");
  value.focus();
  curve.value = [{ time: 1, value: 1.5, shape: "hold" }];
  duration.value = 2;
  expect(root.querySelector('[aria-label="Value"]')).toBe(value);
  expect(document.activeElement).toBe(value);
  expect(value.valueAsNumber).toBe(1.5);
  expect(time.max).toBe("2");
  expect(root.querySelector<HTMLSelectElement>('[aria-label="Shape"]')!.value).toBe("hold");
});

test.each(["points", "duration", "pointercancel", "lostpointercapture", "dispose"] as const)(
  "%s cancels a stale curve preview before pointer release",
  async (reason) => {
    const curve = new AutomationCurve([{ time: 1, value: 0.5, shape: "linear" }]);
    const duration = cell(4);
    const commit = vi.fn();
    const root = host();
    const lane = mountAutomationLane(root, { duration: () => duration.value, points: curve, maxValue: 2, defaultValue: 1, onCommit: commit });
    own(() => lane.dispose());
    const graph = root.querySelector("canvas")!;
    const field = root.querySelector<HTMLInputElement>('[aria-label="Value"]')!;
    let pointerId = -1;
    graph.addEventListener(
      "pointerdown",
      (event) => {
        pointerId = event.pointerId;
      },
      { once: true },
    );
    const rect = graph.getBoundingClientRect();
    await pointer({ action: "down", x: rect.left + rect.width / 4, y: rect.top + rect.height * 0.75 });
    await pointer({ action: "move", x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
    if (reason === "points") curve.value = [{ time: 1, value: 1.5, shape: "hold" }];
    else if (reason === "duration") duration.value = 2;
    else if (reason === "dispose") lane.dispose();
    else graph.dispatchEvent(new PointerEvent(reason, { pointerId }));
    await pointer({ action: "up" });
    expect(commit).not.toHaveBeenCalled();
    if (reason !== "dispose") {
      expect(root.querySelector('[aria-label="Value"]')).toBe(field);
      expect(field.valueAsNumber).toBe(reason === "points" ? 1.5 : 0.5);
    } else {
      field.value = "1.8";
      field.dispatchEvent(new Event("change"));
      curve.value = [{ time: 1, value: 1.1, shape: "hold" }];
      expect(field.value).toBe("1.8");
      expect(commit).not.toHaveBeenCalled();
      expect(root.children).toHaveLength(0);
    }
  },
);

test("a completed pointer edit commits once and the owner remains authoritative", async () => {
  const curve = cell<readonly AutomationPoint[]>([]);
  const commit = vi.fn((next) => {
    curve.value = next;
  });
  const root = host();
  const lane = mountAutomationLane(root, { duration: () => 4, points: curve, maxValue: 2, defaultValue: 1, onCommit: commit });
  own(() => lane.dispose());
  const rect = root.querySelector("canvas")!.getBoundingClientRect();
  await pointer({ action: "down", x: rect.left + rect.width / 2, y: rect.top + rect.height / 4 });
  await pointer({ action: "up" });
  expect(commit).toHaveBeenCalledTimes(1);
  expect(curve.value).toEqual([
    { time: 0, value: 1, shape: "linear" },
    { time: 2, value: 1.5, shape: "linear" },
  ]);
  const field = root.querySelector<HTMLInputElement>('[aria-label="Value"]')!;
  const time = root.querySelector<HTMLInputElement>('[aria-label="Time (s)"]')!;
  expect(time.valueAsNumber).toBe(2);
  expect(field.valueAsNumber).toBe(1.5);
  curve.value = [{ time: 2, value: 0.3, shape: "hold" }];
  expect(field.valueAsNumber).toBe(0.3);
  expect(commit).toHaveBeenCalledTimes(1);
});

test("Escape restores a dirty numeric field and rejected edits do not create a second point store", async () => {
  const curve = new AutomationCurve([{ time: 1, value: 0.5, shape: "linear" }]);
  const before = curve.value;
  const commit = vi.fn();
  const root = host();
  const lane = mountAutomationLane(root, { duration: () => 4, points: curve, timeUnit: "beats", maxValue: 2, defaultValue: 1, onCommit: commit });
  own(() => lane.dispose());
  const field = root.querySelector<HTMLInputElement>('[aria-label="Value"]')!;
  field.focus();
  field.value = "1.5";
  await userEvent.keyboard("{Escape}");
  field.dispatchEvent(new Event("change"));
  expect(commit).not.toHaveBeenCalled();
  expect(field.valueAsNumber).toBe(0.5);
  const time = root.querySelector<HTMLInputElement>('[aria-label="Time (beats)"]')!;
  time.value = "2";
  time.dispatchEvent(new Event("change"));
  expect(commit).toHaveBeenCalledWith([{ time: 2, value: 0.5, shape: "linear" }]);
  expect(time.valueAsNumber).toBe(1);
  expect(curve.value).toBe(before);
});

test("a throwing owner rolls a numeric edit back to the source and retains focused controls", () => {
  const curve = new AutomationCurve([{ time: 1, value: 0.5, shape: "linear" }]);
  const refusal = new Error("Owner refused the edit");
  const errors: unknown[] = [];
  const capture = (event: ErrorEvent) => {
    if (event.error !== refusal) return;
    errors.push(event.error);
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  window.addEventListener("error", capture, true);
  own(() => window.removeEventListener("error", capture, true));
  const root = host();
  const lane = mountAutomationLane(root, {
    duration: () => 4,
    points: curve,
    maxValue: 2,
    defaultValue: 1,
    onCommit: () => {
      throw refusal;
    },
  });
  own(() => lane.dispose());
  const value = root.querySelector<HTMLInputElement>('[aria-label="Value"]')!;
  value.focus();
  value.value = "1.5";
  value.dispatchEvent(new Event("change"));
  expect(errors).toEqual([refusal]);
  expect(value.valueAsNumber).toBe(0.5);
  expect(document.activeElement).toBe(value);
  expect(curve.value[0].value).toBe(0.5);
});

test("generic owners may clear all points while AutomationCurve keeps its nonempty invariant", () => {
  const curve = new AutomationCurve([{ time: 1, value: 0.5, shape: "linear" }]);
  const before = curve.value;
  const notices: unknown[] = [];
  const curveRoot = host();
  const curveLane = mountAutomationLane(curveRoot, {
    duration: () => 4,
    points: curve,
    maxValue: 2,
    defaultValue: 1,
    onCommit(next) {
      try {
        curve.value = next;
      } catch (error) {
        notices.push(error);
      }
    },
  });
  own(() => curveLane.dispose());
  [...curveRoot.querySelectorAll("button")].find((button) => button.textContent === "Delete point")!.click();
  expect(notices).toHaveLength(1);
  expect(notices[0]).toBeInstanceOf(RangeError);
  expect(curve.value).toBe(before);
  expect(curveRoot.querySelector<HTMLInputElement>('[aria-label="Value"]')!.valueAsNumber).toBe(0.5);

  const points = cell<readonly AutomationPoint[]>(before);
  const arrayRoot = host();
  const arrayLane = mountAutomationLane(arrayRoot, {
    duration: () => 4,
    points,
    maxValue: 2,
    defaultValue: 1,
    onCommit: (next) => {
      points.value = next;
    },
  });
  own(() => arrayLane.dispose());
  [...arrayRoot.querySelectorAll("button")].find((button) => button.textContent === "Delete point")!.click();
  expect(points.value).toEqual([]);
  expect(arrayRoot.querySelector<HTMLInputElement>('[aria-label="Value"]')!.disabled).toBe(true);
});

test.each([0, -1, NaN, Infinity])("an invalid live duration (%s) cancels input without throwing and recovers in place", async (invalid) => {
  const curve = new AutomationCurve([{ time: 1, value: 0.5, shape: "linear" }]);
  const duration = cell(4);
  const commit = vi.fn((next) => {
    curve.value = next;
  });
  const root = host();
  const lane = mountAutomationLane(root, { duration: () => duration.value, points: curve, maxValue: 2, defaultValue: 1, onCommit: commit });
  own(() => lane.dispose());
  const graph = root.querySelector("canvas")!;
  const time = root.querySelector<HTMLInputElement>('[aria-label="Time (s)"]')!;
  const value = root.querySelector<HTMLInputElement>('[aria-label="Value"]')!;
  const controls = [...root.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>("input, select, button")];
  const rect = graph.getBoundingClientRect();
  await pointer({ action: "down", x: rect.left + rect.width / 4, y: rect.top + rect.height * 0.75 });
  await pointer({ action: "move", x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
  expect(() => {
    duration.value = invalid;
  }).not.toThrow();
  expect(controls.every((control) => control.disabled)).toBe(true);
  expect(graph.getAttribute("aria-disabled")).toBe("true");
  await pointer({ action: "up" });
  value.value = "1.9";
  value.dispatchEvent(new Event("change"));
  expect(commit).not.toHaveBeenCalled();
  expect(curve.value).toEqual([{ time: 1, value: 0.5, shape: "linear" }]);
  curve.value = [{ time: 1.5, value: 1.25, shape: "hold" }];
  duration.value = 2;
  expect(root.querySelector('[aria-label="Time (s)"]')).toBe(time);
  expect(root.querySelector('[aria-label="Value"]')).toBe(value);
  expect(controls.every((control) => !control.disabled)).toBe(true);
  expect(graph.getAttribute("aria-disabled")).toBe("false");
  expect(time.max).toBe("2");
  expect(time.valueAsNumber).toBe(1.5);
  expect(value.valueAsNumber).toBe(1.25);
  value.value = "1.75";
  value.dispatchEvent(new Event("change"));
  expect(commit).toHaveBeenCalledTimes(1);
  expect(curve.value).toEqual([{ time: 1.5, value: 1.75, shape: "hold" }]);
});

test("invalid mount duration is rejected before the lane creates its controls", () => {
  const root = host();
  const curve = new AutomationCurve([{ time: 0, value: 1, shape: "linear" }]);
  for (const duration of [0, -1, NaN, Infinity]) {
    expect(() => mountAutomationLane(root, { duration: () => duration, points: curve, maxValue: 2, defaultValue: 1, onCommit() {} })).toThrowError(
      new RangeError("Automation lane needs a positive duration and maximum value."),
    );
    expect(root.children).toHaveLength(0);
  }
});

test("Escape cancels a lane drag, then restores an idle field without blocking its dialog", async () => {
  const root = host();
  const dialog = document.createElement("dialog");
  root.append(dialog);
  own(() => dialog.close());
  const curve = new AutomationCurve([{ time: 1, value: 0.5, shape: "linear" }]);
  const commit = vi.fn();
  const lane = mountAutomationLane(dialog, { duration: () => 4, points: curve, maxValue: 2, defaultValue: 1, onCommit: commit });
  own(() => lane.dispose());
  dialog.showModal();
  const graph = dialog.querySelector("canvas")!;
  const rect = graph.getBoundingClientRect();
  await pointer({ action: "down", x: rect.left + rect.width / 4, y: rect.top + rect.height * 0.75 });
  await pointer({ action: "move", x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
  await userEvent.keyboard("{Escape}");
  await pointer({ action: "up" });
  expect(dialog.open).toBe(true);
  expect(commit).not.toHaveBeenCalled();
  const field = dialog.querySelector<HTMLInputElement>('[aria-label="Value"]')!;
  field.focus();
  field.value = "1.5";
  await userEvent.keyboard("{Escape}");
  await expect.poll(() => dialog.open).toBe(false);
  expect(field.valueAsNumber).toBe(0.5);
  expect(commit).not.toHaveBeenCalled();
});
