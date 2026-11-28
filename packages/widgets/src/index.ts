/** Waveform selectors plus audio-independent waveform and piano-roll views. */
export { mountWaveformSelector } from "./selector";
export type {
  MountWaveformSelector,
  PluginAttachment,
  PluginTarget,
  SelectorPlayer,
  SelectorVersion,
  TimeViewPlugin,
  TimeViewPluginContext,
  WaveformPlugin,
  WaveformPluginContext,
  WaveformSelectorHandle,
  WaveformSelectorOptions,
  WaveformSelectorState,
  WidgetPlugin,
  WidgetPluginContext,
} from "./types";
export * from "./parameter";
export * from "./level-meter";
export * from "./automation-lane";
export { createAutomationOverlay } from "./automation-overlay";
export type { AutomationOverlayOptions } from "./automation-overlay";
export { createWarpMarkers } from "./warp-markers";
export type { WarpMarkerOptions, WaveStretchAnchor } from "./warp-markers";
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
