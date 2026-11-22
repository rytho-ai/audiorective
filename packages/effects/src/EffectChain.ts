import { AudioProcessor, batch, Param, SchedulableParam, cell, readonlyCell, untracked, type Cell, type ReadonlyCell } from "@audiorective/core";
import { Effect, initializeEffectSnapshot } from "./Effect";
import { LEAD } from "./internal/smoothing";

/** Common effect type for heterogeneous insert lists and shared wet/bypass controls. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyEffect = Effect<Record<string, Param<any>>, Record<string, Cell<any> | ReadonlyCell<any>>>;

/** What `EffectChain.fromJSON` and `chain.restore` build an effect from: an `Effect` class, or a function returning a configured instance. */
export type EffectType = (new (context: BaseAudioContext) => AnyEffect) | ((context: BaseAudioContext) => AnyEffect);

export interface EffectChainOptions {
  /** Aborting disposes the chain and every effect in it. */
  signal?: AbortSignal;
}

/** One effect's saved state: its type name and every primitive parameter value (`bypass` and `wet` included). */
export interface EffectChainJSONEffect {
  type: string;
  params: Record<string, number | string | boolean>;
}

export interface EffectChainJSON {
  version: 1;
  effects: EffectChainJSONEffect[];
}

/** A preset problem reported by `EffectChain.fromJSON` or `chain.restore`: `path` locates it in the JSON, e.g. `effects[2].params.frequency`. */
export interface EffectChainIssue {
  path: string;
  message: string;
}

export interface EffectChainFromJSONOptions extends EffectChainOptions {
  /** Maps the `type` names in the JSON to the classes (or factories) that build them. */
  types: Record<string, EffectType>;
}

/** One live-preset job; aborting leaves the chain alive and its current preset unchanged. */
export interface EffectChainRestoreOptions {
  /** Maps saved type names to effect classes or factories that create new instances. */
  types: Record<string, EffectType>;
  /** Cancels only this pending restore, not the chain. */
  signal?: AbortSignal;
}

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const restoreAborted = () => new DOMException("EffectChain restore was cancelled.", "AbortError");

/** Link gains settle with this time constant, seconds; a hand-over takes about 6 of them. */
const GATE = 0.003;
const FADE = 6 * GATE;

type End = AnyEffect | null; // null: the chain's own input or output
interface Link {
  from: End;
  to: End;
  gain: GainNode;
}

const typeName = (effect: AnyEffect): string => (effect.constructor as typeof Effect).type ?? effect.constructor.name;

/**
 * An ordered chain of effects between `input` and `output`. The chain owns its effects: `remove` and `dispose` dispose them.
 * Every edit is a short crossfade, so adding, removing or moving an effect never clicks, drops the signal or opens a
 * feedback loop, and the other effects keep their state (a delay's echoes keep ringing). A move runs as a removal followed
 * by an insertion, one after the other. Effects inside a chain take stereo input (a mono source is upmixed).
 */
export class EffectChain extends AudioProcessor<Record<never, never>, { effects: ReadonlyCell<readonly AnyEffect[]> }> {
  private readonly _input: GainNode;
  private readonly _output: GainNode;
  private readonly list: Cell<readonly AnyEffect[]>;
  private readonly links: Link[] = [];
  /** The wiring as built so far; `cells.effects` is the order the edits will end in. */
  private readonly order: AnyEffect[] = [];
  private readonly queue: Array<(t: number, step: number) => void> = [];
  private readonly owned = new Set<AnyEffect>();
  private pendingRestore: { cancel(): void } | undefined;
  private readonly releases = new Set<() => void>();
  private readonly suspends = new Map<number, Array<() => void>>();
  private readonly latencyParam: Param<number>;
  private busyUntil = 0;
  private gone = false;
  private readonly abort: (() => void) | undefined;
  private readonly signal: AbortSignal | undefined;

