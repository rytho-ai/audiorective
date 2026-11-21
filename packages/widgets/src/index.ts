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
export type { WarpMarkerOptions } from "./warp-markers";
export { attachClipGesture, attachTimeRangeGesture, attachTimelineZoom } from "./arrangement";
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
export { mountClipGrid } from "./clip-grid";
export type { ClipGridClip, ClipGridLauncher, ClipGridLayout, ClipGridOptions, ClipGridTrack } from "./clip-grid";
export { mountMixer } from "./mixer";
export type { MixerOptions, MixerState, MixerStrip } from "./mixer";
export { mountSampleBrowser } from "./sample-browser";
export type { SampleBrowserOptions } from "./sample-browser";
export { mountStepGrid } from "./step-grid";
export type * from "./step-grid-types";
export { mountPadGrid } from "./pad-grid";
export type { PadControl, PadGridOptions } from "./pad-grid";
export { mountEqEditor, mountSpectrum } from "./frequency-plot";
export type { EqBand, EqEditorOptions, FrequencyRange, SpectrumOptions } from "./frequency-plot";
export { mountClipEnvelopeEditor } from "./clip-envelope-editor";
export type { ClipEnvelopeEditorOptions } from "./clip-envelope-editor";
