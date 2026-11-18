import { effect, untracked, type Readable } from "@audiorective/core";
import { AutomationCurve, type AutomationPoint } from "@audiorective/core/automation";
import type { TimeViewPlugin } from "./types";

export interface AutomationOverlayOptions {
  points: Readable<readonly AutomationPoint[]>;
  onCommit(points: readonly AutomationPoint[]): void;
  fromView(time: number): number;
  toView(time: number): number;
  maxValue: number;
  defaultValue: number;
  snap?(time: number): number;
  label?: string;
}

/** Edit a borrowed curve over a time view, with a single commit at the end of each gesture. */
export function createAutomationOverlay(options: AutomationOverlayOptions): TimeViewPlugin {
  const { maxValue, defaultValue, fromView, toView } = options;
  if (!Number.isFinite(maxValue) || maxValue <= 0 || !Number.isFinite(defaultValue) || defaultValue < 0 || defaultValue > maxValue) {
    throw new RangeError("Automation overlay needs a positive maximum and an in-range default.");
  }
  const label = options.label ?? "Automation";
  return {
    attach(ctx) {
      const root = document.createElement("div");
      root.className = "ar-automation-overlay";
      root.style.color = "var(--ar-automation-color, #4cae91)";
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("aria-hidden", "true");
      svg.style.cssText = "position:absolute;inset:0;width:100%;height:100%;overflow:hidden";
      const path = document.createElementNS(svg.namespaceURI, "path");
      path.setAttribute("fill", "none");
      path.setAttribute("stroke", "currentColor");
      path.setAttribute("stroke-width", "2");
      svg.append(path);
      root.append(svg);
      ctx.mountOverlay(root);

      let points: readonly AutomationPoint[] = [];
      let interpolate: AutomationCurve | undefined;
      const handles: HTMLButtonElement[] = [];
      let drag: { index: number; pointerId: number; point: AutomationPoint } | undefined;
      const inset = 8;
      const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
      const viewTime = (time: number, alt: boolean) => clamp(!alt && options.snap ? options.snap(time) : time, 0, ctx.duration);
      const sourceTime = (x: number, alt: boolean) => fromView(viewTime(ctx.clientXToTime(x), alt));

      function endDrag(): void {
        const previous = drag;
        drag = undefined;
        const handle = previous && handles[previous.index];
        if (previous && handle?.hasPointerCapture(previous.pointerId)) handle.releasePointerCapture(previous.pointerId);
      }

      function movePoint(index: number, time: number, value: number): AutomationPoint {
        const point = points[index];
        const left = points[index - 1]?.time ?? -Infinity;
        const right = points[index + 1]?.time ?? Infinity;
        const gap = Math.min(1e-6, (point.time - left) / 2, (right - point.time) / 2);
        return { ...point, time: clamp(time, Math.max(fromView(0), left + gap), Math.min(fromView(ctx.duration), right - gap)), value };
      }

      function commitPoint(index: number, point: AutomationPoint): void {
        const previous = points[index];
        if (previous.time === point.time && previous.value === point.value && previous.shape === point.shape) return;
        options.onCommit(points.map((item, i) => (i === index ? point : item)));
      }

      function makeHandle(): HTMLButtonElement {
        const handle = document.createElement("button");
        handle.type = "button";
        handle.className = "ar-automation-point";
        handle.setAttribute("role", "slider");
        handle.setAttribute("aria-valuemin", "0");
        handle.setAttribute("aria-valuemax", String(maxValue));
        handle.style.cssText =
          "position:absolute;width:15px;height:15px;min-height:0;min-width:0;padding:0;border-radius:50%;border:2px solid currentColor;background:Canvas;color:inherit;transform:translate(-50%,-50%);pointer-events:auto;touch-action:none;cursor:grab";
        root.append(handle);
        return handle;
      }

      function render(): void {
        const { height } = ctx.getViewport();
        if (ctx.duration <= 0) {
          for (const handle of handles) handle.hidden = true;
          path.removeAttribute("d");
          return;
        }
        const x = (time: number) => ctx.timeToX(toView(time));
        const y = (value: number) => inset + Math.max(1, height - 2 * inset) * (1 - clamp(value / maxValue, 0, 1));
        const sourceStart = fromView(0);
        const sourceEnd = fromView(ctx.duration);
        const draft = drag;
        const visible = draft ? points.map((point, i) => (i === draft.index ? draft.point : point)) : points;
        const curve = draft ? new AutomationCurve(visible) : interpolate;
        const startValue = curve?.valueAt(sourceStart) ?? defaultValue;
        let line = `M0,${y(startValue)}`;
        let previous = visible.findLast((point) => point.time <= sourceStart);
        for (const point of visible) {
          if (point.time <= sourceStart || point.time > sourceEnd) continue;
          if (previous?.shape === "hold") line += ` H${x(point.time)}`;
          line += ` L${x(point.time)},${y(point.value)}`;
          previous = point;
        }
        const endValue = curve?.valueAt(sourceEnd) ?? defaultValue;
        line += ` L${ctx.timeToX(ctx.duration)},${y(endValue)}`;
        path.setAttribute("d", line);
        for (const [index, point] of visible.entries()) {
          const handle = handles[index] ?? (handles[index] = makeHandle());
          handle.hidden = point.time < sourceStart || point.time > sourceEnd;
          handle.dataset.index = String(index);
          handle.style.left = `${clamp(x(point.time), inset, ctx.timeToX(ctx.duration) - inset)}px`;
          handle.style.top = `${y(point.value)}px`;
          handle.setAttribute("aria-label", `${label} ${index + 1}`);
          handle.setAttribute("aria-valuenow", String(point.value));
          handle.setAttribute("aria-valuetext", `${point.value.toFixed(2)} · ${toView(point.time).toFixed(2)}`);
          handle.title = point.shape;
        }
        for (const handle of handles.splice(visible.length)) handle.remove();
      }

      function listenPointer(event: Event, callback: (pointer: PointerEvent) => void): void {
        if (event instanceof PointerEvent) callback(event);
      }
      const indexOf = (target: EventTarget | null) =>
        target instanceof HTMLButtonElement && target.parentElement === root ? Number(target.dataset.index) : -1;
      function pointerValue(clientY: number): number {
        const view = ctx.surface.getBoundingClientRect();
        const value = 1 - (clientY - view.top - inset) / Math.max(1, view.height - inset * 2);
        return Math.round(clamp(value, 0, 1) * maxValue * 100) / 100;
      }
      ctx.listen(root, "pointerdown", (event) =>
        listenPointer(event, (pointer) => {
          const index = indexOf(pointer.target);
          if (index < 0 || pointer.button !== 0) return;
          pointer.preventDefault();
          pointer.stopPropagation();
          endDrag();
          const handle = handles[index];
          handle.focus({ preventScroll: true });
          handle.setPointerCapture(pointer.pointerId);
          drag = { index, pointerId: pointer.pointerId, point: points[index] };
        }),
      );
      ctx.listen(root, "pointermove", (event) =>
        listenPointer(event, (pointer) => {
          if (drag?.pointerId !== pointer.pointerId) return;
          drag.point = movePoint(drag.index, sourceTime(pointer.clientX, pointer.altKey), pointerValue(pointer.clientY));
          render();
        }),
      );
      ctx.listen(root, "pointerup", (event) =>
        listenPointer(event, (pointer) => {
          if (drag?.pointerId !== pointer.pointerId) return;
          const { index, point } = drag;
          endDrag();
          render();
          commitPoint(index, point);
        }),
      );
      for (const type of ["pointercancel", "lostpointercapture"])
        ctx.listen(root, type, (event) =>
          listenPointer(event, (pointer) => {
            if (drag?.pointerId !== pointer.pointerId) return;
            endDrag();
            render();
          }),
        );
      ctx.listen(ctx.surface, "dblclick", (event) => {
        if (!(event instanceof MouseEvent) || indexOf(event.target) >= 0 || ctx.duration <= 0) return;
        event.preventDefault();
        event.stopPropagation();
        const time = sourceTime(event.clientX, event.altKey);
        if (points.some((point) => Math.abs(point.time - time) < 1e-9)) return;
        const next: AutomationPoint = { time, value: pointerValue(event.clientY), shape: "linear" };
        const start: AutomationPoint = { time: fromView(0), value: defaultValue, shape: "linear" };
        options.onCommit((!points.length && time > start.time ? [start, next] : [...points, next]).sort((a, b) => a.time - b.time));
      });
      ctx.listen(root, "keydown", (event) => {
        const index = indexOf(event.target);
        if (!(event instanceof KeyboardEvent) || index < 0) return;
        const point = points[index];
        const time = toView(point.time);
        let next: AutomationPoint;
        switch (event.key) {
          case "Escape":
            endDrag();
            render();
            break;
          case "Delete":
          case "Backspace":
            options.onCommit(points.filter((_, i) => i !== index));
            break;
          case "ArrowLeft":
          case "ArrowRight": {
            const step = (ctx.duration / 100) * (event.key === "ArrowLeft" ? -1 : 1);
            next = movePoint(index, fromView(viewTime(time + step, event.altKey)), point.value);
            commitPoint(index, next);
            break;
          }
          case "ArrowUp":
          case "ArrowDown":
            next = movePoint(index, point.time, clamp(point.value + (event.key === "ArrowUp" ? 0.05 : -0.05), 0, maxValue));
            commitPoint(index, next);
            break;
          case "Enter":
            commitPoint(index, { ...point, shape: point.shape === "linear" ? "hold" : "linear" });
            break;
          default:
            return;
        }
        event.preventDefault();
        event.stopPropagation();
      });
      ctx.onDataChange(() => {
        endDrag();
        render();
      });
      ctx.onViewportChange(render);
      function update(incoming: readonly AutomationPoint[]): void {
        endDrag();
        interpolate = incoming.length ? new AutomationCurve(incoming) : undefined;
        points = interpolate?.value ?? [];
        render();
      }
      let incoming = untracked(() => options.points.value);
      untracked(() => update(incoming));
      ctx.onCleanup(
        effect(() => {
          const next = options.points.value;
          if (next === incoming) return;
          incoming = next;
          untracked(() => update(next));
        }),
      );
      ctx.onCleanup(endDrag);
    },
  };
}
