# @audiorective/player

Headless range playback for Audiorective. `WavePlayer` loads audio, selects ranges in the committed output timeline, and handles play/pause/seek/loop audition without DOM dependencies. It reuses core's `BufferPlayer` and works alone or with waveform widgets. Depends only on `@audiorective/core`.

`getState().loadProgress` reports download/read bytes, decode and peaks; `subscribe` observes changes and `cancelLoad()` cancels the active load. Unknown totals remain indeterminate. `options.loadSource` can reuse a URL/decode cache while the player owns loading, errors and stale-result guards.

Pass `new WavePlayer(context, { stretch })` to borrow an offline processor such as `TimeStretch` from `@audiorective/effects/time-stretch`. `await player.setStretch(ratio)` always renders the original `sourceBuffer`, then stops playback and commits one `version` containing matching buffer, peaks and revision metadata. Pending or failed edits retain the old playable version; the latest edit wins. Ratio 1 restores the original without a processor.

Selections and position use committed output seconds; `sourceToOutput` and `outputToSource` map original source seconds. Metadata is frozen; treat borrowed source buffers and peak arrays as immutable. The caller owns the AudioContext and stretch processor, routes output, and disposes views before the player and processor. See the [player documentation](../../docs/player.md) for state notifications, shared-view ownership and cleanup, and the [complete stretch-and-selector example](../../docs/player.md#compose-offline-stretch-and-a-selector).
