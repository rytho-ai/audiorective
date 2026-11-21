import { afterEach, expect, test, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { cell, effect } from "@audiorective/core";
import { attachClipGesture, attachTimeRangeGesture, attachTimelineZoom } from "../src/arrangement";
import { cleanup, host, own, pointer } from "./helpers";

afterEach(cleanup);

const timeMap = {
  secondsToBeat(seconds: number) {
    return seconds <= 2 ? seconds * 2 : 4 + seconds - 2;
  },
  beatToSeconds(beat: number) {
    return beat <= 4 ? beat / 2 : 2 + beat - 4;
  },
  snapSeconds(seconds: number) {
    return this.beatToSeconds(Math.round(this.secondsToBeat(seconds)));
  },
};

function mounted(timeUnit: "seconds" | "beats" = "seconds") {
  const root = host();
  root.style.position = "relative";
  root.style.height = "80px";
  const clip = document.createElement("div");
  clip.tabIndex = 0;
  Object.assign(clip.style, { position: "absolute", left: "200px", top: "10px", width: "100px", height: "48px", background: "teal" });
  root.append(clip);
  const onMove = vi.fn();
  const onOpen = vi.fn();
  const onSelect = vi.fn();
  const gesture = attachClipGesture(clip, {
    clipId: "clip1",
    origin: () => ({ trackId: "track1", time: timeUnit === "beats" ? 4 : 2 }),
    timeUnit,
    timeMap,
    pixelsPerSecond: () => 100,
    trackAt: () => "track2",
    onMove,
    onOpen,
    onSelect,
  });
  own(() => gesture.dispose());
  return { clip, onMove, onOpen, onSelect };
}

test("drag previews and commits one snapped cross-track move", async () => {
  const { clip, onMove, onOpen } = mounted();
  const rect = clip.getBoundingClientRect();
  const x = rect.x + 20,
    y = rect.y + 20;
  await pointer({ action: "down", x, y });
  await pointer({ action: "move", x: x + 110, y });
  expect(clip.classList.contains("dragging")).toBe(true);
  expect(clip.style.left).toBe("300px");
  await pointer({ action: "up" });
  expect(onMove).toHaveBeenCalledOnce();
  expect(onMove).toHaveBeenCalledWith({ clipId: "clip1", trackId: "track2", time: 3, kind: "pointer" });
  expect(onOpen).not.toHaveBeenCalled();
});

test("repeated keyboard nudges read the current authored origin without replacing the element", async () => {
  const root = host();
  const clip = document.createElement("button");
  root.append(clip);
  const origin = cell<{ time: number; trackId: string } | undefined>({ time: 2, trackId: "one" });
  const onMove = vi.fn(({ time, trackId }) => (origin.value = { time, trackId }));
  const gesture = attachClipGesture(clip, {
    clipId: "a",
    origin: () => origin.value,
    timeMap,
    pixelsPerSecond: () => 100,
    trackAt: () => undefined,
    onSelect() {},
    onOpen() {},
    onMove,
  });
  own(() => gesture.dispose());
  clip.focus();
  await userEvent.keyboard("{ArrowRight}{ArrowRight}");
  expect(origin.value).toEqual({ time: 4, trackId: "one" });
  expect(onMove).toHaveBeenCalledTimes(2);
  expect(document.activeElement).toBe(clip);
  origin.value = { time: 5, trackId: "two" };
  await userEvent.keyboard("{ArrowLeft}");
  expect(origin.value).toEqual({ time: 4, trackId: "two" });
  origin.value = undefined;
  await userEvent.keyboard("{ArrowRight}{Enter}");
  expect(onMove).toHaveBeenCalledTimes(3);
});

test.each(["dispose", "disable", "replace"] as const)("keyboard commands honor synchronous %s from onSelect", async (action) => {
  const root = host();
  const clip = document.createElement("button");
  root.append(clip);
  const origin = cell<{ time: number; trackId: string } | undefined>({ time: 2, trackId: "one" });
  const onMove = vi.fn();
  const onOpen = vi.fn();
  const gesture = attachClipGesture(clip, {
    clipId: "a",
    origin: () => origin.value,
    timeMap,
    pixelsPerSecond: () => 100,
    trackAt: () => undefined,
    onMove,
    onOpen,
    onSelect() {
      if (action === "dispose") gesture.dispose();
      else if (action === "disable") origin.value = undefined;
      else origin.value = { time: 5, trackId: "two" };
    },
  });
  own(() => gesture.dispose());
  clip.focus();
  await userEvent.keyboard("{ArrowRight}");
  if (action === "replace") expect(onMove).toHaveBeenCalledWith({ clipId: "a", trackId: "two", time: 6, kind: "keyboard" });
  else {
    expect(onMove).not.toHaveBeenCalled();
    await userEvent.keyboard("{Enter}");
    expect(onOpen).not.toHaveBeenCalled();
  }
});

test("disposing from caller focus handling cannot leave a new pointer capture behind", async () => {
  const root = host();
  const clip = document.createElement("button");
  clip.style.cssText = "width:120px;height:50px";
  root.append(clip);
  const gesture = attachClipGesture(clip, {
    clipId: "a",
    origin: () => ({ time: 0, trackId: "one" }),
    timeMap,
    pixelsPerSecond: () => 100,
    trackAt: () => undefined,
    onSelect() {},
    onOpen() {},
    onMove() {},
  });
  own(() => gesture.dispose());
  clip.addEventListener("focus", () => gesture.dispose(), { once: true });
  let pointerId = -1;
  clip.addEventListener("pointerdown", (event) => (pointerId = event.pointerId), { once: true });
  const bounds = clip.getBoundingClientRect();
  await pointer({ action: "down", x: bounds.x + 20, y: bounds.y + 20 });
  expect(clip.hasPointerCapture(pointerId)).toBe(false);
  await pointer({ action: "up" });
});

test.each(["Escape", "lost capture", "external origin", "disabled", "dispose"] as const)(
  "%s cancels a clip preview before a late release",
  async (reason) => {
    const root = host();
    root.style.cssText += ";position:relative;height:90px";
    const clip = document.createElement("button");
    clip.style.cssText = "position:absolute;left:200px;top:0;width:120px;height:60px";
    root.append(clip);
    const origin = cell<{ time: number; trackId: string } | undefined>({ time: 2, trackId: "one" });
    own(
      effect(() => {
        if (origin.value) clip.style.left = `${origin.value.time * 100}px`;
      }),
    );
    const onMove = vi.fn();
    const onOpen = vi.fn();
    const gesture = attachClipGesture(clip, {
      clipId: "a",
      origin: () => origin.value,
      timeMap,
      pixelsPerSecond: () => 100,
      trackAt: () => undefined,
      onSelect() {},
      onOpen,
      onMove,
    });
    own(() => gesture.dispose());
    let pointerId = -1;
    clip.addEventListener("pointerdown", (event) => (pointerId = event.pointerId), { once: true });
    const bounds = clip.getBoundingClientRect();
    await pointer({ action: "down", x: bounds.x + 20, y: bounds.y + 20 });
    await pointer({ action: "move", x: bounds.x + 120, y: bounds.y + 20 });
    expect(clip.classList.contains("dragging")).toBe(true);
    if (reason === "Escape") await userEvent.keyboard("{Escape}");
    else if (reason === "lost capture") {
      clip.releasePointerCapture(pointerId);
      await pointer({ action: "move", x: bounds.x + 121, y: bounds.y + 20 });
    } else if (reason === "external origin") origin.value = { time: 4, trackId: "two" };
    else if (reason === "disabled") origin.value = undefined;
    else {
      gesture.dispose();
      gesture.dispose();
    }
    expect(clip.classList.contains("dragging")).toBe(false);
    expect(clip.style.left).toBe(reason === "external origin" ? "400px" : "200px");
    await pointer({ action: "up" });
    expect(onMove).not.toHaveBeenCalled();
    expect(onOpen).not.toHaveBeenCalled();
  },
);

test("Escape cancels background range selection even when the surface is not focusable", async () => {
  const root = host();
  root.style.height = "80px";
  const onPreview = vi.fn();
  const onSelect = vi.fn();
  const gesture = attachTimeRangeGesture(root, { timeAt: (x) => x / 100, onPreview, onSelect });
  own(() => gesture.dispose());
  const bounds = root.getBoundingClientRect();
  await pointer({ action: "down", x: bounds.x + 20, y: bounds.y + 20 });
  await pointer({ action: "move", x: bounds.x + 120, y: bounds.y + 20 });
  expect(onPreview.mock.lastCall?.[0]).toBeDefined();
  await userEvent.keyboard("{Escape}");
  expect(onPreview).toHaveBeenLastCalledWith(undefined);
  await pointer({ action: "up" });
  expect(onSelect).not.toHaveBeenCalled();
});

test.each([false, true])("zoom follows tracked scale and the native slider domain (explicit bounds: %s)", async (explicit) => {
  const root = host();
  root.style.cssText += ";overflow:auto;height:70px;margin-left:35px";
  const ruler = document.createElement("div");
  root.append(ruler);
  const scale = cell(100);
  const revision = cell(0);
  own(
    effect(() => {
      ruler.style.width = `${scale.value * 16}px`;
      ruler.style.height = "32px";
    }),
  );
  const slider = document.createElement("input");
  slider.type = "range";
  if (explicit) {
    slider.min = "40";
    slider.max = "140";
  }
  root.append(slider);
  const zoom = attachTimelineZoom({
    viewport: root,
    ruler: () => ruler,
    getScale: () => {
      void revision.value;
      return scale.value;
    },
    onScale: (value) => (scale.value = value),
    slider,
  });
  own(() => zoom.dispose());
  scale.value = 200;
  // 200 is two decades into the three-decade 2..2000 range; native step=1 rounds the slider.
  expect(slider.valueAsNumber).toBe(explicit ? 107 : 67);
  slider.value = explicit ? "140" : "100";
  slider.dispatchEvent(new Event("input"));
  await new Promise(requestAnimationFrame);
  expect(scale.value).toBe(2000);
  zoom.zoomTo(500);
  revision.value++;
  await new Promise(requestAnimationFrame);
  expect(scale.value).toBe(500);
  zoom.zoomTo(100);
  scale.value = 300;
  await new Promise(requestAnimationFrame);
  expect(scale.value).toBe(300);
});

test("cancel leaves the project untouched; keyboard nudges one musical beat", async () => {
  const { clip, onMove, onOpen } = mounted();
  const rect = clip.getBoundingClientRect();
  const x = rect.x + 20,
    y = rect.y + 20;
  let pointerId = -1;
  clip.addEventListener("pointerdown", (event) => (pointerId = event.pointerId), { once: true });
  await pointer({ action: "down", x, y });
  await pointer({ action: "move", x: x + 90, y });
  clip.dispatchEvent(new PointerEvent("pointercancel", { pointerId, bubbles: true }));
  await pointer({ action: "up" });
  expect(onMove).not.toHaveBeenCalled();
  expect(clip.style.left).toBe("200px");
  clip.focus();
  await userEvent.keyboard("{ArrowRight}");
  expect(onMove).toHaveBeenCalledWith({ clipId: "clip1", trackId: "track1", time: 3, kind: "keyboard" });
  await userEvent.keyboard("{Enter}");
  expect(onOpen).toHaveBeenCalledOnce();
});

test("beat clip gestures convert pointer geometry but commit native beats", async () => {
  const { clip, onMove } = mounted("beats");
  const rect = clip.getBoundingClientRect();
  const x = rect.x + 20,
    y = rect.y + 20;
  await pointer({ action: "down", x, y });
  await pointer({ action: "move", x: x + 110, y });
  expect(clip.style.left).toBe("300px");
  await pointer({ action: "up" });
  expect(onMove).toHaveBeenCalledWith({ clipId: "clip1", trackId: "track2", time: 5, kind: "pointer" });
  clip.focus();
  await userEvent.keyboard("{ArrowRight}");
  expect(onMove).toHaveBeenCalledWith({ clipId: "clip1", trackId: "track1", time: 5, kind: "keyboard" });
});

test("continuous zoom keeps the time under the pointer and detaches wheel handling", async () => {
  const root = host();
  root.style.overflow = "auto";
  root.style.height = "64px";
  const ruler = document.createElement("div");
  ruler.style.height = "32px";
  ruler.style.width = "1600px";
  root.append(ruler);
  const slider = document.createElement("input");
  slider.type = "range";
  slider.min = "0";
  slider.max = "1000";
  document.body.append(slider);
  own(() => slider.remove());
  let scale = 100;
  const zoom = attachTimelineZoom({
    viewport: root,
    ruler: () => ruler,
    slider,
    getScale: () => scale,
    onScale: (next) => {
      scale = next;
      ruler.style.width = `${16 * scale}px`;
    },
  });
  own(() => zoom.dispose());
  const x = root.getBoundingClientRect().left + 300;
  const timeUnderPointer = () => (x - ruler.getBoundingClientRect().left) / scale;
  expect(timeUnderPointer()).toBeCloseTo(3);
  zoom.zoomTo(200, x);
  await new Promise(requestAnimationFrame);
  expect(scale).toBe(200);
  expect(timeUnderPointer()).toBeCloseTo(3, 2);
  const wheel = new WheelEvent("wheel", { bubbles: true, cancelable: true, ctrlKey: true, clientX: x, deltaY: -100 });
  root.dispatchEvent(wheel);
  await new Promise(requestAnimationFrame);
  expect(wheel.defaultPrevented).toBe(true);
  expect(scale).toBeGreaterThan(200);
  expect(timeUnderPointer()).toBeCloseTo(3, 2);
  zoom.dispose();
  const afterDispose = scale;
  root.dispatchEvent(new WheelEvent("wheel", { bubbles: true, ctrlKey: true, clientX: x, deltaY: -100 }));
  await new Promise(requestAnimationFrame);
  expect(scale).toBe(afterDispose);
});
