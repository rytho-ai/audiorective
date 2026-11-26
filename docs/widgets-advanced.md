---
title: "Widgets: advanced"
---

Use this page to replace drawing, attach scoped helpers or connect caller-owned time domains. [Widgets](./widgets.md) covers ordinary mounts, sources, commands and every widget error. Views borrow audio/model owners and dispose only their own resources.

## Selector ownership and revisions

`SelectorPlayer` is structural: `cells` supplies selection, isLooping, isPlaying, loading, loadProgress, error, processing, version and playhead; the owner also provides position, duration, sourceBuffer, load/cancelLoad, play/audition/pause/stop/seek, setLooping, sourceToOutput, output, dispose and the selection model's setSelection. A WavePlayer fits directly. Loading and selection changes through any shared view reach all views; renderer, zoom and snap stay local. Disposing a borrowed selector leaves the player and its load alive. A selector created through createPlayer owns that player, while the app retains the context.

`mountWaveformSelector(root, { player })` observes a structural `SelectorPlayer`; WavePlayer satisfies it. It has selection, isLooping/isPlaying, loading/loadProgress/error, processing, version and playhead cells; position, duration, sourceBuffer, output, sourceToOutput and the load/cancelLoad/play/audition/pause/stop/seek/setLooping/setSelection/dispose methods. Supply `createPlayer` instead when the view should own a player. A borrowed detach neither disposes that player nor cancels its load. Connect shared output once. Renderer, zoom and snap stay view-local. See [shared WavePlayer views](./player.md#share-a-player-between-widgets).

### Selector API

| Option                     | Owner / default                                                                            |
| -------------------------- | ------------------------------------------------------------------------------------------ |
| `player` or `createPlayer` | Supply exactly one: a borrowed SelectorPlayer or a factory whose player the selector owns. |
| `source`                   | Optional URL or File to load initially.                                                    |
| `controls`                 | Source/playback controls, default true.                                                    |
| `audition`                 | Pointer selection auditions and clicks play, default true.                                 |
| `grid`                     | `{ beats, downbeats }` in original source seconds.                                         |
| `onSelectionChange`        | Selection preview/change callback; `null` clears the range.                                |
| `renderer`                 | Optional public WaveformRenderer factory for drawing.                                      |

`mountWaveformSelector(root, options)` returns `WaveformSelectorHandle`. A shared `player` and a selector-owned `createPlayer` are mutually exclusive options:

| Member                                             | Behavior                                                                                                                                                                                                     |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ready: Promise<void>`                             | Resolves after the initial load, or immediately without `source`; rejects if the current initial load fails.                                                                                                 |
| `output: AudioNode`                                | Caller-routed audio output of the selector's player.                                                                                                                                                         |
| `load(source: string \| File): Promise<void>`      | Replaces the audio and clears the selection. The latest request wins, including when earlier decoding finishes later. A failed current request rejects and populates `error`; a subsequent load can recover. |
| `cancelLoad(): void`                               | Cancels the player's active load. On a shared player this affects all observing selectors; disposing a borrowed view still leaves the caller's load running.                                                 |
| `setSelection(selection: Selection \| null): void` | Sets metadata and updates the player's range without initiating playback. Endpoints must be finite and satisfy `0 <= start < end <= duration`.                                                               |
| `getState(): WaveformSelectorState`                | Returns a snapshot; selection boundaries and position use committed output seconds.                                                                                                                          |
| `attach(plugin: TimeViewPlugin)`                   | Adds an overlay or interaction to the selector's waveform in committed output seconds. Returns a `PluginAttachment`.                                                                                         |
| `dispose(): void`                                  | Idempotently removes mounted DOM, listeners, observers, animation frames, pending load ownership, plugins, and owned audio nodes. Leaves the caller's context open.                                          |

`WaveformSelectorState` is a snapshot read from the player's cells and contains `duration`, `selection`, `position`, `isPlaying`, `isLooping`, `loading`, `loadProgress`, `error: string | null`, `pixelsPerSecond`, `processing`, `stretchRatio`, `revision`, and `sourceDuration`. `duration` is the current output duration; `sourceDuration` belongs to the original source. Loading errors appear in the widget as well as in state. Catch `ready` and `load()` rejections when calling them directly. URL fetches follow the browser's CORS rules; decoding errors keep the browser's message.

### Loading feedback

The complete selector renders the player's download/read byte counts, indeterminate decode/peaks phases, and Cancel loading action. A progress fraction appears only with a known positive byte total; no decode/stretch percentage is fabricated. `getState().loadProgress` is the player's `cells.loadProgress` ([the player contract](./player.md#loading-state-progress-and-cancellation)). Successful completion, errors and cancellation remove loading feedback. A new `load` can retry; a cancelled promise settling does not imply a committed source. Multiple selectors sharing one player show the same progress and cancellation state.

### Displaying committed edits

A selector reads `player.cells.version.value.peaks` when the committed revision changes. The player summarizes PCM once per version; multiple selectors share that result without rescanning PCM for each view. The view copies the peak arrays for drawing. While `setStretch()` is pending, the old waveform stays visible and the processing indicator is active. A successful commit updates audio, peaks, duration and selection together; a failed render leaves the committed waveform in place and rejects to the caller of `setStretch`; the selector does not display it.

Same-source edits preserve each view's zoom factor and map its scroll position to the new duration. A new source resets the viewport. Selector `grid` values remain in **original source seconds** and are remapped through `player.sourceToOutput()` for snapping; selection callbacks, playhead, viewport coordinates, and renderer times use **current output seconds**. To initiate stretch, retain the supplied `WavePlayer` and call `await player.setStretch(ratio)`; the selector handle does not add a second editing API. See the [complete composition example](./player.md#compose-offline-stretch-and-a-selector).

The handle also provides the waveform viewport facade: `getViewport()`, `setZoom(factor)`, `setAmplitudeZoom(factor)`, `getAmplitudeZoom()` and `scrollTo(outputSeconds)`. `WaveformViewport` contains `duration`, `pixelsPerSecond`, `scrollLeft`, `width` and `height`; distances are CSS pixels. Zoom 1 fits the source and preserves the viewport center when changed. Amplitude zoom is display-only, from 1 through 32. It changes neither cached peaks nor audio. Source data remains on the player.

### Waveform API

The `/waveform` entry may import pure `@audiorective/core/peaks` helpers; it evaluates no core audio-runtime or audio-player implementation. Mounting from supplied peaks or an existing AudioBuffer constructs no AudioContext or audio nodes.

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
| `setAmplitudeZoom(factor: number)`     | Scales only the displayed waveform height from `1` to `32`; cached peaks and audio remain unchanged.              |
| `getAmplitudeZoom()`                   | Returns the current display-only amplitude factor.                                                                |
| `scrollTo(seconds: number)`            | Scrolls toward a displayed timeline position, clamped to the available range.                                     |
| `attach(plugin: TimeViewPlugin)`       | Returns a `PluginAttachment` with idempotent `dispose()`.                                                         |
| `dispose()`                            | Idempotently detaches plugins and removes the view and its resources.                                             |

### Selection plugin API

`createSelectionPlugin(options?)` accepts `SelectionPluginOptions`: `grid`, `snap: "off" | "beat" | "downbeat"`, `onChange(selection)`, and `onCommit(event)`. `onChange` reports displayed preview changes and cancellation rollbacks; the shared model retains its committed range until release. Cancellation restores the committed display and commits nothing. A commit contains `selection`, `kind`, and an optional click `time` in seconds. `kind` is `"pointer"`, `"keyboard"`, `"programmatic"`, or `"click"`; pointer commits include both a newly drawn range and handle resizing.

Attach the plugin before calling `setSelection`. Its methods are `getSelection()` (the displayed local preview during a drag), `setSelection(selection | null)` (a programmatic owner edit that also cancels a stale gesture), `setSnap(mode)`, and `setGrid({ beats, downbeats })`. Pure-plugin grids use **current-view seconds**, matching the displayed data. `setGrid` replaces and copies the arrays; it does not convert original source times. Convert those explicitly when using the pure plugin with edited audio. Each selection plugin attaches to one view at a time; each view has one selection owner. Dispose the attachment before reusing the plugin elsewhere. Without an external model, data replacement and detachment clear its selection.

Pass `model: SelectionModel` to use an existing headless selection owner. The structural interface is a `cells.selection` cell holding `Selection | null` and `setSelection(selection: Selection | null): void`. `WavePlayer` implements it. The plugin reads committed selection from the model and keeps pointer previews local. A completed gesture calls the owner once on release; Escape, pointer cancellation, lost capture, detachment and external owner replacement discard the preview. `onChange` reports displayed previews and rollbacks; `onCommit` runs after the owner accepts the completed edit. The plugin writes programmatic `setSelection` through the model; detaching or replacing a view's display data leaves external selection intact. External model notifications redraw without inventing a gesture commit. Keep the model's timeline and duration consistent with the displayed data.

## Replace waveform drawing

Pass a `WaveformRenderer` factory as `renderer` to either `mountWaveform` or `mountWaveformSelector`. The factory mounts your SVG, Canvas, or DOM into a dedicated drawing container once and returns `{ render(frame), dispose?() }`. Omitting the option uses the default SVG drawing.

```typescript
import { mountWaveform, type WaveformData, type WaveformRenderer } from "@audiorective/widgets/waveform";

const drawing: WaveformRenderer = (container) => {
  const canvas = container.ownerDocument.createElement("canvas");
  container.append(canvas);
  return {
    render({ peaks, width, height, amplitudeZoom }) {
      const ratio = devicePixelRatio || 1;
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      canvas.width = Math.max(1, Math.round(width * ratio));
      canvas.height = Math.max(1, Math.round(height * ratio));
      const context = canvas.getContext("2d");
      if (!context) return;
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, width, height);
      if (!peaks) return;
      context.strokeStyle = getComputedStyle(container).color;
      context.beginPath();
      const y = (value: number) => ((1 - Math.max(-1, Math.min(1, value * amplitudeZoom))) * height) / 2;
      for (let index = 0; index < peaks.min.length; index++) {
        const x = ((index + 0.5) * width) / peaks.min.length;
        context.moveTo(x, y(peaks.min[index]));
        context.lineTo(x, y(peaks.max[index]));
      }
      context.stroke();
    },
    dispose: () => canvas.remove(),
  };
};

