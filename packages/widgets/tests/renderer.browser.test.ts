import { afterEach, describe, expect, test, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { mountWaveformSelector, type WaveformRenderer as SelectorRenderer, type WaveformRenderFrame as SelectorFrame } from "../src";
import {
  createSelectionPlugin,
  mountWaveform,
  type WaveformPluginContext,
  type WaveformRenderer,
  type WaveformRendererInstance,
  type WaveformRenderFrame,
} from "../src/waveform";
import { bandsFile, cleanup, delay, drag, element, host, own, pointer } from "./helpers";

/** Consumer implementation: independent SVG bars, without the built-in path generator. */
function svgRenderer() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  const frames: WaveformRenderFrame[] = [];
  const destroy = vi.fn(() => svg.remove());
  const mount = vi.fn((container: HTMLElement): WaveformRendererInstance => {
    container.append(svg);
    return {
      render(frame) {
        frames.push(frame);
        svg.setAttribute("viewBox", `0 0 ${frame.width} ${frame.height}`);
        svg.replaceChildren();
        const peaks = frame.peaks;
        if (!peaks) return;
        for (let i = 0; i < peaks.min.length; i++) {
          const bar = document.createElementNS(svg.namespaceURI, "rect");
          bar.setAttribute("x", String((i / peaks.min.length) * frame.width));
          bar.setAttribute("width", String(frame.width / peaks.min.length));
          bar.setAttribute("y", String(((1 - peaks.max[i]) * frame.height) / 2));
          bar.setAttribute("height", String(((peaks.max[i] - peaks.min[i]) * frame.height) / 2));
          bar.setAttribute("fill", "#d43a6c");
          svg.append(bar);
        }
      },
      destroy,
    };
  });
  const renderer: WaveformRenderer = mount;
  return { renderer, svg, frames, mount, destroy };
}

/** Consumer implementation: CSS-pixel bitmap drawing from the same public frame. */
function canvasRenderer() {
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d")!;
  const frames: WaveformRenderFrame[] = [];
  const destroy = vi.fn(() => canvas.remove());
  const renderer: SelectorRenderer = (container) => {
    container.append(canvas);
    return {
      render(frame: SelectorFrame) {
        frames.push(frame);
        canvas.width = Math.ceil(frame.width);
        canvas.height = Math.ceil(frame.height);
        canvas.style.width = `${frame.width}px`;
        canvas.style.height = `${frame.height}px`;
        const peaks = frame.peaks;
        if (!peaks) return;
        context.fillStyle = "rgb(19, 173, 227)";
        for (let i = 0; i < peaks.min.length; i++) {
          context.fillRect(
            (i / peaks.min.length) * frame.width,
            ((1 - peaks.max[i]) * frame.height) / 2,
            frame.width / peaks.min.length,
            ((peaks.max[i] - peaks.min[i]) * frame.height) / 2,
          );
        }
      },
      destroy,
    };
  };
  const pixel = (x: number, y: number) => Array.from(context.getImageData(Math.floor(x), Math.floor(y), 1, 1).data);
  return { renderer, canvas, frames, destroy, pixel };
}

function audioPeak(analyser: AnalyserNode): number {
  const samples = new Float32Array(analyser.fftSize);
  analyser.getFloatTimeDomainData(samples);
  return samples.reduce((max, sample) => Math.max(max, Math.abs(sample)), 0);
}

