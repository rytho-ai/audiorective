# DAWproject test files

Small files used by `tests/dawproject-samples.test.ts`. None is written by this package.

| File                                                                                                                    | Written by                                                                            | Source and licence                                                                                                                                                                                                   |
| ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schema/Project.xsd`, `schema/MetaData.xsd`                                                                             | Bitwig (official schemas)                                                             | https://github.com/bitwig/dawproject, MIT                                                                                                                                                                            |
| `bitwig-readme/project.xml`                                                                                             | Bitwig Studio 5.0                                                                     | the example `project.xml` in https://github.com/bitwig/dawproject README, MIT (XML only; the test adds an empty `metadata.xml`)                                                                                      |
| `bitwig-5.3-canon-in-d.dawproject`                                                                                      | Bitwig Studio 5.3.13                                                                  | https://github.com/gmlewis/canon-in-d (`CanonInD.dawproject`), Apache-2.0: two Vst3 piano tracks, a bus, CC lanes, tempo automation, eight scenes                                                                    |
| `bitwig-5.3-sugar-plum-celesta.dawproject`                                                                              | Bitwig Studio 5.3.13                                                                  | https://github.com/gmlewis/dance-of-the-sugar-plum-fairy (`DanceOfTheSugarPlumFairy-Celesta.dawproject`), Apache-2.0: a built-in device, a marker, time-signature automation                                         |
| `ts-features.dawproject`, `ts-cc1-in-clips.dawproject`, `ts-pitchbend-on-track.dawproject`, `ts-audio-mixer.dawproject` | `dawproject-typescript` 1.0.7 (https://github.com/perivar/dawproject-typescript, MIT) | generated for this repository by a maintainer script kept outside this repository (the library's own example projects, plus an audio project with 16-bit and float WAV, EQ, compressor, a send and track automation) |

A public Cubase 14 export (Steinberg forum, https://forums.steinberg.net/t/import-and-export-of-media-projects-and-dawprojects/1010846) is checked by `pnpm --filter @audiorective/daw probe:cubase`, which downloads it and verifies its SHA-256; it is not stored here because its licence is not stated.

## Bitwig Studio 6.1.7 audio clips

Made by the maintainer in Bitwig Studio 6.1.7 (licensed) from content generated for this repository; licence: the same as the repository. Used by `tests/dawproject-nested-audio.test.ts` and `tests/dawproject-nested-audio.browser.test.ts`. The scripts and report that made them belong to the maintainer probe `bitwig-roundtrip-001` (kept outside this repository).

| File                         | Written by          | Content                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ---------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `b-bitwig-native.dawproject` | Bitwig Studio 6.1.7 | a project made in Bitwig with a 4 s mono 44.1 kHz 24-bit click recording (clicks at 0.5, 1.5, 2.5 and 3.5 s, 3 KB zipped) on one audio track placed at beat 1, 3 MIDI notes, tempo 100 and a built-in delay. Bitwig stretched the clip to 8 beats (a 120 BPM loop at 100 BPM), so its `Warps` are not the identity until the tempo is 120                                                                                                                                       |
| `a-bitwig-export.dawproject` | Bitwig Studio 6.1.7 | this repository's song (built by a maintainer probe script kept outside this repository: tempo 100 then 130 at beat 32, a meter change, markers, scenes, four audio clips with fades, gain 0.5 and 0.7, a 1.5 to 4.5 s trim, two MIDI tracks) after Bitwig moved one clip (2.4 s to beat 12) and exported it. 502 KB: the four sine recordings are 4, 6, 3 and 4 s, kept whole so the clips' windows are the ones written; the `audiorective/` sidecar is gone, Bitwig drops it |

The browser test and one node test open `b-bitwig-native.dawproject` with its tempo changed from 100 to 120 BPM (two attributes in `project.xml`, edited in the test) to get Warps that are the identity.

## Bitwig Studio 6.1.7 controller lanes

Made by the maintainer in Bitwig Studio 6.1.7 (licensed); licence: the same as the repository. Used by `tests/dawproject-controller-lanes.test.ts`. Script and report: maintainer probe `bitwig-roundtrip-001`, section E (kept outside this repository).

| File                                       | Written by          | Content                                                                                                                                                                                                                                                                               |
| ------------------------------------------ | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bitwig-6.1.7-controller-lanes.dawproject` | Bitwig Studio 6.1.7 | this repository's rich MIDI song (6 MIDI tracks, tempo 96) after CC64, Modulation (CC1) and Pitch Bend were drawn on the Keys track and the project was exported as DAWproject: three `Points unit="normalized"` beside the track's `Clips`, 14 `RealPoint`s in absolute beats (4 KB) |

