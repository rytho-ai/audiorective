/** Default waveform controls bound to a headless WavePlayer. */
import { effect, untracked } from "@audiorective/core";
import type {
  MountWaveformSelector,
  SelectorVersion,
  WaveformSelectorOptions,
  WaveformSelectorHandle,
  WaveformSelectorState,
  WaveformHandle,
  Selection,
} from "./types";
import { mountWaveform } from "./waveform";
import { createSelectionPlugin, type SnapMode } from "./selection";
import { styles } from "./style";
const format = (time: number) => `${Math.floor(time / 60)}:${(time % 60).toFixed(2).padStart(5, "0")}`;
export const mountWaveformSelector: MountWaveformSelector = (root, options) => {
  const container = root.ownerDocument.createElement("section");
  container.className = "ar-widget ar-selector";
  container.setAttribute("aria-label", "Waveform selector");
  container.innerHTML = `<style>${styles}</style>
    <div class="ar-source"><input data-testid="source-url" type="url" aria-label="Audio URL" placeholder="Audio URL"><button data-testid="load-url" type="button">Load URL</button><label>Audio file <input data-testid="source-file" type="file" accept="audio/*"></label></div>
    <div class="ar-status" aria-live="polite"><span data-testid="loading" hidden>Loading audio…</span><progress data-testid="load-progress" aria-label="Audio loading progress" hidden></progress><button data-testid="cancel-load" type="button" hidden>Cancel loading</button><span data-testid="processing" hidden>Processing audio…</span><span data-testid="error" class="ar-error" role="alert" hidden></span></div>
    <div class="ar-toolbar"><button data-testid="play-pause" type="button">Play</button><button data-testid="stop" type="button">Stop</button><button data-testid="loop" type="button" aria-pressed="false">Loop</button><button data-testid="clear" type="button">Clear selection</button>${options.grid ? '<label class="ar-snap">Snap <select data-testid="snap" aria-label="Snap"><option value="off">Off</option><option value="beat">Beat</option><option value="downbeat">Downbeat</option></select></label>' : ""}</div>
    <div class="ar-wave-mount"></div>
    <div class="ar-footer"><output data-testid="selection-readout">No selection</output><output class="ar-position">0:00.00 / 0:00.00</output></div>
    <p class="ar-help">Click to play · Drag either direction to loop · Grips: ← / →, Shift for 0.1s${options.grid ? " · Alt bypasses snap" : ""}</p>`;
  root.append(container);
  if (options.controls === false) {
    container.querySelectorAll<HTMLElement>(":scope > .ar-source, :scope > .ar-toolbar").forEach((controls) => (controls.hidden = true));
  }
  if (options.audition === false) {
    container.querySelector<HTMLElement>(".ar-help")!.textContent =
      `Click to seek · Drag either direction to select · Grips: ← / →, Shift for 0.1s${options.grid ? " · Alt bypasses snap" : ""}`;
  }
  const query = <T extends HTMLElement = HTMLElement>(id: string) => container.querySelector<T>(`[data-testid="${id}"]`)!;
  const url = query<HTMLInputElement>("source-url"),
    file = query<HTMLInputElement>("source-file");
  const ownsPlayer = !options.player;
  let player: NonNullable<WaveformSelectorOptions["player"]>;
  let waveform: WaveformHandle;
  try {
    waveform = mountWaveform(container.querySelector<HTMLElement>(".ar-wave-mount")!, { renderer: options.renderer });
    try {
      player = options.player ?? options.createPlayer!();
    } catch (error) {
      waveform.dispose();
      throw error;
    }
  } catch (error) {
    container.remove();
    throw error;
  }
  let disposed = false,
    playbackError: string | null = null,
    animation = 0;
  let displayed: SelectorVersion | null | undefined;
  let previous: Readonly<Selection> | null = untracked(() => player.cells.selection.value);
  const disposers: Array<() => void> = [];
  const selection = createSelectionPlugin({
    model: player,
    grid: options.grid,
    onCommit(event) {
      if (event.kind === "pointer" && event.selection && options.audition !== false) run(() => player.audition());
      if (event.kind === "click" && event.time !== undefined) {
        player.seek(event.time);
        if (options.audition !== false) run(() => player.play());
      }
      render();
    },
  });
  try {
    waveform.attach(selection);
  } catch (error) {
    waveform.dispose();
    if (ownsPlayer) player.dispose();
    container.remove();
    throw error;
  }
  function on(target: EventTarget, type: string, listener: EventListener): void {
    target.addEventListener(type, listener);
    disposers.push(() => target.removeEventListener(type, listener));
  }
  function run(action: () => Promise<unknown>): void {
    void action().catch((reason) => {
      if (disposed) return;
      playbackError = reason instanceof Error ? reason.message : String(reason);
      render();
    });
  }
  /** One coherent read of the player's cells; the cells are read untracked so a caller's effect around the selector never follows them. */
  function snapshot(): Omit<WaveformSelectorState, "pixelsPerSecond"> {
    return untracked(() => {
      const { cells } = player;
      const version = cells.version.value;
      return {
        duration: player.duration,
        selection: cells.selection.value ? { ...cells.selection.value } : null,
        position: player.position,
        isPlaying: cells.isPlaying.value,
        isLooping: cells.isLooping.value,
        loading: cells.loading.value,
        loadProgress: cells.loadProgress.value,
        error: cells.error.value,
        processing: cells.processing.value,
        stretchRatio: version?.ratio ?? 1,
        sourceDuration: player.sourceBuffer?.duration ?? 0,
        revision: version?.revision ?? 0,
      };
    });
  }
  function render(): void {
    if (disposed) return;
    const state = snapshot(),
      range = state.selection;
    query("selection-readout").textContent = range
      ? `${format(range.start)} – ${format(range.end)} (${(range.end - range.start).toFixed(2)}s)`
      : "No selection";
    waveform.setPlayhead(state.position);
    container.querySelector<HTMLOutputElement>(".ar-position")!.textContent = `${format(state.position)} / ${format(state.duration)}`;
    query("play-pause").textContent = state.isPlaying ? "Pause" : "Play";
    query("loop").setAttribute("aria-pressed", String(state.isLooping));
    query("loading").hidden = !state.loading;
    const progress = state.loadProgress;
    let loadingText = "Loading audio…";
    if (progress?.phase === "download" || progress?.phase === "read") {
      const bytes = (value: number) => `${(value / 1048576).toFixed(2)} MiB`;
      loadingText = `${progress.phase === "download" ? "Downloading" : "Reading"} audio… ${bytes(progress.loadedBytes)}${progress.totalBytes === null ? "" : ` / ${bytes(progress.totalBytes)}`}`;
    } else if (progress?.phase === "decode") loadingText = "Decoding audio…";
    else if (progress?.phase === "peaks") loadingText = "Summarizing audio…";
    query("loading").textContent = loadingText;
    const meter = query<HTMLProgressElement>("load-progress");
    meter.hidden = !state.loading;
    if ((progress?.phase === "download" || progress?.phase === "read") && progress.totalBytes !== null && progress.totalBytes > 0) {
      meter.max = progress.totalBytes;
      meter.value = progress.loadedBytes;
    } else meter.removeAttribute("value");
    query("cancel-load").hidden = !state.loading;
    query("processing").hidden = !state.processing;
    const error = playbackError ?? state.error;
    query("error").hidden = !error;
    query("error").textContent = error ?? "";
    container.setAttribute("aria-busy", String(state.loading || state.processing));
    for (const id of ["play-pause", "stop", "loop"]) (query(id) as HTMLButtonElement).disabled = !state.duration || state.loading;
    (query("clear") as HTMLButtonElement).disabled = !range && !state.isLooping;
  }
  function sync(): void {
    if (disposed) return;
    const current = snapshot();
    if (current.loading || current.processing) playbackError = null;
    const version = untracked(() => player.cells.version.value);
    if (displayed !== version) {
      const before = waveform.getViewport();
      const sameSource = displayed && version && displayed.sourceRevision === version.sourceRevision;
      displayed = version;
      if (options.grid)
        selection.setGrid({
          beats: options.grid.beats.map((time) => player.sourceToOutput(time)),
          downbeats: options.grid.downbeats.map((time) => player.sourceToOutput(time)),
        });
      waveform.setData(version?.peaks ?? null);
      if (sameSource && before.duration && before.width && before.pixelsPerSecond) {
        waveform.setZoom(Math.max(1, (before.duration * before.pixelsPerSecond) / before.width));
        waveform.scrollTo(((before.scrollLeft / before.pixelsPerSecond) * version!.buffer.duration) / before.duration);
      }
    }
    const next = current.selection;
    const changed = previous?.start !== next?.start || previous?.end !== next?.end;
    previous = next;
    render();
    if (changed) options.onSelectionChange?.(next ? { ...next } : null);
  }
  let following = false;
  disposers.push(
    untracked(() =>
      effect(() => {
        const { cells } = player;
        for (const source of [
          cells.selection,
          cells.isLooping,
          cells.isPlaying,
          cells.loading,
          cells.loadProgress,
          cells.error,
          cells.processing,
          cells.version,
          cells.playhead,
        ])
          void source.value;
        if (!following) return void (following = true);
        untracked(sync);
      }),
    ),
  );
  async function loadSource(source: string | File): Promise<void> {
    if (disposed) throw new Error("Waveform selector is disposed.");
    playbackError = null;
    if (typeof source === "string") url.value = source;
    await player.load(source);
  }
  on(query("load-url"), "click", () => run(() => loadSource(url.value)));
  on(query("cancel-load"), "click", () => player.cancelLoad());
  on(url, "keydown", (event) => {
    if ((event as KeyboardEvent).key === "Enter") run(() => loadSource(url.value));
  });
  on(file, "change", () => {
    const selected = file.files?.[0];
    if (selected) run(() => loadSource(selected));
    file.value = "";
  });
  on(query("play-pause"), "click", () => {
    if (untracked(() => player.cells.isPlaying.value)) player.pause();
    else run(() => player.play());
    render();
  });
  on(query("stop"), "click", () => player.stop());
  on(query("loop"), "click", () => player.setLooping(!untracked(() => player.cells.isLooping.value)));
  on(query("clear"), "click", () => {
    player.setSelection(null);
    player.setLooping(false);
  });
  if (options.grid) on(query("snap"), "change", () => selection.setSnap(query<HTMLSelectElement>("snap").value as SnapMode));
  function frame(): void {
    if (disposed) return;
    render();
    animation = requestAnimationFrame(frame);
  }
  sync();
  animation = requestAnimationFrame(frame);
  const ready = options.source === undefined ? Promise.resolve() : loadSource(options.source);
  void ready.catch(() => {});
  const handle: WaveformSelectorHandle = {
    ready,
    output: player.output,
    getViewport: () => waveform.getViewport(),
    setZoom(factor) {
      if (disposed) throw new Error("Waveform selector is disposed.");
      waveform.setZoom(factor);
    },
    setAmplitudeZoom(factor) {
      if (disposed) throw new Error("Waveform selector is disposed.");
      waveform.setAmplitudeZoom(factor);
    },
    getAmplitudeZoom: () => waveform.getAmplitudeZoom(),
    scrollTo(seconds) {
      if (disposed) throw new Error("Waveform selector is disposed.");
      waveform.scrollTo(seconds);
    },
    load: (source) => loadSource(source),
    cancelLoad() {
      if (disposed) throw new Error("Waveform selector is disposed.");
      player.cancelLoad();
    },
    setSelection(range) {
      if (disposed) throw new Error("Waveform selector is disposed.");
      selection.setSelection(range);
    },
    getState: () => {
      const state = snapshot();
      return { ...state, error: playbackError ?? state.error, pixelsPerSecond: waveform.getViewport().pixelsPerSecond };
    },
    attach: (plugin) => waveform.attach(plugin),
    dispose() {
      if (disposed) return;
      disposed = true;
      cancelAnimationFrame(animation);
      for (const dispose of disposers.splice(0)) dispose();
      waveform.dispose();
      if (ownsPlayer) player.dispose();
      container.remove();
    },
  };
  return handle;
};
