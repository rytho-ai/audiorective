import type { Readable } from "@audiorective/core";
import type { WaveLoadProgress } from "@audiorective/player";

/** The playback version a selector currently displays. */
export type SelectorVersion = Readonly<{
  /** Committed playback revision; changes when a load or processing result is adopted. */
  revision: number;
  /** Original-source revision; retained across stretches of the same source. */
  sourceRevision: number;
  /** The committed audio; `duration` is in seconds. */
  buffer: {
    /** Committed output-buffer extent in seconds. */
    readonly duration: number;
  };
  /** Peak summary aligned to the committed output buffer. */
  peaks: WaveformPeaks;
}>;

/** Selection boundaries in the currently committed buffer's output seconds. */
export type Selection = {
  /** Inclusive selection boundary in the owning view's units: seconds or quarter-note beats. */
  start: number;
  /** Exclusive selection boundary in the owning view's units: seconds or quarter-note beats. */
  end: number;
};

/** A snapshot of the selector and its player. Seconds are the committed output buffer's; `error` is the load or playback failure on display. */
export type WaveformSelectorState = {
  /** Committed playback-buffer extent in output seconds. */
  duration: number;
  /** Half-open selected output-seconds range; null means no selection. */
  selection: Selection | null;
  /** Current playhead position in committed output seconds. */
  position: number;
  /** Whether playback is active, including a queued future start. */
  isPlaying: boolean;
  /** Whether playback repeats the selection or full committed buffer. */
  isLooping: boolean;
  /** Whether source loading is in progress. */
  loading: boolean;
  /** Current loading phase and byte progress; null when no load is active. */
  loadProgress: WaveLoadProgress | null;
  /** Latest player failure text; null when no error is recorded. */
  error: string | null;
  /** Whether an output-buffer stretch is in progress. */
  processing: boolean;
  /** Positive output-duration / source-duration factor; 1 preserves duration. */
  stretchRatio: number;
  /** Original unstretched source extent in seconds. */
  sourceDuration: number;
  /** Committed playback revision, used to reject stale rendered data. */
  revision: number;
  /** Positive horizontal scale in CSS pixels per output second. */
  pixelsPerSecond: number;
};

/** What the selector reads and drives. `WavePlayer` satisfies it; so can any model that exposes these members. The selector follows the cells. */
export interface SelectorPlayer extends SelectionModel {
  /** Borrowed audio output for caller-owned routing; the view does not own its connections. */
  readonly output: AudioNode;
  /** Playhead, seconds from the start of the source. */
  readonly position: number;
  /** Length of the source in seconds. */
  readonly duration: number;
  /** The decoded source (`duration` in seconds), or null before it loads. */
  readonly sourceBuffer: {
    /** Original unstretched audio-buffer extent in source seconds. */
    readonly duration: number;
  } | null;
  /** Borrowed reactive player state; the widget observes changes and invokes player commands. */
  readonly cells: SelectionModel["cells"] & {
    /** Whether the selection or full buffer repeats; false disables looping. */
    readonly isLooping: Readable<boolean>;
    /** Whether playback is active, including a queued future start. */
    readonly isPlaying: Readable<boolean>;
    /** Whether source loading is in progress. */
    readonly loading: Readable<boolean>;
    /** Current loading phase and byte counts; null when no load is active. */
    readonly loadProgress: Readable<WaveLoadProgress | null>;
    /** Latest failure text; null when no error is recorded. */
    readonly error: Readable<string | null>;
    /** Whether an output-buffer stretch is in progress. */
    readonly processing: Readable<boolean>;
    /** Committed playback snapshot; null while no audio version is available. */
    readonly version: Readable<
      | (SelectorVersion & {
          /** Positive output-duration / original-duration factor; 1 preserves duration. */
          readonly ratio: number;
        })
      | null
    >;
    /** Observable playback-anchor changes; used to refresh the independently derived position. */
    readonly playhead: Readable<unknown>;
  };
  /** Loads a URL or file asynchronously; replaces the committed audio on success. */
  load(source: string | File): Promise<void>;
  /** Aborts the current load and discards its pending result. */
  cancelLoad(): void;
  /** Starts committed audio playback; resolves after the player's start operation. */
  play(): Promise<unknown>;
  /** Previews the selected output-seconds range without changing the committed source. */
  audition(): Promise<void>;
  /** Holds playback at its current output-seconds position. */
  pause(): void;
  /** Stops playback and returns the playhead to the player's start boundary. */
  stop(): void;
  /** Moves the playhead to the requested committed output-seconds position. */
  seek(seconds: number): void;
  /** Enables or disables repeated playback of the selection or full buffer. */
  setLooping(looping: boolean): void;
  /** Maps original source seconds to committed output seconds after stretching. */
  sourceToOutput(seconds: number): number;
  /** Releases resources owned by this attachment or view; safe to call twice. */
  dispose(): void;
}

