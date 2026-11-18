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
const noteOn = host.scheduleMidi([0x90, 60, 100], context.currentTime + 0.1);
host.scheduleMidi([0x80, 60, 0], context.currentTime + 0.5);
// noteOn.cancel() revokes a future event; host.panic() clears scheduled notes.

const state = await host.saveState();
await host.loadState(state);
const detach = host.hasEditor ? await host.mountEditor(iframe) : undefined;
// On teardown: detach?.(); host.destroy();
```

The [DAW demo](../apps/daw-demo/main.ts) uses a relative worklet asset URL. If `workletUrl` is omitted, `WebClapHost.load` resolves it beside its published JS module. Serve the worklet and bundle from the app's origin. `scheduleMidi` takes absolute `AudioContext` seconds and returns a handle for Clock's `window.own(handle, when)`. A host declares plug-in latency through `AudioProcessor.latency`. Applications using raw `.connect()` own any path delay compensation.

## Parameters and state

`host.params` holds one `Param<number>` per CLAP parameter, keyed by CLAP ID as a decimal string (`host.params["7"]`). Each has `.value`, `$`, `label` (the CLAP name), `min` and `max`; its initial value is the plug-in's value at load. Writing `.value` sends the value to the plug-in. Changes the plug-in reports, such as edits in its editor or its own automation, update the same Param and its observers without being echoed back. `host.parameterInfo` is the frozen metadata snapshot (id, name, min, max, `defaultValue` and display `text`), tracked and mirrored by `host.cells.parameterInfo`; a plug-in rescan replaces it and an effect reading it re-runs. Read live values from the Params. The registry has the parameter IDs reported at load; parameters the plug-in adds later do not appear in `params`.

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

`saveState()` returns opaque patch bytes. `loadState(bytes)` waits for matching readback and applies reported parameter values to the existing Params so controls reflect the loaded patch.

## Select a device in a bundle

Pass `pluginId` to select the exact CLAP descriptor from one `module.wasm`. Without it, `pluginIndex` selects by factory order and defaults to 0. Workspace uses the saved CLAP ID when it opens a project.

The worklet accepts one imported WASM32 memory alongside function imports and allocates the size and sharing mode declared by the module. The Signalsmith Basics example bundle has been tested in Chromium with its shared memory and more than one descriptor, including patch save and reopen on a Workspace return. This validates the tested bundle and host path. [WebCLAP example bundles](https://github.com/WebCLAP/examples)

This first host covers one AudioWorklet instance per plug-in, MIDI note/control input, stereo audio output, CLAP state and the webview bridge. It has been exercised with Oxo Synth2 and, in a browser compatibility probe, [WebCLAP's Clack Gain Example](https://github.com/WebCLAP/examples/tree/main/clack): a 0.2-amplitude oscillator passed through the effect at volume 1 and fell to zero when its volume parameter was set to 0. Other ports, effect input layouts, multi-bus routing and arbitrary CLAP extensions still require compatibility testing.

## Common errors

| Message                                                                                                                                                             | Cause and fix                                                                                                                           |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `WebCLAP bundle HTTP …`                                                                                                                                             | `module.wasm` was not served at `<bundle URL>/module.wasm`; check the URL and deployment assets.                                        |
| `WebCLAP host response timed out.`                                                                                                                                  | The worklet or plug-in did not answer; check worklet loading, WASM compatibility and browser console errors.                            |
| `WebCLAP state did not settle after load.`                                                                                                                          | The plug-in did not report the requested state; keep its original state bytes and check the bundle/version.                             |
| `WebCLAP state needs bytes.`                                                                                                                                        | Pass opaque state to `loadState()` as a `Uint8Array`.                                                                                   |
| `WebCLAP plug-in has no editor.`                                                                                                                                    | The CLAP plug-in has no webview; show parameters or a generic editor instead.                                                           |
| `WebCLAP editor is already mounted.`                                                                                                                                | Detach the current iframe before mounting another one.                                                                                  |
| `WebCLAP MIDI needs a finite non-negative audio time.`                                                                                                              | Schedule with an absolute, non-negative `AudioContext` time.                                                                            |
| `WebCLAP parameter needs a finite value.`                                                                                                                           | `host.params[id].value` was set to NaN or Infinity; the Param reverts to its last good value. Pass a finite number within `min`..`max`. |
| `WebCLAP host is destroyed.`                                                                                                                                        | Create a new host instance before requesting state or opening an editor.                                                                |
| `WebCLAP bundle has no plug-in with ID …` / `WebCLAP bundle has no plug-in at index …`                                                                              | Check the bundle's descriptor IDs or the zero-based index.                                                                              |
| `WebCLAP supports one imported memory alongside function imports.` / `WebCLAP imported memory must use WASM32 limits.` / `WebCLAP memory import could not be read.` | Use a compatible WebCLAP WASM32 build with its supported imports.                                                                       |
| `WebCLAP returned an invalid string pointer.`                                                                                                                       | The plug-in returned invalid metadata. Check the bundle and try a compatible build.                                                     |
