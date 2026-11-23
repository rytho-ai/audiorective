---
title: DAW project, runtime and DAWproject
---

`@audiorective/daw` owns a small audio/MIDI project and stores it as a `.dawproject` ZIP. It has three entries and a convenience root:

| Entry                          | Owns                                                                                                                                                                    | Environment                            |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| `@audiorective/daw/project`    | `Project`, `MidiClip`, tempo map, `AudioMedia`, clip envelope (`ClipEnvelope`, `normalizeClipEnvelope`, `unityClipEnvelope`, `clipGainAt`) and `ClipStretchAnchor`      | Node.js and browser, no `AudioContext` |
| `@audiorective/daw/dawproject` | The `.dawproject` codec: `openDawProject`, `openDawProjectBlob`, `saveDawProject`, `saveDawProjectTo`                                                                   | Node.js and browser, no `AudioContext` |
| `@audiorective/daw/runtime`    | `Workspace`, `scheduleClipEnvelope`; borrows a caller-owned `AudioContext`, schedules the project through Clock and hosts WebCLAP devices. It does not import the codec | Browser                                |
| `@audiorective/daw`            | Re-exports all three and adds `openWorkspace`, `openWorkspaceBlob`, `saveWorkspace`, `saveWorkspaceTo`                                                                  | Browser                                |

A project-file tool imports only `daw/project` and `daw/dawproject`; it loads no runtime, clock or host. Headless playback of a `Project` the caller already holds imports `daw/runtime` and never loads the codec. The root entry joins the two for apps that open and save files around a running `Workspace`. Widgets render the project and recorders capture takes; `daw` and `widgets` never import each other, so the app wires them.

## Save and reopen a project

```typescript
import { Project } from "@audiorective/daw/project";
import { saveDawProject, openDawProject } from "@audiorective/daw/dawproject";

const project = new Project({ title: "Demo", bpm: 120, signature: [4, 4] });
const keys = project.addTrack("Keys", "midi");
const mic = project.addTrack("Mic", "audio");

// `take` comes from @audiorective/midi/web MidiRecorder.stop().
// `audioTake` comes from @audiorective/recorder AudioRecorder.stop().
const midiClip = project.addMidiTake(keys.id, take, 2); // placed at project beat 2
project.addAudioClip(mic.id, audioTake, 1); // placed at 1 second
midiClip.midi.edit((notes) => {
  notes[0].pitch = 65;
});

const bytes = saveDawProject(project);
const { project: reopened, warnings } = openDawProject(bytes);
const notes = reopened.tracks[0].clips[0];
if (notes.kind === "midi") {
  const events = notes.playbackEvents(); // `beat` from the clip's start, still needs your synth/Clock
}
project.dispose();
reopened.dispose();
```

A MIDI clip is always in **beats** (quarter notes): `MidiClip.time` is its position in project beats, `duration` is its length in beats, and note and event times are beats from the clip's start. Audio clips are placed in project seconds. `addMidiTake(trackId, take, time?)` takes the clip position in project beats and defaults to `take.startBeat` (0 when the recorder had no playing clock). A `MidiTake` already carries its notes, duration and non-note messages in beats from its start, so no tempo conversion happens; `RecordedAudio.startFrame/startTime` and `MidiTake.startTime` are absolute AudioContext capture positions, and Project does not infer arrangement placement from them. `MidiClip.midi` is the `MidiClip` of `@audiorective/midi` that owns the editable notes: read `clip.midi.notes.value`, change them with `clip.midi.edit(draft => ...)` or `setNotes(notes)` (selection belongs to the app, not the project). `MidiClip.duration` is the clip length in beats; it changes only through the project's clip operations (`trimClip`, `splitClip`), which replace the clip, and notes that extend beyond it are cut at playback. `Project.tracks`, `tempoMap`, `markers` and `title` are tracked reads: an effect or `useValue` that reads one re-runs after every `Project` edit, and each read returns the current immutable snapshot. `MidiClip.time` is tracked as well.

`addAudioClip` copies the take's Float32 PCM. `saveDawProject` writes it as interleaved 32-bit float WAV in the ZIP, preserving sample values. The caller can use `Project.setVolumeAutomation(trackId, points)` for a track-volume curve; points use project seconds and `"linear"`/`"hold"` shapes. Workspace applies that curve on a separate gain stage so mute, solo and static track volume remain independent. In-memory clips reuse a cached `AudioBuffer` for the same PCM channel window. Moving a clip or changing its envelope retains that buffer. Treat in-memory `AudioClip.channels` as borrowed, read-only PCM: mutating its typed arrays in place bypasses Project revisions and the cache.

### Tempo and arrangement time

`Project.tempoMap` converts musical beats to project seconds and back. The initial `Project.bpm` is beat zero; `setTempoChanges` adds step changes at later beats. The running Workspace automatically rebases Clock's absolute AudioContext tempo events. Await `workspace.flush()` when a following operation depends on the change. `Workspace.position`, `seek`, audio clips, markers and track-volume automation use **project seconds**. MIDI clips use **beats**.

```typescript
project.setTempoChanges([{ beat: 4, bpm: 60 }]); // 120 BPM until beat 4, then 60 BPM
await workspace.flush();
project.tempoMap.beatToSeconds(8); // 6 seconds
project.tempoMap.secondsToBeat(4); // beat 6
project.tempoMap.snapSeconds(4.4); // 4 seconds, the nearest beat
```

Create MIDI material with `project.addMidiClip(trackId, { duration: 4, notes }, startBeat)` or `project.addMidiTake(trackId, take, startBeat)`. MIDI follows the tempo map: tempo edits stretch its placement, note endpoints and controllers together, while audio clips stay anchored in seconds. `project.clipTimeSeconds(clip, localTime?)` maps a clip's native position plus offset (seconds for audio, beats for MIDI) to project seconds for arrangement drawing and `workspace.duration`. `setTempoChanges` replaces the full list and requires unique positive beats and positive finite BPM values. `Project.snapshot()` carries the map. DAWproject stores audio in a seconds `Clips` lane and MIDI in a beats `Clips` lane with beat content (`vel` is the note velocity 0..1), plus beat-based `Arrangement/TempoAutomation` with `hold` points. The importer also accepts a seconds-unit MIDI lane from another application and converts it to beats through the file's tempo map. It rejects unsupported tempo curves rather than dropping them.

## Long audio takes and media ownership

For a long take, stream `AudioRecorder` chunks to `AudioMediaWriter` backed by browser OPFS (`createOpfsAudioMediaWriter`, exported from `daw/runtime` because it needs browser storage; `AudioMedia` and `AudioMediaWriter` stay in `daw/project`), then add the returned `AudioMedia` to `Project`. The project stores a frame window and leaves the File with the caller-owned media object. Splitting, trimming and duplicating these clips retain windows into the same file rather than copying the full PCM. This sharing applies while the project and its source media remain open. DAWproject export writes each clip's retained audio window to its WAV entry. After reopening, that entry is the clip's available source: audio outside the exported window is absent, and split clips do not retain a shared full-take asset. Keep the original recording separately if later untrimming beyond those exported windows is required. Playback reads two-second chunks and waveform views can use `await media.peaks(startFrame, frameCount)` for a bounded display summary.

```typescript
import { createOpfsAudioMediaWriter } from "@audiorective/daw/runtime";

const writer = await createOpfsAudioMediaWriter(context.sampleRate, 1);
const anchor = workspace.takeAnchor();
try {
  const recording = recorder.record({ onChunk: (chunk) => writer.writeChunk(chunk) });
  void recording.catch(showError); // failures can arrive before the Stop click
  // Later, after the user stops recording:
  const span = await recorder.stop({ result: "span" }); // same span as recording
  const media = await writer.finish(span);
  project.addAudioMediaClip(track.id, media, workspace.takePosition(anchor, span, measuredInputLatencySeconds));
  await workspace.flush();
  // Keep `media` while clips or undo history refer to it. After closing that project:
  // await media.dispose(); // deletes this temporary OPFS take
} catch (error) {
  await writer.abort();
  throw error;
}
```

