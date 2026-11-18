import { type AudioClip, type MidiClip, type ProjectClip, type ProjectTrack, type Workspace } from "@audiorective/workspace";
import type { MidiNote } from "@audiorective/midi";
import { mountPianoRoll } from "@audiorective/widgets/piano-roll";
import { attachClipGesture, attachTimelineZoom, type ClipGestureHandle, type TimelineZoomHandle } from "@audiorective/widgets/arrangement";
import { mountWaveform, type WaveformPeaks } from "@audiorective/widgets/waveform";
import { EditHistory } from "./edit-history";
import { mountEffectRackView } from "./effect-rack-view";

type StudioActions = {
  workspace(): Workspace;
  context: AudioContext;
  status(message: string): void;
  error(error: unknown): void;
  addNote(clip: MidiClip, placement?: { start: number; pitch: number }): string;
};

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const pitchName = (pitch: number) => `${["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"][pitch % 12]}${Math.floor(pitch / 12) - 1}`;
const button = (label: string, action: () => void | Promise<void>, title?: string) => {
  const element = document.createElement("button");
  element.type = "button";
  element.textContent = label;
  if (title) element.title = title;
  element.addEventListener("click", (event) => {
    event.stopPropagation();
    try {
      Promise.resolve(action()).catch(console.error);
    } catch (error) {
      console.error(error);
    }
  });
  return element;
};

export class StudioView {
  selectedTrackId: string | undefined;
  selectedClipId: string | undefined;
  private selectedNote?: { clipId: string; noteId: string };
  private noteHighlightObserver?: MutationObserver;
  private editorPitchRange?: { low: number; high: number };
  pixelsPerSecond = 55;
  private readonly timelineZoom: TimelineZoomHandle;
  private clipView?: {
    destroy(): void;
    setPlayhead(time: number | null): void;
    getViewport(): { duration: number; pixelsPerSecond: number; scrollLeft: number; width: number };
    setZoom(factor: number): void;
    setAmplitudeZoom?(factor: number): void;
    getAmplitudeZoom?(): number;
    scrollTo(seconds: number): void;
  };
  private editorClipId?: string;
  private readonly editorViewStates = new Map<string, { zoom: number; scrollTime: number; amplitudeZoom: number }>();
  private readonly mediaPeaks = new WeakMap<AudioClip, WaveformPeaks>();
  private readonly pendingPeaks = new WeakSet<AudioClip>();
  private disposed = false;
  private loopTarget: string | null | undefined;
  private readonly editorDetachers = new Set<() => void>();
  private editorClipTime = 0;
  private playheads: HTMLElement[] = [];
  private rulerWidth = 0;
  private readonly clipGestures: ClipGestureHandle[] = [];
  private readonly history: EditHistory;

