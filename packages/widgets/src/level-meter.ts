export type LevelSnapshot = Readonly<{ peak: number; rms: number }>;
export type LevelMeterOptions = {
  read(samples: Float32Array<ArrayBuffer>): void;
  sampleCount?: number;
  label?: string;
};

/** Display mono sample peak and RMS from a borrowed float reader. */
export function mountLevelMeter(root: HTMLElement, options: LevelMeterOptions) {
  const count = options.sampleCount ?? 2048;
  if (!Number.isInteger(count) || count <= 0) throw new RangeError("Level meter sample count must be a positive integer.");
  const samples = new Float32Array(count);
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
  function update() {
    options.read(samples);
    let peak = 0,
      squares = 0;
    for (const sample of samples) {
      if (!Number.isFinite(sample)) continue;
      peak = Math.max(peak, Math.abs(sample));
      squares += sample * sample;
    }
    const rms = Math.sqrt(squares / count);
    if (level?.peak === peak && level.rms === rms) return;
    level = Object.freeze({ peak, rms });
    meter.value = Math.min(1, peak);
    text.textContent = `Peak ${db(peak)} · RMS ${db(level.rms)} dBFS`;
    element.dataset.overload = String(peak >= 1);
  }
  function tick() {
    if (disposed) return;
    update();
    frame = requestAnimationFrame(tick);
  }
  update();
  root.append(element);
  frame = requestAnimationFrame(tick);
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
