import type { Readable } from "@audiorective/core";
import type { WaveLoadProgress } from "@audiorective/player";

/** The playback version a selector currently displays. */
export type SelectorVersion = Readonly<{
  revision: number;
  sourceRevision: number;
  /** The committed audio; `duration` is in seconds. */
  buffer: { readonly duration: number };
  peaks: WaveformPeaks;
}>;

/** Selection boundaries in the currently committed buffer's output seconds. */
export type Selection = { start: number; end: number };

/** A snapshot of the selector and its player. Seconds are the committed output buffer's; `error` is the load or playback failure on display. */
export type WaveformSelectorState = {
  duration: number;
  selection: Selection | null;
  position: number;
  isPlaying: boolean;
  isLooping: boolean;
  loading: boolean;
  loadProgress: WaveLoadProgress | null;
  error: string | null;
  processing: boolean;
  stretchRatio: number;
  sourceDuration: number;
  revision: number;
  pixelsPerSecond: number;
};

/** What the selector reads and drives. `WavePlayer` satisfies it; so can any model that exposes these members. The selector follows the cells. */
export interface SelectorPlayer extends SelectionModel {
  readonly output: AudioNode;
  /** Playhead, seconds from the start of the source. */
  readonly position: number;
  /** Length of the source in seconds. */
  readonly duration: number;
  /** The decoded source (`duration` in seconds), or null before it loads. */
  readonly sourceBuffer: { readonly duration: number } | null;
  readonly cells: SelectionModel["cells"] & {
    readonly isLooping: Readable<boolean>;
    readonly isPlaying: Readable<boolean>;
    readonly loading: Readable<boolean>;
    readonly loadProgress: Readable<WaveLoadProgress | null>;
    readonly error: Readable<string | null>;
    readonly processing: Readable<boolean>;
    readonly version: Readable<(SelectorVersion & { readonly ratio: number }) | null>;
    readonly playhead: Readable<unknown>;
  };
  load(source: string | File): Promise<void>;
  cancelLoad(): void;
  play(): Promise<unknown>;
  audition(): Promise<void>;
  pause(): void;
  stop(): void;
  seek(seconds: number): void;
  setLooping(looping: boolean): void;
  sourceToOutput(seconds: number): number;
  dispose(): void;
}

export type WaveformSelectorOptions = (
  | {
      /** The selector creates its own player through this factory, owns it and disposes it. */
      createPlayer: () => SelectorPlayer;
      player?: never;
    }
  | {
      /** Shared player belongs to the caller; disposing a view leaves it alive. */
      player: SelectorPlayer;
      createPlayer?: never;
    }
) & {
  /** Optional initial URL or local file. No audio is loaded when omitted. */
  source?: string | File;
  /** Show source and playback controls; default true. False retains waveform navigation and status. */
  controls?: boolean;
  /** Pointer selections audition and clicks seek/play by default; false selects and seeks without starting playback. */
  audition?: boolean;
  onSelectionChange?: (selection: Selection | null) => void;
  grid?: { beats: number[]; downbeats: number[] };
  /** Replace waveform drawing while retaining the selector's interaction and audio. */
  renderer?: WaveformRenderer;
};

export interface WaveformSelectorHandle extends PluginTarget<TimeViewPluginContext> {
  /** Settles after the initial load; resolves immediately without an initial source. */
  readonly ready: Promise<void>;
  readonly output: AudioNode;
  /** Current geometry in output seconds and CSS pixels. */
  getViewport(): WaveformViewport;
  /** A factor of 1 fits the source; preserves the viewport center. */
  setZoom(factor: number): void;
  /** Visual waveform height, 1x to 32x; audio remains unchanged. */
  setAmplitudeZoom(factor: number): void;
  getAmplitudeZoom(): number;
  /** Scroll this view to output seconds. */
  scrollTo(seconds: number): void;
  /** Replace the source. Only the latest request may update the widget. */
  load(source: string | File): Promise<void>;
  cancelLoad(): void;
  setSelection(selection: Selection | null): void;
  getState(): WaveformSelectorState;
  dispose(): void;
}

export type MountWaveformSelector = (root: HTMLElement, options: WaveformSelectorOptions) => WaveformSelectorHandle;

