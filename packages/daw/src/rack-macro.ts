import { Param, SchedulableParam, batch, type SignalAccessor } from "@audiorective/core";
import { isMacroValue, type RackMacroMapping, type RackMacroSettings } from "./rack-preset";
import { AutomationCurve, type AutomationPoint, type AutomationTarget } from "@audiorective/core/automation";

export interface RackMacro {
  readonly id: string;
  readonly param: Param<number>;
  readonly automation: AutomationTarget;
}

export type MacroTarget = {
  mapping: RackMacroMapping;
  param: SchedulableParam;
  muted: boolean;
};

function project(mapping: RackMacroMapping, value: number): number {
  if (value === 0) return mapping.min;
  if (value === 1) return mapping.max;
  return mapping.scale === "exponential"
    ? Math.exp(Math.log(mapping.min) * (1 - value) + Math.log(mapping.max) * value)
    : mapping.min + (mapping.max - mapping.min) * value;
}

function schedule(native: AudioParam, points: readonly AutomationPoint[], when: number, target?: MacroTarget): void {
  native.cancelAndHoldAtTime(when);
  const mapping = target?.mapping;
  for (const [index, point] of points.entries()) {
    const value = target?.muted ? 0 : mapping ? project(mapping, point.value) : point.value;
    const at = when + point.time;
    if (index === 0 || points[index - 1].shape === "hold" || target?.muted) native.setValueAtTime(value, at);
    else if (mapping?.scale === "exponential") native.exponentialRampToValueAtTime(value, at);
    else native.linearRampToValueAtTime(value, at);
  }
}

class MacroControl extends Param<number> {
  override readonly $: SignalAccessor<number>;

  constructor(native: SchedulableParam, label: string, write: (value: number) => void, initial: number) {
    super({ default: initial, min: 0, max: 1, label });
    function access(): number;
    function access(value: number): void;
    function access(...args: [] | [number]): number | void {
      if (args.length) write(args[0]);
      else return native.$();
    }
    this.$ = access;
  }
}

/** Owned by the rack. The single normalized timeline fans out to native parameter timelines. */
export class LiveRackMacro {
  readonly control: RackMacro;
  readonly label: string | undefined;
  private readonly source: ConstantSourceNode;
  private readonly native: SchedulableParam;
  private targets: readonly MacroTarget[] = [];
  private run?: { when: number; curve: AutomationCurve };
  private disposed = false;

  constructor(
    private readonly context: BaseAudioContext,
    silentSink: AudioNode,
    settings: RackMacroSettings,
  ) {
    this.label = settings.label;
    this.source = context.createConstantSource();
    this.source.offset.value = settings.value;
    this.source.connect(silentSink);
    try {
      this.source.start();
      this.native = new SchedulableParam({
        audioContext: context,
        audioParam: this.source.offset,
        default: settings.value,
      });
    } catch (error) {
      this.source.disconnect();
      try {
        this.source.stop();
      } catch {
        /* Source did not start. */
      }
      throw error;
    }
    const param = new MacroControl(this.native, settings.label ?? settings.id, (value) => this.write(value), settings.value);
    this.control = Object.freeze({
      id: settings.id,
      param,
      automation: Object.freeze({
        program: (points: readonly AutomationPoint[], when: number) => this.program(points, when),
        hold: (time: number) => this.hold(time),
      }),
    });
  }

  snapshot(): RackMacroSettings {
    void this.control.param.value;
    return Object.freeze({
      id: this.control.id,
      ...(this.label === undefined ? {} : { label: this.label }),
      value: this.native.read(),
      targets: Object.freeze(this.targets.map(({ mapping }) => mapping)),
    });
  }

  bind(targets: readonly MacroTarget[]): void {
    const now = this.context.currentTime;
    for (const target of this.targets) {
      if (targets.some(({ param }) => param === target.param)) continue;
      const value = target.param.read();
      target.param.audioParam.cancelScheduledValues(0);
      target.param.value = value;
    }
    const value = this.native.read();
    for (const target of targets) {
      if (this.targets.some((old) => old.param === target.param && old.muted === target.muted && old.mapping === target.mapping)) continue;
      this.writeTarget(target, value, now);
      if (this.run && !target.muted) {
        const { when, curve } = this.run;
        const from = Math.max(0, now - when);
        const previous = curve.value.findLast((point) => point.time <= from);
        const remaining: AutomationPoint[] = [
          { time: 0, value: curve.valueAt(from), shape: previous?.shape ?? "hold" },
          ...curve.value.filter((point) => point.time > from).map((point) => ({ ...point, time: point.time - from })),
        ];
        schedule(target.param.audioParam, remaining, Math.max(now, when), target);
      }
    }
    this.targets = targets;
  }

  write(value: number): void {
    this.assertAlive();
    if (!isMacroValue(value)) throw new RangeError("TrackRack macro value needs a number from 0 to 1.");
    this.run = undefined;
    const now = this.context.currentTime;
    batch(() => {
      this.native.audioParam.cancelScheduledValues(now);
      this.native.value = value;
      this.native.audioParam.setValueAtTime(value, now);
      for (const target of this.targets) this.writeTarget(target, value, now);
    });
  }

  private writeTarget(target: MacroTarget, value: number, when: number): void {
    const native = target.param.audioParam;
    const next = target.muted ? 0 : project(target.mapping, value);
    native.cancelScheduledValues(when);
    target.param.value = next;
    native.setValueAtTime(next, when);
  }

  private program(points: readonly AutomationPoint[], when: number): void {
    this.assertAlive();
    if (
      !Number.isFinite(when) ||
      when < 0 ||
      points[0]?.time !== 0 ||
      points.some((point) => !point || !isMacroValue(point.value) || !Number.isFinite(when + point.time))
    ) {
      throw new RangeError("TrackRack macro automation needs a time and a normalized curve starting at zero.");
    }
    const curve = new AutomationCurve(points);
    const start = Math.max(this.context.currentTime, when);
    schedule(this.native.audioParam, curve.value, start);
    for (const target of this.targets) schedule(target.param.audioParam, curve.value, start, target);
    this.run = { when: start, curve };
  }

  private hold(time: number): void {
    if (this.disposed) return;
    this.native.audioParam.cancelAndHoldAtTime(time);
    for (const target of this.targets) target.param.audioParam.cancelAndHoldAtTime(time);
    this.run = undefined;
  }

  private assertAlive(): void {
    if (this.disposed) throw new Error("TrackRack macro is disposed.");
  }

  dispose(): void {
    if (this.disposed) return;
    this.hold(this.context.currentTime);
    this.disposed = true;
    this.native.dispose();
    this.control.param.dispose();
    this.source.stop();
    this.source.disconnect();
  }
}
