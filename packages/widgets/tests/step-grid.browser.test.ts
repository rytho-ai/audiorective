import { afterEach, expect, test } from "vitest";
import { cell, readonlyCell } from "@audiorective/core";
import { mountStepGrid } from "../src";
import { cleanup, host, own } from "./helpers";

afterEach(cleanup);

type Lane = { id: string; label: string; cells: readonly { velocity: number }[] };
const pattern = (size: number, lanes: readonly Lane[]) => ({ size, lanes });
const lane = (id: string, steps: number, on: number[] = []): Lane => ({
  id,
  label: id.toUpperCase(),
  cells: Array.from({ length: steps }, (_, step) => ({ velocity: on.includes(step) ? 0.8 : 0 })),
});

test("the grid rebuilds when the borrowed pattern changes shape", () => {
  const source = cell(pattern(4, [lane("kick", 4, [0])]));
  const current = cell<Record<string, number | null>>({});
  const root = host();
  const view = mountStepGrid(root, {
    sequencer: { pattern: readonlyCell(source), playheads: current, setCell: () => undefined },
  });
  own(() => view.destroy());
  const buttons = () => [...root.querySelectorAll<HTMLButtonElement>("tbody button")];
  expect(buttons()).toHaveLength(4);
  source.value = pattern(8, [lane("kick", 8, [0, 4]), lane("snare", 8, [2])]);
  expect(buttons()).toHaveLength(16);
  expect(buttons().filter((button) => button.getAttribute("aria-pressed") === "true")).toHaveLength(3);
  expect(root.querySelectorAll("thead th")).toHaveLength(9);
  current.value = { kick: 5, snare: 5 };
  expect(buttons().filter((button) => button.dataset.current === "true")).toHaveLength(2);
  source.value = pattern(2, [lane("snare", 2, [1])]);
  expect(buttons()).toHaveLength(2);
  expect(buttons()[1].getAttribute("aria-pressed")).toBe("true");
});