export type WaveformSelectorOptions = (
  | {
      /** The selector creates its own player through this factory, owns it and disposes it. */
      createPlayer: () => SelectorPlayer;
      /** Excluded when createPlayer is supplied; this variant requires a player factory. */
      player?: never;
    }
  | {
      /** Shared player belongs to the caller; disposing a view leaves it alive. */
      player: SelectorPlayer;
      /** Excluded when player is supplied; this variant borrows the supplied player. */
      createPlayer?: never;
    }
) & {
  /** Optional initial URL or local file. No audio is loaded when omitted. */
  source?: string | File;
  /** Show source and playback controls; default true. False retains waveform navigation and status. */
  controls?: boolean;
  /** Pointer selections audition and clicks seek/play by default; false selects and seeks without starting playback. */
  audition?: boolean;
  /** Optional callback for half-open output-seconds selections; null clears the selection. */
  onSelectionChange?: (selection: Selection | null) => void;
  /** Optional output-seconds positions for beat and downbeat guides. */
  grid?: {
    /** Beat-guide positions in output seconds; an empty array draws no guides. */
    beats: number[];
    /** Bar-boundary guide positions in output seconds; an empty array draws no guides. */
    downbeats: number[];
  };
  /** Replace waveform drawing while retaining the selector's interaction and audio. */
  renderer?: WaveformRenderer;
};

export interface WaveformSelectorHandle extends PluginTarget<TimeViewPluginContext> {
  /** Settles after the initial load; resolves immediately without an initial source. */
  readonly ready: Promise<void>;
  /** Player audio output for caller-owned routing; connecting it is the caller's responsibility. */
  readonly output: AudioNode;
  /** Current geometry in output seconds and CSS pixels. */
  getViewport(): WaveformViewport;
  /** A factor of 1 fits the source; preserves the viewport center. */
  setZoom(factor: number): void;
  /** Visual waveform height, 1x to 32x; audio remains unchanged. */
  setAmplitudeZoom(factor: number): void;
  /** Returns the positive display-only linear waveform magnification; 1 is the base scale. */
  getAmplitudeZoom(): number;
  /** Scroll this view to output seconds. */
  scrollTo(seconds: number): void;
  /** Replace the source. Only the latest request may update the widget. */
  load(source: string | File): Promise<void>;
  /** Aborts the player's current load and discards its pending result. */
  cancelLoad(): void;
  /** Commits a half-open output-seconds range; null clears the selection. */
  setSelection(selection: Selection | null): void;
  /** Returns the latest player and view snapshot; audio positions use output seconds. */
  getState(): WaveformSelectorState;
  /** Releases resources owned by this attachment or view; safe to call twice. */
  dispose(): void;
}

export type MountWaveformSelector = (root: HTMLElement, options: WaveformSelectorOptions) => WaveformSelectorHandle;

/** Extrema per bin, shared across channels. Arrays are copied on setData(). `duration` is the span they cover, in seconds. */
export type WaveformPeaks = {
  /** Lowest linear sample value per visible peak bucket. */
  min: Float32Array;
  /** Highest linear sample value per visible peak bucket. */
  max: Float32Array;
  /** Source extent represented by these peak arrays, in seconds. */
  duration: number;
};
/** Peaks with their `duration` in seconds, or an AudioBuffer. */
export type WaveformData =
  | {
      /** Per-bin linear peak magnitudes, ordered along the source time axis. */
      peaks: Float32Array;
      /** Source extent represented by the peak array, in seconds. */
      duration: number;
    }
  | WaveformPeaks
  | AudioBuffer;
