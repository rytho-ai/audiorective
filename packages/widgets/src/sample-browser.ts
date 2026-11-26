import { effect } from "./detached-effect";
import type { Readable } from "@audiorective/core";

export type SampleRow = Readonly<{
  id: string;
  name: string;
  status: "loading" | "ready" | "error";
  /** Seconds; absent until decoded. */
  duration?: number;
  error?: string;
}>;
export type SampleBrowserState = Readonly<{ rows: readonly SampleRow[]; previewId: string | null; previewPlaying: boolean }>;

export type SampleBrowserOptions = {
  library: {
    state: Readable<SampleBrowserState>;
    preview(id: string): Promise<void>;
    stopPreview(): void;
    remove(id: string): void;
  };
  choose(id: string): void | Promise<void>;
  onError(error: unknown): void;
  labels?: Partial<{ preview: string; stop: string; use: string; remove: string; loading: string }>;
};

/** Browse a caller-owned Sample Library. Import controls and placement belong to the caller. */
export function mountSampleBrowser(root: HTMLElement, options: SampleBrowserOptions) {
  const labels = { preview: "Preview", stop: "Stop", use: "Use", remove: "Remove", loading: "Loading…", ...options.labels };
  const doc = root.ownerDocument;
  const list = doc.createElement("ul");
  list.className = "ar-sample-browser";
  root.append(list);
  const rows = new Map<string, ReturnType<typeof add>>();

  function button(label: string, action: () => void | Promise<void>) {
    const item = doc.createElement("button");
    item.type = "button";
    item.textContent = label;
    item.addEventListener("click", async () => {
      try {
        await action();
      } catch (error) {
        options.onError(error);
      }
    });
    return item;
  }

  function add(row: SampleRow) {
    const element = doc.createElement("li");
    element.dataset.sampleId = row.id;
    element.className = "ar-sample-row";
    const name = doc.createElement("strong");
    name.textContent = row.name;
    name.title = row.name;
    const description = doc.createElement("small");
    const actions = doc.createElement("div");
    const preview = button(labels.preview, () => {
      const state = options.library.state.value;
      if (state.previewId === row.id && state.previewPlaying) options.library.stopPreview();
      else return options.library.preview(row.id);
    });
    const use = button(labels.use, () => options.choose(row.id));
    use.setAttribute("aria-label", `${labels.use} ${row.name}`);
    const remove = button(labels.remove, () => options.library.remove(row.id));
    remove.setAttribute("aria-label", `${labels.remove} ${row.name}`);
    actions.append(preview, use, remove);
    element.append(name, description, actions);
    list.append(element);
    return {
      element,
      update(row: SampleRow, playing: boolean) {
        description.textContent = row.status === "loading" ? labels.loading : (row.error ?? `${row.duration?.toFixed(2)} s`);
        preview.disabled = use.disabled = row.status !== "ready";
        preview.textContent = playing ? labels.stop : labels.preview;
        preview.setAttribute("aria-label", `${preview.textContent} ${row.name}`);
        preview.setAttribute("aria-pressed", String(playing));
      },
    };
  }

  const unsubscribe = effect(() => {
    const state = options.library.state.value;
    const ids = new Set(state.rows.map(({ id }) => id));
    for (const [id, row] of rows)
      if (!ids.has(id)) {
        row.element.remove();
        rows.delete(id);
      }
    for (const record of state.rows) {
      let row = rows.get(record.id);
      if (!row) {
        row = add(record);
        rows.set(record.id, row);
      }
      row.update(record, state.previewId === record.id && state.previewPlaying);
    }
  });
  return {
    dispose() {
      unsubscribe();
      rows.clear();
      list.remove();
    },
  };
}
