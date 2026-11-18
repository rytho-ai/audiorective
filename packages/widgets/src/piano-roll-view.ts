/** Default piano-roll appearance. Custom layouts/renderers reuse the widget's geometry and gestures.
 * Reads: ./piano-roll-types. Owns only keyboard/toolbar/note drawing DOM.
 */
import type { PianoRollLayout, PianoRollRenderer } from "./piano-roll-types";
const black = (pitch: number) => [1, 3, 6, 8, 10].includes(pitch % 12);
const name = (pitch: number) => `${["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"][pitch % 12]}${Math.floor(pitch / 12) - 1}`;

export const defaultPianoRollLayout: PianoRollLayout = (root, viewport, controls) => {
  const toolbar = document.createElement("div");
  toolbar.className = "ar-toolbar";
  toolbar.innerHTML =
    '<button data-testid="piano-zoom-out" type="button" aria-label="Zoom piano roll out">−</button><button data-testid="piano-zoom-in" type="button" aria-label="Zoom piano roll in">＋</button>';
  const layout = document.createElement("div");
  layout.className = "ar-pr-layout";
  const keys = document.createElement("div");
  keys.className = "ar-pr-keys";
  keys.setAttribute("aria-hidden", "true");
  layout.append(keys, viewport);
  root.append(toolbar, layout);
  const zoomIn = toolbar.querySelectorAll<HTMLButtonElement>("button")[1],
    zoomOut = toolbar.querySelectorAll<HTMLButtonElement>("button")[0];
  let zoom = 1;
  zoomIn.onclick = () => controls.setZoom(Math.min(64, zoom * 2));
  zoomOut.onclick = () => controls.setZoom(Math.max(1, zoom / 2));
  return {
    render(frame) {
      zoom = frame.zoom;
      zoomOut.disabled = zoom <= 1;
      zoomIn.disabled = zoom >= 64;
      keys.style.height = `${frame.height}px`;
      const rowHeight = frame.height / (frame.pitches.high - frame.pitches.low + 1),
        nodes: HTMLElement[] = [];
      for (let pitch = frame.pitches.high; pitch >= frame.pitches.low; pitch--) {
        const el = document.createElement("div");
        el.className = "ar-pr-key";
        el.dataset.black = String(black(pitch));
        el.textContent = rowHeight >= 14 || pitch % 12 === 0 ? name(pitch) : "";
        Object.assign(el.style, {
          lineHeight: `${rowHeight}px`,
          fontSize: `${Math.max(1, Math.min(11, rowHeight - 1))}px`,
          overflow: "hidden",
          top: `${frame.pitchToY(pitch)}px`,
          height: `${rowHeight}px`,
        });
        nodes.push(el);
      }
      keys.replaceChildren(...nodes);
    },
    destroy() {
      zoomIn.onclick = zoomOut.onclick = null;
      toolbar.remove();
      layout.remove();
    },
  };
};

export const defaultPianoRollRenderer: PianoRollRenderer = (root) => ({
  render(frame) {
    root.replaceChildren(
      ...frame.notes.map((note) => {
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
        el.setAttribute("aria-label", `${name(note.pitch)}, ${note.start.toFixed(3)} to ${note.end.toFixed(3)} ${frame.timeUnit}, velocity ${note.velocity}`);
        if (frame.editable) {
          el.title = "Drag to move; drag either edge to resize. Hold Alt to bypass snap.";
          el.style.cursor = "grab";
        }
        el.onpointerdown = (event) => frame.onNotePointerDown(note, event);
        el.onclick = () => frame.onNoteClick(note);
        return el;
      }),
    );
  },
  destroy() {
    root.replaceChildren();
  },
});
