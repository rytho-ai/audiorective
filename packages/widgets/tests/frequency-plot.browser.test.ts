import { cell } from "@audiorective/core";
import { afterEach, expect, test } from "vitest";
import { userEvent } from "vitest/browser";
import { mountEqEditor, mountSpectrum } from "../src";
import { cleanup, host, own } from "./helpers";

afterEach(cleanup);

test("standalone frequency widgets work with caller-owned controls and FFT bins", async () => {
  const root = host();
  const frequency = cell(1200);
  const eq = mountEqEditor(root, {
    bands: [{ id: "tone", label: "Tone", frequency }],
    readResponse(hz, magnitude) {
      for (let index = 0; index < hz.length; index++) magnitude[index] = hz[index] > frequency.value ? 0.125 : 1;
    },
  });
  own(() => eq.dispose());
  const curve = eq.element.querySelector(".ar-frequency-curve")!;
  const initial = curve.getAttribute("d");
  eq.element.querySelector("button")!.focus();
  await userEvent.keyboard("{ArrowRight}");
  expect(frequency.value).toBeGreaterThan(1200);
  expect(curve.getAttribute("d")).not.toBe(initial);
  let reads = 0;
  const spectrum = mountSpectrum(root, {
    fftSize: 2048,
    sampleRate: 48_000,
    read(bins) {
      reads++;
      bins.fill(-Infinity);
      bins[64] = -6;
      bins[4] = NaN;
    },
  });
  own(() => spectrum.dispose());
  expect(spectrum.element.querySelector(".ar-frequency-curve")?.getAttribute("d")).toContain(" 6.0");
  spectrum.dispose();
  const last = reads;
  await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  expect(reads).toBe(last);
});

test("failed first response releases its borrowed observers and removes the view", () => {
  const root = host();
  const frequency = cell(440);
  let renders = 0;
  expect(() =>
    mountEqEditor(root, {
      bands: [{ id: "tone", label: "Tone", frequency }],
      readResponse() {
        renders++;
        void frequency.value;
        throw new Error("Unavailable sample");
      },
    }),
  ).toThrow("Unavailable sample");
  expect(root.childElementCount).toBe(0);
  frequency.value = 880;
  expect(renders).toBe(1);
});
