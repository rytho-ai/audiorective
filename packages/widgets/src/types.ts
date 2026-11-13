import type { WavePlayer, WavePlayerState } from "@audiorective/blocks";

/** Selection boundaries in the currently committed buffer's output seconds. */
export type Selection = { start: number; end: number };

export type WaveformSelectorState = WavePlayerState & {
  pixelsPerSecond: number;
};

export type WaveformSelectorOptions = (
  | {
      /** The caller owns this context and connects the returned output. */
      context: AudioContext;
      player?: never;
    }
  | {
      /** Shared player belongs to the caller; destroying a view leaves it alive. */
      player: WavePlayer;
      context?: never;
    }
) & {
  /** Optional initial URL or local file. No audio is loaded when omitted. */
  source?: string | File;
  onSelectionChange?: (selection: Selection | null) => void;
  grid?: { beats: number[]; downbeats: number[] };
  /** Replace waveform drawing while retaining the selector's interaction and audio. */
  renderer?: WaveformRenderer;
};

export interface WaveformSelectorHandle {
  /** Settles after the initial load; resolves immediately without an initial source. */
  readonly ready: Promise<void>;
  readonly output: AudioNode;
  /** Replace the source. Only the latest request may update the widget. */
  load(source: string | File): Promise<void>;
  cancelLoad(): void;
  setSelection(selection: Selection | null): void;
  getState(): WaveformSelectorState;
  destroy(): void;
}

export type MountWaveformSelector = (root: HTMLElement, options: WaveformSelectorOptions) => WaveformSelectorHandle;

/** Extrema per bin, shared across channels. Arrays are copied on setData(). */
export type WaveformPeaks = {
  min: Float32Array;
  max: Float32Array;
  duration: number;
};
export type WaveformData = { peaks: Float32Array; duration: number } | WaveformPeaks | AudioBuffer;
/** Drawing uses the full scrolling content in CSS pixels, with a linear time axis. */
export type WaveformRenderFrame = Readonly<{
  /** Cached extrema across channels; null clears the drawing. Treat arrays as read-only. */
  peaks: Readonly<WaveformPeaks> | null;
  width: number;
  height: number;
  pixelsPerSecond: number;
}>;
export interface WaveformRendererInstance {
  render(frame: WaveformRenderFrame): void;
  destroy?(): void;
}
/** Mount drawing once. The widget owns the container and calls destroy on cleanup. */
export type WaveformRenderer = (container: HTMLElement) => WaveformRendererInstance;
export type WaveformViewport = Readonly<{
  duration: number;
  pixelsPerSecond: number;
  scrollLeft: number;
  width: number;
  height: number;
}>;
export type Unsubscribe = () => void;

/** Coordinates use content pixels inside the scrolling waveform. */
export interface WaveformPluginContext {
  readonly surface: HTMLElement;
  readonly duration: number;
  getViewport(): WaveformViewport;
  timeToX(seconds: number): number;
  clientXToTime(clientX: number): number;
  scrollBy(pixels: number): void;
  getViewportRect(): DOMRect;
  /** Mount a full-size overlay; position children using timeToX(). */
  mountOverlay(element: HTMLElement): Unsubscribe;
  onViewportChange(listener: (viewport: WaveformViewport) => void): Unsubscribe;
  onDataChange(listener: (duration: number) => void): Unsubscribe;
  /** Registrations are removed when this attachment is destroyed. */
  listen(target: EventTarget, type: string, listener: EventListener): Unsubscribe;
  /** Late registrations run immediately after attachment destruction. */
  onCleanup(dispose: Unsubscribe): Unsubscribe;
}
export interface WaveformPlugin {
  attach(context: WaveformPluginContext): { destroy(): void } | Unsubscribe | void;
}
export interface PluginAttachment {
  destroy(): void;
}
export type WaveformOptions = {
  data?: WaveformData;
  playhead?: number | null;
  label?: string;
  renderer?: WaveformRenderer;
};
export interface WaveformHandle {
  /** Replace the data and reset zoom, scroll and plugin selections. */
  setData(data: WaveformData | null): void;
  setPlayhead(seconds: number | null): void;
  getViewport(): WaveformViewport;
  /** A factor of 1 fits the entire source; zoom preserves the viewport center. */
  setZoom(factor: number): void;
  scrollTo(seconds: number): void;
  attach(plugin: WaveformPlugin): PluginAttachment;
  destroy(): void;
}

export type SnapMode = "off" | "beat" | "downbeat";
export type SelectionCommit = Readonly<{
  selection: Selection | null;
  kind: "pointer" | "keyboard" | "programmatic" | "click";
  time?: number;
}>;
export type SelectionPluginOptions = {
  /** Optional headless owner. Detaching the view does not clear this model. */
  model?: SelectionModel;
  grid?: { beats: number[]; downbeats: number[] };
  snap?: SnapMode;
  onChange?: (selection: Selection | null) => void;
  onCommit?: (event: SelectionCommit) => void;
};
export interface SelectionModel {
  getSelection(): Selection | null;
  setSelection(selection: Selection | null): void;
  subscribe(listener: () => void): Unsubscribe;
}
export interface SelectionPlugin extends WaveformPlugin {
  getSelection(): Selection | null;
  setSelection(selection: Selection | null): void;
  setSnap(mode: SnapMode): void;
  setGrid(grid: { beats: number[]; downbeats: number[] }): void;
}
