import {
  AudioProcessor,
  Voice,
  cell,
  readonlyCell,
  untracked,
  type CancellableEvent,
  type Cell,
  type ReadonlyCell,
  type SchedulableParam,
} from "@audiorective/core";

export type PadSpec = Readonly<{ id: string; buffer: AudioBuffer; group?: string; gate?: boolean }>;

export type PadHitOptions = Readonly<{
  /** Semitones; the voice plays at rate `2 ** (pitch / 12)`. Default 0. */
  pitch?: number;
  /** Seconds the gate stays open, honoured only for `gate: true` pads. Retractable like choke. */
  duration?: number;
}>;

/** One hit and all of its future policy effects. Clock can own this structural handle. */
export interface PadHit extends CancellableEvent {
  /** Same operation as cancel, for callers treating the event as a voice. */
  stop(): void;
}

type Hit = {
  pad: PadSpec;
  when: number;
  order: number;
  gate: GainNode;
  voice: Voice;
  /** Time the gate closes: the earliest of a same-group choke and the hit's own duration. */
  chokeAt: number;
  /** Close time from `duration` on a gate pad; Infinity when the hit has none. */
  closeAt: number;
  done: boolean;
  callbacks: Array<() => void>;
};

/**
 * Sample hits with retractable same-group choke. The caller owns the AudioContext and routing.
 * A native gain gate carries future choke so cancelling the incoming hit can retract it.
 * Each pad feeds the bank `output` through its own gain; `routePad` redirects that gain, so pads in one choke group can have separate effects.
 */
export class PadBank extends AudioProcessor<
  { volume: SchedulableParam },
  { activeEvents: ReadonlyCell<number>; pads: ReadonlyCell<readonly PadSpec[]> }
> {
  private readonly outputNode: GainNode;
  /** One bank-owned gain per pad: every hit of the pad feeds it, and it feeds `output` unless routed elsewhere. */
  private readonly padNodes = new Map<string, GainNode>();
  private readonly activeStore: Cell<number>;
  /** The only store of pad specs; `cells.pads` is its read-only view. */
  private readonly padStore: Cell<readonly PadSpec[]>;
  private readonly hits = new Set<Hit>();
  private nextOrder = 0;
  private cleanupTimer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;

  constructor(context: BaseAudioContext, pads: readonly PadSpec[]) {
    const ids = new Set<string>();
    for (const pad of pads) {
      if (!pad.id || ids.has(pad.id)) throw new Error("Pad Bank pad IDs must be nonempty and unique.");
      ids.add(pad.id);
    }
    const output = new GainNode(context);
    const active = cell(0);
    const store = cell<readonly PadSpec[]>(Object.freeze(pads.map((pad) => Object.freeze({ ...pad }))));
    super(context, ({ param }) => ({
      params: { volume: param({ default: 1, bind: output.gain }) },
      cells: { activeEvents: readonlyCell(active), pads: readonlyCell(store) },
    }));
    this.outputNode = output;
    for (const pad of pads) {
      const node = new GainNode(context);
      node.connect(output);
      this.padNodes.set(pad.id, node);
    }
    this.activeStore = active;
    this.padStore = store;
  }

  override get output(): GainNode {
    return this.outputNode;
  }

  private pad(id: string): PadSpec | undefined {
    return untracked(() => this.padStore.value).find((pad) => pad.id === id);
  }

  private assertAlive(): void {
    if (this.disposed) throw new Error("PadBank is disposed.");
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
      let chokeAt = hit.closeAt;
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

  /**
   * Schedule one hit. Past times play now; unknown pad IDs return null.
   * `options.pitch` transposes by semitones; `options.duration` closes a gate pad's hit at `when + duration`.
   */
  trigger(id: string, velocity = 1, when = this.context.currentTime, options: PadHitOptions = {}): PadHit | null {
    this.assertAlive();
    if (!Number.isFinite(when) || when < 0) throw new RangeError("Pad hit time must be finite, non-negative seconds.");
    if (!Number.isFinite(velocity)) throw new RangeError("Pad hit velocity must be finite.");
    const { pitch = 0, duration } = options;
    if (!Number.isFinite(pitch)) throw new RangeError("Pad hit pitch must be finite semitones.");
    if (duration !== undefined && (!Number.isFinite(duration) || duration <= 0))
      throw new RangeError("Pad hit duration must be finite, positive seconds.");
    const pad = this.pad(id);
    if (!pad) return null;
    this.settle();
    const at = Math.max(when, this.context.currentTime);
    const gate = new GainNode(this.context);
    gate.connect(this.padNodes.get(pad.id)!);
    let hit: Hit | undefined;
    let voice: Voice;
    try {
      voice = new Voice(
        this.context,
        pad.buffer,
        gate,
        { when: at, volume: Math.max(0, Math.min(1, velocity)), rate: 2 ** (pitch / 12), loop: pad.gate ?? false },
        () => {
          this.settle();
          if (hit) {
            this.finish(hit);
            this.rebuild();
          }
        },
      );
    } catch (error) {
      gate.disconnect();
      throw error;
    }
    hit = {
      pad,
      when: at,
      order: ++this.nextOrder,
      gate,
      voice,
      chokeAt: Infinity,
      closeAt: pad.gate && duration !== undefined ? at + duration : Infinity,
      done: false,
      callbacks: [],
    };
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

  /**
   * Send one pad's sound to `destination` instead of the bank `output`, or back to it with `null`.
   * Choke still works across pads routed apart, because it acts on each hit's gate before the routing.
   * The caller owns `destination`; the bank only adds and removes its own edge into it. Unknown pad IDs throw.
   */
  routePad(id: string, destination: AudioNode | null): void {
    this.assertAlive();
    const node = this.padNodes.get(id);
    if (!node) throw new Error("Unknown pad.");
    node.disconnect();
    node.connect(destination ?? this.outputNode);
  }

  /** Replace a pad's buffer and cancel only hits made from that pad. */
  assign(id: string, buffer: AudioBuffer): void {
    this.assertAlive();
    const pad = this.pad(id);
    if (!pad) throw new Error("Unknown pad.");
    this.settle();
    for (const hit of [...this.hits]) if (hit.pad.id === id) this.finish(hit);
    this.padStore.value = Object.freeze(
      untracked(() => this.padStore.value).map((item) => (item === pad ? Object.freeze({ ...pad, buffer }) : item)),
    );
    this.rebuild();
  }

  /** Cancel every hit, including those scheduled for the future. */
  stopAll(): void {
    this.settle();
    for (const hit of [...this.hits]) this.finish(hit);
    if (this.cleanupTimer !== undefined) clearTimeout(this.cleanupTimer);
    this.cleanupTimer = undefined;
  }

  override dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopAll();
    for (const node of this.padNodes.values()) node.disconnect();
    this.padNodes.clear();
    this.outputNode.disconnect();
    super.dispose();
  }
}
