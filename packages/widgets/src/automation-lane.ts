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
  readonly duration: number;
  readonly maxValue: number;
  readonly defaultValue: number;
  readonly points: readonly AutomationPoint[];
  readonly label?: string;
  readonly labels?: LaneLabels;
  /** Project seconds and linear gain or another caller-defined scalar. */
  onCommit(points: readonly AutomationPoint[]): void;
}

export interface AutomationLaneHandle {
  setPoints(points: readonly AutomationPoint[]): void;
  dispose(): void;
}

const clamp = (value: number, max: number) => Math.max(0, Math.min(value, max));
const round = (value: number) => Math.round(value * 100) / 100;

/** Draw and edit a borrowed envelope, committing once per gesture. */
export function mountAutomationLane(root: HTMLElement, options: AutomationLaneOptions): AutomationLaneHandle {
  const { duration, maxValue, defaultValue } = options;
  if (!(Number.isFinite(duration) && duration > 0 && Number.isFinite(maxValue) && maxValue > 0))
    throw new RangeError("Automation lane needs a positive duration and maximum value.");
  const labels = options.labels ?? {
    time: "Time (s)",
    value: "Value",
    shape: "Shape",
    linear: "Linear",
    hold: "Hold",
    add: "Add point",
    remove: "Delete point",
  };
  const view = document.createElement("div");
  view.className = "ar-automation-lane";
  view.setAttribute("role", "group");
  view.setAttribute("aria-label", options.label ?? "Automation lane");
  const graph = document.createElement("canvas");
  graph.className = "ar-automation-graph";
  graph.style.cssText = "display:block;width:100%;height:126px;touch-action:none;cursor:crosshair";
  const drawing = graph.getContext("2d");
  if (!drawing) throw new Error("Automation lane needs a 2D canvas.");
  const controls = document.createElement("div");
  controls.className = "ar-automation-controls";
  const numberInput = (name: string, max: number) => {
    const node = document.createElement("input");
    node.type = "number";
    node.min = "0";
    node.max = String(max);
    node.step = "any";
    node.setAttribute("aria-label", name);
    return node;
  };
  const time = numberInput(labels.time, duration);
  const value = numberInput(labels.value, maxValue);
  const shape = document.createElement("select");
  shape.setAttribute("aria-label", labels.shape);
  shape.add(new Option(labels.linear, "linear"));
  shape.add(new Option(labels.hold, "hold"));
  const remove = document.createElement("button");
  remove.type = "button";
  remove.textContent = labels.remove;
  const picker = document.createElement("select");
  picker.setAttribute("aria-label", options.label ?? "Automation points");
  const add = document.createElement("button");
  add.type = "button";
  add.textContent = "+";
  add.setAttribute("aria-label", labels.add);
  const field = (name: string, input: HTMLElement) => {
    const label = document.createElement("label");
    label.append(name, input);
    return label;
  };
  controls.append(picker, add, field(labels.time, time), field(labels.value, value), field(labels.shape, shape), remove);
  view.append(graph, controls);
  root.append(view);

  let points = options.points.slice().sort((a, b) => a.time - b.time);
  let selectedTime: number | undefined;
  let gesture: { pointerId: number; previous?: AutomationPoint; point: AutomationPoint } | undefined;

  function replace(point: AutomationPoint, previous?: AutomationPoint): AutomationPoint[] {
    const collision = points.find((item) => item.time === point.time && item !== previous);
    if (collision) return points;
    if (points.length === 0 && point.time > 0) return [{ time: 0, value: defaultValue, shape: "linear" }, point];
    return [...points.filter((item) => item !== previous), point].sort((a, b) => a.time - b.time);
  }

  function draw(): void {
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

  function setPoints(next: readonly AutomationPoint[]): void {
    gesture = undefined;
    points = next.slice().sort((a, b) => a.time - b.time);
    const selected = points.find((point) => point.time === selectedTime) ?? points[0];
    selectedTime = selected?.time;
    const entries = points.map((point) => new Option(`${Number(point.time.toFixed(3))} s`, String(point.time)));
    picker.replaceChildren(...entries);
    picker.disabled = !selected;
    time.disabled = value.disabled = shape.disabled = remove.disabled = !selected;
    time.value = selected ? String(selected.time) : "";
    value.value = selected ? String(selected.value) : "";
    shape.value = selected?.shape ?? "linear";
    if (selected) picker.value = String(selected.time);
    draw();
  }

  function commit(point: AutomationPoint, previous?: AutomationPoint): void {
    if (previous && point.time === previous.time && point.value === previous.value && point.shape === previous.shape) {
      selectedTime = previous.time;
      setPoints(points);
      return;
    }
    const next = replace(point, previous);
    if (next !== points) {
      selectedTime = point.time;
      options.onCommit(next);
    }
    setPoints(points);
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
    if (event.button !== 0 || gesture) return;
    const rect = graph.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const previous = points.find(
      (point) =>
        Math.hypot(
          event.clientX - rect.left - (point.time / duration) * rect.width,
          event.clientY - rect.bottom + (point.value / maxValue) * rect.height,
        ) < 10,
    );
    graph.setPointerCapture(event.pointerId);
    gesture = { pointerId: event.pointerId, previous, point: previous ?? projectPoint(event, "linear") };
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
    gesture = undefined;
    commit(point, previous);
  };
  const cancel = (event: PointerEvent) => {
    if (gesture?.pointerId !== event.pointerId) return;
    gesture = undefined;
    draw();
  };
  graph.onpointercancel = graph.onlostpointercapture = cancel;
  picker.onchange = () => {
    selectedTime = Number(picker.value);
    setPoints(points);
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
      setPoints(points);
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
    options.onCommit(points.filter((point) => point.time !== selectedTime));
    setPoints(points);
  };
  const resize = new ResizeObserver(draw);
  resize.observe(graph);
  setPoints(points);
  return {
    setPoints,
    dispose() {
      resize.disconnect();
      view.remove();
    },
  };
}
