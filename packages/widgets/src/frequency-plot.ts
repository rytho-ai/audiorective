import { effect } from "@audiorective/core";

const ns = "http://www.w3.org/2000/svg";
const resolution = 192;
const width = 320;
const height = 100;

export type FrequencyRange = { minHz?: number; maxHz?: number; minDb?: number; maxDb?: number };

const unit = (value: number) => Math.max(0, Math.min(1, value));

function mountPlot(root: HTMLElement, label: string, range: Required<FrequencyRange>) {
  const { minHz, maxHz, minDb, maxDb } = range;
  if (
    !Number.isFinite(minHz) ||
    !Number.isFinite(maxHz) ||
    minHz <= 0 ||
    maxHz <= minHz ||
    !Number.isFinite(minDb) ||
    !Number.isFinite(maxDb) ||
    maxDb <= minDb
  )
    throw new RangeError("Frequency plot needs increasing frequency and decibel ranges.");

  const doc = root.ownerDocument;
  const element = doc.createElement("div");
  element.className = "ar-frequency-plot";
  const surface = doc.createElement("div");
  surface.style.position = "relative";
  element.setAttribute("aria-label", label);
  const svg = doc.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("preserveAspectRatio", "none");
  svg.setAttribute("aria-hidden", "true");
  Object.assign(svg.style, { width: "100%", height: "auto", aspectRatio: "3.2", display: "block" });

  const xFor = (hz: number) => unit(Math.log(hz / minHz) / Math.log(maxHz / minHz));
  const hzFor = (x: number) => minHz * (maxHz / minHz) ** unit(x);
  const yFor = (db: number) => 1 - unit((db - minDb) / (maxDb - minDb));
  const dbFor = (y: number) => maxDb - unit(y) * (maxDb - minDb);
  const grid = doc.createElementNS(ns, "path");
  grid.setAttribute("fill", "none");
  grid.setAttribute("stroke", "currentColor");
  grid.setAttribute("opacity", "0.18");
  let guides = "";
  for (const hz of [50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000]) {
    if (hz <= minHz || hz >= maxHz) continue;
    guides += `M${xFor(hz) * width} 0v${height}`;
  }
  for (let row = 1; row < 4; row++) guides += `M0 ${(row * height) / 4}h${width}`;
  grid.setAttribute("d", guides);
  const curve = doc.createElementNS(ns, "path");
  curve.classList.add("ar-frequency-curve");
  curve.setAttribute("fill", "none");
  curve.setAttribute("stroke", "currentColor");
  curve.setAttribute("vector-effect", "non-scaling-stroke");
  svg.append(grid, curve);
  surface.append(svg);
  const axis = doc.createElement("div");
  axis.className = "ar-frequency-axis";
  axis.setAttribute("aria-hidden", "true");
  Object.assign(axis.style, { position: "relative", height: "1.25em", fontSize: "0.75em" });
  for (const hz of [minHz, ...[100, 1000, 10_000].filter((tick) => xFor(tick) >= 0.13 && xFor(tick) <= 0.87), maxHz]) {
    const tick = doc.createElement("span");
    tick.textContent = hz >= 1000 ? `${Number((hz / 1000).toFixed(1))}k` : String(Math.round(hz));
    Object.assign(tick.style, {
      position: "absolute",
      left: `${xFor(hz) * 100}%`,
      transform: hz === minHz ? "" : hz === maxHz ? "translateX(-100%)" : "translateX(-50%)",
    });
    axis.append(tick);
  }
  element.append(surface, axis);
  root.append(element);

  const frequencies = Float32Array.from({ length: resolution }, (_, index) => hzFor(index / (resolution - 1)));
  function render(values: Float32Array): void {
    let path = "";
    let start = true;
    for (const [index, value] of values.entries()) {
      if (!Number.isFinite(value)) {
        start = true;
        continue;
      }
      path += `${start ? "M" : "L"}${((index * width) / (resolution - 1)).toFixed(1)} ${(yFor(value) * height).toFixed(1)}`;
      start = false;
    }
    curve.setAttribute("d", path);
  }
  return { element, surface, svg, frequencies, render, xFor, hzFor, yFor, dbFor };
}

