/** Note gestures stay in the widget across replaceable layout and SVG/default drawing. */
import { cell, effect } from "@audiorective/core";
import { afterEach, expect, test, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { mountPianoRoll, type PianoRollLayout, type PianoRollOptions, type PianoRollRenderer, type WaveformPluginContext } from "../src/piano-roll";
import { cleanup, host, own, pointer, rollModel } from "./helpers";
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
          rect.setAttribute("width", String(f.timeToX(n.start + n.duration) - f.timeToX(n.start)));
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
const model = () => rollModel([{ id: "n", start: 1, duration: 1, pitch: 60, velocity: 0.8 }], 8);
const end = (n: { start: number; duration: number }) => n.start + n.duration;
function mount(m = model(), extra: Partial<PianoRollOptions> = {}) {
  const root = host();
  const commit = vi.fn((e: any) =>
    m.clip.edit(
      (draft) => void Object.assign(draft.find((n) => n.id === e.note.id)!, { start: e.note.start, duration: e.note.duration, pitch: e.note.pitch }),
    ),
  );
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
async function move(f: ReturnType<typeof mount>, anchor: { x: number; y: number }, beats: number, pitches = 0, alt = false) {
  await pointer({
    action: "move",
    x: anchor.x + beats * f.ctx.getViewport().pixelsPerSecond,
    y: anchor.y - (pitches * f.ctx.getViewport().height) / 25,
    alt,
  });
}
const state = (f: ReturnType<typeof mount>) => f.m.getState().notes[0];

test("move previews locally and commits once to shared model on release", async () => {
  const a = mount(),
    b = mount(a.m);
  const before = a.m.clip.revision.value,
    anchor = await begin(a);
  await move(a, anchor, 1, 2);
  expect(state(a).start).toBe(1);
  expect(a.m.clip.revision.value).toBe(before);
  expect(note(a).getBoundingClientRect().left - note(b).getBoundingClientRect().left).toBeCloseTo(a.ctx.getViewport().pixelsPerSecond, 0);
  await pointer({ action: "up" });
  expect(a.commit).toHaveBeenCalledTimes(1);
  expect(state(a)).toMatchObject({ start: 2, duration: 1, pitch: 62 });
  expect(a.m.clip.revision.value).toBe(before + 1);
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
  expect(end(state(a))).toBeCloseTo(edge === "end" ? 2.5 : 2, 3);
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
  expect(end(state(a))).toBeCloseTo(3.65, 1);
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
  expect(state(a)).toMatchObject({ start: 7, duration: 1, pitch: 72 });
  expect(a.commit).toHaveBeenCalledTimes(1);
});
test("resize cannot invert a note or leave source bounds", async () => {
  const a = mount();
  let anchor = await begin(a, "start");
  await move(a, anchor, 5);
  await pointer({ action: "up" });
  expect(state(a).start).toBeCloseTo(2 - 1 / 64, 6);
  expect(end(state(a))).toBe(2);
  a.m.clip.edit((d) => void Object.assign(d[0], { start: 1, duration: 1 }));
  anchor = await begin(a, "end");
  await move(a, anchor, 20);
  await pointer({ action: "up" });
  expect(end(state(a))).toBe(8);
});
test.each(["Escape", "source", "zoom", "resize", "dispose", "blur", "pointercancel"] as const)(
  "%s cancels preview without stale commit",
  async (kind) => {
    const a = mount(),
      anchor = await begin(a);
    await move(a, anchor, 0.75, 1);
    if (kind === "Escape") await userEvent.keyboard("{Escape}");
    if (kind === "source") a.m.clip.setNotes([{ ...state(a), pitch: 67 }]);
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
    expect(state(a)).toMatchObject({ start: 1, duration: 1, pitch: kind === "source" ? 67 : 60 });
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
  expect(end(state(a))).toBeCloseTo(2.5, 3);
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
  a.m.clip.edit((d) => void (d[0].pitch = 70));
  expect(state(a).pitch).toBe(70);
});

test("borrowed edit callback owns commit; rejected/no-op commands leave no preview store", async () => {
  const command = vi.fn(),
    a = mount(undefined, { onNoteEdit: command });
  let anchor = await begin(a);
  await move(a, anchor, 0.5, 1);
  await pointer({ action: "up" });
  expect(command).toHaveBeenCalledTimes(1);
  expect(state(a)).toMatchObject({ start: 1, duration: 1, pitch: 60 });
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
  expect(state(b)).toMatchObject({ start: 1, duration: 1, pitch: 60 });
  expect(log).toHaveBeenCalledTimes(1);
});

test("a custom application model needs no MidiClip or mirrored UI store", async () => {
  const root = host(),
    listeners = new Set<() => void>();
  let state = {
    duration: 8,
    selection: null as { start: number; end: number } | null,
    notes: [{ id: "n", start: 1, duration: 1, pitch: 60, velocity: 0.8, channel: 0 }],
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
  a.m.clip.edit((d) => void Object.assign(d[0], { start: 1.25, duration: 1 }));
  const anchor = await begin(a);
  await move(a, anchor, 0, 2);
  await pointer({ action: "up" });
  expect(state(a)).toMatchObject({ start: 1.25, duration: 1, pitch: 62 });
  const edit = a.commit.mock.calls[0][0];
  expect(Object.isFrozen(edit)).toBe(true);
  expect(Object.isFrozen(edit.previous)).toBe(true);
  expect(Object.isFrozen(edit.note)).toBe(true);
});

function adding(extra: Partial<PianoRollOptions> = {}) {
  const m = rollModel([{ id: "n", start: 1, duration: 1, pitch: 60, velocity: 0.5 }], 8);
  const add = vi.fn((n: { pitch: number; start: number; duration: number; velocity: number }) =>
    m.clip.edit((draft) => void draft.push({ ...n, id: "added", channel: 0 })),
  );
  const remove = vi.fn((n: { id: string }) =>
    m.clip.edit(
      (draft) =>
        void draft.splice(
          draft.findIndex((x) => x.id === n.id),
          1,
        ),
    ),
  );
  const commit = vi.fn((e: any) => m.clip.edit((draft) => void Object.assign(draft.find((n) => n.id === e.note.id)!, { velocity: e.note.velocity })));
  const root = host();
  const roll = mountPianoRoll(root, {
    model: m,
    pitches: { low: 48, high: 72 },
    grid: { beats: [0, 1, 2, 3, 4, 5, 6, 7, 8], downbeats: [0, 4, 8] },
    snap: "beat",
    onNoteEdit: commit,
    onNoteAdd: add,
    onNoteDelete: remove,
    velocityLane: true,
    ...extra,
  });
  own(() => roll.dispose());
  root.scrollIntoView({ block: "center" });
  const surface = root.querySelector<HTMLElement>("[data-testid=piano-roll]")!;
  const place = (beat: number, pitch: number) => {
    const r = surface.getBoundingClientRect();
    return { x: r.left + (beat / 8) * r.width, y: r.top + ((72 - pitch + 0.5) / 25) * r.height };
  };
  const dbl = (target: Element, at: { x: number; y: number }) =>
    target.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, clientX: at.x, clientY: at.y }));
  return { m, add, remove, commit, root, surface, place, dbl };
}

