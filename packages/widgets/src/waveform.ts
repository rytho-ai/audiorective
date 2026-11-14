/** Audio-independent waveform: cached PCM extrema, viewport and shared disposal-safe plugin mounts. */
import { cachePeaks, type Peaks } from "./peaks";
import { defaultRenderer } from "./renderer";
import { styles } from "./style";
import { createPluginHost } from "./plugin-host";

import type { WaveformViewport, WaveformOptions, WaveformHandle, WaveformRendererInstance } from "./types";
export { createSelectionPlugin } from "./selection";
export type {
  WaveformData,
  WaveformPeaks,
  WaveformViewport,
  WaveformPluginContext,
  WaveformPlugin,
  WaveformOptions,
  WaveformHandle,
  PluginAttachment,
  Unsubscribe,
  Selection,
  SnapMode,
  SelectionCommit,
  SelectionPluginOptions,
  SelectionModel,
  SelectionPlugin,
  WaveformRenderer,
  WaveformRendererInstance,
  WaveformRenderFrame,
} from "./types";
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
function hasFinitePeaks(peaks: Peaks): boolean {
  for (let i = 0; i < peaks.min.length; i++) {
    if (!Number.isFinite(peaks.min[i]) || !Number.isFinite(peaks.max[i])) return false;
  }
  return true;
}
const format = (t: number) => `${Math.floor(t / 60)}:${(t % 60).toFixed(2).padStart(5, "0")}`;
export function mountWaveform(root: HTMLElement, options: WaveformOptions = {}): WaveformHandle {
  const container = document.createElement("section");
  container.className = "ar-widget ar-waveform";
  container.setAttribute("aria-label", options.label ?? "Waveform");
  container.innerHTML = `<style>${styles}</style><div class="ar-toolbar"><button data-testid="zoom-out" type="button" aria-label="Zoom out">−</button><button data-testid="zoom-in" type="button" aria-label="Zoom in">+</button></div><div class="ar-viewport" data-testid="viewport" tabindex="0" aria-label="Waveform horizontal scroll"><div class="ar-track"><div class="ar-ruler" data-testid="ruler" aria-hidden="true"></div><div class="ar-wave" data-testid="waveform" role="group"><div class="ar-drawing" aria-hidden="true"></div><div class="ar-playhead" data-testid="playhead" hidden></div></div></div></div>`;
  root.append(container);
  const query = <T extends Element>(s: string) => container.querySelector<T>(s)!;
  const viewport = query<HTMLElement>("[data-testid=viewport]");
  const surface = query<HTMLElement>("[data-testid=waveform]");
  const track = query<HTMLElement>(".ar-track");
  const drawing = query<HTMLElement>(".ar-drawing");
  const ruler = query<HTMLElement>("[data-testid=ruler]");
  const playhead = query<HTMLElement>("[data-testid=playhead]");
  const zoomIn = query<HTMLButtonElement>("[data-testid=zoom-in]");
  const zoomOut = query<HTMLButtonElement>("[data-testid=zoom-out]");
  const viewportListeners = new Set<(v: WaveformViewport) => void>();
  const dataListeners = new Set<(duration: number) => void>();
  let renderer: WaveformRendererInstance | undefined;
  let peaks: Peaks | null = null,
    duration = 0,
    scale = 1,
    zoom = 1;
  let position = options.playhead ?? null,
    destroyed = false;
  const snapshot = (): WaveformViewport =>
    Object.freeze({ duration, pixelsPerSecond: scale, scrollLeft: viewport.scrollLeft, width: viewport.clientWidth, height: surface.clientHeight });
  const emitViewport = () => {
    const value = snapshot();
    for (const listener of [...viewportListeners]) listener(value);
  };
  const fit = () => (duration ? Math.max(1, viewport.clientWidth) / duration : 1);
  const maxScale = () => Math.max(128, fit() * 128);
  function drawPlayhead(): void {
    playhead.hidden = position === null || !duration;
    playhead.style.left = `${clamp(position ?? 0, 0, duration) * scale}px`;
    playhead.style.transform = position !== null && position >= duration ? "translateX(-100%)" : "";
  }
  function layout(): void {
    if (destroyed) return;
    scale = Math.min(maxScale(), fit() * zoom);
    const width = Math.max(viewport.clientWidth, duration * scale),
      height = surface.clientHeight || 180;
    track.style.width = `${width}px`;
    renderer?.render(Object.freeze({ peaks, width, height, pixelsPerSecond: scale }));
    ruler.replaceChildren();
    const target = 85 / scale,
      exponent = 10 ** Math.floor(Math.log10(target || 1));
    const interval = [1, 2, 5, 10].map((v) => v * exponent).find((v) => v >= target) ?? exponent * 10;
    for (let time = 0; time <= duration; time += interval) {
      const tick = document.createElement("span");
      tick.className = "ar-tick";
      tick.style.left = `${time * scale}px`;
      tick.textContent = format(time);
      ruler.append(tick);
    }
    zoomOut.disabled = !duration || zoom <= 1;
    zoomIn.disabled = !duration || scale >= maxScale();
    drawPlayhead();
    emitViewport();
  }
  function setZoom(factor: number): void {
    if (destroyed) throw new Error("Waveform is destroyed.");
    if (!Number.isFinite(factor) || factor < 1) throw new RangeError("Zoom must be finite and at least 1.");
    const middle = (viewport.scrollLeft + viewport.clientWidth / 2) / scale;
    zoom = clamp(factor, 1, maxScale() / fit());
    layout();
    viewport.scrollLeft = middle * scale - viewport.clientWidth / 2;
    emitViewport();
  }
  const zoomInClick = () => setZoom(zoom * 2);
  const zoomOutClick = () => setZoom(Math.max(1, zoom / 2));
  zoomIn.addEventListener("click", zoomInClick);
  zoomOut.addEventListener("click", zoomOutClick);
  viewport.addEventListener("scroll", emitViewport);
  const resize = new ResizeObserver(layout);
  resize.observe(viewport);
  const plugins = createPluginHost("waveform", ({ isActive, own }) => ({
    surface,
    get duration() {
      return duration;
    },
    getViewport: snapshot,
    timeToX: (seconds) => clamp(seconds, 0, duration) * scale,
    clientXToTime: (x) => clamp((x - surface.getBoundingClientRect().left) / scale, 0, duration),
    scrollBy(pixels) {
      if (isActive()) {
        viewport.scrollLeft += pixels;
        emitViewport();
      }
    },
    getViewportRect: () => viewport.getBoundingClientRect(),
    mountOverlay(element) {
      if (!isActive()) throw new Error("Plugin attachment is destroyed.");
      Object.assign(element.style, { position: "absolute", inset: "0", pointerEvents: "none" });
      surface.append(element);
      return own(() => element.remove());
    },
    onViewportChange(listener) {
      viewportListeners.add(listener);
      return own(() => viewportListeners.delete(listener));
    },
    onDataChange(listener) {
      dataListeners.add(listener);
      return own(() => dataListeners.delete(listener));
    },
    listen(target, type, listener) {
      target.addEventListener(type, listener);
      return own(() => target.removeEventListener(type, listener));
    },
    onCleanup: own,
  }));
  const handle: WaveformHandle = {
    setData(data) {
      if (destroyed) throw new Error("Waveform is destroyed.");
      let next: Peaks | null = null;
      if (data) {
        if ("getChannelData" in data) next = cachePeaks(data);
        else if ("peaks" in data) {
          const min = new Float32Array(data.peaks.length),
            max = new Float32Array(data.peaks.length);
          for (let i = 0; i < min.length; i++) {
            const p = Math.abs(data.peaks[i]);
            min[i] = -p;
            max[i] = p;
          }
          next = { min, max, duration: data.duration };
        } else next = { min: data.min.slice(), max: data.max.slice(), duration: data.duration };
        if (!Number.isFinite(next.duration) || next.duration <= 0 || next.min.length !== next.max.length || !next.min.length || !hasFinitePeaks(next))
          throw new RangeError("Waveform data needs finite peaks and a positive duration.");
      }
      peaks = next;
      duration = next?.duration ?? 0;
      zoom = 1;
      viewport.scrollLeft = 0;
      position = position === null ? null : clamp(position, 0, duration);
      // Data invalidation happens before drawing the new viewport; plugins cancel gestures here.
      for (const listener of [...dataListeners]) listener(duration);
      layout();
    },
    setPlayhead(seconds) {
      if (destroyed) return;
      if (seconds !== null && !Number.isFinite(seconds)) throw new RangeError("Playhead must be finite or null.");
      position = seconds;
      drawPlayhead();
    },
    getViewport: snapshot,
    setZoom,
    scrollTo(seconds) {
      if (destroyed) return;
      viewport.scrollLeft = clamp(seconds, 0, duration) * scale;
      emitViewport();
    },
    attach: (plugin) => plugins.attach(plugin),
    destroy() {
      if (destroyed) return;
      destroyed = true;
      plugins.destroy();
      try {
        renderer?.destroy?.();
      } catch (error) {
        console.error("Waveform renderer cleanup failed:", error);
      }
      renderer = undefined;
      resize.disconnect();
      viewport.removeEventListener("scroll", emitViewport);
      zoomIn.removeEventListener("click", zoomInClick);
      zoomOut.removeEventListener("click", zoomOutClick);
      viewportListeners.clear();
      dataListeners.clear();
      peaks = null;
      container.remove();
    },
  };
  try {
    renderer = (options.renderer ?? defaultRenderer)(drawing);
    handle.setPlayhead(options.playhead ?? null);
    if (options.data) handle.setData(options.data);
    else layout();
  } catch (error) {
    handle.destroy();
    throw error;
  }
  return handle;
}
