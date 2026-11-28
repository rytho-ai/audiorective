/** Scoped default presentation; host themes by setting --waveform-accent on root. */
export const styles = `
.ar-widget { --ar-accent:var(--waveform-accent,#3c99ff); font:var(--waveform-font,14px/1.45 system-ui,sans-serif); color:var(--waveform-foreground,#e8edf4); background:var(--waveform-background,#141b25); border:1px solid var(--waveform-border,#344154); border-radius:12px; padding:16px; box-sizing:border-box; min-width:0; }
.ar-selector .ar-waveform { padding:0; border:0; border-radius:0; background:transparent; }
.ar-widget * { box-sizing:border-box; }
.ar-widget button,.ar-widget input,.ar-widget select { font:inherit; color:inherit; background:var(--waveform-control-background,#202c3c); border:1px solid var(--waveform-control-border,#4c6078); border-radius:6px; padding:7px 10px; min-height:36px; }
.ar-widget button { cursor:pointer; }
.ar-widget button:hover { border-color:var(--ar-accent); }
.ar-widget button:disabled { opacity:.45; cursor:default; }
.ar-widget :focus-visible { outline:2px solid var(--ar-accent); outline-offset:2px; }
.ar-widget button[aria-pressed=true] { background:var(--ar-accent); color:#08111d; }
.ar-source,.ar-toolbar,.ar-footer { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
.ar-source input[type=url] { flex:1 1 220px; min-width:100px; }
.ar-source label { display:flex; align-items:center; gap:8px; max-width:100%; }
.ar-source input[type=file] { max-width:250px; width:100%; }
.ar-toolbar { margin:14px 0 10px; }
.ar-help { font-size:12px; color:var(--waveform-muted,#a3b4ca); margin:8px 0; }
.ar-viewport { overflow-x:auto; overflow-y:hidden; width:100%; background:var(--waveform-surface,#0b121c); border:1px solid var(--waveform-border,#344154); border-radius:6px; scroll-behavior:auto; }
.ar-track { position:relative; min-width:100%; }
.ar-ruler { height:28px; position:relative; color:var(--waveform-muted,#9dafc4); border-bottom:1px solid var(--waveform-border,#344154); overflow:hidden; pointer-events:none; }
.ar-tick { position:absolute; top:0; height:100%; border-left:1px solid var(--waveform-border,#344154); padding:4px 0 0 4px; font-size:10px; white-space:nowrap; }
.ar-wave { position:relative; height:var(--waveform-height,180px); touch-action:pan-y; cursor:crosshair; user-select:none; }
.ar-drawing { position:absolute; inset:0; overflow:hidden; pointer-events:none; }
.ar-wave svg { display:block; width:100%; height:100%; pointer-events:none; }
.ar-peaks { stroke:var(--ar-accent); stroke-width:1.3; opacity:.8; }
.ar-center { stroke:#26374c; stroke-width:1; }
.ar-selection { position:absolute; top:0; height:100%; background:var(--waveform-selection-background,color-mix(in srgb,var(--ar-accent) 24%,transparent)); border-top:2px solid var(--ar-accent); border-bottom:2px solid var(--ar-accent); pointer-events:none; }
.ar-grip { position:absolute; top:0; height:100%; width:18px; padding:0!important; min-height:0!important; border:0!important; border-radius:0!important; background:transparent!important; cursor:ew-resize!important; touch-action:none; z-index:3; }
.ar-grip::before { content:''; position:absolute; left:clamp(0px,calc(var(--ar-grip-boundary,9px) - 1px),16px); top:0; height:100%; width:2px; background:var(--ar-accent); }
.ar-grip::after { content:''; position:absolute; left:clamp(0px,calc(var(--ar-grip-boundary,9px) - 5px),8px); top:calc(50% - 16px); width:10px; height:32px; border:2px solid var(--ar-accent); border-radius:4px; background:#172638; }
.ar-playhead { position:absolute; top:0; height:100%; width:2px; background:var(--waveform-playhead,#fff); pointer-events:none; z-index:4; }
.ar-footer { justify-content:space-between; color:var(--waveform-muted,#baccdf); font-variant-numeric:tabular-nums; margin-top:10px; }
.ar-widget progress { accent-color:var(--ar-accent); max-width:100%; }
.ar-status { min-height:20px; margin-top:6px; }
.ar-error { color:var(--waveform-error,#ffb7b7); }
.ar-widget [hidden] { display:none!important; }
.ar-snap { margin-left:auto; display:flex; gap:6px; align-items:center; }
@media(max-width:480px) { .ar-widget {padding:10px;} .ar-source label {width:100%;} .ar-source input[type=file] {max-width:none;} .ar-toolbar {gap:6px;} .ar-widget button {padding:6px 8px;} .ar-wave {height:var(--waveform-height,160px);}  .ar-snap {margin-left:0;} }
`;
