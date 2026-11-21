import { effect, untracked } from "@audiorective/core";
import type { AutomationPoint } from "@audiorective/core/automation";

type LaneLabels = Readonly<{
  time: string;
  value: string;
  shape: string;
  linear: string;
  hold: string;
  add: string;
  remove: string;
}>;

export interface AutomationLaneOptions {
  /** Positive length in timeUnit at mount. Tracked changes cancel previews; later non-positive/non-finite lengths disable input until valid. */
  readonly duration: () => number;
  readonly maxValue: number;
  readonly defaultValue: number;
  /** Borrowed tracked snapshots; AutomationCurve and readonlyCell projections fit directly. */
  readonly points: { readonly value: readonly AutomationPoint[] };
  /** Picker/input coordinates; default seconds. No unit conversion is performed. */
  readonly timeUnit?: "seconds" | "beats";
  readonly label?: string;
  readonly labels?: LaneLabels;
  /** One owner command per finished gesture, in timeUnit and the caller's scalar unit. */
  onCommit(points: readonly AutomationPoint[]): void;
}

export interface AutomationLaneHandle {
  dispose(): void;
}

const clamp = (value: number, max: number) => Math.max(0, Math.min(value, max));
const round = (value: number) => Math.round(value * 100) / 100;

/** Draw and edit a borrowed envelope, committing once per gesture. */
export function mountAutomationLane(root: HTMLElement, options: AutomationLaneOptions): AutomationLaneHandle {
  const { maxValue, defaultValue } = options;
  let duration = untracked(() => options.duration());
  const doc = root.ownerDocument;
  const unit = options.timeUnit === "beats" ? "beats" : "s";
  if (!(Number.isFinite(duration) && duration > 0 && Number.isFinite(maxValue) && maxValue > 0))
    throw new RangeError("Automation lane needs a positive duration and maximum value.");
  const labels = options.labels ?? {
    time: `Time (${unit})`,
    value: "Value",
    shape: "Shape",
    linear: "Linear",
    hold: "Hold",
    add: "Add point",
    remove: "Delete point",
  };
  const view = doc.createElement("div");
  view.className = "ar-automation-lane";
  view.setAttribute("role", "group");
  view.setAttribute("aria-label", options.label ?? "Automation lane");
  const graph = doc.createElement("canvas");
  graph.className = "ar-automation-graph";
  graph.style.cssText = "display:block;width:100%;height:126px;touch-action:none;cursor:crosshair";
  const drawing = graph.getContext("2d");
  if (!drawing) throw new Error("Automation lane needs a 2D canvas.");
  const controls = doc.createElement("div");
  controls.className = "ar-automation-controls";
  const numberInput = (name: string, max: number) => {
    const node = doc.createElement("input");
    node.type = "number";
    node.min = "0";
    node.max = String(max);
    node.step = "any";
    node.setAttribute("aria-label", name);
    return node;
  };
  const time = numberInput(labels.time, duration);
  const value = numberInput(labels.value, maxValue);
  const shape = doc.createElement("select");
  shape.setAttribute("aria-label", labels.shape);
  const option = (text: string, value: string) => {
    const item = doc.createElement("option");
    item.textContent = text;
    item.value = value;
    return item;
  };
  shape.add(option(labels.linear, "linear"));
  shape.add(option(labels.hold, "hold"));
  const remove = doc.createElement("button");
  remove.type = "button";
  remove.textContent = labels.remove;
  const picker = doc.createElement("select");
  picker.setAttribute("aria-label", options.label ?? "Automation points");
  const add = doc.createElement("button");
  add.type = "button";
  add.textContent = "+";
  add.setAttribute("aria-label", labels.add);
  const field = (name: string, input: HTMLElement) => {
    const label = doc.createElement("label");
    label.append(name, input);
    return label;
  };
  controls.append(picker, add, field(labels.time, time), field(labels.value, value), field(labels.shape, shape), remove);
  view.append(graph, controls);
  root.append(view);

  let incoming = untracked(() => options.points.value);
  let points: readonly AutomationPoint[] = incoming.slice().sort((a, b) => a.time - b.time);
  let disposed = false;
  let enabled = true;
  let selectedTime: number | undefined;
  let gesture: { pointerId: number; previous?: AutomationPoint; point: AutomationPoint } | undefined;
  const abort = new AbortController();
  view.addEventListener(
    "keydown",
    (event) => {
      if (event.key === "Escape" && !gesture && (event.target === time || event.target === value)) syncControls();
    },
    { signal: abort.signal },
  );
  function escape(event: KeyboardEvent): void {
    if (event.key !== "Escape" || !gesture) return;
    cancelGesture();
    syncControls();
    event.preventDefault();
    event.stopPropagation();
  }

  function cancelGesture(): void {
    const previous = gesture;
    gesture = undefined;
    doc.removeEventListener("keydown", escape, true);
    if (previous && graph.hasPointerCapture(previous.pointerId)) graph.releasePointerCapture(previous.pointerId);
  }

  function replace(point: AutomationPoint, previous?: AutomationPoint): readonly AutomationPoint[] {
    const collision = points.find((item) => item.time === point.time && item !== previous);
    if (collision) return points;
    if (points.length === 0 && point.time > 0) return [{ time: 0, value: defaultValue, shape: "linear" }, point];
    return [...points.filter((item) => item !== previous), point].sort((a, b) => a.time - b.time);
  }

  function draw(): void {
    if (disposed) return;
    const ctx = drawing!;
    const bounds = graph.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    const scale = devicePixelRatio || 1;
    const width = Math.max(1, Math.round(bounds.width * scale));
    const height = Math.max(1, Math.round(bounds.height * scale));
    if (graph.width !== width || graph.height !== height) {
      graph.width = width;
      graph.height = height;
    }
    const x = (seconds: number) => (seconds / duration) * width;
    const y = (gain: number) => height * (1 - clamp(gain, maxValue) / maxValue);
    const color = getComputedStyle(graph).color;
    const preview = gesture ? replace(gesture.point, gesture.previous) : points;
    ctx.clearRect(0, 0, width, height);
    if (!enabled) return;
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = scale;
    ctx.globalAlpha = 0.15;
    ctx.beginPath();
    for (let i = 0; i <= 4; i++) {
      ctx.moveTo((width * i) / 4, 0);
      ctx.lineTo((width * i) / 4, height);
      ctx.moveTo(0, (height * i) / 4);
      ctx.lineTo(width, (height * i) / 4);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.lineWidth = 2 * scale;
    ctx.beginPath();
    ctx.moveTo(0, y(preview[0]?.value ?? defaultValue));
    preview.forEach((point, index) => {
      const previous = preview[index - 1];
      if (previous?.shape === "hold") ctx.lineTo(x(point.time), y(previous.value));
      ctx.lineTo(x(point.time), y(point.value));
    });
    ctx.lineTo(width, y(preview.at(-1)?.value ?? defaultValue));
    ctx.stroke();
    for (const point of preview) {
      ctx.beginPath();
      ctx.arc(x(point.time), y(point.value), (point.time === selectedTime ? 5 : 3.5) * scale, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function syncControls(): void {
    if (disposed) return;
    const selected = points.find((point) => point.time === selectedTime) ?? points[0];
    selectedTime = selected?.time;
    const entries = points.map((point) => option(`${Number(point.time.toFixed(3))} ${unit}`, String(point.time)));
    picker.replaceChildren(...entries);
    picker.disabled = !enabled || !selected;
    add.disabled = !enabled;
    graph.setAttribute("aria-disabled", String(!enabled));
    graph.tabIndex = enabled ? 0 : -1;
    graph.style.cursor = enabled ? "crosshair" : "default";
    time.max = String(duration);
    time.disabled = value.disabled = shape.disabled = remove.disabled = !enabled || !selected;
    time.value = selected ? String(selected.time) : "";
    value.value = selected ? String(selected.value) : "";
    shape.value = selected?.shape ?? "linear";
    if (selected) picker.value = String(selected.time);
    draw();
  }

  function commit(point: AutomationPoint, previous?: AutomationPoint): void {
    if (disposed || !enabled) {
      syncControls();
      return;
    }
    if (previous && point.time === previous.time && point.value === previous.value && point.shape === previous.shape) {
      selectedTime = previous.time;
      syncControls();
      return;
    }
    const next = replace(point, previous);
    if (next !== points) {
      const previousTime = previous?.time ?? selectedTime;
      selectedTime = point.time;
      try {
        options.onCommit(next);
      } finally {
        if (!points.some((item) => item.time === point.time)) selectedTime = previousTime;
        syncControls();
      }
    } else {
      syncControls();
    }
  }

  function projectPoint(event: PointerEvent, mode: AutomationPoint["shape"]): AutomationPoint {
    const rect = graph.getBoundingClientRect();
    return {
      time: clamp(round(((event.clientX - rect.left) / rect.width) * duration), duration),
      value: clamp(round(((rect.bottom - event.clientY) / rect.height) * maxValue), maxValue),
      shape: mode,
    };
  }

  graph.onpointerdown = (event) => {
    if (disposed || !enabled || event.defaultPrevented || event.button !== 0 || gesture) return;
    event.preventDefault();
    const rect = graph.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const previous = points.find(
      (point) =>
        Math.hypot(
          event.clientX - rect.left - (point.time / duration) * rect.width,
          event.clientY - rect.bottom + (point.value / maxValue) * rect.height,
        ) < 10,
    );
    graph.focus({ preventScroll: true });
    graph.setPointerCapture(event.pointerId);
    gesture = { pointerId: event.pointerId, previous, point: previous ?? projectPoint(event, "linear") };
    doc.addEventListener("keydown", escape, true);
    draw();
  };
  graph.onpointermove = (event) => {
    if (gesture?.pointerId !== event.pointerId) return;
    gesture.point = projectPoint(event, gesture.point.shape);
    draw();
  };
  graph.onpointerup = (event) => {
    if (gesture?.pointerId !== event.pointerId) return;
    const { point, previous } = gesture;
    cancelGesture();
    commit(point, previous);
  };
  const cancel = (event: PointerEvent) => {
    if (gesture?.pointerId !== event.pointerId) return;
    cancelGesture();
    draw();
  };
  graph.onpointercancel = graph.onlostpointercapture = cancel;
  picker.onchange = () => {
    selectedTime = Number(picker.value);
    syncControls();
  };
  const edit = () => {
    const previous = points.find((point) => point.time === selectedTime);
    if (
      !previous ||
      !time.checkValidity() ||
      !value.checkValidity() ||
      !Number.isFinite(time.valueAsNumber) ||
      !Number.isFinite(value.valueAsNumber)
    ) {
      syncControls();
      return;
    }
    commit({ time: time.valueAsNumber, value: value.valueAsNumber, shape: shape.value === "hold" ? "hold" : "linear" }, previous);
  };
  time.onchange = value.onchange = shape.onchange = edit;
  add.onclick = () => {
    // Choose an unused position without changing the authored envelope's starting value.
    let index = 0;
    const steps = points.length + 1;
    while (points.some((point) => point.time === (index * duration) / steps)) index++;
    const t = (index * duration) / steps;
    const left = points.findLast((point) => point.time <= t);
    const right = points.find((point) => point.time > t);
    const v =
      left?.shape === "linear" && right
        ? left.value + ((right.value - left.value) * (t - left.time)) / (right.time - left.time)
        : (left?.value ?? right?.value ?? defaultValue);
    commit({ time: t, value: v, shape: left?.shape ?? "linear" });
  };
  remove.onclick = () => {
    if (disposed || !enabled) return;
    try {
      options.onCommit(points.filter((point) => point.time !== selectedTime));
    } finally {
      syncControls();
    }
  };
  graph.tabIndex = 0;
  const resize = new ResizeObserver(draw);
  resize.observe(graph);
  syncControls();
  const stop = untracked(() =>
    effect(() => {
      const next = options.points.value;
      const nextDuration = options.duration();
      const nextEnabled = Number.isFinite(nextDuration) && nextDuration > 0;
      if (next === incoming && nextDuration === duration && nextEnabled === enabled) return;
      untracked(() => {
        cancelGesture();
        enabled = nextEnabled;
        incoming = next;
        points = next.slice().sort((a, b) => a.time - b.time);
        if (enabled) duration = nextDuration;
        syncControls();
      });
    }),
  );
  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      cancelGesture();
      abort.abort();
      stop();
      graph.onpointerdown = graph.onpointermove = graph.onpointerup = graph.onpointercancel = graph.onlostpointercapture = null;
      picker.onchange = time.onchange = value.onchange = shape.onchange = null;
      add.onclick = remove.onclick = null;
      resize.disconnect();
      view.remove();
    },
  };
}
