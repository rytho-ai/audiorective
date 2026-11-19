import { effect, type Readable } from "@audiorective/core";

type ClipLaunch = Readonly<{ trackId: string; clipId: string | null; mode?: "loop" | "one-shot" }>;
type ClipLauncherState = Readonly<{
  active: readonly ClipLaunch[];
  queued: readonly (ClipLaunch & Readonly<{ beat: number }>)[];
}>;

export type ClipGridLayout = Readonly<{
  tracks: readonly Readonly<{ id: string; label: string }>[];
  scenes: readonly Readonly<{ label: string; clips: readonly Readonly<{ trackId: string; clipId: string; label: string }>[] }>[];
}>;

export type ClipGridOptions = {
  state: Readable<ClipLauncherState>;
  launch(changes: readonly ClipLaunch[]): void;
  cancel(): void;
  labels?: Partial<{
    scene: string;
    cancel: string;
    arrangement: string;
    idle: string;
    playing: string;
    empty: string;
    queued(beat: number): string;
  }>;
};

/** Renders a caller-owned scene layout over borrowed launcher state. */
export function mountClipGrid(root: HTMLElement, options: ClipGridOptions) {
  const labels = {
    scene: "Scene",
    cancel: "Cancel queued launch",
    arrangement: "Back to Arrangement",
    idle: "Arrangement playing",
    playing: "Session playback",
    empty: "No launchable audio clips",
    queued: (beat: number) => `Queued for beat ${beat + 1}`,
    ...options.labels,
  };
  const doc = root.ownerDocument;
  function button(label: string, action: () => void): HTMLButtonElement {
    const item = doc.createElement("button");
    item.type = "button";
    item.textContent = label;
    item.addEventListener("click", action);
    return item;
  }

  const element = doc.createElement("div");
  element.className = "ar-clip-grid";
  const toolbar = doc.createElement("div");
  toolbar.className = "ar-clip-grid-toolbar";
  const status = doc.createElement("span");
  status.setAttribute("role", "status");
  const cancel = button(labels.cancel, options.cancel);
  const arrangement = button(labels.arrangement, () => options.launch(options.state.value.active.map(({ trackId }) => ({ trackId, clipId: null }))));
  toolbar.append(arrangement, cancel, status);
  const body = doc.createElement("div");
  body.className = "ar-clip-grid-body";
  element.append(toolbar, body);
  root.append(element);

  let slots: { button: HTMLButtonElement; trackId: string; clipId: string }[] = [];
  let scenes: { button: HTMLButtonElement; clips: readonly ClipLaunch[] }[] = [];
  let returns: { button: HTMLButtonElement; trackId: string }[] = [];
  function renderState(state: ClipLauncherState): void {
    const active = new Map(state.active.map(({ trackId, clipId }) => [trackId, clipId]));
    const queued = new Map(state.queued.map(({ trackId, clipId }) => [trackId, clipId]));
    function mark(item: HTMLButtonElement, playing: boolean, pending: boolean): void {
      item.dataset.clipState = pending ? "queued" : playing ? "active" : "idle";
      item.setAttribute("aria-pressed", String(playing));
    }
    for (const slot of slots) mark(slot.button, active.get(slot.trackId) === slot.clipId, queued.get(slot.trackId) === slot.clipId);
    for (const scene of scenes) {
      mark(
        scene.button,
        scene.clips.every(({ trackId, clipId }) => active.get(trackId) === clipId),
        scene.clips.every(({ trackId, clipId }) => queued.get(trackId) === clipId),
      );
    }
    for (const { button, trackId } of returns) {
      button.disabled = !active.has(trackId);
      button.dataset.clipState = queued.get(trackId) === null ? "queued" : "idle";
    }
    cancel.disabled = !state.queued.length;
    arrangement.disabled = !active.size;
    status.textContent = state.queued.length
      ? labels.queued(Math.min(...state.queued.map(({ beat }) => beat)))
      : active.size
        ? labels.playing
        : labels.idle;
  }

  function setLayout(layout: ClipGridLayout): void {
    slots = [];
    scenes = [];
    returns = [];
    toolbar.hidden = !layout.scenes.length;
    if (!layout.scenes.length) {
      body.textContent = labels.empty;
      return;
    }
    const table = doc.createElement("table");
    const header = table.createTHead().insertRow();
    function heading(row: HTMLTableRowElement, value: string | HTMLElement, scope: "col" | "row"): void {
      const cell = doc.createElement("th");
      cell.scope = scope;
      cell.append(value);
      row.append(cell);
    }
    heading(header, labels.scene, "col");
    for (const track of layout.tracks) heading(header, track.label, "col");

    const rows = table.createTBody();
    for (const scene of layout.scenes) {
      const row = rows.insertRow();
      const action = button(scene.label, () => options.launch(scene.clips));
      action.setAttribute("aria-label", `${labels.scene} ${scene.label}`);
      scenes.push({ button: action, clips: scene.clips });
      heading(row, action, "row");
      const byTrack = new Map(scene.clips.map((clip) => [clip.trackId, clip]));
      for (const track of layout.tracks) {
        const cell = row.insertCell();
        const clip = byTrack.get(track.id);
        if (!clip) continue;
        const action = button(clip.label, () => options.launch([clip]));
        action.setAttribute("aria-label", `${track.label} · ${scene.label} · ${clip.label}`);
        slots.push({ button: action, ...clip });
        cell.append(action);
      }
    }
    const footer = table.createTFoot().insertRow();
    heading(footer, labels.arrangement, "row");
    for (const track of layout.tracks) {
      const action = button("↩", () => options.launch([{ trackId: track.id, clipId: null }]));
      action.setAttribute("aria-label", `${track.label} · ${labels.arrangement}`);
      returns.push({ button: action, trackId: track.id });
      footer.insertCell().append(action);
    }
    body.replaceChildren(table);
    renderState(options.state.value);
  }

  const stop = effect(() => renderState(options.state.value));
  return {
    setLayout,
    destroy() {
      stop();
      element.remove();
    },
  };
}
