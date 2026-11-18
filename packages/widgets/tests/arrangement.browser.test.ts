import { afterEach, expect, test, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { attachClipGesture, attachTimelineZoom } from "../src/arrangement";
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
    trackId: "track1",
    time: timeUnit === "beats" ? 4 : 2,
    timeUnit,
    timeMap,
    pixelsPerSecond: () => 100,
    trackAt: () => "track2",
    onMove,
    onOpen,
    onSelect,
  });
  own(() => gesture.destroy());
  return { clip, onMove, onOpen, onSelect };
}

test("drag previews and commits one snapped cross-track move", async () => {
  const { clip, onMove, onOpen } = mounted();
  const rect = clip.getBoundingClientRect();
  const x = rect.x + 20, y = rect.y + 20;
  await pointer({ action: "down", x, y });
  await pointer({ action: "move", x: x + 110, y });
  expect(clip.classList.contains("dragging")).toBe(true);
  expect(clip.style.left).toBe("300px");
  await pointer({ action: "up" });
  expect(onMove).toHaveBeenCalledOnce();
  expect(onMove).toHaveBeenCalledWith({ clipId: "clip1", trackId: "track2", time: 3, kind: "pointer" });
  expect(onOpen).not.toHaveBeenCalled();
});

test("cancel leaves the project untouched; keyboard nudges one musical beat", async () => {
  const { clip, onMove, onOpen } = mounted();
  const rect = clip.getBoundingClientRect();
  const x = rect.x + 20, y = rect.y + 20;
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
  const x = rect.x + 20, y = rect.y + 20;
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
  own(() => zoom.destroy());
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
  zoom.destroy();
  const afterDestroy = scale;
  root.dispatchEvent(new WheelEvent("wheel", { bubbles: true, ctrlKey: true, clientX: x, deltaY: -100 }));
  await new Promise(requestAnimationFrame);
  expect(scale).toBe(afterDestroy);
});
