/**
 * Default presentation of the step grid. Every colour and size is a `--ar-step-*` custom property
 * with a neutral fallback, so a page themes it by setting properties on the root or any ancestor.
 */
export const stepGridStyles = `
.ar-step-grid { --ar-sg-cols:minmax(0,1fr) 24px 24px 40px 54px 30px 46px; font:var(--ar-step-font,13px/1.35 system-ui,sans-serif); color:var(--ar-step-color,#e6e6e6); background:var(--ar-step-background,#1d1f23); border:1px solid var(--ar-step-border,#3a3d44); border-radius:var(--ar-step-radius,8px); padding:var(--ar-step-padding,12px); box-sizing:border-box; min-width:0; container-type:inline-size; container-name:ar-step-grid; }
.ar-step-grid * { box-sizing:border-box; }
.ar-step-grid [hidden] { display:none!important; }
.ar-sg-scroll { --ar-sg-head:var(--ar-step-header-width,340px); --ar-sg-cw:var(--ar-step-cell-min-width,26px); --ar-sg-gap:var(--ar-step-cell-gap,4px); --ar-sg-bar:var(--ar-step-bar-gap,8px); overflow-x:auto; padding-bottom:4px; }
.ar-sg-surface { position:relative; min-width:calc(var(--ar-sg-head) + var(--ar-sg-size,16) * (var(--ar-sg-cw) + var(--ar-sg-gap)) + (var(--ar-sg-size,16) / 4) * var(--ar-sg-bar)); }
.ar-sg-top { display:grid; grid-template-columns:var(--ar-sg-head) minmax(0,1fr); align-items:end; margin-bottom:4px; }
.ar-sg-colhead { display:grid; grid-template-columns:var(--ar-sg-cols); gap:4px; padding-right:8px; }
.ar-sg-colname { text-align:center; font-size:10px; letter-spacing:.06em; text-transform:uppercase; color:var(--ar-step-column-color,var(--ar-step-muted,#9a9ea8)); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.ar-sg-timeline { min-width:0; }
.ar-sg-ruler,.ar-sg-cells { display:flex; gap:var(--ar-sg-gap); min-width:0; }
.ar-sg-ruler { color:var(--ar-step-column-color,var(--ar-step-muted,#9a9ea8)); font-size:10px; height:14px; line-height:14px; }
.ar-sg-tick { flex:1 1 0; min-width:var(--ar-sg-cw); white-space:nowrap; overflow:visible; padding-left:2px; }
.ar-sg-tick[data-bar=true],.ar-sg-cell[data-bar=true] { margin-left:var(--ar-sg-bar); }
.ar-sg-tick[data-first=true],.ar-sg-cell[data-first=true] { margin-left:0; }
.ar-sg-progress { height:var(--ar-step-progress-height,3px); margin-top:2px; border-radius:2px; overflow:hidden; background:var(--ar-step-progress-track,transparent); }
.ar-sg-progress-fill { height:100%; width:0; background:var(--ar-step-progress,#d0a64a); }
.ar-sg-lanes { display:flex; flex-direction:column; gap:var(--ar-step-lane-gap,4px); }
.ar-sg-lane { display:grid; grid-template-columns:var(--ar-sg-head) minmax(0,1fr); height:var(--ar-step-cell-height,40px); }
.ar-sg-head { display:grid; grid-template-columns:var(--ar-sg-cols); gap:4px; align-items:stretch; padding-right:8px; min-width:0; }
.ar-sg-name { display:flex; align-items:center; min-width:0; padding:0 10px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-weight:600; border-radius:var(--ar-step-control-radius,4px); background:var(--ar-step-header-background,#3a3d44); color:var(--ar-step-name-color,var(--ar-step-header-color,#e6e6e6)); }
.ar-step-grid button,.ar-step-grid input,.ar-step-grid select,.ar-sg-box { font:inherit; font-size:12px; color:var(--ar-step-box-color,var(--ar-step-control-color,inherit)); background:var(--ar-step-box-background,var(--ar-step-control-background,#2a2d33)); border:1px solid var(--ar-step-box-border,var(--ar-step-control-border,#454953)); border-radius:var(--ar-step-control-radius,4px); padding:1px 6px; min-height:22px; margin:0; }
.ar-step-grid button { cursor:pointer; }
.ar-step-grid button:focus-visible,.ar-step-grid select:focus-visible,.ar-sg-box:focus-visible { outline:2px solid var(--ar-step-focus,#4a9eff); outline-offset:1px; }
.ar-sg-head button { padding:0; height:100%; }
.ar-sg-mute[aria-pressed=true] { background:var(--ar-step-mute-active-background,var(--ar-step-control-active-background,#d0a64a)); color:var(--ar-step-mute-active-color,var(--ar-step-control-active-color,#16171a)); border-color:transparent; }
.ar-sg-solo[aria-pressed=true] { background:var(--ar-step-solo-active-background,var(--ar-step-control-active-background,#d0a64a)); color:var(--ar-step-solo-active-color,var(--ar-step-control-active-color,#16171a)); border-color:transparent; }
.ar-sg-mute,.ar-sg-solo { font-size:11px; font-weight:600; }
.ar-sg-box { display:flex; align-items:center; justify-content:center; height:100%; padding:0 2px; cursor:ns-resize; user-select:none; touch-action:none; font-variant-numeric:tabular-nums; }
.ar-sg-box[data-editing=true] { cursor:text; padding:0; }
.ar-step-grid .ar-sg-box input { width:100%; height:100%; min-height:0; padding:0 2px; text-align:center; background:transparent; border:0; outline:none; }
.ar-sg-select { position:relative; display:block; min-width:0; }
.ar-sg-select::after { content:""; position:absolute; right:6px; top:50%; margin-top:-2px; border:4px solid transparent; border-top-color:currentColor; border-bottom:0; pointer-events:none; opacity:.7; }
.ar-step-grid .ar-sg-select select { appearance:none; -webkit-appearance:none; width:100%; height:100%; padding:0 14px 0 6px; cursor:pointer; text-overflow:ellipsis; }
.ar-sg-dir { font-size:16px; line-height:1; }
.ar-sg-cells { position:relative; min-width:0; }
.ar-sg-cell { position:relative; flex:1 1 0; min-width:var(--ar-sg-cw); height:100%; border-radius:var(--ar-step-cell-radius,4px); background:var(--ar-step-cell-background,#2b2e35); border:1px solid var(--ar-step-cell-border,#3d414a); cursor:ns-resize; touch-action:none; user-select:none; overflow:hidden; }
.ar-sg-cell[data-on=true] { background:var(--ar-step-cell-on-background,#7a5a1c); border-color:var(--ar-step-cell-on-border,#d0a64a); }
.ar-sg-cell[data-inert=true] { opacity:var(--ar-step-inert-opacity,.3); cursor:default; pointer-events:none; }
.ar-sg-cell[data-current=true] { background:var(--ar-step-playhead,#f2dcb8); border-color:var(--ar-step-playhead,#f2dcb8); }
.ar-sg-cell:focus-visible { outline:2px solid var(--ar-step-focus,#4a9eff); outline-offset:1px; z-index:2; overflow:visible; }
.ar-sg-fill { position:absolute; left:var(--ar-step-fill-inset,3px); right:var(--ar-step-fill-inset,3px); bottom:0; height:0; background:var(--ar-step-value-color,#d0a64a); opacity:.35; pointer-events:none; }
.ar-sg-cell[data-on=true] .ar-sg-fill { opacity:1; background:var(--ar-step-value-color,#d0a64a); }
.ar-sg-cell[data-on=true]::after { content:""; position:absolute; left:0; right:0; top:0; height:var(--ar-step-cap-height,4px); background:var(--ar-step-cell-on-background,#7a5a1c); pointer-events:none; z-index:1; }
.ar-sg-cell[data-current=true]::after { display:none; }
.ar-sg-cell[data-current=true] .ar-sg-fill { background:var(--ar-step-playhead-value-color,#d8892b); }
.ar-step-grid[data-kind=centre] .ar-sg-cell::before { content:""; position:absolute; left:0; right:0; top:50%; height:1px; background:var(--ar-step-centre-line,#7c808b); z-index:1; pointer-events:none; }
.ar-step-grid[data-kind=segments] .ar-sg-fill { height:45%; background:repeating-linear-gradient(90deg,var(--ar-step-value-color,#d0a64a) 0,var(--ar-step-value-color,#d0a64a) calc(100% / var(--ar-sg-n,1) - 2px),transparent calc(100% / var(--ar-sg-n,1) - 2px),transparent calc(100% / var(--ar-sg-n,1))); }
.ar-sg-value { display:none; position:absolute; left:50%; top:50%; transform:translate(-50%,-50%); padding:0 3px; font-size:10px; line-height:14px; white-space:nowrap; color:var(--ar-step-label-color,#fff); background:var(--ar-step-label-background,rgba(0,0,0,.75)); border-radius:2px; pointer-events:none; z-index:3; }
.ar-sg-cell:hover .ar-sg-value,.ar-sg-cell:focus-visible .ar-sg-value,.ar-sg-cell[data-editing=true] .ar-sg-value { display:block; }
.ar-sg-overlay-host { position:absolute; inset:0; pointer-events:none; }
.ar-sg-footer { display:flex; flex-wrap:wrap; align-items:center; gap:8px 12px; margin-top:10px; }
.ar-sg-tabs { display:inline-flex; flex-wrap:wrap; gap:2px; padding:2px; border-radius:calc(var(--ar-step-tab-radius,4px) + 2px); background:var(--ar-step-tabs-background,rgba(255,255,255,.06)); }
.ar-step-grid .ar-sg-tab,.ar-step-grid .ar-sg-fold { background:transparent; border-color:transparent; color:var(--ar-step-muted,#9a9ea8); padding:2px 10px; border-radius:var(--ar-step-tab-radius,4px); }
.ar-step-grid .ar-sg-tab:hover,.ar-step-grid .ar-sg-fold:hover { color:var(--ar-step-color,#e6e6e6); }
.ar-step-grid .ar-sg-tab[aria-selected=true],.ar-step-grid .ar-sg-fold[aria-pressed=true] { background:var(--ar-step-control-active-background,#d0a64a); color:var(--ar-step-control-active-color,#16171a); border-color:transparent; }
.ar-sg-tools { display:flex; align-items:center; gap:8px; margin-left:auto; flex-wrap:wrap; }
.ar-sg-tools > .ar-sg-fold { background:var(--ar-step-tabs-background,rgba(255,255,255,.06)); }
.ar-sg-toolbar { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.ar-sg-toolbar input,.ar-sg-toolbar select,.ar-sg-toolbar button { min-height:24px; }
@container ar-step-grid (max-width:900px) {
  .ar-sg-scroll { --ar-sg-head:var(--ar-step-header-width,300px); --ar-sg-cols:minmax(0,1fr) 22px 22px 34px 46px 24px 40px; --ar-sg-cw:var(--ar-step-cell-min-width,14px); --ar-sg-gap:var(--ar-step-cell-gap,2px); --ar-sg-bar:var(--ar-step-bar-gap,6px); }
  .ar-sg-head,.ar-sg-colhead { gap:3px; padding-right:6px; }
  .ar-sg-name { padding:0 6px; }
  .ar-sg-colname { font-size:9px; letter-spacing:.02em; }
  .ar-step-grid .ar-sg-select select { padding:0 12px 0 4px; }
  .ar-sg-select::after { right:4px; }
}
`;
