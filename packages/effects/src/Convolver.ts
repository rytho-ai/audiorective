import { AudioBufferCache, cell, readonlyCell, type Cell, type ReadonlyCell } from "@audiorective/core";
import { Effect, type EffectOptions } from "./Effect";

export interface ConvolverOptions extends EffectOptions {
  buffer?: AudioBuffer;
  url?: string;
  /** ConvolverNode.normalize. Default true. */
  normalize?: boolean;
}

const caches = new WeakMap<AudioContext, AudioBufferCache>();
function cacheFor(ctx: BaseAudioContext): AudioBufferCache {
  const audioCtx = ctx as AudioContext;
  let c = caches.get(audioCtx);
  if (!c) {
    c = new AudioBufferCache(audioCtx);
    caches.set(audioCtx, c);
  }
  return c;
}

/** Convolution reverb. Until an impulse response is in place (`cells.status` is `"loading"`, or `"error"` when `url` failed to load) the effect passes the dry signal. */
export class Convolver extends Effect<{}, { buffer: ReadonlyCell<AudioBuffer | null> }> {
  static override readonly type = "Convolver";
  private readonly node: ConvolverNode;
  private loadToken = 0;
  private disposed = false;
  private readonly _buffer: Cell<AudioBuffer | null>;

  constructor(ctx: BaseAudioContext, opts: ConvolverOptions = {}) {
    const node = new ConvolverNode(ctx, { disableNormalization: opts.normalize === false });
    const buffer = cell<AudioBuffer | null>(null);
    super(ctx, { input: node, output: node, loading: true }, () => ({ params: {}, cells: { buffer: readonlyCell(buffer) }, latency: 0 }), opts);
    this.node = node;
    this._buffer = buffer;
    if (opts.buffer) this.buffer = opts.buffer;
    else if (opts.url) void this.load(opts.url).catch(() => {});
  }

  get buffer(): AudioBuffer | null {
    return this._buffer.value;
  }
  set buffer(b: AudioBuffer | null) {
    this.node.buffer = b;
    this._buffer.value = b;
    this.loadToken++;
    this.setReady(b !== null);
  }

  /** Loads the impulse response at `url` (cached per context); rejects with the fetch or decode error, which `cells.error` also holds. */
  load(url: string): Promise<void> {
    const token = ++this.loadToken;
    const work = cacheFor(this.context)
      .load(url)
      .then((buffer) => {
        if (this.disposed || token !== this.loadToken) return;
        this.buffer = buffer;
      });
    this.track(work);
    return this.ready;
  }

  override dispose(): void {
    this.disposed = true;
    super.dispose();
  }
}
