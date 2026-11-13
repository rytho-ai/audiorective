# @audiorective/effects

DSP effects for audiorective — filter, distortion, phaser, frequency shifter, ping-pong delay, convolver, compressor, limiter, pitch shift, channel strip and send bus. See [docs/effects.md](../../docs/effects.md) for details. Install with `pnpm add @audiorective/effects @audiorective/core`.

`TimeStretch` is a separate data-only offline processor. Import it from `@audiorective/effects/time-stretch` without evaluating the live audio-runtime implementations. Construct it with a caller-supplied compiled `WebAssembly.Module` implementing the `rubberband-wasm3.3` C ABI; the package includes no Rubber Band WASM or third-party GPL wrapper binary. The application obtains, hosts and compiles that module.

```typescript
import { TimeStretch } from "@audiorective/effects/time-stretch";
import type { PCMData } from "@audiorective/core/peaks";

async function render(pcm: PCMData, module: WebAssembly.Module) {
  const stretch = new TimeStretch(module);
  try {
    return await stretch.process(pcm, { ratio: 1.5 });
  } finally {
    stretch.destroy();
  }
}
```

Processing uses Web Workers and an offline two-pass render. It preserves pitch, returns exactly `Math.round(inputFrames * ratio)` frames per channel, and transfers private input copies. Calls can run concurrently; `{ signal }` aborts one job, and `destroy()` cancels pending jobs. This class has no context, audio nodes, input/output connections or wet parameter.

See the [TimeStretch contract](../../docs/effects.md#timestretch) and [RangePlayer/selector composition](../../docs/blocks.md#compose-offline-stretch-and-a-selector) for validation, module loading and cleanup.
