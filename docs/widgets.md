---
title: Widgets
---

Try the [waveform showroom](/showroom/waveform) for a working selector, or the [piano-roll showroom](/showroom/piano-roll) for shared MIDI views. See [MIDI and Piano Roll](./midi.md) for `mountPianoRoll` from the audio-independent `@audiorective/widgets/piano-roll` entry.

`@audiorective/widgets` provides browser DOM widgets that mount into an element and return an imperative handle. Use `mountPlayer` for ordinary playback controls without a waveform, `mountWaveformSelector` for loading audio, selecting a range, and auditioning it, or the audio-independent `@audiorective/widgets/waveform` entry for a waveform driven by your own data and playback position.

For a DAW arrangement with caller-rendered clips, `@audiorective/widgets/arrangement` exports `attachClipGesture(element, options)`. It borrows a clip element and owns pointer capture, click versus drag, snapped preview, cancellation, and one move commit on release. Arrow Left/Right moves one musical beat; Shift moves four. Pass a structural time map such as `project.tempoMap`; Alt bypasses pointer snapping. `onMove` receives a move intent, so the caller applies its own Project edit, and history; a running `Workspace` applies the Project edit by itself.

```typescript
import { attachClipGesture } from "@audiorective/widgets/arrangement";

const gesture = attachClipGesture(clipElement, {
  clipId: clip.id,
  trackId: track.id,
  time: clip.time,
  timeUnit: clip.kind === "midi" ? clip.timeUnit : "seconds",
  timeMap: project.tempoMap,
  pixelsPerSecond: () => zoom,
  trackAt: (x, y) => findCompatibleTrackAt(x, y),
  onSelect: () => selectClip(clip.id),
  onOpen: () => openClipEditor(clip.id),
  onMove: ({ clipId, trackId, time }) => {
    history.record("Move clip", () => project.moveClip(clipId, trackId, time));
  },
});

// Before removing the element:
gesture.destroy();
```

The caller renders lanes and clip appearance, supplies compatible track hit testing, and keeps shared selection/history. `time` and `onMove.time` use `timeUnit` (seconds by default, or beats); the widget converts through `timeMap` for its second-based pointer geometry and beat keyboard nudges. The widget never creates an AudioContext or changes the Project by itself. This interaction entry has no dependency on `@audiorective/workspace`.

`attachTimelineZoom` from the same entry owns continuous zoom gestures over a caller-rendered time axis. It connects an optional range input and Ctrl/⌘+wheel, keeps the project time under the pointer (or viewport center for the slider), and batches redraws to animation frames. The caller supplies `getScale()` in pixels per project second and `onScale(next)` to redraw its arrangement; `ruler()` returns the current time-axis element after that redraw. Buttons can call `zoom.zoomBy(1.45)` and fit-to-project can call `zoom.zoomTo(scale, leftEdgeX)`. Call `zoom.cancel()` when switching projects and `zoom.destroy()` when removing the view. The default range is 2–2000 pixels per second; `minScale` and `maxScale` can change it.

The widgets implement their own waveform display and interaction. They require no UI framework or WaveSurfer dependency. The selector uses [WavePlayer](./blocks.md) for audio and selection. Pass a shared `player`, or supply `context` to let the selector own one. Its public audio connection is `handle.output`.

## Parameter controls and metering

`mountParameter(root, { param, orientation, scale, min, max, step, label, format })` binds directly to a borrowed numeric `.value`. Use horizontal for a slider, vertical for a fader, or rotary for a knob. The control follows tracked changes such as native parameter automation. It uses parameter metadata when explicit options are omitted. Use a positive minimum for log scaling. Home and End set the range endpoints; arrow keys adjust the value. Drag a knob up or down and hold Shift for smaller movement.

```typescript
import { mountParameter, mountLevelMeter } from "@audiorective/widgets";

const cutoff = mountParameter(controls, {
  param: filter.params.frequency,
  orientation: "rotary",
  scale: "log",
  min: 20,
  max: 20_000,
  step: 1,
  label: "Cutoff",
  format: (value) => `${Math.round(value)} Hz`,
});
const level = mountLevelMeter(meters, {
  sampleCount: analyser.fftSize,
  read: (samples) => analyser.getFloatTimeDomainData(samples),
});
// cutoff.destroy() and level.destroy() release just the views.
```

