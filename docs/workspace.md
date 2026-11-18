---
title: Workspace and DAWproject
---

`@audiorective/workspace` owns a small audio/MIDI project and stores it as a `.dawproject` ZIP. `Project` and the codec work in Node.js without constructing an `AudioContext`; `Workspace` is a browser runtime that borrows a caller-owned context, schedules the project through Clock and hosts WebCLAP devices. Widgets render the project and recording blocks capture takes.

## Save and reopen a project

```typescript
import { Project, saveDawProject, openDawProject } from "@audiorective/workspace";

const project = new Project({ title: "Demo", bpm: 120, signature: [4, 4] });
const keys = project.addTrack("Keys", "midi");
const mic = project.addTrack("Mic", "audio");

// `take` comes from @audiorective/midi/web MidiRecorder.stop().
// `audioTake` comes from @audiorective/blocks AudioRecorder.stop().
const midiClip = project.addMidiTake(keys.id, take, 0.5);
project.addAudioClip(mic.id, audioTake, 1);
midiClip.sequence.updateNote(take.notes[0].id, { pitch: 65 });

const bytes = saveDawProject(project);
const { project: reopened, warnings } = openDawProject(bytes);
const notes = reopened.tracks[0].clips[0];
if (notes.kind === "midi") {
  const events = notes.playbackEvents(); // clip-relative seconds, still needs your synth/Clock
}
project.destroy();
reopened.destroy();
```

The take placement argument is **project seconds**, chosen by the caller. `RecordedMidi.startTime` and `RecordedAudio.startFrame/startTime` are absolute AudioContext capture positions; Project does not infer arrangement placement from them. `addMidiTake` defaults to seconds, or accepts `{ timeUnit: "beats" }` to convert the take's notes, duration and complete ordered message stream at that placement through the current tempo map. The resulting `MidiClip.time`, `duration`, note times and `playbackEvents()` times all use `clip.timeUnit`. `MidiClip.sequence` owns editable notes and may be passed to `mountPianoRoll` with `timeUnit: clip.timeUnit`. `Project.tracks`, `tempoMap`, `markers` and `title` are tracked reads: an effect or `useValue` that reads one re-runs after every `Project` edit, and each read returns the current immutable snapshot. `MidiClip.time` and `MidiClip.duration` are tracked as well.

`addAudioClip` copies the take's Float32 PCM. `saveDawProject` writes it as interleaved 32-bit float WAV in the ZIP, preserving sample values. The caller can use `Project.setVolumeAutomation(trackId, points)` for a track-volume curve; points use project seconds and `"linear"`/`"hold"` shapes. A running `Workspace` schedules that curve on a separate gain stage so mute, solo and static track volume remain independent. In-memory audio clips reuse a cached `AudioBuffer` while the same clip object is scheduled again; replacing a clip creates a new cache entry. Treat in-memory `AudioClip.channels` as borrowed, read-only PCM: mutating its typed arrays in place bypasses Project revisions and the cache.

### Tempo and arrangement time

`Project.tempoMap` converts musical beats to project seconds and back. The initial `Project.bpm` is beat zero; `setTempoChanges` adds step changes at later beats. A running `Workspace` rebases Clock's absolute AudioContext tempo events automatically after the edit. `Workspace.position`, `seek`, audio clips, markers and track-volume automation use **project seconds**. MIDI clips use their declared `timeUnit` (default `seconds`).

```typescript
project.setTempoChanges([{ beat: 4, bpm: 60 }]); // 120 BPM until beat 4, then 60 BPM; playback rebases itself
await workspace.flush(); // optional: resolves once the runtime reflects the edit
project.tempoMap.beatToSeconds(8); // 6 seconds
project.tempoMap.secondsToBeat(4); // beat 6
project.tempoMap.snapSeconds(4.4); // 4 seconds, the nearest beat
```