test("double-click on empty space adds a note in the clicked grid cell and pitch row", () => {
  const f = adding();
  f.dbl(f.surface, f.place(3.7, 67));
  expect(f.add).toHaveBeenCalledTimes(1);
  expect(f.add.mock.calls[0][0]).toMatchObject({ pitch: 67, start: 3, duration: 1 });
  expect(f.add.mock.calls[0][0].velocity).toBeCloseTo(100 / 127, 5);
  expect(f.m.getState().notes).toHaveLength(2);
});

test("a new note near the end stays inside the clip", () => {
  const f = adding();
  f.dbl(f.surface, f.place(7.9, 60));
  const added = f.add.mock.calls[0][0];
  expect(added.start).toBe(7);
  expect(added.start + added.duration).toBeLessThanOrEqual(8);
});

test("double-click on a note deletes it instead of adding one", () => {
  const f = adding();
  const el = f.root.querySelector<HTMLElement>('[data-note-id="n"]')!;
  const r = el.getBoundingClientRect();
  f.dbl(el, { x: r.left + r.width / 2, y: r.top + r.height / 2 });
  expect(f.remove).toHaveBeenCalledTimes(1);
  expect(f.add).not.toHaveBeenCalled();
  expect(f.m.getState().notes).toHaveLength(0);
});

