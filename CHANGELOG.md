# Changelog

All notable, agent-relevant changes to the `@audiorective/*` packages.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
All packages are released together under one version (`bumpp -r --all`), so a
single version number covers the whole toolkit. Each entry names the package(s)
it affects so a reader can tell which dependency to upgrade.

This file exists so an agent (or human) hitting an "API not found / undefined /
type error" on a documented API can tell whether the installed package simply
predates that API. See the "Version mismatches" note in the skill.

## [Unreleased]

### Added

- **core:** `encodeWav(pcm, { bitDepth? })` returns a WAV `Blob` of any `PCMData` (16-bit default, 24-bit integer or 32-bit float; interleaved, any channel count), and `encodeWavBytes` the same file as a `Uint8Array`. Pure: exported from the root and `@audiorective/core/peaks`, and re-exported from the `@audiorective/daw` root.
- **daw:** Linked MIDI clips. `project.duplicateClip(clipId, time, { trackId?, linked: true })` makes a clip that shares the source's notes (the third argument still accepts a track ID); `project.linkedClips(clipId)` lists the other clips sharing them, `project.makeClipUnique(clipId)` (also the `makeClipUnique` edit) gives a clip its own copy, and `overview()` and `findClips()` clips carry `linkedTo` when linked. An edit through `clip.midi` changes every placement and is one Undo step inside `project.edit`. `splitClip`, a moved start edge and the `rippleDelete` and `copyRange` cuts that use them make their pieces unique; moving or trimming the end keeps the link. `.dawproject` saves write shared notes once and the other clips as `reference`, which opens back as a group (and opens other programs' reference clips).
- **daw:** Session scenes and clip slots are song content. `sessionFor(project)` (from `@audiorective/daw/project` and the root) returns the Project's `ProjectSession`: `scenes`, `addScene`, `renameScene`, `removeScene`, `duplicateScene`, `clipAt`, `setMidiClip`, `setAudioClip`, `moveClip`, `clearSlot` and `copyToArrangement`. A slot holds at most one clip that is not on the timeline; slot clips work with `setClipLoop`, `resizeClip`, `setClipName`, `setAudioClipEnvelope` and `clip.midi.edit` by id. Session edits are undoable inside `project.edit`, advance `project.cells.version` and are copied by `snapshot()`. `.dawproject` saves write `<Scenes>` (a `<Scene>` of `<ClipSlot track>` per filled slot) after `<Arrangement>`; files without it open with no scenes.
- **launcher:** `launcher.insertScene(index, spec?)` and `launcher.removeScene(index)` grow and shrink the scene slots of a running launcher without stopping later scenes' clips.
- **widgets:** A `mountClipGrid` layout scene may carry `index`; its button then calls `launchScene(index)`, so the launcher's `emptySlots` applies.
- **daw:** `project.overview().session` lists scenes and their slot clips. File-backed audio slot clips (after `openWorkspaceBlob`) launch once their audio is read into memory. `openDawProject` accepts a clip with only `playStart` or only `playStop`.
- **launcher:** `LauncherOptions.emptySlots: "keep" | "stop"` (default `"keep"`) chooses what `launchScene(index)` and each `playChain` entry do to a track whose slot in that scene is empty; `"stop"` stops it on the scene's boundary. `workspace.session` uses `"stop"`.
- **daw:** `Project.setClipLoop(clipId, loop)` and `clip.loop` repeat part of a clip until it ends: a `BeatRange` on a MIDI clip, a `SecondsRange` of the recording on an audio clip, `null` to remove. Looped clips play in the Arrangement, the Session and offline renders; `resizeClip` can extend them past their content; `.dawproject` saves keep the loop as `loopStart`/`loopEnd`.
- **daw:** `Project.rippleDelete(range, { crossfade })` (`crossfade: true` for a 5 ms crossfade, or seconds) and the `rippleDelete` edit remove a beat or seconds range (`TimeRange`, `SecondsRange`) from the whole song: clips are trimmed, split, removed or moved earlier, and markers, tempo changes and volume automation follow, with an optional audio crossfade. `renderMixRange` accepts a `SecondsRange`.
- **daw:** Audio clips are windows over their whole recording. `AudioClip.sourceOffset` and `sourceLength` (also on `clip.stretch.source`) give the seconds into the recording where the clip begins and the recording's length. `Project.resizeClip(clipId, { start?, end? })` moves edges to absolute timeline positions, can reveal trimmed audio again inside the recording, and extends MIDI clips into empty space. `.dawproject` saves write each recording once, whole, with `playStart`/`playStop` on its clips, and reopened pieces share the recording.
- **daw:** Extensions: `defineExtension` and `project.extension(definition)` keep app data in the song (saved as `extensions/<id>/data.json`, undoable, versioned); `defineOperation` and `project.operations` register named operations an app or AI assistant can list and call as one Undo step.
- **launcher:** `playChain(scenes)` plays scenes back to back for their lengths and then stops; `launcher.chain` reports the position.
- **daw:** `workspace.arrangement` (and `WorkspaceOptions.arrangement`) turns timeline playback off for Session-only apps, also while playing.
- **daw:** `WorkspaceOptions.instruments` plays a page-made `Sampler` sound on a MIDI track without a plug-in, in Arrangement, Session and offline renders.
- **daw:** `workspace.session` launches MIDI clips through the track's first device, with note release on clip changes and Arrangement MIDI held back while Session owns the track.
- **daw:** `workspace.loop` repeats a beat region on the audio clock with sample-accurate wraps, clip cuts, tempo and automation repeats, and MIDI note release.
- **widgets:** The piano roll adds `onNoteAdd`, `onNoteDelete` and `velocityLane`; `onNoteEdit` also reports `kind: "velocity"`.
- **daw:** `@audiorective/daw/selection` adds `selectionFor(project)`, one shared `ProjectSelection` per Project for views and agents, outside the file, undo and version. `setTempoChanges` accepts an entry at beat 0 to set the starting tempo.
- **daw:** Clip names (`clipName`, `setClipName`, `renameClip`, `findClips({ name })`) round-trip through the standard DAWproject attribute, and files with named clips now open. `renderMixRange` renders and measures a beat range of the full mix, `workspace.editStatus(version)` reports playback state, and `saveWorkspace` / `saveWorkspaceTo` accept `expectedVersion`.
- **daw:** `Project.applyEdits`, `edit`, `undo`, `redo`, `clearHistory`, `overview`, `findMarker`, `findClips`, `cells.version` and `cells.history`: atomic, versioned, JSON-serializable project edits with one shared undo history.

### Fixed