/** Extrema per bin, shared across channels. Arrays are copied on setData(). `duration` is the span they cover, in seconds. */
export type WaveformPeaks = {
  min: Float32Array;
  max: Float32Array;
  duration: number;
};
/** Peaks with their `duration` in seconds, or an AudioBuffer. */
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
  dispose?(): void;
}
/** Mount drawing once. The widget owns the container and calls dispose on cleanup. */
export type WaveformRenderer = (container: HTMLElement) => WaveformRendererInstance;
/** The visible window: `duration` is the full length in seconds; scroll and zoom are in pixels. */
export type WaveformViewport = Readonly<{
  duration: number;
  pixelsPerSecond: number;
  scrollLeft: number;
  width: number;
  height: number;
}>;
export type Unsubscribe = () => void;

/** Resources registered by a plugin are released when its attachment is disposed. */
export interface WidgetPluginContext {
  /** Registers a listener for the lifetime of the plugin attachment. */
  listen(target: EventTarget, type: string, listener: EventListener): Unsubscribe;
  /** Runs immediately if its attachment has already been disposed. */
  onCleanup(dispose: Unsubscribe): Unsubscribe;
}

export interface WidgetPlugin<Context extends WidgetPluginContext = WidgetPluginContext> {
  attach: (context: Context) => { dispose(): void } | Unsubscribe | void;
}
export interface PluginAttachment {
  dispose(): void;
}
export interface PluginTarget<Context extends WidgetPluginContext> {
  /** Mount an extension and return a handle that can detach it independently. */
  attach(plugin: WidgetPlugin<Context>): PluginAttachment;
}

/** Compatibility interface. Use TimeViewPluginContext to read the time unit. */
export interface WaveformPluginContext extends WidgetPluginContext {
  readonly surface: HTMLElement;
  /** Length of the displayed data in seconds. */
  readonly duration: number;
  getViewport(): WaveformViewport;
  /** Pixel x of view `time` (seconds). */
  timeToX(time: number): number;
  clientXToTime(clientX: number): number;
  scrollBy(pixels: number): void;
  getViewportRect(): DOMRect;
  /** Mount a full-size overlay; position children using timeToX(). */
  mountOverlay(element: HTMLElement): Unsubscribe;
  onViewportChange(listener: (viewport: WaveformViewport) => void): Unsubscribe;
  /** Calls `listener` with the new data length in seconds whenever the data changes. */
  onDataChange(listener: (duration: number) => void): Unsubscribe;
}
/** Times use the view's unit. The horizontal coordinate is in scrolling content pixels. */
export interface TimeViewPluginContext extends WaveformPluginContext {
  readonly timeUnit: "seconds" | "beats";
}
export type TimeViewPlugin = WidgetPlugin<TimeViewPluginContext>;
export interface WaveformPlugin {
  attach(context: WaveformPluginContext): { dispose(): void } | Unsubscribe | void;
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
  /** Moves the external playhead to `seconds` in the view, or hides it with null. */
  setPlayhead(seconds: number | null): void;
  getViewport(): WaveformViewport;
  /** A factor of 1 fits the entire source; zoom preserves the viewport center. */
  setZoom(factor: number): void;
  /** Visual waveform height only, from 1× to 32×; audio and cached peaks are unchanged. */
  setAmplitudeZoom(factor: number): void;
  getAmplitudeZoom(): number;
  scrollTo(seconds: number): void;
  dispose(): void;
}

export type SnapMode = "off" | "beat" | "downbeat";
export type SelectionCommit = Readonly<{
  selection: Selection | null;
  kind: "pointer" | "keyboard" | "programmatic" | "click";
  /** Seconds in the view where a `click` landed; absent for other kinds. */
  time?: number;
}>;
export type SelectionPluginOptions = {
  /** Borrowed committed owner; drags preview locally and write once on release. Detaching leaves it intact. */
  model?: SelectionModel;
  grid?: { beats: number[]; downbeats: number[] };
  snap?: SnapMode;
  /** Displayed selection, including local preview and cancellation; not an owner commit. */
  onChange?: (selection: Selection | null) => void;
  onCommit?: (event: SelectionCommit) => void;
};
export interface SelectionModel {
  /** The committed selection as a cell (`WavePlayer.cells.selection`); the plugin follows it and never mutates what it reads. */
  readonly cells: { readonly selection: Readable<Readonly<Selection> | null> };
  setSelection(selection: Selection | null): void;
}
export interface SelectionPlugin extends WaveformPlugin {
  /** Displayed selection, including a local drag preview; the borrowed model remains committed. */
  getSelection(): Selection | null;
  setSelection(selection: Selection | null): void;
  setSnap(mode: SnapMode): void;
  setGrid(grid: { beats: number[]; downbeats: number[] }): void;
}