function mountCustomWaveform(root: HTMLElement, data: WaveformData) {
  return mountWaveform(root, { data, renderer: drawing });
}
```

`WaveformRenderFrame` contains `peaks: Readonly<WaveformPeaks> | null`, `width`, `height`, `pixelsPerSecond`, and `amplitudeZoom`. Peaks are cached extrema combined across channels; treat their arrays as read-only. A custom renderer applies `amplitudeZoom` to its drawing if it wants the public amplitude control; the default renderer clips enlarged peaks at the view's top and bottom. Width and height describe the **full scrolling content in CSS pixels**, and a displayed timeline time maps to `seconds * pixelsPerSecond`. `null` means clear the drawing. The widget calls `render` initially and on data, zoom, and size changes. Scrolling is native DOM movement; it does not require redrawing the whole content. Playback position is a separate overlay.

The drawing container is decorative and ignores pointer events. Use plugins for interactive overlays; selection, snapping, ruler, playhead, and audio continue to be owned by the widget. The renderer can change the shape within the same linear time axis; a circular or otherwise different time-coordinate system requires a separate interaction design. Canvas renderers own their backing resolution and device-pixel scaling. A live color/theme change inside a custom renderer is the renderer's responsibility.

The widget calls the returned `dispose()` once, including after an initial `render` failure, and removes the drawing container. Release additional listeners, observers, or timers there. A factory that throws before returning must release its own extra resources; the widget still removes its mounted DOM. Renderer exceptions propagate to the caller on synchronous operations. Cleanup exceptions are logged and do not interrupt the widget's remaining cleanup.

## Piano roll

`mountPianoRoll(root, { model, onNoteEdit })` draws a `PianoRollModel` (`getState(): { notes, duration, selection }`, `getSelection`, `setSelection`, `subscribe`). Note times, `duration`, `grid`, the playhead and plugin coordinates are in beats (quarter notes); velocity is 0..1. `pianoRollModel(clip)` binds a `MidiClip` from `@audiorective/midi` so no adapter is needed:

```typescript
import { MidiClip } from "@audiorective/midi";
import { mountPianoRoll, pianoRollModel } from "@audiorective/widgets/piano-roll";

