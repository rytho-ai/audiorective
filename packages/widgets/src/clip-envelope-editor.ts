import { effect, untracked, type Readable } from "@audiorective/core";

/** Linear gain and edge fades in clip-local seconds; structurally matches the Project clip envelope. */
export type ClipEnvelope = Readonly<{ gain: number; fadeIn: number; fadeOut: number }>;

export type ClipEnvelopeEditorOptions = Readonly<{
  /** Tracked clip-local seconds; updates mounted fade limits in place. */
  duration: () => number;
  envelope: Readable<ClipEnvelope>;
  onChange(envelope: ClipEnvelope): void;
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
