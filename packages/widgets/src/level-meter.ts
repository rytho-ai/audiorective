import { effect, untracked } from "@audiorective/core";

/** Borrowed mono PCM. The view measures genuine sample peak and RMS. */
export type LevelMeterPCMSource = Readonly<{
  read(samples: Float32Array<ArrayBuffer>): void;
  /** Buffer length, default 2048. */
  sampleCount?: number;
}>;

/** Tracked peak in dBFS (-Infinity is silence), or genuine linear PCM. */
export type LevelMeterSource = (() => number) | LevelMeterPCMSource;
/** Linear amplitudes; RMS is unknown for a peak-only dBFS source. */
export type LevelSnapshot = Readonly<{ peak: number; rms: number | null }>;
export type LevelMeterOptions = {
  source: LevelMeterSource;
  label?: string;
};

export interface LevelMeterHandle {
  readonly element: HTMLDivElement;
  getLevel(): LevelSnapshot;
  dispose(): void;
}

/** Display borrowed peak data. Disposal releases only this view's observer or PCM sampling loop. */
export function mountLevelMeter(root: HTMLElement, options: LevelMeterOptions): LevelMeterHandle {
  const source = options.source;
  const count = typeof source === "function" ? 0 : (source.sampleCount ?? 2048);
  if (typeof source !== "function" && (!Number.isInteger(count) || count <= 0))
    throw new RangeError("Level meter sample count must be a positive integer.");
  const doc = root.ownerDocument;
  const element = doc.createElement("div");
  element.className = "ar-level-meter";
  const meter = doc.createElement("meter");
  meter.max = 1;
  meter.setAttribute("aria-label", options.label ?? "Sample peak");
  const text = doc.createElement("span");
  element.append(meter, text);
  let level: LevelSnapshot | undefined;
  let frame = 0;
  let disposed = false;
  let stop = () => {};
  const db = (amplitude: number) => (amplitude > 0 ? (20 * Math.log10(amplitude)).toFixed(1) : "−∞");
  function publish(peak: number, rms: number | null) {
    if (level?.peak === peak && level.rms === rms) return;
    level = Object.freeze({ peak, rms });
    meter.value = Math.min(1, peak);
    text.textContent = rms === null ? `Peak ${db(peak)} dBFS` : `Peak ${db(peak)} · RMS ${db(rms)} dBFS`;
    element.dataset.overload = String(peak >= 1);
  }
  if (typeof source === "function") {
    // The view owns its observer even when mounted inside a caller's reactive effect.
    stop = untracked(() => effect(() => publish(10 ** (source() / 20), null)));
  } else {
    const samples = new Float32Array(count);
    const update = () => {
      source.read(samples);
      let peak = 0,
        squares = 0;
      for (const sample of samples) {
        if (!Number.isFinite(sample)) continue;
        peak = Math.max(peak, Math.abs(sample));
        squares += sample * sample;
      }
      publish(peak, Math.sqrt(squares / count));
    };
    const tick = () => {
      if (disposed) return;
      update();
      frame = requestAnimationFrame(tick);
    };
    update();
    frame = requestAnimationFrame(tick);
  }
  root.append(element);
  return {
    element,
    getLevel: () => level!,
    dispose() {
      if (disposed) return;
      disposed = true;
      stop();
      cancelAnimationFrame(frame);
      element.remove();
    },
  };
}
