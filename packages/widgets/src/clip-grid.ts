import { cell, type Readable } from "@audiorective/core";
import { effect } from "./detached-effect";

/** The part of a launcher clip the grid reads and drives (an `@audiorective/launcher` `Clip` satisfies it). */
export interface ClipGridClip {
  readonly playing: Readable<boolean>;
  readonly queued: Readable<boolean>;
  launch(): void;
}
/** The part of a launcher track the grid reads and drives (an `@audiorective/launcher` `Track` satisfies it). */
export interface ClipGridTrack {
  readonly playing: Readable<unknown>;
  readonly queued: Readable<unknown>;
  stop(): void;
}
/** The part of a launcher the grid reads and drives (a `ClipLauncher` satisfies it). */
export interface ClipGridLauncher {
  readonly playing: Readable<readonly unknown[]>;
  readonly queued: Readable<readonly Readonly<{ beat: number | null }>[]>;
  /**
   * Receives a scene's slot index (a layout scene with `index`) or its `ClipGridClip` objects: typed `never[]` so a launcher that takes its own clip type (`Clip[]`) satisfies this.
   * The index form lets the launcher apply its own rules for the scene's empty slots.
   */
  launchScene(scene: number | readonly never[]): void;
  stopAll(): void;
  cancelQueued(): boolean;
}

export type ClipGridLayout = Readonly<{
  tracks: readonly Readonly<{ track: ClipGridTrack; label: string }>[];
  scenes: readonly Readonly<{
    label: string;
    /** The launcher's scene slot this row stands for. Give it when the row is the launcher's whole scene: its button then calls `launchScene(index)`, so `emptySlots` applies; without it the row launches exactly its `clips`. */
    index?: number;
    clips: readonly Readonly<{ track: ClipGridTrack; clip: ClipGridClip; label: string }>[];
  }>[];
}>;

export type ClipGridOptions = {
  /** The launcher whose cells the grid shows and whose commands its buttons call. The quantize of every launch is `launcher.quantize`. */
  launcher: ClipGridLauncher;
  /** Wraps every launch, stop and scene command a button issues, so an app can start playback first; default: run it at once. */
  launch?(command: () => void): void;
  /** Replaces the cancel button's `launcher.cancelQueued()`, so an app can also drop launches it is still preparing. */
  cancel?(): void;
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

/** Renders a caller-owned scene layout over a launcher's cells. */
export function mountClipGrid(root: HTMLElement, options: ClipGridOptions) {
  const { launcher } = options;
  const run = (command: () => void) => (options.launch ? options.launch(command) : command());
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
  const cancel = button(labels.cancel, () => (options.cancel ? options.cancel() : void launcher.cancelQueued()));
  const arrangement = button(labels.arrangement, () => run(() => launcher.stopAll()));
  toolbar.append(arrangement, cancel, status);
  const body = doc.createElement("div");
  body.className = "ar-clip-grid-body";
  element.append(toolbar, body);
  root.append(element);

  /** Bumped by `setLayout`, so the rendering effect re-runs and subscribes to the new layout's cells. */
  const layoutVersion = cell(0);
  let version = 0;
  let slots: { button: HTMLButtonElement; clip: ClipGridClip }[] = [];
  let scenes: { button: HTMLButtonElement; clips: readonly ClipGridClip[] }[] = [];
  let returns: { button: HTMLButtonElement; track: ClipGridTrack }[] = [];
  function renderState(): void {
    layoutVersion.$();
    function mark(item: HTMLButtonElement, playing: boolean, pending: boolean): void {
      item.dataset.clipState = pending ? "queued" : playing ? "active" : "idle";
      item.setAttribute("aria-pressed", String(playing));
    }
    for (const slot of slots) mark(slot.button, slot.clip.playing.value, slot.clip.queued.value);
    for (const scene of scenes) {
      mark(
        scene.button,
        scene.clips.every((clip) => clip.playing.value),
        scene.clips.every((clip) => clip.queued.value),
      );
    }
    for (const { button, track } of returns) {
      button.disabled = !track.playing.value;
      button.dataset.clipState = track.queued.value ? "queued" : "idle";
    }
    const queued = launcher.queued.value;
    const playing = launcher.playing.value;
    cancel.disabled = !queued.length;
    arrangement.disabled = !playing.length;
    const beats = queued.flatMap(({ beat }) => (beat === null ? [] : [beat]));
    status.textContent = queued.length
      ? beats.length
        ? labels.queued(Math.min(...beats))
        : labels.queued(0)
      : playing.length
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
      layoutVersion.value = ++version;
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
    for (const { label } of layout.tracks) heading(header, label, "col");

    const rows = table.createTBody();
    for (const scene of layout.scenes) {
      const row = rows.insertRow();
      const action = button(scene.label, () => run(() => launcher.launchScene(scene.index ?? (scene.clips.map(({ clip }) => clip) as never[]))));
      action.setAttribute("aria-label", `${labels.scene} ${scene.label}`);
      scenes.push({ button: action, clips: scene.clips.map(({ clip }) => clip) });
      heading(row, action, "row");
      for (const { track, label } of layout.tracks) {
        const cell = row.insertCell();
        const entry = scene.clips.find((slot) => slot.track === track);
        if (!entry) continue;
        const action = button(entry.label, () => run(() => entry.clip.launch()));
        action.setAttribute("aria-label", `${label} · ${scene.label} · ${entry.label}`);
        slots.push({ button: action, clip: entry.clip });
        cell.append(action);
      }
    }
    const footer = table.createTFoot().insertRow();
    heading(footer, labels.arrangement, "row");
    for (const { track, label } of layout.tracks) {
      const action = button("↩", () => run(() => track.stop()));
      action.setAttribute("aria-label", `${label} · ${labels.arrangement}`);
      returns.push({ button: action, track });
      footer.insertCell().append(action);
    }
    body.replaceChildren(table);
    layoutVersion.value = ++version;
  }

  const stop = effect(() => renderState());
  return {
    setLayout,
    dispose() {
      stop();
      element.remove();
    },
  };
}
