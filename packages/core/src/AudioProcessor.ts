import { computed as alienComputed, effect as alienEffect } from "alien-signals";
import type { ParamBind, ParamOptions, ComputedAccessor } from "./types";
import { Param } from "./Param";
import { SchedulableParam } from "./SchedulableParam";
import { Cell, type ReadonlyCell } from "./Cell";
import { defineGraph as defineGraphFn } from "./graph";
import type { EdgeList, GraphHandle, ValidateEdges } from "./graph";
import { addConnection, removeConnections } from "./connections";

// Registry constraints use `any` rather than `unknown` because Param<T>/Cell<T> have
// T in both reader and writer position, making them invariant in T. Subclasses still
// get exact per-key types; the constraint only describes "an object of params/cells".
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ParamRegistry = Record<string, Param<any>>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type CellRegistry = Record<string, Cell<any> | ReadonlyCell<any>>;

export interface BuildHelpers {
  param<T extends number>(options: Omit<ParamOptions<T>, "bind"> & { bind: AudioParam }): SchedulableParam;
  param<T>(options: ParamOptions<T> & { bind: ParamBind<T> }): Param<T>;
  param<T>(options: ParamOptions<T>): Param<T>;
  schedulableParam(options: Omit<ParamOptions<number>, "bind"> & { bind?: AudioParam }): SchedulableParam;
  cell<T>(initial: T): Cell<T>;
}

type Undeclared<Msg extends string> = { [K in Msg]: never };
export type BuildResult<P extends ParamRegistry, C extends CellRegistry> = (string extends keyof P
  ? { params?: Undeclared<"Error: params not declared — add a P type parameter to AudioProcessor"> }
  : { params: P }) &
  (string extends keyof C ? { cells?: Undeclared<"Error: cells not declared — add a C type parameter to AudioProcessor"> } : { cells: C }) & {
    latency?: number | Param<number>;
  };

export abstract class AudioProcessor<P extends ParamRegistry = ParamRegistry, C extends CellRegistry = CellRegistry> {
  readonly context: BaseAudioContext;
  readonly params: Readonly<P>;
  readonly cells: Readonly<C>;
  readonly latency: Param<number>;
  /** Whether the build callback supplied `latency` itself, rather than defaulting to 0. */
  readonly declaredLatency: boolean;

  private readonly _silencer: GainNode;
  private readonly _ownsLatency: boolean;
  private _constantSources = new Set<ConstantSourceNode>();
  private _effects: (() => void)[] = [];
  private _graphs: GraphHandle[] = [];
  // Direct wires to a bare AudioWorkletNode: it has unknowable latency, so it cannot join the latency graph.
  private _nativeWires: { to: AudioNode; output: number; input: number }[] = [];
  private _disposed = false;

  protected constructor(context: BaseAudioContext, build: (helpers: BuildHelpers) => BuildResult<P, C>) {
    this.context = context;

    this._silencer = new GainNode(context);
    this._silencer.gain.value = 0;
    this._silencer.connect(context.destination);

    const helpers: BuildHelpers = {
      param: (<T>(options: ParamOptions<T> & { bind?: ParamBind<T> | AudioParam }): Param<T> | SchedulableParam => {
        const { bind } = options;
        if (bind instanceof AudioParam) {
          return new SchedulableParam({
            default: options.default as number,
            audioContext: context,
            audioParam: bind,
            label: options.label,
            min: options.min,
            max: options.max,
            step: options.step,
            display: options.display as ((value: number) => string) | undefined,
          });
        }
        return new Param<T>(options as ParamOptions<T>);
      }) as BuildHelpers["param"],

      schedulableParam: (options) => {
        const { bind, ...rest } = options;
        if (bind) {
          return new SchedulableParam({
            ...rest,
            audioContext: context,
            audioParam: bind,
          });
        }
        // Unbound: create our own ConstantSourceNode kept alive by piping into the silencer.
        const cs = context.createConstantSource();
        cs.connect(this._silencer);
        cs.start();
        this._constantSources.add(cs);
        return new SchedulableParam({
          ...rest,
          audioContext: context,
          audioParam: cs.offset,
        });
      },

      cell: <T>(initial: T) => new Cell<T>(initial),
    };

    const result = build(helpers);
    this.params = Object.freeze("params" in result ? result.params : {}) as Readonly<P>;
    this.cells = Object.freeze("cells" in result ? result.cells : {}) as Readonly<C>;

    const declared = "latency" in result ? (result as { latency?: number | Param<number> }).latency : undefined;
    this.declaredLatency = declared !== undefined;
    this._ownsLatency = !(declared instanceof Param);
    this.latency = declared instanceof Param ? declared : new Param({ default: declared ?? 0 });
  }

