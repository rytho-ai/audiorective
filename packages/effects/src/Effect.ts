import {
  AudioProcessor,
  cell,
  readonlyCell,
  untracked,
  type BuildHelpers,
  type BuildResult,
  type Cell,
  type Param,
  type ReadonlyCell,
  type SchedulableParam,
} from "@audiorective/core";
import { fadeTo, SMOOTHING } from "./internal/smoothing";

// Registry constraints mirror core's (invariant Param<T>/Cell<T> need `any`).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ParamRegistry = Record<string, Param<any>>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type CellRegistry = Record<string, import("@audiorective/core").Cell<any> | import("@audiorective/core").ReadonlyCell<any>>;

/** `"loading"` until the effect can process audio (an impulse response, worklet or wasm engine still arriving), `"error"` when that failed. */
export type EffectStatus = "loading" | "ready" | "error";

export interface WetArm {
  input: AudioNode | AudioProcessor;
  output: AudioNode | AudioProcessor;
  /** Start in `"loading"` with the wet arm muted until `track()` resolves. Default false. */
  loading?: boolean;
}

export interface EffectOptions {
  /** Initial wet mix 0..1. Default 1; wet writes smooth over 10 ms automatically. */
  wet?: number;
  /** Start bypassed. Default false. */
  bypass?: boolean;
}

type EffectParams<P> = P & {
  /** Linear wet/dry mix 0..1, default 1; writes smooth over 10 ms automatically, scheduled ramps stay exact. */
  wet: SchedulableParam;
  /** Fades to the full dry signal without changing settings. Default false. */
  bypass: Param<boolean>;
};
type EffectCells<C> = C & { status: ReadonlyCell<EffectStatus>; error: ReadonlyCell<Error | null> };

/** Time constant of the bypass/ready gate, seconds: about 15 ms to settle. */
const GATE = 0.003;

const detachedInitializers = new WeakMap<object, () => void>();

/** @internal Initialize a detached snapshot without turning its saved bypass into a live fade. */
export function initializeEffectSnapshot(effect: object): void {
  untracked(() => detachedInitializers.get(effect)?.());
}

