# @audiorective/blocks

Headless audio blocks for Audiorective, imported by subpath (`/player`, `/recorder`, `/samples`, `/pads`, `/sequencer`, `/launcher`); there is no root entry and each subpath imports only `@audiorective/core`. `WavePlayer` loads audio, selects ranges in the committed output timeline, and handles play/pause/seek/loop audition without DOM dependencies. It reuses core's `BufferPlayer` and works alone or with waveform widgets.

`AudioRecorder` captures short PCM takes from a caller-connected input through an AudioWorklet. It returns actual AudioContext start/end sample frames; the caller owns microphone permission, monitor routing, latency calibration and take placement. See [Record an audio take](../../docs/blocks.md#record-an-audio-take).

`getState().loadProgress` reports download/read bytes, decode and peaks; `subscribe` observes changes and `cancelLoad()` cancels the active load. Unknown totals remain indeterminate. `options.loadSource` can reuse a URL/decode cache while the block owns loading, errors and stale-result guards.

Pass `new WavePlayer(context, { stretch })` to borrow an offline processor such as `TimeStretch` from `@audiorective/effects/time-stretch`. `await player.setStretch(ratio)` always renders the original `sourceBuffer`, then stops playback and commits one `version` containing matching buffer, peaks and revision metadata. Pending or failed edits retain the old playable version; the latest edit wins. Ratio 1 restores the original without a processor.

Selections and position use committed output seconds; `sourceToOutput` and `outputToSource` map original source seconds. Metadata is frozen; treat borrowed source buffers and peak arrays as immutable. The caller owns the AudioContext and stretch processor, routes output, and destroys views before the player and processor. See [Blocks documentation](../../docs/blocks.md) for state notifications, shared-view ownership and cleanup.

See the [complete stretch-and-selector example](../../docs/blocks.md#compose-offline-stretch-and-a-selector) for caller-hosted WASM, URL/File errors and cleanup.