  abstract get output(): AudioNode | undefined;

  get input(): AudioNode | undefined {
    return undefined;
  }

  protected computed<T>(fn: () => T): ComputedAccessor<T> {
    return alienComputed(fn);
  }

  protected effect(fn: () => void): () => void {
    const stop = alienEffect(fn);
    this._effects.push(stop);
    return stop;
  }

  protected defineGraph<const E extends EdgeList>(fn: () => readonly [...ValidateEdges<E>], opts?: { compensate?: boolean }): GraphHandle;
  protected defineGraph(fn: () => EdgeList, opts?: { compensate?: boolean }): GraphHandle {
    const handle = defineGraphFn(fn, { context: this.context, compensate: opts?.compensate, owner: this });
    this._graphs.push(handle);
    return handle;
  }

  /** Connects this processor's output to `destination` like AudioNode.connect and returns `destination`; a processor destination receives its `input`. The edge joins the latency graph, so delay compensation sees it. */
  connect<T extends AudioNode | AudioProcessor | AudioParam | SchedulableParam>(destination: T, output = 0, input = 0): T {
    const name = this.constructor.name;
    if (this._disposed) throw new Error(`${name} is disposed.`);
    const from = this.output;
    if (!from) throw new Error(`AudioProcessor.connect: ${name} has no output`);
    if (destination instanceof AudioProcessor && !destination.input) {
      throw new Error(`AudioProcessor.connect: ${destination.constructor.name} has no input`);
    }
    if (typeof AudioWorkletNode !== "undefined" && destination instanceof AudioWorkletNode) {
      if (!this._nativeWires.some((w) => w.to === destination && w.output === output && w.input === input)) {
        from.connect(destination, output, input);
        this._nativeWires.push({ to: destination, output, input });
      }
      return destination;
    }
    addConnection(this.context, this, destination, output, input);
    return destination;
  }

  /** Removes the connection made by connect(destination), or all of this processor's connections when omitted. */
  disconnect(destination?: AudioNode | AudioProcessor | AudioParam | SchedulableParam): void {
    removeConnections(this.context, (from, to) => from === this && (destination === undefined || to === destination));
    const out = this.output;
    const kept: typeof this._nativeWires = [];
    for (const wire of this._nativeWires) {
      if (destination === undefined || wire.to === destination) {
        try {
          out?.disconnect(wire.to, wire.output, wire.input);
        } catch {
          /* already gone */
        }
      } else kept.push(wire);
    }
    this._nativeWires = kept;
  }

  /** Stops, disconnects and releases everything this processor owns. Safe to call twice. */
  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    this.disconnect();
    removeConnections(this.context, (_from, to) => to === this);

    for (const graph of this._graphs) {
      graph.dispose();
    }
    this._graphs = [];

    for (const stop of this._effects) {
      stop();
    }
    this._effects = [];

    for (const param of Object.values(this.params)) {
      param.dispose();
    }

    // A caller-supplied Param belongs to their own params registry (or their own
    // ownership) and is disposed there; only the one we created ourselves is ours to stop.
    if (this._ownsLatency) {
      this.latency.dispose();
    }

    for (const source of this._constantSources) {
      try {
        source.stop();
      } catch {
        /* already stopped */
      }
      source.disconnect();
    }
    this._constantSources = new Set();
    this._silencer.disconnect();
  }

  [Symbol.dispose](): void {
    this.dispose();
  }
}
