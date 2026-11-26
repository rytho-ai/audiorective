import { afterEach, expect, test, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { cell } from "@audiorective/core";
import { attachClipGesture, attachClipTrim, attachClipWaveform, type ClipWaveformSource } from "../src/clip";
import { cleanup, host, own, pointer } from "./helpers";

afterEach(cleanup);

const timeMap = {
  secondsToBeat: (seconds: number) => seconds * 2,
  beatToSeconds: (beat: number) => beat / 2,
  snapSeconds: (seconds: number) => Math.round(seconds * 4) / 4,
};

function clipElement(width = 200, height = 40) {
  const root = host();
  root.style.position = "relative";
  root.style.height = "80px";
  const element = document.createElement("div");
  Object.assign(element.style, { position: "absolute", left: "100px", top: "10px", width: `${width}px`, height: `${height}px`, background: "teal" });
  root.append(element);
  return element;
}

/** Four seconds at 1 kHz: the first two seconds peak at 0.2, the last two at 1. */
function halves() {
  const channel = new Float32Array(4000);
  for (let i = 0; i < channel.length; i++) channel[i] = (i < 2000 ? 0.2 : 1) * Math.sin(i / 3);
  return { channels: [channel], sampleRate: 1000 };
}

/** Smallest y of the drawn peaks, in SVG units: lower means a taller wave. */
function topOf(element: HTMLElement): number {
  const d = element.querySelector(".ar-peaks")!.getAttribute("d")!;
  return Math.min(...[...d.matchAll(/M[\d.]+,([\d.]+)V/g)].map((m) => Number(m[1])));
}

test("clip waveform draws only its window and fills the element", async () => {
  const element = clipElement();
  const source = cell<ClipWaveformSource | undefined>({ data: halves(), sourceOffset: 2, duration: 2 });
  const handle = attachClipWaveform(element, { clip: () => source.value });
  own(() => handle.dispose());
  const svg = element.querySelector("svg")!;
  const ratio = devicePixelRatio;
  await vi.waitFor(() => expect(svg.getAttribute("viewBox")).toBe(`0 0 ${Math.round(200 * ratio)} ${Math.round(40 * ratio)}`));
  const height = Math.round(40 * ratio);
  const loud = topOf(element);
  expect(loud).toBeLessThan(height * 0.1);
  expect(element.querySelector(".ar-toolbar, .ar-ruler")).toBeNull();
  source.value = { data: halves(), sourceOffset: 0, duration: 2 };
  await vi.waitFor(() => expect(topOf(element)).toBeGreaterThan(height * 0.3));
  source.value = undefined;
  await vi.waitFor(() => expect(element.querySelector(".ar-peaks")!.getAttribute("d")).toBe(""));
});

test("clip waveform redraws on resize and takes precomputed peaks", async () => {
  const element = clipElement(100, 40);
  const handle = attachClipWaveform(element, {
    clip: () => ({ data: { min: new Float32Array([-0.5, -0.5]), max: new Float32Array([0.5, 0.5]), duration: 2 }, sourceOffset: 0, duration: 2 }),
  });
  own(() => handle.dispose());
  const svg = element.querySelector("svg")!;
  await vi.waitFor(() => expect(svg.getAttribute("viewBox")).toContain(`${Math.round(100 * devicePixelRatio)} `));
  element.style.width = "160px";
  await vi.waitFor(() => expect(svg.getAttribute("viewBox")).toContain(`${Math.round(160 * devicePixelRatio)} `));
});

test("clip waveform uses the --waveform-accent variable and removes itself on dispose", async () => {
  const element = clipElement();
  element.style.setProperty("--waveform-accent", "rgb(255, 0, 0)");
  element.style.position = "static";
  const handle = attachClipWaveform(element, { clip: () => ({ data: halves(), sourceOffset: 0, duration: 4 }) });
  expect(getComputedStyle(element).position).toBe("relative");
  await vi.waitFor(() => expect(getComputedStyle(element.querySelector(".ar-peaks")!).stroke).toBe("rgb(255, 0, 0)"));
  handle.dispose();
  handle.dispose();
  expect(element.querySelector(".ar-clip-waveform")).toBeNull();
  expect(element.style.position).toBe("");
});

type Origin = { time: number; duration: number } | undefined;
function trimmed(options: { edges?: readonly ("start" | "end")[]; bounds?: () => { start?: number; end?: number }; snap?: boolean } = {}) {
  const element = clipElement(200, 40);
  const origin = cell<Origin>({ time: 1, duration: 2 });
  const onCommit = vi.fn();
  const handle = attachClipTrim(element, {
    origin: () => origin.value,
    timeMap,
    pixelsPerSecond: () => 100,
    snap: options.snap === false ? undefined : timeMap.snapSeconds,
    bounds: options.bounds,
    edges: options.edges,
    onCommit,
  });
  own(() => handle.dispose());
  return { element, origin, onCommit, handle };
}
const edgeOf = (element: HTMLElement, edge: "start" | "end") => element.querySelector<HTMLElement>(`.ar-clip-trim-${edge}`)!;
const centre = (e: HTMLElement) => {
  const r = e.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
};

test("dragging the start edge previews, snaps and commits absolute positions", async () => {
  const { element, onCommit } = trimmed();
  const { x, y } = centre(edgeOf(element, "start"));
  await pointer({ action: "down", x, y });
  await pointer({ action: "move", x: x + 30, y });
  expect(element.style.left).toBe("125px");
  expect(element.style.width).toBe("175px");
  await pointer({ action: "up" });
  // 1s + 0.3s snaps to 1.25s on the quarter-second grid.
  expect(onCommit).toHaveBeenCalledExactlyOnceWith({ start: 1.25 });
  expect(element.style.left).toBe("100px");
  expect(element.style.width).toBe("200px");
});

test("dragging the end edge honours bounds, and Alt bypasses snapping", async () => {
  const { element, onCommit } = trimmed({ bounds: () => ({ end: 3.5 }) });
  const { x, y } = centre(edgeOf(element, "end"));
  await pointer({ action: "down", x, y });
  await pointer({ action: "move", x: x + 90, y });
  expect(element.style.width).toBe("250px");
  await pointer({ action: "up" });
  expect(onCommit).toHaveBeenCalledExactlyOnceWith({ end: 3.5 });
  onCommit.mockClear();
  await pointer({ action: "down", x, y });
  await pointer({ action: "move", x: x + 13, y, alt: true });
  await pointer({ action: "up", alt: true });
  expect(onCommit).toHaveBeenCalledExactlyOnceWith({ end: 3.13 });
});

test("Escape and an unchanged drag commit nothing and restore the preview", async () => {
  const { element, onCommit } = trimmed();
  const { x, y } = centre(edgeOf(element, "end"));
  await pointer({ action: "down", x, y });
  await pointer({ action: "move", x: x - 40, y });
  expect(element.style.width).not.toBe("200px");
  await userEvent.keyboard("{Escape}");
  expect(element.style.width).toBe("200px");
  expect(element.style.left).toBe("100px");
  await pointer({ action: "up" });
  await pointer({ action: "down", x, y });
  await pointer({ action: "move", x: x + 4, y });
  await pointer({ action: "up" });
  expect(onCommit).not.toHaveBeenCalled();
});

test("the edges option limits the handles", () => {
  const { element } = trimmed({ edges: ["end"] });
  expect(element.querySelector(".ar-clip-trim-start")).toBeNull();
  expect(element.querySelector(".ar-clip-trim-end")).not.toBeNull();
});

test("arrow keys move the focused edge by a snap step and Shift by four", async () => {
  const { element, onCommit } = trimmed();
  edgeOf(element, "end").focus();
  await userEvent.keyboard("{ArrowRight}");
  expect(onCommit).toHaveBeenLastCalledWith({ end: 3.25 });
  await userEvent.keyboard("{Shift>}{ArrowLeft}{/Shift}");
  expect(onCommit).toHaveBeenLastCalledWith({ end: 2 });
  edgeOf(element, "start").focus();
  await userEvent.keyboard("{ArrowRight}");
  expect(onCommit).toHaveBeenLastCalledWith({ start: 1.25 });
});

test("a changed origin cancels a stale drag", async () => {
  const { element, origin, onCommit } = trimmed();
  const { x, y } = centre(edgeOf(element, "end"));
  await pointer({ action: "down", x, y });
  await pointer({ action: "move", x: x + 50, y });
  origin.value = { time: 1, duration: 3 };
  await pointer({ action: "up" });
  expect(onCommit).not.toHaveBeenCalled();
});

test("trim coexists with the move gesture: edges never move, the body still does", async () => {
  const { element, onCommit } = trimmed();
  const onMove = vi.fn();
  const gesture = attachClipGesture(element, {
    clipId: "c",
    origin: () => ({ time: 1, trackId: "t" }),
    timeMap,
    pixelsPerSecond: () => 100,
    trackAt: () => undefined,
    onSelect() {},
    onOpen() {},
    onMove,
  });
  own(() => gesture.dispose());
  const edge = centre(edgeOf(element, "end"));
  await pointer({ action: "down", x: edge.x, y: edge.y });
  await pointer({ action: "move", x: edge.x + 30, y: edge.y });
  await pointer({ action: "up" });
  expect(onMove).not.toHaveBeenCalled();
  expect(onCommit).toHaveBeenCalledOnce();
  const body = centre(element);
  await pointer({ action: "down", x: body.x, y: body.y });
  await pointer({ action: "move", x: body.x + 50, y: body.y });
  await pointer({ action: "up" });
  expect(onMove).toHaveBeenCalledExactlyOnceWith({ clipId: "c", trackId: "t", time: 1.5, kind: "pointer" });
  expect(onCommit).toHaveBeenCalledOnce();
});

test("dispose removes the handles and later drags do nothing", async () => {
  const { element, onCommit, handle } = trimmed();
  const { x, y } = centre(edgeOf(element, "start"));
  handle.dispose();
  handle.dispose();
  expect(element.querySelector(".ar-clip-trim")).toBeNull();
  await pointer({ action: "down", x, y });
  await pointer({ action: "move", x: x + 40, y });
  await pointer({ action: "up" });
  expect(onCommit).not.toHaveBeenCalled();
});

test("Enter and Space on a trim handle do not open the clip through a shared gesture", async () => {
  const { element } = trimmed();
  const onOpen = vi.fn();
  const gesture = attachClipGesture(element, {
    clipId: "c",
    origin: () => ({ time: 1, trackId: "t" }),
    timeMap,
    pixelsPerSecond: () => 100,
    trackAt: () => undefined,
    onSelect() {},
    onOpen,
    onMove() {},
  });
  own(() => gesture.dispose());
  const handle = edgeOf(element, "start");
  handle.focus();
  await userEvent.keyboard("{Enter}");
  await userEvent.keyboard(" ");
  expect(onOpen).not.toHaveBeenCalled();
});

test("both edges of a 4px clip stay reachable", () => {
  const element = clipElement(4, 40);
  const handle = attachClipTrim(element, { origin: () => ({ time: 1, duration: 2 }), timeMap, pixelsPerSecond: () => 100, onCommit() {} });
  own(() => handle.dispose());
  const r = element.getBoundingClientRect();
  const y = r.y + 20;
  expect(document.elementFromPoint(r.x + 0.5, y)).toBe(edgeOf(element, "start"));
  expect(document.elementFromPoint(r.x + r.width - 0.5, y)).toBe(edgeOf(element, "end"));
});
