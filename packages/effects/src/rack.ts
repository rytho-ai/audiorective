import { AudioProcessor, batch, cell, readonlyCell, untracked, type Cell, type ReadonlyCell } from "@audiorective/core";
import { Equalizer } from "./Equalizer";
import { Filter } from "./Filter";
import { PingPongDelay } from "./PingPongDelay";
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
export { LiveRackMacro };
export type { RackMacro };
export { isMacroValue, normalizeRackEffects, normalizeRackPreset, rackMacroRange, retainRackMacroTargets } from "./rack-preset";
export type { RackDelay, RackEffect, RackEq, RackFilter, RackMacroMapping, RackMacroParameter, RackMacroSettings, RackPreset } from "./rack-preset";

type RackNode = { type: "filter"; processor: Filter } | { type: "delay"; processor: PingPongDelay } | { type: "eq"; processor: Equalizer };
function bindMacroTarget(mapping: RackMacroSettings["targets"][number], node: RackNode, slot: RackEffect): MacroTarget {
  const { parameter } = mapping;
  if (parameter === "wet") return { mapping, param: node.processor.params.wet, muted: !slot.enabled };
  if (node.type === "filter" && (parameter === "frequency" || parameter === "q"))
    return { mapping, param: node.processor.params[parameter === "q" ? "Q" : "frequency"], muted: false };
  if (node.type === "delay" && (parameter === "delayTime" || parameter === "feedback"))
    return { mapping, param: node.processor.params[parameter], muted: false };
  throw new Error("EffectRack macro target is unavailable.");
}

/** Ordered built-in inserts. The rack owns its nodes and borrows its context. */
export class EffectRack extends AudioProcessor<
  Record<never, never>,
  {
    effects: ReadonlyCell<readonly RackEffect[]>;
    macros: ReadonlyCell<readonly RackMacro[]>;
  }
> {
  private readonly rackInput: GainNode;
  private readonly rackOutput: GainNode;
  private readonly settings: Cell<readonly RackEffect[]>;
  private readonly macroCells: Cell<readonly RackMacro[]>;
  private macroDefinitions: readonly RackMacroSettings[] = noMacros;
  private macros = new Map<string, LiveRackMacro>();
  private macroSink?: GainNode;
  private nodes = new Map<string, RackNode>();
  private readonly chain = cell<readonly RackNode[]>([]);
  private destroyed = false;

  constructor(context: BaseAudioContext, effects: readonly RackEffect[] = [], macros: readonly RackMacroSettings[] = noMacros) {
    const settings = cell<readonly RackEffect[]>(Object.freeze([]));
    const macroCells = cell<readonly RackMacro[]>(Object.freeze([]));
    super(context, () => ({ params: {}, cells: { effects: readonlyCell(settings), macros: readonlyCell(macroCells) } }));
    this.settings = settings;
    this.macroCells = macroCells;
    this.rackInput = context.createGain();
    this.rackOutput = context.createGain();
    this.defineGraph(
      () => {
        type Endpoint = GainNode | RackNode["processor"];
        const edges: Array<readonly [Endpoint, Endpoint]> = [];
        let previous: Endpoint = this.input;
        for (const { processor } of this.chain.value) {
          edges.push([previous, processor]);
          previous = processor;
        }
        edges.push([previous, this.output]);
        return edges;
      },
      { compensate: true },
    );
    try {
      this.setPreset({ effects, macros });
    } catch (error) {
      this.destroy();
      throw error;
    }
  }

  override get input(): GainNode {
    return this.rackInput;
  }

  get output(): GainNode {
    return this.rackOutput;
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
    if (this.destroyed) throw new Error("EffectRack is destroyed.");
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
      for (const node of created) node.processor.destroy();
      for (const macro of createdMacros) macro.destroy();
      newSink?.disconnect();
      throw error;
    }

    this.macroSink ??= newSink;
    const previousNodes = this.nodes;
    const previousMacros = this.macros;
    const previousChain = untracked(() => this.chain.value);
    const chain = [...next.values()];
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
      if (previousChain.length !== chain.length || chain.some((node, index) => node !== previousChain[index])) this.chain.value = chain;
      this.settings.value = settings;
      const controls = [...macroNodes.values()].map((macro) => macro.control);
      const previous = untracked(() => this.macroCells.value);
      if (previous.length !== controls.length || controls.some((control, i) => control !== previous[i]))
        this.macroCells.value = Object.freeze(controls);
    });
    for (const [id, macro] of previousMacros) if (macroNodes.get(id) !== macro) macro.destroy();
    for (const [id, node] of previousNodes) if (next.get(id) !== node) node.processor.destroy();
    if (!this.macros.size && this.macroSink) {
      this.macroSink.disconnect();
      this.macroSink = undefined;
    }
  }

  override destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    super.destroy();
    for (const macro of this.macros.values()) macro.destroy();
    this.macros.clear();
    this.macroCells.value = [];
    this.macroSink?.disconnect();
    for (const node of this.nodes.values()) node.processor.destroy();
    this.nodes.clear();
    this.chain.value = [];
    this.input.disconnect();
    this.output.disconnect();
  }
}