afterEach(async () => {
  await cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("public custom waveform renderers", () => {
  test("SVG bars receive copied extrema and full content dimensions through zoom, resize, replacement and clear", async () => {
    const root = host();
    const custom = svgRenderer();
    const min = Float32Array.of(-0.25, -0.5);
    const max = Float32Array.of(0.5, 1);
    const view = mountWaveform(root, { renderer: custom.renderer, data: { min, max, duration: 4 } });
    own(() => view.destroy());
    await expect.poll(() => custom.frames.length).toBeGreaterThan(1); // Initial ResizeObserver delivery.
    const first = custom.frames.at(-1)!;
    const bars = () => Array.from(custom.svg.querySelectorAll("rect"));
    expect(root.querySelector("[data-testid=wave-path]")).toBeNull();
    expect(custom.svg.parentElement!.getAttribute("aria-hidden")).toBe("true");
    expect(getComputedStyle(custom.svg.parentElement!).pointerEvents).toBe("none");
    expect(bars()).toHaveLength(2);
    expect(bars()[0].getBoundingClientRect().width).toBeCloseTo(first.width / 2, 0);
    expect(bars()[0].getBoundingClientRect().height).toBeCloseTo(first.height * 0.375, 0);
    expect(first.width).toBeCloseTo(view.getViewport().width);
    expect(first.pixelsPerSecond * 4).toBeCloseTo(first.width);
    expect(first.height).toBe(element(root, "waveform").clientHeight);
    expect(Object.isFrozen(first)).toBe(true);
    min.fill(-1);
    max.fill(0);
    expect(Array.from(first.peaks!.min)).toEqual([-0.25, -0.5]);
    expect(Array.from(first.peaks!.max)).toEqual([0.5, 1]);
    view.setZoom(3);
    const zoomed = custom.frames.at(-1)!;
    expect(zoomed.peaks).toBe(first.peaks);
    expect(zoomed.width).toBeCloseTo(first.width * 3);
    expect(bars()[1].getBoundingClientRect().x - custom.svg.getBoundingClientRect().x).toBeCloseTo(zoomed.width / 2, 0);
    const draws = custom.frames.length;
    view.scrollTo(1);
    view.setPlayhead(2);
    await delay(30);
    expect(custom.frames).toHaveLength(draws);
    expect(parseFloat(element(root, "playhead").style.left)).toBeCloseTo(zoomed.pixelsPerSecond * 2);
    root.style.width = "360px";
    root.style.setProperty("--waveform-height", "120px");
    await expect.poll(() => custom.frames.at(-1)!.width).toBeLessThan(zoomed.width);
    const resized = custom.frames.at(-1)!;
    expect(resized.height).toBe(120);
    expect(resized.width).toBeCloseTo(view.getViewport().width * 3);
    expect(resized.peaks).toBe(first.peaks);
    expect(custom.svg.getBoundingClientRect().height).toBe(120);
    view.setData({ peaks: Float32Array.of(0.75), duration: 2 });
    expect(bars()).toHaveLength(1);
    expect(custom.frames.at(-1)!.peaks).not.toBe(first.peaks);
    expect(custom.frames.at(-1)!.peaks!.duration).toBe(2);
    expect(bars()[0].getBoundingClientRect().height).toBeCloseTo(90);
    expect(view.getViewport().scrollLeft).toBe(0);
    expect(custom.frames.at(-1)!.width).toBe(view.getViewport().width);
    view.setData(null);
    expect(custom.frames.at(-1)!.peaks).toBeNull();
    expect(bars()).toHaveLength(0);
    expect(custom.mount).toHaveBeenCalledTimes(1);
    view.destroy();
    view.destroy();
    expect(custom.destroy).toHaveBeenCalledTimes(1);
    expect(root.childElementCount).toBe(0);
  });

  test("Canvas paints actual pixels, clears on null, and cannot intercept selection gestures", async () => {
    const createAudio = vi.fn(() => {
      throw new Error("Drawing must not create audio");
    });
    vi.stubGlobal("AudioContext", createAudio);
    vi.stubGlobal("OfflineAudioContext", createAudio);
    const root = host();
    const custom = canvasRenderer();
    const view = mountWaveform(root, { renderer: custom.renderer });
    own(() => view.destroy());
    expect(custom.frames[0].peaks).toBeNull();
    expect(custom.pixel(10, 10)[3]).toBe(0);
    view.setData({ min: Float32Array.of(-0.5, -0.25), max: Float32Array.of(0.5, 0.75), duration: 4 });
    const { width, height } = custom.frames.at(-1)!;
    expect(custom.canvas.width).toBe(Math.ceil(width));
    expect(custom.canvas.height).toBe(Math.ceil(height));
    expect(custom.pixel(width / 4, height / 2)).toEqual([19, 173, 227, 255]);
    expect(custom.pixel(width / 4, 1)[3]).toBe(0);
    expect(custom.pixel((width * 3) / 4, height / 6)).toEqual([19, 173, 227, 255]);
    const selection = createSelectionPlugin();
    view.attach(selection);
    await drag(element(root, "waveform"), 4, 1, 3);
    expect(selection.getSelection()!.start).toBeCloseTo(1, 1);
    expect(selection.getSelection()!.end).toBeCloseTo(3, 1);
    view.setData(null);
    expect(custom.pixel(width / 4, height / 2)[3]).toBe(0);
    expect(selection.getSelection()).toBeNull();
    expect(createAudio).not.toHaveBeenCalled();
  });

  test("PCM extrema combine channels once and cached renderer data survives redraws without rescanning PCM", async () => {
    const root = host();
    const custom = svgRenderer();
    const buffer = new AudioBuffer({ length: 256, numberOfChannels: 2, sampleRate: 8000 });
    buffer.getChannelData(0).fill(-0.75);
    buffer.getChannelData(1).fill(0.5);
    const reads = vi.spyOn(buffer, "getChannelData");
    const view = mountWaveform(root, { renderer: custom.renderer, data: buffer });
    own(() => view.destroy());
    await expect.poll(() => custom.frames.length).toBeGreaterThan(1);
    const cached = custom.frames.at(-1)!.peaks!;
    expect(cached.duration).toBe(buffer.duration);
    expect(Array.from(cached.min)).toEqual([-0.75, -0.75]);
    expect(Array.from(cached.max)).toEqual([0.5, 0.5]);
    expect(reads).toHaveBeenCalledTimes(2);
    // Source mutation makes accidental rescans observable in both data and geometry.
    buffer.copyToChannel(new Float32Array(256), 0);
    buffer.copyToChannel(new Float32Array(256), 1);
    view.setZoom(2);
    root.style.width = "380px";
    const previousWidth = custom.frames.at(-1)!.width;
    await expect.poll(() => custom.frames.at(-1)!.width).toBeLessThan(previousWidth);
    expect(reads).toHaveBeenCalledTimes(2);
    expect(custom.frames.at(-1)!.peaks).toBe(cached);
    const bar = custom.svg.querySelector("rect")!;
    expect(bar.getBoundingClientRect().height).toBeCloseTo(custom.frames.at(-1)!.height * 0.625, 0);
    view.setData(buffer);
    expect(reads).toHaveBeenCalledTimes(4);
    expect(custom.svg.querySelector("rect")!.getBoundingClientRect().height).toBe(0);
  });

  test("custom SVG, snapped selection and independent overlays share coordinates after zoom and scroll", async () => {
    const root = host();
    const custom = svgRenderer();
    const view = mountWaveform(root, { renderer: custom.renderer, data: { peaks: Float32Array.of(0.3, 0.8, 0.5, 0.4), duration: 8 } });
    own(() => view.destroy());
    const commits = vi.fn();
    const selection = createSelectionPlugin({ grid: { beats: [0, 1, 2, 3, 4, 5, 6, 7, 8], downbeats: [0, 4, 8] }, snap: "beat", onCommit: commits });
    view.attach(selection);
    const marker = document.createElement("div");
    Object.assign(marker.style, { position: "absolute", top: "0", height: "100%", width: "2px", background: "orange" });
    const overlayControl = document.createElement("button");
    overlayControl.textContent = "Marker action";
    Object.assign(overlayControl.style, { position: "absolute", top: "0", left: "0", pointerEvents: "auto" });
    const activateOverlay = vi.fn();
    let context!: WaveformPluginContext;
    view.attach({
      attach(ctx) {
        context = ctx;
        const layer = document.createElement("div");
        layer.append(marker, overlayControl);
        ctx.mountOverlay(layer);
        ctx.listen(overlayControl, "pointerdown", (event) => event.preventDefault());
        ctx.listen(overlayControl, "click", activateOverlay);
        const draw = () => {
          marker.style.left = `${ctx.timeToX(2)}px`;
          overlayControl.style.left = `${ctx.timeToX(4)}px`;
        };
        ctx.onViewportChange(draw);
        draw();
      },
    });
    view.setZoom(2);
    view.scrollTo(1);
    const surface = element(root, "waveform");
    const rect = surface.getBoundingClientRect();
    const bar = custom.svg.querySelectorAll("rect")[1];
    expect(marker.getBoundingClientRect().x).toBeCloseTo(bar.getBoundingClientRect().x, 0);
    expect(marker.getBoundingClientRect().x - rect.x).toBeCloseTo(custom.frames.at(-1)!.pixelsPerSecond * 2, 0);
    const y = rect.y + rect.height * 0.6;
    const at = (time: number) => rect.x + context.timeToX(time);
    await pointer({ action: "down", x: at(2.2), y });
    await pointer({ action: "move", x: at(3.7), y });
    await pointer({ action: "up" });
    expect(selection.getSelection()).toEqual({ start: 2, end: 4 });
    expect(commits).toHaveBeenLastCalledWith({ kind: "pointer", selection: { start: 2, end: 4 } });
    expect(element(root, "selection").getBoundingClientRect().x).toBeCloseTo(marker.getBoundingClientRect().x, 0);
    const grip = element<HTMLButtonElement>(root, "selection-start");
    const gripBounds = grip.getBoundingClientRect();
    await pointer({ action: "down", x: gripBounds.x + gripBounds.width / 2, y: gripBounds.y + gripBounds.height / 2 });
    await pointer({ action: "move", x: at(3.1), y });
    await pointer({ action: "up" });
    expect(selection.getSelection()).toEqual({ start: 3, end: 4 });
    grip.focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(selection.getSelection()).toEqual({ start: 3.01, end: 4 });
    const committed = commits.mock.calls.length;
    const controlBounds = overlayControl.getBoundingClientRect();
    await pointer({ action: "down", x: controlBounds.x + controlBounds.width / 2, y: controlBounds.y + controlBounds.height / 2 });
    await pointer({ action: "up" });
    expect(activateOverlay).toHaveBeenCalledTimes(1);
    expect(commits).toHaveBeenCalledTimes(committed);
    expect(selection.getSelection()).toEqual({ start: 3.01, end: 4 });
    await pointer({ action: "down", x: at(1.25), y, alt: true });
    await pointer({ action: "move", x: at(2.25), y, alt: true });
    await pointer({ action: "up", alt: true });
    expect(selection.getSelection()!.start).toBeCloseTo(1.25, 1);
    expect(selection.getSelection()!.end).toBeCloseTo(2.25, 1);
  });

  test("the complete selector forwards Canvas drawing while retaining loading, selection and owned audio cleanup", async () => {
    const context = new AudioContext();
    own(() => context.close());
    const root = host();
    const custom = canvasRenderer();
    const onSelectionChange = vi.fn();
    const selector = mountWaveformSelector(root, { context, source: bandsFile(), renderer: custom.renderer, onSelectionChange });
    own(() => selector.destroy());
    await selector.ready;
    const frame = custom.frames.at(-1)!;
    expect(frame.peaks!.duration).toBeCloseTo(6);
    const painted = custom.pixel(frame.width / 2, frame.height / 2);
    // Dense PCM bins overlap fractional pixels; antialiasing changes alpha and RGB rounding.
    expect(painted[3]).toBeGreaterThan(0);
    expect(painted[2]).toBeGreaterThan(200);
    expect(painted[1]).toBeGreaterThan(150);
    expect(painted[0]).toBeLessThan(30);
    expect(root.querySelector("[data-testid=wave-path]")).toBeNull();
    const analyser = context.createAnalyser();
    selector.output.connect(analyser);
    analyser.connect(context.destination);
    own(() => analyser.disconnect());
    await drag(element(root, "waveform"), 6, 2.2, 3.2);
    expect(selector.getState().selection!.start).toBeCloseTo(2.2, 1);
    expect(selector.getState().selection!.end).toBeCloseTo(3.2, 1);
    expect(onSelectionChange).toHaveBeenCalled();
    await expect.poll(() => audioPeak(analyser)).toBeGreaterThan(0.1);
    await selector.load(bandsFile(3));
    expect(selector.getState()).toMatchObject({ duration: 3, selection: null, isPlaying: false, loading: false, error: null });
    expect(custom.frames.at(-1)!.peaks!.duration).toBeCloseTo(3);
    selector.setSelection({ start: 0.5, end: 1.5 });
    element<HTMLButtonElement>(root, "play-pause").click();
    await expect.poll(() => audioPeak(analyser)).toBeGreaterThan(0.1);
    const peer = context.createOscillator();
    const peerGain = context.createGain();
    const peerAnalyser = context.createAnalyser();
    peerGain.gain.value = 0.1;
    peer.connect(peerGain).connect(peerAnalyser).connect(context.destination);
    peer.start();
    own(() => {
      peer.stop();
      peer.disconnect();
      peerGain.disconnect();
      peerAnalyser.disconnect();
    });
    await expect.poll(() => audioPeak(peerAnalyser)).toBeGreaterThan(0.05);
    selector.destroy();
    selector.destroy();
    await expect.poll(() => audioPeak(analyser)).toBeLessThan(0.001);
    expect(audioPeak(peerAnalyser)).toBeGreaterThan(0.05);
    expect(custom.destroy).toHaveBeenCalledTimes(1);
    expect(context.state).toBe("running");
    expect(root.childElementCount).toBe(0);
  });

  test.each(["factory", "initial render"])("a failed %s removes pure-view and selector DOM and disconnects observation", (failure) => {
    const context = new AudioContext();
    own(() => context.close());
    const root = host();
    const sentinel = document.createElement("span");
    root.append(sentinel);
    const disconnect = vi.spyOn(ResizeObserver.prototype, "disconnect");
    const observe = vi.spyOn(ResizeObserver.prototype, "observe");
    const destroy = vi.fn();
    const error = new Error(`custom ${failure} failed`);
    const renderer: WaveformRenderer = (container) => {
      container.append(document.createElement("canvas"));
      if (failure === "factory") throw error;
      return {
        render() {
          throw error;
        },
        destroy,
      };
    };
    expect(() => mountWaveform(root, { renderer })).toThrow(error);
    expect(Array.from(root.children)).toEqual([sentinel]);
    expect(() => mountWaveformSelector(root, { context, renderer })).toThrow(error);
    expect(Array.from(root.children)).toEqual([sentinel]);
    expect(disconnect).toHaveBeenCalledTimes(2);
    for (const observer of observe.mock.contexts) expect(disconnect.mock.contexts).toContain(observer);
    expect(destroy).toHaveBeenCalledTimes(failure === "factory" ? 0 : 2);
    expect(context.state).not.toBe("closed");
  });

  test("a throwing renderer destroy still disposes plugins, observers and listeners exactly once", async () => {
    const root = host();
    const destroyError = new Error("custom drawing teardown failed");
    const destroy = vi.fn(() => {
      throw destroyError;
    });
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const disconnect = vi.spyOn(ResizeObserver.prototype, "disconnect");
    const render = vi.fn();
    const view = mountWaveform(root, { renderer: () => ({ render, destroy }), data: { peaks: Float32Array.of(1), duration: 4 } });
    own(() => view.destroy());
    const marker = document.createElement("div");
    const cleanupPlugin = vi.fn();
    const input = vi.fn();
    const viewportChange = vi.fn();
    const selection = createSelectionPlugin();
    view.attach(selection);
    view.attach({
      attach(ctx) {
        ctx.mountOverlay(marker);
        ctx.listen(window, "renderer-regression", input);
        ctx.onViewportChange(viewportChange);
        ctx.onCleanup(cleanupPlugin);
      },
    });
    const surface = element(root, "waveform");
    const viewport = element(root, "viewport");
    const zoom = element<HTMLButtonElement>(root, "zoom-in");
    let pointerId = 0;
    surface.addEventListener(
      "pointerdown",
      (event) => {
        pointerId = event.pointerId;
      },
      { once: true },
    );
    const rect = surface.getBoundingClientRect();
    await pointer({ action: "down", x: rect.x + rect.width * 0.25, y: rect.y + rect.height / 2 });
    await pointer({ action: "move", x: rect.x + rect.width * 0.5, y: rect.y + rect.height / 2 });
    expect(surface.hasPointerCapture(pointerId)).toBe(true);
    view.destroy();
    view.destroy();
    expect(surface.hasPointerCapture(pointerId)).toBe(false);
    const draws = render.mock.calls.length;
    const changes = viewportChange.mock.calls.length;
    window.dispatchEvent(new Event("renderer-regression"));
    viewport.dispatchEvent(new Event("scroll"));
    zoom.click();
    root.style.width = "360px";
    await delay(30);
    expect(render).toHaveBeenCalledTimes(draws);
    expect(viewportChange).toHaveBeenCalledTimes(changes);
    expect(input).not.toHaveBeenCalled();
    expect(selection.getSelection()).toBeNull();
    expect(marker.isConnected).toBe(false);
    expect(cleanupPlugin).toHaveBeenCalledTimes(1);
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(errorLog).toHaveBeenCalledWith("Waveform renderer cleanup failed:", destroyError);
    expect(root.childElementCount).toBe(0);
  });

  test("a throwing drawing teardown cannot interrupt selector audio and animation cleanup", async () => {
    const context = new AudioContext();
    own(() => context.close());
    const root = host();
    const custom = canvasRenderer();
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const destroyError = new Error("failed canvas disposal");
    custom.destroy.mockImplementation(() => {
      throw destroyError;
    });
    const selector = mountWaveformSelector(root, { context, source: bandsFile(), renderer: custom.renderer });
    own(() => selector.destroy());
    await selector.ready;
    const analyser = context.createAnalyser();
    selector.output.connect(analyser);
    analyser.connect(context.destination);
    own(() => analyser.disconnect());
    element<HTMLButtonElement>(root, "play-pause").click();
    await expect.poll(() => audioPeak(analyser)).toBeGreaterThan(0.1);
    const cancelAnimation = vi.spyOn(window, "cancelAnimationFrame");
    selector.destroy();
    const canceled = cancelAnimation.mock.calls.length;
    expect(canceled).toBeGreaterThan(0);
    selector.destroy();
    expect(cancelAnimation).toHaveBeenCalledTimes(canceled);
    await expect.poll(() => audioPeak(analyser)).toBeLessThan(0.001);
    const draws = custom.frames.length;
    root.style.width = "360px";
    await delay(30);
    expect(custom.frames).toHaveLength(draws);
    expect(selector.getState().isPlaying).toBe(false);
    expect(custom.destroy).toHaveBeenCalledTimes(1);
    expect(errorLog).toHaveBeenCalledWith("Waveform renderer cleanup failed:", destroyError);
    expect(context.state).toBe("running");
    expect(root.childElementCount).toBe(0);
  });
});
