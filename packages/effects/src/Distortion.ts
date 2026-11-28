import type { Param } from "@audiorective/core";
import { Effect, type EffectOptions } from "./Effect";
import { LEAD, SMOOTHING } from "./internal/smoothing";

export interface DistortionOptions extends EffectOptions {
  /** 0..1 drive. Default 0.4. */
  distortion?: number;
  /** WaveShaper oversampling. Default "none"; "2x"/"4x" reduce aliasing but add browser-defined latency that this effect cannot declare. */
  oversample?: OverSampleType;
}

const CURVE_LENGTH = 4096;

type GainPoint = Readonly<{ time: number; value: number }>;
function gainAt(points: readonly GainPoint[], time: number): number {
  if (time <= points[0]!.time) return points[0]!.value;
  for (let i = 1; i < points.length; i++) {
    const point = points[i]!;
    if (time <= point.time) {
      const previous = points[i - 1]!;
      return previous.value + (point.value - previous.value) * ((time - previous.time) / (point.time - previous.time));
    }
  }
  return points.at(-1)!.value;
}

/** Tone.js's distortion curve normalized to unity peak: soft clipping that approaches a square as k grows. */
export function distortionCurve(amount: number): Float32Array<ArrayBuffer> {
  const k = amount * 100;
  const deg = Math.PI / 180;
  const curve = new Float32Array(CURVE_LENGTH);
  // Calculate peak value at x=1 for normalization
  const peak = ((3 + k) * 20 * deg) / (Math.PI + k);
  for (let i = 0; i < CURVE_LENGTH; i++) {
    const x = (i * 2) / CURVE_LENGTH - 1;
    curve[i] = ((3 + k) * x * 20 * deg) / (Math.PI + k * Math.abs(x)) / peak;
  }
  return curve as Float32Array<ArrayBuffer>;
}

/** WaveShaper distortion. Changing `distortion` crossfades prebuilt, silent shaper arms over 10 ms, so a drag never clicks. */
export class Distortion extends Effect<{ distortion: Param<number> }> {
  static override readonly type: string = "Distortion";
  constructor(ctx: BaseAudioContext, opts: DistortionOptions = {}) {
    const oversample = opts.oversample ?? "none";
    const entry = new GainNode(ctx);
    const exit = new GainNode(ctx);
    const quantum = 128 / ctx.sampleRate;
    const lead = Math.max(LEAD, 3 * quantum);
    // Edits coalesce while an incoming arm is safely silent. Preallocate enough
    // arms to cover every handover before the oldest native gate reaches zero.
    const count = Math.ceil((lead + SMOOTHING) / (lead - quantum)) + 1;
    const shapers = Array.from({ length: count }, () => new WaveShaperNode(ctx, { oversample, curve: distortionCurve(opts.distortion ?? 0.4) }));
    const gates = shapers.map((_, i) => new GainNode(ctx, { gain: i === 0 ? 1 : 0 }));
    const envelopes: GainPoint[][] = gates.map((_, i) => [{ time: 0, value: i === 0 ? 1 : 0 }]);
    shapers.forEach((shaper, i) => {
      entry.connect(shaper);
      shaper.connect(gates[i]!);
      gates[i]!.connect(exit);
    });
    let live = 0;
    let first = true;
    let startsAt = 0;
    super(
      ctx,
      { input: entry, output: exit },
      ({ param }) => ({
        params: {
          distortion: param<number>({
            default: opts.distortion ?? 0.4,
            min: 0,
            max: 1,
            bind: {
              set: (v) => {
                if (first) {
                  first = false;
                  return;
                }
                const now = ctx.currentTime;
                if (now === 0 || now + quantum < startsAt) {
                  shapers[live]!.curve = distortionCurve(v);
                  return;
                }
                const next = (live + 1) % count;
                shapers[next]!.curve = distortionCurve(v);
                const start = now + lead;
                const end = start + SMOOTHING;
                const held = gainAt(envelopes[live]!, start);
                gates[live]!.gain.cancelAndHoldAtTime(start);
                gates[live]!.gain.setValueAtTime(held, start);
                gates[live]!.gain.linearRampToValueAtTime(0, end);
                envelopes[live] = [...envelopes[live]!.filter((point) => point.time < start), { time: start, value: held }, { time: end, value: 0 }];
                // Preserve older outgoing fades. The incoming gate is their exact
                // piecewise-linear complement, so overlapping handovers keep unity gain.
                const times = [
                  ...new Set([
                    start,
                    end,
                    ...envelopes.flatMap((points, i) =>
                      i === next ? [] : points.map((point) => point.time).filter((time) => time > start && time < end),
                    ),
                  ]),
                ].sort((a, b) => a - b);
                const incoming = times.map((time) => ({
                  time,
                  value: Math.max(0, Math.min(1, 1 - envelopes.reduce((sum, points, i) => sum + (i === next ? 0 : gainAt(points, time)), 0))),
                }));
                const gain = gates[next]!.gain;
                gain.cancelScheduledValues(now);
                gain.setValueAtTime(0, start);
                for (const point of incoming.slice(1)) gain.linearRampToValueAtTime(point.value, point.time);
                envelopes[next] = incoming;
                startsAt = start;
                live = next;
              },
            },
          }),
        },
        cells: {},
        latency: 0,
      }),
      opts,
    );
  }
}