The completed span's `dropouts` field is optional: a healthy take omits it, so inspect `span.dropouts?.length` or `span.dropouts ?? []`.

`AudioMedia.peaks(startFrame, frameCount)` resolves to `{ min: Float32Array, max: Float32Array, duration: number }`. Pass that complete summary directly to the waveform; its `peaks` alternative takes a `Float32Array`, not another summary object. The frame range comes from the current clip's retained media window. File-backed audio clips expose `clip.media`, `clip.startFrame` and `clip.frameCount` directly. They are not nested under a `source` field. Re-read the current clip from `project.tracks` after a split, trim or reopen:

```typescript
import { mountWaveform } from "@audiorective/widgets/waveform";

const clip = project.tracks.flatMap((track) => track.clips).find((clip) => clip.id === clipId);
if (clip?.kind === "audio" && clip.media) {
  const data = await clip.media.peaks(clip.startFrame, clip.frameCount);
  const waveform = mountWaveform(waveformRoot, { data });
  // Dispose this view when removing it; it does not own clip.media.
}
```

When the app opens a microphone for this take, release that microphone if later setup (`connect` or `recorder.ready`) fails, as well as after completion. Keep a borrowed microphone alive; its creator handles final disposal.

`AudioMediaWriter` accepts a caller-owned `AudioMediaStorage` as an alternative to OPFS. The storage must write in order and return a readable `Blob` or `File` on finish. `AudioMedia` reads interleaved little-endian float32 frames; `dispose()` releases only storage made by its writer. The application retains `AudioMedia` while any clip or undo entry borrows it. The demo removes its temporary OPFS takes when a project closes; an interrupted browser session can leave temporary files in site storage.

Use `await saveWorkspaceTo(workspace, writableStream)` or `saveDawProjectTo(project, writableStream)` to write a DAWproject ZIP without assembling the whole take or archive in a `Uint8Array`. This stream writes stored ZIP entries with CRC and size in every local header; it reads media twice and stops before classic ZIP's 4 GiB archive boundary. The demo uses a native save-file picker when the browser offers one; its download fallback and `saveWorkspace(workspace)` materialize the full ZIP in memory. Reopen from a `Blob` or `File` with `openWorkspaceBlob(context, blob, options)` for a running workspace, or `openDawProjectBlob(blob)` for a project alone, which retains WAV media as Blobs. The synchronous `saveDawProject(project)` accepts in-memory clips only. Each float WAV is limited by RIFF's 4 GiB length field. Both open paths verify the ZIP directory, entry sizes and CRCs before opening a project. The streaming import collects Blob parts under the browser's Blob storage policy, so actual disk versus memory use depends on the browser.

## Arrange clips and mix tracks

`Project.moveClip(clipId, trackId, time)` moves a clip on a matching track using that clip's unit (seconds for audio, beats for MIDI). MIDI moves retain the same `MidiClip.midi` for an open editor. `duplicateClip(clipId, time, trackId?)` uses the source clip's unit and makes a new ID; `removeClip(clipId)` removes it. `splitClip(clipId, offset)` and `trimClip(clipId, start, end)` use **clip-local units** (seconds for audio, beats for MIDI). The left split clip keeps the original ID. Audio boundaries round to samples; MIDI notes crossing a cut are shortened and retained on both sides, while control events inside the kept interval stay at their relative time. The latest prior channel-controller value is carried into a trimmed/split segment, and active sustain is released at its end so a cut cannot leave held notes running. These operations replace the affected clip objects and their `midi` note models, so an editor should re-read `Project.tracks` and remount a borrowed clip view. They do not rewrite stored note positions when tempo changes. Rename with `setTitle(title)` and `setTrackName(trackId, name)`, or remove a whole track with `removeTrack(trackId)`. Structural edits update `Project.cells.revision` (note edits through `MidiClip.midi` are in `Project.cells.content`); read `Project.tracks` again after an edit. `Project.setMarkers([{ time, name }, ...])` stores sorted, unique section markers in project seconds; `Project.markers` exposes the current snapshot. DAWproject stores these under standard arrangement `Markers`.

Tracks have `muted`, `solo` and `pan` (`-1` left, `0` center, `1` right), alongside linear `volume`. Use `Project.setTrackMuted`, `setTrackSolo`, `setTrackPan` or the matching `Workspace` methods. The Workspace methods apply mixer controls immediately. Solo follows the graph to and from a bus, and mute wins over solo. Each track and bus is an `@audiorective/effects` `Channel` strip; the runtime writes `Project` values into its params and the project stays the only owner.

### Apply Project edits to the live graph

Workspace batches edits made directly to its Project and applies changes to clips, tempo, mixer settings, volume automation, routes, built-in inserts and hosted patch state. It can also add or remove a bus with no new hosted device while preserving other tracks and transport.

- Use `await workspace.flush()` when the caller must wait for application, such as before inspecting a new bus node or triggering a newly added clip. Observe `workspace.cells.error` for application errors. `flush()` rejects with the failed edit's cause.
- Observe `workspace.cells.needsSync.value` when adding or removing ordinary tracks or changing the hosted device list. Call `await workspace.sync()` to rebuild the graph and stop transport at the current position. Existing audio nodes and hosts remain loaded until the rebuild.
- `workspace.checkpoint()` waits for light edits, folds live plug-in state into `Project` and returns it. `saveWorkspace()` and `saveWorkspaceTo()` call it before encoding.

`Project` keeps its content in one private store that only its methods write; a multi-field edit such as `setTempoChanges` commits once. `Project.title`, `tracks`, `tempoMap`, `markers`, `masterVolume` and `clipTimeSeconds()` are tracked reads of that store, and `project.cells.revision` counts its commits. A MIDI clip's notes belong to its `MidiClip.midi`, so a note edit does not advance `revision`; `project.cells.content` re-runs for structural commits and for note edits, and `content.value.midi.get(clipId)` holds that clip's current `notes` and `duration`. Read it from an effect that must notice every saved change, such as a dirty flag. Workspace playback and `.dawproject` saves read the note models directly, so they always see the current notes. Commands (`duplicateClip`, `trimClip`, `splitClip`, `snapshot`, `MidiClip.playbackEvents`) and the `Workspace` commands read content untracked, so calling one inside an `effect` does not subscribe it. `MidiClip.time` is trackable on the clip. `workspace.warnings` and `workspace.cells.warnings.value` expose the same read-only warning snapshot.

`Project.masterVolume` is a linear gain, initialized to `1`. Use `workspace.setMasterVolume(value)` for an immediate change during playback, or set it on the Project; the running Workspace applies it. DAWproject stores the value in its main channel. The companion audio export applies it to `mix.wav`. Track stems are tapped before master gain.

### Clip volume and fades

Call `Project.setAudioClipEnvelope(clipId, { gain, fadeIn, fadeOut })`; the running Workspace applies the edit. Use linear gain and clip-local seconds. Gain and fade edits share the original PCM. Trimming and splitting preserve fades on retained edges and start new edges with zero fade. PCM trims share their original backing allocation. File-backed clips continue to read only scheduled windows.

Playback applies the same envelope to in-memory clips and file-backed windows, including after a seek into a fade. Session PCM loops apply the envelope on each pass. Fades are written to DAWproject clip attributes in seconds. Audiorective keeps the constant gain in its project metadata, alongside the unmodified audio.

### Clip envelope helpers