- **daw:** Opening a `.dawproject` with files this codec does not use keeps them and writes them back unchanged on save, instead of failing with `Project archive has unsupported files.`
- **launcher:** A launch waiting for `clock.start()` with no time now begins exactly on beat 0 instead of at the next timer tick.
- **launcher:** A scheduler clip stopped in the same look-ahead as a clock refresh (another track's launch, an edit, a tempo change) still cuts its held notes at the stop instead of letting them ring.
- **daw:** `workspace.deviceOptions` approves the bundle URLs the workspace has loaded, so a file saved from it opens again with its plug-ins; other URLs still need `resolveBundle`.
- **daw:** Live plug-in state capture is no longer on the public `Project` type; apps without a Workspace use `project.setDeviceState`.
- **widgets:** A widget mounted inside an effect keeps updating after that effect re-runs. A Delete handled by the piano roll no longer reaches the app's own key handlers.
- **daw:** `selectionFor` keeps pruning when first called inside an effect.
- **host:** A saved patch now loads on a context that is not rendering yet, so offline renders and exports work after a synth edit, and `params` reflect the loaded patch after the state settles.
- **host:** `saveState` hands parameter changes still queued for the audio thread to the plug-in first, so a value set right before a save is in the saved state.
- **daw:** Both project open paths validate ZIP completeness and entry CRCs. Unsupported master settings fail on open. Audio sidecar details follow clip identity, edited MIDI falls back to standard content with a warning, recorded MIDI channel messages round-trip, XML text is validated on entry, and generated IDs survive save and reopen without reusing deleted IDs. Disposed projects reject edits and saves.
- **daw:** Media read failures report once per clip per playback run in `workspace.cells.error`, retry at the next `play()` or `seek()`, clear on a successful read and abort audio fallback export. A `seek()` while playing keeps the transport `playing` while it waits for file-backed media, and `takeAnchor(audioTime)` maps that audio time to project time, so a take placed from an anchor taken right after `play()` is exact; an anchor captured while a seek waits for media throws at `takePosition`.
- **daw:** Live playback schedules starts in advance, waits for file-backed media at seek boundaries and buffers the next chunk ahead of its start. Unrelated arrangement edits preserve held MIDI notes. Source cancellation and live master changes use short gain fades.
- **recorder:** A transport `start` cancels a pending `quantize` take (its boundary was planned on the previous anchor) with `AbortError`; a take armed with an explicit `when` still survives `start`.
- **daw:** A seek that waits for media gives attached schedulers a real seek before holding the transport `playing`, so an armed recorder take is cancelled as on any seek.
- **effects:** Channel mute and output gating transition smoothly during playback.

### Migration

- **daw:** **Breaking.** `Project.trimClip` is removed; `resizeClip` takes absolute timeline edges instead of clip-local ones. Migration:

  | Before                                            | After                                                                                  |
  | ------------------------------------------------- | -------------------------------------------------------------------------------------- |
  | `project.trimClip(id, localStart, localEnd)`      | `project.resizeClip(id, { start: clip.time + localStart, end: clip.time + localEnd })` |
  | `project.trimClip(id, localStart, clip.duration)` | `project.resizeClip(id, { start: clip.time + localStart })`                            |

- **daw / daw-demo:** A project file's WebCLAP URL requires app approval. Supply `resolveBundle` when opening a project. The demo approves its built-in synth and bundles that the user explicitly loads in the current session.

- **daw:** **Breaking.** `workspace.session` no longer makes slot `i` of a track out of the track's `i`-th Arrangement clip; its slots are the Project's Session grid, `sessionFor(project)`. `session.value.tracks[trackId].clips[i]` is scene `i`'s slot clip (`null` when empty), `launchScene(i)` launches scene `i` and stops the tracks whose slot is empty, and `workspace.sessionClip(trackId, clipId)` finds a slot clip by its id (a timeline clip has none). Scenes added or removed change the launcher in place. Migration:

  | Before                                                                               | After                                                                                                                            |
  | ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
  | `project.addMidiClip(track.id, data, time)` placed far away to give a Session slot   | `sessionFor(project).setMidiClip({ trackId: track.id, sceneId }, data)`                                                          |
  | `project.addAudioClip(track.id, audio, time)` placed far away to give a Session slot | `sessionFor(project).setAudioClip({ trackId: track.id, sceneId }, audio)`                                                        |
  | scene `i` = the `i`-th clip of every track                                           | `sessionFor(project).addScene({ name })`, once per scene, in order                                                               |
  | a clip on both the timeline and in the Session                                       | a slot clip and an Arrangement clip with the same content; `session.copyToArrangement(slot, { atBeat })` makes the timeline copy |
  | grid layout built from `track.clips` grouped by time                                 | `sessionFor(project).scenes` and `clipAt({ trackId, sceneId })`                                                                  |
  | a scene launch left tracks with nothing in that scene playing                        | `launchScene(i)` stops them; `launchScene([clipA, clipB])` still starts exactly those clips                                      |

### Documentation and evaluation

- **docs / skill:** clarify Clock transport states, empty processor registries, nullable launcher slots, file-backed clip media windows and fixed-tempo punch occurrence planning. These are existing APIs; runtime and persisted project formats are unchanged.
- **evals:** accept public widget delegation, current MIDI held cells and signal cleanup; separate actual reference-read evidence from answer prose and keep source preparation distinct from hand-written recording engines. Routing failures remain in per-run means and summary denominators as unmet; incomplete calls are reported separately. Historical frozen grades are retained. Required reference reads are enforced per solver run before grading; a missing route fails the run even when its API happens to be correct.

### Changed

- **widgets:** The piano roll velocity lane is easier to use: wider stems with round handles (fully visible at beat 0), the active note's bar on top and highlighted in a chord, a 1-127 value label while dragging, and ArrowUp/ArrowDown (Shift for 10) to nudge the active note through `onNoteEdit` `kind: "velocity"`.
- **daw:** `exportAudioFallbackTo` renders offline on an `OfflineAudioContext` instead of capturing a live context in real time, so the result no longer depends on real-time rendering or the tab staying active. Signature, ZIP layout, manifest, stems, cancellation, progress and errors are unchanged; the render waits between steps for file-backed media chunks, WebCLAP device messages and the OPFS writer, and the same project exports the same samples. Export duration is no longer tied to the project's length. The offline context holds one channel for the whole render in memory (about 11 MB per minute at 48 kHz); Chromium refuses a render above about 3.1 hours, which fails with the export's own error.
- **recorder:** a worklet `currentFrame` that repeats for one render quantum and then catches up no longer discards 128 captured frames or reports a false `dropouts` gap. A real forward skip is still reported and filled with silence.

### Added

- **clock:** `play()` starts a stopped transport, resumes a paused one, and leaves an already playing transport and its queued events in place. `start(when, offset)` retains its explicit position-jump behavior.

- **widgets:** selector `controls` and `audition` flags work independently (both default `true`), with `getViewport`, zoom/amplitude-zoom and scroll methods for shared-player views. `StepGridPluginContext.onCell` supplies each live step's tracked owner, geometry slot and scoped cleanup; step indices are zero-based.
- **widgets:** direct dBFS peak callbacks or PCM `LevelMeterSource`, explicit `LevelMeterHandle`/`LevelSnapshot` types, public `MixerStripSettings`/`MixerMeter`, and player-owned `WaveStretchAnchor` plus `ClipEnvelope` exports. Scalar peak sources report unknown RMS as `null`; PCM sources retain measured peak/RMS.
- **docs / skill:** basic Widgets and Widgets: advanced pages route common mounts separately from renderers, plugins, time mappings and arrangement gestures, while retaining historical anchors and widget-area error rows. Public widget declarations state local-preview, cancellation, keyboard and live-preset guarantees.

- **core/automation:** `AutomationClip(curve, { target, loop?, length?, signal? })` follows `clock.attach(clip)`: curve times are beats, with tempo ramps, seeks, live edits and loop seams handled by the owner. `cells.attached` is read-only; detach and dispose cancel queued changes while holding current audio. `AutomationBinding` remains the finite owner for fixed caller-chosen units.

- **effects:** `Ducker`, a sidechain ducker: `new Ducker(context, { depth, attack, release, threshold })` lowers its audio by `depth` dB (default 8) while the signal connected to `ducker.sidechain` is above `threshold`; `cells.reduction` is the live reduction in dB. `attack` and `release` are the seconds a full-depth change takes.
- **effects:** public `AnyEffect` type for heterogeneous effect lists and editable-chain UI code; it describes the same effect instances that `EffectChain` accepts.
- **effects:** `EffectChain`, an ordered chain of any effect instances: `new EffectChain(context, effects?, { signal })`, `add(effect, index?)`, `remove(effect)`, `move(effect, index)`, `cells.effects`. Every edit is a short crossfade that never clicks, drops out or opens a feedback loop, and the other effects keep their state. `toJSON()` saves plain data. `EffectChain.fromJSON(context, json, { types })` constructs a separate chain and returns `{ chain, issues }`, recovering valid entries. `await chain.restore(json, { types, signal? })` transactionally loads a playing chain behind stable I/O: strict validation and readiness failures leave it unchanged; success publishes once and queues the built-in crossfades. Newer loads, a job signal or disposal cancel pending preparation with `AbortError`.
- **effects:** every effect has `params.bypass: Param<boolean>` (option `bypass`), a click-free fade that keeps the effect's settings, and `cells.status` (`"loading" | "ready" | "error"`), `cells.error` and `ready`. While loading or after failure, the wet arm is muted and the dry share stays at `1 − wet`; a fully wet return stays silent instead of leaking dry audio. Bypass still passes full dry.
- **core:** `SchedulableParam.smoothing` (and the `smoothing` option on `SchedulableParam`, `param` and `schedulableParam`): seconds a `.value` write takes to settle with `setTargetAtTime`; the default `0` keeps the native jump. Scheduled ramps and the initial value are never smoothed.
- **effects:** audible effect params (`wet`, filter `frequency`/`Q`/`gain`, delay `delayTime`/`feedback`, phaser and shifter frequency, compressor `makeup`, `Channel` `gain`/`pan`, send `gain`) ramp over 10 ms on `.value` writes, and a `Distortion` drive change crossfades two shapers.
- **effects:** `Channel` `cells.level`, the post-fader peak in dBFS (`-Infinity` when silent), refreshed every animation frame.
- **effects:** `TimeStretch` option `loop: true` renders one loop cycle that wraps without a seam, and `TimeStretch.load({ wasmUrl })` caches the compiled module per URL.
- **launcher:** `clip.launch({ at: beat })` starts a buffer clip as if it had started at that transport beat: a beat ahead starts there, a past one starts now at the elapsed phase (wrapped by the loop), so a take that resolved late loops in phase. `clip.buffer` (a `ReadonlyCell`) reads a buffer clip's audio and `clip.configure({ buffer })` replaces it, swapping a playing clip gaplessly at the same position. `removeEventListener` is typed with `ClipEvent` like `addEventListener`.
- **recorder:** `overdub(loop, take, { loopStartBeat, bpm | timeline, atBeat?, gain? })` sums a take into a loop at its beat position (wrapping across the loop end) and `punch(loop, take, { loopStartBeat, fromBeat, toBeat, bpm | timeline, fadeSeconds? })` replaces a region with crossfaded edges; both return a new `AudioBuffer` for `clip.configure({ buffer })`.
- **clock:** `clock.beat`, a plain getter for the current beat. `renderTimeline({ actions: [{ at, run }] })` runs closures at audio times and waits for any promise they return (a take delivered by a worklet) before the next tick; `RenderAction` is exported.
- **core:** `Analyser.createFloatWaveformBuffer()` and `readFloatWaveform(out)` read the time-domain waveform as floats.
- **skill:** capability rows for a loop station, overdub and punch, resampling and launcher `scheduler` clips; the restored "What to read next", "Rules that always apply" and "Common errors" sections after a merge dropped them, with one "Message starts with" routing table.
- **core / pads:** `Sampler.params.release` and `PadBank.params.release` (`Param<number>`, seconds, default 0.005, set by the `release` option) are read when a voice is released, so a release knob needs no rebuild. `PlaySoundOptions.release` also accepts a function. `Voice` gains `started` (false while scheduled ahead, true once its `when` has passed).
- **core:** `Sampler.params.sustain` (`Param<boolean>`, default `false`) is a sustain pedal (MIDI CC64): while true, `noteOff` keeps the held voices sounding, and setting it to `false` releases them at the current time.
- **core / pads:** `Sampler.cells.heldNotes` (notes with a sounding voice, ascending) and `PadBank.cells.playing` (pad ids with a sounding voice, in pad order) replace page-side counters.

- **midi:** `MidiClip` option `transform(note, random)` and `seed`, the same shape as `StepSequencer`'s `transform` (`NoteHit`, `NoteTransform`); `random` is stable per seed, note id and key, so every loop pass is identical.
- **midi/web:** `MidiKeyboard.press(note, { velocity, when, channel })`, `release(note, when)` and `setSustain(down, when)` for on-screen keys on the hardware path; `MidiKeyboard.open(context, { access })` takes a `MIDIAccess` or `null` (on-screen only, no permission prompt); `MidiKeyboard` is a `MidiSource` and `MidiRecorder` records any `MidiSource` (`new MidiRecorder(context, keyboard)`).
- **core:** `resolveHitEdit`, `Random` and `HitTiming`, the per-event transform merge shared by `StepSequencer` and `MidiClip`.

### Changed

- **core / clock:** explicitly empty `AudioProcessor` registries may be omitted from the build result; omitted or `undefined` registries become frozen empty objects. Nonempty registries remain required. Concrete beat rulers accept a scheduler window and beat timing directly; concrete time rulers still require position, and custom `Ruler` implementations retain the full tick window contract.
- **recorder:** every `stop()` failure rejects its Promise. Stop compares the clamped audio time `max(when ?? now, now)` with the first capture frame. A later closing frame keeps captured audio even when the begin notification is queued and state still reads armed. With no captured interval, an omitted/past/present request cancels with `AbortError` without setting `cells.error`; only a future invalid interval rejects that Stop and preserves the take, including one before the quantized boundary requested at `record()`; a Stop after that boundary cancels if late preparation moves the start past it. Leaving the transport cancels a take only while its first frame is still ahead on the audio clock, so captured audio survives a queued begin notification and keeps its `startBeat` on the pre-move timeline, including tempo ramps. Invalid selectors also preserve the take; repeated streaming Stops retain the same completion Promise while draining writes.

- **docs / skill:** recorder punch examples use the planned absolute transport range for the take’s current loop occurrence. Long-take examples guard optional dropout metadata and pass the complete `{ min, max, duration }` media peak summary to waveform views. Runtime contracts and persisted data are unchanged.

- **pads / recorder:** repeated pending `Voice.stop(when)` calls on a PadBank replace the earlier Stop like core Voice; an already committed release or choke stays committed. Buffered recorder `startBeat` follows the actual first captured frame, including late quantized capture and sample rounding, so track placement does not snap late audio to its requested bar line.

- **clock:** a refresh before the first dispatched start/seek window retains the requested beat, including when real audio time advances before the refill. In-progress callbacks and later edits keep current-boundary refills without replaying earlier cues.

- **recorder / daw:** long captures use `record({ onChunk, ...timing })`, resolving a PCM-free span at natural completion or early Stop. Writers run serially with the bounded queue; failure/cancel stops capture, skips queued callbacks and drains the active callback before rejection. Buffered capture and valid timed Stop during graph preparation retain their behavior. DAW consumers observe writer failure without waiting for Stop; audio fallback waits for the recorder’s actual native capture-begin signal before playback, without the startup sleep.

  | Before                                             | After                                                              |
  | -------------------------------------------------- | ------------------------------------------------------------------ |
  | `await recorder.startStream(writeChunk, { when })` | `const recording = recorder.record({ onChunk: writeChunk, when })` |
  | `recorder.stopStream({ when })`                    | `recorder.stop({ result: "span", when })`                          |
  | Stream completion available only from Stop         | Observe `recording` immediately; `length` can finish without Stop  |

  The superseded methods have no aliases. `record()`/`stop()` without streaming options retain PCM results; dynamic writer/selector options return a truthful PCM-or-span union. The Stop selector must match the active mode (`InvalidStateError`).

- **effects / sequencer / widgets:** Boolean silence controls use `muted`, matching mixer and Project state. The Channel Param registry and lane setters retain their existing shapes; the former spelling has no alias. DAW runtime, grid plugins and demos use the same name. The sequencer lane-validation message names `muted` accordingly.

  | Before                                 | After                                   |
  | -------------------------------------- | --------------------------------------- |
  | `new Channel(context, { mute: true })` | `new Channel(context, { muted: true })` |
  | `channel.params.mute.value`            | `channel.params.muted.value`            |
  | `LaneOptions.mute`, `lane.mute`        | `LaneOptions.muted`, `lane.muted`       |
  | `StepGridLane.mute`                    | `StepGridLane.muted`                    |

- **sequencer / pads / clock / host:** argument-shape failures use `TypeError`, invalid values and ranges use `RangeError`, and disposed or duplicate attachment/editor operations use `DOMException` with `InvalidStateError`. WebCLAP response timeouts and state-confirmation exhaustion use `TimeoutError`. Messages are unchanged. External resource/plug-in failures and internal invariants remain ordinary `Error`; launcher validation already uses range/type errors and is unchanged.

- **widgets / docs:** `StepGridOptions.sequencer` documents that lane rows update live while the custom parameter tab set is fixed at mount.

- **widgets:** automation lanes intercept Escape only during an active drag; an idle numeric field restores its owner value without blocking native dialog dismissal. Document-level listeners exist only during the drag.

- **widgets / daw-demo:** arrangement and waveform-selection Escape listeners attach only during active drags. The studio looks up current clip origins through one index per Project revision.

- **widgets:** automation lanes retain validation at mount, then cancel previews and disable input when live duration becomes non-positive or non-finite. Valid durations restore the same controls and latest owner points without throwing from the owner edit.

- **widgets:** level-meter dBFS callbacks are sampled every animation frame without requiring tracked state. `NaN` and `-Infinity` display silence; `+Infinity` displays full scale with overload. Disposal stops sampling for standalone and mixer-strip meters.

- **clock:** `refresh()` and an attached scheduler's `handle.refresh()` return `Promise<void>`. Await the coalesced refill, including synchronous callback edits, before dependent offline work. Transport changes settle cancelled work; inactive/detached owners complete without scheduling.

  | Before                                          | After                    |
  | ----------------------------------------------- | ------------------------ |
  | Caller microtask fence after `clock.refresh()`  | `await clock.refresh()`  |
  | Caller microtask fence after `handle.refresh()` | `await handle.refresh()` |

- **docs / skill:** Clock starts with a Vanilla pattern, lifecycle, units and refill completion; Clock: advanced carries custom rulers, event ownership, offline rendering and deterministic test recipes.

- **clock:** grid-point absolute audio timestamps use `when`, consistently with Web Audio scheduling. All current callers migrate together; no `time` alias remains. Curve coordinates and project-file positions retain `time`.

  | Before                          | After                           |
  | ------------------------------- | ------------------------------- |
  | `point.time` / `{ time, step }` | `point.when` / `{ when, step }` |
  | `trigger({ when: point.time })` | `trigger({ when: point.when })` |

### Fixed

- **core:** `disconnect(processor.input)` removes connections established using the processor owner and vice versa. `FilePlayer` preserves its initial or edited playback rate across media loads and source changes.
- **pads:** rebuilding a choke group preserves an already committed release envelope and its original retirement time, avoiding a gain jump or extended tail.

- **core / pads:** an observer error remains reported while context-wide parameter readback continues; owner effects, graph watchers and AutomationBinding survive consumer-effect reruns until explicitly disposed. Aborted engine setup releases subsequently registered processors and helper graphs. Pad commands do not track voice start state; FilePlayer source/Stop/dispose publish coherent inactive state.
- **effects:** Channel meter disposal is repeatable; effect readiness/error/buffer transitions are batched. Chain handovers wait for audio time across suspension. Rapid Distortion edits coalesce into a bounded pool of prebuilt silent arms with native gain handovers; they do not rewrite an audible curve or reserve caller-owned offline suspend points.
- **recorder / midi / host:** scheduling Stop cannot exempt an unstarted audio take from transport cancellation; MIDI start/end timers recheck audio time across suspension and record commands do not track tempo. Cancelling a future WebCLAP note-off retains its channels, while executed releases leave later note-on ownership intact.

- **clock:** detach retracts the registration's sounding and future owned events at the current audio time, preserving other schedulers; a retained detached window cannot register new events.
- **clock:** a slider write after `cancelAndHoldAtTime(now)` preserves an incoming tempo ramp's historical integral, including repeated writes at the same instant, so transport beat does not jump.
- **clock:** refresh invalidates event ownership without re-anchoring the transport, preventing accumulated rounding from showing the previous bar at a count-in boundary.
- **clock types:** `cycleGridPoints` accepts the minimal core `BeatTiming`, just as `gridPoints` does; custom schedulers can pass their supplied timing without a Timeline adapter.

- **clock docs:** seconds-based rulers report transport position: start/seek seeds from the chosen beat and BPM, playback advances real seconds, and pauses hold it. Type hints distinguish this from cumulative listening duration across seeks; runtime position behavior is unchanged.

- **clock:** a `refresh()` called from an owned event’s cancellation coalesces with the outer edit, preserving its first captured audio boundary even if the audio clock advances inside the callback.

- **core:** `withCancel(event, undo).cancel(time?)` forwards the optional audio-context cancellation boundary to the wrapped event instead of cancelling it immediately. Cancellation and undo still run at most once; documentation and clock-owned voice examples preserve the same boundary.

- **docs / skill:** the prepared audio-stretch example executes `apply()` through the app's synchronous undo history, matching the ownership guidance; warp-editor guidance routes to that example.

- **widgets:** waveform selection previews stay local until release, when the shared model receives one edit. Escape, pointer cancellation, capture loss, external owner replacement and detachment restore the committed range without writing a preview to the model.
- **widgets:** curve, overlay, warp and arrangement gestures cancel on Escape, pointer cancellation, capture loss, stale owner replacement and disposal. Rejected or throwing edit commands restore the authoritative source view. Disabled curve/warp tools yield hit testing, and a background double click is claimed once across tools.
- **widgets:** mixer keyed rows preserve focused extension controls and text selection during reorder, optional controls follow owner capability changes, and meter/extension resources clean up once without disposing borrowed owners. Detached editor observers stop updating after view removal.

- **core:** live latency-compensation changes warm a new delay route and crossfade instead of hard-rewiring or moving an audible delay read head. Initial wiring remains exact; steady branches align sample-for-sample after the short phase blend. `arrivalOf()` and snapshots describe the solved target during the handover. Graph disposal disconnects pending helper routes and cancels their cleanup timers.

- **effects:** `Ducker.cells.reduction` reports actual output attenuation after wet/dry and click-free bypass, instead of the wet arm's detector envelope. The worklet reports every 512 audio frames; a meter reads or subscribes directly, without masking bypass to zero. Loading and failure report the remaining dry gain (`-Infinity` for silence, `0` for full bypass), with polling and reports cleaned up on disposal.

- **recorder:** a source or automation wired only to `recorder.input` is processed from the start, armed or not (a silent pull path to the destination), so a take holds what played at that audio time. Before, it was pulled only once a take armed: in an offline render the oscillator phase or ramp started late and the take came back time-shifted with no error.
- **core:** `Sampler.noteOff` releases only the held voices of the note that start by `when`. A later `noteOff` no longer moves the stop of a voice an earlier `noteOff` released, and a `noteOff` does not release a voice scheduled after it.
- **core / pads:** `Sampler.cells.activeVoices` and `PadBank.cells.activeVoices` count only started voices: a voice scheduled for the future joins at its start time, where before it counted at scheduling, one look-ahead early. `voice.playing` is unchanged (true until the voice ends); read `voice.started` for whether it has begun.
- **recorder:** a take with `length` is exactly that many frames. The capture worklet now counts the length from its first captured frame and never opens before the planned start frame, so a boundary already in the past or a late-opening gate no longer yields extra frames (a 0.25 s take could be 12512 frames). A render quantum the browser repeats is skipped, so chunks stay contiguous instead of failing with `AudioRecorder lost captured frames.`
- **player:** a queued quantized `WavePlayer` start stays cancellable by the clock leaving the transport after a `seek()`.
- **recorder / player:** while attached to a Clock, stop, pause, seek or detach cancels any take (`AudioRecorder.record`) or start (`WavePlayer.play`) that is armed but not yet started, `when` as well as `quantize`. `record()` rejects with `AbortError` and `play()` resolves `null`; a running take or sounding playback continues. Before, only quantized ones were cancelled, so a `when` start recorded or played material that no longer belonged to its position.
- **core:** `Sampler.noteOff(note, when)` moves a voice's pending release earlier when `when` is earlier; a later `when` is still ignored. A `noteOff` at a voice's own start silences a voice that has not started.
- **midi:** a `MidiClip` in a `ClipLauncher` loops per the launcher clip's `loop` and `length` alone (the `MidiClip`'s own `loop` and `length` apply when attached to a clock directly), and sends each note-off in the window that contains it, so a cut sends no stray late note-off.
- **midi:** a `refresh()` (or any retract) that lands after a note's on time but before the next window no longer revokes the started note or sends a stray note-off: a `MidiClip` decides "started" from the audio clock now (a `ClipLauncher`'s handle gains `now()`). `MidiKeyboard.press` on a pitch the sustain pedal alone is holding releases the old note at the re-strike, so the pitch keeps one voice.
- **midi:** when a retract revokes a not-yet-started note and the instrument's `noteOn` returned a cancellable event, `MidiClip` cancels it and sends no note-off; an instrument without one (a `Sampler`) still gets the note-off at the note's start time.
- **clock:** `gridPoints` takes a `BeatTiming`, so a scheduler can pass the `timing` its `schedule(window, timing)` receives.

- **blocks:** `StepSequencer` `transform` is beat-aware. `Hit` (what `transform` receives and returns, and what `onHit`, the `hit` event and a sound get) gains `beat` (absolute beat after offset, swing and repeat) and `durationBeats`. After `transform`, a changed `beat` or `durationBeats` is mapped through the transport's timing, so the hit stays on the grid under tempo automation (`beat: hit.beat + 0.125` is always a 32nd late); a hit that changes neither keeps the returned `when` and `duration`, as before, for millisecond nudges. If both `beat` and `when` changed, the hit sounds at `beatToTime(beat)` plus the `when` delta, and `duration` gets its delta added to the beat-derived length. A non-finite `beat` or a `durationBeats` not above 0 throws `Event transform "transform" ...`. A transform that shifts only `when` by a fixed amount is not tempo-locked.
- **widgets:** the step grid plugin context's lanes include the writable `pattern`, `rate`, `swing`, `direction`, `mute`, `solo` and `length` members of the real `Lane`.
- **docs:** swing is described once everywhere (every odd step delayed by `swing` of half a step, a fixed beat offset), and the sequencer docs say to `clock.refresh()` after changing state a `transform` reads.

- **blocks:** `StepSequencer` randomness is a pure function of a step's position. Before, `chance` and `context.random` drew from one stateful source, so any re-queue (an edit through `refreshOnEdit`, `clock.refresh()`, a seek) redrew every pending step: a chance step could flip between sounding and silent and humanize jitter jumped, and offline renders with different tick sizes differed. Now the chance draw is keyed by `seed`, lane, loop and step counter, and `context.randomFor` by the hit's lane, loop, step counter and repeat index, so the same step gets the same numbers in every window. Pass `options.random` to keep the old sequential source (the old instability comes with it).

### Changed

