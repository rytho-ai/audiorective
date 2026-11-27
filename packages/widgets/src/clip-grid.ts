import { cell, type Readable } from "@audiorective/core";
import { effect } from "./detached-effect";

/** The part of a launcher clip the grid reads and drives (an `@audiorective/launcher` `Clip` satisfies it). */
export interface ClipGridClip {
  /** Whether this clip currently owns playback on its track. */
  readonly playing: Readable<boolean>;
  /** Whether this clip is waiting for a launch boundary. */
  readonly queued: Readable<boolean>;
  /** Requests playback using the launcher's resolved quantization rule. */
  launch(): void;
}
/** The part of a launcher track the grid reads and drives (an `@audiorective/launcher` `Track` satisfies it). */
export interface ClipGridTrack {
  /** Currently active clip or another truthy playback marker; falsy means no session playback. */
  readonly playing: Readable<unknown>;
  /** Pending track change or another truthy marker; falsy means no pending change. */
  readonly queued: Readable<unknown>;
  /** Requests a stop at the launcher's resolved quantization boundary. */
  stop(): void;
}
/** The part of a launcher the grid reads and drives (a `ClipLauncher` satisfies it). */
export interface ClipGridLauncher {
  /** Currently active session clips; an empty array means arrangement playback. */
  readonly playing: Readable<readonly unknown[]>;
  /** Pending changes; an empty array disables the cancel button. */
  readonly queued: Readable<
    readonly Readonly<{
      /** Quarter-note transport beat of the pending boundary; null while no boundary is resolved. */
      beat: number | null;
    }>[]
  >;
  /**
   * Receives a scene's slot index (a layout scene with `index`) or its `ClipGridClip` objects: typed `never[]` so a launcher that takes its own clip type (`Clip[]`) satisfies this.
   * The index form lets the launcher apply its own rules for the scene's empty slots.
   */
  launchScene(scene: number | readonly never[]): void;
  /** Requests all session tracks to stop and return to arrangement playback. */
  stopAll(): void;
  /** Withdraws pending launches; returns whether any queued change was cancelled. */
  cancelQueued(): boolean;
}

export type ClipGridLayout = Readonly<{
  /** Visible track columns in display order; an empty list draws no track columns. */
  tracks: readonly Readonly<{
    /** Borrowed track whose playback state and stop command drive this column. */
    track: ClipGridTrack;
    /** Visible column caption; independent of the borrowed track's identity. */
    label: string;
  }>[];
  /** Visible scene rows in display order; may represent subsets of launcher scenes. */
  scenes: readonly Readonly<{
    /** Visible row caption; independent of the launcher's scene slot. */
    label: string;
    /** The launcher's scene slot this row stands for. Give it when the row is the launcher's whole scene: its button then calls `launchScene(index)`, so `emptySlots` applies; without it the row launches exactly its `clips`. */
    index?: number;
    /** Launchable cells in this row; absent track slots remain empty. */
    clips: readonly Readonly<{
      /** Borrowed track that owns this cell's clip. */
      track: ClipGridTrack;
      /** Borrowed clip whose state and launch command drive this cell. */
      clip: ClipGridClip;
      /** Visible launch-button caption; independent of the clip's identity. */
      label: string;
    }>[];
  }>[];
}>;

export type ClipGridOptions = {
  /** The launcher whose cells the grid shows and whose commands its buttons call. The quantize of every launch is `launcher.quantize`. */
  launcher: ClipGridLauncher;
  /** Wraps every launch, stop and scene command a button issues, so an app can start playback first; default: run it at once. */
  launch?(command: () => void): void;
  /** Replaces the cancel button's `launcher.cancelQueued()`, so an app can also drop launches it is still preparing. */
  cancel?(): void;
  /** Optional button and status-text overrides; missing entries use built-in English text. */
  labels?: Partial<{
    /** Scene-button prefix; defaults to "Scene". */
    scene: string;
    /** Cancel-button caption; defaults to "Cancel queued launch". */
    cancel: string;
    /** Return-button caption; defaults to "Back to Arrangement". */
    arrangement: string;
    /** Status when no session clip plays; defaults to "Arrangement playing". */
    idle: string;
    /** Status while session clips play; defaults to "Session playback". */
    playing: string;
    /** Status for rows without launchable clips; defaults to "No launchable audio clips". */
    empty: string;
    /** Formats a quarter-note transport beat; default text displays beat + 1. */
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
