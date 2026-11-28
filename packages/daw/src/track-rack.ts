import { batch, cell, readonlyCell, untracked, type Cell, type ReadonlyCell } from "@audiorective/core";
import { EffectChain, Equalizer, Filter, PingPongDelay } from "@audiorective/effects";
import {
  noMacros,
  normalizeRackPreset,
  normalizeRackEffects,
  retainRackMacroTargets,
  type RackEffect,
  type RackMacroParameter,
  type RackMacroSettings,
  type RackPreset,
} from "./rack-preset";
import { LiveRackMacro, type MacroTarget, type RackMacro } from "./rack-macro";
export type { RackMacro };

type RackNode = { type: "filter"; processor: Filter } | { type: "delay"; processor: PingPongDelay } | { type: "eq"; processor: Equalizer };
function bindMacroTarget(mapping: RackMacroSettings["targets"][number], node: RackNode, slot: RackEffect): MacroTarget {
  const { parameter } = mapping;
  if (parameter === "wet") return { mapping, param: node.processor.params.wet, muted: !slot.enabled };
  if (node.type === "filter" && (parameter === "frequency" || parameter === "q"))
    return { mapping, param: node.processor.params[parameter === "q" ? "Q" : "frequency"], muted: false };
  if (node.type === "delay" && (parameter === "delayTime" || parameter === "feedback"))
    return { mapping, param: node.processor.params[parameter], muted: false };
  throw new Error("TrackRack macro target is unavailable.");
}

/** A track's ordered built-in inserts and macros, kept in line with Project data. The rack owns its effects and borrows its context. */
export class TrackRack {
  private readonly settings: Cell<readonly RackEffect[]>;
  private readonly macroCells: Cell<readonly RackMacro[]>;
  readonly cells: { effects: ReadonlyCell<readonly RackEffect[]>; macros: ReadonlyCell<readonly RackMacro[]> };
  private chain!: EffectChain;
  private macroDefinitions: readonly RackMacroSettings[] = noMacros;
  private macros = new Map<string, LiveRackMacro>();
  private macroSink?: GainNode;
  private nodes = new Map<string, RackNode>();
  private disposed = false;

  constructor(
    private readonly context: BaseAudioContext,
    effects: readonly RackEffect[] = [],
    macros: readonly RackMacroSettings[] = noMacros,
  ) {
    const settings = cell<readonly RackEffect[]>(Object.freeze([]));
    const macroCells = cell<readonly RackMacro[]>(Object.freeze([]));
    this.settings = settings;
    this.macroCells = macroCells;
    this.cells = { effects: readonlyCell(settings), macros: readonlyCell(macroCells) };
    try {
      this.setPreset({ effects, macros });
    } catch (error) {
      this.dispose();
      throw error;
    }
  }

  get input(): GainNode {
    return this.chain.input;
  }

  get output(): GainNode {
    return this.chain.output;
  }

  get effects(): readonly RackEffect[] {
    return this.cells.effects.value;
  }

  macro(id: string): RackMacro | undefined {
    return this.cells.macros.value.find((macro) => macro.id === id);
  }

  /** Capture current macro positions and effect settings as portable rack data. */
  capturePreset(): Required<RackPreset> {
    const effects = this.effects;
    void this.cells.macros.value;
    const macros = Object.freeze([...this.macros.values()].map((macro) => macro.snapshot()));
    return Object.freeze({ version: 1, effects, macros });
  }

  setPreset(preset: RackPreset): void {
    this.assertAlive();
    const { effects, macros } = normalizeRackPreset(preset);
    this.apply(effects, macros, true);
  }

  /** Read a filter's live response by slot ID. Returns false for an absent or non-filter slot. */
  readFilterResponse(
    slotId: string,
    frequencies: Float32Array<ArrayBuffer>,
    magnitudes: Float32Array<ArrayBuffer>,
    phases: Float32Array<ArrayBuffer>,
  ): boolean {
    void this.cells.effects.value;
    const slot = this.nodes.get(slotId);
    if (!slot || slot.type === "delay") return false;
    slot.processor.getFrequencyResponse(frequencies, magnitudes, phases);
    return true;
  }

  /** Existing slots retain their processors across parameter, bypass and order changes. */
  setEffects(effects: readonly RackEffect[]): void {
    this.assertAlive();
    const settings = normalizeRackEffects(effects);
    const macros = retainRackMacroTargets(settings, this.macroDefinitions);
    this.apply(settings, macros, false);
  }

  private assertAlive(): void {
    if (this.disposed) throw new Error("TrackRack is disposed.");
  }

