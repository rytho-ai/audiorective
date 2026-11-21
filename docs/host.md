---
title: WebCLAP host
---

`@audiorective/host/webclap` runs one WebCLAP bundle in an `AudioWorklet`. A bundle supplies `module.wasm` and, when present, a webview editor. The caller owns the `AudioContext`, output route, bundle URL, and the editor's iframe. The package includes the worklet host, but no plug-in catalogue. The [DAW demo](../apps/daw-demo/README.md) bundles open-webclap's MIT-licensed Oxo Synth2 as its default instrument.

```typescript
import { effect } from "@audiorective/core";
import { WebClapHost } from "@audiorective/host/webclap";

const host = await WebClapHost.load(context, {
  url: "/plugin/oxo-synth2.wclap",
  pluginId: "com.oxo.music.oxosynth2",
  // Serve the worklet copied from @audiorective/host/dist.
  workletUrl: "/assets/webclap-worklet.js",
});
host.output.connect(mixGain);
const on = host.noteOn(60, { velocity: 0.8, when: context.currentTime + 0.1 });
host.noteOff(60, context.currentTime + 0.5);
// on.cancel() revokes a future event; host.allNotesOff() releases every sounding note and clears scheduled messages.

const state = await host.saveState();
await host.loadState(state);
const detach = host.hasEditor ? await host.mountEditor(iframe) : undefined;
// On teardown: detach?.(); host.dispose();
```