const clip = new MidiClip([{ pitch: 60, velocity: 0.8, start: 0, duration: 1 }]);
const model = pianoRollModel(clip); // or pianoRollModel(clip, { duration: 16 })
const view = mountPianoRoll(root, {
  model,
  snap: "beat",
  grid: { beats: [0, 1, 2, 3, 4], downbeats: [0, 4] },
  onNoteEdit: ({ note }) =>
    clip.edit((draft) => Object.assign(draft.find((n) => n.id === note.id)!, { start: note.start, duration: note.duration, pitch: note.pitch })),
});
// later
view.dispose();
model.dispose();
```

`pianoRollModel(clip, options?)` returns `PianoRollModel & { readonly selection: Cell<MidiRange | null>; dispose(): void }`. `getState()` returns a frozen snapshot that stays the same object until the notes, duration or selection change. `duration` defaults to the end of the last note rounded up to a whole 4-beat bar (at least 4 beats); `options.duration` is a number or a getter, in beats. `options.window` is a `{ start, end }` range in beats (or a getter returning one or `null`) that the clip plays, for example a `MidiClip` of `@audiorective/daw` with `{ start: clip.sourceOffset, end: clip.sourceOffset + clip.duration }`: `getState().window` carries it, and the default renderer draws notes entirely outside it dimmed (`data-outside="true"`) and shades the unplayed stretches (`ar-pr-window-shade`). Editing still edits every note. Without it nothing is dimmed. The selection belongs to the model (assign `model.selection.value` or call `setSelection`) and nothing clears it implicitly. `subscribe(listener)` runs once per commit and not on subscribe; `dispose()` stops every listener and leaves the clip alone.

A move or resize gesture previews inside the widget and calls `onNoteEdit({ kind, previous, note })` once on release, where `note` carries the new `start`, `duration` and `pitch`. A resize never makes a note shorter than 1/64 beat (or its own length when already shorter). A custom model is any object with the four `PianoRollModel` methods.

## Write a visual plugin

Use `view.attach(plugin)` for waveform, piano roll, and waveform selector extensions. All three implement `PluginTarget<TimeViewPluginContext>`. The plugin reads `context.timeUnit` to interpret coordinates. Waveform and selector use seconds, with the selector using the current playback version's output seconds. Piano roll uses beats. The app supplies the appropriate time in each unit.

```typescript
import { mountWaveform } from "@audiorective/widgets/waveform";
import type { TimeViewPlugin } from "@audiorective/widgets";

const marker: TimeViewPlugin = {
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
      const time = context.timeUnit === "beats" ? 4 : 2;
      line.hidden = time > context.duration;
      line.style.left = `${context.timeToX(time)}px`;
    };
    context.onViewportChange(draw);
    context.onDataChange(draw);
    draw();
  },
};

const view = mountWaveform(document.querySelector<HTMLElement>("#markers")!, {
  data: { peaks: new Float32Array([0.2, 0.8, 0.4]), duration: 5 },
});
const attachment = view.attach(marker);
// Pass marker to a piano roll or selector the same way.
// attachment.dispose() removes just the marker. view.dispose() removes all attachments.
```

`timeToX()` returns content pixels and `clientXToTime()` converts browser pixels back to the view's time unit. Use these helpers to place overlays independently of zoom and scroll. `mountOverlay()`, `onViewportChange()`, `onDataChange()`, `listen()`, and `onCleanup()` return cleanup functions and are disposed with the attachment. A plugin can also return a disposer from `attach()`. Keep per-attachment DOM and state inside `attach()` if the same plugin object will serve multiple views.

`WidgetPlugin<Context>` and `WidgetPluginContext` describe lifecycle and resource cleanup for other context shapes. `TimeViewPlugin` is the specialization for these three time views. `WaveformPlugin` and `WaveformPluginContext` are compatibility exports. For clip movement and timeline zoom on an app-rendered arrangement, use the [arrangement gesture functions](#arrangement-gestures).

Overlays default to `pointer-events: none`; interactive children can opt into `pointer-events: auto`. A control handling its own pointer gesture can call `preventDefault()` on pointerdown to keep selection interaction from claiming it. Keep extensions on this public seam rather than querying the widget's internal markup.

## One curve in two time views

A lane and an overlay can edit the same curve owner. The lane uses authored coordinates; the overlay uses the supplied view-to-owner and owner-to-view inverses. Supply those conversions from your tempo/clip mapping. Do not preconvert point snapshots and also pass the conversions: that applies the mapping twice.

```typescript
import { readonlyCell, type Readable } from "@audiorective/core";
import type { AutomationCurve } from "@audiorective/core/automation";
import {
  mountAutomationLane,
  createAutomationOverlay,
  createWarpMarkers,
  type PluginTarget,
  type TimeViewPluginContext,
  type WarpMarkerOptions,
} from "@audiorective/widgets";

