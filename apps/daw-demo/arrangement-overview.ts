type OverviewClip = { start: number; end: number; track: number; color: string };

/** A fixed overview of the arrangement with an independently draggable viewport. */
export class ArrangementOverview {
  private readonly artwork = document.createElement("div");
  private readonly window = document.createElement("div");
  private readonly playhead = document.createElement("span");
  private readonly resize: ResizeObserver;
  private readonly listeners = new AbortController();
  private duration = 0;
  private pixelsPerSecond = 1;
  private drag?: { id: number; offset: number };

  constructor(
    private readonly overview: HTMLElement,
    private readonly arrangement: HTMLElement,
  ) {
    this.artwork.className = "overview-clips";
    this.window.className = "overview-window";
    this.playhead.className = "overview-playhead";
    this.artwork.setAttribute("aria-hidden", "true");
    this.window.setAttribute("aria-hidden", "true");
    this.playhead.setAttribute("aria-hidden", "true");
    overview.append(this.artwork, this.window, this.playhead);
    const { signal } = this.listeners;
    overview.addEventListener(
      "pointerdown",
      (event) => {
        if (event.button !== 0 || this.drag) return;
        const bounds = this.overview.getBoundingClientRect();
        const view = this.window.getBoundingClientRect();
        if (bounds.width <= 0 || !this.maxScroll) return;
        event.preventDefault();
        overview.focus({ preventScroll: true });
        const offset = event.clientX >= view.left && event.clientX <= view.right ? event.clientX - view.left : view.width / 2;
        overview.setPointerCapture(event.pointerId);
        this.drag = { id: event.pointerId, offset };
        this.scrollTo(event.clientX - bounds.left - offset);
      },
      { signal },
    );
    overview.addEventListener(
      "pointermove",
      (event) => {
        if (this.drag?.id === event.pointerId) this.scrollTo(event.clientX - overview.getBoundingClientRect().left - this.drag.offset);
      },
      { signal },
    );
    const finish = (event: PointerEvent) => {
      if (this.drag?.id !== event.pointerId) return;
      this.drag = undefined;
      if (overview.hasPointerCapture(event.pointerId)) overview.releasePointerCapture(event.pointerId);
    };
    overview.addEventListener("pointerup", finish, { signal });
    overview.addEventListener("pointercancel", finish, { signal });
    overview.addEventListener("lostpointercapture", finish, { signal });
    overview.addEventListener(
      "keydown",
      (event) => {
        const page = this.visibleWidth();
        const offsets: Record<string, number> = { ArrowLeft: -page / 10, ArrowRight: page / 10, PageUp: -page, PageDown: page };
        if (event.key === "Home") arrangement.scrollLeft = 0;
        else if (event.key === "End") arrangement.scrollLeft = this.maxScroll;
        else if (Object.hasOwn(offsets, event.key)) arrangement.scrollLeft += offsets[event.key];
        else return;
        event.preventDefault();
        event.stopPropagation();
        this.sync();
      },
      { signal },
    );
    arrangement.addEventListener("scroll", () => this.sync(), { passive: true, signal });
    this.resize = new ResizeObserver(() => this.sync());
    this.resize.observe(overview);
    this.resize.observe(arrangement);
  }

  render(clips: readonly OverviewClip[], tracks: number, duration: number, pixelsPerSecond: number): void {
    this.duration = duration;
    this.pixelsPerSecond = pixelsPerSecond;
    const fragment = document.createDocumentFragment();
    for (const clip of clips) {
      if (clip.end <= clip.start) continue;
      const block = document.createElement("span");
      block.className = "overview-clip";
      block.style.left = `${(clip.start / duration) * 100}%`;
      block.style.width = `${((clip.end - clip.start) / duration) * 100}%`;
      block.style.top = `${(clip.track / tracks) * 100}%`;
      block.style.height = `${90 / tracks}%`;
      block.style.background = clip.color;
      fragment.append(block);
    }
    this.artwork.replaceChildren(fragment);
    this.sync();
  }

  private get maxScroll(): number {
    return Math.max(0, this.arrangement.scrollWidth - this.arrangement.clientWidth);
  }

  setPlayhead(time: number): void {
    this.playhead.style.left = this.duration ? `${Math.max(0, Math.min(100, (time / this.duration) * 100))}%` : "0%";
  }

  private visibleWidth(): number {
    return Math.max(0, this.arrangement.clientWidth - (this.arrangement.querySelector<HTMLElement>(".ruler-label")?.offsetWidth ?? 0));
  }

  private scrollTo(left: number): void {
    const width = this.overview.clientWidth;
    if (!width || !this.duration) return;
    this.arrangement.scrollLeft = (left / width) * this.duration * this.pixelsPerSecond;
    this.sync();
  }

  private sync(): void {
    const total = this.duration * this.pixelsPerSecond;
    const left = this.arrangement.scrollLeft;
    this.window.style.left = total ? `${(left / total) * 100}%` : "0%";
    this.window.style.width = total ? `${Math.min(100, (this.visibleWidth() / total) * 100)}%` : "100%";
    const toSeconds = (pixels: number) => Math.round((pixels / this.pixelsPerSecond) * 100) / 100;
    this.overview.setAttribute("aria-valuemin", "0");
    this.overview.setAttribute("aria-valuemax", String(toSeconds(this.maxScroll)));
    this.overview.setAttribute("aria-valuenow", String(toSeconds(left)));
    this.overview.setAttribute("aria-valuetext", `${toSeconds(left)}–${Math.min(this.duration, toSeconds(left + this.visibleWidth()))} 秒`);
  }

  destroy(): void {
    this.listeners.abort();
    this.resize.disconnect();
    this.artwork.remove();
    this.window.remove();
    this.playhead.remove();
  }
}
