import { untracked } from "@audiorective/core";
import { effect } from "./detached-effect";

export type ParameterValue = {
  /** Editable amount in the parameter's native units; never implicitly normalized. */
  value: number;
  /** Optional inclusive native-unit bound; required on the value or widget options. */
  readonly min?: number;
  /** Optional inclusive native-unit bound; required on the value or widget options. */
  readonly max?: number;
  /** Optional positive native-unit increment; omission permits continuous editing. */
  readonly step?: number;
  /** Optional control caption; used unless widget options override it. */
  readonly label?: string;
  /** Optional native-value formatter; presentation only, without changing stored values. */
  readonly display?: (value: number) => string;
};

export type ParameterOptions = {
  /** Borrowed mutable parameter; all edits write directly to its value. */
  param: ParameterValue;
  /** Inclusive native-unit bound; defaults to param.min and must be finite. */
  min?: number;
  /** Inclusive native-unit bound; defaults to param.max and must exceed min. */
  max?: number;
  /** Positive native-unit increment; defaults to param.step, otherwise continuous. */
  step?: number;
  /** Pointer-to-value mapping; defaults to "linear", and "log" requires a positive minimum. */
  scale?: "linear" | "log";
  /** Control presentation; defaults to "horizontal". */
  orientation?: "horizontal" | "vertical" | "rotary";
  /** Accessible caption; defaults to param.label, then "Parameter". */
  label?: string;
  /** Readout formatter; defaults to param.display, then five-significant-digit text. */
  format?: (value: number) => string;
};

export interface ParameterHandle {
  /** Mounted control root; removed when this view is disposed. */
  readonly element: HTMLElement;
  /** Releases resources owned by this attachment or view; safe to call twice. */
  dispose(): void;
}

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));

/** Mount a slider, fader or knob over a borrowed, preferably reactive numeric parameter. */
export function mountParameter(root: HTMLElement, options: ParameterOptions): ParameterHandle {
  const { param, orientation = "horizontal", scale = "linear" } = options;
  const min = options.min ?? param.min;
  const max = options.max ?? param.max;
  const step = options.step ?? param.step;
  if (min === undefined || max === undefined || !Number.isFinite(min) || !Number.isFinite(max) || min >= max || (scale === "log" && min <= 0))
    throw new RangeError("Parameter control needs a finite increasing range and a positive minimum for log scale.");
  if (step !== undefined && (!Number.isFinite(step) || step <= 0)) throw new RangeError("Parameter control step must be positive.");
  const label = options.label ?? param.label ?? "Parameter";
  const format = options.format ?? param.display ?? ((value: number) => String(Number(value.toPrecision(5))));
  const logRange = scale === "log" ? Math.log(max / min) : 0;
  const normalize = (value: number) => {
    const bounded = clamp(value, min, max);
    return logRange ? Math.log(bounded / min) / logRange : (bounded - min) / (max - min);
  };
  const denormalize = (value: number) => {
    const normalized = clamp(value, 0, 1);
    return logRange ? min * Math.exp(normalized * logRange) : min + normalized * (max - min);
  };
  const write = (raw: number) => {
    const value = raw <= min ? min : raw >= max ? max : step ? min + Math.round((raw - min) / step) * step : raw;
    const next = clamp(Number(value.toPrecision(13)), min, max);
    if (next !== param.value) param.value = next;
    refresh(param.value, true);
  };

  const doc = root.ownerDocument;
  const element = doc.createElement("label");
  element.className = "ar-parameter";
  element.dataset.orientation = orientation;
  element.style.cssText = "display:inline-grid;gap:4px;justify-items:start;min-width:0";
  const caption = doc.createElement("span");
  caption.textContent = label;
  const readout = doc.createElement("span");
  readout.className = "ar-parameter-value";
  const range = orientation === "rotary" ? null : doc.createElement("input");
  const control = range ?? doc.createElement("span");
  control.setAttribute("aria-label", label);
  control.className = "ar-parameter-input";
  const abort = new AbortController();
  const listener = { signal: abort.signal };
  let mark: HTMLElement | undefined;
  if (range) {
    range.type = "range";
    range.min = String(logRange ? 0 : min);
    range.max = String(logRange ? 1 : max);
    range.step = logRange || step === undefined ? "any" : String(step);
    if (orientation === "vertical") {
      range.style.cssText = "writing-mode:vertical-lr;direction:rtl;height:90px;width:24px";
      range.setAttribute("aria-orientation", "vertical");
    }
    range.addEventListener("input", () => write(logRange ? denormalize(range.valueAsNumber) : range.valueAsNumber), listener);
  } else {
    control.tabIndex = 0;
    control.setAttribute("role", "slider");
    control.setAttribute("aria-valuemin", String(min));
    control.setAttribute("aria-valuemax", String(max));
    control.setAttribute("aria-orientation", "vertical");
    control.style.cssText =
      "display:block;position:relative;width:38px;height:38px;border:1px solid currentColor;border-radius:50%;touch-action:none;cursor:ns-resize";
    mark = doc.createElement("span");
    mark.style.cssText =
      "position:absolute;left:calc(50% - 1px);top:4px;width:2px;height:calc(50% - 4px);background:currentColor;transform-origin:bottom";
    control.append(mark);
    let pointer: { id: number; y: number; position: number } | undefined;
    control.addEventListener(
      "pointerdown",
      (event) => {
        if (event.button !== 0 || pointer) return;
        event.preventDefault();
        control.focus();
        control.setPointerCapture(event.pointerId);
        pointer = { id: event.pointerId, y: event.clientY, position: normalize(param.value) };
      },
      listener,
    );
    control.addEventListener(
      "pointermove",
      (event) => {
        if (pointer?.id === event.pointerId) write(denormalize(pointer.position + (pointer.y - event.clientY) / (event.shiftKey ? 1200 : 120)));
      },
      listener,
    );
    const end = (event: PointerEvent) => {
      if (pointer?.id === event.pointerId) pointer = undefined;
    };
    for (const name of ["pointerup", "pointercancel", "lostpointercapture"] as const) control.addEventListener(name, end, listener);
  }
  control.addEventListener(
    "keydown",
    (event) => {
      const direction = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1 }[event.key];
      if (event.key === "Home") write(min);
      else if (event.key === "End") write(max);
      else if (direction) {
        const current = param.value;
        write(step && !logRange ? current + step * direction : denormalize(normalize(current) + direction * (event.shiftKey ? 0.001 : 0.01)));
        // A log step rounded to the same value still needs to move on a key press.
        if (step && current === param.value) write(current + step * direction);
      } else return;
      event.preventDefault();
      event.stopPropagation();
    },
    listener,
  );

  const draw = (value: number) => {
    const position = normalize(value);
    const text = format(value);
    readout.textContent = text;
    control.setAttribute("aria-valuetext", text);
    if (range) range.value = String(logRange ? position : value);
    else {
      control.setAttribute("aria-valuenow", String(clamp(value, min, max)));
      mark!.style.transform = `rotate(${position * 270 - 135}deg)`;
    }
  };
  let shown = param.value;
  function refresh(value: number, force = false) {
    if (force || !Object.is(value, shown)) {
      untracked(() => draw(value));
      shown = value;
    }
  }
  draw(shown);
  element.append(caption, control, readout);
  root.append(element);
  const stop = effect(() => refresh(param.value));
  return {
    element,
    dispose() {
      if (abort.signal.aborted) return;
      abort.abort();
      stop();
      element.remove();
    },
  };
}