function attachEditors(
  root: HTMLElement,
  view: PluginTarget<TimeViewPluginContext>,
  curve: AutomationCurve,
  duration: () => number, // authored beats
  mapping: {
    fromView(seconds: number): number;
    toView(beats: number): number;
    viewBreakpoints?: readonly number[];
  },
  tool: Readable<"curve" | "warp">,
  warp: Omit<WarpMarkerOptions, "disabled">, // app supplies frame mapping and commit
  reportError: (error: unknown) => void, // app-owned edit notice
) {
  const commitCurve = (next: typeof curve.value) => {
    try {
      curve.value = next;
    } catch (error) {
      reportError(error);
    }
  };
  const lane = mountAutomationLane(root, {
    points: curve,
    duration,
    timeUnit: "beats",
    maxValue: 2,
    defaultValue: 1,
    onCommit: commitCurve,
  });
  const overlay = view.attach(
    createAutomationOverlay({
      points: curve,
      fromView: mapping.fromView,
      toView: mapping.toView,
      viewBreakpoints: mapping.viewBreakpoints,
      maxValue: 2,
      defaultValue: 1,
      disabled: readonlyCell(() => tool.value !== "curve"),
      onCommit: commitCurve,
    }),
  );
  const markers = view.attach(
    createWarpMarkers({
      ...warp,
      disabled: readonlyCell(() => tool.value !== "warp"),
    }),
  );
  return {
    dispose() {
      markers.dispose();
      overlay.dispose();
      lane.dispose();
    },
  };
}
```

The caller owns `curve`, `tool`, anchors and playback; neither view owns or stops them. `AutomationCurve` rejects an empty point list, so its command reports final-point deletion as an owner validation error here. Project/other array owners may support `[]`. The widget rolls rejected previews back to the authoritative source even if a command throws; it does not choose a replacement curve policy. Disabled tools yield input and cancel active previews, so switching tools needs no detach/remount or second enabled store. External curve/marker snapshot replacement cancels stale gestures; replacement updates retained handles and focus. EQ presets update mounted EQ controls; this does not impose a separate preemption rule on every live native parameter drag.

For a Project clip, project `points` with readonlyCell over `project.cells.revision` and the latest clip. Derive inverses from [the clip source window](./daw.md#clip-gain-automation). Original source seconds, output seconds, project seconds and musical beats are different domains. `viewBreakpoints` supplies interior view times at piecewise slope changes for drawing only. It does not rewrite source points. Pass `viewBreakpoints` as a readonly array, such as `clip.stretch?.anchors?.map(({ outputFrame }) => outputFrame / clip.sampleRate)`. Optional overlay `snap` receives view time; Alt bypasses it. All commits return points in the owner's domain.

### Reactive option shapes

| Option                    | Exact shape                                      | Borrowed source                                                     |
| ------------------------- | ------------------------------------------------ | ------------------------------------------------------------------- |
| Lane and overlay `points` | `{ readonly value: readonly AutomationPoint[] }` | `curve` or `readonlyCell(() => currentPoints())`                    |
| Warp `anchors`            | `Readable<readonly WaveStretchAnchor[]>`         | An existing anchors cell, or `readonlyCell(() => currentAnchors())` |
| Overlay/warp `disabled`   | `Readable<boolean>`                              | `readonlyCell(() => tool.value !== "curve")` for the curve tool     |
| Clip editor `envelope`    | `Readable<ClipEnvelope>`                         | The existing envelope cell or a readonlyCell projection             |
| Lane/envelope `duration`  | `() => number`                                   | A getter that reads the current tracked owner length                |
| Overlay `viewBreakpoints` | `readonly number[]`                              | Interior **view** times at mapping slope changes                    |

`Readable<T>` includes tracked `.value`, `$` and `subscribe`; core Cell, Param and ReadonlyCell supply it. Point sources need only the tracked `.value` member. The commands `onCommit`/`onChange` apply edits to the owner; snapshots and projections remain read-only to the view.

## Warp markers

`view.attach(createWarpMarkers({ anchors, sampleRate, sourceFrames, sourceFrameAt, onCommit }))` mounts a seconds-view marker editor. `anchors` is a `Readable<readonly WaveStretchAnchor[]>` of source/output frame pairs. Pass the existing anchors cell directly, or `readonlyCell(() => currentAnchors())` over the owner array. Supply a conversion from waveform seconds to source frames for new markers. Double-click to add a marker, drag it to change its output position, or move a focused marker with the arrow keys. Shift increases the keyboard step. Delete removes a marker and Escape cancels a drag. The view commits on release and renders neighboring markers in order. It borrows the anchors and leaves audio processing and undo to the caller. `WaveStretchAnchor` is the player-owned `{ sourceFrame, outputFrame }` type, also exported from widgets root. `ClipStretchAnchor` in `@audiorective/daw/project` has the same shape. A readable `disabled` gate yields input to another tool; replacing anchors cancels a stale preview while preserving marker DOM and focus. Dispose the attachment when removing the view.

For a Workspace clip, follow the [prepared stretch example](./daw.md#pitch-preserving-clip-stretch): await preparation, then execute the prepared `apply()` inside the app's history transaction. The marker callback does not record history by itself.

## Step grid reference

`StepGridSequencer = { lanes: Record<string, StepGridLane> }` is structural. Each lane supplies writable pattern, length, rate, swing, direction, `muted` and `solo`, plus params, playhead, optional progress and steps. A real StepSequencer fits; widgets import no sequencer runtime. The grid follows tracked lane membership and length changes. Declare custom parameters before mounting so their tabs are available. Pattern edits reuse elements; longest lane length determines columns.

The grid reads each lane's length, rate, direction, swing, `muted`, solo, `steps`, `playhead` and `progress` and writes through the lane's setters and `steps[i]` fields. The column count is the longest lane length seen. `laneLabel(name)` names a lane for display (default: the lane name).

Each lane row has a header and a row of cells.

- **Header:** a column header row (`Steps`, `Rate`, `Dir`, `Swing`) sits above the lanes, aligned with fixed-width header columns. Each lane row is as tall as its cells: a filled name block, Mute and Solo square toggles, then the four columns. Every control writes the lane's setter.
  - `Steps` and `Swing` are number boxes (`role="spinbutton"` with `aria-valuemin`, `aria-valuemax`, `aria-valuenow` and `aria-valuetext`). Drag vertically (8 px per step, 3 px per percent), press Up/Right or Down/Left (Shift moves by 10), PageUp and PageDown (10), Home and End, scroll the wheel while the box is focused, or double-click (or press Enter) to type a value; Enter commits, Escape cancels, and the value is clamped. `Steps` is limited to 1..128; swing is 0 to 100 percent, the lane's `swing` of 0..1 shown as a percentage: it delays every odd step by that share of half a step (100% is half a step late), a fixed beat offset that follows tempo.
  - `Rate` is a styled `select` over the twelve straight and triplet rates. `Dir` is a button that cycles `→`, `←`, `↔`.
- **Parameter tabs:** a strip under the grid selects which per-step value the grid shows and edits: Velocity, Offset, Length, Repeat, Pitch and Chance, then one tab for each per-lane custom param (the union by id across lanes; a lane without that param shows its cells inert on that tab). Ranges come from the lane's `params` and the built-in `Step` ranges. Velocity, chance, length and custom values draw as a fill height, offset and pitch as a bar from the centre line, repeat as segment marks.
- **Cells:** click toggles. A vertical drag edits the active parameter. A fill-height value covers its range over one cell height, repeat takes 12 px per hit and pitch 3 px per semitone; repeat and pitch snap to integers and every value stays inside its range. A value label (`65%`, `+3 st`, `x4`) shows while editing, on hover and on focus. A drag does not also toggle.
- **Polymeter:** cells beyond a lane's `steps` are dimmed and inert. Each lane's `playhead` cell is highlighted, a bar across the top follows the first lane with a non-null `progress`, and the ruler marks every 4th step (1, 5, 9, 13 …).
- **Fold:** the Fold toggle hides lanes with no active step.
- **Keyboard:** the grid is one tab stop (roving `tabindex`). Left and Right (or Home and End) move along a lane, Alt+Up and Alt+Down move between lanes, Enter and Space toggle, Up and Down adjust the active parameter by a fine step, PageUp and PageDown by a coarse one (velocity 5% and 25%; pitch 1 and 12 semitones).
- **Updates:** the widget keeps every element across pattern changes and repaints only the cells, headers and playheads whose values changed. It rebuilds cells only when the column count or the lane list changes.

`formatStep(label, step)` receives a **zero-based** step index; use `step + 1` for visible numbering. It names each cell for assistive technology (default `Kick step 3`). `labels` overrides the built-in strings (`grid`, `velocity`, `offset`, `length`, `repeat`, `pitch`, `chance`, `fold`, `mute`, `solo`, `steps`, `rate`, `direction`, `swing`, `dir`); custom tabs are labelled with the param name. Tracked lane membership changes add or remove rows and cell scopes. The custom parameter tab set is established at mount.

**Styling.** Every colour and size is a CSS custom property with a neutral default, so a page themes the grid by setting properties on the root or an ancestor, without overriding selectors:

| Property                                                                                                                    | Controls                                                                     |
| --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `--ar-step-font`, `--ar-step-color`, `--ar-step-muted`                                                                      | Text font, colour and secondary text                                         |
| `--ar-step-background`, `--ar-step-border`, `--ar-step-radius`, `--ar-step-padding`                                         | The grid frame                                                               |
| `--ar-step-header-width` (default 340px, 300px in a container 900px wide or narrower)                                       | Width of the lane header column                                              |
| `--ar-step-header-background`, `--ar-step-name-color` (falls back to `--ar-step-header-color`)                              | The lane name block fill and its text                                        |
| `--ar-step-column-color`                                                                                                    | Column header labels and the ruler (falls back to muted)                     |
| `--ar-step-cell-height` (40px), `--ar-step-cell-min-width`, `--ar-step-cell-gap`, `--ar-step-lane-gap`, `--ar-step-bar-gap` | Cell and lane sizes, and the extra gap before every 4th step                 |
| `--ar-step-cell-background`, `--ar-step-cell-border`, `--ar-step-cell-radius`                                               | Off cells                                                                    |
| `--ar-step-cell-on-background`, `--ar-step-cell-on-border`                                                                  | Active cells                                                                 |
| `--ar-step-value-color`, `--ar-step-centre-line`                                                                            | The value bar (fill, centre bar, segments) and the centre line               |
| `--ar-step-cap-height` (4px), `--ar-step-fill-inset` (3px)                                                                  | The on-colour cap above an active cell's value bar, and the bar's side inset |
| `--ar-step-playhead`, `--ar-step-playhead-value-color`                                                                      | The playhead cell and its value bar                                          |
| `--ar-step-inert-opacity`                                                                                                   | Cells beyond a lane's `steps`                                                |
| `--ar-step-focus`                                                                                                           | Keyboard focus outline                                                       |
| `--ar-step-progress`, `--ar-step-progress-track`, `--ar-step-progress-height`                                               | The loop progress bar                                                        |
| `--ar-step-label-color`, `--ar-step-label-background`                                                                       | The value label                                                              |
| `--ar-step-control-background`, `--ar-step-control-color`, `--ar-step-control-border`, `--ar-step-control-radius`           | Header and toolbar controls                                                  |
| `--ar-step-box-background`, `--ar-step-box-color`, `--ar-step-box-border`                                                   | Number boxes, the rate picker and direction (fall back to control)           |
| `--ar-step-mute-active-background`, `--ar-step-mute-active-color`                                                           | Pressed Mute (fall back to control active)                                   |
| `--ar-step-solo-active-background`, `--ar-step-solo-active-color`                                                           | Pressed Solo (fall back to control active)                                   |
| `--ar-step-tabs-background`                                                                                                 | The segmented track behind the tabs and Fold                                 |
| `--ar-step-control-active-background`, `--ar-step-control-active-color`, `--ar-step-tab-radius`                             | Selected tab and pressed Fold; the default for Mute/Solo                     |

**Responsive layout.** The widget root is a size container. At 900px or narrower the header column drops to 300px, controls and column labels compact, and cells shrink to a 14px minimum with a 2px gap and 6px bar gap, so a 768px container shows 16 steps and names such as "Tom even" without scrolling. Properties you set (`--ar-step-header-width`, `--ar-step-cell-min-width`, `--ar-step-cell-gap`, `--ar-step-bar-gap`) apply at every width. Below the minimum width the grid scrolls horizontally inside the widget. The widget needs a width from its parent, so avoid mounting it in a shrink-to-fit container.

### Step grid plugins

`mountStepGrid` returns `{ attach(plugin), dispose() }` and implements `PluginTarget<StepGridPluginContext>`, the same host that backs the waveform, piano roll and selector. Registrations are released when the attachment is disposed, and a throwing plugin or listener does not break the grid. Plugin attachments are disposed with the grid.

`StepGridPluginContext` extends `WidgetPluginContext` (`listen`, `onCleanup`) with the members below; `StepGridPlugin` is `WidgetPlugin<StepGridPluginContext>`:

- `onCell(attach)`: attaches a cell-owned helper to every live step. Its `StepGridCellContext` supplies `laneId`, zero-based `stepIndex`, tracked `step`, dedicated auto-positioned `root`, `listen` and `onCleanup`. The returned cleanup ends on cell removal or plugin detach.
- `surface`: the positioned element that holds the lanes.
- `sequencer`: the borrowed sequencer, so a plugin writes steps through `sequencer.lanes.<name>.steps[i]` and whole patterns through `lanes.<name>.pattern`. The context types each lane with the writable members of a real lane: `pattern`, `length`, `rate`, `swing`, `direction`, `muted` and `solo`.
- `cellElement(laneId, step)`: the cell element, or `null` for an unknown lane or step.
- `cellRect(laneId, step)`: `{ x, y, width, height }` in CSS pixels relative to `surface`, or `null`.
- `mountOverlay(element)`: add a full-surface overlay (`pointer-events: none` by default). Returns its cleanup.
- `addToolbarItem(element)`: add an element to the toolbar strip beside the parameter tabs. Returns its cleanup.
- `activeParameter`: a `Readable<string>` of the selected tab id, and `setActiveParameter(id)` to select a built-in or custom tab.
- `onPatternChange(listener)`: called after the grid has updated for each change. Returns its cleanup.

```typescript
import type { StepGridPlugin } from "@audiorective/widgets";

