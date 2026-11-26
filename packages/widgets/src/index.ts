/** Waveform selectors plus audio-independent waveform and piano-roll views. */
export { mountWaveformSelector } from "./selector";
export { mountWaveform } from "./waveform";
export { createSelectionPlugin } from "./selection";
export type * from "./types";
export { mountPianoRoll } from "./piano-roll";
export { pianoRollModel, type PianoRollModelOptions, type ClipPianoRollModel } from "./piano-roll-model";
export type * from "./piano-roll-types";
export * from "./player";
export * from "./parameter";
export * from "./level-meter";
export * from "./automation-lane";
export { createAutomationOverlay } from "./automation-overlay";
export type { AutomationOverlayOptions } from "./automation-overlay";
export { createWarpMarkers } from "./warp-markers";
export type { WarpMarkerOptions, WaveStretchAnchor } from "./warp-markers";
export { attachClipGesture } from "./clip";
export { attachTimeRangeGesture, attachTimelineZoom } from "./arrangement";
export type {
  ArrangementTimeMap,
  ClipGestureHandle,
  ClipGestureOptions,
  ClipMove,
  TimeRangeGestureOptions,
  TimelineRange,
  TimelineZoomHandle,
  TimelineZoomOptions,
} from "./arrangement";
export { mountBarRuler } from "./bar-ruler";
export type { BarRulerHandle, BarRulerOptions, BarRulerTempoMap } from "./bar-ruler";
export { attachClipWaveform, attachClipTrim } from "./clip";
export type { ClipWaveformSource, ClipWaveformOptions, ClipWaveformHandle, ClipTrimEdge, ClipTrimOptions, ClipTrimHandle } from "./clip";
export { mountClipGrid } from "./clip-grid";
export type { ClipGridClip, ClipGridLauncher, ClipGridLayout, ClipGridOptions, ClipGridTrack } from "./clip-grid";
export { mountMixer } from "./mixer";
export type { MixerMeter, MixerOptions, MixerState, MixerStrip, MixerStripSettings } from "./mixer";
export { mountSampleBrowser } from "./sample-browser";
export type { SampleBrowserOptions, SampleBrowserState, SampleRow } from "./sample-browser";
export { mountStepGrid } from "./step-grid";
export { stepGridModel } from "./step-grid-model";
export type { StepGridModel, StepGridModelOptions, StepGridNoteSource } from "./step-grid-model";
export type * from "./step-grid-types";
export { mountPadGrid } from "./pad-grid";
export type { PadControl, PadGridOptions } from "./pad-grid";
export { mountEqEditor, mountSpectrum } from "./frequency-plot";
export type { EqBand, EqEditorOptions, FrequencyRange, SpectrumOptions } from "./frequency-plot";
export { mountClipEnvelopeEditor } from "./clip-envelope-editor";
export type { ClipEnvelope, ClipEnvelopeEditorOptions } from "./clip-envelope-editor";
