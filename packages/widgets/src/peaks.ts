/** Pure data reduction comes from core; zero-baseline display belongs to the renderer. */
import { summarizePeaks } from "@audiorective/core/peaks";
export type Peaks = { min: Float32Array; max: Float32Array; duration: number };
export function cachePeaks(buffer: AudioBuffer): Peaks {
  return summarizePeaks({
    sampleRate: buffer.sampleRate,
    channels: Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c)),
  });
}
export function peakPath(peaks: Peaks, width: number, height: number, amplitudeZoom = 1): string {
  const commands: string[] = [];
  const columns = Math.ceil(width);
  for (let x = 0; x < columns; x += 2) {
    const first = Math.floor((x / width) * peaks.min.length);
    const last = Math.min(peaks.min.length, Math.max(first + 1, Math.ceil(((x + 2) / width) * peaks.min.length)));
    let lo = 0,
      hi = 0;
    for (let i = first; i < last; i++) {
      lo = Math.min(lo, peaks.min[i]);
      hi = Math.max(hi, peaks.max[i]);
    }
    commands.push(
      `M${x},${(((1 - Math.min(1, hi * amplitudeZoom)) * height) / 2).toFixed(1)}V${(((1 - Math.max(-1, lo * amplitudeZoom)) * height) / 2).toFixed(1)}`,
    );
  }
  return commands.join("");
}
