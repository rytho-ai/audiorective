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

export class Convolver extends Effect<{}, { isReady: ReadonlyCell<boolean>; buffer: ReadonlyCell<AudioBuffer | null> }> {
  private readonly node: ConvolverNode;
  private loadToken = 0;
  private disposed = false;
  private readonly _buffer: Cell<AudioBuffer | null>;
  /** Resolves once the initial `url` (if any) has loaded. */
  readonly ready: Promise<void>;

  constructor(ctx: BaseAudioContext, opts: ConvolverOptions = {}) {
    const node = new ConvolverNode(ctx, { disableNormalization: opts.normalize === false });
    const buffer = cell<AudioBuffer | null>(null);
    super(
      ctx,
      { input: node, output: node },
      () => ({ params: {}, cells: { isReady: readonlyCell(() => buffer.value !== null), buffer: readonlyCell(buffer) }, latency: 0 }),
      opts,
    );
    this.node = node;
    this._buffer = buffer;
    if (opts.buffer) this.buffer = opts.buffer;
    this.ready = opts.url ? this.load(opts.url) : Promise.resolve();
  }

  get buffer(): AudioBuffer | null {
    return this._buffer.value;
  }
  set buffer(b: AudioBuffer | null) {
    this.node.buffer = b;
    this._buffer.value = b;
  }

  async load(url: string): Promise<void> {
    const token = ++this.loadToken;
    const buffer = await cacheFor(this.context).load(url);
    if (this.disposed || token !== this.loadToken) return;
    this.buffer = buffer;
  }

  override dispose(): void {
    this.disposed = true;
    super.dispose();
  }
}
