import { AudioProcessor, cell, readonlyCell, type Param, type ReadonlyCell, type SchedulableParam } from "@audiorective/core";
import { SMOOTHING } from "./internal/smoothing";
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

/** One send from a Channel into a SendBus receive point; created by `Channel.send`. */
export class Send extends AudioProcessor<{ gain: SchedulableParam; enabled: Param<boolean> }, {}> {
  private readonly node: GainNode;
  private readonly gate: GainNode;

  constructor(
    context: BaseAudioContext,
    gain: number,
    private readonly release: (send: Send) => void,
  ) {
    const node = new GainNode(context, { gain });
    const gate = new GainNode(context);
    super(context, ({ param }) => ({
      params: {
        // Send level, linear. Writes ramp over 10 ms.
        gain: param({ default: gain, bind: node.gain, min: 0, smoothing: SMOOTHING }),
        // Gate for this send alone: `false` silences it without touching `gain`. Default `true`.
        enabled: param<boolean>({
          default: true,
          bind: {
            set: (on) => {
              gate.gain.value = on ? 1 : 0;
            },
          },
        }),
      },
      cells: {},
    }));
    node.connect(gate);
    this.node = node;
    this.gate = gate;
  }

  override get input(): GainNode {
    return this.node;
  }

  get output(): GainNode {
    return this.gate;
  }

  override dispose(): void {
    this.release(this);
    super.dispose();
    this.node.disconnect();
    this.gate.disconnect();
  }
}

/** The channel's post-mute point as a processor, so sends join the latency graph (its input is the channel input, its output the `tap`). */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
class ChannelTap extends AudioProcessor<{}, {}> {
  constructor(
    context: BaseAudioContext,
    private readonly source: GainNode,
    private readonly tapNode: GainNode,
  ) {
    super(context, () => ({ params: {}, cells: {}, latency: 0 }));
  }

  override get input(): GainNode {
    return this.source;
  }

  get output(): GainNode {
    return this.tapNode;
  }
}

/**
 * Channel strip: gain → pan → mute → output gate, with post-mute sends into a SendBus.
 * Sends tap the post-mute node (`tap`), so `outputEnabled` gates only the main `output`.
 * `cells.level` is the post-fader peak in dBFS (-Infinity when silent), refreshed every animation frame.
 */
export class Channel extends AudioProcessor<
  { gain: SchedulableParam; pan: SchedulableParam; mute: Param<boolean>; outputEnabled: Param<boolean> },
  { level: ReadonlyCell<number> }
> {
  private readonly _input: GainNode;
  private readonly _output: GainNode;
  private readonly _tap: GainNode;
  private readonly tapProcessor: ChannelTap;
  private readonly sends = new Set<Send>();
  private readonly stopMeter: () => void;

  constructor(ctx: BaseAudioContext, opts: ChannelOptions = {}) {
    const input = new GainNode(ctx, { channelCount: opts.channelCount ?? 2, channelCountMode: opts.channelCountMode ?? "explicit" });
    const gain = new GainNode(ctx, { gain: opts.gain ?? 1 });
    const pan = new StereoPannerNode(ctx, { pan: opts.pan ?? 0 });
    const mute = new GainNode(ctx, { gain: opts.mute ? 0 : 1 });
    const output = new GainNode(ctx);
    const level = cell(-Infinity);

    super(ctx, ({ param }) => ({
      cells: { level: readonlyCell(level) },
      params: {
        gain: param({ default: opts.gain ?? 1, bind: gain.gain, min: 0, smoothing: SMOOTHING }),
        pan: param({ default: opts.pan ?? 0, bind: pan.pan, min: -1, max: 1, smoothing: SMOOTHING }),
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
    this.tapProcessor = new ChannelTap(ctx, input, mute);
    this.defineGraph(() => [
      [input, gain],
      [gain, pan],
      [pan, mute],
      [mute, output],
    ]);
    this.stopMeter = startMeter(ctx, mute, level);
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

  /** Sends the post-mute signal into the bus's receive point at `gain` (linear). The send joins the latency graph, so delay compensation covers it. */
  send(bus: SendBus, name: string, gain = 1): Send {
    const send = new Send(this.context, gain, (gone) => this.sends.delete(gone));
    this.tapProcessor.connect(send);
    send.connect(bus.receive(name));
    this.sends.add(send);
    return send;
  }

  override dispose(): void {
    this.stopMeter();
    for (const send of [...this.sends]) send.dispose();
    this.tapProcessor.dispose();
    super.dispose();
  }
}

/** Peak of both channels over the analyser window, refreshed every animation frame. Returns the stop function. */
function startMeter(ctx: BaseAudioContext, source: AudioNode, level: { value: number }): () => void {
  if (typeof requestAnimationFrame !== "function") return () => {};
  const splitter = new ChannelSplitterNode(ctx, { numberOfOutputs: 2 });
  const analysers = [0, 1].map(() => new AnalyserNode(ctx, { fftSize: 2048, smoothingTimeConstant: 0 }));
  source.connect(splitter);
  analysers.forEach((analyser, i) => splitter.connect(analyser, i));
  const data = new Float32Array(analysers[0]!.fftSize);
  let frame = 0;
  const tick = () => {
    let peak = 0;
    for (const analyser of analysers) {
      analyser.getFloatTimeDomainData(data);
      for (let i = 0; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i]!));
    }
    level.value = peak > 0 ? 20 * Math.log10(peak) : -Infinity;
    frame = requestAnimationFrame(tick);
  };
  frame = requestAnimationFrame(tick);
  return () => {
    cancelAnimationFrame(frame);
    source.disconnect(splitter);
    splitter.disconnect();
    for (const analyser of analysers) analyser.disconnect();
  };
}
