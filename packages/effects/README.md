# @audiorective/effects

DSP effects for audiorective — filter, distortion, phaser, frequency shifter, ping-pong delay, convolver, compressor, limiter, ducker, pitch shift, effect chain, channel strip and send bus. See [docs/effects.md](../../docs/effects.md) for details. Install with `pnpm add @audiorective/effects @audiorective/core`.

`Ducker` ducks one signal under another (`kick.connect(ducker.sidechain)`). `EffectChain` orders any effects and edits them click-free while audio plays. Every effect has `params.bypass`, `cells.status` and ramped param writes.

`TimeStretch` is a separate offline processor: `AudioBuffer` in, `AudioBuffer` out. Import it from `@audiorective/effects/time-stretch` without evaluating the live audio-runtime implementations. `await TimeStretch.load({ wasmUrl })` fetches and compiles a `rubberband-wasm3.3` build once per URL; the package includes no Rubber Band WASM or third-party GPL wrapper binary. The application hosts that file.

```typescript
import { TimeStretch } from "@audiorective/effects/time-stretch";

async function render(buffer: AudioBuffer, signal: AbortSignal) {
  const stretch = await TimeStretch.load({ wasmUrl: "/wasm/rubberband.wasm" });
  try {
    return await stretch.process(buffer, { ratio: 1.5, signal }); // ratio = output length / input length
  } finally {
    stretch.dispose();
  }
}
```

Processing uses Web Workers and an offline two-pass render. It preserves pitch, returns exactly `Math.round(input.length * ratio)` frames, and transfers private input copies. `loop: true` makes the result loop seamlessly. Calls can run concurrently; every cancellation (`{ signal }` or `dispose()`) rejects with an `AbortError`. This class has no context, audio nodes, input/output connections or wet parameter.

See the [TimeStretch contract](../../docs/effects.md#timestretch) and [WavePlayer/selector composition](../../docs/player.md#compose-offline-stretch-and-a-selector) for validation, module loading and cleanup.
