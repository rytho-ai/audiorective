import {
  AudioProcessor,
  Voice,
  cell,
  readonlyCell,
  type CancellableEvent,
  type Cell,
  type ReadonlyCell,
  type SchedulableParam,
} from "@audiorective/core";

export type EventPad = Readonly<{ id: string; buffer: AudioBuffer; group?: string; gate?: boolean }>;

/** One hit and all of its future policy effects. Clock can own this structural handle. */
export interface InstrumentEvent extends CancellableEvent {
  /** Same operation as cancel, for callers treating the event as a voice. */
  stop(): void;
}

type Hit = {
  pad: EventPad;
  when: number;
  order: number;
  gate: GainNode;
  voice: Voice;
  chokeAt: number;
  done: boolean;
  callbacks: Array<() => void>;
};

/**
 * Sample hits with retractable same-group choke. The caller owns the AudioContext and routing.
 * A native gain gate carries future choke so cancelling the incoming hit can retract it.
 */
export class InstrumentEvents extends AudioProcessor<{ volume: SchedulableParam }, { activeEvents: ReadonlyCell<number> }> {
  private readonly outputNode: GainNode;
  private readonly activeStore: Cell<number>;
  private readonly pads: Map<string, EventPad>;
  private readonly hits = new Set<Hit>();
  private nextOrder = 0;
  private cleanupTimer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;

  constructor(context: BaseAudioContext, pads: readonly EventPad[]) {
    const ids = new Set<string>();
    for (const pad of pads) {
      if (!pad.id || ids.has(pad.id)) throw new Error("Instrument pad IDs must be nonempty and unique.");
      ids.add(pad.id);
    }
    const output = new GainNode(context);
    const active = cell(0);
    super(context, ({ param }) => ({
      params: { volume: param({ default: 1, bind: output.gain }) },
      cells: { activeEvents: readonlyCell(active) },
    }));
    this.outputNode = output;
    this.activeStore = active;
    this.pads = new Map(pads.map((pad) => [pad.id, Object.freeze({ ...pad })]));
  }

  override get output(): GainNode {
    return this.outputNode;
  }

  private assertAlive(): void {
    if (this.disposed) throw new Error("InstrumentEvents is destroyed.");
  }

  private publish(): void {
    this.activeStore.value = this.hits.size;
  }

  private finish(hit: Hit): void {
    if (hit.done) return;
    hit.done = true;
    this.hits.delete(hit);
    hit.voice.stop();
    hit.gate.disconnect();
    this.publish();
    for (const listener of hit.callbacks.splice(0)) {
      try {
        listener();
      } catch (error) {
        console.error("Instrument event end listener failed:", error);
      }
    }
  }

  private settle(): void {
    const now = this.context.currentTime;
    for (const hit of [...this.hits]) if (hit.chokeAt <= now) this.finish(hit);
  }

  private rebuild(): void {
    if (this.cleanupTimer !== undefined) clearTimeout(this.cleanupTimer);
    this.cleanupTimer = undefined;
    const now = this.context.currentTime;
    let nextChoke = Infinity;
    for (const hit of this.hits) {
      let chokeAt = Infinity;
      if (hit.pad.group !== undefined) {
        for (const incoming of this.hits) {
          if (incoming.pad.group !== hit.pad.group || incoming.pad.id === hit.pad.id) continue;
          if (incoming.when > hit.when || (incoming.when === hit.when && incoming.order > hit.order)) {
            chokeAt = Math.min(chokeAt, incoming.when);
          }
        }
      }
      hit.chokeAt = chokeAt;
      const gain = hit.gate.gain;
      gain.cancelScheduledValues(now);
      gain.setValueAtTime(1, now);
      if (Number.isFinite(chokeAt)) {
        gain.setValueAtTime(0, Math.max(now, chokeAt));
        nextChoke = Math.min(nextChoke, chokeAt);
      }
    }
    // The timer only retires silent nodes. The gain event above schedules the actual sound cutoff.
    if (Number.isFinite(nextChoke)) {
      this.cleanupTimer = setTimeout(
        () => {
          this.cleanupTimer = undefined;
          this.settle();
          this.rebuild();
        },
        Math.max(1, Math.ceil((nextChoke - now) * 1000) + 1),
      );
    }
  }

  /** Schedule one hit. Past times play now; unknown pad IDs return null. */
  trigger(id: string, velocity = 1, when = this.context.currentTime): InstrumentEvent | null {
    this.assertAlive();
    if (!Number.isFinite(when) || when < 0) throw new RangeError("Instrument event time must be finite, non-negative seconds.");
    if (!Number.isFinite(velocity)) throw new RangeError("Instrument velocity must be finite.");
    const pad = this.pads.get(id);
    if (!pad) return null;
    this.settle();
    const at = Math.max(when, this.context.currentTime);
    const gate = new GainNode(this.context);
    gate.connect(this.outputNode);
    let hit: Hit | undefined;
    let voice: Voice;
    try {
      voice = new Voice(this.context, pad.buffer, gate, { when: at, volume: Math.max(0, Math.min(1, velocity)), loop: pad.gate ?? false }, () => {
        this.settle();
        if (hit) {
          this.finish(hit);
          this.rebuild();
        }
      });
    } catch (error) {
      gate.disconnect();
      throw error;
    }
    hit = { pad, when: at, order: ++this.nextOrder, gate, voice, chokeAt: Infinity, done: false, callbacks: [] };
    this.hits.add(hit);
    this.rebuild();
    this.publish();
    const cancel = () => {
      if (hit.done) return;
      this.settle();
      this.finish(hit);
      this.rebuild();
    };
    return {
      cancel,
      stop: cancel,
      onEnded(listener) {
        if (hit.done) listener();
        else hit.callbacks.push(listener);
      },
    };
  }

  /** Replace a pad's buffer and cancel only hits made from that pad. */
  assign(id: string, buffer: AudioBuffer): void {
    this.assertAlive();
    const pad = this.pads.get(id);
    if (!pad) throw new Error("Unknown instrument pad.");
    this.settle();
    for (const hit of [...this.hits]) if (hit.pad.id === id) this.finish(hit);
    this.pads.set(id, Object.freeze({ ...pad, buffer }));
    this.rebuild();
  }

  /** Cancel every hit, including those scheduled for the future. */
  stopAll(): void {
    this.settle();
    for (const hit of [...this.hits]) this.finish(hit);
    if (this.cleanupTimer !== undefined) clearTimeout(this.cleanupTimer);
    this.cleanupTimer = undefined;
  }

  override destroy(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopAll();
    this.outputNode.disconnect();
    super.destroy();
  }
}
