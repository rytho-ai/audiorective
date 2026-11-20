/** Note gestures stay in the widget across replaceable layout and SVG/default drawing. */
import { afterEach, expect, test, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { MidiSequence } from "@audiorective/midi";
import { mountPianoRoll, type PianoRollLayout, type PianoRollOptions, type PianoRollRenderer, type WaveformPluginContext } from "../src/piano-roll";
import { cleanup, host, own, pointer } from "./helpers";
afterEach(async () => {
  await cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const alternateLayout: PianoRollLayout = (root, viewport, controls) => {
  root.style.cssText = "display:grid;grid-template-columns:minmax(0,1fr) 80px;min-width:0";
  const keys = document.createElement("aside");
  keys.dataset.customKeys = "";
  const toolbar = document.createElement("footer");
  toolbar.style.gridColumn = "1/-1";
  const zoom = document.createElement("button");
  zoom.textContent = "Zoom custom";
  zoom.dataset.customZoom = "";
  toolbar.append(zoom);
  root.append(viewport, keys, toolbar);
  let factor = 1;
  zoom.onclick = () => controls.setZoom(factor * 2);
  return {
    render(f) {
      factor = f.zoom;
      keys.textContent = `${f.pitches.high}–${f.pitches.low}`;
      keys.style.height = `${f.height}px`;
    },
    dispose() {
      zoom.onclick = null;
      root.replaceChildren();
    },
  };
};
const svgRenderer: PianoRollRenderer = (root) => {
  const ns = "http://www.w3.org/2000/svg",
    svg = document.createElementNS(ns, "svg");
  svg.style.cssText = "width:100%;height:100%;display:block";
  root.append(svg);
  return {
    render(f) {
      svg.setAttribute("viewBox", `0 0 ${f.width} ${f.height}`);
      svg.replaceChildren(
        ...f.notes.map((n) => {
          const rect = document.createElementNS(ns, "rect");
          rect.dataset.customNote = n.id;
          rect.setAttribute("x", String(f.timeToX(n.start)));
          rect.setAttribute("y", String(f.pitchToY(n.pitch)));
          rect.setAttribute("width", String(f.timeToX(n.end) - f.timeToX(n.start)));
          rect.setAttribute("height", String(f.height / (f.pitches.high - f.pitches.low + 1) - 1));
          rect.setAttribute("fill", "orange");
          rect.onpointerdown = (e) => f.onNotePointerDown(n, e);
          rect.onclick = () => f.onNoteClick(n);
          return rect;
        }),
      );
    },
    dispose() {
      svg.remove();
    },
  };
};
function model() {
  const m = new MidiSequence({ duration: 8, notes: [{ id: "n", start: 1, end: 2, pitch: 60, velocity: 100, channel: 0, track: 0 }] });
  own(() => m.dispose());
  return m;
}
function mount(m = model(), extra: Partial<PianoRollOptions> = {}) {
  const root = host();
  const commit = vi.fn((e: any) => m.updateNote(e.note.id, { start: e.note.start, end: e.note.end, pitch: e.note.pitch }));
  const inspect = vi.fn();
  const roll = mountPianoRoll(root, { model: m, pitches: { low: 48, high: 72 }, onNoteEdit: commit, onNoteClick: inspect, ...extra });
  own(() => roll.dispose());
  let ctx!: WaveformPluginContext;
  roll.attach({
    attach(c) {
      ctx = c;
    },
  });
  return { root, roll, m, ctx, commit, inspect };
}
function note(f: ReturnType<typeof mount>) {
  return f.root.querySelector<HTMLElement>('[data-note-id="n"],[data-custom-note="n"]')!;
}
async function begin(f: ReturnType<typeof mount>, edge: "body" | "start" | "end" = "body") {
  f.root.scrollIntoView({ block: "center" });
  const r = note(f).getBoundingClientRect();
  const x = edge === "body" ? r.left + r.width / 2 : edge === "start" ? r.left + 2 : r.right - 2;
  const y = r.top + r.height / 2;
  await pointer({ action: "down", x, y });
  return { x, y };
}
async function move(f: ReturnType<typeof mount>, anchor: { x: number; y: number }, seconds: number, pitches = 0, alt = false) {
  await pointer({
    action: "move",
    x: anchor.x + seconds * f.ctx.getViewport().pixelsPerSecond,
    y: anchor.y - (pitches * f.ctx.getViewport().height) / 25,
    alt,
  });
}
const state = (f: ReturnType<typeof mount>) => f.m.getState().notes[0];

test("move previews locally and commits once to shared model on release", async () => {
  const a = mount(),
    b = mount(a.m);
  const before = a.m.getState().revision,
    anchor = await begin(a);
  await move(a, anchor, 1, 2);
  expect(state(a).start).toBe(1);
  expect(a.m.getState().revision).toBe(before);
  expect(note(a).getBoundingClientRect().left - note(b).getBoundingClientRect().left).toBeCloseTo(a.ctx.getViewport().pixelsPerSecond, 0);
  await pointer({ action: "up" });
  expect(a.commit).toHaveBeenCalledTimes(1);
  expect(state(a)).toMatchObject({ start: 2, end: 3, pitch: 62 });
  expect(a.m.getState().revision).toBe(before + 1);
  expect(note(a).textContent).toBe("D4");
  expect(note(b).textContent).toBe("D4");
  expect(a.inspect).not.toHaveBeenCalled();
});
test("click and keyboard inspection remain independent of editable dragging", async () => {
  const a = mount();
  await userEvent.click(note(a));
  expect(a.inspect).toHaveBeenCalledTimes(1);
  expect(a.commit).not.toHaveBeenCalled();
  note(a).focus();
  await userEvent.keyboard("{Enter}");
  expect(a.inspect).toHaveBeenCalledTimes(2);
});
test.each(["start", "end"] as const)("default note %s edge resizes without moving pitch", async (edge) => {
  const a = mount(),
    anchor = await begin(a, edge);
  await move(a, anchor, edge === "start" ? -0.5 : 0.5, 3);
  await pointer({ action: "up" });
  expect(state(a).start).toBeCloseTo(edge === "start" ? 0.5 : 1, 3);
  expect(state(a).end).toBeCloseTo(edge === "end" ? 2.5 : 2, 3);
  expect(state(a).pitch).toBe(60);
  expect(a.commit).toHaveBeenCalledTimes(1);
  expect(a.commit.mock.calls[0][0].kind).toBe(`resize-${edge}`);
});
test("shared nearest-grid snap and Alt bypass apply to move/resize", async () => {
  const a = mount(undefined, { snap: "beat", grid: { beats: [2, 0, 1, 3, 4], downbeats: [0, 4] } });
  let anchor = await begin(a);
  await move(a, anchor, 0.65);
  await pointer({ action: "up" });
  expect(state(a).start).toBe(2);
  anchor = await begin(a, "end");
  await move(a, anchor, 0.65, 0, true);
  await pointer({ action: "up", alt: true });
  expect(state(a).end).toBeCloseTo(3.65, 1);
  a.roll.setSnap("downbeat");
  a.roll.setGrid({ beats: [0, 1, 2, 3, 4, 5], downbeats: [0, 4, 8] });
  anchor = await begin(a);
  await move(a, anchor, 1.5);
  await pointer({ action: "up" });
  expect(state(a).start).toBe(4);
});
test("move is bounded by source duration and visible MIDI pitch range", async () => {
  const a = mount(),
    anchor = await begin(a);
  await move(a, anchor, 20, 30);
  await pointer({ action: "up" });
  expect(state(a)).toMatchObject({ start: 7, end: 8, pitch: 72 });
  expect(a.commit).toHaveBeenCalledTimes(1);
});
test("resize cannot invert a note or leave source bounds", async () => {
  const a = mount();
  let anchor = await begin(a, "start");
  await move(a, anchor, 5);
  await pointer({ action: "up" });
  expect(state(a).start).toBeCloseTo(1.99, 3);
  expect(state(a).end).toBe(2);
  a.m.updateNote("n", { start: 1, end: 2 });
  anchor = await begin(a, "end");
  await move(a, anchor, 20);
  await pointer({ action: "up" });
  expect(state(a).end).toBe(8);
});
test.each(["Escape", "source", "zoom", "resize", "dispose", "blur", "pointercancel"] as const)(
  "%s cancels preview without stale commit",
  async (kind) => {
    const a = mount(),
      anchor = await begin(a);
    await move(a, anchor, 0.75, 1);
    if (kind === "Escape") await userEvent.keyboard("{Escape}");
    if (kind === "source") a.m.setData({ duration: 8, notes: [{ ...state(a), pitch: 67 }] });
    if (kind === "zoom") a.roll.setZoom(2);
    if (kind === "resize") {
      a.root.style.width = "320px";
      await expect.poll(() => a.ctx.getViewport().width).toBeLessThan(320);
    }
    if (kind === "dispose") a.roll.dispose();
    if (kind === "blur") window.dispatchEvent(new Event("blur"));
    if (kind === "pointercancel") {
      let id = 0;
      a.ctx.surface.addEventListener(
        "pointermove",
        (e) => {
          id = e.pointerId;
        },
        { once: true },
      );
      await move(a, anchor, 0.8, 1);
      a.ctx.surface.dispatchEvent(new PointerEvent("pointercancel", { pointerId: id, bubbles: true }));
    }
    await pointer({ action: "up" });
    expect(a.commit).not.toHaveBeenCalled();
    expect(state(a)).toMatchObject({ start: 1, end: 2, pitch: kind === "source" ? 67 : 60 });
  },
);
test("custom layout and SVG rendering keep widget-owned move and native range selection", async () => {
  const a = mount(undefined, { layout: alternateLayout, renderer: svgRenderer });
  expect(a.root.querySelector("[data-custom-keys]")?.textContent).toBe("72–48");
  expect(a.root.querySelector("[data-testid=piano-zoom-in]")).toBeNull();
  const initialScale = a.ctx.getViewport().pixelsPerSecond;
  await userEvent.click(a.root.querySelector<HTMLElement>("[data-custom-zoom]")!);
  expect(a.ctx.getViewport().pixelsPerSecond).toBeCloseTo(initialScale * 2, 3);
  a.roll.scrollTo(0);
  const anchor = await begin(a);
  await move(a, anchor, 0.5, 1);
  await pointer({ action: "up" });
  expect(state(a).start).toBeCloseTo(1.5, 3);
  expect(state(a).end).toBeCloseTo(2.5, 3);
  expect(state(a).pitch).toBe(61);
  expect(a.commit).toHaveBeenCalledTimes(1);
  a.m.setSelection(null);
  const r = a.ctx.surface.getBoundingClientRect();
  await pointer({ action: "down", x: r.left + a.ctx.timeToX(0.2), y: r.top + r.height * 0.9 });
  await pointer({ action: "move", x: r.left + a.ctx.timeToX(1), y: r.top + r.height * 0.9 });
  await pointer({ action: "up" });
  expect(a.m.getSelection()!.start).toBeCloseTo(0.2, 1);
  expect(a.m.getSelection()!.end).toBeCloseTo(1, 1);
});
test("missing layout viewport rejects cleanly and disposes renderer/layout resources", () => {
  const root = host(),
    m = model(),
    rendererDead = vi.fn(),
    layoutDead = vi.fn();
  expect(() =>
    mountPianoRoll(root, {
      model: m,
      renderer: () => ({ render() {}, dispose: rendererDead }),
      layout: () => ({ render() {}, dispose: layoutDead }),
    }),
  ).toThrow("Piano roll layout must mount its viewport inside the supplied root.");
  expect(root.childElementCount).toBe(0);
  expect(rendererDead).toHaveBeenCalledTimes(1);
  expect(layoutDead).toHaveBeenCalledTimes(1);
});
test("throwing custom layout cleanup preserves renderer cleanup and borrowed model", () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const dead = vi.fn();
  const a = mount(undefined, {
    renderer: () => ({ render() {}, dispose: dead }),
    layout: (root, viewport) => {
      root.append(viewport);
      return {
        render() {},
        dispose() {
          throw Error("layout cleanup");
        },
      };
    },
  });
  a.roll.dispose();
  a.roll.dispose();
  expect(dead).toHaveBeenCalledTimes(1);
  expect(a.root.childElementCount).toBe(0);
  a.m.updateNote("n", { pitch: 70 });
  expect(state(a).pitch).toBe(70);
});

test("borrowed edit callback owns commit; rejected/no-op commands leave no preview store", async () => {
  const command = vi.fn(),
    a = mount(undefined, { onNoteEdit: command });
  let anchor = await begin(a);
  await move(a, anchor, 0.5, 1);
  await pointer({ action: "up" });
  expect(command).toHaveBeenCalledTimes(1);
  expect(state(a)).toMatchObject({ start: 1, end: 2, pitch: 60 });
  expect(note(a).textContent).toBe("C4");
  const log = vi.spyOn(console, "error").mockImplementation(() => {}),
    b = mount(undefined, {
      onNoteEdit: () => {
        throw Error("rejected command");
      },
    });
  anchor = await begin(b);
  await move(b, anchor, 0.5, 1);
  await pointer({ action: "up" });
  expect(state(b)).toMatchObject({ start: 1, end: 2, pitch: 60 });
  expect(log).toHaveBeenCalledTimes(1);
});

test("a custom application model needs no MidiSequence inheritance or mirrored UI store", async () => {
  const root = host(),
    listeners = new Set<() => void>();
  let state = {
    duration: 8,
    selection: null as { start: number; end: number } | null,
    notes: [{ id: "n", start: 1, end: 2, pitch: 60, velocity: 100, channel: 0, track: 0 }],
  };
  const publish = () => {
    for (const listener of [...listeners]) listener();
  };
  const applicationModel = {
    getState: () => state,
    getSelection: () => state.selection,
    setSelection(selection: { start: number; end: number } | null) {
      state = { ...state, selection };
      publish();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const command = vi.fn(({ note }: any) => {
    state = { ...state, notes: state.notes.map((n) => (n.id === note.id ? note : n)) };
    publish();
  });
  const roll = mountPianoRoll(root, {
    model: applicationModel,
    pitches: { low: 48, high: 72 },
    layout: alternateLayout,
    renderer: svgRenderer,
    onNoteEdit: command,
  });
  own(() => roll.dispose());
  let context!: WaveformPluginContext;
  roll.attach({
    attach(ctx) {
      context = ctx;
    },
  });
  root.scrollIntoView({ block: "center" });
  const r = root.querySelector("[data-custom-note=n]")!.getBoundingClientRect();
  await pointer({ action: "down", x: r.left + r.width / 2, y: r.top + r.height / 2 });
  await pointer({ action: "move", x: r.left + r.width / 2 + context.getViewport().pixelsPerSecond, y: r.top + r.height / 2 });
  expect(state.notes[0].start).toBe(1);
  await pointer({ action: "up" });
  expect(command).toHaveBeenCalledTimes(1);
  expect(state.notes[0].start).toBeCloseTo(2, 3);
  roll.dispose();
  expect(listeners.size).toBe(0);
});

test("a vertical-only move preserves an unsnapped onset and freezes the command snapshots", async () => {
  const a = mount(undefined, { snap: "beat", grid: { beats: [0, 1, 2, 3, 4], downbeats: [0, 4] } });
  a.m.updateNote("n", { start: 1.25, end: 2.25 });
  const anchor = await begin(a);
  await move(a, anchor, 0, 2);
  await pointer({ action: "up" });
  expect(state(a)).toMatchObject({ start: 1.25, end: 2.25, pitch: 62 });
  const edit = a.commit.mock.calls[0][0];
  expect(Object.isFrozen(edit)).toBe(true);
  expect(Object.isFrozen(edit.previous)).toBe(true);
  expect(Object.isFrozen(edit.note)).toBe(true);
});
