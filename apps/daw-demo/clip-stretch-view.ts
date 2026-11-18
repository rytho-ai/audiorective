import { cell, effect, readonlyCell } from "@audiorective/core";
import type { TimeStretch } from "@audiorective/effects/time-stretch";
import type { AudioClip, PreparedClipStretch, Workspace } from "@audiorective/workspace";

export function createClipStretchEngine() {
  const source = cell<{ name: string; processor: TimeStretch } | undefined>(undefined);
  let next = 0;
  return {
    active: readonlyCell(source),
    async load(file: File) {
      const generation = ++next;
      const [bytes, { TimeStretch }] = await Promise.all([file.arrayBuffer(), import("@audiorective/effects/time-stretch")]);
      const module = await WebAssembly.compile(bytes);
      if (generation !== next) return;
      const previous = source.value;
      source.value = { name: file.name, processor: new TimeStretch(module) };
      previous?.processor.destroy();
    },
    destroy() {
      next++;
      source.value?.processor.destroy();
      source.value = undefined;
    },
  };
}

type ClipStretchViewOptions = {
  clip: AudioClip;
  workspace: Workspace;
  engine: ReturnType<typeof createClipStretchEngine>;
  commit(render: PreparedClipStretch): void;
  report(error: unknown): void;
};

export function mountClipStretchView(root: HTMLElement, { clip, workspace, engine, commit, report }: ClipStretchViewOptions) {
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
  let destroyed = false;

  function update(): void {
    const current = engine.active.value;
    button.textContent = current ? "更換伸縮引擎" : "載入伸縮引擎";
    if (current) button.title = current.name;
    const value = ratio.valueAsNumber;
    apply.disabled = !!job || !Number.isFinite(value) || value <= 0 || (value !== 1 && !current) || value === (clip.stretch?.ratio ?? 1);
    restore.disabled = !!job;
    ratio.disabled = !!job;
    cancel.hidden = !job;
  }
  async function render(value: number): Promise<void> {
    const request = new AbortController();
    job = request;
    apply.textContent = "處理中…";
    update();
    try {
      const prepared = await workspace.prepareAudioClipStretch(clip.id, value, engine.active.value?.processor, { signal: request.signal });
      if (!destroyed && !request.signal.aborted) commit(prepared);
    } catch (error) {
      if (!destroyed && !request.signal.aborted) report(error);
    } finally {
      job = undefined;
      apply.textContent = "套用倍率";
      update();
    }
  }
  ratio.addEventListener("input", update);
  apply.addEventListener("click", () => void render(ratio.valueAsNumber));
  restore.addEventListener("click", () => void render(1));
  cancel.addEventListener("click", () => job?.abort());
  const stop = effect(update);
  row.append(button, engineFile, label, apply, restore, cancel);
  root.append(row);
  return {
    destroy() {
      destroyed = true;
      job?.abort();
      stop();
      row.remove();
    },
  };
}
