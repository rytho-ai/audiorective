import { summarizePeaks, type PeakSummary } from "@audiorective/core/peaks";
import type { WaveformPeaks } from "@audiorective/widgets/waveform";
import type { AudioClip, AudioMedia } from "@audiorective/workspace";

type WaveformView = { clip: AudioClip; element: HTMLDivElement; canvas: HTMLCanvasElement };
type FramePeaks = Pick<PeakSummary, "min" | "max" | "framesPerPeak">;
type MediaPeaks = { tiles: Map<number, PeakSummary | null>; tileFrames: number };
const fineScale = 100;
const tileSeconds = 2;
const tileLimit = 24;
const readLimit = 4;

function peakExtent(peaks: WaveformPeaks): number {
  let max = 0.05;
  for (let i = 0; i < peaks.max.length; i++) max = Math.max(max, peaks.max[i], -peaks.min[i]);
  return max;
}

/** Paint only the visible portion of each thumbnail, with source-resolution peaks at high zoom. */
export class ClipWaveforms {
  private views: WaveformView[] = [];
  private readonly pcm = new WeakMap<readonly Float32Array[], PeakSummary>();
  private readonly media = new WeakMap<AudioMedia, MediaPeaks>();
  private readonly extent = new WeakMap<WaveformPeaks, number>();
  private pending = 0;
  private frame?: number;
  private disposed = false;

  constructor(
    private readonly viewport: HTMLElement,
    private readonly coarse: (clip: AudioClip) => WaveformPeaks | undefined,
    private readonly reportError: (error: unknown) => void,
  ) {}

  add(clip: AudioClip): HTMLElement {
    const element = document.createElement("div");
    element.className = "clip-visual clip-waveform";
    element.setAttribute("aria-hidden", "true");
    const canvas = document.createElement("canvas");
    canvas.hidden = true;
    element.append(canvas);
    this.views.push({ clip, element, canvas });
    return element;
  }

  clear(): void {
    this.views = [];
  }