export type SpectrumOptions = FrequencyRange & {
  label?: string;
  sampleRate: number;
  fftSize: number;
  read(bins: Float32Array<ArrayBuffer>): void;
};

/** Display borrowed FFT magnitudes in dB on a log frequency axis. */
export function mountSpectrum(root: HTMLElement, options: SpectrumOptions) {
  const { sampleRate, fftSize, read } = options;
  const maxHz = options.maxHz ?? Math.min(20_000, sampleRate / 2);
  if (
    !Number.isFinite(sampleRate) ||
    maxHz > sampleRate / 2 ||
    !Number.isInteger(fftSize) ||
    fftSize < 32 ||
    fftSize > 32768 ||
    (fftSize & (fftSize - 1)) !== 0
  )
    throw new RangeError("Spectrum needs a valid FFT size and a range within Nyquist.");

  const minDb = options.minDb ?? -100;
  const plot = mountPlot(root, options.label ?? "Frequency spectrum", {
    minHz: options.minHz ?? 20,
    maxHz,
    minDb,
    maxDb: options.maxDb ?? 0,
  });
  plot.element.classList.add("ar-spectrum");
  plot.element.setAttribute("role", "img");
  const output = new Float32Array(resolution);
  const bins = new Float32Array(fftSize / 2);
  const hzPerBin = sampleRate / fftSize;
  const edges = [...plot.frequencies].map((frequency, index) => {
    const previous = plot.frequencies[index - 1] ?? frequency;
    const next = plot.frequencies[index + 1] ?? frequency;
    const from = Math.min(bins.length - 1, Math.max(1, Math.ceil((previous + frequency) / (2 * hzPerBin))));
    const through = Math.min(bins.length - 1, Math.max(from, Math.ceil((frequency + next) / (2 * hzPerBin)) - 1));
    return [from, through] as const;
  });
  const win = root.ownerDocument.defaultView!;
  function draw() {
    read(bins);
    for (const [index, [from, through]] of edges.entries()) {
      let peak = minDb;
      for (let bin = from; bin <= through; bin++) if (Number.isFinite(bins[bin])) peak = Math.max(peak, bins[bin]);
      output[index] = peak;
    }
    plot.render(output);
  }
  let frame = 0;
  function tick(): void {
    draw();
    frame = win.requestAnimationFrame(tick);
  }
  try {
    tick();
  } catch (error) {
    plot.element.remove();
    throw error;
  }
  return {
    element: plot.element,
    dispose() {
      win.cancelAnimationFrame(frame);
      plot.element.remove();
    },
  };
}

type NumericControl = { value: number };
export type EqBand = Readonly<{ id: string; label: string; frequency: NumericControl; gain?: NumericControl; q?: NumericControl }>;
export type EqEditorOptions = FrequencyRange & {
  label?: string;
  /** Borrowed live controls; external parameter or preset writes update the mounted controls and response in place. */
  bands: readonly EqBand[];
  minQ?: number;
  maxQ?: number;
  /** Fill linear magnitudes from the caller's effect or composed response. False means unavailable. */
  readResponse(frequencies: Float32Array<ArrayBuffer>, magnitudes: Float32Array<ArrayBuffer>): boolean | void;
};