/** Drawing uses the full scrolling content in CSS pixels, with a linear time axis. */
export type WaveformRenderFrame = Readonly<{
  /** Cached extrema across channels; null clears the drawing. Treat arrays as read-only. */
  peaks: Readonly<WaveformPeaks> | null;
  /** Drawing-coordinate width in pixels; the host may scale it for devicePixelRatio. */
  width: number;
  /** Drawing-coordinate height in pixels; the host may scale it for devicePixelRatio. */
  height: number;
  /** Drawing pixels per source second, following the host's drawing resolution. */
  pixelsPerSecond: number;
  /** Display gain for waveform height; PCM and cached peaks remain unchanged. */
  amplitudeZoom: number;
}>;
export interface WaveformRendererInstance {
  /** Draws the supplied waveform frame; pixel dimensions follow the host's drawing resolution and time is seconds. */
  render(frame: WaveformRenderFrame): void;
  /** Releases resources owned by this attachment or view; safe to call twice. */
  dispose?(): void;
}
/** Mount drawing once. The widget owns the container and calls dispose on cleanup. */
export type WaveformRenderer = (container: HTMLElement) => WaveformRendererInstance;
/** The visible window: `duration` is the full length in seconds; scroll and zoom are in pixels. */
export type WaveformViewport = Readonly<{
  /** Content extent in the owning view's time unit: seconds, or quarter-note beats for piano rolls. */
  duration: number;
  /** CSS pixels per owning-view time unit; piano rolls report pixels per quarter-note beat. */
  pixelsPerSecond: number;
  /** Horizontal scroll offset in CSS pixels. */
  scrollLeft: number;
  /** Visible viewport width in CSS pixels. */
  width: number;
  /** Visible viewport height in CSS pixels. */
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
  /** Mounts into a borrowed context; may return a cleanup function or disposable attachment. */
  attach: (context: Context) =>
    | {
        /** Releases resources owned by this attachment or view; safe to call twice. */
        dispose(): void;
      }
    | Unsubscribe
    | void;
}
export interface PluginAttachment {
  /** Releases resources owned by this attachment or view; safe to call twice. */
  dispose(): void;
}
export interface PluginTarget<Context extends WidgetPluginContext> {
  /** Mount an extension and return a handle that can detach it independently. */
  attach(plugin: WidgetPlugin<Context>): PluginAttachment;
}