const fillKick: StepGridPlugin = {
  attach(context) {
    const button = document.createElement("button");
    button.textContent = "Fill kick";
    context.addToolbarItem(button);
    context.listen(button, "click", () => {
      context.sequencer.lanes.kick.pattern = "X...X...X...X...";
      context.setActiveParameter("velocity");
    });
  },
};
// grid.attach(fillKick).dispose() removes this toolbar helper only.
```

For cell-owned helpers, prefer `onCell` over measuring every cell from one global overlay:

```typescript
import { effect } from "@audiorective/core";
import type { StepGridPlugin } from "@audiorective/widgets";

const repeatLabels: StepGridPlugin = {
  attach(context) {
    context.onCell((cell) => {
      const badge = cell.root.ownerDocument.createElement("span");
      cell.root.append(badge);
      cell.onCleanup(
        effect(() => {
          badge.textContent = `×${cell.step.repeat}`;
        }),
      );
      cell.onCleanup(() => badge.remove());
    });
  },
};
```

`listen` and `onCleanup` are scoped to the cell here; a returned cleanup is scoped likewise. Removing a cell or detaching the plugin releases them once. The slot follows cell geometry; the plugin need not query internal markup or rebuild all badges on each step write. Use surface overlays/cellRect for decorations spanning cells, toolbar items for global commands, and onPatternChange for a whole-grid notification. The ordinary grid's `formatStep(label, index)` receives the same zero-based index.

### Per-cell diagnostics

| Message                                   | Cause                                                                                                                                                            | Fix                                                                                                        |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `Step grid cell attachment failed: …`     | A cell helper throws while the grid refreshes. The failed `onCell` registration and all its cell resources detach; other registrations and the grid remain live. | Fix the helper's setup or owner access, then register it again. Return or register only its owned cleanup. |
| `Step grid cell plugin cleanup failed: …` | A returned cell disposer or registered cleanup throws during removal or detach. Remaining cleanups continue.                                                     | Make cleanup idempotent and release only resources that the helper owns.                                   |

Initial cell setup propagates the original exception after rolling back that registration; normal plugin-attach rollback also applies. Cell `onCleanup` called after removal runs its cleanup immediately, and late `listen` registrations are immediately removed. These late registrations do not throw the private host's disposed/duplicate guards; [widget Common errors](./widgets.md#common-errors) lists those invariant diagnostics separately.

## Step grid over a MIDI clip

```typescript
import { mountStepGrid, stepGridModel } from "@audiorective/widgets";

