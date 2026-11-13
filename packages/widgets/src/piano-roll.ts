/** Piano-roll view of borrowed MIDI state. Owns DOM/viewport only, never audio or note data.
 * Reuses the existing selection plugin's linear time coordinates and cleanup contract.
 * Reads: ./piano-roll-types, ./midi interval query, existing widgets selection/styles.
 */
import { createSelectionPlugin } from "./selection";
import type { WaveformPluginContext, Unsubscribe } from "./types";
import { styles } from "./style";
import { visibleMidiNotes, type MidiNote } from "@audiorective/blocks/midi";
import type { PianoRollOptions, PianoRollHandle, PianoRollRenderer, PitchRange } from "./piano-roll-types";
export type * from "./piano-roll-types";
const black = (pitch: number) => [1, 3, 6, 8, 10].includes(pitch % 12);
const name = (pitch: number) => `${["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"][pitch % 12]}${Math.floor(pitch / 12) - 1}`;
const clamp = (n: number, low: number, high: number) => Math.max(low, Math.min(high, n));
const defaultRenderer: PianoRollRenderer = (root) => ({
  render(frame) {
    const nodes = frame.notes.map((note) => {
      const el = document.createElement("button");
      el.type = "button";
      el.dataset.noteId = note.id;
      el.className = "ar-pr-note";
      const x = frame.timeToX(note.start),
        end = frame.timeToX(note.end),
        h = frame.height / (frame.pitches.high - frame.pitches.low + 1);
      Object.assign(el.style, {
        left: `${x}px`,
        top: `${frame.pitchToY(note.pitch)}px`,
        width: `${Math.max(2, end - x)}px`,
        height: `${Math.max(2, h - 1)}px`,
        opacity: String(0.3 + (0.7 * note.velocity) / 127),
      });
      el.textContent = name(note.pitch);
      el.setAttribute("aria-label", `${name(note.pitch)}, ${note.start.toFixed(3)} to ${note.end.toFixed(3)} seconds, velocity ${note.velocity}`);
      // Note inspection is separate from background time-range dragging.
      el.onpointerdown = (e) => e.stopPropagation();
      el.onclick = () => frame.onNoteClick(note);
      return el;
    });
    root.replaceChildren(...nodes);
  },
  destroy() {
    root.replaceChildren();
  },
});
export function mountPianoRoll(root: HTMLElement, options: PianoRollOptions): PianoRollHandle {
  const container = document.createElement("section");
  container.className = "ar-widget ar-piano-roll";
  container.setAttribute("aria-label", options.label ?? "Piano roll");
  container.innerHTML = `<style>${styles}
 .ar-pr-layout{display:grid;grid-template-columns:54px minmax(0,1fr);min-width:0}
 .ar-pr-keys{position:relative;overflow:hidden;border-right:1px solid var(--waveform-border,#344154)}
 .ar-pr-key{position:absolute;left:0;width:100%;font:11px system-ui;padding-left:4px;border-bottom:1px solid var(--waveform-border,#344154)}
 .ar-pr-key[data-black=true]{background:color-mix(in srgb,currentColor 12%,transparent)}
 .ar-pr-surface{position:relative;touch-action:none;height:var(--piano-roll-height,240px);min-height:64px;overflow:hidden}
 .ar-pr-notes{position:absolute;inset:0}.ar-pr-note{position:absolute!important;min-height:0!important;padding:0 3px!important;border-radius:3px!important;overflow:hidden;white-space:nowrap;text-align:left;font-size:10px!important;background:var(--ar-accent)!important;color:var(--piano-roll-note-text,#08111d)!important}
 .ar-pr-grid{position:absolute;inset:0;pointer-events:none}.ar-pr-beat{position:absolute;top:0;height:100%;border-left:1px solid var(--waveform-border,#344154)}
 </style><div class="ar-toolbar"><button data-testid="piano-zoom-out" type="button" aria-label="Zoom piano roll out">−</button><button data-testid="piano-zoom-in" type="button" aria-label="Zoom piano roll in">＋</button></div><div class="ar-pr-layout"><div class="ar-pr-keys" aria-hidden="true"></div><div class="ar-viewport" data-testid="piano-viewport" tabindex="0" aria-label="Piano roll horizontal scroll"><div class="ar-pr-surface" data-testid="piano-roll"><div class="ar-pr-grid"></div><div class="ar-pr-notes"></div><div class="ar-playhead" data-testid="piano-playhead" hidden></div></div></div></div>`;
  root.append(container);
  const find = <T extends HTMLElement = HTMLElement>(s: string) => container.querySelector<T>(s)!;
  const viewport = find("[data-testid=piano-viewport]"),
    surface = find("[data-testid=piano-roll]"),
    keys = find(".ar-pr-keys"),
    drawing = find(".ar-pr-notes"),
    lines = find(".ar-pr-grid"),
    playhead = find("[data-testid=piano-playhead]");
  const zoomIn = find<HTMLButtonElement>("[data-testid=piano-zoom-in]"),
    zoomOut = find<HTMLButtonElement>("[data-testid=piano-zoom-out]");
  let state = options.model.getState(),
    zoom = 1,
    scale = 0,
    width = 1,
    height = 240,
    position: number | null = null,
    destroyed = false;
  let grid = options.grid ?? { beats: [], downbeats: [] };
  let low = 48,
    high = 72;
  for (const note of state.notes) {
    low = Math.min(low, note.pitch);
    high = Math.max(high, note.pitch);
  }
  let pitches: PitchRange = options.pitches ?? { low: Math.max(0, low - 2), high: Math.min(127, high + 2) };
  const cleanups = new Set<Unsubscribe>(),
    viewListeners = new Set<() => void>(),
    dataListeners = new Set<() => void>();
  const own = (dispose: Unsubscribe) => {
    let live = true;
    const off = () => {
      if (!live) return;
      live = false;
      cleanups.delete(off);
      dispose();
    };
    if (destroyed) off();
    else cleanups.add(off);
    return off;
  };
  const listen = (target: EventTarget, type: string, fn: EventListener) => {
    target.addEventListener(type, fn);
    return own(() => target.removeEventListener(type, fn));
  };
  const timeToX = (seconds: number) => clamp(seconds, 0, state.duration) * scale;
  const snapshot = () =>
    Object.freeze({ duration: state.duration, pixelsPerSecond: scale, scrollLeft: viewport.scrollLeft, width: viewport.clientWidth, height });
  let renderer: ReturnType<PianoRollRenderer> | undefined;
  const plugin = createSelectionPlugin({
    model: options.model,
    grid: { beats: [...grid.beats], downbeats: [...grid.downbeats] },
    snap: options.snap,
    onCommit: options.onCommit,
  });
  let pluginHandle: { destroy(): void } | Unsubscribe | void;
  function drawPlayhead() {
    playhead.hidden = position === null || !state.duration;
    if (position !== null) playhead.style.left = `${timeToX(position)}px`;
  }
  function render() {
    if (destroyed) return;
    const range = { start: scale ? viewport.scrollLeft / scale : 0, end: scale ? (viewport.scrollLeft + viewport.clientWidth) / scale : 0 };
    renderer?.render(
      Object.freeze({
        notes: visibleMidiNotes(state.notes, range, pitches),
        duration: state.duration,
        width,
        height,
        pitches: Object.freeze({ ...pitches }),
        viewport: snapshot(),
        timeToX,
        pitchToY: (pitch) => ((pitches.high - pitch) * height) / (pitches.high - pitches.low + 1),
        onNoteClick: (note: MidiNote) => options.onNoteClick?.(note),
      }),
    );
    drawPlayhead();
    for (const fn of [...viewListeners]) fn();
  }
  function layout() {
    if (destroyed) return;
    width = Math.max(1, viewport.clientWidth) * zoom;
    scale = state.duration ? width / state.duration : 0;
    surface.style.width = `${width}px`;
    height = surface.clientHeight;
    keys.style.height = `${height}px`;
    const rowHeight = height / (pitches.high - pitches.low + 1),
      keyNodes = [];
    surface.style.backgroundImage = `repeating-linear-gradient(to bottom, var(--waveform-border,#344154) 0px, var(--waveform-border,#344154) 1px, transparent 1px, transparent ${rowHeight}px)`;
    for (let pitch = pitches.high; pitch >= pitches.low; pitch--) {
      const el = document.createElement("div");
      el.className = "ar-pr-key";
      el.dataset.black = String(black(pitch));
      el.textContent = rowHeight >= 14 || pitch % 12 === 0 ? name(pitch) : "";
      Object.assign(el.style, {
        lineHeight: `${rowHeight}px`,
        fontSize: `${Math.max(1, Math.min(11, rowHeight - 1))}px`,
        overflow: "hidden",
        top: `${(pitches.high - pitch) * rowHeight}px`,
        height: `${rowHeight}px`,
      });
      keyNodes.push(el);
    }
    keys.replaceChildren(...keyNodes);
    lines.replaceChildren(
      ...grid.beats
        .filter((t) => Number.isFinite(t) && t >= 0 && t <= state.duration)
        .map((t) => {
          const el = document.createElement("div");
          el.className = "ar-pr-beat";
          el.style.left = `${timeToX(t)}px`;
          if (grid.downbeats.includes(t)) el.style.borderLeftWidth = "2px";
          return el;
        }),
    );
    zoomOut.disabled = zoom <= 1;
    zoomIn.disabled = zoom >= 64;
    render();
  }
  const context: WaveformPluginContext = {
    surface,
    get duration() {
      return state.duration;
    },
    getViewport: snapshot,
    timeToX,
    clientXToTime: (x) => (scale ? clamp((x - surface.getBoundingClientRect().left) / scale, 0, state.duration) : 0),
    scrollBy(pixels) {
      viewport.scrollLeft += pixels;
      render();
    },
    getViewportRect: () => viewport.getBoundingClientRect(),
    mountOverlay(el) {
      if (destroyed) throw new Error("Plugin attachment is destroyed.");
      Object.assign(el.style, { position: "absolute", inset: "0", pointerEvents: "none" });
      surface.append(el);
      return own(() => el.remove());
    },
    onViewportChange(fn) {
      const cb = () => fn(snapshot());
      viewListeners.add(cb);
      return own(() => viewListeners.delete(cb));
    },
    onDataChange(fn) {
      const cb = () => fn(state.duration);
      dataListeners.add(cb);
      return own(() => dataListeners.delete(cb));
    },
    listen,
    onCleanup: own,
  };
  const handle: PianoRollHandle = {
    setPlayhead(seconds) {
      if (seconds !== null && !Number.isFinite(seconds)) throw new RangeError("Playhead must be finite or null.");
      position = seconds;
      drawPlayhead();
    },
    setZoom(factor) {
      if (!Number.isFinite(factor) || factor < 1 || factor > 64) throw new RangeError("Piano roll zoom must be between 1 and 64.");
      const center = scale ? (viewport.scrollLeft + viewport.clientWidth / 2) / scale : 0;
      zoom = factor;
      layout();
      viewport.scrollLeft = timeToX(center) - viewport.clientWidth / 2;
      render();
    },
    scrollTo(seconds) {
      if (!Number.isFinite(seconds)) throw new RangeError("Piano roll scroll time must be finite.");
      viewport.scrollLeft = timeToX(seconds);
      render();
    },
    setPitchRange(next) {
      if (!Number.isInteger(next.low) || !Number.isInteger(next.high) || next.low < 0 || next.high > 127 || next.low > next.high)
        throw new RangeError("Piano roll pitches must satisfy 0 <= low <= high <= 127.");
      pitches = { ...next };
      layout();
    },
    getViewport: snapshot,
    setSnap: (mode) => plugin.setSnap(mode),
    setGrid(next) {
      grid = next;
      plugin.setGrid({ beats: [...next.beats], downbeats: [...next.downbeats] });
      layout();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      observer.disconnect();
      if (typeof pluginHandle === "function") pluginHandle();
      else pluginHandle?.destroy();
      for (const fn of [...cleanups]) fn();
      renderer?.destroy?.();
      viewListeners.clear();
      dataListeners.clear();
      container.remove();
    },
  };
  const observer = new ResizeObserver(layout);
  try {
    renderer = (options.renderer ?? defaultRenderer)(drawing);
    pluginHandle = plugin.attach(context);
    handle.setPitchRange(pitches);
    listen(viewport, "scroll", render);
    listen(zoomIn, "click", () => handle.setZoom(Math.min(64, zoom * 2)));
    listen(zoomOut, "click", () => handle.setZoom(Math.max(1, zoom / 2)));
    own(
      options.model.subscribe(() => {
        const next = options.model.getState(),
          dataChanged = next.notes !== state.notes || next.duration !== state.duration;
        state = next;
        if (dataChanged) {
          for (const fn of [...dataListeners]) fn();
          layout();
        }
      }),
    );
    observer.observe(viewport);
    layout();
    return handle;
  } catch (error) {
    handle.destroy();
    throw error;
  }
}
