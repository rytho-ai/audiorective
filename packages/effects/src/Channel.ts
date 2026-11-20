import {
  AudioProcessor,
  Param as ParamClass,
  type Param,
  type SchedulableParam,
  SchedulableParam as SchedulableParamClass,
} from "@audiorective/core";
import type { SendBus } from "./SendBus";

export interface ChannelOptions {
  gain?: number;
  pan?: number;
  mute?: boolean;
  /** Output channel count; mono input is upmixed. Default 2. */
  channelCount?: number;
  /**
   * How the input resolves its channel count. `"explicit"` (default) forces `channelCount` channels, so a mono source is
   * upmixed before the panner. `"max"` follows the connected sources, so a mono source reaches the panner as mono and
   * gets the panner's mono equal-power law (about -3 dB per side at centre).
   */
  channelCountMode?: "explicit" | "max";
}

export interface Send {
  readonly gain: SchedulableParam;
  /** Gate for this send alone: `false` silences it without touching `gain`. Default `true`. */
  readonly enabled: Param<boolean>;
  dispose(): void;
}

/**
 * Channel strip: gain → pan → mute → output gate, with post-mute sends into a SendBus.
 * Sends tap the post-mute node (`tap`), so `outputEnabled` gates only the main `output`.
 */
export class Channel extends AudioProcessor<
  { gain: SchedulableParam; pan: SchedulableParam; mute: Param<boolean>; outputEnabled: Param<boolean> },
  {}
> {
  private readonly _input: GainNode;
  private readonly _output: GainNode;
  private readonly _tap: GainNode;
  private readonly sends = new Set<{ node: GainNode; gate: GainNode; param: SchedulableParam; enabled: Param<boolean> }>();

  constructor(ctx: BaseAudioContext, opts: ChannelOptions = {}) {
    const input = new GainNode(ctx, { channelCount: opts.channelCount ?? 2, channelCountMode: opts.channelCountMode ?? "explicit" });
    const gain = new GainNode(ctx, { gain: opts.gain ?? 1 });
    const pan = new StereoPannerNode(ctx, { pan: opts.pan ?? 0 });
    const mute = new GainNode(ctx, { gain: opts.mute ? 0 : 1 });
    const output = new GainNode(ctx);

    super(ctx, ({ param }) => ({
      cells: {},
      params: {
        gain: param({ default: opts.gain ?? 1, bind: gain.gain, min: 0 }),
        pan: param({ default: opts.pan ?? 0, bind: pan.pan, min: -1, max: 1 }),
        mute: param<boolean>({
          default: opts.mute ?? false,
          bind: {
            set: (m) => {
              mute.gain.value = m ? 0 : 1;
            },
          },
        }),
        outputEnabled: param<boolean>({
          default: true,
          bind: {
            set: (enabled) => {
              output.gain.value = enabled ? 1 : 0;
            },
          },
        }),
      },
    }));

    this._input = input;
    this._output = output;
    this._tap = mute;
    this.defineGraph(() => [
      [input, gain],
      [gain, pan],
      [pan, mute],
      [mute, output],
    ]);
  }

  override get input(): GainNode {
    return this._input;
  }

  /** Main output, behind the `outputEnabled` gate. */
  get output(): GainNode {
    return this._output;
  }

  /** Post-pan, post-mute node ahead of the output gate: where sends tap and a post-fader meter reads. */
  get tap(): GainNode {
    return this._tap;
  }

  send(bus: SendBus, name: string, gain = 1): Send {
    const node = new GainNode(this.context, { gain });
    const gate = new GainNode(this.context);
    this.tap.connect(node);
    node.connect(gate);
    gate.connect(bus.receive(name));
    const param = new SchedulableParamClass({ default: gain, audioContext: this.context, audioParam: node.gain, min: 0 });
    const enabled = new ParamClass<boolean>({
      default: true,
      bind: {
        set: (on) => {
          gate.gain.value = on ? 1 : 0;
        },
      },
    });
    const entry = { node, gate, param, enabled };
    this.sends.add(entry);
    return {
      gain: param,
      enabled,
      dispose: () => {
        if (!this.sends.delete(entry)) return;
        param.dispose();
        enabled.dispose();
        this.tap.disconnect(node);
        node.disconnect();
        gate.disconnect();
      },
    };
  }

  override dispose(): void {
    for (const { node, gate, param, enabled } of this.sends) {
      param.dispose();
      enabled.dispose();
      try {
        this.tap.disconnect(node);
      } catch {
        // node may already be disconnected
      }
      node.disconnect();
      gate.disconnect();
    }
    this.sends.clear();
    super.dispose();
  }
}