const model = stepGridModel(clip.midi, {
  lanes: { hat: 42, snare: 38, kick: 36 }, // lane name to pitch, top to bottom
  stepsPerBar: 16, // default
  bars: () => bars.value, // number or tracked getter; default 1
  edit: (recipe) => history.record("Edit pattern", () => clip.midi.edit(recipe)), // one Undo step per grid edit
  position: () => (workspace.playing.value ? beatInClip() : null), // optional playhead, beats from the clip start
});
mountStepGrid(root, { sequencer: model });
```

Each lane is one pitch and each step one slot of `beatsPerBar / stepsPerBar` beats. A step's velocity is the velocity of the lane-pitch note nearest that slot, 0 when there is none. Writing a velocity above 0 adds a note of one step's length (`noteLength`) at the slot or updates the existing one; writing 0 removes the slot's notes. Offset and length edit that note's start (up to half a step either way) and duration (1/16 to 4 steps). Repeat, pitch and chance have no MIDI counterpart: they read 1, 0 and 1 and ignore writes, as do lane rate, swing, direction and the length box (the lane length is `stepsPerBar * bars`). `muted` and `solo` are grid-local flags the app may read. Assigning `lane.pattern` (a string such as `"X...x..."` or velocities) is one commit.

Every change calls `edit(recipe)` once with a draft note array, so the wrapper decides undo and persistence; without `edit` the source's own `edit` is used (a `MidiClip` or `clip.midi`). Reads come from `source.notes`, so notes changed by anything else (a piano roll, an undo, an import) redraw the grid. Notes beyond the lane length, or between slots, are left untouched and not shown. Only a note whose pitch is a lane pitch appears. The model imports `@audiorective/midi` types and no DAW code.

## Mixer markup and extension controls

`mountMixer` ships no stylesheet. Style `.mixer` (root), `.mixer-strip` (strip), `.master` (master strip), `.strip-name` (button when onSelect exists, otherwise span), `.strip-actions`, buttons `.mute`/`.solo`, active `.on`, strip `.selected`, and `.ar-level-meter`. Each track carries `data-track-id`. Style these hooks inside your own container. A master exists only when masterVolume and editMaster are both present.

`appendControls(id, strip)` appends your app's routing row or parameter widget and may return cleanup. Rows are keyed and remain mounted across state updates/reordering, so extensions keep subscriptions/focus. The strip cleanup releases your extension; when you independently remove an extension early, run that cleanup then too. Keep returned cleanup idempotent. Meter cleanup is independent: `{ source, dispose? }` lets a caller disconnect its own PCM analyser when its meter disappears. Callback meters read existing dBFS; no buffer or analyser is needed.

## Plain player adapters

### Pick an adapter

`mountPlayer(root, { player, renderer?, label? })` accepts a `PlayerLike`. Use the matching adapter or pass a Workspace's `player` directly.

| Adapter                    | Controls                 | Position and duration                                                                           | Playback failure reported                                |
| -------------------------- | ------------------------ | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `fromFilePlayer(player)`   | Play/Pause, seek, volume | Reactive `currentTime` and `duration`; unknown length is supported                              | A blocked or rejected `audio.play()` and a missing track |
| `fromWavePlayer(player)`   | Play/Pause, seek, volume | Audio clock while playing; paused seeks and committed versions update the view                  | Missing/loading audio and a rejected play request        |
| `fromBufferPlayer(player)` | Play/Stop, volume        | No seek bar or time readout: `BufferPlayer` exposes no persistent playhead or reactive duration | Missing audio or a closed context                        |
| `workspace.player`         | Play/Pause, seek         | Project seconds, reactive duration and position changes from transport actions                  | A rejected `Workspace.play()` request                    |

When opening or creating a Workspace for speaker playback, pass `{ destination: context.destination }`. For an existing graph, route `workspace.output` from the app. See [DAW playback controls](./daw.md#mount-playback-controls).

`FilePlayer.play()` rejects like `HTMLMediaElement.play()` (`NotAllowedError` for an autoplay block), and the adapter passes that rejection to the view, which shows a notice. A play request made elsewhere rejects to its own caller; the widget reports only its own attempts. `BufferPlayer` starts from the beginning after Stop. For a seekable in-memory track, use `WavePlayer`.

`PlayerLike` is structural, so an app's own player can supply `isPlaying: Readable<boolean>`, `play()`, and `pause()`. Optional `volume` has a writable `.value`; optional `timeline` supplies `position()`, `duration: Readable<number>`, and `seek(seconds)` when seeking is possible. Set `timeline.clock: true` when position advances without reactive writes; the widget reads it per animation frame only while playing. Optional `subscribe(listener)` reports other changes that tracked values miss. `resumes: false` changes the active button label to Stop. Adapters hold no state and need no disposal.

### Player interaction and renderer

An unknown, zero, negative or non-finite duration displays `--:--` and disables seeking; it re-enables when a finite positive duration arrives. During a drag, incoming time updates do not move the thumb or time text. The player seeks once on release, and the view follows it again. If the duration shrinks during the drag, the committed position is clamped to the latest duration; a track change that makes seeking unavailable cancels the drag. A failed play requested by this view shows a notice; the notice clears when playback starts. `AbortError` from an interrupted request is ignored.

Pass `renderer: PlayerRenderer` to replace the markup while keeping these interaction rules. The factory receives `(container, actions)` and returns `{ render(frame), dispose?() }`. Wire controls to `actions.toggle()`, `hold()`, `scrub(seconds)`, `commit()`, `cancel()`, and `setVolume(value)`. The widget sends one `PlayerFrame` with `isPlaying`, `resumes`, `position`, `duration`, `canSeek`, `scrubbing`, `volume`, and `notice`. `position`, `duration`, `volume` and `notice` can be `null`; numeric fields are finite when present. `render(frame)` runs initially and after state changes. Set an input's `max` before `value`, or the browser can clamp a resumed position to the old maximum. A renderer's `dispose()` releases any resources it created outside its container.

`PlayerActions`, `PlayerFrame`, `PlayerRenderer`, `PlayerRendererInstance`, `PlayerOptions`, `PlayerHandle`, `PlayerTimeline`, `PlayerLike`, and `WritableValue` are exported types from this entry. `PlayerOptions.label` sets the control group's accessible name; its default is `"Player"`.

`formatTime(seconds)` returns `m:ss`, with minutes unwrapped and seconds floored; `null` or a non-finite value returns `--:--`. The default renderer uses `ar-player-*` classes and `--player-font`, `--player-foreground`, `--player-accent`, and `--player-error` CSS variables. Its markup is an implementation detail; use a renderer when an app needs particular elements or text.

## Arrangement gestures

`@audiorective/widgets/arrangement` borrows caller-rendered DOM. The app owns keyed clip elements, lane appearance, selection, compatible-track hit testing and history. The widget owns gesture listeners, capture, local preview and one command per finished edit; it creates no AudioContext, Project or rendering engine.

```typescript
import { attachClipGesture } from "@audiorective/widgets/clip";