  schedule(): void {
    if (this.disposed || this.frame !== undefined) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = undefined;
      this.draw();
    });
  }

  destroy(): void {
    this.disposed = true;
    if (this.frame !== undefined) cancelAnimationFrame(this.frame);
    this.clear();
  }

  private mediaTiles(media: AudioMedia): MediaPeaks {
    let cached = this.media.get(media);
    if (!cached) {
      cached = { tiles: new Map(), tileFrames: media.sampleRate * tileSeconds };
      this.media.set(media, cached);
    }
    return cached;
  }

  private requestTile(media: AudioMedia, state: MediaPeaks, index: number): void {
    if (this.pending >= readLimit || state.tiles.has(index)) return;
    const start = index * state.tileFrames;
    const count = Math.min(state.tileFrames, media.frameCount - start);
    if (count <= 0) return;
    state.tiles.set(index, null);
    this.pending++;
    void media
      .readFrames(start, count)
      .then((channels) => {
        state.tiles.set(
          index,
          summarizePeaks(
            { channels, sampleRate: media.sampleRate },
            {
              framesPerPeak: Math.max(1, Math.floor(media.sampleRate / 3000)),
            },
          ),
        );
        if (state.tiles.size > tileLimit) {
          const oldest = [...state.tiles.entries()].find(([key, peaks]) => key !== index && peaks);
          if (oldest) state.tiles.delete(oldest[0]);
        }
      })
      .catch((error: unknown) => {
        if (!this.disposed && this.views.some(({ clip }) => clip.media === media)) this.reportError(error);
      })
      .finally(() => {
        this.pending--;
        this.schedule();
      });
  }

  private pcmPeaks(clip: AudioClip): PeakSummary | undefined {
    const channels = clip.channels;
    if (!channels || !channels[0].length) return undefined;
    const cached = this.pcm.get(channels);
    if (cached) return cached;
    const summary = summarizePeaks(
      { channels, sampleRate: clip.sampleRate },
      {
        framesPerPeak: Math.max(1, Math.floor(clip.sampleRate / 3000), Math.ceil(channels[0].length / 500_000)),
      },
    );
    this.pcm.set(channels, summary);
    return summary;
  }

  private draw(): void {
    const screen = this.viewport.getBoundingClientRect();
    const header = this.viewport.querySelector<HTMLElement>(".ruler-label")?.offsetWidth ?? 0;
    for (const view of this.views) {
      const box = view.element.getBoundingClientRect();
      const start = Math.max(0, Math.floor(screen.left + header - box.left));
      const end = Math.min(Math.ceil(box.width), Math.ceil(screen.left + this.viewport.clientWidth - box.left));
      if (end <= start || !box.height || box.bottom < screen.top || box.top > screen.bottom) {
        view.canvas.hidden = true;
        continue;
      }
      this.paint(view, box, start, end);
    }
  }

  private paint(view: WaveformView, box: DOMRect, start: number, end: number): void {
    const { clip, canvas } = view;
    const frameCount = clip.media ? clip.frameCount : clip.channels[0].length;
    const coarse = clip.media ? this.coarse(clip) : this.pcmPeaks(clip);
    const overview: FramePeaks | undefined = coarse && {
      min: coarse.min,
      max: coarse.max,
      framesPerPeak: "framesPerPeak" in coarse ? (coarse as PeakSummary).framesPerPeak : Math.ceil(frameCount / coarse.min.length),
    };
    const tiles = clip.media && box.width / clip.duration > fineScale ? this.mediaTiles(clip.media) : undefined;
    const framesPerPixel = frameCount / box.width;
    if (tiles && clip.media) {
      const first = Math.floor((clip.startFrame + start * framesPerPixel) / tiles.tileFrames);
      const last = Math.floor((clip.startFrame + Math.min(frameCount - 1, end * framesPerPixel)) / tiles.tileFrames);
      for (let tile = first; tile <= last; tile++) this.requestTile(clip.media, tiles, tile);
    }

    canvas.hidden = false;
    canvas.style.left = `${start}px`;
    canvas.style.width = `${end - start}px`;
    const scale = devicePixelRatio || 1;
    const width = Math.max(1, Math.round((end - start) * scale));
    const height = Math.max(1, Math.round(box.height * scale));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    ctx.clearRect(0, 0, end - start, box.height);
    ctx.strokeStyle = getComputedStyle(view.element).color;
    ctx.lineWidth = 1;
    let amplitude = coarse && this.extent.get(coarse);
    if (coarse && amplitude === undefined) {
      amplitude = peakExtent(coarse);
      this.extent.set(coarse, amplitude);
    }
    const mid = box.height / 2;
    const gain = (mid * 0.9) / (amplitude ?? 1);
    let largestBin = 0;
    ctx.beginPath();
    for (let x = start; x < end; x++) {
      const from = x * framesPerPixel;
      const to = Math.min(frameCount, (x + 1) * framesPerPixel);
      let low = 0,
        high = 0;
      const include = (data: FramePeaks | undefined, a: number, b: number) => {
        if (!data) return;
        largestBin = Math.max(largestBin, data.framesPerPeak);
        for (let i = Math.floor(a / data.framesPerPeak); i < Math.min(data.min.length, Math.ceil(b / data.framesPerPeak)); i++) {
          low = Math.min(low, data.min[i]);
          high = Math.max(high, data.max[i]);
        }
      };
      if (tiles && clip.media) {
        const sourceStart = clip.startFrame + from;
        const sourceEnd = clip.startFrame + to;
        const index = Math.floor(sourceStart / tiles.tileFrames);
        const tileStart = index * tiles.tileFrames;
        const tile = tiles.tiles.get(index);
        const boundary = tileStart + tiles.tileFrames;
        const after = sourceEnd > boundary ? tiles.tiles.get(index + 1) : undefined;
        if (tile && (sourceEnd <= boundary || after)) {
          include(tile, sourceStart - tileStart, Math.min(sourceEnd, boundary) - tileStart);
          if (after) include(after, 0, sourceEnd - boundary);
        } else include(overview, from, to);
      } else include(overview, from, to);
      const column = x - start + 0.5;
      ctx.moveTo(column, Math.max(1, mid - high * gain - 0.5));
      ctx.lineTo(column, Math.min(box.height - 1, mid - low * gain + 0.5));
    }
    ctx.stroke();
    canvas.dataset.framesPerPeak = String(largestBin);
  }
}
