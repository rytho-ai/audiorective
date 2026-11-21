import { cell } from "@audiorective/core";
import { afterEach, expect, test, vi } from "vitest";
import { mountClipEnvelopeEditor } from "../src/clip-envelope-editor";
import { cleanup, host, own } from "./helpers";

afterEach(cleanup);

function input(root: HTMLElement, name: string): HTMLInputElement {
  return [...root.querySelectorAll("label")].find((label) => label.firstChild?.textContent === name)!.querySelector("input")!;
}

test("trimmed duration and external envelopes update existing focused fields and commit bounded owner commands", () => {
  const duration = cell(8);
  const envelope = cell({ gain: 1, fadeIn: 2, fadeOut: 1 });
  const commit = vi.fn((next) => {
    envelope.value = next;
  });
  const root = host();
  const editor = mountClipEnvelopeEditor(root, { duration: () => duration.value, envelope, onChange: commit });
  own(() => editor.dispose());
  const fadeIn = input(root, "Fade in (s)");
  const fadeOut = input(root, "Fade out (s)");
  expect(fadeIn.max).toBe("7");
  fadeIn.focus();
  duration.value = 3;
  expect(input(root, "Fade in (s)")).toBe(fadeIn);
  expect(document.activeElement).toBe(fadeIn);
  expect(fadeIn.max).toBe("2");
  expect(fadeOut.max).toBe("1");
  envelope.value = { gain: 0.8, fadeIn: 0.5, fadeOut: 1.5 };
  expect(fadeIn.valueAsNumber).toBe(0.5);
  expect(fadeIn.max).toBe("1.5");
  expect(document.activeElement).toBe(fadeIn);
  expect(commit).not.toHaveBeenCalled();
  fadeOut.value = "99";
  fadeOut.dispatchEvent(new Event("change"));
  expect(commit).toHaveBeenCalledTimes(1);
  expect(envelope.value).toEqual({ gain: 0.8, fadeIn: 0.5, fadeOut: 2.5 });
  editor.dispose();
  editor.dispose();
  envelope.value = { gain: 1.2, fadeIn: 0, fadeOut: 0 };
  duration.value = 10;
  expect(fadeOut.valueAsNumber).toBe(2.5);
  fadeOut.value = "1";
  fadeOut.dispatchEvent(new Event("change"));
  expect(commit).toHaveBeenCalledTimes(1);
  expect(envelope.value).toEqual({ gain: 1.2, fadeIn: 0, fadeOut: 0 });
  expect(root.children).toHaveLength(0);
});

test("a throwing envelope command restores the same focused field from its owner", () => {
  const envelope = cell({ gain: 1, fadeIn: 0, fadeOut: 0 });
  const refusal = new Error("Envelope owner refused");
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
  const editor = mountClipEnvelopeEditor(root, {
    duration: () => 4,
    envelope,
    onChange: () => {
      throw refusal;
    },
  });
  own(() => editor.dispose());
  const gain = input(root, "Clip gain");
  gain.focus();
  gain.value = "1.5";
  gain.dispatchEvent(new Event("change"));
  expect(errors).toEqual([refusal]);
  expect(gain.valueAsNumber).toBe(1);
  expect(document.activeElement).toBe(gain);
});
