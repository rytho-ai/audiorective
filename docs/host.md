---
title: WebCLAP host
---

`@audiorective/host/webclap` runs one WebCLAP bundle in an `AudioWorklet`. A bundle supplies `module.wasm` and, when present, a webview editor. The caller owns the `AudioContext`, output route, bundle URL, and the editor's iframe. The package includes the worklet host, but no plug-in catalogue. The [DAW demo](../apps/daw-demo/README.md) bundles open-webclap's MIT-licensed Oxo Synth2 as its default instrument.

```typescript
import { effect } from "@audiorective/core";
import { WebClapHost } from "@audiorective/host/webclap";

const host = await WebClapHost.load(context, {
  url: "/plugin/oxo-synth2.wclap",
  // Serve the worklet copied from @audiorective/host/dist.
  workletUrl: "/assets/webclap-worklet.js",
});
host.output.connect(mixGain);
const noteOn = host.scheduleMidi([0x90, 60, 100], context.currentTime + 0.1);
host.scheduleMidi([0x80, 60, 0], context.currentTime + 0.5);
// noteOn.cancel() revokes a future event; host.panic() clears scheduled notes.

// Every CLAP parameter is a Param<number>, keyed by its CLAP id as a string.
const [info] = host.parameterInfo; // frozen metadata: id, name, min, max, defaultValue, text
const cutoff = host.params[String(info.id)];
cutoff.value = 0.5; // forwarded to the plug-in
effect(() => console.log(cutoff.value)); // tracks edits made in the plug-in's own editor too

const state = await host.saveState();
await host.loadState(state);
const detach = host.hasEditor ? await host.mountEditor(iframe) : undefined;
// On teardown: detach?.(); host.destroy();
```

The `workletUrl` above is illustrative; the [DAW demo](../apps/daw-demo/main.ts) uses a relative asset URL from its source file. If omitted, `WebClapHost.load` resolves the worklet beside its published JS module. Serve the worklet and bundle from the same origin as the app. `scheduleMidi` uses absolute `AudioContext` seconds and returns a cancellable handle compatible with Clock's `window.own(handle, when)`.

`host.params` holds one `Param<number>` per CLAP parameter, keyed by CLAP id as a decimal string (`host.params["7"]`). Each has `.value`, `$`, `label` (the CLAP name), `min` and `max`; its initial value is the plug-in's value at load. Writing `.value` sends the value to the plug-in; value changes the plug-in reports, such as edits in its editor or its own automation, update the same Param without being echoed back. `host.parameterInfo` is the frozen metadata snapshot (including `defaultValue` and display `text`), tracked and mirrored by `host.cells.parameterInfo`; the plug-in's rescan replaces it, and an effect reading it re-runs. Parameters the plug-in adds after load do not appear in `params`. `saveState()` returns opaque CLAP state bytes; `loadState(bytes)` waits for state readback to match before resolving. A host declares its CLAP latency through `AudioProcessor.latency`, but applications using raw `.connect()` must perform their own path delay compensation.

This first host covers one AudioWorklet instance per plug-in, MIDI note/control input, stereo audio output, CLAP state and the webview bridge. It has been exercised with Oxo Synth2 and, in a browser compatibility probe, [WebCLAP's Clack Gain Example](https://github.com/WebCLAP/examples/tree/main/clack): a 0.2-amplitude oscillator passed through the effect at volume 1 and fell to zero when its volume parameter was set to 0. Other ports, effect input layouts, multi-bus routing and arbitrary CLAP extensions still require compatibility testing.

## Common errors

| Message                                                | Cause and fix                                                                                                                           |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| `WebCLAP bundle HTTP …`                                | `module.wasm` was not served at `<bundle URL>/module.wasm`; check the URL and deployment assets.                                        |
| `WebCLAP host response timed out.`                     | The worklet or plug-in did not answer; check worklet loading, WASM compatibility and browser console errors.                            |
| `WebCLAP state did not settle after load.`             | The plug-in did not report the requested state; keep its original state bytes and check the bundle/version.                             |
| `WebCLAP state needs bytes.`                           | Pass opaque state to `loadState()` as a `Uint8Array`.                                                                                   |
| `WebCLAP plug-in has no editor.`                       | The CLAP plug-in has no webview; show parameters or a generic editor instead.                                                           |
| `WebCLAP editor is already mounted.`                   | Detach the current iframe before mounting another one.                                                                                  |
| `WebCLAP MIDI needs a finite non-negative audio time.` | Schedule with an absolute, non-negative `AudioContext` time.                                                                            |
| `WebCLAP parameter needs a finite value.`              | `host.params[id].value` was set to NaN or Infinity; the Param reverts to its last good value. Pass a finite number within `min`..`max`. |
| `WebCLAP host is destroyed.`                           | Create a new host instance before requesting state or opening an editor.                                                                |
