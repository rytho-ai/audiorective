/** Public integration and lifecycle for plugins shared by time-based views. */
import { afterEach, expect, test, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { WavePlayer } from "@audiorective/player";
import { cell, readonlyCell } from "@audiorective/core";
import { AutomationCurve, type AutomationPoint } from "@audiorective/core/automation";
import { createAutomationOverlay, createWarpMarkers, mountWaveformSelector, type TimeViewPlugin, type TimeViewPluginContext } from "../src";
import { mountPianoRoll, type WaveformPlugin, type WaveformPluginContext } from "../src/piano-roll";
import { mountWaveform } from "../src/waveform";
import { bandsFile, cleanup, element, host, own, pointer, rollModel } from "./helpers";

afterEach(async () => {
  await cleanup();
  vi.restoreAllMocks();
});

test("curve and warp extensions claim one background double click and respect an earlier claim", () => {
  const root = host();
  const wave = mountWaveform(root, { data: { peaks: Float32Array.of(0.2, 0.8), duration: 4 } });
  own(() => wave.dispose());
  let context!: TimeViewPluginContext;
  wave.attach({
    attach(ctx) {
      context = ctx;
    },
  });
  const curveCommit = vi.fn();
  const markerCommit = vi.fn();
  wave.attach(
    createAutomationOverlay({
      points: cell<readonly AutomationPoint[]>([]),
      fromView: (time) => time,
      toView: (time) => time,
      maxValue: 2,
      defaultValue: 1,
      onCommit: curveCommit,
    }),
  );
  wave.attach(
    createWarpMarkers({
      anchors: cell([]),
      sampleRate: 48_000,
      sourceFrames: 192_000,
      sourceFrameAt: (time) => time * 48_000,
      onCommit: markerCommit,
    }),
  );
  const rect = context.surface.getBoundingClientRect();
  const event = () =>
    new MouseEvent("dblclick", {
      bubbles: true,
      cancelable: true,
      clientX: rect.left + context.timeToX(2),
      clientY: rect.top + 30,
    });
  const claimed = event();
  claimed.preventDefault();
  context.surface.dispatchEvent(claimed);
  expect(curveCommit).not.toHaveBeenCalled();
  expect(markerCommit).not.toHaveBeenCalled();
  const click = event();
  context.surface.dispatchEvent(click);
  expect(curveCommit.mock.calls.length + markerCommit.mock.calls.length).toBe(1);
  expect(click.defaultPrevented).toBe(true);
});

test("borrowed tool gates cancel a curve drag and yield background editing to warp without reattachment", async () => {
  const root = host();
  const wave = mountWaveform(root, { data: { peaks: Float32Array.of(0.2, 0.8), duration: 4 } });
  own(() => wave.dispose());
  let context!: TimeViewPluginContext;
  wave.attach({
    attach(ctx) {
      context = ctx;
    },
  });
  const tool = cell<"curve" | "warp">("curve");
  const curve = new AutomationCurve([
    { time: 4, value: 1, shape: "linear" },
    { time: 6, value: 0.5, shape: "hold" },
    { time: 12, value: 1, shape: "linear" },
  ]);
  const before = curve.value;
  const curveCommit = vi.fn((next: readonly AutomationPoint[]) => {
    curve.value = next;
  });
  const markerCommit = vi.fn();
  wave.attach(
    createAutomationOverlay({
      points: curve,
      fromView: (time) => 4 + 2 * time,
      toView: (time) => (time - 4) / 2,
      maxValue: 2,
      defaultValue: 1,
      disabled: readonlyCell(() => tool.value !== "curve"),
      onCommit: curveCommit,
    }),
  );
  wave.attach(
    createWarpMarkers({
      anchors: cell([{ sourceFrame: 96_000, outputFrame: 144_000 }]),
      sampleRate: 48_000,
      sourceFrames: 192_000,
      disabled: readonlyCell(() => tool.value !== "warp"),
      sourceFrameAt: (time) => time * 32_000,
      onCommit: markerCommit,
    }),
  );
  const handle = root.querySelector<HTMLButtonElement>('.ar-automation-point[data-index="1"]')!;
  const rect = handle.getBoundingClientRect();
  await pointer({ action: "down", x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
  await pointer({ action: "move", x: rect.left + rect.width / 2 + 50, y: rect.top + 30 });
  tool.value = "warp";
  await pointer({ action: "up" });
  expect(curveCommit).not.toHaveBeenCalled();
  expect(curve.value).toBe(before);
  expect(root.querySelector('.ar-automation-point[data-index="1"]')).toBe(handle);
  expect(handle.disabled).toBe(true);
  const bounds = context.surface.getBoundingClientRect();
  context.surface.dispatchEvent(
    new MouseEvent("dblclick", {
      bubbles: true,
      cancelable: true,
      clientX: bounds.left + context.timeToX(2),
      clientY: bounds.top + 30,
    }),
  );
  expect(curveCommit).not.toHaveBeenCalled();
  expect(markerCommit).toHaveBeenCalledTimes(1);
});

test("a disabled marker yields real pointer input to the curve handle beneath it", async () => {
  const root = host();
  const wave = mountWaveform(root, { data: { peaks: Float32Array.of(0.2, 0.8), duration: 4 } });
  own(() => wave.dispose());
  let context!: TimeViewPluginContext;
  wave.attach({
    attach(ctx) {
      context = ctx;
    },
  });
  const curve = new AutomationCurve([{ time: 1, value: 0.5, shape: "linear" }]);
  const commit = vi.fn((next: readonly AutomationPoint[]) => {
    curve.value = next;
  });
  const warpCommit = vi.fn();
  wave.attach(
    createAutomationOverlay({ points: curve, fromView: (time) => time, toView: (time) => time, maxValue: 2, defaultValue: 1, onCommit: commit }),
  );
  wave.attach(
    createWarpMarkers({
      anchors: cell([{ sourceFrame: 48_000, outputFrame: 48_000 }]),
      disabled: cell(true),
      sampleRate: 48_000,
      sourceFrames: 192_000,
      sourceFrameAt: (time) => time * 48_000,
      onCommit: warpCommit,
    }),
  );
  const point = root.querySelector<HTMLButtonElement>(".ar-automation-point")!;
  const rect = point.getBoundingClientRect();
  const bounds = context.surface.getBoundingClientRect();
  await pointer({ action: "down", x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
  await pointer({ action: "move", x: bounds.left + context.timeToX(2), y: rect.top + rect.height / 2 });
  await pointer({ action: "up" });
  expect(commit).toHaveBeenCalledTimes(1);
  expect(curve.value[0].time).toBeCloseTo(2, 1);
  expect(warpCommit).not.toHaveBeenCalled();
});

test("a keyboard command cancels the pointer preview even when the owner refuses the command", async () => {
  const root = host();
  const wave = mountWaveform(root, { data: { peaks: Float32Array.of(0.2, 0.8), duration: 4 } });
  own(() => wave.dispose());
  const points = cell<readonly AutomationPoint[]>([{ time: 1, value: 0.5, shape: "linear" }]);
  const commit = vi.fn();
  wave.attach(createAutomationOverlay({ points, fromView: (time) => time, toView: (time) => time, maxValue: 2, defaultValue: 1, onCommit: commit }));
  const handle = root.querySelector<HTMLButtonElement>(".ar-automation-point")!;
  const originalLeft = handle.style.left;
  const rect = handle.getBoundingClientRect();
  await pointer({ action: "down", x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
  await pointer({ action: "move", x: rect.left + rect.width / 2 + 50, y: rect.top + rect.height / 2 });
  await userEvent.keyboard("{Delete}");
  expect(handle.style.left).toBe(originalLeft);
  await pointer({ action: "up" });
  expect(commit).toHaveBeenCalledTimes(1);
  expect(commit).toHaveBeenCalledWith([]);
  expect(points.value).toEqual([{ time: 1, value: 0.5, shape: "linear" }]);
});

test("an owner command can remove its overlay without a late mapping callback", () => {
  const root = host();
  const wave = mountWaveform(root, { data: { peaks: Float32Array.of(0.2, 0.8), duration: 4 } });
  own(() => wave.dispose());
  const points = cell<readonly AutomationPoint[]>([{ time: 1, value: 0.5, shape: "linear" }]);
  const fromView = vi.fn((time: number) => time);
  const attachment = wave.attach(
    createAutomationOverlay({
      points,
      fromView,
      toView: (time) => time,
      maxValue: 2,
      defaultValue: 1,
      onCommit() {
        attachment.dispose();
        fromView.mockClear();
      },
    }),
  );
  root.querySelector<HTMLButtonElement>(".ar-automation-point")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  expect(fromView).not.toHaveBeenCalled();
  expect(root.querySelector(".ar-automation-overlay")).toBeNull();
  expect(wave.getViewport().duration).toBe(4);
});

for (const tool of ["curve", "warp"] as const) {
  test.each(["Escape", "pointercancel", "lostpointercapture", "replacement", "dispose"] as const)(
    `${tool}: %s cancels pointer previews and keeps the borrowed owner usable`,
    async (reason) => {
      const root = host();
      const wave = mountWaveform(root, { data: { peaks: Float32Array.of(0.2, 0.8), duration: 4 } });
      own(() => wave.dispose());
      let context!: TimeViewPluginContext;
      wave.attach({
        attach(ctx) {
          context = ctx;
        },
      });
      const points = cell<readonly AutomationPoint[]>([{ time: 1, value: 0.5, shape: "linear" }]);
      const anchors = cell<readonly { sourceFrame: number; outputFrame: number }[]>([{ sourceFrame: 48_000, outputFrame: 48_000 }]);
      const commit = vi.fn();
      const attachment = wave.attach(
        tool === "curve"
          ? createAutomationOverlay({ points, fromView: (time) => time, toView: (time) => time, maxValue: 2, defaultValue: 1, onCommit: commit })
          : createWarpMarkers({ anchors, sampleRate: 48_000, sourceFrames: 192_000, sourceFrameAt: (time) => time * 48_000, onCommit: commit }),
      );
      own(() => attachment.dispose());
      const selector = tool === "curve" ? ".ar-automation-point" : ".ar-warp-marker";
      const handle = root.querySelector<HTMLButtonElement>(selector)!;
      let pointerId = -1;
      handle.addEventListener(
        "pointerdown",
        (event) => {
          pointerId = event.pointerId;
        },
        { once: true },
      );
      const rect = handle.getBoundingClientRect();
      await pointer({ action: "down", x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
      await pointer({ action: "move", x: context.surface.getBoundingClientRect().left + context.timeToX(2), y: rect.top + rect.height / 2 });
      if (reason === "Escape") await userEvent.keyboard("{Escape}");
      else if (reason === "replacement") {
        if (tool === "curve") points.value = [{ time: 1, value: 1.5, shape: "hold" }];
        else anchors.value = [{ sourceFrame: 48_000, outputFrame: 72_000 }];
        expect(root.querySelector(selector)).toBe(handle);
        expect(document.activeElement).toBe(handle);
        expect(handle.getAttribute("aria-valuenow")).toBe("1.5");
      } else if (reason === "dispose") attachment.dispose();
      else handle.dispatchEvent(new PointerEvent(reason, { pointerId, bubbles: true }));
      await pointer({ action: "up" });
      expect(commit).not.toHaveBeenCalled();
      if (reason === "dispose") {
        const before = handle.getAttribute("aria-valuenow");
        points.value = [{ time: 1, value: 0.1, shape: "hold" }];
        anchors.value = [{ sourceFrame: 48_000, outputFrame: 96_000 }];
        handle.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
        expect(handle.getAttribute("aria-valuenow")).toBe(before);
        expect(commit).not.toHaveBeenCalled();
        expect(root.querySelector(selector)).toBeNull();
        expect(wave.getViewport().duration).toBe(4);
      }
    },
  );
}

test("an automation overlay edits a shared curve with output-to-source time projection and independent lifetimes", () => {
  const root = host();
  const peer = host();
  const model = rollModel([], 2);
  const waveform = mountWaveform(root, { data: { peaks: Float32Array.of(0.2, 0.8), duration: 2 } });
  const notes = mountPianoRoll(peer, { model });
  own(() => waveform.dispose());
  own(() => notes.dispose());
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
  detach.dispose();
  expect(root.querySelector(".ar-automation-overlay")).toBeNull();
  points.value = points.value.slice(0, 2);
  expect(peer.querySelectorAll(".ar-automation-point:not([hidden])")).toHaveLength(1);
  notes.dispose();
  fromView.mockClear();
  points.value = [];
  expect(fromView).not.toHaveBeenCalled();
});

test("one time plugin mounts on all three views, follows units and cleans up each attachment", async () => {
  const context = new AudioContext();
  own(() => context.close());
  const player = new WavePlayer(context);
  own(() => player.dispose());
  const model = rollModel([], 8);

  const wave = mountWaveform(host(), { data: { peaks: Float32Array.of(0.5), duration: 4 } });
  const piano = mountPianoRoll(host(), { model });
  const selectorRoot = host();
  const selector = mountWaveformSelector(selectorRoot, { player });
  own(() => wave.dispose());
  own(() => piano.dispose());
  own(() => selector.dispose());

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

  waveformMarker.dispose();
  expect(layers.map((layer) => layer.isConnected)).toEqual([false, true, true]);
  selector.dispose();
  selectorMarker.dispose();
  expect(layers.map((layer) => layer.isConnected)).toEqual([false, true, false]);
  expect(cleanups).toHaveBeenCalledTimes(2);
  expect(player.buffer?.duration).toBe(4);
  expect(context.state).not.toBe("closed");
});

for (const kind of ["waveform", "piano roll"] as const) {
  function fixture() {
    const root = host();
    const length = cell(6);
    const model = rollModel([], () => length.value);
    const wave = kind === "waveform" ? mountWaveform(root, { data: { peaks: Float32Array.of(0.2, 0.8), duration: 6 } }) : undefined;
    const view = wave ?? mountPianoRoll(root, { model });
    own(() => view.dispose());
    return {
      root,
      view,
      replace() {
        if (wave) wave.setData({ peaks: Float32Array.of(0.5, 0.1), duration: 8 });
        else length.value = 8;
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
    a.dispose();
    a.dispose();
    expect(dead).toHaveBeenCalledTimes(1);
    expect(layer.isConnected).toBe(false);
    ctx.onCleanup(dead);
    ctx.listen(document, "probe-marker", listener);
    ctx.onDataChange(data);
    expect(dead).toHaveBeenCalledTimes(2);
    const position = view.getViewport().scrollLeft;
    ctx.scrollBy(40);
    expect(view.getViewport().scrollLeft).toBe(position);
    expect(() => ctx.mountOverlay(layer)).toThrow("Plugin attachment is disposed.");
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

  test(`${kind}: dispose during attach disposes returned resource and subsequent registrations`, () => {
    const { root, view } = fixture();
    const dead = vi.fn(),
      late = vi.fn(),
      listener = vi.fn();
    const attachment = view.attach({
      attach(ctx) {
        view.dispose();
        ctx.onCleanup(late);
        ctx.listen(document, "probe-marker", listener);
        return { dispose: dead };
      },
    });
    attachment.dispose();
    view.dispose();
    expect(root.childElementCount).toBe(0);
    expect(dead).toHaveBeenCalledTimes(1);
    expect(late).toHaveBeenCalledTimes(1);
    document.dispatchEvent(new Event("probe-marker"));
    expect(listener).not.toHaveBeenCalled();
    expect(() => view.attach({ attach() {} })).toThrow("is disposed.");
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
    view.dispose();
    view.dispose();
    expect(log).toHaveBeenCalledTimes(1);
    expect(owned).toHaveBeenCalledTimes(1);
    expect(peer).toHaveBeenCalledTimes(1);
    expect(layer.isConnected).toBe(false);
    expect(root.childElementCount).toBe(0);
  });
}
