import {
  AudioProcessor,
  assertSound,
  batch,
  cell,
  playSound,
  readonlyCell,
  untracked,
  type Cell,
  type Param,
  type PlayOptions,
  type ReadonlyCell,
  type SchedulableParam,
  type Sound,
  type Voice,
} from "@audiorective/core";

export type PadSpec = Readonly<{
  id: string;
  /** A decoded sample or a sound factory. */
  sound: Sound;
  /** A hit cuts every sounding voice of the pads in the same group (its own pad included) with the bank's `release` fade. Pads without a group layer freely. */
  group?: string;
}>;

export type PadBankOptions = Readonly<{
  /** Start value of `params.release`: seconds of fade-out applied when a voice is released; changes apply to voices released afterwards. Default 0.005. */
  release?: number;
  /** Aborting the signal calls `dispose()`. */
  signal?: AbortSignal;
}>;

type Hit = {
  pad: PadSpec;
  when: number;
  order: number;
  gate: GainNode;
  voice: Voice;
  state: Cell<boolean>;
  /** Time the gate starts closing: the earliest of a later same-group hit and the hit's own scheduled stop. */
  chokeAt: number;
  /** Scheduled stop time from `voice.stop(when)`; Infinity when the hit has none. */
  stopAt: number;
  done: boolean;
};

/**
 * Named pads that each play their own sound, with choke groups. The caller owns the AudioContext and routing:
 * its output is not connected, `pads.connect(context.destination)`.
 * A native gain gate carries future choke so stopping the incoming hit before it starts can retract it.
 * Each pad feeds the bank `output` through its own gain; `routePad` redirects that gain, so pads in one choke group can have separate effects.
 */
export class PadBank extends AudioProcessor<
  { volume: SchedulableParam; release: Param<number> },
  { activeVoices: ReadonlyCell<number>; pads: ReadonlyCell<readonly PadSpec[]>; playing: ReadonlyCell<readonly string[]> }