The [DAW demo](../apps/daw-demo/main.ts) uses a relative worklet asset URL. If `workletUrl` is omitted, `WebClapHost.load` resolves it beside its published JS module. Serve the worklet and bundle from the app's origin. `noteOn`, `noteOff` and `scheduleMidi` take absolute `AudioContext` seconds and return a handle for Clock's `window.own(handle, when)`. A host declares plug-in latency through `AudioProcessor.latency`, in samples (the plug-in's reported latency). Applications using raw `.connect()` own any path delay compensation.

## Play notes

`WebClapHost` has the same note methods as a core `Sampler`, so it is an `Instrument` for [`MidiClip` and `MidiKeyboard`](./midi.md) (`new MidiClip(notes, { instrument: host })`, `MidiKeyboard.open(context, { instrument: host })`) with no adapter.

- `noteOn(note, { velocity?, when?, channel? })` sends a MIDI note-on: `note` is an integer 0-127, `velocity` 0..1 (default 1), `when` absolute AudioContext seconds (default now), `channel` 0-15 (default 0). It returns the cancellable event.
- `noteOff(note, when?)` releases `note` at `when` (default now) on every channel it was started on.
- `scheduleMidi(bytes, when)` sends any other raw message (controllers, program change, pitch bend); use the note methods for notes.
- `allNotesOff()` sends MIDI All Notes Off on every channel and drops scheduled messages not yet played. `dispose()` calls it.

## Parameters and state

`host.params` holds one `Param<number>` per CLAP parameter, keyed by CLAP ID as a decimal string (`host.params["7"]`). Each has `.value`, `$`, `label` (the CLAP name), `min` and `max`; its initial value is the plug-in's value at load. Writing `.value` sends the value to the plug-in. Changes the plug-in reports, such as edits in its editor or its own automation, update the same Param and its observers without being echoed back. `step` is 1 when the plug-in marks the parameter stepped (a choice or switch, so a slider moves in whole numbers) and absent when it is continuous; the Param carries the same `step`. `host.parameterInfo` is the frozen metadata snapshot in the plug-in's order (id, name, a core `ValueRange` as `min` and `max`, `defaultValue`, display `text` and `step`; `host.params[String(info.id)]` is its live Param), tracked and mirrored by `host.cells.parameterInfo`; a plug-in rescan replaces it and an effect reading it re-runs. Read live values from the Params. The registry has the parameter IDs reported at load; parameters the plug-in adds later do not appear in `params`.

```ts
const amount = host.params["2"]; // An ID provided by the plug-in.
const detachControl = host.effect(() => {
  slider.valueAsNumber = amount.value;
});
slider.oninput = () => {
  amount.value = slider.valueAsNumber;
};
// On teardown: detachControl(); slider.oninput = null;
```

`dispose()` and a plug-in `"error"` message clear every pending response timer and reject the callers still waiting on `saveState()`, `loadState()` or `mountEditor()` instead of leaving them to time out. `WebClapEvent` is core's `CancellableEvent`. `saveState()` returns opaque patch bytes. `loadState(bytes)` waits for matching readback and applies reported parameter values to the existing Params so controls reflect the loaded patch.

## Select a device in a bundle

Pass `pluginId` to select the exact CLAP descriptor from one `module.wasm`. Without it, `pluginIndex` selects by factory order and defaults to 0. Workspace uses the saved CLAP ID when it opens a project.

The worklet accepts one imported WASM32 memory alongside function imports and allocates the size and sharing mode declared by the module. The Signalsmith Basics example bundle has been tested in Chromium with its shared memory and more than one descriptor, including patch save and reopen on a Workspace return. This validates the tested bundle and host path. [WebCLAP example bundles](https://github.com/WebCLAP/examples)

This first host covers one AudioWorklet instance per plug-in, MIDI note/control input, stereo audio output, CLAP state and the webview bridge. It has been exercised with Oxo Synth2 and, in a browser compatibility probe, [WebCLAP's Clack Gain Example](https://github.com/WebCLAP/examples/tree/main/clack): a 0.2-amplitude oscillator passed through the effect at volume 1 and fell to zero when its volume parameter was set to 0. Other ports, effect input layouts, multi-bus routing and arbitrary CLAP extensions still require compatibility testing.

## Common errors

Repeated editor mounting, state requests after disposal, pending requests interrupted by disposal and MIDI scheduling after disposal use `DOMException` with `name === "InvalidStateError"`. Worklet response expiry and state-confirmation exhaustion use `name === "TimeoutError"`. Numeric MIDI limits retain `RangeError`; HTTP and plug-in failures remain ordinary `Error`. In the MIDI error row, the same message also reports an already disposed host; create a new host before scheduling.

| Message                                                                                                                                                             | Cause and fix                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WebCLAP bundle HTTP …`                                                                                                                                             | `module.wasm` was not served at `<bundle URL>/module.wasm`; check the URL and deployment assets.                                                                                      |
| `WebCLAP host response timed out.`                                                                                                                                  | The worklet or plug-in did not answer; check worklet loading, WASM compatibility and browser console errors.                                                                          |
| `WebCLAP state did not settle after load.`                                                                                                                          | The plug-in did not report the requested state; keep its original state bytes and check the bundle/version.                                                                           |
| `WebCLAP state needs bytes.`                                                                                                                                        | Pass opaque state to `loadState()` as a `Uint8Array`.                                                                                                                                 |
| `WebCLAP plug-in has no editor.`                                                                                                                                    | The CLAP plug-in has no webview; show parameters or a generic editor instead.                                                                                                         |
| `WebCLAP editor is already mounted.`                                                                                                                                | Detach the current iframe before mounting another one.                                                                                                                                |
| `WebCLAP note must be an integer 0-127.`                                                                                                                            | `noteOn()` or `noteOff()` got a non-integer or out-of-range note. Pass a MIDI note number 0-127.                                                                                      |
| `WebCLAP velocity must be 0..1.`                                                                                                                                    | `noteOn()` velocity is outside 0..1 (not a MIDI 0-127 byte). Pass a fraction.                                                                                                         |
| `WebCLAP channel must be an integer 0-15.`                                                                                                                          | `noteOn()` channel is outside 0-15.                                                                                                                                                   |
| `WebCLAP MIDI needs a finite non-negative audio time.`                                                                                                              | Schedule with an absolute, non-negative `AudioContext` time.                                                                                                                          |
| `WebCLAP parameter needs a finite value.`                                                                                                                           | `host.params[id].value` was set to NaN or Infinity; the Param reverts to its last good value. Pass a finite number within `min`..`max`.                                               |
| `WebCLAP plug-in error: …`                                                                                                                                          | The plug-in reported an error while a `saveState()`, `loadState()` or `mountEditor()` call was pending; the message follows the colon. Check the plug-in's console output and bundle. |
| `WebCLAP host is disposed.`                                                                                                                                         | Create a new host instance before requesting state or opening an editor. Pending `saveState()`/`loadState()`/`mountEditor()` calls reject with this message when `dispose()` runs.    |
| `WebCLAP bundle has no plug-in with ID …` / `WebCLAP bundle has no plug-in at index …`                                                                              | Check the bundle's descriptor IDs or the zero-based index.                                                                                                                            |
| `WebCLAP supports one imported memory alongside function imports.` / `WebCLAP imported memory must use WASM32 limits.` / `WebCLAP memory import could not be read.` | Use a compatible WebCLAP WASM32 build with its supported imports.                                                                                                                     |
| `WebCLAP returned an invalid string pointer.`                                                                                                                       | The plug-in returned invalid metadata. Check the bundle and try a compatible build.                                                                                                   |