  constructor(private readonly actions: StudioActions) {
    this.history = new EditHistory(
      () => this.workspace.project,
      () => {
        const selectedTrack = this.workspace.project.tracks.find((track) => track.clips.some((clip) => clip.id === this.selectedClipId));
        if (this.selectedClipId && !selectedTrack) this.selectedClipId = undefined;
        if (selectedTrack) this.selectedTrackId = selectedTrack.id;
        const clip = this.selectedClip();
        if (this.selectedNote && (clip?.kind !== "midi" || !clip.sequence.getState().notes.some((note) => note.id === this.selectedNote?.noteId)))
          this.selectedNote = undefined;
        this.render();
      },
      (undo, redo) => {
        const undoButton = $<HTMLButtonElement>("undo");
        const redoButton = $<HTMLButtonElement>("redo");
        undoButton.disabled = !undo;
        redoButton.disabled = !redo;
        undoButton.title = undo ? `復原：${undo}` : "沒有可復原的片段或音符編輯";
        redoButton.title = redo ? `重做：${redo}` : "沒有可重做的片段或音符編輯";
      },
    );
    this.history.clear();
    const resizeGrip = $("lower-resize");
    const lowerPanel = document.querySelector<HTMLElement>(".lower-panel")!;
    const resizeLimit = () => {
      const main = document.querySelector<HTMLElement>(".main-area")!;
      return Math.max(
        180,
        main.clientHeight -
          main.querySelector<HTMLElement>(".arrange-heading")!.offsetHeight -
          main.querySelector<HTMLElement>(".arrange-footer")!.offsetHeight -
          190,
      );
    };
    const setLowerHeight = (height: number) => {
      const max = resizeLimit();
      const next = Math.max(180, Math.min(max, height));
      lowerPanel.style.height = `${next}px`;
      resizeGrip.setAttribute("aria-valuenow", String(Math.round(next)));
      resizeGrip.setAttribute("aria-valuemax", String(Math.round(max)));
    };
    let resizing: { pointerId: number; y: number; height: number } | undefined;
    resizeGrip.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      resizeGrip.setPointerCapture(event.pointerId);
      resizing = { pointerId: event.pointerId, y: event.clientY, height: lowerPanel.getBoundingClientRect().height };
    });
    resizeGrip.addEventListener("pointermove", (event) => {
      if (resizing?.pointerId === event.pointerId) setLowerHeight(resizing.height + resizing.y - event.clientY);
    });
    const finishResize = (event: PointerEvent) => {
      if (resizing?.pointerId !== event.pointerId) return;
      if (resizeGrip.hasPointerCapture(event.pointerId)) resizeGrip.releasePointerCapture(event.pointerId);
      resizing = undefined;
    };
    resizeGrip.addEventListener("pointerup", finishResize);
    resizeGrip.addEventListener("pointercancel", finishResize);
    resizeGrip.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowUp" && event.key !== "ArrowDown" && event.key !== "Home" && event.key !== "End") return;
      event.preventDefault();
      const current = lowerPanel.getBoundingClientRect().height;
      setLowerHeight(event.key === "Home" ? 180 : event.key === "End" ? resizeLimit() : current + (event.key === "ArrowUp" ? 24 : -24));
    });
    $("toggle-browser").addEventListener("click", () => {
      const studio = document.querySelector<HTMLElement>(".studio")!;
      const open = studio.dataset.browserOpen !== "true";
      studio.dataset.browserOpen = String(open);
      $("toggle-browser").setAttribute("aria-pressed", String(open));
    });
    $("toggle-lower").addEventListener("click", () => {
      const studio = document.querySelector<HTMLElement>(".studio")!;
      const open = studio.dataset.lowerOpen !== "true";
      studio.dataset.lowerOpen = String(open);
      $("toggle-lower").setAttribute("aria-pressed", String(open));
      this.renderDevices();
    });
    $("project-title").title = "雙擊重新命名工程";
    $("project-title").addEventListener("dblclick", () => {
      const next = prompt("工程名稱", this.workspace.project.title);
      if (next !== null) {
        try {
          this.workspace.project.setTitle(next);
          this.render();
        } catch (error) {
          this.actions.error(error);
        }
      }
    });
    for (const panel of ["editor", "mixer", "device"] as const) {
      $(`tab-${panel}`).addEventListener("click", () => this.showPanel(panel));
    }
    const arrangement = $("tracks");
    this.timelineZoom = attachTimelineZoom({
      viewport: arrangement,
      ruler: () => arrangement.querySelector<HTMLElement>(".ruler-row .ruler"),
      slider: $<HTMLInputElement>("timeline-zoom"),
      getScale: () => this.pixelsPerSecond,
      onScale: (scale) => {
        this.pixelsPerSecond = scale;
        this.render();
      },
    });
    $("zoom-in").addEventListener("click", () => this.timelineZoom.zoomBy(1.45));
    $("zoom-out").addEventListener("click", () => this.timelineZoom.zoomBy(1 / 1.45));
    $("zoom-fit").addEventListener("click", () => {
      const root = $("tracks");
      const header = root.querySelector<HTMLElement>(".track-control")?.offsetWidth ?? 210;
      const available = Math.max(1, root.clientWidth - header - 16);
      this.timelineZoom.zoomTo(available / Math.max(4, this.actions.workspace().duration + 2), root.getBoundingClientRect().left + header);
    });
    $("duplicate").addEventListener("click", () => this.duplicate());
    $("delete").addEventListener("click", () => this.delete());
    $("split").addEventListener("click", () => this.editAtPlayhead("split"));
    $("trim-start").addEventListener("click", () => this.editAtPlayhead("start"));
    $("trim-end").addEventListener("click", () => this.editAtPlayhead("end"));
    $("undo").addEventListener("click", () => this.undo());
    $("redo").addEventListener("click", () => this.redo());
    $("new-midi-clip").addEventListener("click", () => this.addMidiClip());
    document.addEventListener("keydown", (event) => {
      const target = event.target as HTMLElement;
      if (target.closest("input,textarea,[contenteditable]")) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) this.redo();
        else this.undo();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "y") {
        event.preventDefault();
        this.redo();
        return;
      }
      if (event.key === "Delete" || event.key === "Backspace") {
        if (
          this.selectedNote?.clipId === this.selectedClipId &&
          document.querySelector<HTMLElement>(".studio")?.dataset.lowerOpen === "true" &&
          $("tab-editor").classList.contains("active")
        ) {
          event.preventDefault();
          this.deleteSelectedNote();
        } else if (this.selectedClipId) {
          event.preventDefault();
          this.delete();
        }
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "d") {
        if (this.selectedClipId) {
          event.preventDefault();
          this.duplicate();
        }
      }
      if (event.key === "Escape") {
        this.selectedNote = undefined;
        this.selectedClipId = undefined;
        this.render();
      }
      if (event.code === "Space" && !event.repeat) {
        event.preventDefault();
        const workspace = this.actions.workspace();
        if (workspace.clock.state.value === "playing") workspace.pause();
        else workspace.play().catch(this.actions.error);
      }
    });
  }

  private get workspace(): Workspace {
    return this.actions.workspace();
  }
  private snap(time: number): number {
    return this.workspace.project.tempoMap.snapSeconds(Math.max(0, time));
  }
  private selectedTrack(): ProjectTrack | undefined {
    return this.workspace.project.tracks.find((track) => track.id === this.selectedTrackId);
  }
  private selectedClip(): ProjectClip | undefined {
    return this.workspace.project.tracks.flatMap((track) => track.clips).find((clip) => clip.id === this.selectedClipId);
  }

  selectTrack(trackId: string): void {
    this.selectedTrackId = trackId;
    this.selectedClipId = undefined;
    this.selectedNote = undefined;
    this.render();
    this.revealTrack(trackId);
  }
  selectClip(trackId: string, clipId: string): void {
    this.selectedTrackId = trackId;
    this.selectedClipId = clipId;
    this.selectedNote = undefined;
    this.render();
  }

  private showPanel(panel: "editor" | "mixer" | "device"): void {
    document.querySelector<HTMLElement>(".studio")!.dataset.lowerOpen = "true";
    $("toggle-lower").setAttribute("aria-pressed", "true");
    for (const name of ["editor", "mixer", "device"] as const) {
      $(`tab-${name}`).classList.toggle("active", name === panel);
      $(`${name}-panel`).classList.toggle("hidden", name !== panel);
    }
    this.renderDevices();
  }

  setLoopTarget(clipId: string | null | undefined): void {
    this.loopTarget = clipId;
    this.renderLoopBand();
  }

  private renderLoopBand(): void {
    const ruler = $("tracks").querySelector<HTMLElement>(".ruler-row .ruler");
    if (!ruler) return;
    ruler.querySelector(".loop-region")?.remove();
    if (this.loopTarget === undefined) return;
    const clip = this.loopTarget
      ? this.workspace.project.tracks.flatMap((track) => track.clips).find((item) => item.id === this.loopTarget)
      : undefined;
    const start = clip ? this.workspace.project.clipTimeSeconds(clip) : 0;
    const end = clip ? this.workspace.project.clipTimeSeconds(clip, clip.duration) : this.workspace.duration;
    if (end <= start) return;
    const band = document.createElement("div");
    band.className = "loop-region";
    band.style.left = `${start * this.pixelsPerSecond}px`;
    band.style.width = `${(end - start) * this.pixelsPerSecond}px`;
    band.setAttribute("aria-label", `循環 ${start.toFixed(1)} 到 ${end.toFixed(1)} 秒`);
    ruler.prepend(band);
  }

  private revealTrack(trackId: string): void {
    const root = $("tracks");
    const row = Array.from(root.querySelectorAll<HTMLElement>(".timeline-row[data-track-id]")).find((item) => item.dataset.trackId === trackId);
    if (!row) return;
    const top = row.offsetTop;
    const bottom = top + row.offsetHeight;
    if (bottom > root.scrollTop + root.clientHeight) root.scrollTop = bottom - root.clientHeight;
    else if (top < root.scrollTop + 60) root.scrollTop = Math.max(0, top - 60);
  }

  private addMidiClip(trackId = this.selectedTrackId, time = this.workspace.position): void {
    const track = this.workspace.project.tracks.find((item) => item.id === trackId && item.kind === "midi");
    if (!track) {
      this.actions.status("先選取 MIDI 軌，再新增片段。");
      return;
    }
    const map = this.workspace.project.tempoMap;
    const start = this.snap(time);
    const startBeat = map.secondsToBeat(start);
    const bar = this.workspace.project.signature[0] * 2;
    const clip = this.history.record("新增 MIDI 片段", () =>
      this.workspace.project.addMidiClip(track.id, { duration: bar, notes: [] }, startBeat, { timeUnit: "beats" }),
    );
    this.selectedTrackId = track.id;
    this.selectedClipId = clip.id;
    this.selectedNote = undefined;
    this.showPanel("editor");
    this.render();
    this.revealTrack(track.id);
    this.actions.status(`已在 ${track.name} 建立 MIDI 片段；雙擊琴卷格線加入音符。`);
  }

  private async duplicate(): Promise<void> {
    const clip = this.selectedClip();
    if (!clip) return;
    try {
      const end = this.workspace.project.clipTimeSeconds(clip, clip.duration);
      const time = this.snap(end);
      const target = clip.kind === "midi" && clip.timeUnit === "beats" ? this.workspace.project.tempoMap.secondsToBeat(time) : time;
      const copy = this.history.record("複製片段", () => this.workspace.project.duplicateClip(clip.id, target));
      this.selectedClipId = copy.id;
      this.render();
      this.actions.status("已複製 clip");
    } catch (error) {
      this.actions.error(error);
    }
  }

  private delete(): void {
    if (!this.selectedClipId) return;
    try {
      this.clipView?.destroy();
      this.clipView = undefined;
      this.history.record("刪除片段", () => this.workspace.project.removeClip(this.selectedClipId!));
      this.editorViewStates.delete(this.selectedClipId);
      this.selectedClipId = undefined;
      this.selectedNote = undefined;
      this.render();
      this.actions.status("已刪除 clip");
    } catch (error) {
      this.actions.error(error);
    }
  }

  private editAtPlayhead(kind: "split" | "start" | "end"): void {
    const clip = this.selectedClip();
    if (!clip) return;
    const snapped = this.snap(this.workspace.position);
    const offset =
      clip.kind === "midi" && clip.timeUnit === "beats" ? this.workspace.project.tempoMap.secondsToBeat(snapped) - clip.time : snapped - clip.time;
    if (offset <= 0 || offset >= clip.duration) {
      this.actions.status("請先把播放游標放在所選片段內部。");
      return;
    }
    try {
      const label = kind === "split" ? "分割片段" : kind === "start" ? "裁左片段" : "裁右片段";
      this.history.record(label, () => {
        if (kind === "split") this.workspace.project.splitClip(clip.id, offset);
        else this.workspace.project.trimClip(clip.id, kind === "start" ? offset : 0, kind === "end" ? offset : clip.duration);
      });
      this.selectedNote = undefined;
      this.render();
      this.actions.status(`${label} · ${this.workspace.position.toFixed(2)} s`);
    } catch (error) {
      this.actions.error(error);
    }
  }

  private undo(): void {
    try {
      const label = this.history.undo();
      if (label) this.actions.status(`已復原：${label}`);
    } catch (error) {
      this.actions.error(error);
    }
  }

  private redo(): void {
    try {
      const label = this.history.redo();
      if (label) this.actions.status(`已重做：${label}`);
    } catch (error) {
      this.actions.error(error);
    }
  }

  recordClipEdit<T>(label: string, action: () => T): T {
    return this.history.record(label, action);
  }

  clearHistory(): void {
    this.history.clear();
  }

  private trackControl(track: ProjectTrack, index: number): HTMLElement {
    const control = document.createElement("div");
    control.className = `track-control ${this.selectedTrackId === track.id ? "selected" : ""}`;
    control.dataset.trackId = track.id;
    control.title = track.kind === "midi" ? "MIDI 軌" : "音訊軌";
    const top = document.createElement("div");
    top.className = "track-top";
    const number = document.createElement("span");
    number.className = "track-number";
    number.textContent = String(index + 1).padStart(2, "0");
    const name = document.createElement("span");
    name.className = "track-name";
    name.textContent = track.name;
    name.title = "雙擊重新命名";
    name.addEventListener("dblclick", (event) => {
      event.stopPropagation();
      const next = prompt("軌道名稱", track.name);
      if (next !== null) {
        try {
          this.workspace.project.setTrackName(track.id, next);
          this.render();
        } catch (error) {
          this.actions.error(error);
        }
      }
    });
    const kind = document.createElement("span");
    kind.className = "track-kind";
    kind.textContent = track.kind === "midi" ? "MIDI" : "音訊";
    top.append(number, name, kind);
    const bottom = document.createElement("div");
    bottom.className = "track-bottom";
    const mute = button(
      "M",
      () => {
        this.workspace.setTrackMuted(track.id, !track.muted);
        this.render();
      },
      "靜音",
    );
    mute.className = `mute ${track.muted ? "on" : ""}`;
    mute.setAttribute("aria-pressed", String(track.muted));
    mute.setAttribute("aria-label", `${track.name} 靜音`);
    const solo = button(
      "S",
      () => {
        this.workspace.setTrackSolo(track.id, !track.solo);
        this.render();
      },
      "獨奏",
    );
    solo.className = `solo ${track.solo ? "on" : ""}`;
    solo.setAttribute("aria-pressed", String(track.solo));
    solo.setAttribute("aria-label", `${track.name} 獨奏`);
    const volume = document.createElement("input");
    volume.type = "range";
    volume.min = "0";
    volume.max = "1.5";
    volume.step = "0.01";
    volume.value = String(track.volume);
    volume.className = "track-volume";
    volume.setAttribute("aria-label", `${track.name} 音量`);
    volume.addEventListener("input", () => {
      this.workspace.setTrackVolume(track.id, Number(volume.value));
      readout.textContent = `${Math.round(Number(volume.value) * 100)}%`;
    });
    const readout = document.createElement("span");
    readout.className = "volume-readout";
    readout.textContent = `${Math.round(track.volume * 100)}%`;
    const more = button(
      "⋯",
      () => {
        this.selectTrack(track.id);
        this.showPanel("device");
      },
      "軌道裝置",
    );
    more.className = "track-menu";
    bottom.append(mute, solo, volume, readout, more);
    control.append(top, bottom);
    control.addEventListener("click", (event) => {
      if ((event.target as HTMLElement).closest("button,input")) return;
      this.selectTrack(track.id);
    });
    return control;
  }

  private clipVisual(clip: ProjectClip, width: number): SVGSVGElement {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "clip-visual");
    svg.setAttribute("viewBox", `0 0 ${Math.max(1, width)} 37`);
    svg.setAttribute("preserveAspectRatio", "none");
    if (clip.kind === "midi") {
      const notes = clip.sequence.getState().notes;
      const high = Math.max(72, ...notes.map((note) => note.pitch));
      const low = Math.min(48, ...notes.map((note) => note.pitch));
      for (const note of notes) {
        const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
        rect.setAttribute("x", String(note.start * this.pixelsPerSecond));
        rect.setAttribute("y", String(4 + ((high - note.pitch) / Math.max(1, high - low)) * 26));
        rect.setAttribute("width", String(Math.max(3, (note.end - note.start) * this.pixelsPerSecond)));
        rect.setAttribute("height", "3.5");
        rect.setAttribute("rx", "1");
        rect.setAttribute("fill", "var(--clip-wave)");
        svg.append(rect);
      }
    } else {
      const peaks = clip.media ? this.requestMediaPeaks(clip) : undefined;
      const samples = clip.media ? peaks?.max : clip.channels[0];
      if (!samples) return svg;
      let fullPeak = 0;
      for (let i = 0; i < samples.length; i += 64) fullPeak = Math.max(fullPeak, Math.abs(samples[i]), Math.abs(peaks?.min[i] ?? 0));
      const scale = Math.max(0.05, fullPeak);
      for (let x = 0; x < Math.min(width, 1000); x += 3) {
        const from = Math.floor((x / width) * samples.length),
          to = Math.max(from + 1, Math.floor(((x + 3) / width) * samples.length));
        let peak = 0;
        for (let i = from; i < Math.min(to, samples.length); i += Math.max(1, Math.floor((to - from) / 64)))
          peak = Math.max(peak, Math.abs(samples[i]), Math.abs(peaks?.min[i] ?? 0));
        const height = Math.max(1, Math.min(34, (peak / scale) * 30));
        const line = document.createElementNS("http://www.w3.org/2000/svg", "rect");
        line.setAttribute("x", String(x));
        line.setAttribute("y", String((37 - height) / 2));
        line.setAttribute("width", "2");
        line.setAttribute("height", String(height));
        line.setAttribute("fill", "var(--clip-wave)");
        svg.append(line);
      }
    }
    return svg;
  }

  private requestMediaPeaks(clip: AudioClip): WaveformPeaks | undefined {
    if (!clip.media) return undefined;
    const cached = this.mediaPeaks.get(clip);
    if (cached) return cached;
    if (!this.pendingPeaks.has(clip)) {
      this.pendingPeaks.add(clip);
      void clip.media
        .peaks(clip.startFrame, clip.frameCount)
        .then((peaks) => {
          this.mediaPeaks.set(clip, peaks);
          this.pendingPeaks.delete(clip);
          if (!this.disposed) this.render();
        })
        .catch((error: unknown) => {
          this.pendingPeaks.delete(clip);
          this.actions.error(error);
        });
    }
    return undefined;
  }

  private clipElement(clip: ProjectClip, track: ProjectTrack): HTMLElement {
    const element = document.createElement("div");
    element.className = `clip ${clip.kind} ${this.selectedClipId === clip.id ? "selected" : ""}`;
    element.dataset.clipId = clip.id;
    element.tabIndex = 0;
    element.setAttribute("role", "button");
    element.setAttribute(
      "aria-label",
      `${track.name} ${clip.kind === "midi" ? "MIDI" : "音訊"}片段，從 ${this.workspace.project.clipTimeSeconds(clip).toFixed(1)} 秒開始；按 Enter 編輯`,
    );
    const startSeconds = this.workspace.project.clipTimeSeconds(clip);
    const width = Math.max(16, (this.workspace.project.clipTimeSeconds(clip, clip.duration) - startSeconds) * this.pixelsPerSecond);
    element.style.left = `${startSeconds * this.pixelsPerSecond}px`;
    element.style.width = `${width}px`;
    const label = document.createElement("div");
    label.className = "clip-label";
    label.textContent = track.name;
    element.append(label, this.clipVisual(clip, width));
    this.clipGestures.push(
      attachClipGesture(element, {
        clipId: clip.id,
        trackId: track.id,
        time: clip.time,
        timeUnit: clip.kind === "midi" ? clip.timeUnit : "seconds",
        timeMap: this.workspace.project.tempoMap,
        pixelsPerSecond: () => this.pixelsPerSecond,
        trackAt: (x, y) => {
          const lane = document.elementsFromPoint(x, y).find((node) => (node as HTMLElement).classList?.contains("lane")) as HTMLElement | undefined;
          return this.workspace.project.tracks.find((item) => item.id === lane?.dataset.trackId && item.kind === clip.kind)?.id;
        },
        onSelect: () => {
          this.selectedTrackId = track.id;
          this.selectedClipId = clip.id;
          if (this.selectedNote?.clipId !== clip.id) this.selectedNote = undefined;
          element.classList.add("selected");
          $("selection-caption").textContent = track.name;
        },
        onOpen: () => {
          this.showPanel("editor");
          this.render();
        },
        onMove: ({ trackId, time }) => {
          const target = this.workspace.project.tracks.find((item) => item.id === trackId)!;
          try {
            this.history.record("移動片段", () => this.workspace.project.moveClip(clip.id, target.id, time));
            this.selectedTrackId = target.id;
            this.actions.status(`Clip 已移至 ${target.name} · ${this.workspace.project.clipTimeSeconds(clip).toFixed(2)} s`);
          } catch (error) {
            this.actions.error(error);
          }
          this.render();
        },
      }),
    );
    return element;
  }

  render(): void {
    const workspace = this.workspace;
    const tracks = workspace.project.tracks;
    if (!tracks.some((track) => track.id === this.selectedTrackId)) this.selectedTrackId = tracks[0]?.id;
    if (!this.selectedClip()) this.selectedClipId = undefined;
    const root = $("tracks");
    const scrollLeft = root.scrollLeft,
      scrollTop = root.scrollTop;
    for (const gesture of this.clipGestures.splice(0)) gesture.destroy();
    root.replaceChildren();
    this.playheads = [];
    const map = workspace.project.tempoMap;
    const beatsPerBar = workspace.project.signature[0];
    const lastMarker = workspace.project.markers.at(-1)?.time ?? 0;
    const lastBeat = Math.ceil(map.secondsToBeat(Math.max(8, workspace.duration, lastMarker)) / beatsPerBar + 2) * beatsPerBar;
    const seconds = map.beatToSeconds(lastBeat);
    const width = Math.ceil(seconds * this.pixelsPerSecond);
    this.rulerWidth = width;
    const gridStyle = (element: HTMLElement) => {
      element.style.width = `${width}px`;
      if (!map.changes.length) {
        const beatWidth = (60 / workspace.project.bpm) * this.pixelsPerSecond;
        element.style.setProperty("--beat-width", `${beatWidth}px`);
        element.style.setProperty("--bar-width", `${beatWidth * beatsPerBar}px`);
        element.style.setProperty("--beat-line", beatWidth < 8 ? "transparent" : "#2b3c48");
        element.style.setProperty("--bar-line", beatWidth * beatsPerBar < 8 ? "transparent" : "#405462");
        return;
      }
      element.classList.add("tempo-grid");
      const steps = [{ beat: 0, bpm: workspace.project.bpm }, ...map.changes];
      steps.forEach((step, index) => {
        const left = map.beatToSeconds(step.beat) * this.pixelsPerSecond;
        const right = index + 1 < steps.length ? map.beatToSeconds(steps[index + 1].beat) * this.pixelsPerSecond : width;
        const beatWidth = (60 / step.bpm) * this.pixelsPerSecond;
        const segment = document.createElement("div");
        segment.className = "tempo-grid-segment";
        segment.style.left = `${left}px`;
        segment.style.width = `${Math.max(0, right - left)}px`;
        segment.style.setProperty("--beat-width", `${beatWidth}px`);
        segment.style.setProperty("--bar-width", `${beatWidth * beatsPerBar}px`);
        segment.style.setProperty("--beat-line", beatWidth < 8 ? "transparent" : "#2b3c48");
        segment.style.setProperty("--bar-line", beatWidth * beatsPerBar < 8 ? "transparent" : "#405462");
        segment.style.setProperty("--beat-phase", `${-step.beat * beatWidth}px`);
        segment.style.setProperty("--bar-phase", `${-step.beat * beatWidth}px`);
        element.append(segment);
      });
    };
    const rulerRow = document.createElement("div");
    rulerRow.className = "timeline-row ruler-row";
    const corner = document.createElement("div");
    corner.className = "track-control ruler-label";
    corner.textContent = "軌道 / 小節";
    const ruler = document.createElement("div");
    ruler.className = "ruler";
    gridStyle(ruler);
    let lastLabelX = -Infinity;
    for (let beat = 0, number = 1; beat < lastBeat; beat += beatsPerBar, number++) {
      const x = map.beatToSeconds(beat) * this.pixelsPerSecond;
      if (x - lastLabelX < 42) continue;
      const label = document.createElement("span");
      label.className = "ruler-mark";
      label.textContent = String(number);
      label.style.left = `${x}px`;
      ruler.append(label);
      lastLabelX = x;
    }
    let scrub: { pointerId: number; startX: number; pausedForDrag: boolean; frame: number | undefined; x: number } | undefined;
    const seekAt = (x: number) => workspace.seek(this.snap(Math.max(0, (x - ruler.getBoundingClientRect().left) / this.pixelsPerSecond)));
    ruler.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      ruler.setPointerCapture(event.pointerId);
      scrub = { pointerId: event.pointerId, startX: event.clientX, pausedForDrag: false, frame: undefined, x: event.clientX };
      seekAt(event.clientX);
    });
    ruler.addEventListener("pointermove", (event) => {
      if (!scrub || event.pointerId !== scrub.pointerId || Math.abs(event.clientX - scrub.startX) < 3) return;
      if (!scrub.pausedForDrag && workspace.clock.state.value === "playing") {
        workspace.pause();
        scrub.pausedForDrag = true;
      }
      scrub.x = event.clientX;
      if (scrub.frame === undefined)
        scrub.frame = requestAnimationFrame(() => {
          if (!scrub) return;
          seekAt(scrub.x);
          scrub.frame = undefined;
        });
    });
    const finishScrub = (event: PointerEvent) => {
      if (!scrub || event.pointerId !== scrub.pointerId) return;
      if (scrub.frame !== undefined) cancelAnimationFrame(scrub.frame);
      seekAt(event.type === "pointercancel" ? scrub.x : event.clientX);
      if (ruler.hasPointerCapture(event.pointerId)) ruler.releasePointerCapture(event.pointerId);
      const resume = scrub.pausedForDrag;
      scrub = undefined;
      if (resume) workspace.play().catch(this.actions.error);
    };
    ruler.addEventListener("pointerup", finishScrub);
    ruler.addEventListener("pointercancel", finishScrub);
    this.addPlayhead(ruler);
    rulerRow.append(corner, ruler);
    root.append(rulerRow);
    const markerRow = document.createElement("div");
    markerRow.className = "timeline-row marker-row";
    const markerCorner = document.createElement("div");
    markerCorner.className = "track-control ruler-label";
    markerCorner.textContent = "段落";
    const markerLane = document.createElement("div");
    markerLane.className = "ruler marker-lane";
    gridStyle(markerLane);
    workspace.project.markers.forEach((marker, index, markers) => {
      const block = document.createElement("div");
      block.className = "marker-block";
      block.textContent = marker.name;
      block.title = "雙擊改名；留空可刪除";
      block.style.left = `${marker.time * this.pixelsPerSecond}px`;
      block.style.width = `${((markers[index + 1]?.time ?? seconds) - marker.time) * this.pixelsPerSecond}px`;
      block.addEventListener("dblclick", (event) => {
        event.stopPropagation();
        const next = prompt("段落名稱（留空刪除）", marker.name);
        if (next === null) return;
        try {
          workspace.project.setMarkers(
            next.trim() ? markers.map((item) => (item === marker ? { ...item, name: next } : item)) : markers.filter((item) => item !== marker),
          );
          this.render();
        } catch (error) {
          this.actions.error(error);
        }
      });
      markerLane.append(block);
    });
    markerLane.addEventListener("dblclick", (event) => {
      if (event.target !== markerLane) return;
      const time = this.snap((event.clientX - markerLane.getBoundingClientRect().left) / this.pixelsPerSecond);
      const name = prompt("新增段落", "New section");
      if (name === null) return;
      try {
        workspace.project.setMarkers([...workspace.project.markers, { time, name }]);
        this.render();
      } catch (error) {
        this.actions.error(error);
      }
    });
    this.addPlayhead(markerLane);
    markerRow.append(markerCorner, markerLane);
    root.append(markerRow);
    tracks.forEach((track, index) => {
      const row = document.createElement("section");
      row.className = "timeline-row";
      row.dataset.trackId = track.id;
      const paletteSlot = [4, 1, 3, 2, 5, 6, 7, 8][index % 8];
      row.style.setProperty("--track-color", `var(--palette-${paletteSlot})`);
      const lane = document.createElement("div");
      lane.className = "lane grid";
      lane.dataset.trackId = track.id;
      gridStyle(lane);
      for (const clip of track.clips) lane.append(this.clipElement(clip, track));
      if (!track.clips.length) {
        const empty = document.createElement("span");
        empty.className = "clip-empty";
        empty.textContent = track.kind === "midi" ? "按「＋ MIDI 片段」建立" : "從瀏覽器匯入音訊";
        lane.append(empty);
      }
      lane.addEventListener("pointerdown", (event) => {
        if (event.target !== lane) return;
        this.selectedTrackId = track.id;
        this.selectedClipId = undefined;
        this.selectedNote = undefined;
        workspace.seek(this.snap((event.clientX - lane.getBoundingClientRect().left) / this.pixelsPerSecond));
        root
          .querySelectorAll<HTMLElement>(".track-control[data-track-id]")
          .forEach((control) => control.classList.toggle("selected", control.dataset.trackId === track.id));
        $("selection-caption").textContent = `${track.name} · 雙擊建立音符片段`;
        $<HTMLButtonElement>("new-midi-clip").disabled = track.kind !== "midi";
        $<HTMLButtonElement>("duplicate").disabled = true;
        $<HTMLButtonElement>("delete").disabled = true;
        for (const id of ["split", "trim-start", "trim-end"]) $<HTMLButtonElement>(id).disabled = true;
        this.renderEditor();
        this.renderMixer();
        this.renderDevices();
      });
      lane.addEventListener("dblclick", (event) => {
        if (track.kind !== "midi" || (event.target as HTMLElement).closest(".clip")) return;
        const time = this.snap((event.clientX - lane.getBoundingClientRect().left) / this.pixelsPerSecond);
        this.addMidiClip(track.id, time);
      });
      this.addPlayhead(lane);
      row.append(this.trackControl(track, index), lane);
      root.append(row);
    });
    root.scrollLeft = scrollLeft;
    root.scrollTop = scrollTop;
    this.renderLoopBand();
    $("project-title").textContent = workspace.project.title;
    $("bpm").textContent = String(workspace.project.bpm);
    $("meter").textContent = workspace.project.signature.join("/");
    $("arrange-summary").textContent = `${tracks.length} 軌 · ${tracks.reduce((count, track) => count + track.clips.length, 0)} 片段`;
    $("duration").textContent = `${workspace.duration.toFixed(1)} s`;
    $("selection-caption").textContent = this.selectedClipId
      ? (this.selectedTrack()?.name ?? "")
      : this.selectedTrackId
        ? `${this.selectedTrack()?.name} · 選取片段`
        : "選取片段開始編輯";
    $<HTMLButtonElement>("duplicate").disabled = !this.selectedClipId;
    $<HTMLButtonElement>("delete").disabled = !this.selectedClipId;
    for (const id of ["split", "trim-start", "trim-end"]) $<HTMLButtonElement>(id).disabled = !this.selectedClipId;
    $<HTMLButtonElement>("new-midi-clip").disabled = this.selectedTrack()?.kind !== "midi";
    this.renderEditor();
    this.renderMixer();
    this.renderDevices();
    this.setPlayhead(workspace.position);
  }

  private addPlayhead(container: HTMLElement): void {
    const line = document.createElement("div");
    line.className = "playhead";
    container.append(line);
    this.playheads.push(line);
  }

  setPlayhead(time: number): void {
    const left = Math.min(this.rulerWidth, Math.max(0, time * this.pixelsPerSecond));
    for (const line of this.playheads) line.style.left = `${left}px`;
    const clip = this.selectedClip();
    const local =
      clip?.kind === "midi" && clip.timeUnit === "beats"
        ? this.workspace.project.tempoMap.secondsToBeat(time) - clip.time
        : time - this.editorClipTime;
    this.clipView?.setPlayhead?.(Math.max(0, local));
  }

  private deleteSelectedNote(): void {
    const clip = this.selectedClip();
    const id = this.selectedNote?.noteId;
    if (clip?.kind !== "midi" || this.selectedNote?.clipId !== clip.id || !id) return;
    const state = clip.sequence.getState();
    if (!state.notes.some((note) => note.id === id)) return;
    this.history.record("刪除音符", () => clip.sequence.setData({ duration: state.duration, notes: state.notes.filter((note) => note.id !== id) }));
    this.selectedNote = undefined;
    this.render();
    this.actions.status("已刪除音符");
  }

  private highlightSelectedNote(mount: HTMLElement): void {
    const id = this.selectedNote?.noteId;
    mount.querySelectorAll<HTMLElement>(".ar-pr-note").forEach((element) => {
      const selected = element.dataset.noteId === id;
      element.classList.toggle("selected", selected);
      element.setAttribute("aria-pressed", String(selected));
    });
  }

  private refreshClipVisual(clip: MidiClip): void {
    const element = Array.from($("tracks").querySelectorAll<HTMLElement>(".clip")).find((item) => item.dataset.clipId === clip.id);
    element
      ?.querySelector(".clip-visual")
      ?.replaceWith(
        this.clipVisual(
          clip,
          Math.max(
            16,
            (this.workspace.project.clipTimeSeconds(clip, clip.duration) - this.workspace.project.clipTimeSeconds(clip)) * this.pixelsPerSecond,
          ),
        ),
      );
  }

  private renderNoteInspector(clip: MidiClip, root: HTMLElement): void {
    root.replaceChildren();
    const note =
      this.selectedNote?.clipId === clip.id ? clip.sequence.getState().notes.find((item) => item.id === this.selectedNote?.noteId) : undefined;
    if (!note) {
      const hint = document.createElement("span");
      hint.textContent = "選取音符後可修改音高、時間與力度；Delete 刪除音符。";
      root.append(hint);
      return;
    }
    const title = document.createElement("strong");
    title.textContent = pitchName(note.pitch);
    root.append(title);
    const field = (
      label: string,
      value: number,
      min: number,
      max: number,
      step: string,
      update: (next: number, current: MidiNote) => Partial<Omit<MidiNote, "id">>,
    ) => {
      const wrapper = document.createElement("label");
      wrapper.textContent = label;
      const input = document.createElement("input");
      input.type = "number";
      input.min = String(min);
      input.max = String(max);
      input.step = step;
      input.value = String(Number(value.toFixed(3)));
      input.setAttribute("aria-label", label);
      input.addEventListener("change", () => {
        const next = input.valueAsNumber;
        if (!Number.isFinite(next) || !input.checkValidity()) {
          this.actions.status(`${label}超出可用範圍。`);
          this.renderNoteInspector(clip, root);
          return;
        }
        try {
          const current = clip.sequence.getState().notes.find((item) => item.id === note.id)!;
          this.history.record("修改音符", () => clip.sequence.updateNote(note.id, update(next, current)));
          const updated = clip.sequence.getState().notes.find((item) => item.id === note.id)!;
          this.refreshClipVisual(clip);
          title.textContent = pitchName(updated.pitch);
          root.querySelector<HTMLInputElement>(`input[aria-label="起點 (${clip.timeUnit === "beats" ? "拍" : "秒"})"]`)!.max = String(
            Math.max(0, clip.duration - (updated.end - updated.start)),
          );
          root.querySelector<HTMLInputElement>(`input[aria-label="長度 (${clip.timeUnit === "beats" ? "拍" : "秒"})"]`)!.max = String(
            clip.duration - updated.start,
          );
          if (updated.pitch < (this.editorPitchRange?.low ?? 0) || updated.pitch > (this.editorPitchRange?.high ?? 127)) this.render();
          this.actions.status(`已更新 ${pitchName(updated.pitch)} 音符`);
        } catch (error) {
          this.actions.error(error);
          this.renderNoteInspector(clip, root);
        }
      });
      wrapper.append(input);
      root.append(wrapper);
    };
    const length = note.end - note.start;
    field("音高", note.pitch, 0, 127, "1", (pitch) => ({ pitch }));
    field(`起點 (${clip.timeUnit === "beats" ? "拍" : "秒"})`, note.start, 0, Math.max(0, clip.duration - length), "0.01", (start, current) => ({
      start,
      end: start + current.end - current.start,
    }));
    field(`長度 (${clip.timeUnit === "beats" ? "拍" : "秒"})`, length, 0.01, clip.duration - note.start, "0.01", (duration, current) => ({
      end: current.start + duration,
    }));
    field("力度", note.velocity, 0, 127, "1", (velocity) => ({ velocity }));
    const remove = button("刪除音符", () => this.deleteSelectedNote());
    remove.className = "note-delete";
    root.append(remove);
  }

  private renderEditor(): void {
    if (this.clipView && this.editorClipId) {
      const view = this.clipView.getViewport();
      if (view.width > 0 && view.duration > 0 && view.pixelsPerSecond > 0)
        this.editorViewStates.set(this.editorClipId, {
          zoom: Math.max(1, (view.pixelsPerSecond * view.duration) / view.width),
          scrollTime: view.scrollLeft / view.pixelsPerSecond,
          amplitudeZoom: this.clipView.getAmplitudeZoom?.() ?? 1,
        });
    }
    this.noteHighlightObserver?.disconnect();
    this.noteHighlightObserver = undefined;
    this.clipView?.destroy();
    this.clipView = undefined;
    this.editorClipId = undefined;
    const root = $("editor-panel");
    root.replaceChildren();
    const clip = this.selectedClip();
    if (!clip) {
      root.innerHTML = '<div class="empty-state"><strong>選取片段</strong><span>下方會顯示音符或波形。</span></div>';
      return;
    }
    this.editorClipTime = this.workspace.project.clipTimeSeconds(clip);
    const trackIndex = this.workspace.project.tracks.findIndex((track) => track.clips.includes(clip));
    const paletteSlot = [4, 1, 3, 2, 5, 6, 7, 8][Math.max(0, trackIndex) % 8];
    root.style.setProperty("--editor-track-color", `var(--palette-${paletteSlot})`);
    const top = document.createElement("div");
    top.className = "editor-top";
    const name = document.createElement("strong");
    name.textContent = clip.kind === "midi" ? "音符" : "波形";
    const meta = document.createElement("span");
    meta.textContent = `${this.workspace.project.clipTimeSeconds(clip).toFixed(2)}–${this.workspace.project.clipTimeSeconds(clip, clip.duration).toFixed(2)} s${clip.kind === "midi" && clip.timeUnit === "beats" ? " · 拍位鎖定" : ""}`;
    const spacer = document.createElement("span");
    spacer.className = "spacer";
    top.append(name, meta, spacer);
    if (clip.kind === "midi") {
      const hint = document.createElement("span");
      hint.className = "editor-hint";
      hint.textContent = "雙擊格線加入音符 · 拖曳音符移動";
      top.insertBefore(hint, spacer);
      top.append(
        button(
          "＋ 加音符",
          () => {
            this.selectedNote = { clipId: clip.id, noteId: this.history.record("新增音符", () => this.actions.addNote(clip)) };
            this.render();
          },
          "在播放位置加入音符",
        ),
      );
    }
    root.append(top);
    const inspector = clip.kind === "midi" ? document.createElement("div") : undefined;
    if (inspector && clip.kind === "midi") {
      inspector.className = "note-inspector";
      root.append(inspector);
      this.renderNoteInspector(clip, inspector);
    }
    const mount = document.createElement("div");
    mount.className = clip.kind === "midi" ? "roll" : "wave";
    root.append(mount);
    if (clip.kind === "midi") {
      const map = this.workspace.project.tempoMap;
      const clipStartBeat = clip.timeUnit === "beats" ? clip.time : map.secondsToBeat(clip.time);
      const clipEndBeat = clip.timeUnit === "beats" ? clip.time + clip.duration : map.secondsToBeat(clip.time + clip.duration);
      const firstBeat = Math.ceil(clipStartBeat);
      const lastBeat = Math.floor(clipEndBeat);
      const beats: number[] = [];
      const downbeats: number[] = [];
      for (let beat = firstBeat; beat <= lastBeat; beat++) {
        const localTime = clip.timeUnit === "beats" ? beat - clip.time : map.beatToSeconds(beat) - clip.time;
        beats.push(localTime);
        if (beat % this.workspace.project.signature[0] === 0) downbeats.push(localTime);
      }
      const grid = {
        beats,
        downbeats,
      };
      const notes = clip.sequence.getState().notes;
      const lowest = notes.length ? Math.min(...notes.map((note) => note.pitch)) : 60;
      const highest = notes.length ? Math.max(...notes.map((note) => note.pitch)) : 72;
      const center = (lowest + highest) / 2;
      const span = Math.max(12, highest - lowest + 3);
      const low = Math.max(0, Math.min(127 - span, Math.floor(center - span / 2)));
      this.editorPitchRange = { low, high: Math.min(127, low + span) };
      this.clipView = mountPianoRoll(mount, {
        model: clip.sequence,
        timeUnit: clip.timeUnit,
        grid,
        snap: "beat",
        pitches: { low, high: Math.min(127, low + span) },
        onNoteEdit: ({ note }) => {
          this.selectedNote = { clipId: clip.id, noteId: note.id };
          this.history.record("拖曳音符", () => clip.sequence.updateNote(note.id, { start: note.start, end: note.end, pitch: note.pitch }));
          requestAnimationFrame(() => this.render());
        },
        onNoteClick: (note) => {
          this.selectedNote = { clipId: clip.id, noteId: note.id };
          this.renderNoteInspector(clip, inspector!);
          this.highlightSelectedNote(mount);
          this.actions.status(
            `${pitchName(note.pitch)} · ${note.start.toFixed(2)} ${clip.timeUnit === "beats" ? "拍" : "s"} · 力度 ${note.velocity}`,
          );
        },
      });
      const drawing = mount.querySelector<HTMLElement>(".ar-pr-notes")!;
      this.noteHighlightObserver = new MutationObserver(() => this.highlightSelectedNote(mount));
      this.noteHighlightObserver.observe(drawing, { childList: true });
      this.highlightSelectedNote(mount);
      const surface = mount.querySelector<HTMLElement>(".ar-pr-surface")!;
      surface.addEventListener("dblclick", (event) => {
        if ((event.target as HTMLElement).closest(".ar-pr-note")) return;
        const rect = surface.getBoundingClientRect();
        const rawTime = clip.duration * Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
        const pitch = Math.max(low, Math.min(low + span, low + span - Math.floor(((event.clientY - rect.top) / rect.height) * (span + 1))));
        this.selectedNote = {
          clipId: clip.id,
          noteId: this.history.record("新增音符", () => {
            const map = this.workspace.project.tempoMap;
            const beat = Math.floor(clip.timeUnit === "beats" ? clip.time + rawTime : map.secondsToBeat(clip.time + rawTime));
            return this.actions.addNote(clip, {
              start: Math.max(0, clip.timeUnit === "beats" ? beat - clip.time : map.beatToSeconds(beat) - clip.time),
              pitch,
            });
          }),
        };
        this.render();
      });
    } else {
      this.editorPitchRange = undefined;
      if (clip.media) {
        const peaks = this.requestMediaPeaks(clip);
        this.clipView = mountWaveform(mount, {
          data: peaks ?? { min: new Float32Array(1), max: new Float32Array(1), duration: clip.duration },
        });
      } else {
        const buffer = this.actions.context.createBuffer(clip.channels.length, clip.channels[0].length, clip.sampleRate);
        clip.channels.forEach((samples, index) => buffer.copyToChannel(new Float32Array(samples), index));
        this.clipView = mountWaveform(mount, { data: buffer });
      }
    }
    const previousView = this.editorViewStates.get(clip.id);
    if (previousView) {
      this.clipView.setZoom(Math.min(clip.kind === "midi" ? 64 : 128, previousView.zoom));
      this.clipView.scrollTo(previousView.scrollTime);
      this.clipView.setAmplitudeZoom?.(previousView.amplitudeZoom);
    }
    const zoom = mount.querySelector<HTMLElement>(".ar-toolbar");
    if (zoom) {
      if (clip.kind === "audio") {
        const label = document.createElement("span");
        label.textContent = "時間";
        zoom.prepend(label);
        zoom.querySelector<HTMLButtonElement>('[data-testid="zoom-in"]')!.setAttribute("aria-label", "放大時間");
        zoom.querySelector<HTMLButtonElement>('[data-testid="zoom-out"]')!.setAttribute("aria-label", "縮小時間");
      }
      top.append(zoom);
    }
    if (clip.kind === "audio") {
      const gain = document.createElement("div");
      gain.className = "wave-amplitude";
      const label = document.createElement("span");
      label.textContent = "波高";
      const readout = document.createElement("span");
      readout.className = "wave-amplitude-value";
      const decrease = button("−", () => changeAmplitude(0.25), "縮小波形高度");
      decrease.dataset.testid = "amplitude-zoom-out";
      decrease.setAttribute("aria-label", "縮小波形高度");
      const increase = button("＋", () => changeAmplitude(4), "放大波形高度");
      increase.dataset.testid = "amplitude-zoom-in";
      increase.setAttribute("aria-label", "放大波形高度");
      const changeAmplitude = (factor: number) => {
        const current = this.clipView?.getAmplitudeZoom?.() ?? 1;
        this.clipView?.setAmplitudeZoom?.(Math.max(1, Math.min(32, current * factor)));
        updateAmplitude();
      };
      const updateAmplitude = () => {
        const current = this.clipView?.getAmplitudeZoom?.() ?? 1;
        readout.textContent = `${current}×`;
        decrease.disabled = current <= 1;
        increase.disabled = current >= 32;
      };
      gain.append(label, decrease, increase, readout);
      top.append(gain);
      updateAmplitude();
    }
    this.editorClipId = clip.id;
  }

  private renderMixer(): void {
    const root = $("mixer-panel");
    root.replaceChildren();
    const mixer = document.createElement("div");
    mixer.className = "mixer";
    for (const track of this.workspace.project.tracks) {
      const strip = document.createElement("div");
      strip.className = `mixer-strip ${track.id === this.selectedTrackId ? "selected" : ""}`;
      const name = document.createElement("span");
      name.className = "strip-name";
      name.textContent = track.name;
      const pan = document.createElement("input");
      pan.type = "range";
      pan.min = "-1";
      pan.max = "1";
      pan.step = "0.01";
      pan.value = String(track.pan);
      pan.setAttribute("aria-label", `${track.name} pan`);
      pan.addEventListener("input", () => this.workspace.setTrackPan(track.id, Number(pan.value)));
      const volume = document.createElement("input");
      volume.type = "range";
      volume.min = "0";
      volume.max = "1.5";
      volume.step = "0.01";
      volume.value = String(track.volume);
      volume.setAttribute("aria-label", `${track.name} mixer 音量`);
      volume.addEventListener("input", () => this.workspace.setTrackVolume(track.id, Number(volume.value)));
      const panLabel = document.createElement("label");
      panLabel.textContent = "PAN";
      panLabel.append(pan);
      const volumeLabel = document.createElement("label");
      volumeLabel.textContent = "VOLUME";
      volumeLabel.append(volume);
      const actions = document.createElement("div");
      actions.className = "strip-actions";
      const mute = button("M", () => {
        this.workspace.setTrackMuted(track.id, !track.muted);
        this.render();
      });
      mute.className = `mute ${track.muted ? "on" : ""}`;
      const solo = button("S", () => {
        this.workspace.setTrackSolo(track.id, !track.solo);
        this.render();
      });
      solo.className = `solo ${track.solo ? "on" : ""}`;
      actions.append(mute, solo);
      strip.append(name, panLabel, volumeLabel, actions);
      mixer.append(strip);
    }
    const master = document.createElement("div");
    master.className = "mixer-strip master";
    master.innerHTML = '<span class="strip-name">MASTER</span><span class="section-label">OUTPUT</span>';
    const masterVolume = document.createElement("input");
    masterVolume.type = "range";
    masterVolume.min = "0";
    masterVolume.max = "1.5";
    masterVolume.step = "0.01";
    masterVolume.value = String(this.workspace.output.gain.value);
    masterVolume.setAttribute("aria-label", "Master 音量");
    masterVolume.addEventListener("input", () =>
      this.workspace.output.gain.setValueAtTime(Number(masterVolume.value), this.actions.context.currentTime),
    );
    master.append(masterVolume);
    mixer.append(master);
    root.append(mixer);
  }

  private renderDevices(): void {
    for (const detach of this.editorDetachers) detach();
    this.editorDetachers.clear();
    const root = $("device-panel");
    root.replaceChildren();
    if (root.classList.contains("hidden") || document.querySelector<HTMLElement>(".studio")!.dataset.lowerOpen !== "true") return;
    const track = this.selectedTrack();
    if (!track) {
      root.innerHTML = '<div class="empty-state"><strong>選取軌道</strong><span>裝置會顯示在這裡。</span></div>';
      return;
    }
    const actions = document.createElement("div");
    actions.className = "device-actions";
    const title = document.createElement("strong");
    title.textContent = track.name;
    const remove = button("刪除軌道", async () => {
      this.clipView?.destroy();
      this.clipView = undefined;
      this.workspace.project.removeTrack(track.id);
      this.history.clear();
      await this.workspace.sync();
      this.selectedTrackId = undefined;
      this.selectedClipId = undefined;
      this.selectedNote = undefined;
      this.render();
      this.actions.status(`已刪除 ${track.name}`);
    });
    actions.append(title, remove);
    root.append(actions);
    if (!track.devices.length) {
      const empty = document.createElement("div");
      empty.className = "empty-state";
      empty.innerHTML = "<strong>這條軌道沒有裝置</strong><span>從左方瀏覽器加入 Oxo Synth2。</span>";
      root.append(empty);
    }
    for (const device of track.devices) {
      const host = this.workspace.host(device.id);
      const details = document.createElement("details");
      details.className = "device-card";
      const summary = document.createElement("summary");
      summary.textContent = `${device.name} · WebCLAP ${host ? "" : "（未載入）"}`;
      details.append(summary);
      if (host?.hasEditor) {
        const frame = document.createElement("iframe");
        frame.title = `${device.name} 編輯器`;
        details.append(frame);
        let detach: (() => void) | undefined;
        details.addEventListener("toggle", async () => {
          if (details.open && !detach) {
            try {
              const mounted = await host.mountEditor(frame);
              if (!details.isConnected || !details.open) mounted();
              else {
                detach = mounted;
                this.editorDetachers.add(mounted);
              }
            } catch (error) {
              this.actions.error(error);
            }
          } else if (!details.open && detach) {
            detach();
            this.editorDetachers.delete(detach);
            detach = undefined;
          }
        });
      }
      root.append(details);
    }
    this.editorDetachers.add(mountEffectRackView(root, this.workspace, track.id, this.actions.error));
  }

  resetProject(): void {
    this.timelineZoom.cancel();
    this.history.clear();
    this.selectedTrackId = undefined;
    this.selectedClipId = undefined;
    this.selectedNote = undefined;
    for (const gesture of this.clipGestures.splice(0)) gesture.destroy();
    this.loopTarget = undefined;
    this.playheads = [];
    this.noteHighlightObserver?.disconnect();
    this.noteHighlightObserver = undefined;
    this.clipView?.destroy();
    this.clipView = undefined;
    this.editorClipId = undefined;
    this.editorViewStates.clear();
    for (const detach of this.editorDetachers) detach();
    this.editorDetachers.clear();
  }

  destroy(): void {
    this.disposed = true;
    this.resetProject();
    this.timelineZoom.destroy();
  }
}