/** Edits borrowed band parameters and plots the effect's measured or calculated response. */
export function mountEqEditor(root: HTMLElement, options: EqEditorOptions) {
  const { bands, readResponse, minQ = 0.1, maxQ = 20 } = options;
  if (new Set(bands.map(({ id }) => id)).size !== bands.length || !Number.isFinite(minQ) || !Number.isFinite(maxQ) || minQ <= 0 || maxQ <= minQ) {
    throw new RangeError("EQ editor needs unique band IDs and increasing positive Q limits.");
  }
  const plot = mountPlot(root, options.label ?? "Frequency response", {
    minHz: options.minHz ?? 20,
    maxHz: options.maxHz ?? 20_000,
    minDb: options.minDb ?? -24,
    maxDb: options.maxDb ?? 24,
  });
  plot.element.classList.add("ar-eq-editor");
  plot.element.setAttribute("role", "group");
  const magnitudes = new Float32Array(resolution);
  const response = new Float32Array(resolution);
  const doc = root.ownerDocument;
  const controls = bands.map((band) => {
    const button = doc.createElement("button");
    button.type = "button";
    button.className = "ar-eq-band";
    button.textContent = band.label;
    Object.assign(button.style, { position: "absolute", transform: "translate(-50%, -50%)", touchAction: "none" });
    let pointer: number | undefined;
    button.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || pointer !== undefined) return;
      pointer = event.pointerId;
      button.setPointerCapture(pointer);
      button.focus();
    });
    button.addEventListener("pointermove", (event) => {
      if (pointer !== event.pointerId) return;
      const rect = plot.svg.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      band.frequency.value = Math.round(plot.hzFor((event.clientX - rect.left) / rect.width));
      if (band.gain) band.gain.value = Math.round(plot.dbFor((event.clientY - rect.top) / rect.height) * 10) / 10;
    });
    button.addEventListener("lostpointercapture", () => {
      pointer = undefined;
    });
    function adjustQ(factor: number): void {
      if (band.q) band.q.value = Math.max(minQ, Math.min(maxQ, band.q.value * factor));
    }
    button.addEventListener("keydown", (event) => {
      const x = plot.xFor(band.frequency.value);
      switch (event.key) {
        case "ArrowLeft":
        case "ArrowRight":
          band.frequency.value = Math.round(plot.hzFor(x + (event.key === "ArrowRight" ? 0.01 : -0.01)));
          break;
        case "Home":
        case "End":
          band.frequency.value = Math.round(plot.hzFor(event.key === "End" ? 1 : 0));
          break;
        case "ArrowUp":
        case "ArrowDown":
          if (!band.gain) return;
          band.gain.value = plot.dbFor(plot.yFor(band.gain.value + (event.key === "ArrowUp" ? 1 : -1)));
          break;
        case "PageUp":
        case "PageDown":
          if (!band.q) return;
          adjustQ(2 ** (event.key === "PageUp" ? 1 / 12 : -1 / 12));
          break;
        default:
          return;
      }
      event.preventDefault();
    });
    if (band.q)
      button.addEventListener(
        "wheel",
        (event) => {
          if (!event.deltaY) return;
          event.preventDefault();
          adjustQ(2 ** (-Math.sign(event.deltaY) / 12));
        },
        { passive: false },
      );
    plot.surface.append(button);
    return button;
  });

  function refresh(): void {
    magnitudes.fill(NaN);
    const available = readResponse(plot.frequencies, magnitudes) !== false;
    for (let index = 0; index < response.length; index++) {
      response[index] = available && Number.isFinite(magnitudes[index]) ? 20 * Math.log10(Math.max(1e-12, magnitudes[index])) : NaN;
    }
    plot.render(response);
    for (const [index, band] of bands.entries()) {
      const button = controls[index];
      const frequency = band.frequency.value;
      const x = plot.xFor(frequency);
      const gain = band.gain?.value ?? response[Math.round(x * (resolution - 1))];
      const q = band.q?.value;
      Object.assign(button.style, { left: `${x * 100}%`, top: `${plot.yFor(Number.isFinite(gain) ? gain : 0) * 100}%` });
      button.setAttribute("aria-label", band.label);
      button.title = [`${Math.round(frequency)} Hz`, band.gain ? `${gain.toFixed(1)} dB` : "", q === undefined ? "" : `Q ${q.toFixed(2)}`]
        .filter(Boolean)
        .join(" · ");
    }
  }

  let first = true;
  let failure: { error: unknown } | undefined;
  const unsubscribe = effect(() => {
    try {
      refresh();
    } catch (error) {
      if (!first) throw error;
      failure = { error };
    }
  });
  first = false;
  if (failure) {
    unsubscribe();
    plot.element.remove();
    throw failure.error;
  }

  return {
    element: plot.element,
    dispose() {
      unsubscribe();
      plot.element.remove();
    },
  };
}
