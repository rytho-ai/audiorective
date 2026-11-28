import { untracked, type Readable } from "@audiorective/core";
import { effect } from "./detached-effect";

/** Linear gain and edge fades in clip-local seconds. */
export type ClipEnvelope = Readonly<{
  /** Nonnegative linear amplitude factor; 1 is unity. */
  gain: number;
  /** Leading fade length in clip-local seconds, constrained by the remaining clip duration. */
  fadeIn: number;
  /** Trailing fade length in clip-local seconds, constrained by the remaining clip duration. */
  fadeOut: number;
}>;

export type ClipEnvelopeEditorOptions = Readonly<{
  /** Tracked clip-local seconds; updates mounted fade limits in place. */
  duration: () => number;
  /** Borrowed reactive settings; the widget reports edits without replacing this reader. */
  envelope: Readable<ClipEnvelope>;
  /** Reports edited linear gain and second-based fades; caller commits them to the model. */
  onChange(envelope: ClipEnvelope): void;
  /** Optional captions for gain and fades; omitted entries use built-in English text. */
  labels?: Partial<Record<keyof ClipEnvelope, string>>;
}>;

/** Editable clip envelope values over caller-owned settings. */
export function mountClipEnvelopeEditor(root: HTMLElement, options: ClipEnvelopeEditorOptions) {
  const doc = root.ownerDocument;
  const labels = { gain: "Clip gain", fadeIn: "Fade in (s)", fadeOut: "Fade out (s)", ...options.labels };
  const element = doc.createElement("div");
  element.className = "ar-clip-envelope";
  const abort = new AbortController();
  const fields = (["gain", "fadeIn", "fadeOut"] as const).map((key) => {
    const label = doc.createElement("label");
    label.textContent = labels[key];
    const input = doc.createElement("input");
    input.type = "number";
    input.min = "0";
    input.step = key === "gain" ? "0.01" : "0.001";
    input.addEventListener(
      "change",
      () => {
        try {
          const current = options.envelope.value;
          const maximum = input.max === "" ? Infinity : Number(input.max);
          if (Number.isFinite(input.valueAsNumber)) {
            const value = Math.max(0, Math.min(maximum, input.valueAsNumber));
            options.onChange({ ...current, [key]: value });
          }
        } finally {
          input.value = String(options.envelope.value[key]);
        }
      },
      { signal: abort.signal },
    );
    label.append(input);
    element.append(label);
    return [key, input] as const;
  });
  const stop = untracked(() =>
    effect(() => {
      const envelope = options.envelope.value;
      const duration = options.duration();
      for (const [key, input] of fields) {
        input.value = String(envelope[key]);
        if (key !== "gain") input.max = String(Math.max(0, duration - envelope[key === "fadeIn" ? "fadeOut" : "fadeIn"]));
      }
    }),
  );
  let disposed = false;
  root.append(element);
  return {
    element,
    dispose() {
      if (disposed) return;
      disposed = true;
      abort.abort();
      stop();
      element.remove();
    },
  };
}