/** Compatibility interface. Use TimeViewPluginContext to read the time unit. */
export interface WaveformPluginContext extends WidgetPluginContext {
  /** Borrowed drawing/gesture surface; plugin cleanup must leave the host surface intact. */
  readonly surface: HTMLElement;
  /** Length of the displayed data in seconds. */
  readonly duration: number;
  /** Returns the current view extent, scroll offset and horizontal time scale. */
  getViewport(): WaveformViewport;
  /** Pixel x of view `time` (seconds). */
  timeToX(time: number): number;
  /** Maps client-space CSS pixels to seconds, or quarter-note beats in a beat view. */
  clientXToTime(clientX: number): number;
  /** Moves the horizontal viewport by the supplied CSS-pixel delta. */
  scrollBy(pixels: number): void;
  /** Returns viewport bounds in client-space CSS pixels. */
  getViewportRect(): DOMRect;
  /** Mount a full-size overlay; position children using timeToX(). */
  mountOverlay(element: HTMLElement): Unsubscribe;
  /** Subscribes to viewport changes; returns a function that stops listening. */
  onViewportChange(listener: (viewport: WaveformViewport) => void): Unsubscribe;
  /** Calls `listener` with the new data length in seconds whenever the data changes. */
  onDataChange(listener: (duration: number) => void): Unsubscribe;
}
/** Times use the view's unit. The horizontal coordinate is in scrolling content pixels. */
export interface TimeViewPluginContext extends WaveformPluginContext {
  /** Coordinate unit for plugin positions; seconds for waveforms, quarter-note beats for piano rolls. */
  readonly timeUnit: "seconds" | "beats";
}
export type TimeViewPlugin = WidgetPlugin<TimeViewPluginContext>;
export interface WaveformPlugin {
  /** Mounts into a borrowed view context; may return a cleanup function or disposable attachment. */
  attach(context: WaveformPluginContext):
    | {
        /** Releases resources owned by this attachment or view; safe to call twice. */
        dispose(): void;
      }
    | Unsubscribe
    | void;
}
export type WaveformOptions = {
  /** Optional source buffer or peak data; omitted to mount an initially empty view. */
  data?: WaveformData;
  /** Initial source-seconds cursor; null or omission hides it. */
  playhead?: number | null;
  /** Accessible waveform caption; defaults to "Waveform". */
  label?: string;
  /** Optional drawing factory; omitted to use the built-in waveform renderer. */
  renderer?: WaveformRenderer;
};
export interface WaveformHandle extends PluginTarget<TimeViewPluginContext> {
  /** Replace the data and reset zoom, scroll and plugin selections. */
  setData(data: WaveformData | null): void;
  /** Moves the external playhead to `seconds` in the view, or hides it with null. */
  setPlayhead(seconds: number | null): void;
  /** Returns the current second-based view extent, scroll and CSS-pixel scale. */
  getViewport(): WaveformViewport;
  /** A factor of 1 fits the entire source; zoom preserves the viewport center. */
  setZoom(factor: number): void;
  /** Visual waveform height only, from 1× to 32×; audio and cached peaks are unchanged. */
  setAmplitudeZoom(factor: number): void;
  /** Returns positive display-only linear waveform magnification; 1 is the base scale. */
  getAmplitudeZoom(): number;
  /** Moves the left viewport edge to the requested source-seconds position. */
  scrollTo(seconds: number): void;
  /** Releases resources owned by this attachment or view; safe to call twice. */
  dispose(): void;
}

export type SnapMode = "off" | "beat" | "downbeat";
export type SelectionCommit = Readonly<{
  /** Committed half-open range in the owning view's time unit; null clears selection. */
  selection: Selection | null;
  /** Input path that produced the commit; programmatic changes are explicitly identified. */
  kind: "pointer" | "keyboard" | "programmatic" | "click";
  /** Seconds in the view where a `click` landed; absent for other kinds. */
  time?: number;
}>;
export type SelectionPluginOptions = {
  /** Borrowed committed owner; drags preview locally and write once on release. Detaching leaves it intact. */
  model?: SelectionModel;
  /** Optional beat/downbeat guides in the owning view's time unit. */
  grid?: {
    /** Beat-guide positions in the owning view's time unit; an empty array draws no guides. */
    beats: number[];
    /** Bar-boundary guide positions in the owning view's time unit; an empty array draws no guides. */
    downbeats: number[];
  };
  /** Initial snapping rule; defaults to "off". */
  snap?: SnapMode;
  /** Displayed selection, including local preview and cancellation; not an owner commit. */
  onChange?: (selection: Selection | null) => void;
  /** Optional notification after a selection gesture commits; null selection means cleared. */
  onCommit?: (event: SelectionCommit) => void;
};
export interface SelectionModel {
  /** The committed selection as a cell (`WavePlayer.cells.selection`); the plugin follows it and never mutates what it reads. */
  readonly cells: {
    /** Reactive half-open selection in the owning view's time unit; null means none. */
    readonly selection: Readable<Readonly<Selection> | null>;
  };
  /** Commits a half-open range in the model's time unit; null clears it. */
  setSelection(selection: Selection | null): void;
}
export interface SelectionPlugin extends WaveformPlugin {
  /** Displayed selection, including a local drag preview; the borrowed model remains committed. */
  getSelection(): Selection | null;
  /** Sets a half-open view-time range; null clears it. */
  setSelection(selection: Selection | null): void;
  /** Replaces the gesture-snapping rule; "off" disables snapping. */
  setSnap(mode: SnapMode): void;
  /** Replaces beat/downbeat guides in the owning view's time unit. */
  setGrid(grid: {
    /** Beat-guide positions in the owning view's time unit; an empty array draws no guides. */
    beats: number[];
    /** Bar-boundary guide positions in the owning view's time unit; an empty array draws no guides. */
    downbeats: number[];
  }): void;
}