- **widgets (breaking):** meter PCM options move from `{ read, sampleCount }` to `{ source: { read, sampleCount } }`; mixer meter factories return `{ source, dispose? }`. Existing dBFS owners use `source: () => channel.cells.level.value`. Mute/solo settings and master are optional; master appears only with `masterVolume` and `editMaster`.
- **widgets (breaking):** lane `points` changes from a captured array plus `handle.setPoints()` to a tracked readonly `.value` source. Lane and clip-envelope `duration` changes from a number to a tracked callback. Lane `timeUnit` defaults to `"seconds"` and accepts `"beats"` for labels and picker coordinates; projections remain caller-owned. Overlay point sources accept the same `.value` contract, including a direct `AutomationCurve`, with an optional borrowed `disabled` gate.
- **widgets (breaking):** arrangement clip options replace captured `time`/`trackId` with fixed `clipId` and live `origin()`. Each keyboard nudge reads the latest owner position; external origin changes cancel stale drags. Timeline `getScale()` tracks owner changes and synchronizes the borrowed native slider in place.

- **effects (breaking):** the static preset constructor is `EffectChain.fromJSON(context, json, options)`, with `EffectChainFromJSONOptions`. The static `EffectChain.restore` name is removed; `chain.restore(json, options)` is the asynchronous in-place load, with a job-only cancellation signal.

- **effects:** `EffectChain.restore()` initializes newly created effects at their saved values immediately even on a running context, while retaining normal smoothing for subsequent writes.

- **effects docs:** mixer routes using `Channel.send()` use processor `connect()` throughout, so upstream inserts, sends and returns share one latency solve; separate `defineGraph` solves do not share arrival times.

- **effects:** built-in effects allow subclasses to choose their own `static type` for `EffectChain` serialization.

- **effects:** `EffectChain.restore()` reports parameter-bind validation failures as issues instead of throwing; non-loop `TimeStretch.process()` keeps the first sample and exact requested frame count instead of trimming a one-frame loop margin.
- **effects:** parameter JSDoc states the automatic 10 ms smoothing on wet, channel gain/pan, send gain, filter frequency/Q/gain, delay time/feedback, phaser frequency/Q, frequency shift, EQ bands and compressor makeup. Slider handlers can write `.value` directly.

- **effects / player / daw:** **Breaking.** The effects API is one form per job. Migrate in one pass.

  | Old                                                                                                | New                                                                                                                                                   |
  | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `new EffectRack(context, slots, macros)` from `@audiorective/effects/rack`                         | `new EffectChain(context, [new Filter(context), ...])` for any effects; the DAW's data-driven rack is internal to `@audiorective/daw`                 |
  | `@audiorective/effects/rack-preset` (`RackEffect`, `RackPreset`, `rackMacroRange`, ...)            | the same names from `@audiorective/daw` / `@audiorective/daw/project`; Equalizer band validation is `@audiorective/effects/equalizer-bands`           |
  | `effect.cells.isReady` on `Convolver`, `PitchShift`, `Compressor`, `Limiter`                       | `effect.cells.status.value === "ready"`; a failed load is `status === "error"` with `cells.error`                                                     |
  | `effect.ready` as an ad-hoc field on four classes                                                  | `effect.ready` on every `Effect`: resolves when the status is `"ready"`, rejects with the cause on failure                                            |
  | `params.wet.value = 0` to bypass                                                                   | `params.bypass.value = true` (click-free, keeps `wet`)                                                                                                |
  | `new TimeStretch(compiledModule)`                                                                  | `await TimeStretch.load({ wasmUrl })`                                                                                                                 |
  | `stretch.process({ channels, sampleRate }, { ratio })` resolving `{ channels, outputFrames, ... }` | `stretch.process(audioBuffer, { ratio, loop?, signal? })` resolving an `AudioBuffer`; `ratio` is still output length / input length                   |
  | `WaveStretchProcessor.process(PCMData, ...) => Promise<PCMData>`                                   | `process(AudioBuffer, ...) => Promise<AudioBuffer>`; `TimeStretch` satisfies it                                                                       |
  | `TimeStretch.dispose()` rejecting running jobs with a plain `Error`                                | every cancellation (signal or `dispose()`) rejects with an `AbortError`                                                                               |
  | `channel.send(bus, name)` returning `{ gain, enabled, dispose }`; `bus.receive(name)` a `GainNode` | a `Send` processor: `send.params.gain`, `send.params.enabled`; `bus.receive(name)` a `SendReceive` processor (`connect`); both join the latency graph |

- **core / clock / launcher / midi:** `CancellableEvent.cancel(time?)` takes the audio time the retraction takes effect (`cancelFrom(time)`, or now for a transport change or `refresh()`); an event written as `cancel()` keeps working. A `ClipLauncher` cancels a scheduler clip's own events from its stop, replacement or end, so a launched `MidiClip` releases its sounding notes at that boundary where before they rang to their own note-off.
- **core / all packages:** **Breaking.** `destroy()` is renamed `dispose()` everywhere, and the engine lifecycle follows `AudioContext`. No aliases remain; migrate every call site in one pass.

  | Old                                                                                                                  | New                                                                                                                                  |
  | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
  | `x.destroy()` on every class and view in every package                                                               | `x.dispose()`; `AudioProcessor`, `AudioEngine`, `Param` and `SchedulableParam` also have `[Symbol.dispose]()`; safe to call twice    |
  | `override destroy()` in a processor subclass                                                                         | `override dispose()` (call `super.dispose()`)                                                                                        |
  | `engine.start()`                                                                                                     | `engine.resume()` (resolves at once when already running)                                                                            |
  | `engine.state()` (callable view), type `EngineStateView`                                                             | `engine.state.value` (a `ReadonlyCell<AudioContextState>`; also `.$()` and `.subscribe`)                                             |
  | `type EngineState = "idle" \| "running" \| "suspended" \| "destroyed"`                                               | `AudioContextState` (`"suspended" \| "running" \| "closed"`); `"idle"` is now `"suspended"` and `"destroyed"` is `"closed"`          |
  | `suspend()` / `resume()` after `destroy()` warned and did nothing; `start()` threw `Cannot start a destroyed engine` | `suspend()` / `resume()` reject with `new DOMException("AudioEngine is disposed.", "InvalidStateError")`                             |
  | `"destroyed"` states and `... is destroyed.` messages                                                                | `"disposed"` and `... is disposed.` (`MidiRecorder`, `AudioRecorder`, `WavePlayer`, `Clock`, `MidiSequence`, `PadBank` and the rest) |

  The engine state starts as the context's own state and follows every `statechange`, so a context the browser lets run without a gesture reads `"running"` without any call. Dispose a borrowed context's engine and `state` still reads `"closed"`; the engine does not close a context it did not create.