For app-owned commands, supply a structural getter that reads the current tracked value and a setter that calls the command. `mountLevelMeter()` reports mono sample peak and RMS per snapshot, including samples over full scale. Call `destroy()` to stop the sampling loop. The caller owns the analyser and audio routing.

## Clip envelope editor

`mountClipEnvelopeEditor(root, { duration, envelope, onChange })` exposes linear gain, fade-in and fade-out fields for a caller-owned reactive envelope. It commits changes in clip-local seconds and limits the combined fade length to `duration`. Use its `labels` option to localize the controls. The widget updates when the borrowed state changes and tears down its own observer on `destroy()`.

## Automation overlay

`view.attach(createAutomationOverlay({ points, fromView, toView, defaultValue, maxValue, onCommit }))` layers a borrowed curve over a waveform or other time view. Supply a reactive `points` reader and increasing inverse time conversions. The overlay follows zoom and scroll. Double-click to add a point, drag to move it, or use the arrow keys on a focused point. Enter switches between linear and hold. Delete removes the point. An optional `snap` function receives view time, and Alt bypasses it. Dragging commits once on release and cancels on Escape or data replacement.

The attachment owns its gesture and drawing. The caller owns the points and playback. For a project clip, derive the conversion from [the clip's source window](./workspace.md#clip-gain-automation) and pass updates to Project in `onCommit`. Supply optional `viewBreakpoints` at slope changes in a piecewise mapping.

## Warp markers

`view.attach(createWarpMarkers({ anchors, sampleRate, sourceFrames, sourceFrameAt, onCommit }))` mounts a seconds-view marker editor. `anchors` is a reactive reader of source/output frame pairs. Supply a conversion from waveform seconds to source frames for new markers. Double-click to add a marker, drag it to change its output position, or move a focused marker with the arrow keys. Shift increases the keyboard step. Delete removes a marker and Escape cancels a drag. The view commits on release and renders neighboring markers in order. It borrows the anchors and leaves audio processing and undo to the caller.

## Spectrum and EQ editor

`mountSpectrum(root, { sampleRate, fftSize, read })` projects borrowed FFT dB values onto a log-frequency axis. A Web Audio analyser can supply the values through `read: (bins) => analyser.getFloatFrequencyData(bins)`. The reader receives `fftSize / 2` entries. The widget releases its animation frame on destruction. The caller owns the analyser and its audio connection.

`mountEqEditor(root, { bands, readResponse })` edits borrowed numeric controls. Each band has a stable ID, label and reactive `frequency`, with optional `gain` and `q` controls. Pass a response function that fills **linear magnitudes** at the supplied frequencies. Drag or use Left and Right to change frequency. Gain-enabled bands also use vertical movement and Up or Down. Page Up, Page Down and the wheel adjust Q when supplied. The widget can run against standalone Params and generated analysis data, or it can borrow feedback from [Workspace](./workspace.md#effect-rack).

## Step grid and pads

`mountStepGrid(root, { sequencer })` edits the provided pattern's velocities and displays its current step. Click a step to toggle and focus it to adjust its velocity. Destroying the view leaves the borrowed pattern available.

`mountPadGrid(root, { pads, press })` turns pointer or focused keyboard presses into calls to `press(id)`. A one-shot callback returns nothing. For a gated sound, return a release callback for that specific press. The widget releases held inputs on key or pointer release, focus loss and destruction. It leaves the audio engine and pad mapping with the caller.

## Sample browser

`mountSampleBrowser(root, { library, choose, onError, labels? })` renders a borrowed [Sample Library](./blocks.md#sample-library). The caller supplies file input and placement. On `choose(id)`, acquire the buffer, copy or retain it in the destination and release the lease when finished. `destroy()` removes the view, leaving audition and imports available to the caller.

## Mixer controls

`mountMixer(root, { state, editTrack, editMaster, output? })` binds volume, pan, mute and solo controls to an external mixer state. Give it a `Readable<MixerState>` and apply edits in the owner. To display meters, return each track's post-fader `AudioNode` from `output(id)` and the master from `output(null)`. The widget detaches only its own analysis branches and reactive subscription on `destroy()`. Add app-specific routing controls with `appendControls(id, element)`, whose optional return value cleans up that strip.

With Workspace, read `project.cells.revision` when projecting `project.tracks` and `project.masterVolume`. Bind the edit callbacks to [Workspace mixer methods](./workspace.md#mixer-buses-and-sends). The same view can borrow a different mixer as long as it supplies the same state and actions.

## Timeline range gesture

`attachTimeRangeGesture(element, { timeAt, onPreview, onSelect })` from `@audiorective/widgets/arrangement` attaches a drag to an existing time surface. Your `timeAt(clientX, bypassSnap)` resolves scrolling, zoom, bounds and snapping. The widget supplies `bypassSnap` while Alt is pressed. It previews an ordered `[start, end]` and calls `onSelect` once when the pointer releases a nonempty range. Clicks and cancelled gestures clear the preview. Call `destroy()` when replacing the borrowed element.

Use a dedicated surface with `touch-action: none` when dragging also needs to work on touchscreens. The app decides how to store or use the returned bounds. The DAW demo converts project seconds to beats before setting its loop.

## Automation lane

`mountAutomationLane(root, options)` draws and edits an envelope in project seconds. Pass `duration`, `maxValue`, `defaultValue`, `points` and an `onCommit(next)` callback. Click to add a point or drag a point to move it. The point picker and fields allow precise time and value edits, linear or hold interpolation, and deletion. The first pointer edit after time zero anchors the default value at zero. Each completed gesture emits one replacement point list. A cancelled drag keeps the prior points.

```typescript
import { mountAutomationLane } from "@audiorective/widgets";

const lane = mountAutomationLane(root, {
  duration: 16,
  maxValue: 1.5,
  defaultValue: 1,
  points: track.volumeAutomation,
  onCommit(next) {
    project.setVolumeAutomation(track.id, next);
    lane.setPoints(project.tracks.find(({ id }) => id === track.id)!.volumeAutomation);
    void workspace.commit().catch(reportError);
  },
});
// On hide or teardown:
lane.destroy();
```

The caller owns the envelope, applies undo and redo, and calls `setPoints()` with the accepted points after each edit or external change. Use a positive finite duration and maximum value. Otherwise the mount reports `Automation lane needs a positive duration and maximum value.` A browser without a 2D canvas reports `Automation lane needs a 2D canvas.`.

## Clip Grid

`mountClipGrid(root, { state, launch, cancel, labels? })` renders buttons for an app-owned scene layout. Supply a reactive `ClipLauncherState` from Blocks or Workspace and a callback that handles the whole launch group. Use `setLayout({ tracks, scenes })` when the grid changes. Give each scene a label and at most one clip per track. The widget exposes `data-clip-state` as `idle`, `queued` or `active` for theming and keeps button state in sync with the borrowed launcher.

The return buttons request `clipId: null` for the affected tracks. The widget's `destroy()` removes its own DOM and subscription. See the [Workspace example](./workspace.md#clip-launcher) for wiring and launch timing.

## Plain player controls

`@audiorective/widgets/player` mounts Play/Pause, position, duration and volume controls on a caller-owned player. It works without waveform decoding, so use `FilePlayer` for long tracks, podcasts and streams. The widget borrows the player: removing the controls leaves playback and the audio graph running.

```typescript
import { FilePlayer } from "@audiorective/core";
import { fromFilePlayer, mountPlayer } from "@audiorective/widgets/player";

const context = new AudioContext();
const player = new FilePlayer(context, { src: "/music/track.mp3" });
player.output.connect(context.destination);

const controls = mountPlayer(document.querySelector<HTMLElement>("#player")!, {
  player: fromFilePlayer(player),
});

// When this view is removed:
controls.destroy(); // playback continues; the caller still owns player and context
// At the end of the app's audio lifetime: player.destroy(); await context.close();
```

Call `mountPlayer` in a browser, behind a client-only boundary when the app also renders on a server. The caller routes and starts its audio context. A single player can drive several views; each view keeps only its own drag and error display state. `destroy()` is idempotent and removes DOM, effects, subscriptions and animation frames without stopping or destroying the player.

### Pick an adapter

`mountPlayer(root, { player, renderer?, label? })` accepts a `PlayerLike`. Use the matching adapter or pass a Workspace's `player` directly.

| Adapter                    | Controls                 | Position and duration                                                                           | Playback failure reported                                |
| -------------------------- | ------------------------ | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `fromFilePlayer(player)`   | Play/Pause, seek, volume | Reactive `currentTime` and `duration`; unknown length is supported                              | A blocked or rejected `audio.play()` and a missing track |
| `fromWavePlayer(player)`   | Play/Pause, seek, volume | Audio clock while playing; paused seeks and committed versions update the view                  | Missing/loading audio and a rejected play request        |
| `fromBufferPlayer(player)` | Play/Stop, volume        | No seek bar or time readout: `BufferPlayer` exposes no persistent playhead or reactive duration | Missing audio or a closed context                        |
| `workspace.player`         | Play/Pause, seek         | Project seconds, reactive duration and position changes from transport actions                  | A rejected `Workspace.play()` request                    |

When opening or creating a Workspace for speaker playback, pass `{ destination: context.destination }`. For an existing graph, route `workspace.output` from the app. See [Workspace playback controls](./workspace.md#mount-playback-controls).

`FilePlayer.play()` deliberately resolves for browser autoplay blocks. Its adapter calls the documented `player.audio.play()` escape hatch to display the actual failure; the player's cells still follow the element. A failed play request made elsewhere cannot be inferred by this widget. `BufferPlayer` starts from the beginning after Stop. For a seekable in-memory track, use `WavePlayer`.

`PlayerLike` is structural, so an app's own player can supply `isPlaying: Readable<boolean>`, `play()`, and `pause()`. Optional `volume` has a writable `.value`; optional `timeline` supplies `position()`, `duration: Readable<number>`, and `seek(seconds)` when seeking is possible. Set `timeline.clock: true` when position advances without reactive writes; the widget reads it per animation frame only while playing. Optional `subscribe(listener)` reports other changes that tracked values miss. `resumes: false` changes the active button label to Stop. Adapters hold no state and need no disposal.

```typescript
import type { Readable } from "@audiorective/core";

interface PlayerLike {
  readonly isPlaying: Readable<boolean>;
  play(): void | Promise<void>; // throw or reject when playback cannot start
  pause(): void;
  readonly resumes?: boolean; // false means Stop, then Play starts over
  readonly volume?: { readonly $: () => number; value: number };
  readonly timeline?: {
    position(): number; // current seconds; tracked reads update the widget
    readonly clock?: boolean; // reread per frame while playing
    readonly duration: Readable<number>;
    seek?(seconds: number): void;
  };
  subscribe?(listener: () => void): () => void;
}
```

### Interaction and renderer

An unknown, zero, negative or non-finite duration displays `--:--` and disables seeking; it re-enables when a finite positive duration arrives. During a drag, incoming time updates do not move the thumb or time text. The player seeks once on release, and the view follows it again. If the duration shrinks during the drag, the committed position is clamped to the latest duration; a track change that makes seeking unavailable cancels the drag. A failed play requested by this view shows a notice; the notice clears when playback starts. `AbortError` from an interrupted request is ignored.

Pass `renderer: PlayerRenderer` to replace the markup while keeping these interaction rules. The factory receives `(container, actions)` and returns `{ render(frame), destroy?() }`. Wire controls to `actions.toggle()`, `hold()`, `scrub(seconds)`, `commit()`, `cancel()`, and `setVolume(value)`. The widget sends one `PlayerFrame` with `isPlaying`, `resumes`, `position`, `duration`, `canSeek`, `scrubbing`, `volume`, and `notice`. `position`, `duration`, `volume` and `notice` can be `null`; numeric fields are finite when present. `render(frame)` runs initially and after state changes. Set an input's `max` before `value`, or the browser can clamp a resumed position to the old maximum. A renderer's `destroy()` releases any resources it created outside its container.

`PlayerActions`, `PlayerFrame`, `PlayerRenderer`, `PlayerRendererInstance`, `PlayerOptions`, `PlayerHandle`, `PlayerTimeline`, `PlayerLike`, and `WritableValue` are exported types from this entry. `PlayerOptions.label` sets the control group's accessible name; its default is `"Player"`.

`formatTime(seconds)` returns `m:ss`, with minutes unwrapped and seconds floored; `null` or a non-finite value returns `--:--`. The default renderer uses `ar-player-*` classes and `--player-font`, `--player-foreground`, `--player-accent`, and `--player-error` CSS variables. Its markup is an implementation detail; use a renderer when an app needs particular elements or text.

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
| `attach(plugin: TimeViewPlugin)`                   | Adds an overlay or interaction to the selector's waveform in committed output seconds. Returns a `PluginAttachment`.                                                                                         |
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
view.setAmplitudeZoom(4); // visual height only; original peaks and audio stay unchanged

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
| `setAmplitudeZoom(factor: number)`     | Scales only the displayed waveform height from `1` to `32`; cached peaks and audio remain unchanged.              |
| `getAmplitudeZoom()`                   | Returns the current display-only amplitude factor.                                                                |
| `scrollTo(seconds: number)`            | Scrolls toward a displayed timeline position, clamped to the available range.                                     |
| `attach(plugin: TimeViewPlugin)`       | Returns a `PluginAttachment` with idempotent `destroy()`.                                                         |
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
    render({ peaks, width, height, amplitudeZoom }) {
      svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
      const commands: string[] = [];
      if (peaks) {
        for (let i = 0; i < peaks.max.length; i++) {
          const x = ((i + 0.5) / peaks.max.length) * width;
          const y = ((1 - Math.min(1, peaks.max[i] * amplitudeZoom)) * height) / 2;
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
view.setAmplitudeZoom(4);
// Selection plugins and external playheads work with this drawing too.
// view.destroy() also destroys the renderer.
```

`WaveformRenderFrame` contains `peaks: Readonly<WaveformPeaks> | null`, `width`, `height`, `pixelsPerSecond`, and `amplitudeZoom`. Peaks are cached extrema combined across channels; treat their arrays as read-only. A custom renderer applies `amplitudeZoom` to its drawing if it wants the public amplitude control; the default renderer clips enlarged peaks at the view's top and bottom. Width and height describe the **full scrolling content in CSS pixels**, and a displayed timeline time maps to `seconds * pixelsPerSecond`. `null` means clear the drawing. The widget calls `render` initially and on data, zoom, and size changes. Scrolling is native DOM movement; it does not require redrawing the whole content. Playback position is a separate overlay.

The drawing container is decorative and ignores pointer events. Use plugins for interactive overlays; selection, snapping, ruler, playhead, and audio continue to be owned by the widget. The renderer can change the shape within the same linear time axis; a circular or otherwise different time-coordinate system requires a separate interaction design. Canvas renderers own their backing resolution and device-pixel scaling. A live color/theme change inside a custom renderer is the renderer's responsibility.

The widget calls the returned `destroy()` once, including after an initial `render` failure, and removes the drawing container. Release additional listeners, observers, or timers there. A factory that throws before returning must release its own extra resources; the widget still removes its mounted DOM. Renderer exceptions propagate to the caller on synchronous operations. Cleanup exceptions are logged and do not interrupt the widget's remaining cleanup.

## Write a visual plugin

Use `view.attach(plugin)` for waveform, piano roll, and waveform selector extensions. All three implement `PluginTarget<TimeViewPluginContext>`. The plugin reads `context.timeUnit` to interpret coordinates. Waveform and selector use seconds, with the selector using the current playback version's output seconds. Piano roll uses its configured seconds or beats. The app supplies the appropriate time in each unit.

```typescript
import { mountWaveform, type TimeViewPlugin } from "@audiorective/widgets/waveform";

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
// attachment.destroy() removes just the marker. view.destroy() removes all attachments.
```

`timeToX()` returns content pixels and `clientXToTime()` converts browser pixels back to the view's time unit. Use these helpers to place overlays independently of zoom and scroll. `mountOverlay()`, `onViewportChange()`, `onDataChange()`, `listen()`, and `onCleanup()` return cleanup functions and are disposed with the attachment. A plugin can also return a disposer from `attach()`. Keep per-attachment DOM and state inside `attach()` if the same plugin object will serve multiple views.

`WidgetPlugin<Context>` and `WidgetPluginContext` describe lifecycle and resource cleanup for other context shapes. `TimeViewPlugin` is the specialization for these three time views. `WaveformPlugin` and `WaveformPluginContext` are compatibility exports. For clip movement and timeline zoom on an app-rendered arrangement, use the dedicated arrangement gesture functions above.

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

| Frequency widget message                                            | Fix                                                                                                       |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `Frequency plot needs increasing frequency and decibel ranges.`     | Supply positive ordered frequencies and increasing dB limits.                                             |
| `Spectrum needs a valid FFT size and a range within Nyquist.`       | Pass a power-of-two FFT size from 32 through 32768 and limit the upper frequency to half the sample rate. |
| `EQ editor needs unique band IDs and increasing positive Q limits.` | Supply unique IDs and finite positive Q bounds in increasing order.                                       |

| Control message                                                                           | Fix                                                                            |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `Parameter control needs a finite increasing range and a positive minimum for log scale.` | Provide a finite increasing range, above zero for log scale.                   |
| `Parameter control step must be positive.`                                                | Supply a finite positive step, or omit it.                                     |
| `Automation overlay needs a positive maximum and an in-range default.`                    | Provide a positive finite maximum and a default between zero and that maximum. |
| `Warp markers need a positive sample rate and source frame count.`                        | Supply both from the clip's source.                                            |
| `Warp markers need a seconds time view.`                                                  | Mount on a seconds-based waveform.                                             |
| `Level meter sample count must be a positive integer.`                                    | Supply the length of the float buffer your reader needs.                       |

Messages thrown by the plain player adapters, waveform view, its plugins and the complete selector. Waveform loading and playback messages come from the borrowed player: see [Blocks](./blocks.md#common-errors).

| Message                                                     | Cause                                                                         | Fix                                                                                 |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `No track is loaded.`                                       | The plain player view requested FilePlayer playback with no `src`             | Set `player.src` before pressing Play.                                              |
| `Timeline zoom needs a positive increasing scale range.`    | Invalid arrangement zoom limits                                               | Use finite positive `minScale` and a larger `maxScale`.                             |
| `No audio is loaded.`                                       | A WavePlayer or BufferPlayer adapter has no buffer                            | Load audio before pressing Play.                                                    |
| `Audio is still loading.`                                   | The WavePlayer adapter was asked to play before loading finished              | Await `player.load(...)`.                                                           |
| `The audio context is closed.`                              | The BufferPlayer adapter cannot start a closed context                        | Create a new context and player.                                                    |
| `Waveform selector is destroyed.`                           | Calling `load` or `setSelection` after cleanup                                | Mount a new selector.                                                               |
| `Waveform is destroyed.`                                    | Mutating a destroyed waveform or attaching after waveform or selector cleanup | Mount a new view or selector.                                                       |
| `Waveform data needs finite peaks and a positive duration.` | Invalid peaks or duration                                                     | Supply nonempty finite peaks, matching extrema arrays, and finite positive seconds. |
| `Zoom must be finite and at least 1.`                       | Invalid zoom factor                                                           | Use `1` to fit, or a larger finite factor.                                          |
| `Amplitude zoom must be finite and from 1 to 32.`           | Invalid display-only amplitude factor                                         | Pass a finite factor from `1` through `32`.                                         |
| `Playhead must be finite or null.`                          | Invalid playhead                                                              | Supply finite source seconds or `null` to hide it.                                  |
| `Plugin is already attached to this waveform.`              | Duplicate attachment of one instance                                          | Reuse its attachment or detach it before attaching again.                           |
| `Plugin attachment is destroyed.`                           | Mounting an overlay from a disposed attachment                                | Stop asynchronous work during cleanup; use a live attachment context.               |
| `Selection plugin is not attached.`                         | Setting metadata before attachment or after detach                            | Call `view.attach(selection)` before `selection.setSelection`.                      |
| `Selection plugin is already attached.`                     | Reusing a selection plugin across live views                                  | Detach first, or create one plugin per view.                                        |
| `Waveform already has a Selection owner.`                   | Multiple selection plugins on one view                                        | Keep one selection plugin per view.                                                 |
