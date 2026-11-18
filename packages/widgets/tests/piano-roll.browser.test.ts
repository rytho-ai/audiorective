import { afterEach, expect, test, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { parseMidi, midiGrid } from "@audiorective/midi";
import { MidiSequence } from "@audiorective/midi";
import { mountPianoRoll } from "../src/piano-roll";
import { end, file, off, on, sig, tempo, track } from "../../midi/tests/midi-fixture";
import { drag } from "./helpers";
const disposers: Array<() => void> = [];
afterEach(() => {
  for (const fn of disposers.splice(0).reverse()) fn();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const complex = () =>
  file(
    1,
    96,
    track(sig(0, 4, 4), tempo(0, 500000), tempo(192, 1000000), sig(192, 3, 4), end(384)),
    track(on(0, 60, 50), on(48, 60, 70), off(48, 60), off(48, 60), on(0, 67, 100, 1), off(96, 67, 1), end(528)),
  );

function owner() {
  const m = new MidiSequence();
  m.load(complex());
  disposers.push(() => m.destroy());
  return m;
}
function view(model = owner(), extra: Partial<Parameters<typeof mountPianoRoll>[1]> = {}) {
  const root = document.createElement("div");
  root.style.width = "720px";
  root.style.maxWidth = "100%";
  document.body.append(root);
  disposers.push(() => root.remove());
  const roll = mountPianoRoll(root, { model, ...extra });
  disposers.push(() => roll.destroy());
  return { root, roll, model, surface: root.querySelector<HTMLElement>("[data-testid=piano-roll]")! };
}
function overlays(root: HTMLElement) {
  return ["start", "end"].map((k) => Number(root.querySelector(`[data-testid=selection-${k}]`)?.getAttribute("aria-valuenow")));
}
test("import/mount does not allocate audio; note click inspects rather than plays", async () => {
  const no = vi.fn(() => {
    throw new Error("audio forbidden");
  });
  vi.stubGlobal("AudioContext", no);
  vi.stubGlobal("OfflineAudioContext", no);
  const click = vi.fn();
  const { root } = view(undefined, { onNoteClick: click });
  await userEvent.click(root.querySelectorAll<HTMLButtonElement>("[data-note-id]")[1]);
  expect(click).toHaveBeenCalledTimes(1);
  expect(no).not.toHaveBeenCalled();
});
test("two views share background range drag, snap and keyboard handles", async () => {
  const m = owner(),
    grid = midiGrid(parseMidi(complex()));
  const a = view(m, { grid, snap: "beat" }),
    b = view(m, { grid, snap: "beat" });
  await drag(a.surface, m.getState().duration, 0.3, 1.8);
  expect(m.getSelection()).toEqual({ start: 0.5, end: 2 });
  expect(overlays(a.root)).toEqual([0.5, 2]);
  expect(overlays(b.root)).toEqual([0.5, 2]);
  const grip = b.root.querySelector<HTMLButtonElement>("[data-testid=selection-end]")!;
  grip.focus();
  await userEvent.keyboard("{ArrowRight}");
  expect(m.getSelection()!.end).toBeCloseTo(2.01);
  expect(overlays(a.root)[1]).toBeCloseTo(2.01);
});
test("beat model keeps note labels, grid snap and playhead in beats", async () => {
  const model = new MidiSequence({
    duration: 4,
    notes: [{ id: "beat-note", start: 1, end: 2, pitch: 60, velocity: 90, channel: 0, track: 0 }],
  });
  disposers.push(() => model.destroy());
  const { root, roll, surface } = view(model, { timeUnit: "beats", grid: { beats: [0, 1, 2, 3, 4], downbeats: [0, 4] }, snap: "beat" });
  expect(roll.getViewport()).toMatchObject({ timeUnit: "beats", pixelsPerUnit: surface.clientWidth / 4 });
  expect(root.querySelector('[data-note-id="beat-note"]')?.getAttribute("aria-label")).toContain("1.000 to 2.000 beats");
  roll.setPlayhead(2);
  expect(root.querySelector<HTMLElement>("[data-testid=piano-playhead]")!.style.left).toBe(`${surface.clientWidth / 2}px`);
  await drag(surface, 4, 0.4, 1.6);
  expect(model.getSelection()).toEqual({ start: 0, end: 2 });
});
test("view cleanup preserves owner, selection, peer and caller context", () => {
  const m = owner(),
    a = view(m),
    b = view(m);
  m.setSelection({ start: 1, end: 2 });
  a.roll.destroy();
  m.updateNote(m.getState().notes[0].id, { pitch: 71 });
  expect(overlays(b.root)).toEqual([1, 2]);
  expect(b.root.querySelector("[data-note-id]")).not.toBeNull();
  expect(m.getState().notes.some((n) => n.pitch === 71)).toBe(true);
});
test("custom renderer, pitch geometry, external playhead and resize/zoom", async () => {
  const frames: any[] = [],
    dead = vi.fn();
  const a = view(undefined, { pitches: { low: 48, high: 72 }, renderer: () => ({ render: (frame) => frames.push(frame), destroy: dead }) });
  a.roll.setZoom(2);
  a.roll.scrollTo(0.5);
  a.roll.setPlayhead(1);
  let f = frames.at(-1);
  expect(f.pitchToY(72)).toBe(0);
  expect(f.pitchToY(60)).toBeCloseTo((f.height * 12) / 25);
  expect(a.root.querySelector<HTMLElement>("[data-testid=piano-playhead]")!.style.left).toBe(`${f.timeToX(1)}px`);
  const zoomed = a.roll.getViewport().pixelsPerSecond;
  a.root.style.width = "360px";
  await new Promise((r) => setTimeout(r, 60));
  expect(a.roll.getViewport().pixelsPerSecond).toBeLessThan(zoomed);
  a.roll.destroy();
  expect(dead).toHaveBeenCalledTimes(1);
});
test("empty sequence and invalid viewport commands leave state intact", () => {
  const m = new MidiSequence();
  disposers.push(() => m.destroy());
  const a = view(m);
  expect(a.root.querySelectorAll("[data-note-id]")).toHaveLength(0);
  for (const n of [0, Infinity, 65]) expect(() => a.roll.setZoom(n)).toThrow();
  expect(() => a.roll.setPitchRange({ low: -1, high: 72 })).toThrow();
  expect(() => a.roll.setPlayhead(NaN)).toThrow();
  a.roll.destroy();
  m.destroy();
  expect(() => m.setSelection(null)).toThrow("destroyed");
});

test("compressed keys label octaves without overlapping and large data avoids spread limits", () => {
  const m = new MidiSequence({
    duration: 1,
    notes: Array.from({ length: 150000 }, (_, i) => ({ id: String(i), start: 0, end: 1, pitch: i % 128, velocity: 100, track: 0, channel: 0 })),
  });
  disposers.push(() => m.destroy());
  const a = view(m, { renderer: () => ({ render() {} }) });
  expect(a.roll.getViewport().duration).toBe(1);
  const keys = [...a.root.querySelectorAll<HTMLElement>(".ar-pr-key")];
  expect(keys.filter((k) => k.textContent)).toHaveLength(11);
});