`ClipEnvelope`, `normalizeClipEnvelope`, `unityClipEnvelope` and `clipGainAt` come from `@audiorective/daw/project`; `scheduleClipEnvelope` comes from `@audiorective/daw/runtime`. `ClipEnvelope` holds a linear `gain` and the edge fade lengths `fadeIn` and `fadeOut` in seconds. Validate values with `normalizeClipEnvelope(settings, duration)`. The unity default is `{ gain: 1, fadeIn: 0, fadeOut: 0 }`.

`clipGainAt(envelope, duration, seconds)` evaluates a clip-local position. `scheduleClipEnvelope(gainParam, envelope, duration, { when, offset, length })` installs the linear ramps on a borrowed gain parameter over a playback window. Supply absolute audio-clock seconds for `when` and clip-local seconds for `offset` and `length`. A window starting partway through a fade starts at that fade's existing level. The caller owns PCM, playback scheduling, and the temporary gain node.

### Clip gain automation

`project.setAudioClipGainAutomation(clipId, points)` edits a clip's own linear gain curve. Point times are seconds in the original source before stretch. The curve multiplies the clip's constant gain and fades, and track automation runs separately. A gain-only edit updates playing Arrangement voices at their current source position. Use `await workspace.flush()` when a following operation needs the applied change.

Moving, stretching or warping a clip preserves its points. Trimming or splitting updates `clip.gainAutomation.sourceStart` to the first retained source frame in seconds. Points outside the visible window still guide interpolation. Use `audioClipTimeMap(clip)` to convert waveform seconds with `sourceStart + map.outputToSource(playbackTime)` and use `map.sourceToOutput(sourceTime - sourceStart)` for the inverse. Pass the clip's warp output times as the overlay's `viewBreakpoints` so the drawing follows the same slopes as playback. Pass an empty array to clear the curve.

PCM, file-backed playback, clip and range audition, and newly launched Session PCM apply the curve. An already launched Session clip uses the curve from its launch. Audiorective stores editable points in its DAWproject metadata. Use the rendered audio fallback for other DAWs that need the audible result.

### Audition an arranged audio clip

Call `await workspace.auditionAudioClip(clipId)` to play the current clip window from its start, including trims, stretch and its gain envelope. It works with in-memory and file-backed clips. The audition goes through master volume, bypasses track devices and mixer settings, and leaves the Arrangement playhead and transport alone. Observe `workspace.cells.auditioningClip` (also `workspace.auditioningClip`) for the active or loading clip ID. A new request replaces the old one. Use `stopClipAudition()` to cancel, or let the clip finish. Committing an edit that replaces the clip stops its audition.