Create beat-locked material with `project.addMidiClip(trackId, { duration: 4, notes }, startBeat, { timeUnit: "beats" })` or `project.addMidiTake(trackId, take, startSeconds, { timeUnit: "beats" })`. Tempo edits stretch its placement, note endpoints and controllers together; existing seconds clips stay anchored. `project.clipTimeSeconds(clip, localTime?)` maps either clip unit to project seconds for arrangement drawing and `workspace.duration`. `setTempoChanges` replaces the full list and requires unique positive beats and positive finite BPM values. `Project.snapshot()` carries the map. DAWproject stores separate seconds and beats `Clips` lanes and beat content for beat MIDI, plus beat-based `Arrangement/TempoAutomation` with `hold` points. The importer rejects unsupported tempo curves rather than dropping them.

## Long audio takes and media ownership

For a long take, stream `AudioRecorder` chunks to `AudioMediaWriter` backed by browser OPFS, then add the returned `AudioMedia` to `Project`. The project stores a frame window and leaves the File with the caller-owned media object. Splitting, trimming and duplicating these clips retain windows into the same file rather than copying the full PCM. Playback reads two-second chunks and waveform views can use `await media.peaks(startFrame, frameCount)` for a bounded display summary.

```typescript
import { createOpfsAudioMediaWriter } from "@audiorective/workspace";

const writer = await createOpfsAudioMediaWriter(context.sampleRate, 1);
const anchor = workspace.takeAnchor();
try {
  await recorder.startStream((chunk) => writer.writeChunk(chunk));
  // Later, after the user stops recording:
  const span = await recorder.stopStream();
  const media = await writer.finish(span);
  project.addAudioMediaClip(track.id, media, workspace.takePosition(anchor, span, measuredInputLatencySeconds));
  // The running workspace applies the new clip automatically.
  // Keep `media` while clips or undo history refer to it. After closing that project:
  // await media.dispose(); // deletes this temporary OPFS take
} catch (error) {
  await writer.abort();
  throw error;
}
```

`AudioMediaWriter` accepts a caller-owned `AudioMediaStorage` as an alternative to OPFS. The storage must write in order and return a readable `Blob` or `File` on finish. `AudioMedia` reads interleaved little-endian float32 frames; `dispose()` releases only storage made by its writer. The application retains `AudioMedia` while any clip or undo entry borrows it. The demo removes its temporary OPFS takes when a project closes; an interrupted browser session can leave temporary files in site storage.

Use `await workspace.saveTo(writableStream)` or `saveDawProjectTo(project, writableStream)` to write a DAWproject ZIP without assembling the whole take or archive in a `Uint8Array`. This stream writes stored ZIP entries with CRC and size in every local header; it reads media twice and stops before classic ZIP's 4 GiB archive boundary. The demo uses a native save-file picker when the browser offers one; its download fallback and `workspace.save()` materialize the full ZIP in memory. Reopen from a `Blob` or `File` with `Workspace.openBlob(context, blob, options)` / `openDawProjectBlob(blob)`, which retains WAV media as Blobs. The synchronous `saveDawProject(project)` accepts in-memory clips only. Each float WAV is limited by RIFF's 4 GiB length field. The streaming import collects Blob parts under the browser's Blob storage policy, so actual disk versus memory use depends on the browser.

## Arrange clips and mix tracks

`Project.moveClip(clipId, trackId, time)` moves a clip on a matching track using that clip's unit. MIDI moves retain the same `MidiClip.sequence` for an open editor. `duplicateClip(clipId, time, trackId?)` uses the source clip's unit and makes a new ID; `removeClip(clipId)` removes it. `splitClip(clipId, offset)` and `trimClip(clipId, start, end)` use **clip-local units** (seconds for audio and legacy MIDI, beats for beat MIDI). The left split clip keeps the original ID. Audio boundaries round to samples; MIDI notes crossing a cut are shortened and retained on both sides, while control events inside the kept interval stay at their relative time. The latest prior channel-controller value is carried into a trimmed/split segment, and active sustain is released at its end so a cut cannot leave held notes running. These operations replace the affected clip objects and MIDI sequences, so an editor should re-read `Project.tracks` and remount a borrowed clip view. They do not rewrite stored note positions when tempo changes. Rename with `setTitle(title)` and `setTrackName(trackId, name)`, or remove a whole track with `removeTrack(trackId)`. Structural edits update `Project.cells.revision`; read `Project.tracks` again after an edit. `Project.setMarkers([{ time, name }, ...])` stores sorted, unique section markers in project seconds; `Project.markers` exposes the current snapshot. DAWproject stores these under standard arrangement `Markers`.