  private apply(settings: readonly RackEffect[], macros: readonly RackMacroSettings[], recall: boolean): void {
    const next = new Map<string, RackNode>();
    const created: RackNode[] = [];
    const macroNodes = new Map<string, LiveRackMacro>();
    const createdMacros: LiveRackMacro[] = [];
    let newSink: GainNode | undefined;
    try {
      for (const slot of settings) {
        const existing = this.nodes.get(slot.id);
        if (
          existing?.type === slot.type &&
          (slot.type !== "eq" || (existing.type === "eq" && existing.processor.bands.length === slot.bands.length))
        ) {
          next.set(slot.id, existing);
          continue;
        }
        const wet = slot.enabled ? slot.wet : 0;
        let node: RackNode;
        if (slot.type === "filter")
          node = { type: "filter", processor: new Filter(this.context, { frequency: slot.frequency, Q: slot.q, type: slot.mode, wet }) };
        else if (slot.type === "delay")
          node = { type: "delay", processor: new PingPongDelay(this.context, { delayTime: slot.delayTime, feedback: slot.feedback, wet }) };
        else node = { type: "eq", processor: new Equalizer(this.context, { wet, bands: slot.bands }) };
        created.push(node);
        next.set(slot.id, node);
      }
      if (macros.length && !this.macroSink) {
        newSink = this.context.createGain();
        newSink.gain.value = 0;
        newSink.connect(this.context.destination);
      }
      for (const macro of macros) {
        const existing = this.macros.get(macro.id);
        if (existing && existing.label === macro.label) macroNodes.set(macro.id, existing);
        else {
          const node = new LiveRackMacro(this.context, this.macroSink ?? newSink!, macro);
          createdMacros.push(node);
          macroNodes.set(macro.id, node);
        }
      }
    } catch (error) {
      for (const node of created) node.processor.dispose();
      for (const macro of createdMacros) macro.dispose();
      newSink?.disconnect();
      throw error;
    }

    this.macroSink ??= newSink;
    const previousMacros = this.macros;
    const desired = [...next.values()].map((node) => node.processor);
    const effectById = new Map(settings.map((slot) => [slot.id, slot]));
    const owned = new Map<string, Set<RackMacroParameter>>();
    for (const { targets } of macros) {
      for (const { slotId, parameter } of targets) {
        let parameters = owned.get(slotId);
        if (!parameters) owned.set(slotId, (parameters = new Set()));
        parameters.add(parameter);
      }
    }
    batch(() => {
      if (recall) for (const macro of previousMacros.values()) macro.bind([]);
      for (const slot of settings) {
        const node = next.get(slot.id)!;
        const mapped = owned.get(slot.id);
        if (!mapped?.has("wet")) node.processor.params.wet.value = slot.enabled ? slot.wet : 0;
        if (node.type === "filter" && slot.type === "filter") {
          if (!mapped?.has("frequency")) node.processor.params.frequency.value = slot.frequency;
          if (!mapped?.has("q")) node.processor.params.Q.value = slot.q;
          node.processor.params.type.value = slot.mode;
        } else if (node.type === "delay" && slot.type === "delay") {
          if (!mapped?.has("delayTime")) node.processor.params.delayTime.value = slot.delayTime;
          if (!mapped?.has("feedback")) node.processor.params.feedback.value = slot.feedback;
        } else if (node.type === "eq" && slot.type === "eq") {
          node.processor.setBands(slot.bands);
        }
      }
      for (const macro of macros) {
        const node = macroNodes.get(macro.id)!;
        if (recall) node.write(macro.value);
        node.bind(macro.targets.map((mapping) => bindMacroTarget(mapping, next.get(mapping.slotId)!, effectById.get(mapping.slotId)!)));
      }
      this.nodes = next;
      this.macros = macroNodes;
      this.macroDefinitions = macros;
      if (!this.chain) this.chain = new EffectChain(this.context, desired);
      else this.reorder(desired);
      this.settings.value = settings;
      const controls = [...macroNodes.values()].map((macro) => macro.control);
      const previous = untracked(() => this.macroCells.value);
      if (previous.length !== controls.length || controls.some((control, i) => control !== previous[i]))
        this.macroCells.value = Object.freeze(controls);
    });
    for (const [id, macro] of previousMacros) if (macroNodes.get(id) !== macro) macro.dispose();
    if (!this.macros.size && this.macroSink) {
      this.macroSink.disconnect();
      this.macroSink = undefined;
    }
  }

  /** Brings the chain to `desired` with the chain's crossfaded edits; effects that left the rack are disposed by `remove`. */
  private reorder(desired: readonly (Filter | PingPongDelay | Equalizer)[]): void {
    const chain = this.chain;
    for (const effect of untracked(() => chain.cells.effects.value)) if (!desired.includes(effect as never)) chain.remove(effect);
    desired.forEach((effect, index) => {
      const current = untracked(() => chain.cells.effects.value);
      if (current[index] === effect) return;
      if (current.includes(effect)) chain.move(effect, index);
      else chain.add(effect, index);
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const macro of this.macros.values()) macro.dispose();
    this.macros.clear();
    this.macroCells.value = [];
    this.macroSink?.disconnect();
    this.chain?.dispose();
    this.nodes.clear();
  }
}
