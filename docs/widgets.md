---
title: Widgets
---

Try the [waveform showroom](/showroom/waveform) for a working selector, or the [piano-roll showroom](/showroom/piano-roll) for shared MIDI views. See [MIDI and Piano Roll](./midi.md) for `mountPianoRoll` from the audio-independent `@audiorective/widgets/piano-roll` entry.

`@audiorective/widgets` provides browser DOM widgets that mount into an element and return an imperative handle. Use `mountWaveformSelector` for loading audio, selecting a range, and auditioning it. Use the audio-independent `@audiorective/widgets/waveform` entry for a waveform driven by your own data and playback position.

The widgets implement their own waveform display and interaction. They require no UI framework or WaveSurfer dependency. The selector uses [WavePlayer](./blocks.md) for audio and selection. Pass a shared `player`, or supply `context` to let the selector own one. Its public audio connection is `handle.output`.

## Mount a selector

```typescript
import { mountWaveformSelector } from "@audiorective/widgets";

const context = new AudioContext(); // or pass your app's existing context
const root = document.querySelector<HTMLElement>("#waveform")!;
const selector = mountWaveformSelector(root, {
  context,
  source: "/audio/loop.wav", // optional; also accepts a File
  onSelectionChange(selection) {
    console.log(selection); // { start, end } in committed output seconds, or null
  },
});
selector.output.connect(context.destination);

try {
  await selector.ready;
} catch (error) {
  console.error(error); // also available as selector.getState().error
}

// Later, after a successful load:
if (selector.getState().duration >= 2) {
  selector.setSelection({ start: 0.5, end: 2 });
}

// On unmount:
// selector.destroy();
```

The caller owns the context and routing. The selector resumes the supplied context when a user initiates playback; it neither creates nor closes a context, and it does not connect its output to the destination. Connect its output to a destination or your effects chain. Mount in the browser with a DOM, Web Audio, and `ResizeObserver`; keep mounting behind a client-only boundary in a server-rendered app.

### Interaction

