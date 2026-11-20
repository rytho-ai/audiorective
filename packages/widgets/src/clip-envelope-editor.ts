import { effect, type Readable } from "@audiorective/core";

/** Linear gain and edge fades in clip-local seconds; structurally matches the Project clip envelope. */
type ClipEnvelope = Readonly<{ gain: number; fadeIn: number; fadeOut: number }>;

export type ClipEnvelopeEditorOptions = Readonly<{
  duration: number;
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
  const fields = (["gain", "fadeIn", "fadeOut"] as const).map((key) => {
    const label = doc.createElement("label");
    label.textContent = labels[key];
    const input = doc.createElement("input");
    input.type = "number";
    input.min = "0";
    input.step = key === "gain" ? "0.01" : "0.001";
    input.addEventListener("change", () => {
      const current = options.envelope.value;
      const maximum = input.max === "" ? Infinity : Number(input.max);
      if (Number.isFinite(input.valueAsNumber)) {
        const value = Math.max(0, Math.min(maximum, input.valueAsNumber));
        options.onChange({ ...current, [key]: value });
      }
      input.value = String(options.envelope.value[key]);
    });
    label.append(input);
    element.append(label);
    return [key, input] as const;
  });
  const stop = effect(() => {
    const envelope = options.envelope.value;
    for (const [key, input] of fields) {
      input.value = String(envelope[key]);
      if (key !== "gain") input.max = String(Math.max(0, options.duration - envelope[key === "fadeIn" ? "fadeOut" : "fadeIn"]));
    }
  });
  root.append(element);
  return {
    element,
    dispose() {
      stop();
      element.remove();
    },
  };
}
