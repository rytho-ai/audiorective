import { AudioProcessor } from "@audiorective/core";

/** A named receive point on a `SendBus`: connect it onward like any processor, `bus.receive("hall").connect(reverb)`. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export class SendReceive extends AudioProcessor<{}, {}> {
  private readonly node: GainNode;

  constructor(context: BaseAudioContext) {
    const node = new GainNode(context);
    super(context, () => ({ params: {}, cells: {} }));
    this.node = node;
  }

  override get input(): GainNode {
    return this.node;
  }

  get output(): GainNode {
    return this.node;
  }
}

/** Named receive points a Channel can send into. Instance-scoped; one per rack. Sends and receives connect through `connect`, so delay compensation covers them. */
export class SendBus {
  private readonly receives = new Map<string, SendReceive>();
  constructor(private readonly ctx: BaseAudioContext) {}

  /** Creates the receive point `name`, or returns the existing one; connect it onward with `bus.receive(name).connect(...)`. */
  define(name: string): SendReceive {
    let node = this.receives.get(name);
    if (!node) {
      node = new SendReceive(this.ctx);
      this.receives.set(name, node);
    }
    return node;
  }

  /** The receive point `name`; throws when `define(name)` has not been called. */
  receive(name: string): SendReceive {
    const node = this.receives.get(name);
    if (!node) throw new Error(`SendBus: no receive named "${name}" — call define("${name}") first`);
    return node;
  }

  /** True when `define(name)` has been called and `undefine(name)` has not. */
  has(name: string): boolean {
    return this.receives.has(name);
  }

  /** Disconnect and forget one receive point; dispose its sends first. No-op for an undefined name. */
  undefine(name: string): void {
    this.receives.get(name)?.dispose();
    this.receives.delete(name);
  }

  /** Disconnect all receives; call after dependent sends are disposed since this cannot see their nodes. */
  dispose(): void {
    for (const node of this.receives.values()) node.dispose();
    this.receives.clear();
  }
}
