import type { WavePlayerState } from "@audiorective/player";

/** The playback version a selector currently displays. */
export type SelectorVersion = Readonly<{ revision: number; sourceRevision: number; buffer: { readonly duration: number }; peaks: WaveformPeaks }>;

/** Selection boundaries in the currently committed buffer's output seconds. */
export type Selection = { start: number; end: number };

export type WaveformSelectorState = WavePlayerState & {
  pixelsPerSecond: number;
};

/**
 * What the selector reads and drives. `WavePlayer` satisfies it; so can any model that exposes these members.
 * `version`, `isPlaying` and `isLooping` are read inside `subscribe` notifications.
 */
export interface SelectorPlayer extends SelectionModel {
  readonly output: AudioNode;
  readonly version: SelectorVersion | null;
  readonly isPlaying: boolean;
  readonly isLooping: boolean;
  getState(): WavePlayerState;
  load(source: string | File): Promise<void>;
  cancelLoad(): void;
  play(): Promise<unknown>;
  audition(): Promise<void>;
  pause(): void;
  stop(): void;
  seek(seconds: number): void;
  setLooping(looping: boolean): void;
  sourceToOutput(seconds: number): number;
  destroy(): void;
}

export type WaveformSelectorOptions = (
  | {
      /** The selector creates its own player through this factory, owns it and destroys it. */
      createPlayer: () => SelectorPlayer;
      player?: never;
    }
  | {
      /** Shared player belongs to the caller; destroying a view leaves it alive. */
      player: SelectorPlayer;
      createPlayer?: never;
    }
) & {
  /** Optional initial URL or local file. No audio is loaded when omitted. */
  source?: string | File;
  onSelectionChange?: (selection: Selection | null) => void;
  grid?: { beats: number[]; downbeats: number[] };
  /** Replace waveform drawing while retaining the selector's interaction and audio. */
  renderer?: WaveformRenderer;
};

export interface WaveformSelectorHandle extends PluginTarget<TimeViewPluginContext> {
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
  /** Display gain for waveform height; PCM and cached peaks remain unchanged. */
  amplitudeZoom: number;
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

/** Resources registered by a plugin are released when its attachment is destroyed. */
export interface WidgetPluginContext {
  /** Registers a listener for the lifetime of the plugin attachment. */
  listen(target: EventTarget, type: string, listener: EventListener): Unsubscribe;
  /** Runs immediately if its attachment has already been destroyed. */
  onCleanup(dispose: Unsubscribe): Unsubscribe;
}

export interface WidgetPlugin<Context extends WidgetPluginContext = WidgetPluginContext> {
  attach: (context: Context) => { destroy(): void } | Unsubscribe | void;
}
export interface PluginAttachment {
  destroy(): void;
}
export interface PluginTarget<Context extends WidgetPluginContext> {
  /** Mount an extension and return a handle that can detach it independently. */
  attach(plugin: WidgetPlugin<Context>): PluginAttachment;
}

/** Compatibility interface. Use TimeViewPluginContext to read the time unit. */
export interface WaveformPluginContext extends WidgetPluginContext {
  readonly surface: HTMLElement;
  readonly duration: number;
  getViewport(): WaveformViewport;
  timeToX(time: number): number;
  clientXToTime(clientX: number): number;
  scrollBy(pixels: number): void;
  getViewportRect(): DOMRect;
  /** Mount a full-size overlay; position children using timeToX(). */
  mountOverlay(element: HTMLElement): Unsubscribe;
  onViewportChange(listener: (viewport: WaveformViewport) => void): Unsubscribe;
  onDataChange(listener: (duration: number) => void): Unsubscribe;
}
/** Times use the view's unit. The horizontal coordinate is in scrolling content pixels. */
export interface TimeViewPluginContext extends WaveformPluginContext {
  readonly timeUnit: "seconds" | "beats";
}
export type TimeViewPlugin = WidgetPlugin<TimeViewPluginContext>;
export interface WaveformPlugin {
  attach(context: WaveformPluginContext): { destroy(): void } | Unsubscribe | void;
}
export type WaveformOptions = {
  data?: WaveformData;
  playhead?: number | null;
  label?: string;
  renderer?: WaveformRenderer;
};
export interface WaveformHandle extends PluginTarget<TimeViewPluginContext> {
  /** Replace the data and reset zoom, scroll and plugin selections. */
  setData(data: WaveformData | null): void;
  setPlayhead(seconds: number | null): void;
  getViewport(): WaveformViewport;
  /** A factor of 1 fits the entire source; zoom preserves the viewport center. */
  setZoom(factor: number): void;
  /** Visual waveform height only, from 1× to 32×; audio and cached peaks are unchanged. */
  setAmplitudeZoom(factor: number): void;
  getAmplitudeZoom(): number;
  scrollTo(seconds: number): void;
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