test("Delete removes the focused note", async () => {
  const f = adding();
  const el = f.root.querySelector<HTMLElement>('[data-note-id="n"]')!;
  el.focus();
  await userEvent.keyboard("{Delete}");
  expect(f.remove).toHaveBeenCalledTimes(1);
  expect(f.m.getState().notes).toHaveLength(0);
});

test("the velocity lane previews a drag and commits once on release", async () => {
  const f = adding();
  const lane = f.root.querySelector<HTMLElement>("[data-testid=piano-velocity]")!;
  lane.scrollIntoView({ block: "center" });
  const rect = lane.getBoundingClientRect();
  const x = f.place(1, 60).x + 1;
  await pointer({ action: "down", x, y: rect.top + rect.height * 0.5 });
  await pointer({ action: "move", x, y: rect.top + rect.height * 0.1 });
  const bar = lane.querySelector<HTMLElement>('[data-velocity-note="n"]')!;
  expect(parseFloat(bar.style.height)).toBeGreaterThan(80);
  expect(f.commit).not.toHaveBeenCalled();
  await pointer({ action: "up", x, y: rect.top + rect.height * 0.1 });
  expect(f.commit).toHaveBeenCalledTimes(1);
  expect(f.commit.mock.calls[0][0].kind).toBe("velocity");
  expect(f.m.getState().notes[0].velocity).toBeGreaterThan(0.8);
  expect(f.m.getState().notes[0].start).toBe(1);
});

test("Escape cancels a velocity drag", async () => {
  const f = adding();
  const lane = f.root.querySelector<HTMLElement>("[data-testid=piano-velocity]")!;
  lane.scrollIntoView({ block: "center" });
  const rect = lane.getBoundingClientRect();
  const x = f.place(1, 60).x + 1;
  await pointer({ action: "down", x, y: rect.top + rect.height * 0.5 });
  await pointer({ action: "move", x, y: rect.top + 2 });
  await userEvent.keyboard("{Escape}");
  await pointer({ action: "up", x, y: rect.top + 2 });
  expect(f.commit).not.toHaveBeenCalled();
  expect(f.m.getState().notes[0].velocity).toBe(0.5);
});

test("without the new callbacks, double-click and Delete do nothing and no lane appears", async () => {
  const f = adding({ onNoteAdd: undefined, onNoteDelete: undefined, velocityLane: false });
  f.dbl(f.surface, f.place(3, 67));
  expect(f.m.getState().notes).toHaveLength(1);
  expect(f.root.querySelector("[data-testid=piano-velocity]")).toBeNull();
});

test("a real double-click on a note deletes it", async () => {
  const f = adding();
  const el = f.root.querySelector<HTMLElement>('[data-note-id="n"]')!;
  await userEvent.dblClick(el);
  expect(f.add).not.toHaveBeenCalled();
  expect(f.remove).toHaveBeenCalledTimes(1);
  expect(f.m.getState().notes).toHaveLength(0);
});

test("Delete after clicking empty space removes nothing", async () => {
  const f = adding();
  const el = f.root.querySelector<HTMLElement>('[data-note-id="n"]')!;
  await userEvent.click(el);
  const empty = f.place(5, 50);
  await pointer({ action: "down", x: empty.x, y: empty.y });
  await pointer({ action: "up", x: empty.x, y: empty.y });
  f.root.querySelector<HTMLElement>("[data-testid=piano-viewport]")!.focus();
  await userEvent.keyboard("{Delete}");
  expect(f.remove).not.toHaveBeenCalled();
});

test("the velocity lane edits the clicked note of a chord and ignores hidden notes", async () => {
  const m = rollModel(
    [
      { id: "low", start: 1, duration: 1, pitch: 60, velocity: 0.5 },
      { id: "high", start: 1, duration: 1, pitch: 67, velocity: 0.5 },
      { id: "hidden", start: 3, duration: 1, pitch: 100, velocity: 0.5 },
    ],
    8,
  );
  const commit = vi.fn();
  const root = host();
  const roll = mountPianoRoll(root, { model: m, pitches: { low: 48, high: 72 }, onNoteEdit: commit, velocityLane: true });
  own(() => roll.dispose());
  root.scrollIntoView({ block: "center" });
  await userEvent.click(root.querySelector<HTMLElement>('[data-note-id="high"]')!);
  const lane = root.querySelector<HTMLElement>("[data-testid=piano-velocity]")!;
  lane.scrollIntoView({ block: "center" });
  const rect = lane.getBoundingClientRect();
  const at = (beat: number) => rect.left + (beat / 8) * rect.width + 1;
  await pointer({ action: "down", x: at(1), y: rect.top + 4 });
  await pointer({ action: "up", x: at(1), y: rect.top + 4 });
  expect(commit.mock.calls[0][0].note.id).toBe("high");
  commit.mockClear();
  await pointer({ action: "down", x: at(3), y: rect.top + 4 });
  await pointer({ action: "up", x: at(3), y: rect.top + 4 });
  expect(commit).not.toHaveBeenCalled();
});

