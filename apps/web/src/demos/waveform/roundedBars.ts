/** Example of replacing drawing through the public widget interface. */
import type { WaveformRenderer } from "@audiorective/widgets/waveform";

export const roundedBars: WaveformRenderer = (container) => {
  const namespace = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(namespace, "svg");
  svg.setAttribute("data-custom-waveform", "rounded-bars");
  const path = document.createElementNS(namespace, "path");
  path.setAttribute("stroke", "#ffab76");
  path.setAttribute("stroke-width", "4");
  path.setAttribute("stroke-linecap", "round");
  svg.append(path);
  container.append(svg);
  return {
    render({ peaks, width, height }) {
      svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
      const commands: string[] = [];
      if (peaks) {
        const count = Math.max(1, Math.min(peaks.min.length, Math.floor(width / 10)));
        for (let column = 0; column < count; column++) {
          const first = Math.floor((column / count) * peaks.min.length);
          const end = Math.ceil(((column + 1) / count) * peaks.min.length);
          let min = 0,
            max = 0;
          for (let i = first; i < end; i++) {
            min = Math.min(min, peaks.min[i]);
            max = Math.max(max, peaks.max[i]);
          }
          const x = ((column + 0.5) / count) * width;
          commands.push(`M${x},${((1 - max) * height) / 2}V${((1 - min) * height) / 2}`);
        }
      }
      path.setAttribute("d", commands.join(" "));
    },
    dispose() {
      svg.remove();
    },
  };
};