> {
  private readonly outputNode: GainNode;
  /** One bank-owned gain per pad: every hit of the pad feeds it, and it feeds `output` unless routed elsewhere. */
  private readonly padNodes = new Map<string, GainNode>();
  private readonly activeStore: Cell<number>;
  private readonly playingStore: Cell<readonly string[]>;
  /** The only store of pad specs; `cells.pads` is its read-only view. */
  private readonly padStore: Cell<readonly PadSpec[]>;
  private readonly hits = new Set<Hit>();
  private readonly abortSignal: AbortSignal | undefined;
  private readonly onAbort = () => this.dispose();
  private nextOrder = 0;
  private cleanupTimer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;

  constructor(context: BaseAudioContext, pads: readonly PadSpec[], options: PadBankOptions = {}) {
    const ids = new Set<string>();
    for (const pad of pads) {
      if (!pad.id || ids.has(pad.id)) throw new Error("Pad Bank pad IDs must be nonempty and unique.");
      assertSound(pad.sound);
      ids.add(pad.id);
    }
    const output = new GainNode(context);
    const active = cell(0);
    const playing = cell<readonly string[]>([]);
    const store = cell<readonly PadSpec[]>(Object.freeze(pads.map((pad) => Object.freeze({ ...pad }))));
    super(context, ({ param }) => ({
      params: { volume: param({ default: 1, bind: output.gain }), release: param({ default: Math.max(0, options.release ?? 0.005), min: 0 }) },
      cells: { activeVoices: readonlyCell(active), pads: readonlyCell(store), playing: readonlyCell(playing) },
    }));
    this.outputNode = output;
    for (const pad of pads) {
      const node = new GainNode(context);
      node.connect(output);
      this.padNodes.set(pad.id, node);
    }
    this.activeStore = active;
    this.playingStore = playing;
    this.padStore = store;
    this.abortSignal = options.signal;
    if (this.abortSignal) {
      if (this.abortSignal.aborted) this.dispose();
      else this.abortSignal.addEventListener("abort", this.onAbort, { once: true });
    }
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

  /** Seconds a hit fades out when released, read when it is released. */
  private get release(): number {
    return Math.max(
      0,
      untracked(() => this.params.release.value),
    );
  }

  /** Commit the sounding-hit count and pad ids together; a hit scheduled ahead counts from its start time. */
  private publish(): void {
    const sounding = [...this.hits].filter((hit) => untracked(() => hit.state.value));
    const ids = new Set(sounding.map((hit) => hit.pad.id));
    const playing = untracked(() => this.padStore.value)
      .map((pad) => pad.id)
      .filter((id) => ids.has(id));
    batch(() => {
      this.activeStore.value = sounding.length;
      const current = untracked(() => this.playingStore.value);
      if (current.length !== playing.length || current.some((id, index) => id !== playing[index])) this.playingStore.value = playing;
    });
  }

  private finish(hit: Hit): void {
    if (hit.done) return;
    hit.done = true;
    this.hits.delete(hit);
    hit.voice.stop();
    batch(() => {
      hit.state.value = false;
      this.publish();
    });
  }

  /** Retire every hit whose gate has finished closing. */
  private settle(): void {
    const now = this.context.currentTime;
    for (const hit of [...this.hits]) if (hit.chokeAt + this.release <= now) this.finish(hit);
  }

  private rebuild(): void {
    if (this.cleanupTimer !== undefined) clearTimeout(this.cleanupTimer);
    this.cleanupTimer = undefined;
    const now = this.context.currentTime;
    let nextRetire = Infinity;
    for (const hit of this.hits) {
      let chokeAt = hit.stopAt;
      if (hit.pad.group !== undefined) {
        for (const incoming of this.hits) {
          if (incoming.pad.group !== hit.pad.group) continue;
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
        const start = Math.max(now, chokeAt);
        gain.setValueAtTime(1, start);
        gain.linearRampToValueAtTime(0, start + this.release);
        nextRetire = Math.min(nextRetire, start + this.release);
      }
    }
    // The timer only retires silent nodes. The gain events above schedule the actual fade.
    if (Number.isFinite(nextRetire)) {
      this.cleanupTimer = setTimeout(
        () => {
          this.cleanupTimer = undefined;
          this.settle();
          this.rebuild();
        },
        Math.max(1, Math.ceil((nextRetire - now) * 1000) + 1),
      );
    }
  }

  private stopHit(hit: Hit, when: number | undefined): void {
    if (hit.done) return;
    this.settle();
    const now = this.context.currentTime;
    const at = Math.max(when ?? now, now);
    if (at <= now || at <= hit.when) {
      this.finish(hit);
    } else {
      hit.stopAt = Math.min(hit.stopAt, at);
    }
    this.rebuild();
  }

  /**
   * Play pad `id` once. Returns the voice, or null for an unknown id.
   * A hit in a choke group fades out every sounding voice of the group at its own start time; stopping it before it starts retracts that.
   */
  trigger(id: string, options: PlayOptions = {}): Voice | null {
    this.assertAlive();
    const pad = this.pad(id);
    if (!pad) return null;
    this.settle();
    const at = Math.max(options.when ?? this.context.currentTime, this.context.currentTime);
    const gate = new GainNode(this.context);
    gate.connect(this.padNodes.get(pad.id)!);
    let voice: Voice;
    try {
      voice = playSound(
        this.context,
        pad.sound,
        gate,
        { when: at, velocity: options.velocity ?? 1, pitch: options.pitch ?? 0, duration: options.duration ?? Infinity },
        { release: () => this.release, offset: options.offset, span: options.duration, onFree: () => gate.disconnect() },
      );
    } catch (error) {
      gate.disconnect();
      throw error;
    }
    const state = cell(voice.playing.value);
    const created: Hit = { pad, when: at, order: ++this.nextOrder, gate, voice, state, chokeAt: Infinity, stopAt: Infinity, done: false };
    this.hits.add(created);
    voice.playing.subscribe((playing) => {
      if (created.done) return;
      if (playing) {
        batch(() => {
          state.value = true;
          this.publish();
        });
        return;
      }
      this.settle();
      this.finish(created);
      this.rebuild();
    });
    this.rebuild();
    this.publish();
    const view = readonlyCell(state);
    return {
      note: null,
      when: at,
      playing: view,
      stop: (when) => this.stopHit(created, when),
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

  /** Replace a pad's sound; its sounding voices are released. */
  assign(id: string, sound: Sound): void {
    this.assertAlive();
    const pad = this.pad(id);
    if (!pad) throw new Error("Unknown pad.");
    assertSound(sound);
    this.settle();
    for (const hit of [...this.hits]) if (hit.pad.id === id) this.finish(hit);
    this.padStore.value = Object.freeze(untracked(() => this.padStore.value).map((item) => (item === pad ? Object.freeze({ ...pad, sound }) : item)));
    this.rebuild();
  }

  /** Release every voice at `when` (default now). */
  stopAll(when?: number): void {
    for (const hit of [...this.hits]) this.stopHit(hit, when);
  }

  override dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.abortSignal?.removeEventListener("abort", this.onAbort);
    for (const hit of [...this.hits]) this.finish(hit);
    if (this.cleanupTimer !== undefined) clearTimeout(this.cleanupTimer);
    this.cleanupTimer = undefined;
    for (const node of this.padNodes.values()) node.disconnect();
    this.padNodes.clear();
    this.outputNode.disconnect();
    super.dispose();
  }
}
