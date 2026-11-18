/** Public integration and lifecycle for plugins shared by time-based views. */
import { afterEach, expect, test, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { MidiSequence } from "@audiorective/midi";
import { WavePlayer } from "@audiorective/blocks/player";
import { cell } from "@audiorective/core";
import type { AutomationPoint } from "@audiorective/core/automation";
import { createAutomationOverlay, mountWaveformSelector, type TimeViewPlugin } from "../src";
import { mountPianoRoll, type WaveformPlugin, type WaveformPluginContext } from "../src/piano-roll";
import { mountWaveform } from "../src/waveform";
import { bandsFile, cleanup, element, host, own, pointer } from "./helpers";

afterEach(async () => {
  await cleanup();
  vi.restoreAllMocks();
});

test("an automation overlay edits a shared curve with output-to-source time projection and independent lifetimes", () => {
  const root = host();
  const peer = host();
  const model = new MidiSequence({ notes: [], duration: 2 });
  const waveform = mountWaveform(root, { data: { peaks: Float32Array.of(0.2, 0.8), duration: 2 } });
  const notes = mountPianoRoll(peer, { model });
  own(() => model.destroy());
  own(() => waveform.destroy());
  own(() => notes.destroy());
  const points = cell<readonly AutomationPoint[]>([
    { time: 0, value: 0.2, shape: "hold" },
    { time: 3, value: 1, shape: "linear" },
    { time: 4.5, value: 0.5, shape: "hold" },
  ]);
  const fromView = vi.fn((time: number) => 2 + time * 2);
  const commit = vi.fn((next: readonly AutomationPoint[]) => {
    points.value = next;
  });
  const plugin = createAutomationOverlay({
    points,
    fromView,
    toView: (time) => (time - 2) / 2,
    maxValue: 2,
    defaultValue: 1,
    onCommit: commit,
  });
  const detach = waveform.attach(plugin);
  notes.attach(plugin);
  expect(root.querySelectorAll(".ar-automation-point:not([hidden])")).toHaveLength(2);
  const handle = root.querySelector<HTMLButtonElement>(".ar-automation-point[data-index='1']")!;
  const original = parseFloat(handle.style.left);
  waveform.setZoom(2);
  expect(parseFloat(handle.style.left)).toBeCloseTo(original * 2);
  handle.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  expect(commit).toHaveBeenCalledTimes(1);
  expect(peer.querySelector(".ar-automation-point[data-index='1']")?.getAttribute("title")).toBe("hold");
  detach.destroy();
  expect(root.querySelector(".ar-automation-overlay")).toBeNull();
  points.value = points.value.slice(0, 2);
  expect(peer.querySelectorAll(".ar-automation-point:not([hidden])")).toHaveLength(1);
  notes.destroy();
  fromView.mockClear();
  points.value = [];
  expect(fromView).not.toHaveBeenCalled();
});

test("one time plugin mounts on all three views, follows units and cleans up each attachment", async () => {
  const context = new AudioContext();
  own(() => context.close());
  const player = new WavePlayer(context);
  own(() => player.destroy());
  const model = new MidiSequence({ duration: 8, notes: [] });
  own(() => model.destroy());

  const wave = mountWaveform(host(), { data: { peaks: Float32Array.of(0.5), duration: 4 } });
  const piano = mountPianoRoll(host(), { model, timeUnit: "beats" });
  const selectorRoot = host();
  const selector = mountWaveformSelector(selectorRoot, { player });
  own(() => wave.destroy());
  own(() => piano.destroy());
  own(() => selector.destroy());

  const layers: HTMLElement[] = [];
  const lines: HTMLElement[] = [];
  const observedDurations = vi.fn();
  const cleanups = vi.fn();
  const marker: TimeViewPlugin = {
    attach(ctx) {
      const layer = document.createElement("div");
      const line = document.createElement("span");
      line.style.position = "absolute";
      layer.append(line);
      layers.push(layer);
      lines.push(line);
      ctx.mountOverlay(layer);
      const draw = () => {
        line.style.left = `${ctx.timeToX(ctx.timeUnit === "beats" ? 2 : 1)}px`;
        line.textContent = ctx.timeUnit;
      };
      ctx.onViewportChange(draw);
      ctx.onDataChange(observedDurations);
      ctx.onCleanup(cleanups);
      draw();
    },
  };
  const waveformMarker = wave.attach(marker);
  piano.attach(marker);
  const selectorMarker = selector.attach(marker);
  await selector.load(bandsFile(4));
  expect(observedDurations.mock.calls).toEqual([[4]]);
  expect(layers.map((layer) => layer.textContent)).toEqual(["seconds", "beats", "seconds"]);
  expect(lines.every((line) => line.isConnected && parseFloat(line.style.left) > 0)).toBe(true);
  const leftBeforeZoom = parseFloat(lines[2].style.left);
  element<HTMLButtonElement>(selectorRoot, "zoom-in").click();
  expect(parseFloat(lines[2].style.left)).toBeCloseTo(2 * leftBeforeZoom);

  waveformMarker.destroy();
  expect(layers.map((layer) => layer.isConnected)).toEqual([false, true, true]);
  selector.destroy();
  selectorMarker.destroy();
  expect(layers.map((layer) => layer.isConnected)).toEqual([false, true, false]);
  expect(cleanups).toHaveBeenCalledTimes(2);
  expect(player.buffer?.duration).toBe(4);
  expect(context.state).not.toBe("closed");
});

for (const kind of ["waveform", "piano roll"] as const) {
  function fixture() {
    const root = host();
    const model = new MidiSequence({ duration: 6, notes: [] });
    own(() => model.destroy());
    const wave = kind === "waveform" ? mountWaveform(root, { data: { peaks: Float32Array.of(0.2, 0.8), duration: 6 } }) : undefined;
    const view = wave ?? mountPianoRoll(root, { model });
    own(() => view.destroy());
    return {
      root,
      view,
      replace() {
        if (wave) wave.setData({ peaks: Float32Array.of(0.5, 0.1), duration: 8 });
        else model.setData({ notes: [], duration: 8 });
      },
    };
  }

  test(`${kind}: public plugin coordinates, overlay and native pointer survive zoom/scroll/resize/data`, async () => {
    const { root, view, replace } = fixture();
    let ctx!: WaveformPluginContext;
    let clickedTime = -1;
    const changes: number[] = [];
    const marker = document.createElement("button");
    marker.textContent = "annotation";
    marker.style.cssText = "position:absolute;top:24px;width:12px;height:24px;padding:0;pointer-events:auto";
    view.attach({
      attach(context) {
        ctx = context;
        const layer = document.createElement("div");
        layer.append(marker);
        ctx.mountOverlay(layer);
        const draw = () => {
          marker.style.left = `${ctx.timeToX(2)}px`;
        };
        ctx.onViewportChange(draw);
        ctx.onDataChange((duration) => changes.push(duration));
        ctx.listen(marker, "pointerdown", (event) => event.stopPropagation());
        ctx.listen(marker, "click", (event) => {
          clickedTime = ctx.clientXToTime((event as MouseEvent).clientX);
        });
        draw();
      },
    });
    const aligned = () => expect(marker.getBoundingClientRect().left - ctx.surface.getBoundingClientRect().left).toBeCloseTo(ctx.timeToX(2), 0);
    aligned();
    view.setZoom(3);
    view.scrollTo(1);
    aligned();
    await userEvent.click(marker);
    expect(clickedTime).toBeCloseTo(2, 1);
    let pointerTime = -1;
    ctx.listen(ctx.surface, "pointerdown", (event) => {
      pointerTime = ctx.clientXToTime((event as PointerEvent).clientX);
    });
    const rect = ctx.getViewportRect();
    const x = rect.left + rect.width * 0.7;
    const expected = ctx.clientXToTime(x);
    await pointer({ action: "down", x, y: ctx.surface.getBoundingClientRect().top + 100 });
    await pointer({ action: "up" });
    expect(pointerTime).toBeCloseTo(expected, 1);
    const oldWidth = ctx.getViewport().width;
    root.style.width = "320px";
    await expect.poll(() => ctx.getViewport().width).toBeLessThan(oldWidth);
    aligned();
    replace();
    expect(changes).toEqual([8]);
    expect(ctx.duration).toBe(8);
    aligned();
  });

  test(`${kind}: detach owns only its registrations; late registrations clean up immediately`, () => {
    const { view, replace } = fixture();
    let ctx!: WaveformPluginContext;
    const listener = vi.fn(),
      data = vi.fn(),
      peer = vi.fn(),
      dead = vi.fn();
    const layer = document.createElement("div");
    const plugin: WaveformPlugin = {
      attach(context) {
        ctx = context;
        ctx.mountOverlay(layer);
        ctx.listen(document, "probe-marker", listener);
        ctx.onDataChange(data);
        return dead;
      },
    };
    const a = view.attach(plugin);
    view.attach({
      attach(context) {
        context.onDataChange(peer);
      },
    });
    expect(() => view.attach(plugin)).toThrow("already attached");
    a.destroy();
    a.destroy();
    expect(dead).toHaveBeenCalledTimes(1);
    expect(layer.isConnected).toBe(false);
    ctx.onCleanup(dead);
    ctx.listen(document, "probe-marker", listener);
    ctx.onDataChange(data);
    expect(dead).toHaveBeenCalledTimes(2);
    const position = view.getViewport().scrollLeft;
    ctx.scrollBy(40);
    expect(view.getViewport().scrollLeft).toBe(position);
    expect(() => ctx.mountOverlay(layer)).toThrow("Plugin attachment is destroyed.");
    document.dispatchEvent(new Event("probe-marker"));
    replace();
    expect(listener).not.toHaveBeenCalled();
    expect(data).not.toHaveBeenCalled();
    expect(peer).toHaveBeenCalledTimes(1);
    view.attach(plugin);
    document.dispatchEvent(new Event("probe-marker"));
    expect(listener).toHaveBeenCalledTimes(1);
  });

  test(`${kind}: failed attach rolls back overlay/listeners and permits retry`, () => {
    const { view } = fixture();
    const layer = document.createElement("div"),
      listener = vi.fn(),
      dead = vi.fn();
    let fail = true;
    const plugin: WaveformPlugin = {
      attach(ctx) {
        ctx.mountOverlay(layer);
        ctx.listen(document, "probe-marker", listener);
        ctx.onCleanup(dead);
        if (fail) throw new Error("consumer setup failed");
      },
    };
    expect(() => view.attach(plugin)).toThrow("consumer setup failed");
    expect(layer.isConnected).toBe(false);
    expect(dead).toHaveBeenCalledTimes(1);
    document.dispatchEvent(new Event("probe-marker"));
    expect(listener).not.toHaveBeenCalled();
    fail = false;
    view.attach(plugin);
    expect(layer.isConnected).toBe(true);
  });

  test(`${kind}: destroy during attach disposes returned resource and subsequent registrations`, () => {
    const { root, view } = fixture();
    const dead = vi.fn(),
      late = vi.fn(),
      listener = vi.fn();
    const attachment = view.attach({
      attach(ctx) {
        view.destroy();
        ctx.onCleanup(late);
        ctx.listen(document, "probe-marker", listener);
        return { destroy: dead };
      },
    });
    attachment.destroy();
    view.destroy();
    expect(root.childElementCount).toBe(0);
    expect(dead).toHaveBeenCalledTimes(1);
    expect(late).toHaveBeenCalledTimes(1);
    document.dispatchEvent(new Event("probe-marker"));
    expect(listener).not.toHaveBeenCalled();
    expect(() => view.attach({ attach() {} })).toThrow("is destroyed.");
  });

  test(`${kind}: throwing plugin cleanup preserves peer cleanup and widget removal`, () => {
    const { root, view } = fixture();
    const log = vi.spyOn(console, "error").mockImplementation(() => {}),
      peer = vi.fn(),
      owned = vi.fn();
    const layer = document.createElement("div");
    view.attach({
      attach(ctx) {
        ctx.mountOverlay(layer);
        ctx.onCleanup(owned);
        return () => {
          throw new Error("consumer cleanup failed");
        };
      },
    });
    view.attach({
      attach() {
        return peer;
      },
    });
    view.destroy();
    view.destroy();
    expect(log).toHaveBeenCalledTimes(1);
    expect(owned).toHaveBeenCalledTimes(1);
    expect(peer).toHaveBeenCalledTimes(1);
    expect(layer.isConnected).toBe(false);
    expect(root.childElementCount).toBe(0);
  });
}
