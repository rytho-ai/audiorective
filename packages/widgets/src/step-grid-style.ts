/**
 * Default presentation of the step grid. Every colour and size is a `--ar-step-*` custom property
 * with a neutral fallback, so a page themes it by setting properties on the root or any ancestor.
 */
export const stepGridStyles = `
.ar-step-grid { font:var(--ar-step-font,13px/1.35 system-ui,sans-serif); color:var(--ar-step-color,#e6e6e6); background:var(--ar-step-background,#1d1f23); border:1px solid var(--ar-step-border,#3a3d44); border-radius:var(--ar-step-radius,8px); padding:var(--ar-step-padding,10px); box-sizing:border-box; min-width:0; }
.ar-step-grid * { box-sizing:border-box; }
.ar-step-grid [hidden] { display:none!important; }
.ar-sg-scroll { overflow-x:auto; padding-bottom:2px; }
.ar-sg-surface { position:relative; min-width:calc(var(--ar-step-header-width,220px) + var(--ar-sg-size,16) * (var(--ar-step-cell-min-width,22px) + var(--ar-step-cell-gap,3px))); }
.ar-sg-progress { height:var(--ar-step-progress-height,3px); margin-left:var(--ar-step-header-width,220px); background:var(--ar-step-progress-track,transparent); margin-bottom:3px; }
.ar-sg-progress-fill { height:100%; width:0; background:var(--ar-step-progress,#d0a64a); }
.ar-sg-ruler,.ar-sg-cells { display:flex; gap:var(--ar-step-cell-gap,3px); flex:1 1 auto; min-width:0; }
.ar-sg-ruler { margin-left:var(--ar-step-header-width,220px); color:var(--ar-step-muted,#9a9ea8); font-size:10px; height:14px; }
.ar-sg-tick { flex:1 1 0; min-width:var(--ar-step-cell-min-width,22px); white-space:nowrap; overflow:visible; }
.ar-sg-tick[data-bar=true],.ar-sg-cell[data-bar=true] { margin-left:var(--ar-step-bar-gap,5px); }
.ar-sg-tick[data-first=true],.ar-sg-cell[data-first=true] { margin-left:0; }
.ar-sg-lanes { display:flex; flex-direction:column; gap:var(--ar-step-lane-gap,3px); }
.ar-sg-lane { display:flex; align-items:stretch; }
.ar-sg-head { flex:0 0 var(--ar-step-header-width,220px); width:var(--ar-step-header-width,220px); display:flex; flex-wrap:wrap; align-content:center; align-items:center; gap:2px 4px; padding:2px 8px 2px 0; }
.ar-sg-name { flex:1 1 60px; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-weight:600; color:var(--ar-step-header-color,#e2c24a); }
.ar-sg-field { display:inline-flex; align-items:center; gap:2px; font-size:10px; color:var(--ar-step-muted,#9a9ea8); }
.ar-step-grid button,.ar-step-grid input,.ar-step-grid select { font:inherit; font-size:11px; color:var(--ar-step-control-color,inherit); background:var(--ar-step-control-background,#2a2d33); border:1px solid var(--ar-step-control-border,#454953); border-radius:var(--ar-step-control-radius,4px); padding:1px 4px; min-height:20px; margin:0; }
.ar-step-grid button { cursor:pointer; }
.ar-step-grid button[aria-pressed=true],.ar-sg-tab[aria-selected=true] { background:var(--ar-step-control-active-background,#d0a64a); color:var(--ar-step-control-active-color,#16171a); border-color:transparent; }
.ar-sg-head input[type=number] { width:42px; }
.ar-sg-head select { max-width:58px; }
.ar-sg-cells { position:relative; }
.ar-sg-cell { position:relative; flex:1 1 0; min-width:var(--ar-step-cell-min-width,22px); height:var(--ar-step-cell-height,36px); border-radius:var(--ar-step-cell-radius,3px); background:var(--ar-step-cell-background,#2b2e35); border:1px solid var(--ar-step-cell-border,#3d414a); cursor:ns-resize; touch-action:none; user-select:none; overflow:hidden; }
.ar-sg-cell[data-on=true] { background:var(--ar-step-cell-on-background,#7a5a1c); border-color:var(--ar-step-cell-on-border,#d0a64a); }
.ar-sg-cell[data-inert=true] { opacity:var(--ar-step-inert-opacity,.3); cursor:default; pointer-events:none; }
.ar-sg-cell[data-current=true] { background:var(--ar-step-playhead,#f2dcb8); border-color:var(--ar-step-playhead,#f2dcb8); }
.ar-sg-cell:focus-visible { outline:2px solid var(--ar-step-focus,#4a9eff); outline-offset:1px; z-index:2; overflow:visible; }
.ar-sg-fill { position:absolute; left:0; right:0; bottom:0; height:0; background:var(--ar-step-value-color,#d0a64a); opacity:.35; pointer-events:none; }
.ar-sg-cell[data-on=true] .ar-sg-fill { opacity:1; background:var(--ar-step-value-color,#d0a64a); }
.ar-sg-cell[data-current=true] .ar-sg-fill { background:var(--ar-step-playhead-value-color,#d8892b); }
.ar-step-grid[data-kind=centre] .ar-sg-cell::before { content:""; position:absolute; left:0; right:0; top:50%; height:1px; background:var(--ar-step-centre-line,#7c808b); z-index:1; pointer-events:none; }
.ar-step-grid[data-kind=segments] .ar-sg-fill { height:45%; background:repeating-linear-gradient(90deg,var(--ar-step-value-color,#d0a64a) 0,var(--ar-step-value-color,#d0a64a) calc(100% / var(--ar-sg-n,1) - 2px),transparent calc(100% / var(--ar-sg-n,1) - 2px),transparent calc(100% / var(--ar-sg-n,1))); }
.ar-sg-value { display:none; position:absolute; left:50%; top:50%; transform:translate(-50%,-50%); padding:0 3px; font-size:10px; line-height:14px; white-space:nowrap; color:var(--ar-step-label-color,#fff); background:var(--ar-step-label-background,rgba(0,0,0,.75)); border-radius:2px; pointer-events:none; z-index:3; }
.ar-sg-cell:hover .ar-sg-value,.ar-sg-cell:focus-visible .ar-sg-value,.ar-sg-cell[data-editing=true] .ar-sg-value { display:block; }
.ar-sg-overlay-host { position:absolute; inset:0; pointer-events:none; }
.ar-sg-footer { display:flex; flex-wrap:wrap; align-items:center; gap:8px; margin-top:8px; }
.ar-sg-tabs { display:flex; flex-wrap:wrap; gap:2px; }
.ar-sg-tab { padding:2px 8px!important; border-radius:var(--ar-step-tab-radius,4px)!important; }
.ar-sg-tools { display:flex; align-items:center; gap:6px; margin-left:auto; flex-wrap:wrap; }
.ar-sg-toolbar { display:flex; align-items:center; gap:6px; flex-wrap:wrap; }
`;