const clipOrigins = new Map<string, { time: number; trackId: string }>();
let originRevision: number | undefined;
function findClipOrigin(id: string) {
  const revision = project.cells.revision.value;
  if (revision !== originRevision) {
    clipOrigins.clear();
    for (const track of project.tracks) for (const clip of track.clips) clipOrigins.set(clip.id, { time: clip.time, trackId: track.id });
    originRevision = revision;
  }
  return clipOrigins.get(id);
}

const gesture = attachClipGesture(clipElement, {
  clipId,
  origin: () => findClipOrigin(clipId),
  timeUnit: clipKind === "midi" ? "beats" : "seconds",
  timeMap: {
    secondsToBeat: (seconds) => project.tempoMap.secondsToBeat(seconds),
    beatToSeconds: (beat) => project.tempoMap.beatToSeconds(beat),
    snapSeconds: (seconds) => project.tempoMap.snapSeconds(seconds),
  },
  pixelsPerSecond: () => scale.value,
  trackAt: (clientX, clientY) => findCompatibleTrackAt(clientX, clientY),
  onSelect: () => selectClip(clipId),
  onOpen: () => openClipEditor(clipId),
  onMove: ({ clipId, trackId, time }) => {
    history.record("Move clip", () => project.moveClip(clipId, trackId, time));
  },
});
// Dispose before removing this borrowed element.
gesture.dispose();
```

`onSelect` runs at pointerdown, before the drag. Update the selected styling in place there: replacing the clip element ends the gesture.

Each mounted clip re-evaluates its tracked `origin()` when Project changes. Build a clip-ID index once per revision and use constant-time lookups; avoid searching every track separately for every clip. If the app replaces the Project object, invalidate that index as well. Document-level Escape listeners exist only during active drags.

The supplied Project owns the source state; the getter rereads its current clip instead of capturing a stale position. It is tracked and returns undefined when the clip is unavailable. Actual origin time/track changes cancel a stale drag. Pointer drags freeze their origin; every keyboard nudge reads the latest owner origin. Left/Right move one beat, Shift four; Alt bypasses pointer snapping. `origin.time` and `onMove.time` use `timeUnit` (seconds by default, or beats); pointer geometry stays in seconds through the structural time map (`secondsToBeat`, `beatToSeconds`, `snapSeconds`). Keep the same element after committing a nudge so focus survives. Escape, pointercancel, lost capture and dispose commit no move.

A running Workspace applies light Project edits automatically. The widget never calls Project itself and has no DAW package dependency. If the app deliberately removes/rebuilds the element, dispose its attachment first; a live origin getter cannot preserve focus through caller-owned DOM replacement.

### Timeline zoom

```typescript
import { attachTimelineZoom } from "@audiorective/widgets/arrangement";

const zoom = attachTimelineZoom({
  viewport,
  ruler: () => currentRuler(),
  slider, // borrowed native range input, including default min/max
  getScale: () => scale.value, // the app's existing tracked pixels-per-second owner
  onScale: (next) => {
    scale.value = next;
    redrawArrangement();
  },
});
// Optional controls: zoom.zoomBy(1.45); zoom.zoomTo(fitScale, clientX);
// Switching projects: zoom.cancel(); removing this view: zoom.dispose();
```

Ctrl/⌘+wheel retains the project time under the pointer; slider zoom retains the viewport center. Redraws are batched to animation frames, and `ruler()` returns the current axis element after a redraw. `getScale` tracks existing owner state, so external scale changes update slider/ARIA in place without focus loss. The helper configures its slider's logarithmic coordinate, including native defaults. Default limits are 2–2000 px/s, configurable by minScale/maxScale. `zoomTo` and `zoomBy` accept an optional **browser client X** anchor. `labels: { scale(pixelsPerSecond) }` localizes default aria text `<n> px/s`. A plain mutable local variable does not become reactive merely because a callback reads it.

### Timeline range gesture

`attachTimeRangeGesture(element, { timeAt, onPreview, onSelect })` borrows a dedicated time surface. `timeAt(clientX, bypassSnap)` resolves scrolling, zoom, bounds and snapping; Alt sets bypassSnap. It previews ordered `[start, end]` and calls onSelect once on release of a nonempty range. Clicks and canceled gestures clear preview. Escape, capture loss and disposal select nothing. Use `touch-action: none` on a surface supporting touch drag. The app stores/uses the result and converts seconds to beats itself when needed; dispose before replacing the element.

### Bar ruler

```typescript
import { mountBarRuler, attachTimelineZoom } from "@audiorective/widgets/arrangement";

