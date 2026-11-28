import { effect } from "./detached-effect";
import type { Readable } from "@audiorective/core";

export type SampleRow = Readonly<{
  /** Stable sample identifier forwarded to library commands. */
  id: string;
  /** Visible sample caption; independent of its stable identifier. */
  name: string;
  /** Import lifecycle phase; error indicates that the sample is unavailable for playback. */
  status: "loading" | "ready" | "error";
  /** Seconds; absent until decoded. */
  duration?: number;
  /** Optional import failure text; absent when no failure is reported. */
  error?: string;
}>;
export type SampleBrowserState = Readonly<{
  /** Visible library entries in display order; may be empty. */
  rows: readonly SampleRow[];
  /** Identifier of the previewed sample; null when no sample is selected for preview. */
  previewId: string | null;
  /** Whether library preview audio is currently playing. */
  previewPlaying: boolean;
}>;

export type SampleBrowserOptions = {
  /** Borrowed library state and commands; disposing the view does not dispose the library. */
  library: {
    /** Reactive library snapshot; changes refresh the visible rows and preview controls. */
    state: Readable<SampleBrowserState>;
    /** Starts preview by stable sample identifier; rejects when loading or playback fails. */
    preview(id: string): Promise<void>;
    /** Stops current preview playback; leaves imported samples in the library. */
    stopPreview(): void;
    /** Removes a sample by stable identifier; caller owns any persistence consequences. */
    remove(id: string): void;
  };
  /** Accepts a sample by stable identifier; may complete asynchronously. */
  choose(id: string): void | Promise<void>;
  /** Receives failures from preview, choose or removal commands. */
  onError(error: unknown): void;
  /** Optional control-caption overrides; missing entries use built-in English text. */
  labels?: Partial<{
    /** Preview-button caption; defaults to "Preview". */
    preview: string;
    /** Preview-stop caption; defaults to "Stop". */
    stop: string;
    /** Choose-button caption; defaults to "Use". */
    use: string;
    /** Delete-button caption; defaults to "Remove". */
    remove: string;
    /** Pending-import caption; defaults to "Loading…". */
    loading: string;
  }>;
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
