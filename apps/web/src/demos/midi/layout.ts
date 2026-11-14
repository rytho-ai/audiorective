/** Alternate public piano-roll layout: numeric keyboard on the right, wrapping controls below. */
import type { PianoRollLayout } from "@audiorective/widgets/piano-roll";
export const rightKeyboardLayout: PianoRollLayout = (root, viewport, controls) => {
  const row = document.createElement("div");
  row.style.cssText = "display:grid;grid-template-columns:minmax(0,1fr) 48px;min-width:0";
  const keys = document.createElement("aside");
  keys.setAttribute("aria-hidden", "true");
  keys.style.cssText = "position:relative;overflow:hidden;border-left:1px solid var(--waveform-border,#344154)";
  keys.dataset.demoKeys = "right";
  row.append(viewport, keys);
  const footer = document.createElement("footer");
  footer.style.cssText = "display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-top:8px";
  const output = document.createElement("output");
  let zoom = 1;
  const buttons: HTMLButtonElement[] = [];
  for (const [label, action] of [
    ["Fit", () => controls.setZoom(1)],
    ["Zoom out", () => controls.setZoom(Math.max(1, zoom / 2))],
    ["Zoom in", () => controls.setZoom(Math.min(64, zoom * 2))],
  ] as const) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.onclick = action;
    button.dataset.demoZoom = label;
    buttons.push(button);
    footer.append(button);
  }
  footer.append(output);
  root.append(row, footer);
  return {
    render(frame) {
      zoom = frame.zoom;
      output.textContent = `${zoom}× · ${frame.duration.toFixed(2)}s`;
      keys.style.height = `${frame.height}px`;
      const nodes: HTMLElement[] = [],
        height = frame.height / (frame.pitches.high - frame.pitches.low + 1);
      for (let pitch = frame.pitches.low; pitch <= frame.pitches.high; pitch++) {
        const key = document.createElement("div");
        key.style.cssText = `position:absolute;left:0;right:0;top:${frame.pitchToY(pitch)}px;height:${height}px;border-bottom:1px solid var(--waveform-border,#344154);font:10px monospace;overflow:hidden;text-align:center`;
        key.textContent = height >= 14 || pitch % 12 === 0 ? String(pitch) : "";
        nodes.push(key);
      }
      keys.replaceChildren(...nodes);
      buttons[1].disabled = zoom <= 1;
      buttons[2].disabled = zoom >= 64;
    },
    destroy() {
      for (const button of buttons) button.onclick = null;
      root.replaceChildren();
    },
  };
};
