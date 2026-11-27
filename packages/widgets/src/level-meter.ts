import { untracked } from "@audiorective/core";

/** Borrowed mono PCM. The view measures genuine sample peak and RMS. */
export type LevelMeterPCMSource = Readonly<{
  /** Fills the supplied mono buffer with linear PCM samples; called once per animation frame. */
  read(samples: Float32Array<ArrayBuffer>): void;
  /** Buffer length, default 2048. */
  sampleCount?: number;
}>;

/** Peak in dBFS, read once per animation frame; no tracked state is required. NaN/-Infinity mean silence; +Infinity is full scale with overload. Or genuine linear PCM. */
export type LevelMeterSource = (() => number) | LevelMeterPCMSource;
/** Linear amplitudes; RMS is unknown for a peak-only dBFS source. */
export type LevelSnapshot = Readonly<{
  /** Nonnegative linear sample peak; 1 is full scale and values above 1 indicate overload. */
  peak: number;
  /** Nonnegative linear root-mean-square amplitude; null for a peak-only source. */
  rms: number | null;
}>;
export type LevelMeterOptions = {
  /** Borrowed dBFS peak reader or mono PCM reader; disposal does not release the source. */
  source: LevelMeterSource;
  /** Accessible meter caption; defaults to "Sample peak". */
  label?: string;
};

export interface LevelMeterHandle {
  /** Mounted meter root; removed when this view is disposed. */
  readonly element: HTMLDivElement;
  /** Returns the most recent linear peak and RMS snapshot; RMS may be null. */
  getLevel(): LevelSnapshot;
  /** Releases resources owned by this attachment or view; safe to call twice. */
  dispose(): void;
}

/** Display borrowed peak data. Disposal releases only this view's animation-frame sampling loop. */
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
  const db = (amplitude: number) => (amplitude > 0 ? (20 * Math.log10(amplitude)).toFixed(1) : "−∞");
  function publish(peak: number, rms: number | null) {
    peak = Number.isFinite(peak) ? Math.max(0, peak) : peak === Infinity ? 1 : 0;
    if (level?.peak === peak && level.rms === rms) return;
    level = Object.freeze({ peak, rms });
    meter.value = Math.min(1, peak);
    text.textContent = rms === null ? `Peak ${db(peak)} dBFS` : `Peak ${db(peak)} · RMS ${db(rms)} dBFS`;
    element.dataset.overload = String(peak >= 1);
  }
  const samples = new Float32Array(count);
  const update = () => {
    if (typeof source === "function") {
      publish(10 ** (source() / 20), null);
      return;
    }
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
    if (!disposed) frame = requestAnimationFrame(tick);
  };
  // A borrowed source must not become a dependency of the caller's mount effect.
  untracked(update);
  frame = requestAnimationFrame(tick);
  root.append(element);
  return {
    element,
    getLevel: () => level!,
    dispose() {
      if (disposed) return;
      disposed = true;
      cancelAnimationFrame(frame);
      element.remove();
    },
  };
}
