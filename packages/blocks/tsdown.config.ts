import { defineConfig } from "tsdown";
export default defineConfig({
  entry: {
    player: "src/WavePlayer.ts",
    recorder: "src/AudioRecorder.ts",
    samples: "src/SampleLibrary.ts",
    "instrument-events": "src/InstrumentEvents.ts",
    sequencer: "src/StepSequencer.ts",
    launcher: "src/ClipLauncher.ts",
  },
  format: "esm",
  dts: true,
});
