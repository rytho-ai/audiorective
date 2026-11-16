# @audiorective/widgets

Framework-independent browser widgets for plain playback controls, waveform selection and MIDI views.

## Plain player

```typescript
import { FilePlayer } from "@audiorective/core";
import { fromFilePlayer, mountPlayer } from "@audiorective/widgets/player";

const context = new AudioContext();
const player = new FilePlayer(context, { src: "/music/track.mp3" });
player.output.connect(context.destination);
const controls = mountPlayer(document.querySelector<HTMLElement>("#player")!, {
  player: fromFilePlayer(player),
});
// controls.destroy() removes this view; playback and the caller-owned player continue.
```

Adapters also support `WavePlayer` and `BufferPlayer`. A custom renderer replaces the markup while keeping playback, drag, unknown-duration and cleanup behavior. See the [plain player reference](../../docs/widgets.md#plain-player-controls).

## Waveform

```typescript
import { mountWaveformSelector } from "@audiorective/widgets";

const context = new AudioContext();
const selector = mountWaveformSelector(document.querySelector<HTMLElement>("#waveform")!, {
  context,
  source: "/audio/loop.wav",
});
selector.output.connect(context.destination);
try {
  await selector.ready;
} catch (error) {
  console.error(selector.getState().error, error);
}
// selector.destroy() on unmount; the caller still owns the context.
```

The selector includes URL/File loading with shared phase/byte progress and cancellation, zoom, scrolling, range handles, keyboard adjustment, optional beat snapping, and playback controls. Drag a new range to audition it; programmatic selection updates do not initiate playback. The caller supplies the `AudioContext` and routes `output`.

`getState().loadProgress` comes from the block. `selector.cancelLoad()` or Cancel loading stops the current load; retry with `load()`. Known byte totals support a fraction; decode, peaks and unknown totals stay indeterminate.

For headless control or multiple views, create a `WavePlayer` from `@audiorective/blocks` and pass `{ player }` instead of `{ context }`. Selectors read the same audio and selection owner; each retains its own renderer, zoom and snap settings. Route the shared output once. Destroying a view leaves a supplied player alive; the caller destroys it after all views are finished.

Selectors display the shared player's committed `version.peaks`, without scanning PCM for each view. A pending stretch keeps the previous waveform visible; successful edits preserve same-source zoom and map scrolling. `getState()` includes `processing`, `stretchRatio`, `revision`, and `sourceDuration`. Selection, position and renderer coordinates use committed output seconds. Selector beat grids are supplied in original source seconds and mapped to output after edits.

For peaks, an external playhead, metadata-only selection, or custom visual plugins, import `mountWaveform` and `createSelectionPlugin` from `@audiorective/widgets/waveform`. That entry creates no audio context or nodes. It may use the pure `@audiorective/core/peaks` helper, while importing no audio-runtime or audio-player implementation. The pure selection plugin's `setGrid({ beats, downbeats })` uses current-view seconds; applications map original source times explicitly.

Both mount functions accept a `renderer` factory to replace waveform drawing with your own SVG, Canvas, or DOM. It receives a drawing container and returns `render(frame)` plus optional `destroy()`. The widget keeps zoom, coordinates, selection, and playback; the renderer owns only its drawing.

See the [widget reference](../../docs/widgets.md) for public types, loading and cleanup behavior, plugin examples, and styling.

For offline edits, pass a `WavePlayer` configured with a borrowed stretch processor and call `await player.setStretch(ratio)`. See the [complete composition example](../../docs/blocks.md#compose-offline-stretch-and-a-selector) for caller-hosted WASM, routing, URL/File errors and cleanup.

## Piano roll

Import `mountPianoRoll` from `@audiorective/widgets/piano-roll` for MIDI notes, a piano keyboard, source-time range selection, beat snapping, zoom/scroll and an external playhead. Pass a shared `MidiSequence` or structural model. Each view borrows data and selection, owns its renderer/viewport, and creates no audio nodes. `layout` replaces keyboard, toolbar and arrangement around the supplied widget viewport. `onNoteEdit` enables widget-owned move/edge-resize previews and a single model-command commit; custom renderers forward pointerdown to the frame handler. `renderer` replaces note drawing; `onNoteClick` connects your inspector and model editing controls. `view.attach(plugin)` accepts the same `WaveformPlugin` as waveform views, providing time coordinates, overlays, notifications and attachment-owned cleanup. See [MIDI and Piano Roll](../../docs/midi.md).
