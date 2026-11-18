import { AudioProcessor, batch, cell, readonlyCell, untracked, type Cell, type ReadonlyCell } from "@audiorective/core";
import { Filter, PingPongDelay } from "@audiorective/effects";

type EffectSlot = Readonly<{ id: string; enabled: boolean; wet: number }>;
export type RackFilter = EffectSlot & Readonly<{ type: "filter"; mode: "lowpass" | "highpass"; frequency: number; q: number }>;
export type RackDelay = EffectSlot & Readonly<{ type: "delay"; delayTime: number; feedback: number }>;
export type RackEffect = RackFilter | RackDelay;

const between = (value: number, min: number, max: number) => Number.isFinite(value) && value >= min && value <= max;

/** Validate a complete ordered settings snapshot before changing effects or routing. */
export function normalizeRackEffects(effects: readonly RackEffect[]): readonly RackEffect[] {
  const invalid = () => new RangeError("EffectRack needs unique slot IDs and valid Filter or Delay settings.");
  if (!Array.isArray(effects)) throw invalid();
  const ids = new Set<string>();
  return Object.freeze(
    Array.from(effects, (slot: RackEffect) => {
      if (
        !slot ||
        typeof slot.id !== "string" ||
        !slot.id.trim() ||
        ids.has(slot.id) ||
        typeof slot.enabled !== "boolean" ||
        !between(slot.wet, 0, 1)
      )
        throw invalid();
      ids.add(slot.id);
      const base = { id: slot.id, enabled: slot.enabled, wet: slot.wet };
      if (
        slot.type === "filter" &&
        (slot.mode === "lowpass" || slot.mode === "highpass") &&
        between(slot.frequency, 20, 20_000) &&
        between(slot.q, 0.1, 20)
      ) {
        return Object.freeze({ ...base, type: slot.type, mode: slot.mode, frequency: slot.frequency, q: slot.q });
      }
      if (slot.type === "delay" && between(slot.delayTime, 0.01, 1) && between(slot.feedback, 0, 0.95)) {
        return Object.freeze({ ...base, type: slot.type, delayTime: slot.delayTime, feedback: slot.feedback });
      }
      throw invalid();
    }),
  );
}

type RackNode = { type: "filter"; processor: Filter } | { type: "delay"; processor: PingPongDelay };

/**
 * Ordered built-in inserts. The rack owns its nodes and borrows its context.
 * `cells.effects` (and the `effects` getter) is the tracked settings snapshot; it changes only through `setEffects`.
 */
export class EffectRack extends AudioProcessor<Record<never, never>, { effects: ReadonlyCell<readonly RackEffect[]> }> {
  private readonly rackInput: GainNode;
  private readonly rackOutput: GainNode;
  private readonly settings: Cell<readonly RackEffect[]>;
  private nodes = new Map<string, RackNode>();
  private readonly chain = cell<readonly RackNode[]>([]);
  private destroyed = false;

  constructor(context: BaseAudioContext, effects: readonly RackEffect[] = []) {
    const settings = cell<readonly RackEffect[]>(Object.freeze([]));
    super(context, () => ({ params: {}, cells: { effects: readonlyCell(settings) } }));
    this.settings = settings;
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
      this.setEffects(effects);
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

  /** Existing slots retain their processors across parameter, bypass and order changes. */
  setEffects(effects: readonly RackEffect[]): void {
    if (this.destroyed) throw new Error("EffectRack is destroyed.");
    const settings = normalizeRackEffects(effects);
    const next = new Map<string, RackNode>();
    const created: RackNode[] = [];
    try {
      for (const slot of settings) {
        const existing = this.nodes.get(slot.id);
        if (existing?.type === slot.type) {
          next.set(slot.id, existing);
          continue;
        }
        const node: RackNode =
          slot.type === "filter"
            ? {
                type: "filter",
                processor: new Filter(this.context, { frequency: slot.frequency, Q: slot.q, type: slot.mode, wet: slot.enabled ? slot.wet : 0 }),
              }
            : {
                type: "delay",
                processor: new PingPongDelay(this.context, { delayTime: slot.delayTime, feedback: slot.feedback, wet: slot.enabled ? slot.wet : 0 }),
              };
        created.push(node);
        next.set(slot.id, node);
      }
    } catch (error) {
      for (const node of created) node.processor.destroy();
      throw error;
    }

    for (const slot of settings) {
      const node = next.get(slot.id)!;
      node.processor.params.wet.value = slot.enabled ? slot.wet : 0;
      if (node.type === "filter" && slot.type === "filter") {
        node.processor.params.frequency.value = slot.frequency;
        node.processor.params.Q.value = slot.q;
        node.processor.params.type.value = slot.mode;
      } else if (node.type === "delay" && slot.type === "delay") {
        node.processor.params.delayTime.value = slot.delayTime;
        node.processor.params.feedback.value = slot.feedback;
      }
    }
    const chain = [...next.values()];
    const previous = untracked(() => this.chain.value);
    batch(() => {
      if (previous.length !== chain.length || chain.some((node, index) => node !== previous[index])) this.chain.value = chain;
      this.settings.value = settings;
    });
    for (const [id, node] of this.nodes) if (next.get(id) !== node) node.processor.destroy();
    this.nodes = next;
  }

  override destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    super.destroy();
    for (const node of this.nodes.values()) node.processor.destroy();
    this.nodes.clear();
    this.chain.value = [];
    this.input.disconnect();
    this.output.disconnect();
  }
}
