# Audiorective DAW demo

From the repository root, build the workspace packages and run:

```sh
pnpm -r build
pnpm --filter @audiorective/daw-demo dev
```

The demo uses a locally bundled MIT-licensed Oxo Synth2 WebCLAP instrument based on [open-webclap](https://github.com/andremichelle/open-webclap). The trial binary came from a fork build with uncommitted changes, documented in `public/plugin/oxo-synth2.wclap/NOTICES.md`; it is not an upstream release artifact. The bundle includes its license and notices. The host worklet in `packages/host/` is an adapted copy of the open-webclap MIT test host.

Open an audio or bus track's **裝置** tab and choose **加入 WebCLAP**. Enter the served bundle directory and the desired CLAP ID. The loader checks the descriptor before it changes the project. Use **參數** for a slider view bound to the same host values, or use the plug-in's webview when it provides one. Adding or removing the device applies a structural graph rebuild.

To verify a multi-device bundle, extract `module.wasm` from the Signalsmith Basics archive and run `DAW_WEBCLAP_EFFECT_WASM=/absolute/path/to/module.wasm pnpm --filter @audiorective/daw-demo smoke:webclap`. The test exercises the picker, a parameter edit, a return effect and patch reopen. [WebCLAP examples](https://github.com/WebCLAP/examples)

It starts with a MIDI instrument track and generated audio rhythm tracks. The UI can edit notes, split and trim clips at the playhead, undo and redo clip/note edits, add tracks, upload audio, adjust track volume, record from a Web MIDI input or microphone, open the synth editor, and save/reopen `.dawproject`. Microphone takes stream to temporary OPFS files; the project borrows those files, plays them in chunks, and saves them as portable WAV assets. On supported browsers, Save uses a native file picker and streams the ZIP to disk; the download fallback assembles the ZIP in memory. Temporary takes are deleted when another project opens; page-exit cleanup is best effort, so interrupted sessions may leave OPFS files. The browser panel has a measured input-latency correction in milliseconds for new MIDI and microphone takes; if correction would place a take before project zero, start with preroll. In the lower waveform editor, `時間` changes horizontal zoom, `波高` changes visual amplitude without changing audio gain, and the thin handle above the editor tabs resizes the lower panel. The project file contains CLAP identity/state and an Audiorective bundle URL; it does not embed the WebCLAP bundle, so reopening in a different deployment needs a bundle resolver.

After building the packages, verify the browser workflow with `pnpm --filter @audiorective/daw-demo smoke`. This checks real synth output, pause, editor loading, changed patch state, save/reopen and track creation in Chromium. The **New** button starts an empty 120 BPM, 4/4 project after confirming that unsaved edits may be lost.

Select a track and open **裝置** to add **Filter** and **Delay** inserts. Move an insert with the arrow buttons, bypass it with **旁通**, or remove it with **移除**. The peak/RMS meter reads the mono rack output before the mixer. Saving `.dawproject` preserves the ordered insert settings for Audiorective; the audio fallback includes their processed sound.

Use **＋ 巨集** in the effects rack to make one knob control several parameters. Assign each target from **指定參數**. The macro and its assigned targets stay connected when inserts are reordered, and saving the project retains their mapping and position.

Open **自動化** after selecting a track to add or drag volume points. The point fields allow precise edits. The toolbar's Undo and Redo include these gestures. The Master fader is saved in the project and scales the mix export. Track stems use their own mixer gain.

Select an audio clip and turn on **片段自動化** in the waveform editor to draw that clip's own gain curve. Double-click to add a point, drag to edit it, and use Enter to switch the segment shape. The curve follows the source through trim and stretch, and Undo and Redo restore its points.

Drag on **循環區間**, directly below the bar ruler, to loop a range across all tracks. Hold Alt for a free position between beats. The main bar ruler still seeks and scrubs. The **循環** toggle retains a custom range until you clear it with **×** or open another project. With a cleared range, the toggle loops the selected clip, or the whole project when there is no selected clip. The custom range follows beats through tempo changes and belongs to the current session.

Use **試聽選區** to hear just the audio tracks in the chosen range on a shared repeat. Short clips stay silent after they end until the next pass. The button pauses Arrangement if it is running, and the audition keeps that playhead where it stopped.

The **全曲總覽** mini-map shows each track's clips, playhead and visible time window. Click to center the arrangement there, or drag the window to scroll. Arrow, Page Up, Page Down, Home and End keys work when the mini-map is focused. Arrangement audio thumbnails paint the visible waveform at the current zoom. At high zoom, file-backed clips request finer peaks from the visible source windows.

When a completed microphone take shows **已建立復原點**, the browser has a streamed copy of the project in OPFS. Use **復原錄音** to choose a checkpoint by project name and time, then open it or delete it. The same project session replaces its previous checkpoint once the next one finishes. Recoverable copies stay available on the same browser profile and origin until deleted. The checkpoint includes the project and its media as of the completed take. Recording in progress and edits after the checkpoint require separate protection. Run `pnpm --filter @audiorective/daw-demo smoke:recovery` to verify recovery after a Chromium renderer crash.

Open the browser and choose **匯入素材** to populate the session library. Use **試聽** independently of transport and **放入音軌** to place the sample on the selected audio track at the playhead. Removing the library entry leaves placed clips available for playback and saving. Run `pnpm --filter @audiorective/daw-demo smoke:samples` to verify decoded identity and placement in Chromium.

Open **混音** and add **群組** for a shared dry destination or **效果回送** for a parallel effect. Pick the bus as a track's **輸出** or add a send to it. On its mixer strip, choose **編輯裝置** to add a Filter or Ping Pong Delay. The bus and send settings save with the project. Run `pnpm --filter @audiorective/daw-demo smoke:mixer` to verify rendered bus output and live edits in Chromium.

The device panel shows the track's post-rack spectrum. For a Filter insert, drag the dot to change cutoff, and use Page Up, Page Down or the wheel on it to adjust Q. Choose **＋ EQ** to edit a three-band Equalizer on one response plot. Drag a band horizontally for frequency and vertically for gain. The adjacent precise controls update the same response and project settings. The group saves and bypasses as one insert.

Select an audio clip and open **編輯** to change **片段音量**, **淡入** and **淡出**. These edits support undo and save with the project. Choose **試聽片段** to hear the current audio and envelope through master volume while leaving the arrangement playhead alone. The display-only **波高** control adjusts visual amplitude. Run `pnpm --filter @audiorective/daw-demo smoke:fades` for seek, Session and independent file-backed audition checks.

In the audio clip editor, choose **載入伸縮引擎** and supply a compatible Rubber Band 3.3 ABI `.wasm` file. Enter **長度倍率** and select **套用倍率** to render with the original pitch. The original audio stays in the project. Use **還原原始長度** to return to it and the standard undo and redo controls to reverse an edit. Saved rendered clips play without loading an engine. To run the real-engine check, set `DAW_STRETCH_WASM` to a compatible local fixture and run `pnpm --filter @audiorective/daw-demo smoke:stretch`.

Turn on **Warp 標記** and double-click the waveform to pin a point in the source. Drag its marker to move that sound while holding the clip length. The edit renders on release. Use the arrow keys on a focused marker to move it or Delete to remove it. The project saves the rendered audio, original source and markers.

## DAW v1 reference song

Open **步進鼓機** to edit a 16-step pattern, adjust velocity and assign loaded samples to pads. The pattern follows the project clock after you enable it. Manual pad presses work separately. The groove and its pad assignments are live session controls. Run `pnpm --filter @audiorective/daw-demo smoke:rhythm` to check grid edits and rendered cancellation.

Open **片段觸發** above Arrangement to launch one PCM clip or a whole scene on the next beat or bar. Choose **循環** or **單次** in **片段播放** before launch. A one-shot returns its track to Arrangement as soon as the clip ends. Use **取消排隊** before a switch or **回到編曲** to return all active tracks at the next boundary. Run `pnpm --filter @audiorective/daw-demo smoke:session` to check controls and render the audio switches in Chromium.

Run `pnpm --filter @audiorective/daw-demo smoke:reference` to create a song from the empty project in Chromium. The runner uses a virtual Web MIDI input and fake microphone, then records one note through the Oxo Synth2 WebCLAP instrument and an audio take. It edits the note, splits the audio clip, changes mixer volume/pan and master gain, and draws track volume automation with the mouse. It exercises undo and redo, saves `.dawproject`, reopens it in a fresh browser context, and checks the mix and both track WAV files for audible samples.

| Acceptance step                                                  | Current result                                                                                                                            | Remaining work                                                                             |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Start blank; record/edit MIDI and audio; mix; save/reopen/export | Passes in Chromium                                                                                                                        | Repeat with real hardware and a user-chosen take.                                          |
| Track volume automation playback and persistence                 | The editor supports clicking, dragging, precise values, linear and hold shapes, deletion, undo and redo                                   | Add device and send automation when those targets are available.                           |
| Tempo change within the song                                     | Step tempo and beat-locked MIDI clips, including recorded notes and controllers, are implemented; audio and legacy MIDI remain in seconds | Test more real DAWproject importers and longer recorded takes across multiple tempo steps. |
| Bus mixing and sends                                             | Groups, effect returns and post-fader sends persist in DAWproject and can be changed during playback                                      | Check other DAWs with real interchange files.                                              |
| WebCLAP effects                                                  | Add served bundles by CLAP ID and edit their parameters. Signalsmith Frequency Shifter is tested on a return before and after reopen.     | Broaden compatibility to more bundles and input layouts.                                   |
| Clip and scene launching                                         | **片段觸發** groups PCM clips by common start and uses matching arrangement markers for scene names                                       | Add user-authored slots, MIDI and file-backed clip launches, and scene persistence.        |
| Crash/session recovery                                           | Completed microphone takes have a local recovery checkpoint verified by `smoke:recovery`                                                  | Add segmented writes for recordings interrupted before the checkpoint completes.           |
| Import in other DAWs                                             | Not established by this runner                                                                                                            | Test actual exports from multiple DAWs and maintain explicit compatibility cases.          |

Recovery during an active take remains open.
