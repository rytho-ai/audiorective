# Audiorective DAW demo

From the repository root, build the workspace packages and run:

```sh
pnpm -r build
pnpm --filter @audiorective/daw-demo dev
```

The demo uses a locally bundled MIT-licensed Oxo Synth2 WebCLAP instrument based on [open-webclap](https://github.com/andremichelle/open-webclap). The trial binary came from a fork build with uncommitted changes, documented in `public/plugin/oxo-synth2.wclap/NOTICES.md`; it is not an upstream release artifact. The bundle includes its license and notices. The host worklet in `packages/host/` is an adapted copy of the open-webclap MIT test host.

It starts with a MIDI instrument track and generated audio rhythm tracks. The UI can edit notes, split and trim clips at the playhead, undo and redo clip/note edits, add tracks, upload audio, adjust track volume, record from a Web MIDI input or microphone, open the synth editor, and save/reopen `.dawproject`. Microphone takes stream to temporary OPFS files; the project borrows those files, plays them in chunks, and saves them as portable WAV assets. On supported browsers, Save uses a native file picker and streams the ZIP to disk; the download fallback assembles the ZIP in memory. Temporary takes are deleted when another project opens; page-exit cleanup is best effort, so interrupted sessions may leave OPFS files. The browser panel has a measured input-latency correction in milliseconds for new MIDI and microphone takes; if correction would place a take before project zero, start with preroll. In the lower waveform editor, `時間` changes horizontal zoom, `波高` changes visual amplitude without changing audio gain, and the thin handle above the editor tabs resizes the lower panel. The project file contains CLAP identity/state and an Audiorective bundle URL; it does not embed the WebCLAP bundle, so reopening in a different deployment needs a bundle resolver.

After building the packages, verify the browser workflow with `pnpm --filter @audiorective/daw-demo smoke`. This checks real synth output, pause, editor loading, changed patch state, save/reopen and track creation in Chromium. The **New** button starts an empty 120 BPM, 4/4 project after confirming that unsaved edits may be lost.

Select a track and open **裝置** to add **Filter** and **Delay** inserts. Move an insert with the arrow buttons, bypass it with **旁通**, or remove it with **移除**. The peak/RMS meter reads the mono rack output before the mixer. Saving `.dawproject` preserves the ordered insert settings for Audiorective; the audio fallback includes their processed sound.

## DAW v1 reference song

Run `pnpm --filter @audiorective/daw-demo smoke:reference` to create a song from the empty project in Chromium. The runner uses a virtual Web MIDI input and fake microphone, then records one note through the Oxo Synth2 WebCLAP instrument and an audio take. It edits the note, splits the audio clip, checks undo/redo, changes mixer volume/pan, assigns track volume automation through the Workspace API, saves `.dawproject`, opens it in a fresh browser context, and exports mix plus both track WAV files. It checks that the reopened project matches the saved content and that all three WAV files contain audible samples. The runner prints the measured take length and WAV peaks; microphone timing and synth amplitude vary between runs.

| Acceptance step | Current result | Remaining work |
| --- | --- | --- |
| Start blank; record/edit MIDI and audio; mix; save/reopen/export | Passes in Chromium | Repeat with real hardware and a user-chosen take. |
| Track volume automation playback and persistence | Workspace runtime and save format support it; browser smoke verifies audible automation | Add an automation lane/editor to the DAW UI. |
| Tempo change within the song | Step tempo and beat-locked MIDI clips, including recorded notes and controllers, are implemented; audio and legacy MIDI remain in seconds | Test more real DAWproject importers and longer recorded takes across multiple tempo steps. |
| Bus mixing and sends | Unsupported: Workspace routes each track directly to master | Add bus tracks, routing, sends, and graph validation; persist them in the project format. |
| WebCLAP effect after the instrument | Host can load devices, but the demo only bundles/selects an instrument | Add a verified effect bundle and an effect insertion/parameter UI; test state and sound after reopen. |
| Crash/session recovery | Temporary recording takes use OPFS, but the demo does not restore an interrupted session | Add a journal and recovery flow before treating unsaved takes as durable. |
| Import in other DAWs | Not established by this runner | Test actual exports from multiple DAWs and maintain explicit compatibility cases. |

This reference song is an acceptance probe for the current architecture. It does not yet satisfy the bus, effect, or recovery gates for a complete DAW v1.