  constructor(context: BaseAudioContext, effects: readonly AnyEffect[] = [], options: EffectChainOptions = {}) {
    const list = cell<readonly AnyEffect[]>(Object.freeze([]));
    const latency = new Param<number>({ default: 0 });
    super(context, () => ({ params: {}, cells: { effects: readonlyCell(list) }, latency }));
    this.list = list;
    this.latencyParam = latency;
    this._input = new GainNode(context);
    this._output = new GainNode(context);

    const seen = new Set<AnyEffect>();
    for (const effect of effects) {
      if (seen.has(effect)) throw new Error("EffectChain: effect is already in the chain.");
      seen.add(effect);
      this.owned.add(effect);
    }
    let previous: End = null;
    for (const effect of [...effects, null]) {
      this.connectLink(previous, effect, 1);
      previous = effect;
    }
    list.value = Object.freeze([...effects]);
    this.order.push(...effects);
    this.effect(() => {
      let total = 0;
      for (const effect of list.value) total += effect.latency.value;
      latency.value = total;
    });

    this.signal = options.signal;
    if (options.signal) {
      this.abort = () => this.dispose();
      if (options.signal.aborted) this.dispose();
      else options.signal.addEventListener("abort", this.abort, { once: true });
    }
  }

  override get input(): GainNode {
    return this._input;
  }

  get output(): GainNode {
    return this._output;
  }

  /** Inserts `effect` at `index` (default: the end; clamped to the chain's length). */
  add(effect: AnyEffect, index?: number): void {
    this.assertAlive();
    if (this.owned.has(effect)) throw new Error("EffectChain: effect is already in the chain.");
    this.owned.add(effect);
    const at = this.clamp(index, this.currentEffects.length);
    this.publish((order) => order.splice(at, 0, effect));
    this.queue.push((t, step) => this.insert(effect, at, t, step));
    this.pump();
  }

  /** Takes `effect` out and disposes it once its tail has faded. */
  remove(effect: AnyEffect): void {
    this.assertAlive();
    this.assertMember(effect);
    this.publish((order) => order.splice(order.indexOf(effect), 1));
    this.queue.push((t, step) => this.take(effect, true, t, step));
    this.pump();
  }

  /** Moves `effect` to `index` (clamped); the others keep their order. */
  move(effect: AnyEffect, index: number): void {
    this.assertAlive();
    this.assertMember(effect);
    const target = this.clamp(index, this.currentEffects.length - 1);
    if (this.currentEffects.indexOf(effect) === target) return;
    this.publish((order) => order.splice(target, 0, ...order.splice(order.indexOf(effect), 1)));
    this.queue.push((t, step) => this.take(effect, false, t, step));
    this.queue.push((t, step) => this.insert(effect, target, t, step));
    this.pump();
  }

  /** The chain as plain data: each effect's type name and primitive parameter values, in order. */
  toJSON(): EffectChainJSON {
    return {
      version: 1,
      effects: this.list.value.map((effect) => {
        const params: Record<string, number | string | boolean> = {};
        for (const [name, param] of Object.entries(effect.params as Record<string, Param<unknown>>)) {
          const value = param.value;
          if (typeof value === "number" || typeof value === "string" || typeof value === "boolean") params[name] = value;
        }
        return { type: typeName(effect), params };
      }),
    };
  }

  /**
   * Constructs a separate chain, recovering valid parts and reporting skipped bad data.
   * This factory does not replace an existing live chain; use its `restore()` method for that.
   * Saved values initialize detached effects immediately; later writes retain normal smoothing.
   */
  static fromJSON(context: BaseAudioContext, json: unknown, options: EffectChainFromJSONOptions): { chain: EffectChain; issues: EffectChainIssue[] } {
    const { effects, issues } = EffectChain.build(context, json, options.types, false);
    return { chain: new EffectChain(context, effects, { signal: options.signal }), issues };
  }