For a standalone player over one source, use [WavePlayer](./player.md#waveplayer) and its source-local selection. Workspace resolves a project clip's current media window and streams file-backed audio in bounded reads.

### Audition a range across audio tracks

Call `await workspace.auditionRange({ start, end }, { trackIds })` to repeat one project-second selection through master output. Omit `trackIds` to include all audio tracks. The same clock schedules the entire preview. Short tracks stay silent until the next common repeat, and the selected audio uses existing PCM and file chunk caches.

Observe `workspace.cells.auditioningRange` (also `workspace.auditioningRange`) for the active or loading range, and call `stopRangeAudition()` to stop it. A new clip or range audition replaces the previous preview. Changes to the selected tracks' clips stop the preview. Auditions include clip gain and fades, bypass the track mixer and preserve the Arrangement position. MIDI and track device playback remain in Arrangement.

### Pitch-preserving clip stretch

`Workspace.prepareAudioClipStretch(clipId, ratio, processor, { anchors?, signal? })` borrows a `WaveStretchProcessor`. Pass the desired length divided by original length. Call `apply()` on the prepared result inside the app's undo transaction, then await `workspace.flush()` if the next action depends on the applied render. Preparation leaves Project unchanged. Moving, trimming, deleting or replacing the clip invalidates a prepared edit. Preparing a newer result for that clip, cancelling the supplied signal and disposing Workspace all cancel outstanding work. Apply a prepared result once.

The example borrows the app's existing `history` manager: its synchronous `record(label, apply)` captures Project state before and after `apply`. Finish asynchronous preparation before entering that transaction; record only the synchronous application, then flush outside it. `history` belongs to the app, rather than a Workspace export.

```ts
import { TimeStretch } from "@audiorective/effects/time-stretch";

const processor = await TimeStretch.load({ wasmUrl: "/wasm/rubberband.wasm" });
try {
  const edit = await workspace.prepareAudioClipStretch(clipId, 1.5, processor);
  history.record("Stretch audio clip", () => edit.apply());
  await workspace.flush();
} finally {
  processor.dispose();
}
```

A clip stores its rendered playback plus the original audio window. A later ratio always uses that original window. Pass ratio `1` without anchors to restore it without a processor. Clip position and ID stay in place. Fade lengths scale with the clip. Offline processing loads the selected source window into memory.

To warp a clip, pass strictly increasing interior `{ sourceFrame, outputFrame }` anchors and an anchor-capable processor. For 48 kHz PCM, `{ ratio: 1, anchors: [{ sourceFrame: 48000, outputFrame: 62400 }] }` moves the point from 1.0 to 1.3 seconds while holding total length. Trimming or splitting projects each cut back to a retained source frame and rebases interior anchors. `audioClipTimeMap(clip)` exposes `sourceDuration`, `outputDuration`, `sourceToOutput(seconds)` and `outputToSource(seconds)`. Its piecewise-linear conversion also projects source-relative gain into playback time.

DAWproject stores the rendered WAV as the playable clip. Audiorective retains the original window, ratio and anchors in private project entries. The file opens and plays without a stretch engine. Re-rendering requires the caller's processor. Use `project.hasFileBackedAudio` to choose a streaming save when either the playback or a retained source is file-backed.

## Mixer buses and sends

Use `Project.addTrack(name, "bus")` for a submix or pass `{ busRole: "effect" }` for a shared effects return. Both have the same rack, fader and automation as other tracks. Route a track's main output to one bus or to the master, then add separate post-fader, post-pan sends with linear gains. The model rejects unknown targets and feedback cycles before changing the graph.

```ts
const wet = project.addTrack("Echo return", "bus", { busRole: "effect" });
project.setTrackEffects(wet.id, [{ id: "echo", type: "delay", delayTime: 0.3, feedback: 0.35, enabled: true, wet: 1 }]);
await workspace.flush();

for (const [id, gain] of [
  [drums.id, 0.3],
  [keys.id, 0.15],
] as const) {
  workspace.setTrackRouting(id, { outputBusId: null, sends: [{ busId: wet.id, gain }] });
}
```

`Workspace.setTrackRouting()` applies a route edit immediately. `Project.setTrackRouting()` works with or without a live Workspace. With a live Workspace, flush for a deterministic routing readback. Removing a destination restores incoming main outputs to master and drops sends to the removed bus. Soloing a return keeps its inputs and suppresses their parallel dry outputs. `workspace.trackMixerOutput(trackId)` borrows a post-fader node for a meter. Exported individual stems are taken there, before downstream bus processing, while the exported mix passes through all buses.

Routing saves to DAWproject channel destinations and post-fader sends. DAWproject files with pre-fader sends, extra send controls or other unsupported routing are rejected. The [DAWproject schema](https://github.com/bitwig/dawproject/blob/main/Project.xsd) defines those wire formats.

## Live browser workspace

```typescript
import { Project } from "@audiorective/daw/project";
import { Workspace } from "@audiorective/daw/runtime";
import { openWorkspace, saveWorkspace } from "@audiorective/daw";

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
]);
await workspace.flush();
const bytes = await saveWorkspace(workspace); // checkpoints live plug-in state, then encodes
detachEditor?.();
workspace.dispose();
project.dispose(); // `create` borrows the project, so the caller disposes it

const reopened = await openWorkspace(context, bytes, {
  destination: context.destination,
  workletUrl: "/assets/webclap-worklet.js",
  resolveBundle: ({ pluginId }) => (pluginId === device.pluginId ? device.bundleUrl : undefined),
});
// Inspect reopened.warnings and reopened.project before playing.
```

`Workspace` owns runtime nodes and Clock. The caller owns its context and any `Project` passed to `Workspace.create`, and disposes that project separately. A disposed Project rejects edits and saves. A Workspace from `openWorkspace` or `openWorkspaceBlob` owns the project it opened: `workspace.dispose()` disposes it (disposing it again is harmless). Pass `{ ownsProject: true }` to `Workspace.create` to hand a project over the same way; replacing `workspace.project` ends that ownership. `workspace.host(device.id)` returns the loaded plug-in host, if available. `workspace.cells` holds every observable value as a read-only cell: `needsSync`, `error`, `warnings`, `session`, `auditioningClip` and `auditioningRange`. `workspace.position` and `workspace.duration` are project seconds for external playheads and seek controls. For a MIDI piano roll, pass `project.tempoMap.secondsToBeat(workspace.position) - clip.time` as its playhead (beats from the clip's start). `sync()` rebuilds routing after changing tracks or devices (`cells.needsSync` reports when), preserving the playhead and stopping playback. MIDI note edits refresh Clock while playing. `pause`, `stop` and `seek` fade out active arrangement sources and release hosted instruments. Playback schedules a live start ahead on the audio clock. Play and seek wait for file-backed chunks at the target and request later chunks ahead of the playback window. A seek made while playing keeps `clock.state` and `player.isPlaying` at `playing` during that wait: the playhead holds at the target, nothing sounds, and audio resumes from the exact requested frame (a `play()` during the wait resolves when it has). A media read that fails is reported once in `cells.error` and its clip is skipped for the rest of that playback run; the next `play()` or `seek()` reads it again, and a successful read clears the error (a replaced or removed clip never inherits it). A missing or mismatched bundle yields a warning and leaves that track's device silent. `workspace.warnings` (also `workspace.cells.warnings`) is a frozen array of these notices plus file-open notices passed through `WorkspaceOptions.warnings` (`openWorkspace` supplies them first); it is a tracked read, never mutated in place, and each new notice replaces it.

For recorded takes, capture `const anchor = workspace.takeAnchor()` before arming `AudioRecorder`; use `workspace.takePosition(anchor, take, measuredInputLatencySeconds)` when adding the result to `Project`. For `MidiRecorder`, capture the anchor the same way before `record()`; `takePosition` returns project seconds, so convert it with `project.tempoMap.secondsToBeat(...)` before `addMidiTake`, whose position is project beats. A recorder attached to the playing Workspace clock already carries `take.startBeat`, which `addMidiTake` uses by default. `takePosition` maps the actual take start to project seconds while transport plays; while transport is stopped, it keeps the anchor's project cursor. `takeAnchor(audioTime)` maps that audio time to project time, so an anchor taken in the short lead `play()` leaves before the audible start is exact too: a take that starts before the transport's start is placed earlier by the same offset (and throws below project zero, as with latency). An anchor captured while a seek waits for media cannot be placed, because the audible start is not known yet; capture it after the seek resumes. A positive measured input latency moves the placement earlier. If that would cross project zero, the method throws instead of silently losing timing; record with preroll or reduce the correction. The demo exposes a locally stored millisecond correction field in its browser panel and defaults to zero until the user measures their device.

### Resolve saved plug-in bundles

Bundle URLs from project files are hints. An app approves a URL by returning it from `WorkspaceOptions.resolveBundle`, or returns `undefined` to decline. This applies to both workspace open functions and to `Workspace.create` with a project read by the codec.

```ts
const workspace = await openWorkspaceBlob(context, file, {
  resolveBundle: ({ pluginId }) => (pluginId === "com.oxo.music.oxosynth2" ? "/plugin/oxo-synth2.wclap" : undefined),
});
```

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

**Light edits** keep the same tracks and devices: tempo map, clips (including envelopes, fades, gain automation and warp or stretch), effect rack settings and macros, device state bytes, mixer (master volume, track volume, mute, solo, pan), volume automation, track routing and sends, and adding or removing a bus track that hosts no device. They apply in place and hosts stay loaded. Edits coalesce: any number of edits in one synchronous burst cause one application in the next microtask. Applications never overlap. Device-state restore is asynchronous, so edits that arrive during one queue exactly one more application that reads the latest `Project`.

**Structural edits** add, remove or retype tracks (a bus without devices is a light edit), or add, remove, reorder or replace devices (a different plug-in or bundle). `sync()` stops transport, captures live plug-in state, reloads WebCLAP hosts and rebuilds routing; it is slow, asynchronous, can fail and interrupts sound. For that reason the workspace never runs it by itself. It sets the read-only `workspace.cells.needsSync` and leaves transport and hosts untouched, so the UI can offer a rebuild action at a moment the user accepts a glitch. `sync()` clears `needsSync` and applies everything in `Project`, including light edits made meanwhile. While `needsSync` is true no automatic application runs: light edits wait for `sync()`, or take effect if the topology is restored first. The direct `Workspace` mixer and effect methods still apply immediately to tracks that are already loaded.

`workspace.cells.error` is a read-only cell holding the message of the latest failed automatic application (for example a plug-in rejecting saved state), or `null`. The next successful application or `sync()` clears it. Failures never become unhandled rejections. Edit again or call `sync()` to retry application. A media read failure publishes one error per clip in this cell. An audio fallback export rejects and aborts its destination when its render cannot read a clip's media.

`await workspace.flush()` resolves when all pending automatic application has finished and rejects with the latest failure. `checkpoint()` (and so `saveWorkspace()` and `saveWorkspaceTo()`) and `exportAudioFallbackTo(workspace, …)` wait for pending application first, but do not reject because of an earlier failure: `Project` is the document. After `dispose()` the watcher is disposed, pending applications are dropped, and `flush()` resolves without error.

Edits the runtime makes itself, such as capturing plug-in state into `Project` during `sync()` or `save()`, and the `Workspace` mixer and effect methods, are marked as already applied, so they cause no second application. `refreshArrangement()` and `sync()` remain public for callers that want to drive those operations explicitly.

### Mount playback controls

Pass `workspace.player` directly to `mountPlayer` for play, pause and seeking. Its seek bar follows the project duration in seconds, including clip and tempo edits. Programmatic seeks and stops update the view even while paused.

```typescript
import { openWorkspaceBlob } from "@audiorective/daw";
import { mountPlayer } from "@audiorective/widgets/player";

const options = { destination: context.destination }; // Route to speakers in this app.
const workspace = await openWorkspaceBlob(context, file, options);
const controls = mountPlayer(container, { player: workspace.player });

// On teardown or before mounting controls for another Workspace:
controls.dispose();
workspace.dispose(); // also disposes the project it opened
```

The same view works with `Workspace.create()` and `openWorkspace()`. Pass a `destination` in all three paths for audible output, or connect `workspace.output` to your own graph. The widget borrows the transport. Your app still decides when to stop playback at the end or loop a region.

## Runtime internals

`Workspace` is a facade over small internal modules; none is part of the `daw/runtime` surface except what `Workspace` re-exports. A collaborator receives a narrow handle (a function returning the current `Project`, the shared track-runtime map, an `isDisposed` check) and never imports `Workspace`. Project stays the only owner of persistent data. The only collaborator write is a prepared stretch the caller applies in its own undo transaction, and observable state stays in `Workspace.cells`.

| Module                                  | Owns                                                                                                                                                                             | Reads                                                     |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `runtime.ts` (`Workspace`)              | The public API, the `cells`, the track-runtime map, the graph build, transport (`play`, `pause`, `stop`, `seek`), and Project-edit reconciliation (`flush`, `sync`, light edits) | Everything below, through narrow handles                  |
| `mixer.ts` (`Mixer`)                    | The `Channel` and `SendBus` strips, send routing, and writing Project mixer values into them                                                                                     | The track map, the current Project, the master `GainNode` |
| `clip-scheduler.ts` (`ClipScheduler`)   | Scheduled audio handles, media chunk loading, decoded-buffer caches, one tick window of MIDI and audio clips                                                                     | Track runtimes and timing passed per call                 |
| `audition.ts` (`Audition`)              | The current clip or range audition cell and the clock or handle that plays it                                                                                                    | The current Project, the scheduler, the master output     |
| `clip-stretch.ts` (`ClipStretch`)       | One cancellable stretch job per clip and the prepared edit it returns                                                                                                            | The current Project                                       |
| `take-placement.ts`                     | Pure take-anchor validation and take-position maths                                                                                                                              | Nothing                                                   |
| `track-reconcile.ts`                    | Pure diffs between a live track and its Project track (rack settings, gain-automation-only edits, device keys)                                                                   | Nothing                                                   |
| `track-runtime.ts`, `project-lookup.ts` | The shared `TrackRuntime` type and a clip lookup by id                                                                                                                           | Nothing                                                   |

## Step Sequencer

`workspace.transport` is the Workspace's Clock (`workspace.clock`): `transport.timeline`, `transport.attach(scheduler)` and `transport.refresh()` let any scheduler, such as an `@audiorective/sequencer` `Sequencer` created with `{ transport: workspace.transport, context: workspace.context }`, follow Workspace's beats and tempo. Pause, stop and seek reset attached schedulers; Workspace keeps play, pause, seek and tempo.

Attach a caller-owned `StepSequencer` with `workspace.transport.attach(seq)`. Route each lane's `output` (or your `onHit` voices) to a caller-selected mix path. The attached sequencer uses Workspace's Clock windows and tempo mapping. Edits to its lanes and steps re-queue pending hits, and transport pause, stop and seek reset its scheduled events. Call the returned detach function (or `seq.dispose()`) to remove only this sequencer. An attached live pattern belongs to the current app session. Saveable Arrangement clips belong to Project.

## Clip Launcher

`workspace.session` is a [`ClipLauncher`](./launcher.md) over the Project's audio tracks, as a cell (`workspace.cells.session`): `session.value.tracks[trackId].clips[i]` is the Session clip of the i-th clip of that track, `null` when it is not an in-memory PCM clip. `workspace.sessionClip(trackId, clipId)` finds it by Project clip ID (a tracked reader). Launch with the launcher's own commands: `workspace.sessionClip(t, c).launch({ quantize: "4n" })`, `session.value.launchScene([clipA, clipB])` (one boundary for every listed track), `session.value.tracks[t].stop()` (back to Arrangement), `session.value.cancelQueued()`, and read `session.value.playing`, `queued` and each clip's cells. The launcher's [`quantize` cell](./launcher.md#layer-1-tracks-of-buffers) defaults to a bar of the Project's time signature; set it to `"4n"` for a beat or `"none"` for now.

A launched clip plays through the track's devices, inserts and mixer (it is the launcher track's output connected to the track input) and takes that track away from Arrangement until it is stopped or a one-shot ends. Tracks that are not launched keep playing as before. Session clips loop at their original sample rate and length and keep their recorded speed (`warp: false`); `clip.configure({ loop: false })` makes one a one-shot that returns the track to Arrangement at its exact audio end.

The launcher follows `workspace.transport`: a launch made while stopped waits for `play()`, Pause freezes it and Play starts fresh (clips are silent, waiting launches keep their place), Stop and Seek clear it, a tempo change moves waiting boundaries with the beat and keeps playing clips going. Clip edits that reach `refreshArrangement()` replace the Session clips to match, and a Session clip whose Project clip is removed is stopped at once. `sync()` (a structural rebuild) replaces the launcher, so read `workspace.session.value` inside the effect that uses it. The launcher is built the first time `session` or `sessionClip` is read (an app that never launches clips never copies their audio), and a clip's audio is read when the launcher is built or the clip is replaced. DAWproject stores Arrangement and media; the launcher state and scene layout live in the session. MIDI and file-backed media remain playable in Arrangement.

```ts
import { mountClipGrid } from "@audiorective/widgets";

const session = workspace.session.value;
const verseDrums = workspace.sessionClip(drums.id, drumsClip.id)!;
const verseBass = workspace.sessionClip(bass.id, bassClip.id)!;
session.quantize.value = "4n";
const grid = mountClipGrid(root, {
  launcher: session,
  launch: async (command) => {
    try {
      await workspace.play(); // a launch made while stopped would wait for play
      command();
    } catch (error) {
      showError(error);
    }
  },
});
grid.setLayout({
  tracks: [
    { track: session.tracks[drums.id]!, label: "Drums" },
    { track: session.tracks[bass.id]!, label: "Bass" },
  ],
  scenes: [
    {
      label: "Verse",
      clips: [
        { track: session.tracks[drums.id]!, clip: verseDrums, label: "Drum loop" },
        { track: session.tracks[bass.id]!, clip: verseBass, label: "Bass loop" },
      ],
    },
  ],
});
// Tear down the DOM view while leaving the borrowed Workspace available.
grid.dispose();
```

## Effect rack

`ProjectTrack.effects` is the ordered snapshot of built-in inserts (Filter, PingPongDelay and Equalizer slots). The track's runtime rack is a data-driven layer over an [`EffectChain`](./effects.md#effectchain): it owns its effects, keeps processors with the same slot ID and type across edits, and reorders, adds and removes them with the chain's click-free crossfades. An empty rack passes audio through. Bypass (`enabled: false`) sets the effective mix to dry while preserving the configured mix. Filter accepts lowpass or highpass, 20–20,000 Hz and Q 0.1–20. Delay accepts 0.01–1 second and feedback 0–0.95. Both accept a mix from 0–1. An EQ slot is `{ id, type: "eq", enabled, wet, bands }`; each band uses `{ frequency, gain, q }` and follows the [Equalizer ranges](./effects.md#parametric-equalizer), and edits retain a slot's Equalizer when its band count stays the same.

```typescript
project.setTrackEffects(track.id, [
  { id: "filter", type: "filter", enabled: true, wet: 1, mode: "lowpass", frequency: 1200, q: 0.7 },
  { id: "delay", type: "delay", enabled: true, wet: 0.35, delayTime: 0.25, feedback: 0.25 },
]);
```

Use `project.setTrackEffects(trackId, slots)` for headless project edits and await `workspace.flush()` when you need to wait for the rack to reflect that edit. For an already loaded track, `workspace.setTrackEffects(trackId, slots)` applies the change synchronously to the rack and Project, preserving transport and loaded WebCLAP hosts. The signal runs from the track's source through its hosted devices, then the rack, then the mixer. `workspace.trackEffectOutput(trackId)` borrows the rack's pre-mixer output for an analyser. Disconnect only the analyser you connected, or remount it if a structural edit rebuilt that track.

`project.setTrackRackPreset(trackId, { effects, macros })` replaces a track's insert setup and macro settings in one edit. Macro settings are in `track.effectMacros` (see [Rack macros](#rack-macros)). Await `workspace.flush()` after structural rack edits. Bind a UI knob to `workspace.trackMacroValue(trackId, macroId)` for reads and `workspace.setTrackMacroValue(trackId, macroId, value)` for immediate edits. The latter updates the graph and Project together. Use the Project setter for headless editing. Project archives preserve mappings and positions in Audiorective metadata. The rendered audio fallback carries the audible settings to other DAWs.

The DAW's Devices panel inserts, adjusts, bypasses, reorders and removes Filter, Delay and EQ slots. DAWproject uses vendor-specific `BuiltinDevice` entries in order and versioned JSON settings in `plugins/`. Open the project in Audiorective to edit the inserts. Use the audio fallback when sharing the processed sound with another DAW.

Use `workspace.trackEffectOutput(trackId)` to connect a borrowed spectrum analyser. Use `workspace.trackFilterResponse(trackId, slotId, frequencies, magnitudes, phases)` to draw the live response for a Filter or Equalizer slot. Apply editor mutations with `setTrackEffects()` so the controls, audio and saved settings share one owner.

### Rack macros

Each macro owns one normalized control and one or more built-in parameter targets. Set its mappings in a complete preset.

```typescript
project.setTrackRackPreset(track.id, {
  effects: track.effects,
  macros: [
    {
      id: "tone",
      label: "Tone",
      value: 0.5,
      targets: [
        { slotId: "filter", parameter: "frequency", min: 200, max: 8000, scale: "exponential" },
        { slotId: "delay", parameter: "feedback", min: 0.05, max: 0.65 },
      ],
    },
  ],
});
await workspace.flush();
workspace.trackMacroValue(track.id, "tone")!.value; // bind a knob here
workspace.setTrackMacroValue(track.id, "tone", 0.7);
```

Writing a macro moves the native macro timeline and every mapped target together, and its value is what the Project keeps. The control stays valid across `setTrackEffects`. For audio-clock automation, pass `workspace.trackMacroAutomation(trackId, macroId)` to [AutomationBinding](./automation.md). Linear or hold segments in the normalized curve produce native ramps or steps on the mapped parameters. Exponential targets require positive endpoints. Stop a running binding before taking manual control so subsequent curve edits do not reprogram the target.

Only one macro can own a given slot parameter. Use `rackMacroRange(slot, parameter)` (from `@audiorective/daw/project`) for ranges. Supported targets are mix (`wet`) on every insert, Filter `frequency` and `q`, and Delay `delayTime` and `feedback`. Removing a slot drops its mappings. Bypassing a slot keeps its macro phase and makes that insert dry.

A preset carries version 1, the ordered slots, mappings and current macro positions. Authored curves belong to their caller. A successful recall resets the recalled positions and cancels their old schedules. Existing controls retain identity when their IDs and labels match.

## File contents and fidelity

The ZIP contains standard `project.xml`, `metadata.xml`, `audio/*.wav` and, for WebCLAP devices, `plugins/*.bin`. Standard XML holds track/channel structure, `ClapPlugin` identity and `State` references, clip positions, notes, controller points, initial tempo and optional beat-based step-tempo automation, time signature, volume automation, arrangement markers, and channel mute/pan/solo. `audiorective/host.json` maps a CLAP device to a WebCLAP bundle URL; this is an Audiorective locator, not a portable DAWProject property. `audiorective/state.json` holds note IDs, the next generated project ID and the original ordered MIDI messages. Its fingerprint covers the clip's unit and standard note/control content; the MIDI details of a version 1 or 2 sidecar never attach to a clip, so such a file opens from standard XML with a warning (its audio details still apply). If another application changes that content or removes the private entry, `openDawProject` rebuilds from standard XML and returns a warning. Audio sidecar data follows the XML audio ID and asset path, so reordering clips keeps gain and ID attached to the original audio.

For plug-in round trips, use `saveWorkspace(workspace)` to capture the live patch. The portable part of DAWProject is the CLAP ID and state bytes; `audiorective/host.json` is the private lookup needed to find browser `module.wasm`. Another DAW needs its own matching CLAP binary, and may drop the private bundle locator when saving.

Call `portabilityReport(workspace.project, workspace.warnings)` (from `@audiorective/daw/dawproject`; a pure function of `Project`, so it also runs in Node with `portabilityReport(project)`) before sharing. It lists content represented in standard DAWproject fields, required CLAP IDs and limitations; it does not claim that a particular DAW has passed import testing. For an audible companion, call `await exportAudioFallbackTo(workspace, writableStream, { tailSeconds: 1, signal, onProgress })` (from `@audiorective/daw/runtime`). It renders a separate runtime offline from project time zero, writing a ZIP with `mix.wav`, per-track post-mixer `tracks/<id>.wav` and `manifest.json`. The render runs on an `OfflineAudioContext` in steps of the transport's tick interval; between steps it waits for file-backed media chunks and device messages and for the OPFS writer to catch up, so main-thread work, a slow media read or the live context's state cannot drop or delay frames, and the same project exports the same samples. It can finish faster or slower than the project's length. The mix includes hosted WebCLAP instruments and effects; the source project and its playback keep running. Captured PCM is temporarily stored in browser OPFS and removed after export; the offline context itself holds one channel of the whole render (about 11.5 MB per minute at 48 kHz). The export rejects unresolved devices, missing frames, cancellation, an offline render the browser cannot allocate and storage failures instead of delivering a knowingly incomplete backup. A project with more than 15 tracks exports the full mix without stems because one recorder supports at most 32 packed channels. The demo offers **分享說明** and **匯出音訊** next to **儲存工程**. This ZIP is a companion audio delivery, not a second DAWproject or an editable plug-in replacement.

`Project.snapshot()` supplies the export runtime with independent MIDI and in-memory PCM clip data plus copied device state. File-backed `AudioMedia` stays borrowed; retain it until the export settles.

This is a narrow native slice. `openDawProject` and `openDawProjectBlob` accept the structure this package writes: regular tracks, submix and effects buses, post-fader sends, second-based audio and beats- or seconds-based MIDI clips (seconds convert to beats on open), CLAP devices, Audiorective Filter, Delay and EQ inserts, controller points, volume automation, arrangement markers, channel mute/pan/solo, fixed or step tempo, time signature and 32-bit float WAV. The MIDI writer accepts note on/off, control change, pitch bend, program change, channel pressure and polyphonic key pressure. Other messages fail on save. Master volume is supported. A master with devices, mute, pan or solo is rejected. Unsupported XML structures throw instead of disappearing on the next save. Other DAWs may open the standard content but are not required to preserve Audiorective's private entries or resolve the WebCLAP bundle; cross-DAW round-trip preservation remains to be verified. VST/AU hosting and arbitrary routing remain outside this slice.

A small [Cubase 14 export shared on the Steinberg forum](https://forums.steinberg.net/t/import-and-export-of-media-projects-and-dawprojects/1010846) was probed against both open paths (inner `test.dawproject` SHA-256 `b45bdefe6101b58db1aad86757801d816350c9b6c0eb7b9ff5a9f55edea25708`). After building the daw package, `pnpm --filter @audiorective/daw probe:cubase` downloads the public fixture, verifies its hash and repeats the probe. Pass a previously downloaded inner `.dawproject` as an argument to run offline; its hash is checked in the same way. Empty standard metadata fields are accepted. The file still rejects at `Project XML has unsupported Structure content.` because it contains a track folder and a separate master channel; it also carries EQ devices and time-signature automation that the model cannot preserve. This is an observed rejection, not a claim of Cubase import compatibility. Five separately generated Bitwig-shaped fixtures also reject on unsupported structure. Wider import needs explicit model semantics and preservation tests rather than ignoring those elements.

## Common errors

| Clip message                                                                                                                                                     | Fix                                                                                                 |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `Workspace clip stretch needs an audio clip.` / `Workspace clip stretch ratio must produce at least one sample.`                                                 | Choose a current audio clip and a positive ratio yielding at least one output sample.               |
| `Workspace clip stretch needs a processor.`                                                                                                                      | Supply a `WaveStretchProcessor` for ratios other than 1.                                            |
| `Workspace audition needs an audio clip.`                                                                                                                        | Use the ID of a current audio clip in the project.                                                  |
| `Workspace range audition needs a non-negative range at least one audio frame long.`                                                                             | Choose finite seconds on the project timeline.                                                      |
| `Workspace range audition needs existing audio tracks.` / `Workspace range audition needs audio in the selected range.`                                          | Select existing audio tracks with at least one clip crossing the range.                             |
| `Audio clip changed while rendering stretch.` / `Audio clip stretch was cancelled.`                                                                              | Prepare a new result using the current clip revision and apply it once.                             |
| `Project clip stretch needs a positive ratio and matching rendered audio.` / `Project clip stretch needs a compatible original audio window and positive ratio.` | Retain the original sample rate and channel count. Render the requested rounded output frame count. |
| `Project clip stretch source is missing.`                                                                                                                        | Reopen an intact Audiorective project archive with its source WAV.                                  |
| `Project clip envelope needs an audio clip.`                                                                                                                     | Pass an ID from a current audio track.                                                              |
| `Project audio fades need seconds.`                                                                                                                              | Import clip fades in seconds.                                                                       |
| `Project clip gain automation needs an audio clip.`                                                                                                              | Pass the ID of an existing audio clip.                                                              |
| `Project clip warp needs strictly increasing interior source and output frames.`                                                                                 | Keep each anchor inside both frame windows and in increasing order on both axes.                    |
| `Audio clip gain automation needs a non-negative source start and non-negative finite gains.`                                                                    | Use original source seconds and non-negative linear gain.                                           |
| `Clip gain must be non-negative and fades must fit its duration.`                                                                                                | Keep the combined fade lengths within the clip duration.                                            |

| Routing message                                                                                               | Fix                                                                   |
| ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `Project bus roles need a bus track and a supported role.`                                                    | Use `busRole` on a bus with role `submix` or `effect`.                |
| `Project track routing needs an existing track.` / `Sync new or removed tracks before changing live routing.` | Add the tracks and await `workspace.sync()` before live rewiring.     |
| `Project routes need existing buses, unique sends and non-negative send gain.`                                | Use current bus IDs, one send per bus and a non-negative linear gain. |
| `Project track routing cannot form a cycle.`                                                                  | Remove the feedback edge between buses.                               |
| `Project has duplicate channel IDs.` / `Project bus tracks cannot contain clips.`                             | Use unique channel IDs and put clips on source tracks.                |
| `Project has unsupported send settings.`                                                                      | Use post-fader sends with linear gain.                                |

| Effect rack message                                                                                     | Fix                                                                                                                  |
| ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `Project effects need an existing track.` / `Workspace effects need a live track.`                      | Use its current track ID, and `await workspace.sync()` after adding a new track before calling the Workspace method. |
| `Project master volume needs a finite non-negative value.`                                              | Pass a linear gain such as `0.3` or `1` to `setMasterVolume()`.                                                      |
| `Project has an unsupported built-in effect.` / `Project built-in effects must follow WebCLAP devices.` | Import supported Audiorective Filter, Delay and EQ inserts after the hosted devices.                                 |
| `Project built-in effect state is missing or reused.` / `Project built-in effect state is invalid.`     | Restore the matching, versioned insert state entries.                                                                |
| `Project macro needs an existing track and macro.`                                                      | Use IDs from the track's current effectMacros.                                                                       |
| `Flush the project before setting a live track macro.`                                                  | Wait for the pending rack edit, then look up the current macro ID.                                                   |
| `TrackRack needs unique slot IDs and valid Filter, Delay or EQ settings.`                               | Use distinct nonempty slot IDs and settings inside the [rack ranges](#effect-rack).                                  |
| `TrackRack preset version must be 1.`                                                                   | Pass a version 1 snapshot or omit the version when authoring a preset.                                               |
| `TrackRack macros need unique IDs, normalized values, and distinct valid targets.`                      | Use positions from 0 to 1 and assign a supported slot parameter to at most one macro.                                |
| `TrackRack macro target is unavailable.`                                                                | Rebuild the preset against the current rack slots and supported ranges.                                              |
| `TrackRack macro value needs a number from 0 to 1.`                                                     | Pass a finite normalized position.                                                                                   |
| `TrackRack macro automation needs a time and a normalized curve starting at zero.`                      | Use absolute audio seconds for the start and a relative curve beginning at zero.                                     |
| `TrackRack macro is disposed.`                                                                          | Look up the replacement control on the live rack.                                                                    |

| Message                                                                                                                                                                                                                   | Cause and fix                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
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
| `Project device state needs bytes.` / `Workspace is disposed.`                                                                                                                                                            | Supply `Uint8Array` state or create a new Workspace after disposing one.                                                                                      |
| `Project has an unsupported device role.` / `Project device state asset is missing.`                                                                                                                                      | Open a CLAP instrument on a MIDI track or audio effect on an audio track, with its referenced state file in `plugins/`.                                       |
| `workspace.cells.error` holds a message / `await workspace.flush()` rejects                                                                                                                                               | An automatic application failed (often a plug-in rejecting `loadState`). Fix the edit, edit again, or call `await workspace.sync()`; success clears the cell. |
| `workspace.cells.needsSync` stays true and edits are silent                                                                                                                                                               | Tracks or devices changed. Call `await workspace.sync()`; light edits wait until then.                                                                        |
| `Workspace seek needs non-negative seconds.`                                                                                                                                                                              | Seek to a finite non-negative project time.                                                                                                                   |
| `Workspace take anchor needs a finite non-negative audio time.` / `Workspace take placement needs a valid anchor, take start and non-negative input latency.`                                                             | Use the recorder's start clock and a finite, non-negative measured latency.                                                                                   |
| `Workspace take anchor was captured while a seek waited for media; capture it after the seek has resumed.`                                                                                                                | Call `takeAnchor()` once the seek has resumed, then `takePosition(anchor, take)`.                                                                             |
| `Workspace take placement crosses project zero; use preroll or a smaller latency correction.`                                                                                                                             | Record after sufficient preroll so the corrected clip starts at or after project zero.                                                                        |
| `Project clip needs a matching track.` / `Project automation needs an existing track.`                                                                                                                                    | Use a current track ID of the right kind.                                                                                                                     |
| `Project clip time must be finite and non-negative.` / `Project audio clips need a time, sample rate and equal-length PCM channels.`                                                                                      | Pass time in the clip's unit (seconds for audio, beats for MIDI) and valid equal-length Float32 channel arrays.                                               |
| `Project MIDI duration must be finite non-negative beats.`                                                                                                                                                                | Pass a finite clip `duration` of zero or more beats.                                                                                                          |
| `Project MIDI events need finite non-negative times and MIDI bytes.`                                                                                                                                                      | Use clip-relative non-negative event times in beats and nonempty `Uint8Array` messages.                                                                       |
| `Project MIDI has events outside supported portable content.`                                                                                                                                                             | Use valid MIDI channel messages. System messages need a portable representation before saving.                                                                |
| `Project automation needs finite unique times and non-negative values.`                                                                                                                                                   | Provide finite points at distinct non-negative project seconds with `linear` or `hold`.                                                                       |
| `Project WAV needs equal-length PCM channels and a valid sample rate.` / `Project audio needs an IEEE float32 WAV asset.`                                                                                                 | Supply valid PCM, or convert an imported asset to 32-bit float WAV before opening this slice.                                                                 |
| `Project archive is missing or too large.` / `Project archive is too large.` / `Project archive needs project.xml and metadata.xml.`                                                                                      | Supply a valid bounded `.dawproject` ZIP with both required XML entries.                                                                                      |
| `Project archive is incomplete or corrupt.` / `Project archive entry is corrupt: …`                                                                                                                                       | Recover a complete, unmodified archive and reopen it.                                                                                                         |
| `Project has unsupported master channel devices, mute, pan or solo.`                                                                                                                                                      | Preserve the source archive. Open a copy whose master contains only supported routing and volume.                                                             |
| `Project text contains characters that XML cannot represent.`                                                                                                                                                             | Remove illegal control characters or unpaired UTF-16 surrogates from the input.                                                                               |
| `Project is disposed.`                                                                                                                                                                                                    | Edit or save an active Project. Reopen the archive to get a new Project.                                                                                      |
| `Audio clip … could not read its media: …`                                                                                                                                                                                | Restore the media source, then call `play()` or `seek()` again (a successful read clears the error), or reopen an intact archive.                             |
| `Project archive has unsupported files.`                                                                                                                                                                                  | This slice cannot preserve extra archive members; use a supported project or extend the codec before resaving.                                                |
| `Project XML is invalid: …` / `Project XML needs …` / `Project XML has invalid …`                                                                                                                                         | Repair malformed, missing or invalid XML fields.                                                                                                              |
| `Project XML has unsupported … content.` / `Project XML has unsupported … attributes.`                                                                                                                                    | The file uses a DAWproject feature outside this slice; use a supported simple project or extend the codec before resaving.                                    |
| `Project needs DAWproject version 1.0.` / `Project transport needs BPM tempo.` / `Project arrangement needs seconds time.` / `Project track lanes need seconds time.`                                                     | Open a version 1.0 project with seconds-based clips and a supported fixed or step tempo map.                                                                  |
| `Project tempo needs positive finite BPM.` / `Project tempo changes need unique positive beats and BPM.` / `Project snap needs a positive beat interval.`                                                                 | Supply a valid initial BPM, unique changes after beat zero, and a positive snap interval.                                                                     |
| `Project tempo automation needs beat positions and BPM.` / `Project has unsupported tempo automation target.` / `Project has unsupported tempo interpolation.` / `Project tempo automation disagrees with transport BPM.` | Import beat-based hold points targeting the transport tempo, with beat-zero BPM matching Transport.                                                           |
| `Project has unsupported track routing.` / `Project has unsupported master routing.` / `Project has an unsupported track kind.` / `Project has unsupported track volume units.`                                           | Use regular audio/MIDI tracks or buses, valid channel destinations and linear volume.                                                                         |
| `Project MIDI clip has unsupported audio content.` / `Project MIDI clip content time must match its clip lane.` / `Project MIDI has unsupported control automation.`                                                      | Keep placement, notes and controllers in the same seconds or beats lane.                                                                                      |
| `Project clip lane needs seconds or beats time.` / `Project audio clip has unsupported time unit.`                                                                                                                        | Use seconds or beats for MIDI and seconds for audio.                                                                                                          |
| `Project audio clip has unsupported content.` / `Project audio asset is missing.` / `Project audio asset does not match its XML metadata.`                                                                                | Include the referenced 32-bit float WAV with matching sample rate, channel count and duration.                                                                |
| `Project file-backed audio needs saveDawProjectTo().`                                                                                                                                                                     | Use the streaming writer for media-backed clips; `saveWorkspace()` is an in-memory convenience.                                                               |
| `Project media clip needs a valid frame window and time.` / `AudioMedia needs a valid PCM frame window.` / `AudioMedia read needs a valid frame window.`                                                                  | Use integer frames inside the borrowed media and a finite project position.                                                                                   |
| `Project media clip needs an AudioMedia asset.`                                                                                                                                                                           | Pass an `AudioMedia` returned by a writer or constructed over a valid interleaved float32 Blob.                                                               |
| `AudioMediaWriter needs browser OPFS storage.` / `AudioMediaWriter lost captured frames.` / `AudioMediaWriter take does not match captured frames.`                                                                       | Use OPFS on a compatible secure origin, keep ordered recorder chunks and pass its matching `record({ onChunk })` span.                                        |
| `AudioMediaWriter is closed.` / `AudioMedia is disposed.` / `AudioMedia asset ended before its declared frame count.` / `Project media asset ended before its declared frame count.`                                      | Keep the writer/media alive until saving and playback finish; verify the backing file was not truncated.                                                      |
| `AudioMediaWriter needs finite PCM samples.` / `AudioMedia asset has non-finite PCM samples.`                                                                                                                             | Repair invalid sample values in the source take or imported media.                                                                                            |
| `AudioMedia peaks need a valid frame window.` / `Workspace media chunk is outside the clip.`                                                                                                                              | Request positive integer frames inside the current clip; refresh the runtime after clip edits.                                                                |
| `AudioMediaWriter needs a sample rate and 1–32 channels.` / `AudioMediaWriter needs equal-length PCM channels.`                                                                                                           | Match the writer to the recorder sample rate and channel count, with equal-length chunks.                                                                     |
| `Project media asset is missing.` / `Project archive has unsupported media path.` / `Project archive has invalid entry data.`                                                                                             | The media/archive source is incomplete or malformed; keep the original and retry with a valid asset.                                                          |
| `Project audio needs a canonical IEEE float32 WAV asset.` / `Project archive has duplicate or unsafe paths.` / `Project archive is incomplete.`                                                                           | Use a complete ZIP with safe unique paths and canonical float32 WAV assets for streamed import.                                                               |
| `Project has unsupported … metadata.`                                                                                                                                                                                     | A nonempty metadata field outside Title cannot be preserved; keep the original file until the model supports it.                                              |
| `Project portable ZIP needs at most 65535 entries.` / `Project portable ZIP entry exceeds 4 GiB.` / `Project portable ZIP exceeds 4 GiB.`                                                                                 | The streaming writer uses classic ZIP; split the project or add ZIP64 support before writing a larger archive.                                                |
| `Project portable ZIP needs unique safe paths.` / `Project portable ZIP source size changed.` / `Project portable ZIP source changed while saving.` / `Project portable ZIP was cancelled.`                               | Keep entry names unique and media immutable until the two-pass save finishes; retry after cancellation.                                                       |
| `Project WAV media entry needs a valid frame window.` / `Project WAV media entry needs a valid frame window and stereo pair.`                                                                                             | Use frames inside a live `AudioMedia` asset and a valid packed stereo pair.                                                                                   |
| `Workspace audio fallback tail must be from 0 to 60 seconds.` / `Workspace audio fallback missed the project start or end.`                                                                                               | Use a finite tail within range and retry; a missed start or end means the render did not cover the project.                                                   |
| `Workspace audio fallback could not start an offline render of … seconds: …`                                                                                                                                              | The browser refused the render's buffer (Chromium: about 3.1 hours at 48 kHz). Export a shorter project or tail.                                              |
| `Workspace audio fallback has unresolved devices: …` / `Workspace audio fallback lost audio frames during the project; retry the export.` / `Workspace audio fallback was cancelled.`                                     | Resolve and load every WebCLAP bundle and retry, or cancel with `AbortSignal`.                                                                                |
| `Project arrangement refers to an unknown track.`                                                                                                                                                                         | Repair the lane's `track` reference and project structure.                                                                                                    |
| `Project has unsupported automation target.` / `Project has unsupported automation interpolation.`                                                                                                                        | This slice reads track-volume points with `linear` or `hold` interpolation.                                                                                   |
| `Project beat needs a finite non-negative value.` / `Project time needs finite non-negative seconds.`                                                                                                                     | A tempo-map query (`bpmAtBeat`, `beatToSeconds`, `secondsToBeat`) received a negative or non-finite value.                                                    | Pass finite, non-negative beats or seconds. |

`openDawProject(...).warnings` are non-fatal fidelity notices. An invalid or missing Audiorective private entry causes a warning and a standard-XML fallback for affected audio and MIDI clips.