Tracks have `muted`, `solo` and `pan` (`-1` left, `0` center, `1` right), alongside linear `volume`. Set them through `Project.setTrackMuted`, `setTrackSolo`, `setTrackPan` or through the matching `Workspace` methods while a browser session is active. The workspace applies mixer changes to native Web Audio gain and stereo panner nodes immediately; solo suppresses non-solo tracks, and mute wins over solo. Edits made directly on `Project` reach the running workspace without a further call; see [Editing a running project](#editing-a-running-project).

## Live browser workspace

```typescript
import { Project, Workspace } from "@audiorective/workspace";

const project = new Project({ bpm: 120 });
const track = project.addTrack("Synth", "midi");
const device = project.addWebClapDevice(track.id, {
  pluginId: "com.oxo.music.oxosynth2",
  name: "Oxo Synth2",
  vendor: "chab (Oxo Music)",
  version: "1.1.1",
  bundleUrl: "/plugin/oxo-synth2.wclap",
});
const workspace = await Workspace.create(context, project, {
  destination: context.destination,
  workletUrl: "/assets/webclap-worklet.js",
});
const iframe = document.querySelector<HTMLIFrameElement>("#plugin-editor")!;
const host = workspace.host(device.id); // lookup by device ID, not track ID
const detachEditor = host?.hasEditor ? await host.mountEditor(iframe) : undefined;
await workspace.play();
workspace.seek(1.5);
workspace.setTrackVolume(track.id, 0.7);
project.setVolumeAutomation(track.id, [
  { time: 0, value: 1, shape: "linear" },
  { time: 2, value: 0.5, shape: "hold" },
]); // applied automatically
const bytes = await workspace.save(); // waits for pending edits, then captures live plug-in state
detachEditor?.();
workspace.destroy();
project.destroy();

const reopened = await Workspace.open(context, bytes, { destination: context.destination, workletUrl: "/assets/webclap-worklet.js" });
// Inspect reopened.warnings and reopened.project before playing.
```

`Workspace` owns runtime nodes and Clock; the caller owns its context and `Project`, including `Workspace.open(...).project`, and destroys the project separately. `workspace.host(device.id)` returns the loaded plug-in host, if available. `workspace.position` and `workspace.duration` are project seconds for external playheads and seek controls. For a beat MIDI piano roll, pass `project.tempoMap.secondsToBeat(workspace.position) - clip.time` as its playhead; for seconds clips subtract `clip.time` directly. `sync()` rebuilds routing after changing tracks or devices (`cells.needsSync` reports when), preserving the playhead and stopping playback. MIDI note edits refresh Clock while playing. `pause`, `stop` and `seek` cancel active audio clips and panic hosted instruments. `resolveBundle(device)` can map a saved plug-in descriptor to a deployment-specific bundle URL. A missing or mismatched bundle yields a warning and leaves that track's device silent. `workspace.warnings` (also `workspace.cells.warnings`) is a frozen array of these notices plus import notices from `Workspace.open`; it is a tracked read, never mutated in place, and each new notice replaces it.

For recorded takes, capture `const anchor = workspace.takeAnchor()` before arming `AudioRecorder`; use `workspace.takePosition(anchor, take, measuredInputLatencySeconds)` when adding the result to `Project`. For `MidiRecorder`, use its returned output-clock start: `const anchor = workspace.takeAnchor(recorder.start())`. `takePosition` maps the actual take start to project seconds while transport plays; while transport is stopped, it keeps the anchor's project cursor. A positive measured input latency moves the placement earlier. If that would cross project zero, the method throws instead of silently losing timing; record with preroll or reduce the correction. The demo exposes a locally stored millisecond correction field in its browser panel and defaults to zero until the user measures their device.

### Editing a running project

`Workspace` watches `project.cells.revision` (and the `project` setter). Edit `Project` directly and the change is heard; there is no commit step.

```typescript
project.setTempoChanges([{ beat: 4, bpm: 60 }]); // light edit: applied automatically
project.moveClip(clip.id, track.id, 2.5); // light edit

const bass = project.addTrack("Bass", "midi"); // structural edit: topology differs
workspace.cells.needsSync.value; // true once the runtime has noticed; transport keeps playing
if (workspace.cells.needsSync.value) await workspace.sync(); // rebuild hosts and routing, clears needsSync

await workspace.flush(); // resolves when pending automatic application is done; rejects if it failed
workspace.cells.error.value; // message of the latest failed application, or null
workspace.cells.warnings.value; // frozen array of non-fatal notices; workspace.warnings reads the same value, tracked
```

**Light edits** keep the same tracks and devices: tempo map, effect rack settings, device state bytes, mixer (volume, mute, solo, pan), volume automation, and clips. They apply in place and hosts stay loaded. Edits coalesce: any number of edits in one synchronous burst cause one application in the next microtask. Applications never overlap. Device-state restore is asynchronous, so edits that arrive during one queue exactly one more application that reads the latest `Project`.

**Structural edits** add, remove or retype tracks, or add, remove, reorder or replace devices (a different plug-in or bundle). `sync()` stops transport, captures live plug-in state, reloads WebCLAP hosts and rebuilds routing; it is slow, asynchronous, can fail and interrupts sound. For that reason the workspace never runs it by itself. It sets the read-only `workspace.cells.needsSync` and leaves transport and hosts untouched, so the UI can offer a rebuild action at a moment the user accepts a glitch. `sync()` clears `needsSync` and applies everything in `Project`, including light edits made meanwhile. While `needsSync` is true no automatic application runs: light edits wait for `sync()`, or take effect if the topology is restored first. The direct `Workspace` mixer and effect methods still apply immediately to tracks that are already loaded.

`workspace.cells.error` is a read-only cell holding the message of the latest failed automatic application (for example a plug-in rejecting saved state), or `null`. The next successful application or `sync()` clears it. Failures never become unhandled rejections. An application is not retried by itself: edit again or call `sync()`.

`await workspace.flush()` resolves when all pending automatic application has finished and rejects with the latest failure. `save()`, `saveTo()` and `exportAudioFallbackTo()` wait for pending application first, but do not reject because of an earlier failure: `Project` is the document. After `destroy()` the watcher is disposed, pending applications are dropped, and `flush()` resolves without error.

Edits the runtime makes itself, such as capturing plug-in state into `Project` during `sync()` or `save()`, and the `Workspace` mixer and effect methods, are marked as already applied, so they cause no second application. `refreshArrangement()` and `sync()` remain public for callers that want to drive those operations explicitly.

### Mount playback controls

Pass `workspace.player` directly to `mountPlayer` for play, pause and seeking. Its seek bar follows the project duration in seconds, including clip and tempo edits. Programmatic seeks and stops update the view even while paused.

```typescript
import { Workspace } from "@audiorective/workspace";
import { mountPlayer } from "@audiorective/widgets/player";

const options = { destination: context.destination }; // Route to speakers in this app.
const workspace = await Workspace.openBlob(context, file, options);
const controls = mountPlayer(container, { player: workspace.player });

// On teardown or before mounting controls for another Workspace:
controls.destroy();
workspace.destroy();
workspace.project.destroy();
```

The same view works with `Workspace.create()` and `Workspace.open()`. Pass a `destination` in all three paths for audible output, or connect `workspace.output` to your own graph. The widget borrows the transport. Your app still decides when to stop playback at the end or loop a region.

## Effect rack

`ProjectTrack.effects` is the ordered snapshot of built-in inserts. Use `project.setTrackEffects(trackId, slots)` for headless project edits and the running workspace applies them automatically. For an already loaded track, `workspace.setTrackEffects(trackId, slots)` applies the change synchronously to the rack and Project, preserving transport and loaded WebCLAP hosts. The signal runs from the track's source through its hosted devices, then the rack, then the mixer. `workspace.trackEffectOutput(trackId)` borrows the rack's pre-mixer output for an analyser. Disconnect only the analyser you connected, or remount it if a structural edit rebuilt that track.

The DAW's Devices panel inserts, adjusts, bypasses, reorders and removes Filter and Delay slots. DAWproject uses vendor-specific `BuiltinDevice` entries in order and versioned JSON settings in `plugins/`. Open the project in Audiorective to edit the inserts. Use the audio fallback when sharing the processed sound with another DAW.

## File contents and fidelity

The ZIP contains standard `project.xml`, `metadata.xml`, `audio/*.wav` and, for WebCLAP devices, `plugins/*.bin`. Standard XML holds track/channel structure, `ClapPlugin` identity and `State` references, clip positions, notes, controller points, initial tempo and optional beat-based step-tempo automation, time signature, volume automation, arrangement markers, and channel mute/pan/solo. `audiorective/host.json` maps a CLAP device to a WebCLAP bundle URL; this is an Audiorective locator, not a portable DAWProject property. `audiorective/state.json` holds note IDs and the original ordered MIDI messages that DAWproject 1.0 cannot express directly. Its fingerprint includes the clip's time unit as well as standard note/control content; version 1 seconds sidecars remain readable but never attach to beat-labelled XML. If another application changes that content or removes the private entry, `openDawProject` rebuilds from standard XML and returns a warning; it never applies stale original events to edited notes.

For plug-in round trips, use `Workspace.save()` to capture the live patch. The portable part of DAWProject is the CLAP ID and state bytes; `audiorective/host.json` is the private lookup needed to find browser `module.wasm`. Another DAW needs its own matching CLAP binary, and may drop the private bundle locator when saving.

Call `workspace.portabilityReport()` before sharing. It lists content represented in standard DAWproject fields, required CLAP IDs and limitations; it does not claim that a particular DAW has passed import testing. For an audible companion, call `await workspace.exportAudioFallbackTo(writableStream, { tailSeconds: 1, signal, onProgress })`. It captures a separate real-time runtime from project time zero, writing a ZIP with `mix.wav`, per-track post-mixer `tracks/<id>.wav` and `manifest.json`. The mix includes hosted WebCLAP instruments and effects; the source project and its playback keep running. Captured PCM is temporarily stored in browser OPFS and removed after export. The export rejects unresolved devices, missing frames during project playback, cancellation and storage failures instead of delivering a knowingly incomplete backup. A project with more than 15 tracks exports the full mix without stems because one recorder supports at most 32 packed channels. The demo offers **分享說明** and **匯出音訊** next to **儲存工程**. This ZIP is a companion audio delivery, not a second DAWproject or an editable plug-in replacement.

`Project.snapshot()` supplies the export runtime with independent MIDI and in-memory PCM clip data plus copied device state. File-backed `AudioMedia` stays borrowed; retain it until the export settles.

This is a narrow native slice. `openDawProject` and `openDawProjectBlob` accept the structure this package writes: regular tracks routed to one master, second-based audio and seconds- or beats-based MIDI clips, CLAP devices, Audiorective Filter and Delay inserts, controller points, volume automation, arrangement markers, channel mute/pan/solo, fixed or step tempo, time signature and 32-bit float WAV. The MIDI writer accepts note on/off and control-change bytes; other message kinds fail on save until a portable mapping is implemented. Unsupported XML structures throw instead of disappearing on the next save. Other DAWs may open the standard content but are not required to preserve Audiorective's private entries or resolve the WebCLAP bundle; cross-DAW round-trip preservation remains to be verified. VST/AU hosting and arbitrary routing remain outside this slice.

A small [Cubase 14 export shared on the Steinberg forum](https://forums.steinberg.net/t/import-and-export-of-media-projects-and-dawprojects/1010846) was probed against both open paths (inner `test.dawproject` SHA-256 `b45bdefe6101b58db1aad86757801d816350c9b6c0eb7b9ff5a9f55edea25708`). After building the workspace package, `pnpm --filter @audiorective/workspace probe:cubase` downloads the public fixture, verifies its hash and repeats the probe. Pass a previously downloaded inner `.dawproject` as an argument to run offline; its hash is checked in the same way. Empty standard metadata fields are accepted. The file still rejects at `Project XML has unsupported Structure content.` because it contains a track folder and a separate master channel; it also carries EQ devices and time-signature automation that the model cannot preserve. This is an observed rejection, not a claim of Cubase import compatibility. Five separately generated Bitwig-shaped fixtures also reject on unsupported structure. Wider import needs explicit model semantics and preservation tests rather than ignoring those elements.

## Common errors

| Effect rack message                                                                                     | Fix                                                                                                                  |
| ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `Project effects need an existing track.` / `Workspace effects need a live track.`                      | Use its current track ID, and `await workspace.sync()` after adding a new track before calling the Workspace method. |
| `Project has an unsupported built-in effect.` / `Project built-in effects must follow WebCLAP devices.` | Import supported Audiorective Filter and Delay inserts after the hosted devices.                                     |
| `Project built-in effect state is missing or reused.` / `Project built-in effect state is invalid.`     | Restore the matching, versioned insert state entries.                                                                |
| `EffectRack needs unique slot IDs and valid Filter or Delay settings.`                                  | Follow the [rack settings ranges](./blocks.md#effectrack-inserts).                                                   |

| Message                                                                                                                                                                                                                   | Cause and fix                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Project needs positive BPM and a valid time signature.`                                                                                                                                                                  | Pass finite BPM above zero and a positive power-of-two denominator.                                                                                           |
| `Project IDs must be unique XML IDs.` / `Project has duplicate DAWproject XML IDs.`                                                                                                                                       | Use distinct IDs that start with a letter or underscore; avoid collisions with generated XML IDs.                                                             |
| `Project tracks need a name, kind and non-negative volume.`                                                                                                                                                               | Supply a nonempty name, `"midi"` or `"audio"`, and finite non-negative volume.                                                                                |
| `Project track mixer options need boolean mute/solo and pan from -1 to 1.`                                                                                                                                                | Initialize a track with boolean mute/solo and finite pan in the stated range.                                                                                 |
| `Project track volume needs an existing track and non-negative value.`                                                                                                                                                    | Use a current track ID and finite non-negative gain.                                                                                                          |
| `Project track name needs an existing track and non-empty name.` / `Project title must not be empty.`                                                                                                                     | Give the project or an existing track a non-empty name.                                                                                                       |
| `Project track mute needs an existing track and boolean value.` / `Project track solo needs an existing track and boolean value.` / `Project track pan needs an existing track and a value from -1 to 1.`                 | Use a current track ID, boolean mute/solo and finite pan in the stated range.                                                                                 |
| `Project clip does not exist.` / `Project track does not exist.`                                                                                                                                                          | Use a clip or track ID still present in the project.                                                                                                          |
| `Project split needs a time inside the clip.`                                                                                                                                                                             | Pass a finite clip-local offset strictly between zero and clip duration.                                                                                      |
| `Project trim needs 0 <= start < end <= clip duration.` / `Project audio trim needs at least one sample.`                                                                                                                 | Keep a nonempty local interval; for audio, its rounded sample endpoints must differ.                                                                          |
| `Project markers need unique non-negative times and names.` / `Project markers need seconds time.`                                                                                                                        | Supply named markers at distinct non-negative project seconds.                                                                                                |
| `Project has invalid channel mute or solo.` / `Project has unsupported track pan units.` / `Project has invalid track pan.`                                                                                               | Supply DAWproject channel mute/solo as booleans and normalized pan between 0 and 1.                                                                           |
| `Project WebCLAP device needs an ID, name, bundle URL and byte state.` / `Project device needs an existing track.`                                                                                                        | Supply a current track ID, CLAP identity and URL; state must be `Uint8Array`.                                                                                 |
| `Project device state needs bytes.` / `Workspace is destroyed.`                                                                                                                                                           | Supply `Uint8Array` state or create a new Workspace after destroying one.                                                                                     |
| `Project has an unsupported device role.` / `Project device state asset is missing.`                                                                                                                                      | Open a CLAP instrument on a MIDI track or audio effect on an audio track, with its referenced state file in `plugins/`.                                       |
| `workspace.cells.error` holds a message / `await workspace.flush()` rejects                                                                                                                                               | An automatic application failed (often a plug-in rejecting `loadState`). Fix the edit, edit again, or call `await workspace.sync()`; success clears the cell. |
| `workspace.cells.needsSync` stays true and edits are silent                                                                                                                                                               | Tracks or devices changed. Call `await workspace.sync()`; light edits wait until then.                                                                        |
| `Workspace seek needs non-negative seconds.`                                                                                                                                                                              | Seek to a finite non-negative project time.                                                                                                                   |
| `Workspace take anchor needs a finite non-negative audio time.` / `Workspace take placement needs a valid anchor, take start and non-negative input latency.`                                                             | Use the recorder's start clock and a finite, non-negative measured latency.                                                                                   |
| `Workspace take placement crosses project zero; use preroll or a smaller latency correction.`                                                                                                                             | Record after sufficient preroll so the corrected clip starts at or after project zero.                                                                        |
| `Project clip needs a matching track.` / `Project automation needs an existing track.`                                                                                                                                    | Use a current track ID of the right kind.                                                                                                                     |
| `Project clip time must be finite and non-negative.` / `Project audio clips need a time, sample rate and equal-length PCM channels.`                                                                                      | Pass time in the clip's declared unit and valid equal-length Float32 channel arrays.                                                                          |
| `Project MIDI time unit must be seconds or beats.`                                                                                                                                                                        | Use one supported unit for the whole MIDI clip.                                                                                                               |
| `Project MIDI events need finite non-negative times and MIDI bytes.`                                                                                                                                                      | Use clip-relative non-negative event times and nonempty `Uint8Array` messages.                                                                                |
| `Project MIDI has events outside supported portable content.`                                                                                                                                                             | This slice writes note on/off and control changes; add a DAWproject mapping for other MIDI messages before saving this take.                                  |
| `Project automation needs finite unique times and non-negative values.`                                                                                                                                                   | Provide finite points at distinct non-negative project seconds with `linear` or `hold`.                                                                       |
| `Project WAV needs equal-length PCM channels and a valid sample rate.` / `Project audio needs an IEEE float32 WAV asset.`                                                                                                 | Supply valid PCM, or convert an imported asset to 32-bit float WAV before opening this slice.                                                                 |
| `Project archive is missing or too large.` / `Project archive is too large.` / `Project archive needs project.xml and metadata.xml.`                                                                                      | Supply a valid bounded `.dawproject` ZIP with both required XML entries.                                                                                      |
| `Project archive has unsupported files.`                                                                                                                                                                                  | This slice cannot preserve extra archive members; use a supported project or extend the codec before resaving.                                                |
| `Project XML is invalid: …` / `Project XML needs …` / `Project XML has invalid …`                                                                                                                                         | Repair malformed, missing or invalid XML fields.                                                                                                              |
| `Project XML has unsupported … content.` / `Project XML has unsupported … attributes.`                                                                                                                                    | The file uses a DAWproject feature outside this slice; use a supported simple project or extend the codec before resaving.                                    |
| `Project needs DAWproject version 1.0.` / `Project transport needs BPM tempo.` / `Project arrangement needs seconds time.` / `Project track lanes need seconds time.`                                                     | Open a version 1.0 project with seconds-based clips and a supported fixed or step tempo map.                                                                  |
| `Project tempo needs positive finite BPM.` / `Project tempo changes need unique positive beats and BPM.` / `Project snap needs a positive beat interval.`                                                                 | Supply a valid initial BPM, unique changes after beat zero, and a positive snap interval.                                                                     |
| `Project tempo automation needs beat positions and BPM.` / `Project has unsupported tempo automation target.` / `Project has unsupported tempo interpolation.` / `Project tempo automation disagrees with transport BPM.` | Import beat-based hold points targeting the transport tempo, with beat-zero BPM matching Transport.                                                           |
| `Project has unsupported track routing.` / `Project has unsupported master routing.` / `Project has an unsupported track kind.` / `Project has unsupported track volume units.`                                           | This slice stores simple audio/MIDI tracks routed to one master with linear volume.                                                                           |
| `Project MIDI clip has unsupported audio content.` / `Project MIDI clip content time must match its clip lane.` / `Project MIDI has unsupported control automation.`                                                      | Keep placement, notes and controllers in the same seconds or beats lane.                                                                                      |
| `Project clip lane needs seconds or beats time.` / `Project audio clip has unsupported time unit.`                                                                                                                        | Use seconds or beats for MIDI and seconds for audio.                                                                                                          |
| `Project audio clip has unsupported content.` / `Project audio asset is missing.` / `Project audio asset does not match its XML metadata.`                                                                                | Include the referenced 32-bit float WAV with matching sample rate, channel count and duration.                                                                |
| `Project file-backed audio needs saveDawProjectTo().`                                                                                                                                                                     | Use the streaming writer for media-backed clips; `Workspace.save()` is an in-memory convenience.                                                              |
| `Project media clip needs a valid frame window and time.` / `AudioMedia needs a valid PCM frame window.` / `AudioMedia read needs a valid frame window.`                                                                  | Use integer frames inside the borrowed media and a finite project position.                                                                                   |
| `Project media clip needs an AudioMedia asset.`                                                                                                                                                                           | Pass an `AudioMedia` returned by a writer or constructed over a valid interleaved float32 Blob.                                                               |
| `AudioMediaWriter needs browser OPFS storage.` / `AudioMediaWriter lost captured frames.` / `AudioMediaWriter take does not match captured frames.`                                                                       | Use OPFS on a compatible secure origin, keep ordered recorder chunks and pass its matching `stopStream()` span.                                               |
| `AudioMediaWriter is closed.` / `AudioMedia is disposed.` / `Project media asset ended before its declared frame count.`                                                                                                  | Keep the writer/media alive until saving and playback finish; verify the backing file was not truncated.                                                      |
| `AudioMediaWriter needs finite PCM samples.` / `AudioMedia asset has non-finite PCM samples.`                                                                                                                             | Repair invalid sample values in the source take or imported media.                                                                                            |
| `AudioMedia peaks need a valid frame window.` / `Workspace media chunk is outside the clip.`                                                                                                                              | Request positive integer frames inside the current clip; refresh the runtime after clip edits.                                                                |
| `AudioMediaWriter needs a sample rate and 1–32 channels.` / `AudioMediaWriter needs equal-length PCM channels.`                                                                                                           | Match the writer to the recorder sample rate and channel count, with equal-length chunks.                                                                     |
| `Project media asset is missing.` / `Project archive has unsupported media path.` / `Project archive has invalid entry data.`                                                                                             | The media/archive source is incomplete or malformed; keep the original and retry with a valid asset.                                                          |
| `Project audio needs a canonical IEEE float32 WAV asset.` / `Project archive has duplicate or unsafe paths.` / `Project archive is incomplete.`                                                                           | Use a complete ZIP with safe unique paths and canonical float32 WAV assets for streamed import.                                                               |
| `Project has unsupported … metadata.`                                                                                                                                                                                     | A nonempty metadata field outside Title cannot be preserved; keep the original file until the model supports it.                                              |
| `Project portable ZIP needs at most 65535 entries.` / `Project portable ZIP entry exceeds 4 GiB.` / `Project portable ZIP exceeds 4 GiB.`                                                                                 | The streaming writer uses classic ZIP; split the project or add ZIP64 support before writing a larger archive.                                                |
| `Project portable ZIP needs unique safe paths.` / `Project portable ZIP source size changed.` / `Project portable ZIP source changed while saving.` / `Project portable ZIP was cancelled.`                               | Keep entry names unique and media immutable until the two-pass save finishes; retry after cancellation.                                                       |
| `Project WAV media entry needs a valid frame window.` / `Project WAV media entry needs a valid frame window and stereo pair.`                                                                                             | Use frames inside a live `AudioMedia` asset and a valid packed stereo pair.                                                                                   |
| `Workspace audio fallback tail must be from 0 to 60 seconds.` / `Workspace audio fallback missed the project start or end.`                                                                                               | Use a finite tail within range and retry after keeping the browser audio clock active.                                                                        |
| `Workspace audio fallback has unresolved devices: …` / `Workspace audio fallback lost audio frames during the project; retry the export.` / `Workspace audio fallback was cancelled.`                                     | Resolve and load every WebCLAP bundle, keep audio rendering active and retry, or cancel with `AbortSignal`.                                                   |
| `Project arrangement refers to an unknown track.`                                                                                                                                                                         | Repair the lane's `track` reference and project structure.                                                                                                    |
| `Project has unsupported automation target.` / `Project has unsupported automation interpolation.`                                                                                                                        | This slice reads track-volume points with `linear` or `hold` interpolation.                                                                                   |

`openDawProject(...).warnings` are non-fatal fidelity notices. An invalid or missing Audiorective private entry causes a warning and a standard-XML fallback for affected MIDI clips.
