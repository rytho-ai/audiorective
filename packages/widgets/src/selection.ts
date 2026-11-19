/** Selection metadata and interaction only. No audio transport or context dependency. */
import { prepareGrid, snapTime } from "./snap-time";
import type { Selection, WaveformPluginContext, Unsubscribe, SnapMode, SelectionCommit, SelectionPluginOptions, SelectionPlugin } from "./types";
export type { SnapMode, SelectionCommit, SelectionPluginOptions, SelectionPlugin } from "./types";
// Shared symbol also guards independently loaded ESM copies (e.g. dev-server query URLs).
const ownerKey: unique symbol = Symbol.for("audiorective.waveform.selection-owner");
type OwnedSurface = HTMLElement & { [ownerKey]?: object };
const MIN_RANGE = 0.05;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
type Gesture = {
  id: number;
  kind: "new" | "start" | "end";
  anchor: number;
  originX: number;
  x: number;
  alt: boolean;
  moved: boolean;
  original: Selection | null;
};
export function createSelectionPlugin(options: SelectionPluginOptions = {}): SelectionPlugin {
  let range: Selection | null = null,
    context: WaveformPluginContext | null = null;
  let snap: SnapMode = options.snap ?? "off";
  let redraw = () => {};
  const grid = prepareGrid(options.grid);
  const copy = (): Selection | null => {
    const value = options.model ? options.model.getSelection() : range;
    return value ? { ...value } : null;
  };
  function change(next: Selection | null): void {
    if (options.model) options.model.setSelection(next);
    else range = next ? { start: next.start, end: next.end } : null;
    redraw();
    options.onChange?.(copy());
  }
  function commit(kind: SelectionCommit["kind"], time?: number): void {
    const range = copy();
    options.onCommit?.(Object.freeze({ selection: range ? Object.freeze({ ...range }) : null, kind, ...(time === undefined ? {} : { time }) }));
  }
  const plugin: SelectionPlugin = {
    getSelection: copy,
    setSelection(selection) {
      if (!context) throw new Error("Selection plugin is not attached.");
      if (
        selection &&
        (!Number.isFinite(selection.start) ||
          !Number.isFinite(selection.end) ||
          selection.start < 0 ||
          selection.start >= selection.end ||
          selection.end > context.duration)
      ) {
        throw new RangeError("Selection must satisfy 0 <= start < end <= duration (finite seconds).");
      }
      change(selection);
      commit("programmatic");
    },
    setSnap(mode) {
      snap = mode;
    },
    setGrid(next) {
      Object.assign(grid, prepareGrid(next));
    },
    attach(ctx) {
      if (context) throw new Error("Selection plugin is already attached.");
      const surface = ctx.surface as OwnedSurface;
      if (surface[ownerKey]) throw new Error("Waveform already has a Selection owner.");
      surface[ownerKey] = plugin;
      context = ctx;
      const layer = document.createElement("div");
      layer.innerHTML =
        '<div data-testid="selection" class="ar-selection" hidden></div><button data-testid="selection-start" class="ar-grip" type="button" role="slider" aria-label="Selection start" hidden></button><button data-testid="selection-end" class="ar-grip" type="button" role="slider" aria-label="Selection end" hidden></button>';
      const overlay = layer.querySelector<HTMLElement>("[data-testid=selection]")!;
      const start = layer.querySelector<HTMLButtonElement>("[data-testid=selection-start]")!;
      const end = layer.querySelector<HTMLButtonElement>("[data-testid=selection-end]")!;
      start.style.pointerEvents = end.style.pointerEvents = "auto";
      ctx.mountOverlay(layer);
      let gesture: Gesture | null = null,
        frame = 0,
        disposed = false;
      redraw = () => {
        const range = ctx.duration ? copy() : null;
        overlay.hidden = start.hidden = end.hidden = !range;
        if (!range) return;
        overlay.style.left = `${ctx.timeToX(range.start)}px`;
        overlay.style.width = `${ctx.timeToX(range.end) - ctx.timeToX(range.start)}px`;
        const viewport = ctx.getViewport();
        const width = Math.max(viewport.width, ctx.duration * viewport.pixelsPerSecond);
        // Keep the entire 18px grip inside the track at fit boundaries.
        for (const [grip, value] of [
          [start, range.start],
          [end, range.end],
        ] as const) {
          const boundary = ctx.timeToX(value);
          const left = clamp(boundary - 9, 0, Math.max(0, width - 18));
          grip.style.left = `${left}px`;
          grip.style.setProperty("--ar-grip-boundary", `${boundary - left}px`);
          grip.setAttribute("aria-valuemin", "0");
          grip.setAttribute("aria-valuemax", String(ctx.duration));
          grip.setAttribute("aria-valuenow", String(value));
          grip.setAttribute("aria-valuetext", `${value.toFixed(3)} seconds`);
        }
      };
      function snapped(time: number, alt: boolean): number {
        const points = !alt && snap !== "off" ? grid[snap] : null;
        return snapTime(time, points ?? undefined, ctx.duration);
      }
      const timeAt = (x: number, alt: boolean) => snapped(ctx.clientXToTime(x), alt);
      function cancel(revert = true): void {
        const g = gesture;
        gesture = null;
        if (!g) return;
        stop();
        if (ctx.surface.hasPointerCapture(g.id)) ctx.surface.releasePointerCapture(g.id);
        if (revert && g.moved) change(g.original);
      }
      function update(): void {
        const g = gesture;
        if (!g?.moved) return;
        const time = timeAt(g.x, g.alt);
        const min = Math.min(MIN_RANGE, ctx.duration, g.kind === "new" || !g.original ? MIN_RANGE : g.original.end - g.original.start);
        if (g.kind === "new") {
          let a = Math.min(g.anchor, time),
            b = Math.max(g.anchor, time);
          if (b - a < min) {
            if (time >= g.anchor) b = Math.min(ctx.duration, a + min);
            else a = Math.max(0, b - min);
            if (b - a < min) {
              a = Math.max(0, b - min);
              b = Math.min(ctx.duration, a + min);
            }
          }
          change({ start: a, end: b });
        } else if (g.original)
          change(
            g.kind === "start"
              ? { start: clamp(time, 0, g.original.end - min), end: g.original.end }
              : { start: g.original.start, end: clamp(time, g.original.start + min, ctx.duration) },
          );
      }
      ctx.listen(ctx.surface, "pointerdown", (event) => {
        const e = event as PointerEvent;
        if (e.button !== 0 || !ctx.duration || gesture) return;
        // Independent overlay controls may opt out by preventing the event.
        if (e.defaultPrevented) return;
        e.preventDefault();
        const kind = e.target === start ? "start" : e.target === end ? "end" : "new";
        if (kind !== "new") (kind === "start" ? start : end).focus();
        gesture = {
          id: e.pointerId,
          kind,
          anchor: timeAt(e.clientX, e.altKey),
          originX: e.clientX,
          x: e.clientX,
          alt: e.altKey,
          moved: false,
          original: copy(),
        };
        ctx.surface.setPointerCapture(e.pointerId);
      });
      ctx.listen(ctx.surface, "pointermove", (event) => {
        const e = event as PointerEvent;
        if (!gesture || gesture.id !== e.pointerId) return;
        gesture.x = e.clientX;
        gesture.alt = e.altKey;
        gesture.moved ||= Math.abs(e.clientX - gesture.originX) >= 3;
        update();
        schedule();
      });
      ctx.listen(ctx.surface, "pointerup", (event) => {
        const e = event as PointerEvent;
        if (!gesture || gesture.id !== e.pointerId) return;
        gesture.x = e.clientX;
        gesture.alt = e.altKey;
        gesture.moved ||= Math.abs(e.clientX - gesture.originX) >= 3;
        update();
        if (!gesture || disposed) return;
        const g = gesture;
        cancel(false);
        if (g.moved) commit("pointer");
        else if (g.kind === "new") {
          const time = timeAt(e.clientX, e.altKey);
          const range = copy();
          if (range && (time < range.start || time >= range.end)) change(null);
          commit("click", time);
        }
      });
      ctx.listen(ctx.surface, "pointercancel", (event) => {
        if (gesture?.id === (event as PointerEvent).pointerId) cancel();
      });
      ctx.listen(ctx.surface, "lostpointercapture", (event) => {
        if (gesture?.id === (event as PointerEvent).pointerId) cancel();
      });
      for (const [grip, boundary] of [
        [start, "start"],
        [end, "end"],
      ] as const)
        ctx.listen(grip, "keydown", (event) => {
          const e = event as KeyboardEvent;
          const range = copy();
          if (!range || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
          e.preventDefault();
          const next = range[boundary] + (e.shiftKey ? 0.1 : 0.01) * (e.key === "ArrowLeft" ? -1 : 1);
          const min = Math.min(MIN_RANGE, range.end - range.start);
          change(
            boundary === "start"
              ? { start: clamp(next, 0, Math.max(0, range.end - min)), end: range.end }
              : { start: range.start, end: clamp(next, Math.min(ctx.duration, range.start + min), ctx.duration) },
          );
          if (!disposed) commit("keyboard");
        });
      ctx.onViewportChange(redraw);
      ctx.onDataChange(() => {
        cancel(false);
        if (options.model) redraw();
        else change(null);
      });
      if (options.model) ctx.onCleanup(options.model.subscribe(() => redraw()));
      // The edge-scroll loop runs only while a drag is in progress.
      function schedule(): void {
        if (!frame && !disposed && gesture?.moved) frame = requestAnimationFrame(tick);
      }
      function stop(): void {
        cancelAnimationFrame(frame);
        frame = 0;
      }
      function tick(): void {
        frame = 0;
        if (disposed) return;
        if (gesture?.moved) {
          const rect = ctx.getViewportRect();
          const amount = gesture.x < rect.left + 24 ? -8 : gesture.x > rect.right - 24 ? 8 : 0;
          if (amount) {
            ctx.scrollBy(amount);
            update();
          }
        }
        schedule();
      }
      range = null;
      redraw();
      const destroy: Unsubscribe = () => {
        if (disposed) return;
        disposed = true;
        cancel(false);
        stop();
        range = null;
        redraw = () => {};
        context = null;
        if (surface[ownerKey] === plugin) delete surface[ownerKey];
      };
      ctx.onCleanup(destroy);
      return { destroy };
    },
  };
  return plugin;
}