const ruler = mountBarRuler(rulerRow, {
  tempoMap: () => project.tempoMap, // re-read in an effect: a tempo edit redraws
  signature: () => project.signature, // default [4, 4]
  pixelsPerSecond: () => scale.value,
  duration: () => workspace.duration,
  viewport: scroller, // optional: draw only the visible bars; a scroll redraws
  playhead: () => workspace.position.value, // optional line, seconds or null
  onSeek: (seconds) => workspace.seek(seconds), // optional: a click, not a drag
});
attachTimelineZoom({ viewport: scroller, ruler: () => ruler.element, getScale: () => scale.value, onScale });
// ruler.refresh() after scrolling by script; ruler.dispose() removes the element.
```

A bar is `numerator * 4 / denominator` quarter-note beats and a beat tick is one `1/denominator` note, placed through `tempoMap.beatToSeconds`, so bars after a tempo change sit at their real positions. Bar lines are drawn from 4 px per bar, beat ticks from 7 px per beat. A bar's label shows when its one-based bar number divides by the smallest power of two that keeps labels `minLabelSpacing` (56) px apart, measured at that bar, so labels stay put while scrolling. `labels: { bar(n) }` replaces the number. `signature` is one signature for the whole song; a meter change mid-song is not drawn. Invalid options throw at mount; a later invalid value (scale 0) draws nothing. The ruler never calls the Project or the Workspace: snapping a seek is the app's `onSeek`.

## Timeline clips

`@audiorective/widgets/clip` holds the three gestures and drawings an audio clip element needs on a timeline: `attachClipGesture` (move), `attachClipTrim` (edge trim) and `attachClipWaveform` (the played window as a thumbnail). It is the one import path for `attachClipGesture`. Each function borrows a caller-owned element, returns `{ dispose() }`, and stays free of any DAW import: it takes structural contracts, and your code connects them to `Project`.

```typescript
import { cell, effect } from "@audiorective/core";
import { attachClipGesture, attachClipTrim, attachClipWaveform } from "@audiorective/widgets/clip";
import type { AudioClip } from "@audiorective/daw";

const timeMap = {
  secondsToBeat: (seconds: number) => project.tempoMap.secondsToBeat(seconds),
  beatToSeconds: (beat: number) => project.tempoMap.beatToSeconds(beat),
  snapSeconds: (seconds: number) => project.tempoMap.snapSeconds(seconds),
};
// Tracked: reading the revision makes every getter below re-run after a Project edit.
const audioClip = (): AudioClip | undefined => {
  project.cells.revision.value;
  const clip = project.tracks.flatMap((track) => track.clips).find((item) => item.id === clipId);
  return clip?.kind === "audio" ? clip : undefined;
};

// An in-memory clip's `channels` already begin at its window, so sourceOffset is 0 and `clip` itself is the PCM.
// A file-backed clip has no PCM in memory: ask its media for a bounded peak summary of the window.
const peaks = cell<{ min: Float32Array; max: Float32Array; duration: number } | undefined>(undefined);
const stopPeaks = effect(() => {
  const clip = audioClip();
  if (!clip?.media) return;
  const { media, startFrame, frameCount } = clip;
  void media.peaks(startFrame, frameCount).then((summary) => {
    const current = audioClip();
    if (current?.media === media && current.startFrame === startFrame && current.frameCount === frameCount) peaks.value = summary;
  });
});
const waveform = attachClipWaveform(element, {
  clip: () => {
    const clip = audioClip();
    if (!clip) return undefined;
    const data = clip.media ? peaks.value : clip;
    return data && { data, sourceOffset: 0, duration: clip.duration };
  },
});

const trim = attachClipTrim(element, {
  origin: () => {
    const clip = audioClip();
    return clip && { time: clip.time, duration: clip.duration };
  },
  timeMap,
  pixelsPerSecond: () => scale.value,
  snap: (seconds) => project.tempoMap.snapSeconds(seconds),
  // Audio edges stay inside the recording; resizeClip would throw beyond it.
  bounds: () => {
    const clip = audioClip();
    if (!clip) return {};
    const start = clip.time - clip.sourceOffset;
    return { start, end: start + clip.sourceLength };
  },
  onCommit: (edges) => {
    project.edit("Trim clip", () => void project.resizeClip(clipId, edges));
  },
});

const move = attachClipGesture(element, {
  /* clipId, origin, timeMap, trackAt, onMove ... as in Arrangement gestures */
});
// Removing the element: dispose all three first, then stopPeaks().
```

`attachClipWaveform(element, { clip })` draws only the window `[sourceOffset, sourceOffset + duration)` of `clip().data`, which is PCM (`{ channels, sampleRate }`) or min/max peaks (the shape `mountWaveform` takes). It fills the element with no toolbar, ruler or padding, matches device pixels, redraws when the tracked source or the element's size changes, and uses `--waveform-accent` and `--waveform-border`. It treats PCM as immutable, caching its peak summary per first channel array. It makes a `static` element `position: relative`; `undefined` clears the drawing.

`attachClipTrim(element, options)` appends an `ar-clip-trim ar-clip-trim-start|end` handle (6 px wide, `--ar-clip-trim-size` resizes it) to each edge in `edges` (default both). Dragging previews by changing the element's `left` and `width`, so the element must be absolutely positioned (as `attachClipGesture` also assumes) and `pixelsPerSecond()` must be the same scale that lays the clip out. Each handle is at most a third of a narrow clip's width (minimum 2 px), so both edges stay reachable. `snap(time)` and `bounds()` work in `timeUnit` (seconds by default; `"beats"` with the same `timeMap` as `attachClipGesture`); Alt bypasses snap while dragging. `onCommit({ start?, end? })` runs once per finished drag with absolute timeline positions: exactly what `project.resizeClip` takes, and only the edge that changed. Escape, pointercancel, capture loss, a changed `origin()` or dispose restore the element and commit nothing; an unchanged edge commits nothing. The handles are focusable: Left/Right move the edge to the next snap position (4 px without `snap`), Shift four steps. Edge pointers stop at the handle, so `attachClipGesture` on the same element never starts a move from an edge, and its body drags still move.

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

Waveform and player classes use the `ar-` prefix. Internal class names and test attributes are implementation details; use the handle and plugin context for behavior. The mixer has separately documented generic [styling hooks](#mixer-markup-and-extension-controls).