- **midi / host / clock:** **Breaking.** MIDI notes are beats with velocity 0..1 and play on a clock through `MidiClip`; recording and live play follow `AudioRecorder`'s and `MicrophoneInput`'s shapes. No aliases remain; migrate every call site in one pass.

  | Old                                                                                                                                                         | New                                                                                                                                                                                                                                                                                                     |
  | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `MidiSequence` (`load`, `setData`, `getState`, `subscribe`, `setSelection`, `updateNote`, `query`, `cells.state`), `MidiSequenceState`, `MidiSequenceCells` | `new MidiClip(notes?, { instrument, loop, length, signal })` with cells `notes` and `revision`, `setNotes(notes)`, `edit(draft => ...)` (one commit, one revision), `dispose()`; `clock.attach(clip)` plays it; selection is the app's, or `pianoRollModel(clip).selection`                             |
  | `MidiNote { id, start, end, pitch, velocity 0-127, channel, track }` in seconds                                                                             | `MidiNote { id, pitch, velocity 0..1, start, duration, channel }` in beats; new `NoteInit`, `DraftNote`, `Instrument { noteOn(note, { velocity, when, channel }), noteOff(note, when) }`                                                                                                                |
  | `parseMidi(bytes)` notes in source seconds with `endTick`, `tempos: { tick, usPerQuarter }`, `signatures: { tick, ... }`                                    | notes in beats (the file's tempo is not applied to playback), `duration` in beats, `ppq`, `tempos: { beat, bpm }`, `signatures: { beat, numerator, denominator }`; `midiGrid` and `visibleMidiNotes` take beats                                                                                         |
  | `tickToSeconds(tempos, ppq, tick)`, `isValidMidiNote`, `MidiTempo`, `MidiSignature`                                                                         | removed; ticks are already beats, and the transport owns tempo                                                                                                                                                                                                                                          |
  | `MidiRecorder.start({ when })` / `stop(): RecordedMidi`, `RecordedMidiEvent`                                                                                | `new MidiRecorder(context, input, { signal? })`, `clock.attach(recorder)`, `await recorder.record({ when?, quantize?, length?, signal? })` resolves `MidiTake`; `stop({ when? })` ends early and resolves; `cancel()` rejects `AbortError`; cells `state` (now with `"armed"`), `startsAt`, `startedAt` |
  | `RecordedMidi { startTime, endTime, duration (s), notes (s, 0-127), events: { audioTime, data, noteId }[] }`                                                | `MidiTake { notes (beats, 0..1), duration (beats), startBeat, startTime, endTime, events: { beat, data }[] }`; `new MidiClip(take.notes)`                                                                                                                                                               |
  | `compileMidiPlaybackEvents(take, sequence.getState())` returning `{ time, data, noteId }` in seconds                                                        | `compileMidiPlaybackEvents({ events: [{ beat, data, noteId? }] }, { notes, duration })` returning `{ beat, data, noteId? }`; needed only to replay recorded controllers beside edited notes                                                                                                             |
  | hand-written `midimessage` decoding for a live keyboard (`status & 0xf0`, `velocity / 127`, sustain CC 64, hot-plug)                                        | `await MidiKeyboard.open(context, { instrument, sustain?, signal? })` from `@audiorective/midi/web`; cells `inputs`, `held`, `sustain`; `dispose()`                                                                                                                                                     |
  | `WebClapHost.panic()`; notes sent as `scheduleMidi([0x90, note, 100], when)`                                                                                | `allNotesOff()`; `noteOn(note, { velocity 0..1, when, channel })` and `noteOff(note, when)` (the `Sampler` shape, so a host is an `Instrument`); `scheduleMidi` stays for other messages                                                                                                                |
  | `WebClapHost.parameterInfo[]` without a step                                                                                                                | each entry has `step` (1 when the plug-in marks the parameter stepped); `host.params[String(id)]` is its live `Param`                                                                                                                                                                                   |
  | importing `BeatTiming` from `@audiorective/core` for a custom scheduler                                                                                     | `@audiorective/clock` also exports the types `BeatTiming` and `CancellableEvent`                                                                                                                                                                                                                        |

  New errors: `MidiClip note ...`, `MidiClip notes need unique ids.`, `MidiClip length must be positive beats or a note value.`, `MidiClip is disposed.`, `MidiKeyboard needs an instrument.`, ``MidiRecorder record() takes `when` or `quantize`, not both.``, `MidiRecorder quantize needs clock.attach(recorder).`, `MidiRecorder quantize needs a playing clock.`, `WebCLAP note must be an integer 0-127.`, `WebCLAP velocity must be 0..1.`, `WebCLAP channel must be an integer 0-15.`.

- **widgets:** **Breaking.** The piano roll is always in beats and its model is `pianoRollModel(clip)`. No aliases remain.

  | Old                                                           | New                                                                                                      |
  | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------- |
  | `mountPianoRoll({ timeUnit: "seconds"                         | "beats" })`, default seconds                                                                             | removed; the piano roll is beats only |
  | `PianoRollViewport.timeUnit`, `PianoRollRenderFrame.timeUnit` | removed                                                                                                  |
  | a `MidiSequence` as the piano-roll model                      | `pianoRollModel(clip, { duration? })` returns a `PianoRollModel` with a `selection` cell and `dispose()` |
  | `onNoteEdit` note `{ start, end, pitch }`                     | `{ start, duration, pitch }`                                                                             |
  | minimum resize length 0.01 s                                  | 1/64 beat                                                                                                |
  | default renderer velocity opacity from 0-127                  | from 0..1                                                                                                |

- **daw:** **Breaking.** Project MIDI clips are `@audiorective/midi` clips in beats. No aliases remain.

  | Old                                                                       | New                                                                                                                                                                                                 |
  | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `clip.sequence`                                                           | `clip.midi`, a `@audiorective/midi` `MidiClip`                                                                                                                                                      |
  | `{ timeUnit }` option and `clip.timeUnit`; `clip.time` in the clip's unit | removed; project MIDI is always beats and `clip.time` is project beats                                                                                                                              |
  | note shape `{ start, end, velocity 0-127, track }`                        | `{ start, duration, velocity 0..1 }`                                                                                                                                                                |
  | `playbackEvents()[].time`                                                 | `.beat`                                                                                                                                                                                             |
  | `addMidiTake(trackId, RecordedMidi, seconds, opts)`                       | `addMidiTake(trackId, MidiTake, beats?)`                                                                                                                                                            |
  | `MidiClip.duration` as a tracked cell                                     | a plain beats number                                                                                                                                                                                |
  | `MidiData & { events? }`                                                  | `ProjectMidiData`                                                                                                                                                                                   |
  | `host.panic()` in the workspace                                           | `host.allNotesOff()`                                                                                                                                                                                |
  | DAWproject MIDI in seconds with `vel` 0-127                               | written in beats with `vel` 0..1; seconds MIDI lanes convert on read; `vel` above 1 is rejected with `Project XML has invalid vel on Note.`                                                         |
  | sidecar `audiorective/state.json` version 2                               | version 3; versions 1 and 2 keep audio details and rack macros, but their MIDI event details no longer attach and the file opens with the existing "no matching Audiorective event details" warning |
  | `Project MIDI time unit ...` error                                        | `Project MIDI duration must be finite non-negative beats.`                                                                                                                                          |

- **core / pads / sequencer / launcher:** **Breaking.** One `Sound` type (`NoteName | AudioBuffer | SoundFactory`) is played by every one-shot player, through one voice machinery (connect, start, hold, release fade, cleanup). A factory builds an unconnected, unstarted voice and never connects or starts anything; the player does, and applies `velocity` once after the factory's output. `Sampler` gains `noteOn`/`noteOff`; hits take one `PlayOptions { velocity?, when?, pitch?, offset?, duration? }` everywhere (`offset`/`duration` play a buffer region like `AudioBufferSourceNode.start`; for a factory or tone `duration` is `hit.duration`). No aliases remain.

  | Old                                                                                                                                                                  | New                                                                                                                                                                                            |
  | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `new Sampler(ctx, { buffer, loop, playbackRate, fadeIn, fadeOut, reverse, mute, polyphony })`, `params.buffer`, `.buffer =`                                          | `new Sampler(ctx, { sound, rootNote (60), lowNote (0), highNote (127), polyphony (32), steal, release (0.005), volume, signal })`, `sampler.sound =`; default polyphony is now 32 (was 1)      |
  | `sampler.trigger({ volume, rate, offset, duration, loop, when, fadeIn, fadeOut })`                                                                                   | `sampler.trigger({ velocity, when, pitch, offset, duration })` (`velocity` 0..1, `pitch` semitones, `offset`/`duration` seconds of buffer, a past `when` plays now; `rate` becomes `pitch`)    |
  | `reverse: true`, `params.reverse`, `params.mute`                                                                                                                     | `reverseBuffer(buffer)` as the `sound`; mute with `params.volume` or by not connecting                                                                                                         |
  | per-key `Map<number, Set<Voice>>` bookkeeping                                                                                                                        | `sampler.noteOn(note \| "C4", options)` / `sampler.noteOff(note, when?)` (same note again adds a voice; notes outside `lowNote`..`highNote` return `null`)                                     |
  | `Voice` class (`new Voice(...)`, `pause()`, `seek()`, `rate`, `volume`, `isPlaying`, `onEnded`), `TriggerOptions`, `VoiceOptions`                                    | `Voice { note, when, playing: ReadonlyCell<boolean>, stop(when?) }` (an interface); `SoundHit`, `SoundVoice`, `SoundFactory`, `Sound`, `PlayOptions`, `NoteName` types                         |
  | a factory `(ctx, hit) => AudioScheduledSourceNode` that connects, starts and stops its own nodes                                                                     | `(ctx, hit) => AudioScheduledSourceNode \| { output, sources, duration? }`, returned unconnected; a voice without `duration` is held for `hit.duration` then faded over `release`              |
  | `cells.activeVoices` on `Sampler`; `PadBank` `cells.activeEvents`                                                                                                    | `cells.activeVoices` on both                                                                                                                                                                   |
  | `PadBank.trigger(id, velocity, when, { pitch, duration })` returning `PadHit` (`cancel()`, `stop()`, `onEnded`)                                                      | `bank.trigger(id, { velocity, when, pitch })` returning a `Voice` (`stop(when?)`, `playing`); wrap it as a `CancellableEvent` (`{ cancel: () => voice.stop(), onEnded }`) for `window.own`     |
  | `PadSpec { id, buffer, group?, gate? }`, `assign(id, buffer)`                                                                                                        | `PadSpec { id, sound, group? }`, `assign(id, sound)`; a hit holds like any sound, so a gate pad is a long buffer or a held factory, ended by `stop`/choke                                      |
  | choke skipped the pad's own group members; `stopAll()`                                                                                                               | a hit cuts every sounding voice of its group, its own pad included, with the bank's `release` fade; `stopAll(when?)`; new `PadBankOptions { release, signal }`                                 |
  | `StepSequencer` lane `sound: "C6"` (built-in triangle tone), lane `Sound = NoteName \| AudioBuffer \| SoundFactory`                                                  | `sound` is the core `Sound` (note name tone, buffer or factory); `Sound`, `SoundFactory`, `SoundHit`, `NoteName` are re-exported from `@audiorective/sequencer`                                |
  | `ClipLauncher` `{ sound: ClipFactory }`, bare factory function as a clip, `ClipFactory`, `ClipVoice`                                                                 | `{ sound: Sound, length?, loop? }`; a buffer behaves as `buffer`; a factory is one hit held for `length` (endless while looping), `hit.pitch` = the clip's `pitch`                             |
  | `Pad hit time must be finite, non-negative seconds.`, `Pad hit velocity must be finite.`, `Pad hit pitch must be finite semitones.`                                  | `Sound hit needs a finite time in seconds.`, `Sound hit needs a velocity from 0 to 1.`, `Sound hit needs finite semitones for pitch.`                                                          |
  | `Step Sequencer sound needs a note name like "C4", an AudioBuffer or a function ...`, `Step Sequencer sound factory needs to return an AudioScheduledSourceNode ...` | `Sound needs a note name like "C4", an AudioBuffer or a sound factory function.`, `Sound factory needs to return an AudioScheduledSourceNode or { output, sources } with at least one source.` |

  New core exports: `playSound` (the voice player under `Sampler`, `PadBank`, lanes and clips), `assertSound`, `noteNumber`, and the types above. New errors: `Note needs a MIDI number from 0 to 127 or a note name like "C4".`, `Sound factory duration needs finite seconds from 0.`, `Sound hit needs finite seconds from 0 for offset and duration.`, `Sampler is disposed.`. `PadBank` and `Sampler` also take `signal`. `BufferPlayer` is unchanged (single-playhead deck).

- **widgets:** `mountStepGrid` keeps the on colour visible at any value: an active cell draws a cap (`--ar-step-cap-height`, default 4px) in `--ar-step-cell-on-background` above the value band, and the band is inset from the cell sides (`--ar-step-fill-inset`, default 3px). The lane header is 340px by default and the widget adapts to its own width: at 900px or narrower (a container query on the widget root) the header is 300px with compact controls and cells shrink to 14px, so a 768px container fits 16 steps without scrolling and names such as "Tom even" are not truncated.

- **core / recorder / player / widgets:** **Breaking.** Recording and playback follow the platform: `FilePlayer.play()` rejects like `HTMLMediaElement.play()`, a take starts with `record()`, and `WavePlayer` is observed through its cells only. No aliases remain; migrate every call site in one pass.

  | Old                                                                                                           | New                                                                                                                                                        |
  | ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `FilePlayer.play()` resolved on `NotAllowedError` and `AbortError`; with no `src` it resolved and did nothing | rejects with the element's `DOMException`: `NotAllowedError` (autoplay blocked), `AbortError` (interrupted), `NotSupportedError` (no `src` or undecodable) |
  | `fromFilePlayer` called `player.audio.play()` to see the failure                                              | it calls `player.play()` and the view shows the rejection                                                                                                  |
  | `await recorder.start({ when })`, then `recorder.stop(...)` for the take                                      | `const taken = recorder.record({ when?, quantize?, length?, signal? })`; `recorder.stop({ when? })` ends it early; `await taken` is the take               |
  | hand-computed bar boundary and `stop({ when: start + 8 })`                                                    | `clock.attach(recorder)`, then `record({ quantize: "1m", length: "4m" })`                                                                                  |
  | `RecordedAudio` had no beat position                                                                          | `RecordedAudio.startBeat: number \| null`                                                                                                                  |
  | `WavePlayer.getState()`, `subscribe(listener)`, `getSelection()`, type `WavePlayerState`                      | `player.cells.*` (`effect`, `useValue`, or `cells.x.subscribe(listener, { immediate })`)                                                                   |
  | `WavePlayer.isPlaying`, `.isLooping`, `.version` getters                                                      | `player.cells.isPlaying`, `.isLooping`, `.version` (`.value`)                                                                                              |
  | `setStretch` failure: rejected promise and `getState().error`                                                 | the rejected promise only; `cells.error` is for `load()`                                                                                                   |
  | `SelectionModel` (`getSelection`, `setSelection`, `subscribe`), `SelectorPlayer.getState`, `.version`         | `SelectionModel` is `{ cells: { selection }, setSelection }`; `SelectorPlayer` follows `cells`; `WaveformSelectorState` is defined by `widgets`            |

### Added

- **player:** `WavePlayer` is a clock scheduler like `AudioRecorder` and `ClipLauncher`: `clock.attach(player)`, then `play({ quantize: "1m" })` starts on the next bar line (`Quantize`, same boundary rule as the recorder; a call exactly on a boundary starts there). `quantize` without an attached, playing clock rejects with `InvalidStateError`, and `when` with `quantize` rejects with `RangeError`. `cells.startsAt` is the audio time a queued start (future `when` or quantize boundary) begins; `stop()`, `pause()` and the clock leaving the transport cancel it. `play()` with no options is unchanged. Install `@audiorective/clock` only to attach.
- **core:** `FilePlayer` gains `cells.error` (the element's `MediaError`, cleared when `src` is set) and a `position` getter that reads `audio.currentTime` live; `cells.currentTime` still updates only at `timeupdate` (about 4 Hz), so animate from `position`.
- **recorder / player / samples (docs):** `AudioRecorder.stop()` ends a take early and resolves `record()` with the partial take, `cancel()` discards it with `AbortError`; the `quantize` docs note that during a count-in a boundary can fall inside it (`when: clock.timeline.beatToTime(0)` starts at bar 1). `WavePlayer` `play`, `seek`, `setSelection`, `setLooping`, `setStretch` and `SampleLibrary` `preview`, `remove`, `stopPreview` document their exact behaviour.

- **recorder:** `MicrophoneInput.open(context, { audio?, signal? })` asks for the microphone and resolves with an `AudioProcessor` (`mic.connect(recorder)`) that has `stream`, `cells.state` (`"live" | "ended"`), a writable `cells.monitoring` (routes to `context.destination`) and `dispose()` / `[Symbol.dispose]()` that stops every track. It rejects with `getUserMedia`'s own `DOMException` (`NotAllowedError`, `NotFoundError`, `NotReadableError`, `OverconstrainedError`, `SecurityError`); an aborted `signal` rejects `open` or disposes the input.
- **recorder:** `AudioRecorder` is a clock scheduler: `clock.attach(recorder)`, then `record({ quantize: "1m", length: "4m" })` starts on the next bar line and ends exactly four bars later (`quantize` takes `"none"`, `"<n>m"`, `"<n>n"`; `length` takes seconds or a note value). New `cells.startsAt` / `cells.startedAt`, `AudioRecorderOptions.signal`, `RecordOptions.signal` and `toAudioBuffer(take, context)`; new errors `InvalidStateError` (quantize or a note-value length without a playing attached clock). A `record({ quantize })` call exactly on a boundary starts there, like the launcher.
- **player / samples:** `WavePlayerOptions.signal` and `SampleLibraryOptions.signal` dispose on abort; `SampleLibrary` has `[Symbol.dispose]()`; `WavePlayer.cells.playhead` (`{ position, startedAt }`) changes on every seek, play, pause and stop.
- **clock:** `TimelineLike` extends `BeatTiming`, so the `timing` a `Scheduler` receives and a ruler's timeline are one type.
- **core:** `AudioProcessor.connect(destination, output?, input?)` and `disconnect(destination?)` mirror `AudioNode.connect`. The destination is an `AudioNode`, `AudioParam`, `SchedulableParam` or another `AudioProcessor` (its `input`), `connect` returns it so calls chain, and `disconnect()` removes every connection the processor made. The edges join a latency graph per `AudioContext`, so delay compensation, `AudioEngine.getPathLatency` and `AudioEngine.latency` see them; a bare `AudioWorkletNode` destination is connected directly and stays outside the solve. `defineGraph` remains for reactive edge lists, and joins are compensated within one mechanism only. New errors: `AudioProcessor.connect: X has no output`, `AudioProcessor.connect: X has no input`, `X is disposed.`
- **core:** `subscribe(listener, { immediate? })` on `Cell`, `ReadonlyCell`, `Param`, `SchedulableParam` and `Readable` returns an unsubscribe function, is a bound method valid for `useSyncExternalStore`, and fires on a `SchedulableParam` while a scheduled ramp moves the value. `useValue` in `@audiorective/react` is built on it.
- **core:** `new AudioEngine(context?, { signal })` and `createEngine(setup, { context?, signal? })` dispose the engine when the signal aborts. New export `AudioEngineOptions`. `AudioEngine` has `[Symbol.dispose]()`.

- **clock:** `SchedulerHandle.cancelFrom(time)` retracts the calling scheduler's own events (registered through `window.own`) that start at or after `time`, synchronously, and touches nothing else: not other schedulers' events, `onTick` events, its earlier events or the refill point. The scheduler refills the span through its most recent window's `own`. `refresh()` is unchanged; do not replay by hand after `cancelFrom` then `refresh()`.

- **clock:** the scheduler contract grows. `Scheduler.reset(reason)` gets a `ResetReason` (`"start" | "stop" | "pause" | "seek" | "detach"`), called before the state change; `resume()` sends none, so a scheduler can keep launches queued while stopped across `start()`. `SchedulerHandle` now carries `timeline`, `state` and `meter` next to `refresh()` and `detach()`, available synchronously inside `attached`. The optional `Scheduler.transport(change)` reports `start`, `stop`, `pause`, `resume`, `seek` and `tempo` (every edit of `clock.bpm`) as `TransportChange { type, when, beat }`. `Clock.meter` is a writable `Cell<TimeSignature>` (default `[4, 4]`, option `ClockOptions.meter`). New exports `ResetReason`, `TransportChange`, `TransportChangeType`, `TimeSignature`. New error: `Clock meter must be [numerator, denominator] positive integers`. Not breaking: a `reset()` that ignores its argument behaves as before, and `StepSequencer` is unchanged.
- **clock:** `new Clock({ context, bpm? })` creates its own `Timeline` from the AudioContext (`audioContext` is accepted as the same option), so a transport is one object. `clock.bpm` is the Timeline's `TempoParam` (`clock.timeline` is the Timeline). `new Clock({ timeline })` is unchanged and borrows the Timeline; a Clock that created its own owns it. `ClockOptions.timeline` is optional. New errors: `Clock takes either timeline or context, not both.`, ``Clock needs a `timeline` or a `context`.``, ``Clock `bpm`only applies with`context```.
- **blocks:** `StepSequencer` gains a lane-record constructor form: `new StepSequencer({ kick: "X...", snare: { pattern, rate: "16n", swing: "30%", sound, params } }, { context, seed, onHit, transform, signal })`. Lanes loop independently on their own length and rate (polymeter), `Time` rates (`"16n"`, `"16n."`, `"8t"`, `"1m"`, `"250ms"`), `lanes.<name>` live setters and 0-based `steps[i]` writes that re-queue automatically on an attached transport, `onHit` with a cleanup run when a pending hit is retracted, `HitEvent`/`onhit` (the class is now an `EventTarget`), `transform(hit, random)`, optional per-lane `sound` with `lane.output`/`connect`/`disconnect`, and `dispose()`/`[Symbol.dispose]()`. The `(pattern, trigger, options)` form is unchanged.
- **clock:** `Scheduler.attached(handle)` hook and the `SchedulerHandle` type: `clock.attach` hands a scheduler `{ refresh(), detach() }` and runs the cleanup it returns on detach.
- **clock:** `Clock.attach(scheduler)` follows a clock with any `{ schedule(window, timing), reset?() }` and returns a detach function; `onTick` is now optional, and `clock.timeline` is public. Owned events and `reset()` follow `start`, `pause`, `stop`, `seek` and `destroy`; `refresh()` re-queues every scheduler. New exports `Scheduler`, `SchedulerWindow`. New errors: `Clock is destroyed.`, `Clock already has this scheduler attached.`
- **daw:** `Workspace.transport` returns the Workspace's Clock, the transport other schedulers attach to.
- **clock:** `Clock.start(when?, offsetBeats?)` has the shape of `AudioScheduledSourceNode.start`: beat `offsetBeats` (default 0) sounds at audio time `when` (default now; a past `when` clamps to now; a future `when` is "playing" at once with nothing scheduled before it). `start({ atBeat })` keeps working. `TempoParam.setTargetAtTime(target, startTime, timeConstant)` (128 linear ramps over 8 time constants) and `setValueCurveAtTime(values, startTime, duration)` (exact) complete the AudioParam scheduling surface. New errors: `Clock start time must be finite seconds`, `Clock start offset must be finite beats`, `TempoParam start time must be finite`, `TempoParam time constant must be finite and >= 0`, `TempoParam value curve needs at least 2 values`, `TempoParam value curve duration must be finite and > 0`.
- **core:** `hash01(...parts)` hashes numbers and strings to a number in [0, 1); `EventTransformContext.randomFor(event, key?)` gives a transform a number that is stable per event; `applyEventTransforms` takes an `EventTransformInput` (`seed?`, `keyOf?` besides the old fields) and builds `randomFor` from it. `context.random` stays, documented as a sequential, unstable source.
- **blocks:** `StepSequencerOptions.seed` (default 0) seeds the stable chance and `randomFor` draws.
- **clock:** `TempoParam.linearRampToValueAtTime(value, endTime)` and `exponentialRampToValueAtTime(value, endTime)` schedule tempo ramps with Web Audio semantics (from the previous event, or from the current value at the current time when nothing is scheduled). `beatToTime`, `timeToBeat`, rulers, Clock windows and `bpm.value` follow the ramp exactly; `valueAtTime` interpolates, and `cancelAndHoldAtTime` cuts a ramp at the interpolated value. A non-finite end time throws `TempoParam ramp end time must be finite`. Both methods previously threw `TempoParam.<method> is V2 (tempo ramps)`.
- **core:** `ValueRange` (`{ min, max }`), `ParamRange` (adds `default` and an optional `step`) and `ParamSpec` (adds `id` and an optional `label`) describe a numeric parameter's range once. `StepParamSpec` and `StepGridParamSpec` are aliases of `ParamSpec`; `ParamOptions`, `LfoOptions`, `RackMacroMapping` and `WebClapParameter` reuse the same fields. No behaviour change.
- **blocks:** `refreshOnEdit(sequencer, transport)` in `@audiorective/sequencer` calls `transport.refresh()` once per committed change of a `StepSequencer`'s `pattern` or `transforms` (not on attach) and returns a disposer. `transport` is any `{ refresh(): void }`. `Workspace.attachStepSequencer` in `@audiorective/daw` uses it.
- **core:** `withCancel(event, undo)` returns a `CancellableEvent` whose `cancel()` also runs `undo` once, so a trigger's extra scheduling (such as a filter cutoff) is retracted when a scheduler cancels and re-queues the hit.
- **blocks:** `PadBank.routePad(id, destination | null)` sends one pad to a caller-owned node (or back to the bank `output` with `null`). Each pad owns a gain node feeding `output`, so pads in one choke group can feed different effects and still choke each other. An unknown pad ID throws `Unknown pad.`
- **blocks:** `StepSequencer.cellParams` (`stepCellParams`) lists the six built-in cell ranges as `StepParamSpec[]`, and `StepSequencer.rates` (`stepRates`) lists the twelve `StepRate`s in display order. Cell validation reads the same constants.
- **core:** `ScheduledEvent` (`{ when }`), `TimedEvent` (adds `duration`, `velocity`), `EventTransform<E>`, `EventTransformContext` and `applyEventTransforms`, the shared contract and enforcement for scheduler transform sockets. See Core "Shared contracts".
- **blocks:** `StepSequencer` option `transforms` (default `defaultStepTransforms`), the read-only `transforms` cell and `setTransforms(list)`; exported `stepSwing()` and `defaultStepTransforms` from `@audiorective/sequencer`. Violations throw `Event transform "<id>" …`.
- **blocks:** `StepSequencer` option `params` (`StepParamSpec[]`) declares custom per-step numbers, exposed as `sequencer.params`; cells carry `custom`, and `setCell(lane, step, { custom })` merges partially and validates. New errors start `Step Sequencer params need`, `Step Sequencer custom values need` and `Step Sequencer transforms need`.
- **widgets:** `mountStepGrid` returns `{ attach(plugin), destroy() }` (a `PluginTarget<StepGridPluginContext>`). The context adds `surface`, `sequencer`, `cellElement`, `cellRect`, `mountOverlay`, `addToolbarItem`, `activeParameter`, `setActiveParameter` and `onPatternChange` to `listen` and `onCleanup`. The grid shows lane headers (label, mute, solo, steps, rate, direction, swing), parameter tabs for the six built-in cell values plus the sequencer's custom `params`, vertical-drag and keyboard editing, polymeter dimming, per-lane playheads, a loop progress bar, bar markers and a fold toggle. Colours and sizes are `--ar-step-*` custom properties. New exports: `StepGridSequencer`, `StepGridPluginContext`, `StepGridHandle`, `StepGridOptions`, `StepGridLabels` and the pattern, lane, cell and param types.
- **widgets:** `StepGridPlugin`, an alias for `WidgetPlugin<StepGridPluginContext>` (as `TimeViewPlugin` is for the time views), exported from `@audiorective/widgets`.
- **widgets:** `StepGridSequencer` gains optional `cellParams` and `rates`; the grid reads them when present (a `StepSequencer` provides both) instead of its own copies of the ranges and rate names. `StepGridLabels` gains `dir`.
- **widgets:** new step grid theming properties `--ar-step-header-background`, `--ar-step-name-color`, `--ar-step-column-color`, `--ar-step-box-*`, `--ar-step-mute-active-*`, `--ar-step-solo-active-*` and `--ar-step-tabs-background`.

### Changed

- **core:** `Analyser` takes a `BaseAudioContext` (it was typed `AudioContext`), so it can be built on an `OfflineAudioContext` like every other processor.
- **blocks:** `StepHit` extends `TimedEvent` and gains `count`, `beat`, `rateBeats`, `swing`, `custom` and `loop`; `StepCell` gains `custom` (`{}` without `params`). Lane `swing` is applied by the `stepSwing` transform, so a custom `transforms` list without it makes `swing` inert; compose `[...defaultStepTransforms, mine]` to keep it.

### Changed (breaking)

- **blocks / daw / widgets:** **Breaking.** `StepSequencer` has one form, the lane-record form: `new StepSequencer({ kick: "X...", hat: { pattern, rate, swing, direction, solo, mute, sound, params, onHit } }, { context, onHit, transform, seed, random, signal })`, attached with `clock.attach(seq)` or `workspace.transport.attach(seq)`. The explicit form and its helpers are removed. New: per-step `steps[i].offset`, `length`, `repeat`, `pitch` and `chance`; per-lane `direction`, `solo`, settable `length`, and live `playhead` (0-based index or `null`) and `progress` (0..1 through the lane's own loop, or `null`); `Hit.pitch`; `SoundFactory(context, hit)`, and note-name and `AudioBuffer` sounds follow `pitch`. `mountStepGrid` takes the sequencer directly (`StepGridSequencer = { lanes }`) and gains `laneLabel(name)`. Migration:

  <!-- prettier-ignore -->
  | Before | After |
  | --- | --- |
  | `new StepSequencer({ size, lanes }, trigger, options)` | `new StepSequencer({ kick: "X...", ... }, { onHit, context, ... })`; the trigger becomes `onHit` (return a cleanup in place of the returned `CancellableEvent`) |
  | `StepPatternInput`, `StepPattern`, `StepLane`, `StepCell` | `sequencer.lanes.<name>` and `lanes.<name>.steps[i]` |
  | `setCell(lane, i, patch)` / `toggle(lane, i)` | `lanes.<name>.steps[i].velocity = v` (any step field the same way) |
  | `setLane(lane, patch)` / `setSize(n)` | `lanes.<name>.rate`, `swing`, `direction`, `mute`, `solo`, `length`, `pattern` setters |
  | `sequencer.pattern` cell | read `lanes.<name>.pattern`, `length`, `steps[i]` (tracked) |
  | `playheads.value[lane]` / `loopProgress` | `lanes.<name>.playhead` / `lanes.<name>.progress` |
  | `transforms` option, `setTransforms`, `stepSwing`, `defaultStepTransforms`, `StepTransform` | lane `swing`, step `offset`, and `transform(hit, random)` in seconds; `StepHit`/`StepEvent` become `Hit` |
  | `refreshOnEdit(sequencer, clock)` | `clock.attach(seq)` re-queues on every edit |
  | `Workspace.attachStepSequencer(seq)` | `workspace.transport.attach(seq)` |
  | sequencer-level `params`, `cellParams` / `stepCellParams`, `rates` / `stepRates` | lane `params: { id: { min, max, default } }`; ranges are in the `Step` JSDoc |
  | `hit.custom`, `hit.laneId`, `hit.step` | `hit.values`, `hit.lane`, `hit.index` |
  | `onHit`/`context` only in the lane-record form | the only form; the error `Step Sequencer onHit and context belong to the lane-record form` is gone |

- **launcher / daw / widgets:** **Breaking.** `ClipLauncher` has one form: tracks of clips that the launcher plays itself on a clock. `new ClipLauncher({ drums: [clipA, clipB], bass: [clipC] }, { context, quantize, seed, scenes, transform, signal, onSchedule })`, attached with `clock.attach(launcher)` or `workspace.transport.attach(launcher)`. A clip is an `AudioBuffer`, a `sound` factory returning an unconnected source, or a `scheduler` (a `StepSequencer` or any clock scheduler, routed into the track by the launcher), with per-clip `quantize`, `offsetBeats`, `loop` (or a loop region), `length`, `gainDb`, `pitch`, `mode` (`"trigger" | "gate" | "toggle" | "repeat"`), `chance`, `follow`, `legato`, `bpm` and `warp`. New: `launcher.scenes` with a tempo, `launchScene`, `stopAll`, `track.stop`, `cancelQueued`, `clip.configure`, `clip.release`, `Clip`/`Track` cells (`playing`, `queued`, `startsAt`, `startedAt`, `options`), `launcher.quantize` cell, the `queued`/`started`/`ended`/`cancelled`/`skipped` `ClipEvent`s and `onSchedule` for hosts. Buffer clips follow the song tempo by default: `warp` defaults to `"repitch"` (playback rate = clock tempo / the clip's `bpm`, which defaults to the clock tempo when the clip is created); pass `warp: false` to keep a buffer's own speed. The driver-based API (`queue`, `ClipLaunchTransport`, `ClipLaunchTransition`, `cancel`, `advance`, `reset`, `state`) is removed. `@audiorective/launcher` still depends only on `@audiorective/core`.

  <!-- prettier-ignore -->
  | Before | After |
  | --- | --- |
  | `new ClipLauncher(transport)` with a driver you wrote | `new ClipLauncher({ track: [clips...] }, { context })`; the launcher plays the clips |
  | `launcher.queue([{ trackId, clipId }], beats)` | `launcher.tracks[trackId].clips[i].launch({ quantize })`; `"none"` is quantum 0, `"4n"` a beat, `"1m"` a bar |
  | `queue([a, b], beats)` as one scene | `launcher.launchScene(i)` (slot `i` of every track) or `launchScene([clipA, clipB])` |
  | `queue([{ trackId, clipId: null }])` | `launcher.tracks[trackId].stop()`; `launcher.stopAll()` |
  | `cancel(trackId?)` | `track.cancelQueued()` / `launcher.cancelQueued()` (also `clip.cancelQueued()`) |
  | `advance()` called from the clock's `onTick`; `reset()` called by the app | none: `clock.attach(launcher)`; the clock resets it on stop, seek and detach, and pause freezes it |
  | `launcher.state.value.active` / `.queued` (`{ trackId, clipId, mode, beat, when }`) | `launcher.playing.value` (clips), `launcher.queued.value` (`{ track, clip, beat, when }`), `clip.playing` / `clip.queued`, `track.playing` / `track.queued` |
  | `ClipLaunchTransition.commit()` / `cancel()` / `endsAt` | `onSchedule` returns `{ cancel, commit, reset }`; `ScheduledChange` carries `when` and `endsAt` |
  | `mode: "loop" \| "one-shot"` on a launch | `loop: true` (default for a looping clip) or `loop: false` on the clip, `clip.configure({ loop })` |
  | `Workspace.launchClips(changes, beats)` | `workspace.sessionClip(trackId, clipId).launch({ quantize })`, `workspace.session.value.launchScene([...])`; a launch made while stopped waits for `play()` (`Start Workspace playback before launching clips.` is gone) |
  | `Workspace.cancelClipLaunch(trackId?)` | `workspace.session.value.tracks[trackId].cancelQueued()` / `.cancelQueued()` |
  | `workspace.session` / `cells.session` as `{ active, queued }` | `workspace.session` / `cells.session` is the `ClipLauncher` (replaced by `sync()`); `Workspace.pause()`, `stop()` and `seek()` no longer call a manual reset, the launcher follows the transport |
  | `mountClipGrid(root, { state, launch(changes), cancel })`, layout `{ trackId, clipId }` | `mountClipGrid(root, { launcher, launch?, cancel?, labels? })`, layout `{ track, clip, label }` objects; the buttons call `clip.launch()`, `launchScene`, `track.stop()`, `stopAll()` |
  | `Clip Launcher requires a non-negative launch quantum.`, `...one launch per affected track.`, `...a future audio time.`, `Clip Launcher requires an audio track.`, `...an in-memory audio clip on the target track.` | gone; new errors start `Clip Launcher requires` (`chance`, `repeatBeats`, loop region, note value) |

  The `@audiorective/daw` Session behaviour that changed with it: Pause freezes (Play then starts fresh) instead of clearing every override at once, a tempo change no longer clears Session, a clip removed from the Project is stopped when `refreshArrangement()` applies the edit, and the launcher quantize defaults to a bar of the Project time signature (`clock.meter` follows it).

- **clock:** **Breaking.** `Clock.refresh()` no longer calls `onTick` before it returns. Owned events are still cancelled synchronously; the refill tick runs in one microtask, shared by every `refresh()` in the same task, so a refresh from inside `onTick`, an effect or a launcher method cannot re-enter it, and N edits re-queue once. `start`, `pause`, `stop`, `seek` and `destroy` cancel a pending refill. Code that read the refilled window right after `refresh()` must `await` a microtask first.
- **core:** **Breaking.** Event transforms work in beats by default. `EventTransform<E>` now takes `E extends BeatEvent` (`{ beat }`; `TimedBeatEvent` adds `durationBeats` and `velocity`) and gains `unit?: "beat" | "second"`. A `unit: "second"` transform reads and returns the seconds form (`SecondsOf<E>`: `when`, `duration`), converted through `context.timing` and back to beats before the next transform. `context.now` is in the transform's unit. `applyEventTransforms` takes beat events and returns `SecondsOf<E>[]` after one exit conversion and the clamp to `now`. New errors: `Event transform "<id>" returned an event without a finite "beat".`, `... whose "durationBeats" is not a finite number above 0.` and `Event transform "<id>" has a unit other than "beat" or "second".` To migrate a seconds transform, add `unit: "second"`; to migrate a timing move, use `beat` and `durationBeats`.
- **blocks:** **Breaking.** `StepSequencer` transforms are `StepTransform` (`EventTransform<StepEvent>`) and run on beat-positioned `StepEvent`s. `StepHit`, the trigger's argument, is now `SecondsOf<StepEvent>`: still `when` and `duration` in final, clamped seconds. The lane step boundary field `beat` is renamed `stepBeat`, because `beat` is now the hit's own position. `stepSwing()` is pure beat arithmetic, so swing stays a fixed beat offset when the tempo changes. Timing at constant tempo is unchanged.
- **widgets:** the step grid lane header is a column layout under a column header row. Steps and Swing are number boxes (`role="spinbutton"`), Rate is a styled picker and Dir cycles on click. Default sizes change: header width 320px, cell height 40px, gap 4px, bar gap 8px. Migration: select the controls by role or `aria-label` rather than as `<select>` or `<input type="range">`, and override `--ar-step-header-width`, `--ar-step-cell-height`, `--ar-step-cell-gap` and `--ar-step-bar-gap` to restore other sizes.
- **widgets:** `mountStepGrid`'s `sequencer` contract is `{ pattern, playheads, loopProgress, params?, setCell, toggle, setLane }`, and `pattern` lanes carry `steps`, `rate`, `direction`, `swing`, `mute`, `solo` and cells with all six values. The option `velocityLabel` is removed and the velocity slider is gone: edit by dragging a cell or with Up and Down. Migration: `{ sequencer, velocityLabel: "力度" }` → `{ sequencer, labels: { velocity: "力度" } }`; `formatStep` is unchanged. The grid is no longer a table and its buttons are `.ar-sg-cell` elements with `role="button"`; select cells through `data-lane` and `data-step`, or `plugin.cellElement(laneId, step)`. The playhead marker is `data-current="true"` on the cell.
- **effects:** `signalsmith-stretch` moves from a dependency to an optional peer dependency of `@audiorective/effects`, loaded lazily when `PitchShift` creates the `"stretch"` engine. Migration: install `signalsmith-stretch` when you use the stretch pitch engine; without it `ready` rejects with `PitchShift stretch engine needs the optional peer dependency "signalsmith-stretch"…`. Filter, Delay and the granular engine are unaffected.
- **workspace → daw:** the package is `@audiorective/daw` and has three entries plus a convenience root. Migration: `import { Project, … } from "@audiorective/workspace"` becomes `from "@audiorective/daw/project"`; `openDawProject`, `openDawProjectBlob`, `saveDawProject`, `saveDawProjectTo` come from `@audiorective/daw/dawproject`; `Workspace` and `scheduleClipEnvelope` come from `@audiorective/daw/runtime`. `@audiorective/daw` re-exports all three. `project` and `dawproject` load without an `AudioContext` or the DOM; `runtime` does not import the codec.
- **daw:** `Workspace.open`, `Workspace.openBlob`, `workspace.save()` and `workspace.saveTo()` are removed. Migration: `Workspace.open(ctx, bytes, o)` → `openWorkspace(ctx, bytes, o)`; `Workspace.openBlob(ctx, blob, o)` → `openWorkspaceBlob(ctx, blob, o)`; `workspace.save()` → `saveWorkspace(workspace)`; `workspace.saveTo(stream)` → `saveWorkspaceTo(workspace, stream)`. All four come from the `@audiorective/daw` root. `Workspace.create(ctx, project, o)` is unchanged.
- **daw:** `workspace.checkpoint()` waits for pending edits, folds live plug-in state into `Project` and returns it. `WorkspaceOptions.warnings` seeds `workspace.warnings`; `openWorkspace` passes file-open warnings through it.
- **blocks → player / recorder / samples / pads / sequencer / launcher:** **Breaking.** `@audiorective/blocks` is split into six independent packages, one per capability, and the `blocks` package no longer exists. Each depends only on `@audiorective/core`, has a root entry and no subpaths, and behaves as before; only the import path changes. Migration: `@audiorective/blocks/player` → `@audiorective/player` (`WavePlayer`); `@audiorective/blocks/recorder` → `@audiorective/recorder` (`AudioRecorder` and its recording types); `@audiorective/blocks/samples` → `@audiorective/samples` (`SampleLibrary`); `@audiorective/blocks/pads` → `@audiorective/pads` (`PadBank`); `@audiorective/blocks/sequencer` → `@audiorective/sequencer` (`StepSequencer`, `Lane`, notation and sounds); `@audiorective/blocks/launcher` → `@audiorective/launcher` (`ClipLauncher`). Install only the packages you use; the Blocks docs page is replaced by one page per package.
- **blocks:** `InstrumentEvents` is renamed `PadBank`, its hit type `InstrumentEvent` is `PadHit`, and `EventPad` is `PadSpec`, imported from `@audiorective/pads`. Its error messages start with `Pad Bank`, `Pad hit` or `Unknown pad.`
- **blocks → effects:** `EffectRack` moves from `@audiorective/blocks/effect-rack` to `@audiorective/effects/rack`; `LiveRackMacro` is no longer exported. The pure settings and validation (`normalizeRackEffects`, `normalizeRackPreset`, `retainRackMacroTargets`, `rackMacroRange`, the `Rack*` types) are also available without an `AudioContext` from `@audiorective/effects/rack-preset`.
- **blocks → daw:** `ClipEnvelope`, `normalizeClipEnvelope`, `unityClipEnvelope`, `clipGainAt` move from `@audiorective/blocks` to `@audiorective/daw/project`; `scheduleClipEnvelope` moves to `@audiorective/daw/runtime`. `WaveStretchAnchor` stays in `blocks/player`; `ClipStretchAnchor` in `daw/project` has the same shape.
- **core / clock / blocks:** `CancellableEvent` and the new `BeatTiming` (`beatToTime`, `timeToBeat`) are core contracts. `@audiorective/clock` still re-exports `CancellableEvent`. `PadHit` extends it. `StepTiming` is removed: use `BeatTiming`. `StepSequencer` triggers return any `CancellableEvent`, and `ClipLaunchTransport` extends `BeatTiming`.
- **blocks:** `SampleLibrary.preview()` plays through core `BufferPlayer` instead of `WavePlayer`, so `blocks/samples` imports only core.
- **widgets:** `mountStepGrid`, `mountSampleBrowser`, `mountClipGrid`, `createWarpMarkers` and `mountClipEnvelopeEditor` accept local structural contracts instead of block or project classes. `mountWaveformSelector`'s `{ context }` option is replaced by `{ createPlayer: () => WavePlayer }`: `{ context }` → `{ createPlayer: () => new WavePlayer(context) }`. Passing `{ player }` is unchanged.
- **daw:** `Workspace.commit()` does not exist; direct `Project` edits apply automatically (see below). Call `await workspace.flush()` to wait.
- **clock:** `Clock.state` is a `ReadonlyCell<TransportState>` (was `Param<TransportState>`), the same store as `timeline.state`, written only by `start`, `pause`, `resume` and `stop`. Reads through `.value` and `$()` are unchanged; writes no longer exist.
- **clock:** `Timeline.state` is a `ReadonlyCell<TransportState>` (was a plain getter). Migration: `timeline.state` → `timeline.state.value`.
- **clock:** `timeline.rulers.<key>.current` is a `ReadonlyCell<TPoint>` (was `Param<TPoint>`).
- **effects:** `cells.reduction` and `cells.isReady` on `DynamicsCore`, `Compressor` and `Limiter`, and `cells.isReady` on `PitchShift` and `Convolver`, are `ReadonlyCell` (were `Cell`). Only the owner writes them.
- **effects:** `PitchShift.params.pitch` is a JS-rate `Param<number>`, not a `SchedulableParam`; set `pitch.value` from the main thread.
- **host:** `WebClapEvent` is `CancellableEvent` from `@audiorective/core` (same shape).
- **daw:** `workspace.portabilityReport()` → `portabilityReport(project, workspace.warnings)` from `@audiorective/daw/dawproject`; the `PortabilityReport` type is exported there.
- **daw:** `workspace.exportAudioFallbackTo(destination, options)` → `exportAudioFallbackTo(workspace, destination, options)` from `@audiorective/daw/runtime`; `AudioFallbackOptions` is exported there.
- **daw:** `createOpfsAudioMediaWriter` moves from `@audiorective/daw/project` to `@audiorective/daw/runtime`.
- **core / effects:** `BufferPlayer.cells.isPlaying`, `FilePlayer.cells.isPlaying`, `FilePlayer.cells.currentTime`, `FilePlayer.cells.duration` and `Sampler.cells.activeVoices` are `ReadonlyCell` (were `Cell`). Drive them through `play`, `seek`, `stop`, the `audio` element and the other player methods; direct writes no longer exist.
- **core:** `AudioEngine.state` is a read-only callable (`engine.state()`, `.value`, `$()`) with no setter, and `AudioEngine.latency` is `ReadonlyCell<number>` (was `Param<number>`). Only the engine writes them.
- **core:** `AudioEngine` does not close an `AudioContext` passed to it; only a context it created is closed on `destroy()`. It listens with `addEventListener("statechange")` instead of overwriting `onstatechange`, so a borrowed context keeps its own handler. `destroy()` rejects pending `untilReady()` calls, and `untilReady()` after `destroy()` rejects.
- **blocks / widgets:** `mountMixer` option `output(id)` is replaced by `meter(id)`, which returns a caller-owned reader `{ sampleCount?, read, destroy? }` (or `undefined` for no meter). Migration: `output: (id) => node` becomes `meter: (id) => { const a = node.context.createAnalyser(); node.connect(a); return { sampleCount: a.fftSize, read: (d) => a.getFloatTimeDomainData(d), destroy: () => node.disconnect(a) }; }`.
- **blocks (breaking):** `StepSequencer` has a new data model. Migration: `StepPattern { steps, beatsPerStep, lanes[{ id, label, velocities }] }` → `{ size, lanes[{ id, label, steps?, rate?, direction?, swing?, mute?, solo?, cells: [{ velocity, ... }] }] }`, where `size` is the loop length in 1/16 steps and `beatsPerStep: 0.25` becomes the lane's default `rate: "1/16"` (`0.5` → `"1/8"`, `1` → `"1/4"`; set the lane's `steps` for a shorter lane). `velocities: [1, 0]` → `cells: [{ velocity: 1 }, { velocity: 0 }]`. `setVelocity(id, step, v)` → `setCell(id, step, { velocity: v })` (or `toggle(id, step)`). `currentStep` (one index) → `playheads` (a cell index per lane ID) and `loopProgress`. The trigger's `StepHit` gains `pitch`, `duration`, `repeatIndex` and `repeatCount`. Thrown messages are new; see Common errors in `docs/blocks.md`.
- **widgets (breaking):** `mountStepGrid`'s `sequencer` contract is `{ pattern: Readable<{ size, lanes[{ id, label, cells[{ velocity }] }] }>, playheads, setCell }` instead of `{ pattern, currentStep, setVelocity }`.

### Fixed

- **daw:** `openWorkspace` and `openWorkspaceBlob` return a Workspace that owns its opened `Project`: `workspace.destroy()` destroys it. `WorkspaceOptions.ownsProject` hands a project to `Workspace.create` the same way; without it the caller still owns the project.
- **daw:** `Project.cells.content` re-runs for note and duration edits made through `MidiClip.sequence` as well as structural commits; `Project.cells.revision` still counts structural commits only.
- **widgets:** `mountStepGrid` rebuilds when the borrowed pattern's step count or lane list changes instead of throwing.
- **blocks:** `WavePlayer.buffer`, `.duration` and `.sourceBuffer` track the committed playback version. `EffectRack.effects` and its read-only `cells.effects` update alongside the live chain. A destroyed WavePlayer now reports `WavePlayer is destroyed.`.
- **clock:** `timeline.bpm.$(x)` writes a tempo-curve step like `bpm.value = x`; before, it changed only the displayed value.
- **effects:** `Convolver.buffer` is a tracked read. `Compressor` and `Limiter` without AudioWorklet no longer cause an unhandled rejection; `ready` still rejects.
- **host:** `destroy()` and a plug-in "error" message reject pending `saveState()`, `loadState()` and `mountEditor()` calls and clear their timers.
- **daw:** `Project.clipTimeSeconds` tracks tempo changes. `duplicateClip`, `snapshot`, `trimClip`, `splitClip`, `MidiClip.playbackEvents` and the Workspace commands `setTrack*`, `setMasterVolume`, `seek`, `play`, `takeAnchor`, `launchClips` and `refreshArrangement` no longer subscribe a calling effect. A multi-field Project edit is one change, and a `snapshot()` copy starts at revision 1.
- **core:** `SchedulableParam` raw writes `$(x)` update the AudioParam like `.value`; before, they changed only the signal. `AudioEngine.start`, `suspend`, `resume` and `untilReady` no longer subscribe a calling effect. `AudioProcessor.destroy()` stops its constant sources and disconnects the internal silencer. `AutomationBinding.start` no longer tracks the curve, and `AutomationCurve.$(points)` validates, sorts and freezes like `.value`.
- **widgets:** Mixer strips keep reactive widgets mounted through `appendControls` when the track list changes. `attachClipGesture` restores the element's original `left` after a drag. The selection plugin's edge-scroll `requestAnimationFrame` loop runs only during a drag.
- **blocks:** `SampleLibrary.preview()` can be called from an effect and releases its lease when starting the preview fails. `StepSequencer` and `ClipLauncher` commands do not subscribe a calling effect.
- **core:** a `Param` created inside a running `effect()` no longer becomes that effect's child, so its bind effect survives the outer effect re-running. Constructing a processor (`BufferPlayer`, `Sampler`, …) inside an effect is safe, and `SampleLibrary.preview()` keeps its loop and rate bindings.
- **core:** `FilePlayer.src` is a tracked read.
- **core:** `AudioEngine` rejects pending `untilReady()` calls when its context closes externally, and `start()`, `resume()` and `suspend()` no longer flip the state back after a `destroy()` during their await.
- **host:** a timed-out `saveState()`, `loadState()` or `mountEditor()` no longer leaves its waiter queued; the next reply settles the next real caller instead of the dead one.
- **blocks:** `WavePlayer.destroy()` stops subscribers before it resets state, so no listener runs after the player is destroyed.
- **midi:** `MidiSequence.subscribe` is an effect over `cells.state`; it notifies once per committed change, after the enclosing `batch`/effect flush, so several commits inside one outer `batch` produce one notification.
- **daw:** a failure while building a track (for example a throwing `EffectRack`) releases its channel, automation gain and send-bus entry.
- **host:** `WebClapHost.latency` is reported in samples (it was seconds), so graph PDC compensates a plug-in's latency correctly.
- **blocks:** `WavePlayer.sourceToOutput` and `outputToSource` are tracked readers: an effect that calls them re-runs when the source is loaded or stretched.
- **daw:** `Workspace.stop`, `auditionAudioClip`, `auditionRange` and `prepareAudioClipStretch` no longer subscribe a calling effect to Project edits.
- **widgets:** `mountParameter`, `mountLevelMeter`, `mountWaveformSelector` and the selection plugin create elements in the mount root's own document, so they work inside iframes.
- **docs:** `docs/effects.md` lists `Channel`'s `outputEnabled`, `tap` and per-send `enabled`.

### Added

- **blocks:** `StepSequencer` lanes have their own `steps` (polymeter), `rate` (straight and triplet), `direction` (`forward`, `backward`, `bounce`), `swing`, `mute` and `solo`; cells have `offset`, `length`, `repeat`, `pitch` and `chance`. New commands `setCell`, `toggle`, `setLane` and `setSize`, the `playheads` and `loopProgress` cells, and an injectable `random` option.
- **blocks:** `PadBank.trigger(id, velocity, when, { pitch, duration })`: `pitch` (semitones) sets the playback rate to `2 ** (pitch / 12)`; `duration` (seconds) closes a `gate` pad's hit at `when + duration`, retractably like choke.

- **core:** `BufferPlayer.params.buffer: Param<AudioBuffer | null>`; the `buffer` property reads and writes it, like `Sampler.buffer`.
- **effects:** `Channel` option `channelCountMode: "max"` keeps a mono input mono into the panner (equal-power mono pan law); the default `"explicit"` is unchanged.
- **effects:** `Channel.params.outputEnabled` gates the main output, `Channel.tap` is the post-mute node sends read from, and `Send.enabled` gates one send; `SendBus.undefine(name)` removes a receive point.
- **daw:** `workspace.cells.session`, `cells.auditioningClip` and `cells.auditioningRange` are read-only cells; `workspace.session` is a `ReadonlyCell`. `Workspace.deviceOptions` returns the `workletUrl` and `resolveBundle` options used to create a matching Workspace.

- **workspace / widgets:** Project clips retain warp anchors alongside the rendered playback and original source. The DAW waveform marker editor uses the same mapping for drag edits, trimming, source-relative gain and saved projects.

- **effects:** `TimeStretch.process` accepts interior source/output frame anchors for local pitch-preserving warp with an explicit total duration and a compatible caller-supplied WASM module.

- **blocks / workspace:** EffectRack macros map one control to several built-in insert parameters using native linear or exponential scheduling. Rack presets restore their slots and controls together. Workspace persists track macros and applies live knob edits without a transport rebuild.

- **widgets / workspace:** `createAutomationOverlay` edits a borrowed curve over a time view. Project clip gain curves use original source seconds, follow trim and stretch, and apply to playing Arrangement voices without restarting their sources.

- **host / workspace:** `WebClapHost.load` accepts a CLAP `pluginId` for multi-device bundles. Workspace uses the ID it persists. The worklet supports one imported WASM32 memory, including the shared memory used by the Signalsmith Basics example.

- **clock / workspace:** `RangeLoop` projects one source range onto the audio clock. Workspace range audition uses it for synchronized repeats over selected PCM and file-backed audio tracks, with a borrowed playhead-independent preview in the DAW.

- **blocks / workspace:** Session clips accept a one-shot mode. The audio graph returns that track to Arrangement at the clip's exact end, and the launcher drops the finished override from its read-only state.

- **host:** WebCLAP parameters use `host.params[id].value`. Plug-in editor changes and patch restores update the same Params. `parameterInfo` exposes reactive metadata, and `saveState()` / `loadState()` capture and restore patches.

- **workspace:** Direct Project edits apply automatically to the live graph. `flush()` waits for edits, `cells.needsSync` signals structural changes and `sync()` rebuilds on request. Project and MidiClip getters track their owning state, and `cells.warnings` exposes a read-only warning snapshot.

- **workspace:** `auditionAudioClip()`, `auditioningClip` and `stopClipAudition()` play a project audio clip independently of Arrangement. The waveform editor uses the same cached PCM and streamed media windows as project playback.

- **effects / blocks / workspace:** `Equalizer` provides a standalone peaking-filter bank with schedulable band controls and a compound frequency response. EffectRack and the DAW use an `eq` insert that persists, moves and bypasses as one slot.

- **workspace:** `prepareAudioClipStretch()` borrows a standalone processor to render audio from its original source window. Apply in an undo transaction, restore the original at ratio 1, or save rendered playback and the source together. The DAW audio editor supports an optional user-supplied stretch engine.

- **blocks / workspace / widgets:** Reusable clip envelope helpers schedule clip-local gain and fades. Project persists audio clip envelopes for arrangement and PCM Session playback and the DAW uses `mountClipEnvelopeEditor()` to edit them.

- **effects / blocks / widgets / workspace:** Filter exposes the complex response of its stages and wet/dry mix. EffectRack and Workspace expose live Filter responses by slot. `mountSpectrum()` and `mountEqEditor()` work with borrowed data and power the DAW's effect panel.

- **blocks / workspace / widgets:** `StepSequencer` schedules velocity patterns through a borrowed transport. Workspace attaches patterns to its existing Clock, and the DAW combines `mountStepGrid()`, `mountPadGrid()`, cancellable PadBank and optional Sample Library assignments.

- **blocks / widgets:** `SampleLibrary` decodes queued local files, shares identical verified content, exposes retained PCM leases and auditions apart from transport. `mountSampleBrowser()` integrates these controls with the DAW's audio track placement.

- **workspace / widgets:** Project persists submix and effect buses, channel output destinations and post-fader sends in DAWproject. Workspace applies bus and routing edits with existing tracks left running. `mountMixer()` binds reactive strip controls and meters to caller-owned settings. The DAW can create buses, edit routing and sends, and open each bus's effect rack.

- **blocks / workspace / widgets:** `ClipLauncher` queues cancellable track changes at the next grid boundary over a borrowed transport. `Workspace.launchClips()` uses the existing timeline and track routing for live PCM loops. `mountClipGrid()` adds clip, scene, cancellation and return controls, wired into the DAW's Session panel.
- **workspace / widgets / DAW demo:** Persist master volume in the DAWproject main channel and apply it to mix export. Add `mountAutomationLane` and a DAW track-volume lane with undo and redo. Completed microphone takes create local OPFS recovery checkpoints that can be reopened after a page crash.
- **widgets / DAW demo:** `attachTimeRangeGesture` previews and commits a range on a borrowed timeline surface. The DAW's loop strip selects a beat-based range across the arrangement.
- **DAW demo:** The arrangement mini-map shows the song, playhead and draggable viewport. Audio clip thumbnails redraw at the viewport's zoom, including fine peaks read from visible file-backed sample windows.

- **workspace:** `workspace.player` plugs directly into `mountPlayer` with play, pause, reactive project duration and seek in project seconds.
- **blocks / workspace:** `@audiorective/blocks/effect-rack` owns ordered Filter and PingPongDelay inserts. Project stores rack settings and Workspace applies them after WebCLAP without restarting playback. DAWproject saves the inserts as Audiorective built-in devices. The DAW Devices panel supports adding, reordering, bypass, editing and removal.
- **widgets:** `mountParameter()` provides reactive horizontal, vertical and rotary controls with linear and logarithmic coordinates. `mountLevelMeter()` displays peak and RMS from a borrowed float reader. The DAW uses both in its effect rack.

- **widgets:** Waveform, piano roll, and waveform selector expose the shared `attach(TimeViewPlugin)` interface. Plugins read the view's seconds or beats from `TimeViewPluginContext.timeUnit` and clean up through their own attachment. The waveform selector passes the plugin to its internal waveform. Existing `WaveformPlugin` types remain compatible.

- **workspace:** `TempoMap`, `Project.tempoMap` and `setTempoChanges()` provide step-tempo beat/project-second conversion. DAWproject reads and writes beat-based hold `TempoAutomation`; Workspace rebases Clock on play and seek. `Project.addMidiClip(..., { timeUnit: "beats" })` and `addMidiTake(..., { timeUnit: "beats" })` create beat-locked MIDI notes and ordered control events; existing clips default to seconds. `Project.clipTimeSeconds()` converts a clip boundary for project-second views. The codec writes beat clip lanes and unit-bound private event fingerprints.
- **widgets:** `@audiorective/widgets/arrangement` provides `attachClipGesture()` for snapped clip moves and beat-based keyboard nudges, plus `attachTimelineZoom()` for anchored continuous slider and Ctrl/⌘+wheel zoom over caller-owned views. `ClipGestureOptions.timeUnit` lets gesture input and commits use the clip's native seconds or beats. `PianoRollOptions.timeUnit` labels borrowed model times; `PianoRollViewport` exposes `timeUnit` and `pixelsPerUnit`.
- **core:** `registerWorklet` and `WorkletUnavailableError` are exported from `@audiorective/core`; `@audiorective/effects` still re-exports them. `BufferPlayer.params.loop`, `loopStart` and `loopEnd`, `FilePlayer.params.loop` and `playbackRate`, and `Sampler.params.buffer` and `reverse` are `Param`s; the matching properties (`player.loop`, `sampler.buffer`, ...) read and write them. `FilePlayer.onEnded(cb)` returns a function that removes the callback.
- **effects:** `Equalizer.params.band<i>Frequency`, `band<i>Gain` and `band<i>Q` (zero-based `i`) register each band's Params in `equalizer.params`.
- **blocks:** `PadBank.cells.pads` is a read-only cell of the pad specs.
- **widgets:** `SelectorPlayer` is the structural contract for `mountWaveformSelector`'s `player` and `createPlayer`; `WavePlayer` satisfies it.

### Changed

- **workspace / blocks / host:** Public stateful readers are tracked, so an `effect()`, `computed()` or `useValue` that reads them re-runs on change. `Project.tracks`, `tempoMap`, `markers`, `title`, `MidiClip.time` and `MidiClip.duration` follow `Project` edits; `WavePlayer.buffer`, `duration` and `sourceBuffer` follow `cells.version`. `Workspace.warnings` is a frozen snapshot array (not mutable in place) mirrored by the new `workspace.cells.warnings`; `EffectRack` exposes `cells.effects` behind its `effects` getter; `WebClapHost` exposes `cells.parameterInfo` behind its `parameterInfo` getter.
- **host:** WebCLAP plug-in parameters are reactive `Param<number>`s in `host.params`, keyed by CLAP id as a string (`host.params["7"].value = 0.5`). Plug-in-side changes, such as editor edits, update the same Params without echoing back. `host.parameterInfo` replaces `host.parameters` as the frozen metadata snapshot, and `setParameter(id, value)` is removed. `WebClapHost.load` resolves with `descriptor` and `hasEditor` always set.
- **host / workspace:** `WebClapHost.getState()` / `setState()` are renamed `saveState()` / `loadState()` (opaque CLAP state bytes) so `getState()` stays the name for synchronous block snapshots.
- **blocks:** `AudioRecorder` fills short browser render gaps with silence and reports their absolute frame ranges in optional `dropouts`; a gap beyond two seconds fails the take.
- **workspace:** Streaming DAWproject saves use stored ZIP entries with CRC and size in local headers, and stop before classic ZIP limits. This removes reliance on ZIP data descriptors for large file-backed media.
- **midi:** `MidiRecorder.start()` returns its actual output-clock start time for a Workspace take anchor; existing callers may ignore the return value.
- **workspace:** A running `Workspace` applies light `Project` edits (tempo map, effect rack, device state, mixer, volume automation, clips) automatically, coalesced per microtask and serialized, without reloading hosts. A track/device topology change sets the read-only `workspace.cells.needsSync` and leaves transport and hosts alone until `await workspace.sync()`; light edits wait for it. `workspace.cells.error` holds the latest failed application, and `await workspace.flush()` resolves when pending application is done (rejecting on failure). `save()`, `saveTo()` and `exportAudioFallbackTo()` wait for pending application. There is no `commit()`.
- **midi / blocks / widgets:** MIDI note data, `MidiSequence` and `compileMidiPlaybackEvents` use the pure `@audiorective/midi` entry; browser `MidiRecorder` uses `@audiorective/midi/web`. The unreleased `@audiorective/blocks/midi` entry and blocks-root recorder exports are removed. Piano-roll widgets and the showroom use the new package without changing note editing, recording or audio playback behavior.

- **widgets:** Piano-roll layout frames expose the current `snap` mode. Calling `setSnap` refreshes custom controls synchronously, so externally changed snapping stays visible without duplicating widget state.

- **blocks / widgets:** Rename the unreleased `RangePlayer` to `WavePlayer`, including `WavePlayerOptions`, `WavePlayerSource`, `WavePlayerState`, `WaveStretchProcessor`, `WaveLoadProgress`, and `WaveSourceLoader`, and the destroyed-player messages (`WavePlayer is destroyed.`, `WavePlayer listener failed.`). Consumers use the new names; loading, range playback, stretch and ownership behavior are unchanged.
- **core:** A `bind.get` on a `param()` seeds the initial value (`default` applies when it returns `undefined`).
- **blocks:** `SampleLibrary.state` is the only store of rows, decoded bytes and preview state. `WavePlayer.subscribe` wraps the cells, and `WavePlayer.isPlaying` equals `cells.isPlaying`.
- **widgets:** `attachTimelineZoom` takes `labels.scale(pixelsPerSecond)` for the slider's `aria-valuetext`; the default is English (`<n> px/s`, was Chinese).
- **daw:** The runtime builds track and bus strips from effects `Channel` and `SendBus`. The audible result is unchanged (an offline PCM test compares it with the earlier hand-built strips).

### Added

- **workspace:** `Project.snapshot()`, `Workspace.portabilityReport()` and `Workspace.exportAudioFallbackTo()` provide a separate real-time mix and optional stem WAV ZIP for sharing WebCLAP projects with people who lack the matching CLAP binary. The fallback checks unresolved devices and render dropouts, supports cancellation and uses temporary OPFS media. The DAW demo exposes share guidance and audio export.
- **workspace:** `AudioMediaWriter` accepts streamed recorder chunks into caller-owned storage; `createOpfsAudioMediaWriter` supplies a browser disk-backed target. `Project.addAudioMediaClip` stores frame windows into an `AudioMedia` asset, so split/trim/duplicate avoid whole-take PCM copies. Workspace schedules file-backed audio in two-second chunks and exposes `saveTo(writable)` / `openBlob(blob)` for streamed DAWproject ZIP save and Blob-backed reopen. `save()` remains an in-memory convenience. The DAW demo records to OPFS and uses native streaming file save when available.
- **workspace:** DAWproject import accepts empty standard metadata fields while rejecting nonempty unsupported metadata. A Cubase 14 export probe confirms unsupported track structure, EQ and time-signature automation still reject rather than disappearing on save.
- **workspace:** Track-volume automation now drives a separate native gain stage during playback and seek, preserving mute/solo behavior. Audio clips reuse an `AudioBuffer` while the same clip object remains current. `takeAnchor()` and `takePosition()` map recorder start times to project position with explicit input-latency correction.
- **blocks:** `AudioRecorder.startStream(writeChunk)` and `stopStream()` send ordered PCM chunks to caller-owned storage without retaining a full take; the recorder bounds outstanding writes and returns frame/timing metadata.

- **widgets:** Pure waveform views expose `setAmplitudeZoom(1..32)` and `getAmplitudeZoom()` for display-only waveform height, with the factor available to custom renderers. The DAW demo separates time and wave-height controls and lets users resize the lower editor.
- **workspace:** `Project.splitClip` and `trimClip` edit audio and MIDI clips in clip-local seconds, preserving PCM, overlapping MIDI notes and in-range controller events. The DAW demo adds playhead split/trim controls and session-local clip/note undo and redo.
- **workspace:** Projects can move, duplicate and remove audio/MIDI clips, rename projects/tracks, remove tracks, and store track mute/solo/pan and named section markers in standard DAWproject fields. Workspace applies mixer changes to native audio nodes and refreshes clip-only arrangement edits without reloading WebCLAP hosts. The private DAW demo now offers a shared eight-track arrangement, clip dragging, piano-roll and waveform editor, browser, mixer, device rack, and four switchable skins.
- **host / workspace:** `@audiorective/host/webclap` loads a WebCLAP bundle in an AudioWorklet, schedules cancellable MIDI, bridges its editor and reads/writes opaque CLAP state. `Workspace` adds a browser transport and track graph over `Project`, captures device state on save, and stores CLAP identity/state in DAWProject plus an Audiorective bundle locator. The private DAW demo uses open-webclap Oxo Synth2 as its default instrument.
- **workspace:** New `@audiorective/workspace` package owns a small audio/MIDI project and saves/opens DAWproject 1.0 ZIPs with fixed tempo, seconds-based clips, float32 WAV assets, MIDI notes/controllers and track-volume automation. An Audiorective private entry preserves note IDs and same-time recorded MIDI order for native round trips; changed or missing private detail falls back to standard XML with a warning. Unsupported structures fail on open instead of being silently dropped.
- **midi:** `compileMidiPlaybackEvents(take, sequence)` projects edited notes with the recorded take's non-note MIDI messages in stable same-time order, normalizing sub-nanosecond floating-point differences. Matched raw note messages carry `noteId` for edit and overlap identity; scheduling, instrument choice and clip placement remain caller-owned.
- **midi:** `MidiRecorder` borrows one caller-owned Web MIDI input and a running AudioContext to record raw messages with mapped output-timeline positions. It projects paired note on/off into a take-relative `MidiData` snapshot, preserves controller messages, supports cancellation and leaves live synth playback and take placement to the app.
- **blocks:** `AudioRecorder` captures short PCM takes from a caller-connected Web Audio input using AudioWorklet sample-frame timing. It exposes a read-only recording state, scheduled start/stop, cancellation and repeatable takes; results retain raw audio-clock frame positions for later Track/Clip placement. It owns no microphone permission, monitor route or AudioContext.
- **blocks:** `WavePlayer.attachSourceAutomation(binding)` borrows a finite core automation binding for non-looping playback. The player shares its effective scheduled start, maps committed output selection and stretch into source seconds, invalidates pending starts on selection/stretch edits, and stops the binding on transport and source changes. Detaching releases automation without stopping borrowed playback or destroying the binding.
- **clock / blocks:** Clock tick windows can opt in to event ownership with `window.own(event, when)`; transport changes cancel those handles, while `clock.refresh()` cancels owned events at or after one captured audio time and refills from that same boundary without moving the playhead. A hit exactly at `now` is reissued once. Unowned events retain the existing look-ahead tail. `blocks.PadBank` supplies cancellable sample-hit handles with reversible same-group choke, read-only active-event count, pad reassignment and caller-owned output routing.
- **widgets:** `@audiorective/widgets/player` exports `mountPlayer`, default and custom renderers, `formatTime`, and adapters for `FilePlayer`, `WavePlayer`, and `BufferPlayer`. The view borrows playback state, holds seek gestures against incoming position updates, handles unknown duration and play failures, and releases only its own resources. The same exports are available from the widgets root entry.
- **core:** `ReadonlyCell<T>` and `readonlyCell(source)` — a tracked view with no setter, for state only its owner's methods may change. A processor's `cells` registry accepts `Cell` or `ReadonlyCell`. `batch(fn)` applies several writes as one change; `untracked(fn)` reads without subscribing. `effect` and `computed` are exported from core, so observing state outside a framework binding needs no direct `alien-signals` import. `Readable<T>.$` is typed as a read-only accessor (`() => T`), so `useValue` accepts `ReadonlyCell`; code that wrote through a `Readable`-typed `$` needs the concrete `Param`/`Cell` type. The type declarations use `NoInfer` and need TypeScript 5.4 or later.
- **blocks / midi:** `WavePlayer.cells` (`selection`, `isLooping`, `isPlaying`, `loading`, `loadProgress`, `error`, `processing`, `version`) and `MidiSequence.cells` (`state`, `notes`, `duration`, `selection`, `revision`) expose observable state as read-only cells that effects and `useValue` track. `getState()`, `getSelection()`, `isLooping`, `isPlaying` and MIDI `query()` are tracked reads. Multi-field operations commit as one batch. `subscribe()` is unchanged.
- **blocks:** `WavePlayer.play({ when })` starts playback at an absolute audio time (a past time clamps to now) and resolves with the effective start time, or `null` when it started nothing, so an `AutomationBinding` can share the same `when`. A queued start counts as playing, holds `position` at the start offset, is cancelled by `pause`/`stop`/`load`/stretch commit/`destroy`, and is re-issued at the same `when` by `seek`/`setSelection`/`setLooping`. `play()` without options still starts now; its promise resolves with a number or `null` instead of `void`.

- **core:** Optional `@audiorective/core/automation` entry with immutable reactive `AutomationCurve`, finite audio-clock `AutomationBinding`, and explicit `audioParamTarget`. Supports linear/hold curves, range/time scaling, live reprogramming, native hold/cancel and borrowed-target cleanup without importing blocks or effects.

- **widgets:** `PianoRollOptions.layout` replaces the surrounding keyboard, toolbar and arrangement while retaining the supplied viewport and widget behavior. `onNoteEdit` enables widget-owned move/edge-resize previews, shared beat snap/Alt bypass and single-release model commands; custom note renderers forward `onNotePointerDown` instead of implementing gestures. Source/geometry changes, cancellation and cleanup discard previews. MIDI showroom demonstrates alternate layout/drawing with shared editing.

- **widgets:** `PianoRollHandle.attach(plugin)` accepts the existing `WaveformPlugin` contract for public time coordinates, overlays, viewport/data notifications and attachment-scoped cleanup. Waveform and piano-roll share plugin disposal; detachment and failed attachment preserve peer views, borrowed models and caller audio.

- **midi:** Pure `@audiorective/midi` entry with `parseMidi`, `tickToSeconds`, `midiGrid`, `visibleMidiNotes`, immutable MIDI types and `MidiSequence` for source-time note/selection snapshots and atomic note edits. SMF format0/1 PPQ note projection follows tempo/signature maps without DOM, AudioContext or device permissions.
- **widgets:** Audio-independent `mountPianoRoll` and renderer/model contracts from `@audiorective/widgets/piano-roll`; shared time selection, snap, keyboard handles, independent pitch/zoom/scroll, external playheads and custom note drawing. Views borrow note state and leave audio/synth ownership to the caller. MIDI docs and showroom demonstrate two views and caller-owned range audition.

- **blocks**: `WavePlayer.getState().loadProgress` snapshots via `getState()`/`subscribe()` (download/read bytes, decode, peaks), `cancelLoad()`, and `WavePlayerOptions.loadSource` for shared URL/decode caches. Built-in loading streams bytes, treats unknown/encoded totals as indeterminate, and rejects text or mismatched transfers. Cancelled/stale loads do not publish progress or errors.
- **widgets**: selector loading phases/byte feedback, determinate or indeterminate progress, Cancel loading control and `handle.cancelLoad()`, all driven by the shared player.

- **core:** `summarizePeaks`, `peakFrameRange`, `PCMData` and `PeakSummary` provide raw PCM min/max summaries with source-frame and time metadata. The pure `@audiorective/core/peaks` entry works without DOM or audio runtime imports. Widget reduction uses this shared implementation.
- **effects:** `TimeStretch` renders pitch-preserving PCM in a Worker using a caller-supplied compatible Rubber Band WASM module. The package contains no WASM binary. Uniform duration ratios produce an exact rounded frame count; cancellation and destroy leave original PCM intact. The pure `@audiorective/effects/time-stretch` entry has no audio nodes or wet/dry insert semantics.
- **blocks / widgets:** `WavePlayer(ctx, { stretch })`, `setStretch`, `version`, `sourceBuffer`, and source/output coordinate conversion support non-destructive render-then-commit editing. A committed version publishes audio and core peaks together, stops playback, and maps selection/position. Shared selectors consume committed peaks, expose processing/version state, preserve zoom on same-source edits, and map source beat grids; selection plugins can update their grid with `setGrid`.

- **blocks / widgets:** `@audiorective/blocks` exports headless `WavePlayer` for URL/File/AudioBuffer loading, source-time selection, play/pause/stop/seek and loop audition. `mountWaveformSelector` accepts a shared `player` instead of `context`; views share audio and selection while retaining their own renderers, zoom and snapping. View cleanup leaves a supplied player alive. `createSelectionPlugin({ model })` accepts a structural external selection owner without adding audio imports to the pure waveform entry. Existing context-based selectors create and own a WavePlayer.

- **widgets:** `renderer` on `mountWaveform` and `mountWaveformSelector` replaces waveform drawing with caller-supplied SVG, Canvas, or DOM. A factory mounts once and returns `render(frame)` plus optional `destroy()`. Cached extrema and content dimensions follow data, zoom, and resize changes while the widget retains its linear timeline, selection, plugins, and audio ownership.
- **widgets:** `@audiorective/widgets` provides a framework-independent `mountWaveformSelector` with URL/File loading, range selection, keyboard adjustment, optional beat/downbeat snapping, zoom/scroll, and audition controls. The caller supplies an `AudioContext` and routes `output`; widget destruction leaves that context open. `mountWaveform` and `createSelectionPlugin` are also exported from the audio-independent `@audiorective/widgets/waveform` entry for precomputed peaks, external playheads, metadata-only selection, and custom visual plugins with attachment-owned cleanup. These APIs are unreleased; an installed older npm package does not include them.

### Fixed

- **DAW demo:** Looping a beat-locked clip uses its converted project-second boundaries for playback and the loop readout.
- **workspace:** A cancelled audio clip's late `onended` callback no longer removes a newer handle for the same clip, preventing duplicate playback after rapid seek or replay.

## [2.3.2] - 2026-09-16

### Fixed

- **core:** `AudioEngine`'s state mirror only followed a `running → suspended`
  transition it caused itself, so a raw `context.resume()`/`context.suspend()`
  or Safari's `interrupted` state left `engine.core.state()` stale, and
  `start()`/`suspend()`/`resume()` guarded on that stale mirror instead of the
  real `context.state`. The engine now mirrors every `statechange` (including
  `interrupted` as `"suspended"` and `closed` as `"destroyed"`), and
  `start()`/`resume()` decide from the real context state, so either is
  idempotent even after an external change. (#36)
- **core:** `AudioEngine.destroy()` skipped disposing graphs, processors, and
  effects if the context had already been closed externally (the engine's
  own state mirror follows that closure to `"destroyed"`, and `destroy()`
  used to guard on the same signal). Cleanup completion is now tracked
  separately from the reactive state, so `destroy()` still runs it.

## [2.3.1] - 2026-09-10

### Fixed

- **effects:** the granular `PitchShift` declared its full `windowSize` as
  latency while its signal arrives half a window late (exactly so at pitch 0,
  on average when shifting). It now declares `windowSize / 2`, so plugin
  delay compensation and `perceivedTime` no longer over-delay everything
  aligned to a pad by 50 ms at the default window. Measured by the devtools
  validator at 44.1 and 48 kHz.

## [2.3.0] - 2026-09-09

### Added

- **core:** `Voice` / `Sampler` fades — `fadeIn` and `fadeOut` (seconds) as
  `SamplerOptions` defaults and `TriggerOptions` overrides. A faded `stop()`
  or steal finishes the voice for callers immediately and lets the audio ring
  out; a scheduled `stop(when)` fades from `when`. (#31)
- **core:** `Sampler.reverse` — plays voices backwards from a cached reversed
  copy of `buffer`; `offset`/`duration` still count from the original start.
  `reverseBuffer(buffer)` is exported for callers that need the copy. (#31)
- **core:** `Sampler.params.mute: Param<boolean>` on its own gain stage, so
  muting leaves queued `params.volume` automation intact. (#31)
- **core:** `loadAudioBuffer` and `AudioBufferCache` accept a
  `BaseAudioContext`, so the same loader serves `renderOffline`. (#31)

### Changed

- **core:** `Sampler.trigger` pushes the new voice before stopping a stolen
  one, so `cells.activeVoices` no longer dips to `0` during a retrigger.
  With `polyphony: 1` the cell is a pad's "latest hit is playing" signal. (#31)

## [2.2.1] - 2026-09-09

### Fixed

- **core:** `AudioEngine.perceivedTime` had its sign backwards — it added the
  graph latency and `ctx.outputLatency` to `ctx.currentTime`, giving the
  moment something scheduled now would be heard, while its docs described
  the schedule time the listener is hearing now. It now subtracts both, so a
  visualizer or record-quantize step comparing against it lands with the
  ear instead of leading it by twice the latency. Breaking for anyone who
  consumed the 2.2.0 value; nothing in tree did. (#29)

## [2.2.0] - 2026-09-09

### Added

- **core:** `renderOffline(options, setup)` — builds an `OfflineAudioContext`, awaits an async setup callback, returns the rendered `AudioBuffer`.
- **clock:** `renderTimeline(options, setup)` — `renderOffline` for a `Clock`-driven graph. `setup(ctx, tickSource)` builds the clock on the tick source it is handed; the render is then suspended, ticked, and resumed every `tickInterval` (default 25 ms) so windows keep coming against the context's real `currentTime` instead of starving after the first look-ahead. A `tickInterval` above the clock's `lookAhead` reports misses, as live.
- **core:** `defineGraph` — a declarative, reactive audio graph helper. Edges
  reference nodes and processors directly (`[from, to]`, an options bag for
  multi-channel connections and a debug `label`, or a falsy entry to skip),
  diff against the previous render on every re-run, and connect through a
  processor's `input`/`output`. Available as `this.defineGraph(fn, opts?)`
  (protected, after `super()`) and as the standalone `defineGraph(fn, {
context, compensate? })` for a graph owned by no processor. A bare
  `AudioWorkletNode` is rejected as an edge endpoint — wrap it in an
  `AudioProcessor` that declares its latency.
- **core:** `AudioProcessor.latency: Param<number>` — every processor's
  processing latency in samples, defaulting to `0`. Declared as a fixed
  number, a `Param<number>` (for a latency that changes at runtime), or a
  time-based sample count (`Math.round(0.01 * ctx.sampleRate)`); derived
  automatically from a processor's own `defineGraph` when left undeclared.
  Plugin delay compensation runs on every `defineGraph` re-solve, splicing a
  `DelayNode` into any branch that arrives at a join early so every incoming
  edge lands in step.
- **core:** engine latency queries — `AudioEngine.latency: Param<number>`
  (longest path into `ctx.destination` across every engine-owned graph),
  `AudioEngine.perceivedTime` (`ctx.currentTime` minus the graph latency and
  `ctx.outputLatency` — the schedule time the listener is hearing now), and `AudioEngine.getPathLatency(proc)` (samples from
  a processor's output to the destination). `createEngine`'s setup callback
  gains a second `{ defineGraph }` argument for wiring the root graph; the
  existing one-argument form still works.
- **core:** `LatencyUnknownError` — thrown by `getPathLatency(proc)` when
  `proc` has never appeared in a `defineGraph`, naming the processor instead
  of silently returning `0`.
- **core:** `GraphHandle.snapshot()` and `GraphHandle.idOf(endpoint)` — a
  point-in-time view of a graph's last solve (`GraphSnapshot`: `solveId`,
  `nodes` with `kind`/`label`/`latency`/`arrival`, `edges` with
  `kind`/`compensationSamples`) and the stable id `snapshot()` assigns an
  endpoint, for building diagrams or devtools off the solver's own state.
  `GraphOptions.onSolve` is now documented as a public hook, called with the
  handle after every solve.
- **devtools:** new package, `@audiorective/devtools` — dev-only impulse
  latency validator for `@audiorective/core` processors. `measureLatency`
  renders a single-sample impulse through a processor offline at each
  configured sample rate and reports where it arrives; `assertLatency` checks
  that against the processor's declared `latency` and throws a message that
  carries the `latency: ...` line to paste when it doesn't match.
- **devtools:** `MeasureOptions.ready?: (proc) => Promise<void>` — awaited
  after `build` and before rendering, for a worklet-backed processor that is
  silent until its worklet resolves.
- **effects:** new package, `@audiorective/effects` — the Tone.js
  replacement set. Every effect is an `AudioProcessor` with `input`/`output`,
  a `wet: SchedulableParam` crossfade, and a declared or derived `latency`.
- **effects:** `Filter` — biquad stack with selectable `rolloff` (-12/-24/-48
  dB per octave), `frequency`/`Q`/`gain` as `SchedulableParam`s.
- **effects:** `Distortion` — `WaveShaperNode` with Tone's curve shape
  normalized to unity peak, so `distortion = 0` is exactly unity gain.
- **effects:** `Phaser` — LFO-swept allpass stages per channel, summed with
  the dry input at equal gain to produce the notches.
- **effects:** `FrequencyShifter` — single-sideband shifter built from a
  Hilbert-transform allpass pair, ring-modulated by quadrature oscillators.
- **effects:** `PingPongDelay` — stereo cross-fed delay with alternating
  left/right echoes.
- **effects:** `Convolver` — `ConvolverNode` wrapper with async `load(url)`
  (latest call wins), a `ready` promise, and an `isReady` cell.
- **effects:** `PitchShift` — one param surface over two engines: `"granular"`
  (native delay-line, low latency) and `"stretch"` (Signalsmith Stretch, a
  WASM AudioWorklet with a `ready` promise, an `isReady` cell, and latency
  reported by the node as a live `Param<number>`).
- **effects:** `Compressor` and `Limiter` — a shared worklet-backed dynamics
  core (feedforward gain computer, windowed peak detector over `lookahead`)
  so behavior is identical across browsers and offline renders; both expose
  a `reduction` meter cell. `Limiter` fixes ratio/knee/attack to a brickwall
  preset.
- **effects:** `Channel` — gain → pan → mute strip with post-mute
  `send(bus, name, gain?)` into a `SendBus`; `gain` is linear.
- **effects:** `SendBus` — instance-scoped named receive points a `Channel`
  sends into.
- **effects:** `registerWorklet(ctx, name, source)` — exported so an app can
  pre-warm a worklet module ahead of first use.
- **effects:** `dbToGain(db)` / `gainToDb(gain)` — dB/linear-gain conversion
  helpers for the package's linear gain params.
- **effects:** `Effect` base class exported as the extension point for custom effects.
- **apps:** FX Rack showroom demo — a live effects processor and offline
  export engine built on `@audiorective/effects`: five inserts, two sends,
  compression, and a limiter, sharing one headless `FxRack` class between the
  live UI and the WAV export.

### Changed

- **apps:** the Latency Lab demo is folded into the Step Sequencer: the
  sequencer's `DrumMachine` now feeds the split/limiter/dry `defineGraph`
  (PDC toggle, bypass-by-edge-removal, the runtime-adjustable
  `LookaheadLimiter`, and the graph diagram all live on `/showroom/sequencer`),
  and the step highlight reads the pattern ruler at the time the listener is
  hearing — the render clock minus `engine.latency` and the output latency —
  instead of at `ctx.currentTime`. `DrumMachine` accepts a `tickSource`, so
  the whole machine renders offline through `renderTimeline`; the standalone
  `/showroom/latency-lab` page, its `Beat`/`Click` sources, and its flash row
  are gone.
- **core:** `AudioProcessor.context` widens from `AudioContext` to
  `BaseAudioContext`, so processors can be constructed against an
  `OfflineAudioContext` for offline measurement. Existing code that passes
  `proc.context` where an `AudioContext` is expected needs its own
  `AudioContext` reference, or a cast, at that call site.
- **core:** `Sampler` and `BufferPlayer` constructors widen their `ctx`
  parameter from `AudioContext` to `BaseAudioContext` — neither uses any
  `AudioContext`-only member, so both now build against an
  `OfflineAudioContext` too.

### Fixed

- **core:** an engine-owned graph that stops reaching `ctx.destination` (an
  edge condition turns false, the graph is disposed) drops its contribution
  to `engine.core.latency` instead of leaving the last value it solved.
- **core:** `getPathLatency` now always throws `LatencyUnknownError` for a
  processor that isn't part of the current solve — one dropped from the edge
  list, one whose owning graph was disposed, or one that only feeds an
  `AudioParam` — instead of leaking `defineGraph`'s internal "not present in
  the last solve" error for the first two cases.
- **core:** a processor wired into more than one live graph no longer loses
  `getPathLatency` when one of those graphs disposes or drops it — the
  internal graph registry now keeps one registration per graph a processor
  belongs to (instead of a single entry the most recently solved graph
  overwrote), so `getPathLatency` keeps resolving through whichever
  registration is still live.
- **core:** `AudioEngine` no longer leaks a dead graph handle on every
  dispose-and-rebuild (e.g. each `setPdc` toggle in the Latency Lab demo) —
  a disposed handle now removes itself from the engine's internal graph
  list, and `destroy()` iterates a copy of that list since each `dispose()`
  mutates it mid-loop.
- **devtools:** `measureLatency` destroys each per-sample-rate processor it
  builds after rendering, instead of leaking one `OfflineAudioContext`-scoped
  processor per configured rate.
- **core:** `getPathLatency` no longer fabricates a latency for a processor
  sitting in a disconnected component of the same graph (e.g. a branch that
  feeds nothing reaching the destination, while another branch of the same
  graph does) — it now throws `LatencyUnknownError` for that case instead of
  subtracting two unrelated solved arrivals. `GraphHandle` gains
  `reaches(from, to)` to answer the reachability check.

## [2.1.2] - 2026-08-24

### Added

- **core:** `EngineEnvironmentError` — thrown by the `AudioEngine` constructor
  (and therefore by `createEngine`) when the environment has no `AudioContext`
  constructor, instead of a bare `ReferenceError: AudioContext is not defined`.
  The message names the fix for the environment it landed in: on a server or
  build-time render it points at the client-only boundary
  (`next/dynamic` with `ssr: false`, Astro `client:only`); in a DOM without Web
  Audio (jsdom) it points at passing a context. Supplying one —
  `createEngine(setup, { context })` or `new AudioEngine(ctx)` — never triggers
  it, and the check runs before `setup`, so a failed call leaves no half-built
  graph.

### Changed

- **docs, skill:** audiorective is documented as officially client-only. New
  guide "Server-rendered frameworks" (`docs/client-boundary.md`) covers the
  boundary pattern for Next.js/Remix/Astro, why `'use client'` is not a
  boundary, how to choose the seam, and troubleshooting. The agent skill gained
  a matching top-level rule.

## [2.1.1] - 2026-08-15

### Fixed

- **clock, react, threejs, playcanvas:** these packages declared an exact
  version of `@audiorective/core` (`"2.1.0"` rather than `"^2.1.0"`), so a
  project on a newer core got a second copy of it nested under the binding
  package instead of sharing one. Two copies break `instanceof AudioProcessor`
  inside `AudioEngine` for processors built from the other copy, and give a
  single `AudioContext` two `ParamSync` loops. Upgrading any one binding
  package to 2.1.1 is enough to deduplicate it.

## [2.1.0] - 2026-08-15

### Added

- **clock:** New package `@audiorective/clock` — the timing and scheduling
  engine. `Clock` (worker-based look-ahead tick loop, transport
  start/pause/resume/stop/seek, miss detection via `onMiss`) + `Timeline`
  (beat↔time conversion, anchor, `generation`) + a standalone event-list
  `TempoParam` (V1: steps only; ramp methods throw, reserved for V2) + four
  stateless rulers (`LinearBarRuler`, `CycleBarRuler`, `LinearTimeRuler`,
  `CycleTimeRuler`) with grid iteration, `spans`, and a reactive `current`
  reading for visuals. Looping is expressed as a `CycleBarRuler` reading, not
  transport state — the beat axis never jumps. Linear and cycling rulers yield
  different grid points: linear counts forever (`index`), while a cycle ruler
  folds into its region (`step`, `cycle`) so a pattern's length can be passed
  as the division and `step` indexes it directly. See `docs/clock.md` and
  `docs/superpowers/specs/2026-07-04-clock-design.md`.
- **docs/skill:** `clock.md` — usage guide for the new package; `SKILL.md`
  packages table and read-next table updated accordingly.
- **apps:** `step-sequencer` — a 4-track × 16-step drum machine demoing the
  clock end to end: one `grid(patternLength)` loop over a cycle ruler whose
  region holds exactly one pass of the pattern (so scheduling needs no modulo),
  two rulers stacked on one timeline (`pattern` for scheduling and the
  playhead, `bar` for the absolute position readout), live tempo, transport,
  and live pattern editing, over a headless `DrumMachine` core that is an
  `AudioProcessor` consuming a `Clock`.

### Fixed

- **clock:** `Timeline.addRuler` stored the reading `Param` where the slot
  object belonged, so `timeline.rulers.<key>.current` was `undefined` at
  runtime (an `as unknown as` cast hid it from the type checker). Anything
  binding a UI to a ruler reading would have crashed on mount.
- **clock:** the published `.d.ts` degraded every consumer's ruler readings to
  `unknown` — a method generic named `K` collided with the `[K in keyof
TRulers]` mapped types and the declaration bundler emitted `TRulers[K$1]`.
  Source-level types were always correct, so only a consumer compiling against
  the built package saw it.

## [2.0.0]

### Changed

- **BREAKING — core:** Player taxonomy renamed to split cleanly on source
  (in-memory buffer vs streamed file) and voice model (polyphonic vs single
  playhead). `SoundPlayer` → `Sampler`, `StreamPlayer` → `FilePlayer` (and their
  `SoundPlayerOptions`/`StreamPlayerOptions` types → `SamplerOptions`/
  `FilePlayerOptions`). Update imports accordingly.

### Added

- **core:** `BufferPlayer` (+ `BufferPlayerOptions`) — buffer-backed
  single-playhead deck: sample-accurate `start`/`stop`/`loop` with a schedulable
  `params.rate` for beat-locked loops, stems, and DJ pitch/tempo moves. Its
  source is one-shot, so each `start()` builds a fresh node and re-points the
  stable `params.rate` at it via `SchedulableParam.rebind()`.
- **core:** `SchedulableParam.rebind()` — re-point a stable param at a freshly
  built source node, so a single reactive reference survives node rebuilds while
  scheduled automation always lands on the live source.
- **core:** `Analyser` (+ `AnalyserOptions`) — an `AudioProcessor` wrapping an
  `AnalyserNode` as a pass-through tap. Exposes `readFrequencies`/`readWaveform`
  with `createFrequencyBuffer`/`createWaveformBuffer` and `binCount`/`fftSize`,
  for audio visualizers. Poll it from a render loop, not an `effect()`.
- **docs/skill:** `choosing-playback.md` — decision flow plus per-primitive
  use/avoid and common mistakes for `Sampler`, `BufferPlayer`, and `FilePlayer`.
- **docs/skill:** `pixijs.md` — guide for pairing PixiJS with audiorective. No
  binding package is needed; core + `alien-signals` cover it. Documents the boot
  one-liner, the `effect`-vs-`ticker` decision, and the worked example
  `apps/pixi-visualizer`.

### Fixed

- **core:** `BufferPlayer.loop` setter now reapplies the loop window when toggled
  mid-play.

## [1.2.0]

### Added

- **core:** `SoundPlayer` — buffer-backed, polyphonic pad. `trigger()` returns a
  `Voice` for SFX and one-shots.
- **core:** `StreamPlayer` — streaming track with a single play/pause/seek
  transport, for music and long-form audio.
- **core:** `Voice` (+ `VoiceOptions`) — per-trigger handle spawned by
  `SoundPlayer`.
- **core:** `loadAudioBuffer` + `AudioBufferCache` — fetch/decode helper with an
  explicit-lifetime buffer cache.
- **core:** `AudioProcessor.input` convention for effect-style processors.
- **playcanvas:** new package `@audiorective/playcanvas` — PlayCanvas scene
  bindings (`attach`, `bindPanner`).

### Changed

- **core:** `SoundPlayer` slimmed to a polyphonic pad — the song-style player
  transport (`play`/`pause`/`resume`/`seek`) moved to the new `StreamPlayer`.
  Code that drove a track through `SoundPlayer`'s transport must move to
  `StreamPlayer`.

## [1.1.2]

Baseline for this changelog. Earlier history lives in the git log.