/**
 * Base for every effect: stable `input`/`output` gains and a linear wet/dry
 * crossfade. `wet` is one automation signal that drives the wet gain directly
 * and the dry gain as `1 − wet`, so ramps land sample-accurately on both arms.
 * `params.bypass` fades the effect out of the sound without a click and keeps its settings;
 * while `cells.status` is not `"ready"` only the wet arm is muted: dry stays at `1 − wet`,
 * so a fully wet return stays silent. Bypass always passes the full dry signal.
 * Wet writes smooth over 10 ms automatically (`smoothing = 0.01`); scheduled ramps stay exact.
 * The graph is compensated, so a latent wet arm delays the dry arm to match and
 * the effect's own latency (when not declared) derives to the wet arm's.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export abstract class Effect<P extends ParamRegistry = {}, C extends CellRegistry = {}> extends AudioProcessor<EffectParams<P>, EffectCells<C>> {
  /** Name `toJSON()` writes and `EffectChain.fromJSON` and `chain.restore` look up. Built-in effects set it; a custom subclass falls back to its class name. */
  static readonly type: string | undefined = undefined;

  private readonly _input: GainNode;
  private readonly _output: GainNode;
  private readonly _sources: ConstantSourceNode[];
  private readonly _mixControl: { dry: readonly AudioNode[]; wet: AudioNode; wetValue: AudioParam; enabled: AudioParam };
  private readonly _mixCleanups: Array<() => void> = [];
  private readonly _status: Cell<EffectStatus>;
  private readonly _error: Cell<Error | null>;
  private _ready: Promise<void> = Promise.resolve();
  private _resolveReady: (() => void) | undefined;
  private _token = 0;
  private _gone = false;

  protected constructor(
    ctx: BaseAudioContext,
    arm: WetArm,
    build: (h: BuildHelpers) => { params: P; cells: C; latency?: number | Param<number> },
    opts: EffectOptions = {},
  ) {
    const input = new GainNode(ctx);
    const output = new GainNode(ctx);
    const dry = new GainNode(ctx, { gain: 0 }); // driven by 1 − wet·enabled
    const wetGain = new GainNode(ctx, { gain: 0 }); // driven by wet·enabled·ready
    const one = new ConstantSourceNode(ctx, { offset: 1 });
    const negate = new GainNode(ctx, { gain: -1 });
    const wetSignal = new ConstantSourceNode(ctx, { offset: opts.wet ?? 1 });
    const enabled = new ConstantSourceNode(ctx, { offset: opts.bypass ? 0 : 1 });
    const ready = new ConstantSourceNode(ctx, { offset: arm.loading ? 0 : 1 });
    const wetScaled = new GainNode(ctx, { gain: 0 });
    const wetReady = new GainNode(ctx, { gain: 0 });
    one.start();
    wetSignal.start();
    enabled.start();
    ready.start();
    const status = cell<EffectStatus>(arm.loading ? "loading" : "ready");
    const error = cell<Error | null>(null);

    super(ctx, (h) => {
      const built = build(h);
      const wet = h.param({ default: opts.wet ?? 1, bind: wetSignal.offset, min: 0, max: 1, smoothing: SMOOTHING });
      const bypass = h.param<boolean>({ default: opts.bypass ?? false });
      const result: { params: EffectParams<P>; cells: EffectCells<C>; latency?: number | Param<number> } = {
        params: { ...built.params, wet, bypass },
        cells: { ...built.cells, status: readonlyCell(status), error: readonlyCell(error) },
      };
      if (built.latency !== undefined) result.latency = built.latency;
      return result as unknown as BuildResult<EffectParams<P>, EffectCells<C>>;
    });

    this._input = input;
    this._output = output;
    this._status = status;
    this._error = error;
    if (arm.loading) this.setReady(false);

    // `arm.input` may be an AudioProcessor; as a sink it must resolve to a concrete
    // node here (the processor itself still appears as the `arm.output` source below,
    // so its latency still flows into the graph).
    const armInput = arm.input instanceof AudioProcessor ? arm.input.input : arm.input;
    if (!armInput) throw new Error("Effect: wet arm's input processor has no input node");

    this.defineGraph(
      () => [
        [input, dry],
        [dry, output],
        [input, armInput],
        [arm.output, wetGain],
        [wetGain, output],
        [wetSignal, wetScaled],
        [enabled, wetScaled.gain],
        [wetScaled, wetReady],
        [ready, wetReady.gain],
        [wetReady, wetGain.gain],
        [wetScaled, negate],
        [negate, dry.gain],
        [one, dry.gain],
      ],
      { compensate: true },
    );

    this.effect(() => {
      fadeTo(ctx, enabled.offset, this.params.bypass.value ? 0 : 1, GATE);
    });
    this.effect(() => fadeTo(ctx, ready.offset, status.value === "ready" ? 1 : 0, GATE));

    this._sources = [one, wetSignal, enabled, ready];
    this._mixControl = { dry: [one, negate], wet: wetReady, wetValue: wetSignal.offset, enabled: enabled.offset };
    detachedInitializers.set(this, () => {
      const now = ctx.currentTime;
      enabled.offset.cancelScheduledValues(now);
      enabled.offset.setValueAtTime(this.params.bypass.value ? 0 : 1, now);
    });
  }

  /** Internal audio-rate mix coefficients for a subclass's applied-gain meter; these are the same signals that drive the audible mix. */
  protected connectMixControls(dry: AudioNode, wet: AudioNode): void {
    const wires = [...this._mixControl.dry.map((source) => ({ source, destination: dry })), { source: this._mixControl.wet, destination: wet }];
    for (const { source, destination } of wires) source.connect(destination);
    this._mixCleanups.push(() => {
      for (const { source, destination } of wires) source.disconnect(destination);
    });
  }

  /** The native dry coefficient while no processing engine can report a meter yet. */
  protected get dryMixValue(): number {
    return Math.max(0, 1 - this._mixControl.wetValue.value * this._mixControl.enabled.value);
  }

  override get input(): GainNode {
    return this._input;
  }

  get output(): GainNode {
    return this._output;
  }

  /** Resolves once `cells.status` is `"ready"`; rejects with the cause when loading failed. Already resolved for an effect that never loads. */
  get ready(): Promise<void> {
    return this._ready;
  }

  /** Marks the effect `"loading"` until `work` settles, then `"ready"` or `"error"`. The latest call wins. */
  protected track(work: Promise<unknown>): void {
    const token = ++this._token;
    this._status.value = "loading";
    this._error.value = null;
    const done = work.then(
      () => {
        if (token === this._token && !this._gone) this._status.value = "ready";
      },
      (cause: unknown) => {
        if (token === this._token && !this._gone) {
          this._error.value = cause instanceof Error ? cause : new Error("Effect failed to load.", { cause });
          this._status.value = "error";
        }
        throw cause;
      },
    );
    done.catch(() => {});
    this._ready = done;
  }

  /** Sets `"ready"` or `"loading"` directly, for effects whose readiness is a state rather than a promise. */
  protected setReady(ready: boolean): void {
    this._token++;
    this._error.value = null;
    this._status.value = ready ? "ready" : "loading";
    if (ready) {
      this._resolveReady?.();
      this._resolveReady = undefined;
      this._ready = Promise.resolve();
    } else if (!this._resolveReady) {
      this._ready = new Promise<void>((resolve) => (this._resolveReady = resolve));
    }
  }

  override dispose(): void {
    this._gone = true;
    detachedInitializers.delete(this);
    for (const cleanup of this._mixCleanups.splice(0)) cleanup();
    for (const s of this._sources) {
      s.stop();
      s.disconnect();
    }
    super.dispose();
  }
}
