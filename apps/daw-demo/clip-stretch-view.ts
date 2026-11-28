import { cell, effect, readonlyCell, untracked, type Cell } from "@audiorective/core";
import type { TimeStretch } from "@audiorective/effects/time-stretch";
import { audioClipTimeMap, type AudioClip, type PreparedClipStretch, type ClipStretchAnchor, type Workspace } from "@audiorective/daw";
import { createWarpMarkers } from "@audiorective/widgets";
import type { WaveformHandle } from "@audiorective/widgets/waveform";

export type AudioClipEditorTool = "gain" | "warp" | null;

export function createClipStretchEngine() {
  const source = cell<{ name: string; processor: TimeStretch } | undefined>(undefined);
  let next = 0;
  return {
    active: readonlyCell(source),
    async load(file: File) {
      const generation = ++next;
      const { TimeStretch } = await import("@audiorective/effects/time-stretch");
      const url = URL.createObjectURL(file);
      let processor: TimeStretch;
      try {
        processor = await TimeStretch.load({ wasmUrl: url });
      } finally {
        URL.revokeObjectURL(url);
      }
      if (generation !== next) return processor.dispose();
      const previous = source.value;
      source.value = { name: file.name, processor };
      previous?.processor.dispose();
    },
    dispose() {
      next++;
      source.value?.processor.dispose();
      source.value = undefined;
    },
  };
}

type ClipStretchViewOptions = {
  clip: AudioClip;
  workspace: Workspace;
  engine: ReturnType<typeof createClipStretchEngine>;
  waveform: WaveformHandle;
  tool: Cell<AudioClipEditorTool>;
  commit(render: PreparedClipStretch): void;
  report(error: unknown): void;
};

export function mountClipStretchView(root: HTMLElement, { clip, workspace, engine, waveform, tool, commit, report }: ClipStretchViewOptions) {
  const doc = root.ownerDocument;
  const row = doc.createElement("div");
  row.className = "clip-stretch";
  const engineFile = doc.createElement("input");
  engineFile.type = "file";
  engineFile.accept = ".wasm,application/wasm";
  engineFile.hidden = true;
  const button = doc.createElement("button");
  button.type = "button";
  button.textContent = "載入伸縮引擎";
  button.title = "選擇與 Rubber Band 3.3 ABI 相容的 .wasm 檔";
  button.addEventListener("click", () => engineFile.click());
  engineFile.addEventListener("change", () => {
    const file = engineFile.files?.[0];
    engineFile.value = "";
    if (file) void engine.load(file).catch(report);
  });
  const label = doc.createElement("label");
  label.textContent = "長度倍率";
  const ratio = doc.createElement("input");
  ratio.type = "number";
  ratio.step = "0.01";
  ratio.min = "0.01";
  ratio.value = String(clip.stretch?.ratio ?? 1);
  label.append(ratio);
  const apply = doc.createElement("button");
  apply.type = "button";
  apply.textContent = "套用倍率";
  const restore = doc.createElement("button");
  restore.type = "button";
  restore.textContent = "還原原始長度";
  restore.hidden = !clip.stretch;
  const cancel = doc.createElement("button");
  cancel.type = "button";
  cancel.textContent = "取消";
  cancel.hidden = true;
  let job: AbortController | undefined;
  let disposed = false;
  const busy = cell(false);
  const map = audioClipTimeMap(clip);
  const anchors = clip.stretch?.anchors ?? [];
  const warp = doc.createElement("button");
  warp.type = "button";
  warp.textContent = "Warp 標記";
  warp.title = "雙擊波形新增標記 · 拖曳調整時間 · Delete 刪除";
  warp.addEventListener("click", () => {
    tool.value = tool.value === "warp" ? null : "warp";
  });
  let attachment: ReturnType<WaveformHandle["attach"]> | undefined;
  const stopWarp = effect(() => {
    const visible = tool.value === "warp";
    untracked(() => {
      warp.setAttribute("aria-pressed", String(visible));
      if (visible && !attachment && clip.duration > 0) {
        attachment = waveform.attach(
          createWarpMarkers({
            sampleRate: clip.sampleRate,
            sourceFrames: Math.round(map.sourceDuration * clip.sampleRate),
            anchors: readonlyCell(() => anchors),
            sourceFrameAt: (time) => map.outputToSource(time) * clip.sampleRate,
            disabled: readonlyCell(() => busy.value || !engine.active.value),
            label: "Warp 標記",
            onCommit: (points) => void render(clip.duration / map.sourceDuration, points),
          }),
        );
      } else if (!visible && attachment) {
        attachment.dispose();
        attachment = undefined;
      }
    });
  });

  function update(): void {
    const current = engine.active.value;
    button.textContent = current ? "更換伸縮引擎" : "載入伸縮引擎";
    if (current) button.title = current.name;
    const value = ratio.valueAsNumber;
    apply.disabled = !!job || !Number.isFinite(value) || value <= 0 || (value !== 1 && !current) || value === (clip.stretch?.ratio ?? 1);
    restore.disabled = !!job;
    warp.disabled = !!job || clip.duration <= 0;
    if (!current) warp.title = "先載入伸縮引擎";
    else warp.title = "雙擊波形新增標記 · 拖曳調整時間 · Delete 刪除";
    ratio.disabled = !!job;
    cancel.hidden = !job;
  }
  async function render(value: number, points: readonly ClipStretchAnchor[] = []): Promise<void> {
    if (job) return;
    const editor = root.parentElement;
    const focused = doc.activeElement;
    const focusedMarker =
      focused instanceof HTMLButtonElement && focused.classList.contains("ar-warp-marker") && editor?.contains(focused)
        ? focused.dataset.sourceFrame
        : undefined;
    const request = new AbortController();
    job = request;
    busy.value = true;
    apply.textContent = "處理中…";
    update();
    try {
      const prepared = await workspace.prepareAudioClipStretch(clip.id, value, engine.active.value?.processor, {
        signal: request.signal,
        anchors: points,
      });
      if (!disposed && !request.signal.aborted) {
        commit(prepared);
        if (focusedMarker !== undefined)
          editor
            ?.querySelector<HTMLButtonElement>(`.ar-warp-marker[data-source-frame="${CSS.escape(focusedMarker)}"]`)
            ?.focus({ preventScroll: true });
      }
    } catch (error) {
      if (!disposed && !request.signal.aborted) report(error);
    } finally {
      job = undefined;
      busy.value = false;
      apply.textContent = "套用倍率";
      update();
    }
  }
  ratio.addEventListener("input", update);
  apply.addEventListener("click", () => {
    const outputFrames = Math.round(map.sourceDuration * clip.sampleRate * ratio.valueAsNumber);
    const scale = outputFrames / Math.round(clip.duration * clip.sampleRate);
    void render(
      ratio.valueAsNumber,
      anchors.map((point) => ({ ...point, outputFrame: Math.round(point.outputFrame * scale) })),
    );
  });
  restore.addEventListener("click", () => void render(1));
  cancel.addEventListener("click", () => job?.abort());
  const stop = effect(update);
  row.append(button, engineFile, label, apply, warp, restore, cancel);
  root.append(row);
  return {
    dispose() {
      disposed = true;
      job?.abort();
      stopWarp();
      attachment?.dispose();
      stop();
      row.remove();
    },
  };
}
