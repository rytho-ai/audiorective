---
title: Widgets
---

`@audiorective/widgets` mounts browser views over your existing audio and model owners. A view reads tracked values and sends edits through the owner's commands. Call its `dispose()` when removing it; borrowed playback, authored data and audio routing remain with your app.

| Job                                           | View / entry                                                                                |
| --------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Playback bar, long track or stream            | `mountPlayer`, `@audiorective/widgets/player`                                               |
| Load, select and audition a clip              | `mountWaveformSelector`, widgets root                                                       |
| Draw existing peaks without audio             | `mountWaveform`, `@audiorective/widgets/waveform`                                           |
| Edit MIDI notes                               | `mountPianoRoll`, `@audiorective/widgets/piano-roll`; [MIDI](./midi.md)                     |
| Steps, pads, scenes, meters and clip controls | Widgets root                                                                                |
| Gestures over app-rendered arrangement DOM    | `@audiorective/widgets/arrangement`; [advanced](./widgets-advanced.md#arrangement-gestures) |

Mount behind a client-only boundary in an app that also renders on the server. These views need the DOM; the audio-independent waveform and piano-roll entries create no audio context or nodes. Try the [waveform showroom](/showroom/waveform) or [piano-roll showroom](/showroom/piano-roll). See [Widgets: advanced](./widgets-advanced.md) for custom renderers, plugins, time projections and full interaction details.

## Mount a selector

Pass a shared [WavePlayer](./player.md) when the app owns playback. Route its output once in the app. Each view keeps its own zoom, drawing and snap settings while observing the same selection and load state.

```typescript
import { mountWaveformSelector } from "@audiorective/widgets";

// player is the app-owned WavePlayer; its output is already routed.
const selector = mountWaveformSelector(root, {
  player,
  controls: false,
  audition: false,
  onSelectionChange: (selection) => console.log(selection),
});
selector.setZoom(2);
selector.setAmplitudeZoom(4);
selector.scrollTo(1); // committed output seconds
const viewport = selector.getViewport();
// When this view closes:
selector.dispose(); // leaves player, selection, playback and pending loads alive
```

`controls` and `audition` default to true and are independent. `controls: false` hides source/playback controls while retaining the waveform and status. Pointer selection previews stay local until release, when one edit updates the shared owner. Escape, pointer cancellation, capture loss, view removal or external owner replacement cancel that preview. With `audition: false`, completed range edits change metadata and clicks seek without starting playback. With default audition, drawing/resizing a range auditions it in a loop and clicking seeks and plays; clicking outside a selection clears it. Programmatic selection and keyboard edits do not start a stopped player. Handles move by 0.01 seconds with arrow keys, or 0.1 with Shift.

For a selector-owned player, supply `createPlayer: () => new WavePlayer(context)` instead of `player`. The app supplies and closes the context; the selector owns and disposes only the player it creates. Connect `selector.output` to your destination or effects. Playback gestures resume the supplied context. Supply optional `source: string | File` or call `load`; loading does not start playback. Catch `ready` and `load` rejections. `cancelLoad()` cancels the shared player's load, whereas detaching a borrowed view leaves it running.

Selection callbacks, viewport, playhead and renderer times use committed **output seconds**. Selector `grid: { beats, downbeats }` uses **original source seconds**, remapped after edits. Snap starts off; Alt bypasses pointer snapping. [Full selector API and loading](./widgets-advanced.md#selector-api) cover committed revisions and custom structural owners.

<a id="interaction"></a>
<a id="selector-api"></a>
<a id="loading-feedback"></a>
<a id="displaying-committed-edits"></a>

[Selector API, loading and revisions](./widgets-advanced.md#selector-api) describe the full handle and source/output mapping.

## Plain player controls

Use a [FilePlayer](./core.md#fileplayer) for a long track or stream; a control bar does not decode a waveform. Given an existing player:

```typescript
import { fromFilePlayer, mountPlayer } from "@audiorective/widgets/player";

const controls = mountPlayer(root, { player: fromFilePlayer(player) });
// controls.dispose() removes only this view; the caller still owns player.
```

Adapters support `FilePlayer`, `WavePlayer` and `BufferPlayer`; a Workspace's `player` fits directly. The view shows only available seek/volume controls. Unknown duration displays `--:--` and disables seek until a positive finite duration arrives. A scrub freezes the shown position, seeks once on release and cancels when seeking becomes unavailable. Play failures requested by the view appear as a notice, including autoplay blocks; requests elsewhere report to their own caller. `AbortError` is ignored. [Adapters and custom player renderers](./widgets-advanced.md#plain-player-adapters) describe the structural contract and actions.

<a id="pick-an-adapter"></a>
<a id="interaction-and-renderer"></a>

[Adapter and renderer contracts](./widgets-advanced.md#plain-player-adapters) include unknown duration, scrub actions and notices.

## Parameter controls and metering

Bind a slider, fader or knob directly to a numeric `.value`. `mountParameter(root, { param, orientation, scale, min, max, step, label, format })` follows tracked changes and uses parameter metadata when options are omitted. `orientation` is `horizontal`, `vertical` or `rotary`; log scale needs a positive minimum. Home/End set endpoints; arrows adjust; drag a knob vertically and use Shift for finer movement. For an app-owned command, a structural `value` getter reads the tracked owner and its setter invokes the command.

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
const peak = mountLevelMeter(meters, {
  source: () => channel.cells.level.value, // tracked post-fader peak in dBFS
});
```

Use the callback for an existing dBFS peak such as Channel's `cells.level`; `-Infinity` means silence. The view samples the callback once per animation frame; it need not read tracked state and creates no analyser or synthetic samples. `NaN` displays silence; `+Infinity` displays full scale with overload. `getLevel()` returns **linear amplitude** `{ peak, rms }`; `rms` is `null` when the source supplies only a scalar peak.

When the app already has genuine PCM to analyse, pass a PCM source:

```typescript
import { mountLevelMeter } from "@audiorective/widgets";

const pcm = mountLevelMeter(meters, {
  source: {
    sampleCount: analyser.fftSize,
    read: (samples) => analyser.getFloatTimeDomainData(samples),
  },
});
```

`sampleCount` defaults to 2048. PCM snapshots measure mono sample peak and RMS, including values above full scale. The caller owns the analyser and route. `dispose()` stops the view's sampling loop and leaves the audio owner alive.

## Mixer controls

`mountMixer` binds volume and pan to a `Readable<MixerState>`, then sends `Partial<MixerStripSettings>` to `editTrack`. Omit `muted` or `solo` when that control is unsupported; the widget creates neither solo logic nor routing. Master needs both `state.masterVolume` and `editMaster`. Track/master volume spans 0..1.5, pan -1..1.

Project arrays can be projected without a mirrored writable store:

```typescript
import { readonlyCell } from "@audiorective/core";
import { mountMixer } from "@audiorective/widgets";

const mixer = mountMixer(root, {
  state: readonlyCell(() => {
    void workspace.project.cells.revision.value;
    return { tracks: workspace.project.tracks, masterVolume: workspace.project.masterVolume };
  }),
  editTrack(id, patch) {
    if (patch.volume !== undefined) workspace.setTrackVolume(id, patch.volume);
    if (patch.pan !== undefined) workspace.setTrackPan(id, patch.pan);
    if (patch.muted !== undefined) workspace.setTrackMuted(id, patch.muted);
    if (patch.solo !== undefined) workspace.setTrackSolo(id, patch.solo);
  },
  editMaster: (gain) => workspace.setMasterVolume(gain),
});
```

`MixerStripSettings` is `{ volume, pan, muted?, solo? }`; `MixerStrip` adds stable `id` and `name`; `MixerState` has `tracks` and optional `masterVolume`. `meter(id)` receives a track ID, or `null` for a mounted master, and returns `{ source, dispose? }`. The source is the same per-animation-frame dBFS callback or genuine PCM reader accepted by `mountLevelMeter`. Optional caller cleanup runs when that meter is removed. Rows and controls keep their identity across owner updates and reorder. `onSelect`, tracked `selected`, labels and `appendControls` support app-specific controls; [markup and extension lifetime](./widgets-advanced.md#mixer-markup-and-extension-controls) list the public styling hooks.

## Automation lane

`mountAutomationLane` edits caller-owned curve snapshots. Give `points` an object with a tracked readonly `.value`; an `AutomationCurve` fits directly. `duration` is a tracked getter. The lane keeps its mounted controls synchronized, with local previews until one `onCommit` per finished gesture.

```typescript
import { mountAutomationLane } from "@audiorective/widgets";

// curve is the existing AutomationCurve; length is the owner's tracked beat length.
const lane = mountAutomationLane(root, {
  points: curve,
  duration: () => length.value,
  timeUnit: "beats",
  maxValue: 1.5,
  defaultValue: 1,
  onCommit(next) {
    try {
      curve.value = next;
    } catch (error) {
      showEditError(error);
    } // caller-owned notice for owner validation
  },
});
```

`timeUnit` is `seconds` by default or `beats`; time fields, labels and picker use that unit. The widget performs no beat/second conversion. Click to add or drag to move a point; the picker allows exact time/value, linear/hold and deletion. The first pointer edit after zero anchors the default at zero. Escape, pointer cancellation, capture loss, external point replacement or disposal discard stale previews without a commit. External updates retain control DOM and focus. Owner updates flow through `.value`; the handle only needs `dispose()`. `AutomationCurve` requires a nonempty curve: deleting its final point is an owner validation error. Report the rejection or apply your own owner policy. Generic array owners may accept an empty list. A refused or throwing command restores the source values without replacing controls.

For Project arrays, pass `points: readonlyCell(() => { void project.cells.revision.value; return currentTrack().volumeAutomation; })` and commit with `project.setVolumeAutomation(trackId, next)`. Read the latest track rather than a captured array. A running Workspace applies light Project edits automatically; [DAW](./daw.md) covers flush/error handling.

## Automation overlay

`view.attach(createAutomationOverlay({ points, fromView, toView, defaultValue, maxValue, onCommit }))` uses the same readonly-value source over a waveform or other time view. Supply inverse conversions between the view's time unit and the owner's curve time; pass the **original curve**, not preconverted points. Optional readable `disabled` gates editing. Double-click adds; drag/arrows move; Enter toggles linear/hold; Delete removes. Optional `snap` receives view time, with Alt bypass. Finished gestures commit once; cancellation and external replacement leave authored data intact and preserve mounted identity. See [one curve in two views](./widgets-advanced.md#one-curve-in-two-time-views) for mapping and competing tools.

## Clip envelope editor

`mountClipEnvelopeEditor(root, { duration: () => currentClip().duration, envelope, onChange })` edits linear `{ gain, fadeIn, fadeOut }` in clip-local seconds. Use a tracked readonlyCell projection for a Project envelope and commit through `project.setAudioClipEnvelope(clipId, next)`. Tracked duration changes update fade limits in place; combined fades are limited to the current duration. External envelope changes refresh the same fields. `labels` localizes them; `dispose()` removes only the editor's observer and DOM. The Project's ClipEnvelope shape fits directly.

```typescript
import { readonlyCell } from "@audiorective/core";
import { mountClipEnvelopeEditor } from "@audiorective/widgets";

// currentAudioClip() reads the current tracked clip, not an old snapshot.
const inspector = mountClipEnvelopeEditor(inspectorRoot, {
  duration: () => currentAudioClip().duration,
  envelope: readonlyCell(() => currentAudioClip().envelope ?? { gain: 1, fadeIn: 0, fadeOut: 0 }),
  onChange: (next) => project.setAudioClipEnvelope(clipId, next),
});
```

The caller retains its Project and history.

## Sample browser

`mountSampleBrowser(root, { library, choose, onError, labels? })` accepts a [SampleLibrary](./samples.md#sample-library) directly. The structural library reads `state` (`rows`, `previewId`, `previewPlaying`) and supplies `preview`, `stopPreview`, `remove`. The app owns file input and placement. In `choose(id)`, acquire the buffer, retain or copy it to the destination, then release the lease. Disposing the browser leaves the borrowed library and preview alive.

```typescript
import { mountSampleBrowser } from "@audiorective/widgets";

const browser = mountSampleBrowser(browserRoot, {
  library, // the app-owned SampleLibrary, directly
  choose: useSample, // app command: acquire, place/copy, then release the lease
  onError: reportError,
});
// browser.dispose() releases this view; library and preview remain available.
```

## Step grid and pads

`mountStepGrid(root, { sequencer, formatStep?, labels?, laneLabel? })` accepts a [StepSequencer](./sequencer.md) directly, or the structural `StepGridSequencer` lane contract. It edits lane headers and per-step velocity, offset, length, repeat, pitch, chance and custom params; Fold hides inactive lanes. Arrow keys navigate; Enter/Space toggle; Up/Down edit, PageUp/PageDown use coarse steps. All step indices passed to `formatStep(label, step)` and plugin helpers are **zero-based**: use `${label} step ${step + 1}` for visible numbering. Removing the view leaves its sequencer alive.

For a per-step helper, attach a `StepGridPlugin` with `context.onCell(cell => ...)`. Each cell supplies its tracked `step`, `laneId`, zero-based `stepIndex`, a dedicated positioned `root`, and scoped `listen`/`onCleanup`. Geometry and cleanup follow the cell automatically. Read step fields inside a core effect and register its disposer with `cell.onCleanup`; write authored changes through `cell.step`. [Step grid plugins](./widgets-advanced.md#step-grid-plugins) show the attachment and full keyboard, theme and structural contracts.

`mountPadGrid(root, { pads, press })` calls `press(id)` for pointer or focused keyboard input. Return a release callback for that specific press when the sound is gated; return nothing for a one-shot. Releases run on key/pointer release, focus loss and destruction. The app owns mapping and sound.

<a id="step-grid-plugins"></a>

[Per-cell and toolbar plugins](./widgets-advanced.md#step-grid-plugins) use scoped public attachment contexts.

## Clip Grid

`mountClipGrid(root, { launcher, launch?, cancel?, labels? })` renders buttons for an app-owned scene layout over an `@audiorective/launcher` `ClipLauncher` (or `workspace.session.value`), read through its cells and driven through its commands. Use `setLayout({ tracks, scenes })` when the grid changes: `tracks` are `{ track, label }` and each scene is `{ label, clips: [{ track, clip, label }] }` with at most one clip per track, where `track` and `clip` are the launcher's `Track` and `Clip` objects. The widget exposes `data-clip-state` as `idle`, `queued` or `active` for theming and keeps button state in sync with the launcher's `playing` and `queued` cells. The quantize of every launch is `launcher.quantize`, which the app owns.

**Scope.** The grid is a plain table of buttons: a scene button per row (`launcher.launchScene(clips)`), a button per clip (`clip.launch()`), Cancel for all queued launches (`launcher.cancelQueued()`), a return-all button (`launcher.stopAll()`) and a `↩` per track (`track.stop()`). `data-clip-state` is its only visual state. It has no playback progress, per-clip colours, one-shot marker, gate or repeat press handling (`release()`), and no keyboard model beyond focusable buttons. For a performance grid that needs any of those, read the same launcher cells (`clip.playing`, `clip.queued`, `clip.position`, `launcher.queued`) and build the grid in your framework; the launcher is the contract, not the widget.

`launch(command)` wraps every command a button issues (an app can start playback first); `cancel()` replaces the Cancel button's `launcher.cancelQueued()`. The widget's `dispose()` removes its own DOM and subscription. See the [DAW example](./daw.md#clip-launcher) for wiring.

## Spectrum and EQ editor

`mountSpectrum(root, { sampleRate, fftSize, read })` projects borrowed FFT dB values onto a log-frequency axis. A Web Audio analyser can supply the values through `read: (bins) => analyser.getFloatFrequencyData(bins)`. The reader receives `fftSize / 2` entries. The widget releases its animation frame on destruction. The caller owns the analyser and its audio connection.

`mountEqEditor(root, { bands, readResponse })` edits borrowed numeric controls. Each band has a stable ID, label and reactive `frequency`, with optional `gain` and `q` controls. Pass a response function that fills **linear magnitudes** at the supplied frequencies. Drag or use Left and Right to change frequency. Gain-enabled bands also use vertical movement and Up or Down. Page Up, Page Down and the wheel adjust Q when supplied. The widget can run against standalone Params and generated analysis data, or it can borrow feedback from [the DAW runtime](./daw.md#effect-rack).

## Warp markers

`view.attach(createWarpMarkers({ anchors, sampleRate, sourceFrames, sourceFrameAt, onCommit, disabled? }))` edits borrowed source/output frame pairs on a seconds view. The public `WaveStretchAnchor` is the player's type. Pass the existing `ReadonlyCell<readonly WaveStretchAnchor[]>` as `anchors`, or project an owner array with `readonlyCell(() => currentAnchors())`. Supply output-seconds-to-source-frame mapping and commit through the owner; the app performs audio processing and owns undo. [Warp editing](./widgets-advanced.md#warp-markers) covers gestures and composition.

## Use the waveform without audio

`mountWaveform(root, { data, playhead?, label?, renderer? })` accepts precomputed peaks or an existing AudioBuffer and creates no audio graph. `setData` replaces data; `setPlayhead` follows an external player. The handle has the same viewport, zoom, amplitude and scroll operations exposed by the selector. [Waveform and selection APIs](./widgets-advanced.md#waveform-api) cover data shapes and metadata selection. For MIDI views use [MIDI and Piano Roll](./midi.md); piano-roll times are beats.

<a id="waveform-api"></a>
<a id="selection-plugin-api"></a>
<a id="replace-waveform-drawing"></a>
<a id="piano-roll"></a>
<a id="write-a-visual-plugin"></a>
<a id="timeline-range-gesture"></a>

Continue with [waveform/selection](./widgets-advanced.md#waveform-api), [custom drawing](./widgets-advanced.md#replace-waveform-drawing), [piano roll](./widgets-advanced.md#piano-roll), [visual plugins](./widgets-advanced.md#write-a-visual-plugin) or [arrangement range gestures](./widgets-advanced.md#timeline-range-gesture).

## Style

Default waveform styles mount with the widget. Set `--waveform-accent` on its host; [all theme variables](./widgets-advanced.md#style) and step-grid properties are listed in advanced. Mixer ships no stylesheet and keeps its documented generic CSS hooks; [style the mixer](./widgets-advanced.md#mixer-markup-and-extension-controls) within your own container.

## Common errors

| Frequency widget message                                            | Fix                                                                                                       |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `Frequency plot needs increasing frequency and decibel ranges.`     | Supply positive ordered frequencies and increasing dB limits.                                             |
| `Spectrum needs a valid FFT size and a range within Nyquist.`       | Pass a power-of-two FFT size from 32 through 32768 and limit the upper frequency to half the sample rate. |
| `EQ editor needs unique band IDs and increasing positive Q limits.` | Supply unique IDs and finite positive Q bounds in increasing order.                                       |

| Control message                                                                           | Fix                                                                                                                  |
| ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `Parameter control needs a finite increasing range and a positive minimum for log scale.` | Provide a finite increasing range, above zero for log scale.                                                         |
| `Parameter control step must be positive.`                                                | Supply a finite positive step, or omit it.                                                                           |
| `Automation overlay needs a positive maximum and an in-range default.`                    | Provide a positive finite maximum and a default between zero and that maximum.                                       |
| `Warp markers need a positive sample rate and source frame count.`                        | Supply both from the clip's source.                                                                                  |
| `Warp markers need a seconds time view.`                                                  | Mount on a seconds-based waveform.                                                                                   |
| `Level meter sample count must be a positive integer.`                                    | Set `source.sampleCount` to the positive integer buffer length needed by a PCM reader; omit it for the 2048 default. |

Messages thrown by the plain player adapters, waveform view, its plugins and the complete selector. Waveform loading and playback messages come from the borrowed player: see [WavePlayer](./player.md#common-errors).

| Message                                                        | Cause                                                                                 | Fix                                                                                                                                                  |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FilePlayer has no src to play.` (`NotSupportedError`)         | The plain player view requested FilePlayer playback with no `src`                     | Set `player.src` before pressing Play.                                                                                                               |
| `Timeline zoom needs a positive increasing scale range.`       | Invalid arrangement zoom limits                                                       | Use finite positive `minScale` and a larger `maxScale`.                                                                                              |
| `No audio is loaded.`                                          | A WavePlayer or BufferPlayer adapter has no buffer                                    | Load audio before pressing Play.                                                                                                                     |
| `Audio is still loading.`                                      | The WavePlayer adapter was asked to play before loading finished                      | Await `player.load(...)`.                                                                                                                            |
| `The audio context is closed.`                                 | The BufferPlayer adapter cannot start a closed context                                | Create a new context and player.                                                                                                                     |
| `Waveform selector is disposed.`                               | Calling `load` or `setSelection` after cleanup                                        | Mount a new selector.                                                                                                                                |
| `Waveform is disposed.`                                        | Mutating a disposed waveform or attaching after waveform or selector cleanup          | Mount a new view or selector.                                                                                                                        |
| `Waveform data needs finite peaks and a positive duration.`    | Invalid peaks or duration                                                             | Supply nonempty finite peaks, matching extrema arrays, and finite positive seconds.                                                                  |
| `Zoom must be finite and at least 1.`                          | Invalid zoom factor                                                                   | Use `1` to fit, or a larger finite factor.                                                                                                           |
| `Amplitude zoom must be finite and from 1 to 32.`              | Invalid display-only amplitude factor                                                 | Pass a finite factor from `1` through `32`.                                                                                                          |
| `Playhead must be finite or null.`                             | Invalid playhead                                                                      | Supply finite source seconds or `null` to hide it.                                                                                                   |
| `Plugin is already attached to this waveform.`                 | Duplicate attachment of one instance                                                  | Reuse its attachment or detach it before attaching again.                                                                                            |
| `Step grid has no parameter "…".`                              | `setActiveParameter` with an id that is not a tab                                     | Use `velocity`, `offset`, `length`, `repeat`, `pitch`, `chance` or a declared custom param id.                                                       |
| `Step grid is disposed.`                                       | Attaching a plugin to a disposed step grid                                            | Mount a new grid.                                                                                                                                    |
| `Plugin is already attached to this step grid.`                | Duplicate attachment of one plugin instance                                           | Detach it first, or create one plugin per grid.                                                                                                      |
| `Step grid cell is disposed.`                                  | An internal per-cell attachment host was reused after cleanup.                        | Use a live grid attachment. If this appears through normal `onCell` calls, report the reproduction; cell contexts expose no public attach operation. |
| `Plugin is already attached to this step grid cell.`           | An internal per-cell host received a duplicate attachment.                            | Report a reproduction from the live grid/plugin. Reusing `onCell` callbacks does not require managing this private host.                             |
| `Plugin attachment is disposed.`                               | Mounting an overlay from a disposed attachment                                        | Stop asynchronous work during cleanup; use a live attachment context.                                                                                |
| `Selection plugin is not attached.`                            | Setting metadata before attachment or after detach                                    | Call `view.attach(selection)` before `selection.setSelection`.                                                                                       |
| `Selection plugin is already attached.`                        | Reusing a selection plugin across live views                                          | Detach first, or create one plugin per view.                                                                                                         |
| `Waveform already has a Selection owner.`                      | Multiple selection plugins on one view                                                | Keep one selection plugin per view.                                                                                                                  |
| `Automation lane needs a positive duration and maximum value.` | `duration()` returned a zero, negative or non-finite value, or `maxValue` is invalid. | Return finite `duration()` and supply finite `maxValue` above 0.                                                                                     |
| `Automation lane needs a 2D canvas.`                           | The browser could not create a 2D canvas context for the lane.                        | Mount in a browser with canvas support; headless DOM stubs need a 2D context.                                                                        |
