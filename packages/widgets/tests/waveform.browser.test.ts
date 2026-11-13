import { afterEach, describe, expect, test, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { createSelectionPlugin, mountWaveform, type Selection, type SelectionPluginOptions, type WaveformPluginContext } from "../src/waveform";
import { cleanup, drag, element, host, own, pointer } from "./helpers";

function fixture(options: SelectionPluginOptions = {}) {
  const root = host();
  const view = mountWaveform(root, {
    data: { peaks: Float32Array.from({ length: 240 }, (_, i) => Math.abs(Math.sin(i * 0.3))), duration: 6 },
  });
  own(() => view.destroy());
  const selection = createSelectionPlugin(options);
  const attachment = view.attach(selection);
  return { root, view, selection, attachment, surface: element(root, "waveform") };
}

afterEach(async () => {
  await cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("audio independent waveform and selection", () => {
  test("pure view renders peaks and ruler without creating audio or transport controls", () => {
    const forbidden = vi.fn(() => {
      throw new Error("Audio is forbidden in a pure waveform");
    });
    vi.stubGlobal("AudioContext", forbidden);
    vi.stubGlobal("OfflineAudioContext", forbidden);
    const play = vi.spyOn(HTMLMediaElement.prototype, "play");
    const root = host();
    const view = mountWaveform(root, { data: { peaks: Float32Array.of(0.1, 0.4, 0.8, 0.2), duration: 6 } });
    own(() => view.destroy());
    expect(element(root, "wave-path").getAttribute("d")!.length).toBeGreaterThan(100);
    expect(element(root, "ruler").childElementCount).toBeGreaterThan(1);
    expect(root.querySelector("[data-testid=selection]")).toBeNull();
    expect(root.querySelector("[data-testid=play-pause]")).toBeNull();
    const plugin = createSelectionPlugin();
    view.attach(plugin);
    plugin.setSelection({ start: 1, end: 2 });
    view.setZoom(2);
    view.scrollTo(1);
    view.destroy();
    expect(forbidden).not.toHaveBeenCalled();
    expect(play).not.toHaveBeenCalled();
  });

  test("selection copies caller and callback metadata and rejects invalid input atomically", () => {
    const onChange = vi.fn();
    const onCommit = vi.fn();
    const { root, selection } = fixture({ onChange, onCommit });
    const input = { start: 1, end: 2 };
    selection.setSelection(input);
    input.start = 5;
    const snapshot = selection.getSelection()!;
    snapshot.end = 5;
    (onChange.mock.calls[0][0] as Selection).start = 4;
    expect(selection.getSelection()).toEqual({ start: 1, end: 2 });
    expect(onCommit.mock.calls[0][0]).toEqual({ selection: { start: 1, end: 2 }, kind: "programmatic" });
    expect(Object.isFrozen(onCommit.mock.calls[0][0].selection)).toBe(true);
    const left = element(root, "selection").style.left;
    const changes = onChange.mock.calls.length;
    for (const invalid of [
      { start: -1, end: 1 },
      { start: 2, end: 1 },
      { start: 1, end: 1 },
      { start: NaN, end: 2 },
      { start: 1, end: Infinity },
      { start: 1, end: 7 },
    ])
      expect(() => selection.setSelection(invalid)).toThrow(RangeError);
    expect(selection.getSelection()).toEqual({ start: 1, end: 2 });
    expect(element(root, "selection").style.left).toBe(left);
    expect(onChange).toHaveBeenCalledTimes(changes);
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  test("reverse drag, grip resize and keyboard nudges commit absolute source seconds", async () => {
    const onCommit = vi.fn();
    const { root, surface, selection } = fixture({ onCommit });
    await drag(surface, 6, 4, 2);
    expect(selection.getSelection()!.start).toBeCloseTo(2, 1);
    expect(selection.getSelection()!.end).toBeCloseTo(4, 1);
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit.mock.calls[0][0].kind).toBe("pointer");

    const grip = element(root, "selection-start").getBoundingClientRect();
    const rect = surface.getBoundingClientRect();
    await pointer({ action: "down", x: grip.x + grip.width / 2, y: grip.y + grip.height / 2 });
    await pointer({ action: "move", x: rect.x + rect.width / 2, y: grip.y + grip.height / 2 });
    await pointer({ action: "up" });
    expect(selection.getSelection()!.start).toBeCloseTo(3, 1);
    expect(selection.getSelection()!.end).toBeCloseTo(4, 1);
    expect(onCommit).toHaveBeenCalledTimes(2);

    element(root, "selection-end").focus();
    await userEvent.keyboard("{ArrowLeft}{Shift>}{ArrowLeft}{/Shift}");
    expect(selection.getSelection()!.end).toBeCloseTo(3.89, 2);
    expect(element(root, "selection-end").getAttribute("aria-valuenow")).toBe(String(selection.getSelection()!.end));
    expect(onCommit.mock.calls.slice(-2).map(([event]) => event.kind)).toEqual(["keyboard", "keyboard"]);
  });

  test("beat and downbeat snapping use source times; Alt bypasses snapping", async () => {
    const { surface, selection } = fixture({ grid: { beats: [0, 1, 2, 3, 4, 5, 6], downbeats: [0, 4] }, snap: "beat" });
    await drag(surface, 6, 1.13, 3.23);
    expect(selection.getSelection()).toEqual({ start: 1, end: 3 });
    selection.setSelection(null);
    await drag(surface, 6, 1.13, 3.23, true);
    expect(selection.getSelection()!.start).toBeCloseTo(1.13, 1);
    expect(selection.getSelection()!.end).toBeCloseTo(3.23, 1);
    selection.setSelection(null);
    selection.setSnap("downbeat");
    await drag(surface, 6, 0.3, 3.7);
    expect(selection.getSelection()).toEqual({ start: 0, end: 4 });
  });

  test("pointercancel reverts the in-progress edit and prevents a later commit", async () => {
    const onCommit = vi.fn();
    const { surface, selection } = fixture({ onCommit });
    selection.setSelection({ start: 1, end: 2 });
    onCommit.mockClear();
    let pointerId = 0;
    surface.addEventListener(
      "pointerdown",
      (event) => {
        pointerId = event.pointerId;
      },
      { once: true },
    );
    const rect = surface.getBoundingClientRect();
    const y = rect.y + rect.height * 0.6;
    await pointer({ action: "down", x: rect.x + rect.width / 2, y });
    await pointer({ action: "move", x: rect.x + rect.width * 0.7, y });
    expect(selection.getSelection()!.start).toBeCloseTo(3, 1);
    surface.dispatchEvent(new PointerEvent("pointercancel", { pointerId, bubbles: true }));
    expect(selection.getSelection()).toEqual({ start: 1, end: 2 });
    expect(surface.hasPointerCapture(pointerId)).toBe(false);
    await pointer({ action: "move", x: rect.x + rect.width * 0.8, y });
    await pointer({ action: "up" });
    expect(selection.getSelection()).toEqual({ start: 1, end: 2 });
    expect(onCommit).not.toHaveBeenCalled();
  });

  test("detach during a captured gesture leaves peer plugins intact and reattachment does not multiply commits", async () => {
    const onChange = vi.fn();
    const onCommit = vi.fn();
    const { view, surface, selection, attachment, root } = fixture({ onChange, onCommit });
    const marker = document.createElement("div");
    const peerCleanup = vi.fn();
    view.attach({
      attach(ctx) {
        ctx.mountOverlay(marker);
        ctx.onCleanup(peerCleanup);
      },
    });
    const rect = surface.getBoundingClientRect();
    const y = rect.y + rect.height * 0.6;
    await pointer({ action: "down", x: rect.x + rect.width * 0.3, y });
    await pointer({ action: "move", x: rect.x + rect.width * 0.5, y });
    attachment.destroy();
    const changes = onChange.mock.calls.length;
    await pointer({ action: "move", x: rect.x + rect.width * 0.7, y });
    await pointer({ action: "up" });
    expect(onChange).toHaveBeenCalledTimes(changes);
    expect(onCommit).not.toHaveBeenCalled();
    expect(root.querySelector("[data-testid=selection]")).toBeNull();
    expect(marker.isConnected).toBe(true);
    expect(peerCleanup).not.toHaveBeenCalled();
    for (let i = 0; i < 3; i++) view.attach(selection).destroy();
    view.attach(selection);
    await drag(surface, 6, 1, 2);
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(root.querySelectorAll("[data-testid=selection]")).toHaveLength(1);
  });

  test("selection has one owner per surface and can be attached again after detach", () => {
    const { view, selection, attachment } = fixture();
    expect(() => view.attach(selection)).toThrow(/already attached/);
    const second = createSelectionPlugin();
    expect(() => view.attach(second)).toThrow(/Selection owner/);
    attachment.destroy();
    expect(() => selection.setSelection({ start: 1, end: 2 })).toThrow(/not attached/);
    expect(() => view.attach(second)).not.toThrow();
  });

  test("independent marker and pointer coordinates follow zoom, scroll, source replacement and resize", async () => {
    const { root, view, surface, selection } = fixture();
    let context!: WaveformPluginContext;
    let updates = 0;
    const marker = document.createElement("span");
    marker.style.position = "absolute";
    marker.style.width = "2px";
    let markerTime = 3;
    view.attach({
      attach(ctx) {
        context = ctx;
        const layer = document.createElement("div");
        layer.append(marker);
        ctx.mountOverlay(layer);
        const draw = () => {
          marker.style.left = `${ctx.timeToX(markerTime)}px`;
          updates++;
        };
        ctx.onViewportChange(draw);
        ctx.onDataChange(draw);
        draw();
      },
    });
    const aligned = () => {
      expect(marker.getBoundingClientRect().x - surface.getBoundingClientRect().x).toBeCloseTo(context.timeToX(markerTime), 0);
    };
    aligned();
    const before = updates;
    view.setZoom(4);
    view.scrollTo(1.5);
    aligned();
    expect(updates).toBeGreaterThan(before);
    const viewport = element(root, "viewport").getBoundingClientRect();
    const fromX = viewport.x + viewport.width * 0.3;
    const toX = viewport.x + viewport.width * 0.6;
    const expected = { start: context.clientXToTime(fromX), end: context.clientXToTime(toX) };
    const y = surface.getBoundingClientRect().y + 100;
    await pointer({ action: "down", x: fromX, y });
    await pointer({ action: "move", x: toX, y });
    await pointer({ action: "up" });
    expect(selection.getSelection()!.start).toBeCloseTo(expected.start, 1);
    expect(selection.getSelection()!.end).toBeCloseTo(expected.end, 1);
    markerTime = 1;
    view.setData({ min: Float32Array.of(-0.2, -0.7), max: Float32Array.of(0.3, 0.6), duration: 2 });
    expect(selection.getSelection()).toBeNull();
    expect(view.getViewport().scrollLeft).toBe(0);
    expect(view.getViewport().duration).toBe(2);
    aligned();
    const oldWidth = view.getViewport().width;
    root.style.width = "360px";
    await expect.poll(() => view.getViewport().width).toBeLessThan(oldWidth);
    aligned();
  });

  test.each([{ data: { peaks: Float32Array.of(NaN), duration: 2 } }, { playhead: Infinity }])(
    "failed initial mount removes its DOM, observation and listeners: %j",
    (options) => {
      const root = host();
      const observe = vi.spyOn(ResizeObserver.prototype, "observe");
      const disconnect = vi.spyOn(ResizeObserver.prototype, "disconnect");
      const add = vi.spyOn(EventTarget.prototype, "addEventListener");
      const remove = vi.spyOn(EventTarget.prototype, "removeEventListener");
      expect(() => mountWaveform(root, options)).toThrow(RangeError);
      expect(root.childElementCount).toBe(0);
      expect(observe).toHaveBeenCalledTimes(1);
      expect(disconnect.mock.contexts).toContain(observe.mock.contexts[0]);
      const registrations = add.mock.calls.flatMap(([type, listener], index) => {
        const target = add.mock.contexts[index];
        return target instanceof HTMLElement && target.closest(".ar-waveform") ? [{ target, type, listener }] : [];
      });
      expect(registrations.length).toBeGreaterThan(0);
      for (const { target, type, listener } of registrations) {
        expect(
          remove.mock.calls.some(
            ([removedType, removedListener], index) => remove.mock.contexts[index] === target && removedType === type && removedListener === listener,
          ),
        ).toBe(true);
      }
    },
  );

  test("invalid data preserves the current view; playhead and accent remain host controlled", () => {
    const { root, view } = fixture();
    const data = element(root, "wave-path").getAttribute("d");
    expect(() => view.setData({ peaks: Float32Array.of(NaN), duration: 2 })).toThrow(RangeError);
    expect(element(root, "wave-path").getAttribute("d")).toBe(data);
    expect(view.getViewport().duration).toBe(6);
    expect(() => view.setZoom(NaN)).toThrow(RangeError);
    view.setPlayhead(3);
    expect(element(root, "playhead").hidden).toBe(false);
    expect(parseFloat(element(root, "playhead").style.left)).toBeCloseTo(view.getViewport().pixelsPerSecond * 3);
    view.setPlayhead(null);
    expect(element(root, "playhead").hidden).toBe(true);
    const path = element(root, "wave-path");
    const original = getComputedStyle(path).stroke;
    root.style.setProperty("--waveform-accent", "rgb(207, 101, 62)");
    expect(getComputedStyle(path).stroke).not.toBe(original);
  });
});
