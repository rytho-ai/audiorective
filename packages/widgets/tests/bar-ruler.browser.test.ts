/** `mountBarRuler` draws bar/beat ticks from a tempo map and follows its tracked sources. */
import { afterEach, expect, test, vi } from "vitest";
import { cell } from "@audiorective/core";
import { mountBarRuler, type BarRulerOptions, type BarRulerTempoMap } from "../src/arrangement";
import { cleanup, host, own } from "./helpers";

afterEach(cleanup);

/** 120 BPM for 8 beats, then 60 BPM. */
const tempo = (): BarRulerTempoMap => ({
  beatToSeconds: (beat) => (beat <= 8 ? beat / 2 : 4 + (beat - 8)),
  secondsToBeat: (seconds) => (seconds <= 4 ? seconds * 2 : 8 + (seconds - 4)),
});
const constant = (bpm: number): BarRulerTempoMap => ({ beatToSeconds: (beat) => (beat * 60) / bpm, secondsToBeat: (s) => (s * bpm) / 60 });

function mount(extra: Partial<BarRulerOptions> = {}, scale = 100) {
  const root = host();
  const pps = cell(scale);
  const map = cell<BarRulerTempoMap>(constant(120));
  const handle = mountBarRuler(root, { tempoMap: () => map.value, pixelsPerSecond: () => pps.value, duration: () => 16, ...extra });
  own(() => handle.dispose());
  return { root, pps, map, handle, el: handle.element };
}
const bars = (el: HTMLElement) => [...el.querySelectorAll<HTMLElement>(".ar-bar-ruler-bar")];
const left = (node: Element) => Number.parseFloat((node as HTMLElement).style.left);
const labels = (el: HTMLElement) =>
  bars(el)
    .filter((node) => node.dataset.labelled)
    .map((node) => node.textContent);

test("draws bar lines, numbers and beat ticks at a known tempo", () => {
  const { el } = mount();
  // 120 BPM: a 4/4 bar is 2 s = 200 px; 16 s gives bars 1..8 plus the closing line
  expect(el.style.width).toBe("1600px");
  expect(bars(el).slice(0, 3).map(left)).toEqual([0, 200, 400]);
  expect(labels(el).slice(0, 3)).toEqual(["1", "2", "3"]);
  const beats = [...el.querySelectorAll<HTMLElement>('.ar-bar-ruler-beat[data-bar="1"]')];
  expect(beats.map(left)).toEqual([50, 100, 150]);
  expect(beats.map((b) => b.dataset.beat)).toEqual(["2", "3", "4"]);
});

test("follows a time signature and bar labels", () => {
  const { el } = mount({ signature: [6, 8], labels: { bar: (n) => `m${n}` } });
  // 6/8: bar = 3 quarter beats = 1.5 s = 150 px, six eighth-note ticks of 25 px
  expect(bars(el).slice(0, 2).map(left)).toEqual([0, 150]);
  expect(labels(el)[0]).toBe("m1");
  expect([...el.querySelectorAll('.ar-bar-ruler-beat[data-bar="1"]')].map(left)).toEqual([25, 50, 75, 100, 125]);
});

test("a tempo change moves later bars and a swapped tempo map redraws", () => {
  const { el, map } = mount();
  map.value = tempo();
  // beats 0..8 at 120 BPM (bars 1-2), then 60 BPM: bar 3 starts at 4 s, bar 4 at 8 s
  expect(bars(el).slice(0, 5).map(left)).toEqual([0, 200, 400, 800, 1200]);
  map.value = constant(60);
  expect(bars(el).slice(0, 3).map(left)).toEqual([0, 400, 800]);
});

test("zooming out thins labels by powers of two, zooming in adds beat ticks", () => {
  const { el, pps } = mount({}, 100);
  const dense = labels(el).length;
  pps.value = 10; // a bar is 20 px; labels need 56 px, so every 4th bar
  const thin = labels(el);
  expect(thin).toEqual(["1", "5", "9"]);
  expect(dense).toBeGreaterThan(thin.length);
  expect(el.querySelectorAll(".ar-bar-ruler-beat").length).toBe(0);
  pps.value = 400;
  expect(el.querySelectorAll(".ar-bar-ruler-beat").length).toBeGreaterThan(0);
});

test("a viewport limits drawing to the visible bars and redraws on scroll", async () => {
  const root = host();
  root.style.width = "300px";
  root.style.overflow = "auto";
  const handle = mountBarRuler(root, { tempoMap: constant(120), pixelsPerSecond: () => 100, duration: () => 600, viewport: root });
  own(() => handle.dispose());
  const first = bars(handle.element);
  expect(first.length).toBeLessThan(10);
  expect(first[0].dataset.bar).toBe("1");
  root.scrollLeft = 20000;
  await vi.waitFor(() => expect(bars(handle.element)[0].dataset.bar).not.toBe("1"));
  expect(Number(bars(handle.element)[0].dataset.bar)).toBeGreaterThan(80);
});

test("theme variables colour ticks and the playhead follows its getter", () => {
  const playhead = cell<number | null>(null);
  const { root, el } = mount({ playhead: () => playhead.value });
  root.style.setProperty("--ar-ruler-bar-line", "rgb(1, 2, 3)");
  root.style.setProperty("--ar-ruler-playhead", "rgb(4, 5, 6)");
  expect(getComputedStyle(bars(el)[0]).borderLeftColor).toBe("rgb(1, 2, 3)");
  const head = el.querySelector<HTMLElement>(".ar-bar-ruler-playhead")!;
  expect(head.hidden).toBe(true);
  playhead.value = 1.5;
  expect(head.hidden).toBe(false);
  expect(head.style.left).toBe("150px");
  expect(getComputedStyle(head).backgroundColor).toBe("rgb(4, 5, 6)");
});

test("a click seeks, a drag does not, and invalid options throw", async () => {
  const onSeek = vi.fn();
  const { el } = mount({ onSeek });
  const rect = el.getBoundingClientRect();
  const fire = (type: string, x: number) =>
    el.dispatchEvent(new PointerEvent(type, { clientX: rect.left + x, pointerId: 1, button: 0, bubbles: true }));
  fire("pointerdown", 250);
  fire("pointerup", 250);
  expect(onSeek).toHaveBeenCalledWith(2.5);
  fire("pointerdown", 100);
  fire("pointerup", 180);
  expect(onSeek).toHaveBeenCalledTimes(1);
  const root = host();
  expect(() => mountBarRuler(root, { tempoMap: constant(120), pixelsPerSecond: () => 0, duration: () => 4 })).toThrow(
    "Bar ruler needs a positive finite scale",
  );
  expect(() => mountBarRuler(root, { tempoMap: constant(120), signature: [4, 3], pixelsPerSecond: () => 10, duration: () => 4 })).toThrow(
    "time signature",
  );
  expect(() => mountBarRuler(root, { tempoMap: {} as BarRulerTempoMap, pixelsPerSecond: () => 10, duration: () => 4 })).toThrow("tempo map");
});

test("dispose removes the element and stops tracking", () => {
  const { root, handle, pps, el } = mount();
  handle.dispose();
  expect(root.contains(el)).toBe(false);
  pps.value = 50;
  expect(el.querySelectorAll(".ar-bar-ruler-bar").length).toBeGreaterThan(0); // not redrawn
  expect(() => handle.dispose()).not.toThrow();
});
