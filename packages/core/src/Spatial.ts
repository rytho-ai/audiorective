import { AudioProcessor } from "./AudioProcessor";
import type { Param } from "./Param";

export interface SpatialOptions {
  /** Distance attenuation law; defaults to "inverse". */
  distanceModel?: DistanceModelType;
  /** Reference distance in scene units, nonnegative; defaults to 1. */
  refDistance?: number;
  /** Maximum attenuation distance in scene units, nonnegative; defaults to 10000. */
  maxDistance?: number;
  /** Dimensionless distance attenuation strength, nonnegative; defaults to 1. */
  rolloffFactor?: number;
  /** Full-volume cone angle in degrees, 0..360; defaults to 360. */
  coneInnerAngle?: number;
  /** Outer cone angle in degrees, 0..360; defaults to 0. */
  coneOuterAngle?: number;
  /** Linear level outside the outer cone, 0..1; defaults to 0. */
  coneOuterGain?: number;
}

type SpatialParams = {
  refDistance: Param<number>;
  maxDistance: Param<number>;
  rolloffFactor: Param<number>;
  distanceModel: Param<DistanceModelType>;
  coneInnerAngle: Param<number>;
  coneOuterAngle: Param<number>;
  coneOuterGain: Param<number>;
};

/** Positional audio: an HRTF `PannerNode` whose position, orientation and cone are `params`; `input` feeds the panner and `output` is the panner. */
export class Spatial extends AudioProcessor<SpatialParams> {
  /** The underlying HRTF `PannerNode`, for native properties the params do not cover. */
  readonly panner: PannerNode;
  private readonly _input: GainNode;

  constructor(context: AudioContext, options: SpatialOptions = {}) {
    const panner = context.createPanner();
    panner.panningModel = "HRTF";
    const input = new GainNode(context);
    input.connect(panner);

    const setField = <K extends keyof PannerNode>(key: K) => ({
      set: (v: PannerNode[K]) => {
        panner[key] = v;
      },
    });

    super(context, ({ param }) => ({
      params: {
        refDistance: param<number>({ default: options.refDistance ?? 1, label: "Ref Distance", min: 0, bind: setField("refDistance") }),
        maxDistance: param<number>({ default: options.maxDistance ?? 10000, label: "Max Distance", min: 0, bind: setField("maxDistance") }),
        rolloffFactor: param<number>({ default: options.rolloffFactor ?? 1, label: "Rolloff", min: 0, bind: setField("rolloffFactor") }),
        distanceModel: param<DistanceModelType>({
          default: options.distanceModel ?? "inverse",
          label: "Distance Model",
          bind: setField("distanceModel"),
        }),
        coneInnerAngle: param<number>({
          default: options.coneInnerAngle ?? 360,
          label: "Cone Inner",
          min: 0,
          max: 360,
          bind: setField("coneInnerAngle"),
        }),
        coneOuterAngle: param<number>({
          default: options.coneOuterAngle ?? 0,
          label: "Cone Outer",
          min: 0,
          max: 360,
          bind: setField("coneOuterAngle"),
        }),
        coneOuterGain: param<number>({
          default: options.coneOuterGain ?? 0,
          label: "Cone Outer Gain",
          min: 0,
          max: 1,
          bind: setField("coneOuterGain"),
        }),
      },
    }));

    this.panner = panner;
    this._input = input;
  }

  override get input(): GainNode {
    return this._input;
  }

  get output(): AudioNode {
    return this.panner;
  }

  override dispose(): void {
    super.dispose();
    this._input.disconnect();
    this.panner.disconnect();
  }
}
