# @audiorective/blocks

Headless audio blocks for Audiorective. `WavePlayer` loads audio, selects ranges in the committed output timeline, and handles play/pause/seek/loop audition without DOM dependencies. It reuses core's `BufferPlayer` and works alone or with waveform widgets.

`getState().loadProgress` reports download/read bytes, decode and peaks; `subscribe` observes changes and `cancelLoad()` cancels the active load. Unknown totals remain indeterminate. `options.loadSource` can reuse a URL/decode cache while the block owns loading, errors and stale-result guards.

Pass `new WavePlayer(context, { stretch })` to borrow an offline processor such as `TimeStretch` from `@audiorective/effects/time-stretch`. `await player.setStretch(ratio)` always renders the original `sourceBuffer`, then stops playback and commits one `version` containing matching buffer, peaks and revision metadata. Pending or failed edits retain the old playable version; the latest edit wins. Ratio 1 restores the original without a processor.

Selections and position use committed output seconds; `sourceToOutput` and `outputToSource` map original source seconds. Metadata is frozen; treat borrowed source buffers and peak arrays as immutable. The caller owns the AudioContext and stretch processor, routes output, and destroys views before the player and processor. See [Blocks documentation](../../docs/blocks.md) for state notifications, shared-view ownership and cleanup.

See the [complete stretch-and-selector example](../../docs/blocks.md#compose-offline-stretch-and-a-selector) for caller-hosted WASM, URL/File errors and cleanup.

## MIDI data

`@audiorective/blocks/midi` exports `MidiSequence`, `parseMidi`, `midiGrid`, `tickToSeconds` and `visibleMidiNotes`. They work without DOM or AudioContext. One sequence owns immutable notes and a shared source-time selection; piano-roll views borrow it. Parsing accepts SMF format0/1 PPQ note data; it is not a transport, synth, lossless MIDI editor or Web MIDI device connection. See [MIDI and Piano Roll](../../docs/midi.md).
