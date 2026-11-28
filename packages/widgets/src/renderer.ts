/** Default drawing shares the same lifecycle as a caller's Canvas/SVG renderer. */
import { peakPath } from "./peaks";
import type { WaveformRenderer } from "./types";

export const defaultRenderer: WaveformRenderer = (container) => {
  const namespace = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(namespace, "svg");
  svg.setAttribute("preserveAspectRatio", "none");
  const center = document.createElementNS(namespace, "path");
  center.setAttribute("class", "ar-center");
  const path = document.createElementNS(namespace, "path");
  path.setAttribute("class", "ar-peaks");
  path.setAttribute("data-testid", "wave-path");
  svg.append(center, path);
  container.append(svg);
  return {
    render({ peaks, width, height, amplitudeZoom }) {
      svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
      path.setAttribute("d", peaks ? peakPath(peaks, width, height, amplitudeZoom) : "");
      center.setAttribute("d", `M0,${height / 2}H${width}`);
    },
    dispose() {
      svg.remove();
    },
  };
};