To share audio and selection across views, call `mountWaveformSelector(root, { player })` with a `WavePlayer` from `@audiorective/blocks`. Supply either `context` or `player`. The view does not destroy a supplied player or cancel its loads when detached. Route the shared output once. Loading or changing selection through any view updates the player and all its views; renderer, zoom and snap remain local. See [Blocks](./blocks.md#share-a-block-between-widgets).

- Load an audio URL or local file using the built-in controls. Loading does not start playback.
- Drag in either direction to create a range and start looping its audition. The endpoints are normalized to increasing seconds.
- Click the waveform to seek and play. Clicking outside the selected range clears that range.
- Resize a range with its handles. Arrow keys adjust a focused handle by 0.01 seconds; Shift uses 0.1 seconds. Pointer handle resizing commits and auditions the resulting range too. Keyboard edits and programmatic `setSelection` leave a stopped player stopped.
- Use Play/Pause, Stop, Loop, Clear selection, zoom controls, and horizontal scrolling. A zoom factor of 1 fits the entire source.
- Supply `grid: { beats, downbeats }` as arrays of original source seconds to enable the snap control. The selector maps them to the committed output timeline after each edit. Snap starts off; Alt bypasses pointer snapping.

### Selector API

```typescript
type Selection = { start: number; end: number };

type WaveformSelectorOptions = {
  context: AudioContext; // alternatively supply player: WavePlayer, without context
  source?: string | File;
  grid?: { beats: number[]; downbeats: number[] };
  onSelectionChange?: (selection: Selection | null) => void;
  renderer?: import("@audiorective/widgets").WaveformRenderer;
};
```

`mountWaveformSelector(root, options)` returns `WaveformSelectorHandle`:

| Member                                             | Behavior                                                                                                                                                                                                     |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ready: Promise<void>`                             | Resolves after the initial load, or immediately without `source`; rejects if the current initial load fails.                                                                                                 |
| `output: AudioNode`                                | Caller-routed audio output, using the supplied context.                                                                                                                                                      |
| `load(source: string \| File): Promise<void>`      | Replaces the audio and clears the selection. The latest request wins, including when earlier decoding finishes later. A failed current request rejects and populates `error`; a subsequent load can recover. |
| `cancelLoad(): void`                               | Cancels the player's active load. On a shared player this affects all observing selectors; destroying a borrowed view still leaves the caller's load running.                                                |
| `setSelection(selection: Selection \| null): void` | Sets metadata and updates the player's range without initiating playback. Endpoints must be finite and satisfy `0 <= start < end <= duration`.                                                               |
| `getState(): WaveformSelectorState`                | Returns a snapshot; selection boundaries and position use committed output seconds.                                                                                                                          |
| `destroy(): void`                                  | Idempotently removes mounted DOM, listeners, observers, animation frames, pending load ownership, plugins, and owned audio nodes. Leaves the caller's context open.                                          |

`WaveformSelectorState` contains `duration`, `selection`, `position`, `isPlaying`, `isLooping`, `loading`, `loadProgress`, `error: string | null`, `pixelsPerSecond`, `processing`, `stretchRatio`, `revision`, and `sourceDuration`. `duration` is the current output duration; `sourceDuration` belongs to the original source. Loading errors appear in the widget as well as in state. Catch `ready` and `load()` rejections when calling them directly. URL fetches follow the browser's CORS rules; decoding errors keep the browser's message.

### Loading feedback

The complete selector renders the block's download/read byte counts, indeterminate decode/peaks phases, and Cancel loading action. A progress fraction appears only with a known positive byte total; no decode/stretch percentage is fabricated. `getState().loadProgress` uses [the block contract](./blocks.md#loading-state-progress-and-cancellation). Successful completion, errors and cancellation remove loading feedback. A new `load` can retry; a cancelled promise settling does not imply a committed source. Multiple selectors sharing one player show the same progress and cancellation state.

### Displaying committed edits

A selector reads `player.version.peaks` when the committed revision changes. The player summarizes PCM once per version; multiple selectors share that result without rescanning PCM for each view. The view copies the peak arrays for drawing. While `setStretch()` is pending, the old waveform stays visible and the processing indicator is active. A successful commit updates audio, peaks, duration and selection together; a failed render leaves the committed waveform in place.

Same-source edits preserve each view's zoom factor and map its scroll position to the new duration. A new source resets the viewport. Selector `grid` values remain in **original source seconds** and are remapped through `player.sourceToOutput()` for snapping; selection callbacks, playhead, viewport coordinates, and renderer times use **current output seconds**. To initiate stretch, retain the supplied `WavePlayer` and call `await player.setStretch(ratio)`; the selector handle does not add a second editing API. See the [complete composition example](./blocks.md#compose-offline-stretch-and-a-selector).

## Use the waveform without audio

The `/waveform` entry may import the pure `@audiorective/core/peaks` helper, but evaluates no core audio-runtime or audio-player implementation. It accepts precomputed peaks or an existing `AudioBuffer`; mounting it creates no audio context or nodes.

```typescript
import { mountWaveform, createSelectionPlugin } from "@audiorective/widgets/waveform";

const view = mountWaveform(document.querySelector<HTMLElement>("#waveform")!, {
  data: { peaks: new Float32Array([0.2, 0.8, 0.5, 0.3]), duration: 4 },
  label: "Clip waveform",
});
const selection = createSelectionPlugin({
  onChange(range) {
    console.log(range);
  },
  onCommit(event) {
    console.log(event.kind, event.selection);
  },
});
const attachment = view.attach(selection);
selection.setSelection({ start: 1, end: 3 });
view.setPlayhead(1.5); // feed updates from an external player if needed
view.setZoom(2);

// Optional early detach; view.destroy() also destroys all attachments.
attachment.destroy();
view.destroy();
```

Selection plugins only manage metadata and interaction. Even pointer commits do not start sound here; applications explicitly choose how to respond.

### Waveform API

`mountWaveform(root, options?)` accepts `WaveformOptions` with optional `data`, `playhead: number | null`, accessible `label`, and a custom `renderer`. `WaveformData` is one of:

- `{ peaks: Float32Array, duration: number }`: symmetric amplitude per bin.
- `WaveformPeaks = { min: Float32Array, max: Float32Array, duration: number }`: matching, nonempty extrema arrays.
- An existing `AudioBuffer`, from which extrema are computed across channels.

Peak values must be finite, and duration must be finite and positive. The view copies supplied peak arrays. `null` clears data through `setData`.

| `WaveformHandle` member                | Behavior                                                                                                          |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `setData(data: WaveformData \| null)`  | Replaces data, resets zoom and scroll, and clears attached selection metadata.                                    |
| `setPlayhead(seconds: number \| null)` | Shows a finite position clamped to the displayed timeline; `null` hides the playhead.                             |
| `getViewport()`                        | Returns `WaveformViewport`: `duration`, `pixelsPerSecond`, `scrollLeft`, `width`, `height`. Distances are pixels. |
| `setZoom(factor: number)`              | Requires finite `factor >= 1`; zoom preserves the viewport center and is bounded internally.                      |
| `scrollTo(seconds: number)`            | Scrolls toward a displayed timeline position, clamped to the available range.                                     |
| `attach(plugin: WaveformPlugin)`       | Returns a `PluginAttachment` with idempotent `destroy()`.                                                         |
| `destroy()`                            | Idempotently detaches plugins and removes the view and its resources.                                             |

### Selection plugin API

`createSelectionPlugin(options?)` accepts `SelectionPluginOptions`: `grid`, `snap: "off" | "beat" | "downbeat"`, `onChange(selection)`, and `onCommit(event)`. A commit contains `selection`, `kind`, and an optional click `time` in seconds. `kind` is `"pointer"`, `"keyboard"`, `"programmatic"`, or `"click"`; pointer commits include both a newly drawn range and handle resizing.

Attach the plugin before calling `setSelection`. Its methods are `getSelection()`, `setSelection(selection | null)`, `setSnap(mode)`, and `setGrid({ beats, downbeats })`. Pure-plugin grids use **current-view seconds**, matching the displayed data. `setGrid` replaces and copies the arrays; it does not convert original source times. Convert those explicitly when using the pure plugin with edited audio. Each selection plugin attaches to one view at a time; each view has one selection owner. Destroy the attachment before reusing the plugin elsewhere. Without an external model, data replacement and detachment clear its selection.

Pass `model: SelectionModel` to use an existing headless selection owner. The structural interface is `getSelection(): Selection | null`, `setSelection(selection: Selection | null): void`, and `subscribe(listener: () => void): () => void`. `WavePlayer` implements it. The plugin reads the model directly and writes gesture changes to it; detaching or replacing a view's display data leaves external selection intact. `onChange`/`onCommit` describe this plugin's edits; external model notifications redraw without inventing a gesture commit. Keep the model's timeline and duration consistent with the displayed data.

## Replace waveform drawing

Pass a `WaveformRenderer` factory as `renderer` to either `mountWaveform` or `mountWaveformSelector`. The factory mounts your SVG, Canvas, or DOM into a dedicated drawing container once and returns `{ render(frame), destroy?() }`. Omitting the option uses the default SVG drawing.

```typescript
import { mountWaveform, type WaveformRenderer } from "@audiorective/widgets/waveform";

const outline: WaveformRenderer = (container) => {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  const path = document.createElementNS(svg.namespaceURI, "path");
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", "orange");
  path.setAttribute("stroke-width", "2");
  svg.append(path);
  container.append(svg);
  return {
    render({ peaks, width, height }) {
      svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
      const commands: string[] = [];
      if (peaks) {
        for (let i = 0; i < peaks.max.length; i++) {
          const x = ((i + 0.5) / peaks.max.length) * width;
          const y = ((1 - peaks.max[i]) * height) / 2;
          commands.push(`${i ? "L" : "M"}${x},${y}`);
        }
      }
      path.setAttribute("d", commands.join(" "));
    },
    destroy() {
      svg.remove();
    },
  };
};

const view = mountWaveform(document.querySelector<HTMLElement>("#waveform")!, {
  data: { peaks: Float32Array.of(0.2, 0.8, 0.4, 0.6), duration: 6 },
  renderer: outline,
});
// Selection plugins and external playheads work with this drawing too.
// view.destroy() also destroys the renderer.
```

`WaveformRenderFrame` contains `peaks: Readonly<WaveformPeaks> | null`, `width`, `height`, and `pixelsPerSecond`. Peaks are cached extrema combined across channels; treat their arrays as read-only. Width and height describe the **full scrolling content in CSS pixels**, and a displayed timeline time maps to `seconds * pixelsPerSecond`. `null` means clear the drawing. The widget calls `render` initially and on data, zoom, and size changes. Scrolling is native DOM movement; it does not require redrawing the whole content. Playback position is a separate overlay.

The drawing container is decorative and ignores pointer events. Use plugins for interactive overlays; selection, snapping, ruler, playhead, and audio continue to be owned by the widget. The renderer can change the shape within the same linear time axis; a circular or otherwise different time-coordinate system requires a separate interaction design. Canvas renderers own their backing resolution and device-pixel scaling. A live color/theme change inside a custom renderer is the renderer's responsibility.

The widget calls the returned `destroy()` once, including after an initial `render` failure, and removes the drawing container. Release additional listeners, observers, or timers there. A factory that throws before returning must release its own extra resources; the widget still removes its mounted DOM. Renderer exceptions propagate to the caller on synchronous operations. Cleanup exceptions are logged and do not interrupt the widget's remaining cleanup.

## Write a visual plugin

Use the public `WaveformPluginContext` for coordinates, overlays, subscriptions, and cleanup. Coordinates from `timeToX()` are content pixels inside the scrolling waveform; `clientXToTime()` converts browser pointer coordinates into displayed timeline seconds.

```typescript
import { mountWaveform, type WaveformPlugin } from "@audiorective/widgets/waveform";

const marker: WaveformPlugin = {
  attach(context) {
    const layer = document.createElement("div");
    const line = document.createElement("div");
    Object.assign(line.style, {
      position: "absolute",
      top: "0",
      bottom: "0",
      borderLeft: "2px solid orange",
    });
    layer.append(line);
    context.mountOverlay(layer);
    const draw = () => {
      line.style.left = `${context.timeToX(2)}px`;
    };
    context.onViewportChange(draw);
    context.onDataChange(draw);
    draw();
  },
};

const view = mountWaveform(document.querySelector<HTMLElement>("#markers")!, {
  data: { peaks: new Float32Array([0.2, 0.8, 0.4]), duration: 5 },
});
view.attach(marker);
// view.destroy() removes the marker overlay and subscriptions too.
```

The context exposes `surface`, live `duration`, `getViewport()`, `timeToX()`, `clientXToTime()`, `scrollBy(pixels)`, and `getViewportRect()`. Resource methods return unsubscribe functions: `mountOverlay(element)`, `onViewportChange(listener)`, `onDataChange(listener)`, `listen(target, type, listener)`, and `onCleanup(dispose)`. Attachments own those registrations. For additional resources such as a timer, register their disposal with `onCleanup`. `attach` may also return a cleanup function or an object with `destroy()`.

Overlays default to `pointer-events: none`; interactive children can opt into `pointer-events: auto`. A control handling its own pointer gesture can call `preventDefault()` on pointerdown to keep selection interaction from claiming it. Keep extensions on this public seam rather than querying the widget's internal markup.

## Style

Default styles mount with the widget. Set the public accent variable on the host:

```css
#waveform {
  --waveform-accent: #a878ff;
}
```

Other public theme variables:

| Variable                                                     | Controls                                           |
| ------------------------------------------------------------ | -------------------------------------------------- |
| `--waveform-font`                                            | CSS font shorthand                                 |
| `--waveform-foreground`, `--waveform-background`             | Widget text and background                         |
| `--waveform-border`                                          | Widget, viewport, and ruler borders                |
| `--waveform-control-background`, `--waveform-control-border` | Input and button surfaces                          |
| `--waveform-muted`                                           | Help text, ruler labels, and readouts              |
| `--waveform-surface`                                         | Waveform viewport background                       |
| `--waveform-height`                                          | Waveform height, with a CSS length such as `220px` |
| `--waveform-selection-background`                            | Selected range fill                                |
| `--waveform-playhead`                                        | Playhead color                                     |
| `--waveform-error`                                           | Error text color                                   |

DOM classes use the `ar-` prefix to scope widget presentation. Internal class names and test attributes are implementation details; use the handle and plugin context for behavior.

## Common errors

Messages thrown by the waveform view, its plugins and the complete selector. Loading and playback messages come from the borrowed player: see [Blocks](./blocks.md#common-errors).

| Message                                                     | Cause                                              | Fix                                                                                 |
| ----------------------------------------------------------- | -------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `Waveform selector is destroyed.`                           | Calling `load` or `setSelection` after cleanup     | Mount a new selector.                                                               |
| `Waveform is destroyed.`                                    | Mutating or attaching to a destroyed view          | Mount a new view.                                                                   |
| `Waveform data needs finite peaks and a positive duration.` | Invalid peaks or duration                          | Supply nonempty finite peaks, matching extrema arrays, and finite positive seconds. |
| `Zoom must be finite and at least 1.`                       | Invalid zoom factor                                | Use `1` to fit, or a larger finite factor.                                          |
| `Playhead must be finite or null.`                          | Invalid playhead                                   | Supply finite source seconds or `null` to hide it.                                  |
| `Plugin is already attached to this waveform.`              | Duplicate attachment of one instance               | Reuse its attachment or detach it before attaching again.                           |
| `Plugin attachment is destroyed.`                           | Mounting an overlay from a disposed attachment     | Stop asynchronous work during cleanup; use a live attachment context.               |
| `Selection plugin is not attached.`                         | Setting metadata before attachment or after detach | Call `view.attach(selection)` before `selection.setSelection`.                      |
| `Selection plugin is already attached.`                     | Reusing a selection plugin across live views       | Detach first, or create one plugin per view.                                        |
| `Waveform already has a Selection owner.`                   | Multiple selection plugins on one view             | Keep one selection plugin per view.                                                 |