test("double-click deletes the note drawn on top, including a very short one", async () => {
  const m = rollModel(
    [
      { id: "under", start: 1, duration: 4, pitch: 60, velocity: 0.5 },
      { id: "top", start: 2, duration: 1, pitch: 60, velocity: 0.5 },
      { id: "short", start: 6, duration: 1 / 64, pitch: 64, velocity: 0.5 },
    ],
    8,
  );
  const remove = vi.fn((n: { id: string }) =>
    m.clip.edit(
      (draft) =>
        void draft.splice(
          draft.findIndex((x) => x.id === n.id),
          1,
        ),
    ),
  );
  const add = vi.fn();
  const root = host();
  const roll = mountPianoRoll(root, { model: m, pitches: { low: 48, high: 72 }, onNoteEdit: vi.fn(), onNoteAdd: add, onNoteDelete: remove });
  own(() => roll.dispose());
  root.scrollIntoView({ block: "center" });
  await userEvent.dblClick(root.querySelector<HTMLElement>('[data-note-id="top"]')!);
  expect(remove.mock.calls[0][0].id).toBe("top");
  await userEvent.dblClick(root.querySelector<HTMLElement>('[data-note-id="short"]')!);
  expect(remove.mock.calls[1][0].id).toBe("short");
  expect(add).not.toHaveBeenCalled();
});

test("setActiveNote chooses the chord note a velocity drag edits after a remount", async () => {
  const m = rollModel(
    [
      { id: "low", start: 1, duration: 1, pitch: 60, velocity: 0.5 },
      { id: "high", start: 1, duration: 1, pitch: 67, velocity: 0.5 },
    ],
    8,
  );
  const commit = vi.fn();
  const root = host();
  const roll = mountPianoRoll(root, { model: m, pitches: { low: 48, high: 72 }, onNoteEdit: commit, velocityLane: true });
  own(() => roll.dispose());
  roll.setActiveNote("high");
  const lane = root.querySelector<HTMLElement>("[data-testid=piano-velocity]")!;
  lane.scrollIntoView({ block: "center" });
  const rect = lane.getBoundingClientRect();
  const x = rect.left + rect.width / 8 + 1;
  await pointer({ action: "down", x, y: rect.top + 4 });
  await pointer({ action: "up", x, y: rect.top + 4 });
  expect(commit.mock.calls[0][0].note.id).toBe("high");
});

test("a handled Delete does not reach the app's own key handler", async () => {
  const f = adding();
  const seen = vi.fn();
  document.addEventListener("keydown", seen);
  own(() => document.removeEventListener("keydown", seen));
  f.root.querySelector<HTMLElement>('[data-note-id="n"]')!.focus();
  await userEvent.keyboard("{Delete}");
  expect(f.remove).toHaveBeenCalledTimes(1);
  expect(seen).not.toHaveBeenCalled();
});

test("a view mounted inside an effect keeps following its model after that effect re-runs", () => {
  const m = rollModel([{ id: "n", start: 1, duration: 1, pitch: 60, velocity: 0.5 }], 8);
  const root = host();
  const tick = cell(0);
  let roll: ReturnType<typeof mountPianoRoll> | undefined;
  const stop = effect(() => {
    tick.value;
    roll ??= mountPianoRoll(root, { model: m, pitches: { low: 48, high: 72 } });
  });
  own(() => {
    stop();
    roll?.dispose();
  });
  tick.value = 1;
  m.clip.edit((draft) => void draft.push({ id: "later", start: 3, duration: 1, pitch: 62, velocity: 0.5, channel: 0 }));
  expect(root.querySelector('[data-note-id="later"]')).not.toBeNull();
});