## Studio One quirks (synthetic)

Written for this repository with `fflate` from the structure a PreSonus Studio One 7.0.2 export has (attribute order, `<Project version="0.1">`, a `Track` of `contentType="tracks"` holding the master `Channel`, notes without `channel`); licence: the same as the repository. One quirk per file, used by `tests/dawproject-studio-one.test.ts`. The real export (27.7 MB, PreSonus demo song "Get Some Air", from https://github.com/zarfld/dawproject_c, GPL-3.0 repository, PreSonus copyright) is not stored here: `pnpm --filter @audiorective/daw probe:studio-one` downloads it and checks its SHA-256.

| File                                          | Quirk                                                                                         |
| --------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `studio-one-version-0.1.dawproject`           | `<Project version="0.1">`                                                                     |
| `studio-one-metadata-entity.dawproject`       | `&copy;` and `&mdash;` in `metadata.xml`                                                      |
| `studio-one-negative-note.dawproject`         | a clip with a note at `time="-0.001269"` beside a clip without one                            |
| `studio-one-note-without-channel.dawproject`  | `<Note>` without `channel`                                                                    |
| `studio-one-volume-step.dawproject`           | a volume lane with two points at one time (a dip: 0.7 to 0 at beat 8, back to 0.7 at beat 12) |
| `studio-one-clip-without-duration.dawproject` | an audio `Clip` with `playStart` and `playStop` and no `duration` (a 10 ms WAV)               |

## Bitwig Studio 6.1.7 point interpolation

Made by the maintainer in Bitwig Studio 6.1.7 (licensed) from a song this repository built; licence: the same as the repository. Used by `tests/dawproject-point-interpolation.test.ts`, `tests/dawproject-nested-gain-curve.test.ts` and `tests/dawproject-nested-gain-curve.browser.test.ts` (its clip gain curve is Bitwig's nested form). Script and report: maintainer probe `bitwig-roundtrip-001`, section F (kept outside this repository).

| File                                    | Written by          | Content                                                                                                                                                                                                                                                                                       |
| --------------------------------------- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bitwig-6.1.7-interpolation.dawproject` | Bitwig Studio 6.1.7 | two audio tracks with a 12 s sine each; the first has a volume curve (0.2 held, a jump to 0.8 at 4 s, a ramp to 0.5 at 8 s), the second the same curve as clip gain, and the project has a tempo step 120 to 90 at beat 32. Bitwig writes every point `linear` and a hold as a repeated value |

## Audiorective legacy interpolation

Written by this repository's own writer at commit 278ee19 (`audiorective/state.json` version 3, where a point's `interpolation` is the model's `shape`, how the value leaves it) from a small song: 1 s of 440 Hz at 8 kHz with a mixed hold/linear clip gain curve, a mixed volume curve, and a MIDI clip with pedal and mod-wheel events. Made by the maintainer's tooling for this repository; licence: the same as the repository. Used by `tests/dawproject-legacy-interpolation.test.ts`.

| File                                                   | Written by                     | Content                                                                                                   |
| ------------------------------------------------------ | ------------------------------ | --------------------------------------------------------------------------------------------------------- |
| `audiorective-legacy-leaving-interpolation.dawproject` | Audiorective writer of 278ee19 | tracks `Voice` (clip `Tone` with gain points, volume points) and `Keys` (clip `Pedal`); sidecar version 3 |