  /**
   * Transactionally loads a preset into this chain's stable input/output. Malformed data or a
   * readiness failure returns issues, disposes the candidate effects, and leaves the live chain alone.
   * The latest pending request wins; supersession, `signal`, or disposal rejects with AbortError.
   * Resolves after the target list is published and its crossfades are queued, not after they finish.
   */
  async restore(json: unknown, options: EffectChainRestoreOptions): Promise<EffectChainIssue[]> {
    this.assertAlive();
    this.pendingRestore?.cancel();
    if (options.signal?.aborted) throw restoreAborted();
    const candidates = new Set<AnyEffect>();
    const issues: EffectChainIssue[] = [];
    let active = true;
    let rejectAbort!: (error: DOMException) => void;
    const cancelled = new Promise<never>((_resolve, reject) => {
      rejectAbort = reject;
    });
    void cancelled.catch(() => {});
    const discard = () => {
      for (const effect of [...candidates]) {
        candidates.delete(effect);
        try {
          effect.dispose();
        } catch (cause) {
          issues.push({ path: "", message: `could not dispose candidate: ${cause instanceof Error ? cause.message : String(cause)}` });
        }
      }
    };
    const job = {
      cancel: () => {
        if (!active) return;
        active = false;
        rejectAbort(restoreAborted());
        discard();
      },
    };
    const onAbort = () => job.cancel();
    this.pendingRestore = job;
    options.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const built = EffectChain.build(this.context, json, options.types, true, this.owned);
      for (const effect of built.effects) candidates.add(effect);
      issues.push(...built.issues);
      if (!active) throw restoreAborted();
      if (issues.length) return issues;
      const ready = Promise.all(
        built.effects.map(async (effect, index) => {
          try {
            await effect.ready;
          } catch (cause) {
            if (active)
              issues.push({
                path: `effects[${index}]`,
                message: `could not prepare ${typeName(effect)}: ${cause instanceof Error ? cause.message : String(cause)}`,
              });
            throw cause;
          }
        }),
      );
      try {
        await Promise.race([ready, cancelled]);
      } catch {
        if (!active) throw restoreAborted();
        return issues;
      }
      if (!active) throw restoreAborted();
      if (issues.length) return issues;
      // Ownership and the complete job batch precede publication: a subscriber's edit
      // may enqueue after this batch, but can never interleave with its internal work.
      const previous = [...this.currentEffects];
      const edits: Array<(t: number, step: number) => void> = [
        ...previous.map((effect) => (t: number, step: number) => this.take(effect, true, t, step)),
        ...built.effects.map((effect, index) => (t: number, step: number) => this.insert(effect, index, t, step)),
      ];
      active = false;
      options.signal?.removeEventListener("abort", onAbort);
      if (this.pendingRestore === job) this.pendingRestore = undefined;
      for (const effect of built.effects) this.owned.add(effect);
      candidates.clear();
      batch(() => {
        this.queue.push(...edits);
        this.list.value = Object.freeze([...built.effects]);
      });
      this.pump();
      return [];
    } finally {
      active = false;
      options.signal?.removeEventListener("abort", onAbort);
      if (this.pendingRestore === job) this.pendingRestore = undefined;
      discard();
    }
  }

  private static build(
    context: BaseAudioContext,
    json: unknown,
    types: Record<string, EffectType>,
    strict: boolean,
    forbidden: ReadonlySet<AnyEffect> = new Set(),
  ): { effects: AnyEffect[]; issues: EffectChainIssue[] } {
    const issues: EffectChainIssue[] = [],
      effects: AnyEffect[] = [];
    const seen = new Set<AnyEffect>();
    const extraKeys = (value: Record<string, unknown>, keys: string[], path: string) => {
      for (const key of Object.keys(value))
        if (!keys.includes(key)) issues.push({ path: path ? `${path}.${key}` : key, message: "unknown property" });
    };
    try {
      if (!record(json) || json.version !== 1 || !Array.isArray(json.effects)) {
        issues.push({ path: "", message: "expected { version: 1, effects: [...] }" });
        return { effects, issues };
      }
      if (strict) extraKeys(json, ["version", "effects"], "");
      for (let i = 0; i < json.effects.length; i++) {
        const entry: unknown = json.effects[i],
          path = `effects[${i}]`;
        if (!record(entry)) {
          issues.push({ path, message: "expected { type, params }" });
          continue;
        }
        if (strict) extraKeys(entry, ["type", "params"], path);
        const type = entry.type;
        const make = typeof type === "string" && Object.hasOwn(types, type) ? types[type] : undefined;
        if (!make) {
          issues.push({ path: `${path}.type`, message: `unknown type ${JSON.stringify(type)}` });
          continue;
        }
        const params = entry.params;
        if (strict && !record(params)) {
          issues.push({ path: `${path}.params`, message: "expected an object" });
          continue;
        }
        let effect: AnyEffect;
        try {
          effect =
            (make as { prototype?: unknown }).prototype instanceof Effect
              ? new (make as new (context: BaseAudioContext) => AnyEffect)(context)
              : (make as (context: BaseAudioContext) => AnyEffect)(context);
        } catch (cause) {
          issues.push({ path, message: `could not build ${type}: ${cause instanceof Error ? cause.message : String(cause)}` });
          continue;
        }
        if (!(effect instanceof Effect)) {
          issues.push({ path, message: `could not build ${type}: factory must return an Effect` });
          continue;
        }
        if (forbidden.has(effect)) {
          issues.push({ path, message: "factory must create a new effect, not an effect owned by the live chain" });
          continue;
        }
        if (seen.has(effect)) {
          issues.push({ path, message: "factory returned the same effect twice" });
          continue;
        }
        seen.add(effect);
        if (effect.context !== context) {
          effect.dispose();
          issues.push({ path, message: "effect belongs to another audio context" });
          continue;
        }
        effects.push(effect);
        if (params !== undefined && !record(params)) {
          issues.push({ path: `${path}.params`, message: "expected an object" });
          continue;
        }
        for (const [name, value] of Object.entries(params ?? {})) {
          if (!["number", "string", "boolean"].includes(typeof value) || (typeof value === "number" && !Number.isFinite(value))) {
            issues.push({ path: `${path}.params.${name}`, message: "expected a finite number, string or boolean" });
            continue;
          }
          const problem = EffectChain.apply(effect, name, value);
          if (problem) issues.push({ path: `${path}.params.${name}`, message: problem });
        }
      }
    } catch (cause) {
      issues.push({ path: "", message: `could not read preset: ${cause instanceof Error ? cause.message : String(cause)}` });
    }
    // Saved bypass is initial state too: settle its native gate after all detached
    // parameter writes, before fromJSON or live restore can expose the candidate.
    for (const effect of effects) initializeEffectSnapshot(effect);
    return { effects, issues };
  }

  private static apply(effect: AnyEffect, name: string, value: unknown): string | undefined {
    const param = Object.hasOwn(effect.params, name) ? (effect.params[name] as Param<unknown>) : undefined;
    if (!param) return "unknown parameter";
    const current = param.value;
    if (typeof value !== typeof current || (typeof value === "number" && !Number.isFinite(value))) return `expected a ${typeof current}`;
    if (typeof value === "number" && ((param.min !== undefined && value < param.min) || (param.max !== undefined && value > param.max)))
      return `outside ${param.min ?? "-Infinity"}..${param.max ?? "Infinity"}`;
    const schedulable = param instanceof SchedulableParam ? param : undefined;
    const smoothing = schedulable?.smoothing ?? 0;
    // These effects are still detached: saved settings are their initial state,
    // not a live edit that should ramp from the constructor's defaults.
    if (schedulable) schedulable.smoothing = 0;
    try {
      param.value = value;
    } catch (cause) {
      // A reactive bind may reject after the signal has already changed.
      // Restore the prior value as well as reporting the rejected setting.
      try {
        param.value = current;
      } catch {
        // A custom bind can also reject rollback; bad input still becomes an issue.
      }
      return `invalid value: ${cause instanceof Error ? cause.message : String(cause)}`;
    } finally {
      if (schedulable) schedulable.smoothing = smoothing;
    }
    return undefined;
  }

  override dispose(): void {
    if (this.gone) return;
    this.gone = true;
    this.pendingRestore?.cancel();
    if (this.abort) this.signal?.removeEventListener("abort", this.abort);
    for (const effect of [...this.owned]) this.releaseEffect(effect);
    for (const release of [...this.releases]) release();
    this.releases.clear();
    this.queue.length = 0;
    for (const link of this.links.splice(0)) link.gain.disconnect();
    this.list.value = Object.freeze([]);
    this._input.disconnect();
    this._output.disconnect();
    super.dispose();
    this.latencyParam.dispose();
  }

  private releaseEffect(effect: AnyEffect): void {
    if (this.owned.delete(effect)) effect.dispose();
  }

  private get currentEffects(): readonly AnyEffect[] {
    return untracked(() => this.list.value);
  }

  private assertAlive(): void {
    if (this.gone) throw new Error("EffectChain is disposed.");
  }

  private assertMember(effect: AnyEffect): void {
    if (!this.currentEffects.includes(effect)) throw new Error("EffectChain: effect is not in this chain.");
  }

  private clamp(index: number | undefined, max: number): number {
    return Math.min(Math.max(Math.trunc(index ?? max), 0), max);
  }

  private publish(change: (order: AnyEffect[]) => unknown): void {
    const order = [...this.currentEffects];
    change(order);
    this.list.value = Object.freeze(order);
  }

  private source(end: End): AudioNode {
    return end ? end.output : this._input;
  }

  private sink(end: End): AudioNode {
    return end ? end.input : this._output;
  }

  private connectLink(from: End, to: End, gain: number): Link {
    // An effect in a chain always takes stereo: a second source that changed its input's channel count would reset the state of the filters behind it.
    if (to) Object.assign(to.input, { channelCount: 2, channelCountMode: "explicit" });
    const node = new GainNode(this.context, { gain });
    this.source(from).connect(node);
    node.connect(this.sink(to));
    const link = { from, to, gain: node };
    this.links.push(link);
    return link;
  }

  private findLink(from: End, to: End): Link {
    return this.links.find((link) => link.from === from && link.to === to)!;
  }

  /** Fades a link at `at`; `at` 0 means the clock has not run, so the gain just takes its value. */
  private fade(link: Link, target: 0 | 1, at: number): void {
    if (at === 0) link.gain.gain.value = target;
    else link.gain.gain.setTargetAtTime(target, at, GATE);
  }

  private retire(link: Link, at: number): void {
    this.fade(link, 0, at);
    this.links.splice(this.links.indexOf(link), 1);
    this.after(at === 0 ? 0 : at + FADE, () => {
      this.source(link.from).disconnect(link.gain);
      link.gain.disconnect();
    });
  }

  /** Runs `work` once the context clock passes `time`, and always before `dispose` returns. */
  private after(time: number, work: () => void): void {
    if (time === 0) return work();
    const release = () => {
      if (this.releases.delete(release)) work();
    };
    this.releases.add(release);
    this.at(time, release);
  }

  /** Calls `work` when the context clock reaches `time`: a timer for a live context, a suspend point for an offline one. */
  private at(time: number, work: () => void): void {
    const context = this.context;
    if (typeof OfflineAudioContext !== "undefined" && context instanceof OfflineAudioContext) {
      const frame = Math.ceil((time * context.sampleRate) / 128) * 128;
      const waiting = this.suspends.get(frame);
      if (waiting) return void waiting.push(work);
      this.suspends.set(frame, [work]);
      context
        .suspend(frame / context.sampleRate)
        .then(() => {
          for (const job of this.suspends.get(frame) ?? []) if (!this.gone) job();
          this.suspends.delete(frame);
          return context.resume();
        })
        .catch(() => this.suspends.delete(frame)); // rendering already finished: nothing left to do
      return;
    }
    setTimeout(
      () => {
        if (this.gone) return;
        if (context.state !== "closed" && context.currentTime < time) this.at(time, work);
        else work();
      },
      Math.max(0, (time - context.currentTime) * 1000) + 5,
    );
  }

  /** Runs queued edits one at a time, each only after the previous hand-over has finished. */
  private pump(): void {
    while (!this.gone && this.queue.length) {
      const now = this.context.currentTime;
      if (this.busyUntil > now) {
        this.at(this.busyUntil, () => this.pump());
        return;
      }
      // Before the clock has run there is nothing to crossfade: the edit lands at once (t = 0).
      const t = now === 0 ? 0 : now + LEAD;
      this.busyUntil = t === 0 ? 0 : t + 2 * FADE;
      this.queue.shift()!(t, t === 0 ? 0 : FADE);
    }
  }

  /** Insertion: the effect's output joins first (it carries only a tail), then its input takes over from the bridge. */
  private insert(effect: AnyEffect, at: number, t: number, step: number): void {
    const order = this.order;
    const before: End = at === 0 ? null : order[at - 1]!;
    const after: End = at === order.length ? null : order[at]!;
    const bridge = this.findLink(before, after);
    const out = this.connectLink(effect, after, 0);
    const into = this.connectLink(before, effect, 0);
    this.fade(out, 1, t);
    this.fade(into, 1, t + step);
    this.retire(bridge, t + step);
    order.splice(at, 0, effect);
  }

  /** Removal: the bridge takes over from the effect's input first, then its tail fades out of the exit link. */
  private take(effect: AnyEffect, dispose: boolean, t: number, step: number): void {
    const order = this.order;
    const at = order.indexOf(effect);
    const before: End = at === 0 ? null : order[at - 1]!;
    const after: End = at === order.length - 1 ? null : order[at + 1]!;
    const into = this.findLink(before, effect);
    const out = this.findLink(effect, after);
    const bridge = this.connectLink(before, after, 0);
    this.fade(bridge, 1, t);
    this.retire(into, t);
    this.retire(out, t + step);
    order.splice(at, 1);
    if (dispose) this.after(t === 0 ? 0 : t + 2 * FADE, () => this.releaseEffect(effect));
  }
}
