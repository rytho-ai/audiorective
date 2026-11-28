import { untracked, type Readable } from "@audiorective/core";
import { effect } from "./detached-effect";
import type { WaveStretchAnchor } from "@audiorective/player";
export type { WaveStretchAnchor } from "@audiorective/player";
import type { TimeViewPlugin } from "./types";

export interface WarpMarkerOptions {
  /** Borrowed snapshots; replacement cancels stale drags and updates retained handles/focus in place. */
  anchors: Readable<readonly WaveStretchAnchor[]>;
  /** Original source sample-frame rate in hertz. */
  sampleRate: number;
  /** Total original source sample frames per channel. */
  sourceFrames: number;
  /** Maps committed output seconds to an original source sample-frame position. */
  sourceFrameAt(outputSeconds: number): number;
  /** Default false; true cancels input while keeping markers visible. */
  disabled?: Readable<boolean>;
  /** One owner edit after release or a key edit; Escape, pointercancel, capture loss and detach cancel previews. */
  onCommit(points: readonly WaveStretchAnchor[]): void;
  /** Optional accessible marker caption; omitted to use the built-in warp-marker caption. */
  label?: string;
}

/** Borrowed seconds-view editor: arrows move, Delete removes. Drags preview locally; PCM processing remains caller-owned. */
export function createWarpMarkers(options: WarpMarkerOptions): TimeViewPlugin {
  const { sampleRate, sourceFrames } = options;
  if (!Number.isInteger(sampleRate) || sampleRate <= 0 || !Number.isInteger(sourceFrames) || sourceFrames < 1)
    throw new RangeError("Warp markers need a positive sample rate and source frame count.");
  return {
    attach(ctx) {
      if (ctx.timeUnit !== "seconds") throw new Error("Warp markers need a seconds time view.");
      const root = document.createElement("div");
      root.className = "ar-warp-markers";
      ctx.mountOverlay(root);
      let points: readonly WaveStretchAnchor[] = [];
      let disabled = false;
      const handles: HTMLButtonElement[] = [];
      let drag: { pointerId: number; index: number; outputFrame: number; grabOffset: number } | undefined;
      let disposed = false;
      ctx.onCleanup(() => {
        disposed = true;
        finish();
      });
      const outputFrames = () => Math.round(ctx.duration * sampleRate);
      const indexOf = (event: Event) =>
        event.target instanceof HTMLButtonElement && event.target.parentElement === root ? handles.indexOf(event.target) : -1;

      function finish(): void {
        const previous = drag;
        drag = undefined;
        const handle = previous && handles[previous.index];
        if (previous && handle?.hasPointerCapture(previous.pointerId)) handle.releasePointerCapture(previous.pointerId);
      }
      function fit(index: number, frame: number): number {
        const min = (points[index - 1]?.outputFrame ?? 0) + 1;
        const max = (points[index + 1]?.outputFrame ?? outputFrames()) - 1;
        return Math.max(min, Math.min(max, frame));
      }
      function commit(index: number, outputFrame: number): void {
        if (points[index].outputFrame !== outputFrame) options.onCommit(points.map((point, i) => (i === index ? { ...point, outputFrame } : point)));
      }
      function render(): void {
        if (disposed) return;
        for (const [i, point] of points.entries()) {
          let button = handles[i];
          if (!button) {
            button = document.createElement("button");
            button.type = "button";
            button.className = "ar-warp-marker";
            button.setAttribute("role", "slider");
            button.style.cssText =
              "position:absolute;top:0;bottom:0;width:14px;min-width:0;min-height:0;padding:0;transform:translateX(-50%);border:0;border-radius:0;background:linear-gradient(90deg,transparent 44%,currentColor 44%,currentColor 56%,transparent 56%);color:var(--ar-warp-color,#806af7);cursor:ew-resize;pointer-events:auto;touch-action:none";
            const grip = document.createElement("span");
            grip.style.cssText =
              "position:absolute;top:4px;left:2px;width:10px;height:10px;background:currentColor;transform:rotate(45deg);pointer-events:none";
            button.append(grip);
            root.append(button);
            handles[i] = button;
          }
          const time = (drag?.index === i ? drag.outputFrame : point.outputFrame) / sampleRate;
          button.dataset.sourceFrame = String(point.sourceFrame);
          button.style.left = `${ctx.timeToX(time)}px`;
          button.disabled = disabled;
          button.style.pointerEvents = disabled ? "none" : "auto";
          button.setAttribute("aria-label", `${options.label ?? "Warp marker"} ${i + 1}`);
          button.setAttribute("aria-valuemin", String(((points[i - 1]?.outputFrame ?? 0) + 1) / sampleRate));
          button.setAttribute("aria-valuemax", String(((points[i + 1]?.outputFrame ?? outputFrames()) - 1) / sampleRate));
          button.setAttribute("aria-valuenow", String(time));
          button.setAttribute("aria-valuetext", `${(point.sourceFrame / sampleRate).toFixed(3)} → ${time.toFixed(3)} s`);
        }
        for (const extra of handles.splice(points.length)) extra.remove();
      }

      ctx.listen(root, "pointerdown", (event) => {
        const index = indexOf(event);
        if (!(event instanceof PointerEvent) || event.defaultPrevented || event.button !== 0 || index < 0 || disabled) return;
        event.preventDefault();
        event.stopPropagation();
        finish();
        handles[index].focus({ preventScroll: true });
        handles[index].setPointerCapture(event.pointerId);
        const outputFrame = points[index].outputFrame;
        drag = { pointerId: event.pointerId, index, outputFrame, grabOffset: outputFrame / sampleRate - ctx.clientXToTime(event.clientX) };
      });
      ctx.listen(root, "pointermove", (event) => {
        if (!(event instanceof PointerEvent) || drag?.pointerId !== event.pointerId) return;
        drag.outputFrame = fit(drag.index, Math.round((ctx.clientXToTime(event.clientX) + drag.grabOffset) * sampleRate));
        render();
      });
      ctx.listen(root, "pointerup", (event) => {
        if (!(event instanceof PointerEvent) || drag?.pointerId !== event.pointerId) return;
        const { index, outputFrame } = drag;
        finish();
        render();
        commit(index, outputFrame);
      });
      for (const type of ["pointercancel", "lostpointercapture"])
        ctx.listen(root, type, (event) => {
          if (!(event instanceof PointerEvent) || drag?.pointerId !== event.pointerId) return;
          finish();
          render();
        });
      ctx.listen(ctx.surface, "dblclick", (event) => {
        if (!(event instanceof MouseEvent) || event.defaultPrevented || indexOf(event) >= 0 || disabled) return;
        const time = ctx.clientXToTime(event.clientX);
        const outputFrame = Math.round(time * sampleRate);
        const sourceFrame = Math.round(options.sourceFrameAt(time));
        if (!Number.isFinite(sourceFrame) || outputFrame <= 0 || outputFrame >= outputFrames() || sourceFrame <= 0 || sourceFrame >= sourceFrames)
          return;
        const index = points.findIndex((point) => point.outputFrame >= outputFrame);
        const next = index < 0 ? points.length : index;
        if (
          (points[next - 1]?.sourceFrame ?? 0) >= sourceFrame ||
          (points[next]?.sourceFrame ?? sourceFrames) <= sourceFrame ||
          points[next]?.outputFrame === outputFrame
        )
          return;
        event.preventDefault();
        event.stopPropagation();
        options.onCommit([...points.slice(0, next), { sourceFrame, outputFrame }, ...points.slice(next)]);
      });
      ctx.listen(root, "keydown", (event) => {
        const index = indexOf(event);
        if (!(event instanceof KeyboardEvent) || index < 0 || disabled) return;
        if (!["Escape", "Delete", "Backspace", "ArrowLeft", "ArrowRight"].includes(event.key)) return;
        event.preventDefault();
        event.stopPropagation();
        finish();
        render();
        if (event.key === "Delete" || event.key === "Backspace") {
          options.onCommit(points.filter((_, i) => i !== index));
        } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
          const step = Math.max(1, Math.round(sampleRate * (event.shiftKey ? 0.1 : 0.01)));
          commit(index, fit(index, points[index].outputFrame + (event.key === "ArrowLeft" ? -step : step)));
        }
      });
      ctx.onViewportChange(render);
      ctx.onDataChange(() => {
        finish();
        render();
      });
      const apply = (next: readonly WaveStretchAnchor[], locked: boolean) => {
        if (next !== points || locked) finish();
        points = next;
        disabled = locked;
        render();
      };
      untracked(() => apply(options.anchors.value, options.disabled?.value ?? false));
      ctx.onCleanup(
        untracked(() =>
          effect(() => {
            const next = options.anchors.value;
            const locked = options.disabled?.value ?? false;
            if (next !== points || locked !== disabled) untracked(() => apply(next, locked));
          }),
        ),
      );
    },
  };
}
