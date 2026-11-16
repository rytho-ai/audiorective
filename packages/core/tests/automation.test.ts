import { describe, expect, test } from "vitest";
import { effect, isSignal } from "alien-signals";
import { AutomationBinding, AutomationCurve, audioParamTarget } from "../src/automation";
import type { AutomationPoint, AutomationTarget } from "../src/automation";
import { Param } from "../src/Param";
import { SchedulableParam } from "../src/SchedulableParam";
import { ParamSync } from "../src/ParamSync";

const point = (time: number, value: number, shape: "linear" | "hold" = "linear"): AutomationPoint => ({ time, value, shape });
const ramp = () => new AutomationCurve([point(0, 0), point(1, 1)]);
function recording() {
  const clock = { currentTime: 0 };
  const programs: { points: readonly AutomationPoint[]; when: number }[] = [];
  const holds: number[] = [];
  const target: AutomationTarget = { program: (points, when) => programs.push({ points, when }), hold: (time) => holds.push(time) };
  return { clock, programs, holds, target };
}

describe("AutomationCurve", () => {
  test("sorts, freezes and copies input, with outgoing linear/hold segments", () => {
    const input = [point(3, 8), point(1, 2, "hold"), point(2, 4)];
    const curve = new AutomationCurve(input);
    input[0] = point(3, 100);
    expect(curve.value.map((p) => p.time)).toEqual([1, 2, 3]);
    expect(Object.isFrozen(curve.value)).toBe(true);
    expect(curve.value.every(Object.isFrozen)).toBe(true);
    expect([-2, 0, 1, 1.5, 2, 2.5, 3, 8].map((x) => curve.valueAt(x))).toEqual([2, 2, 2, 2, 4, 6, 8, 8]);
  });

  test(".value and the raw $ signal share reactive tracking", () => {
    const curve = ramp();
    const seen: number[] = [];
    const dispose = effect(() => {
      seen.push(curve.$()[1].value);
    });
    curve.value = [point(0, 1), point(1, 2)];
    const replacement = new AutomationCurve([point(0, 2), point(1, 3)]).value;
    curve.$(replacement);
    expect(isSignal(curve.$)).toBe(true);
    expect(curve.value).toBe(replacement);
    expect(curve.value).toBe(curve.$());
    expect(seen).toEqual([1, 2, 3]);
    dispose();
  });

  test.each(
    [
      [],
      [point(-1, 0)],
      [point(NaN, 1)],
      [point(0, Infinity)],
      [point(0, 0), point(0, 1)],
      [{ time: 0, value: 0, shape: "exponential" }],
      [undefined],
      new Array(2),
    ].map((invalid) => [invalid]),
  )("rejects malformed snapshots atomically: %j", (invalid) => {
    const curve = ramp();
    const before = curve.value;
    expect(() => {
      curve.value = invalid as readonly AutomationPoint[];
    }).toThrow("AutomationCurve needs nonempty finite points");
    expect(curve.value).toBe(before);
  });

  test("supports a one-point constant and rejects nonfinite sampling", () => {
    const curve = new AutomationCurve([point(4, 0.7)]);
    expect(curve.valueAt(0)).toBe(0.7);
    expect(curve.valueAt(10)).toBe(0.7);
    expect(() => curve.valueAt(NaN)).toThrow("AutomationCurve sample time must be finite.");
  });
});

describe("AutomationBinding", () => {
  test("crop, scale, live edit and stop use one stable audio anchor", () => {
    const r = recording(),
      curve = ramp();
    const binding = new AutomationBinding(r.clock, curve, r.target);
    binding.start({ when: 2, from: 0.2, to: 0.8, secondsPerUnit: 2 });
    expect(r.programs[0].when).toBe(2);
    expect(r.programs[0].points[0]).toEqual(point(0, 0.2));
    expect(r.programs[0].points[1].time).toBeCloseTo(1.2);
    expect(binding.position).toBe(0.2);
    r.clock.currentTime = 2.4;
    curve.value = [point(0, 1), point(1, 0)];
    expect(r.programs[1].when).toBe(2.4);
    expect(r.programs[1].points[0].value).toBeCloseTo(0.6);
    expect(r.programs[1].points[1].time).toBeCloseTo(0.8);
    binding.stop();
    expect(binding.position).toBeCloseTo(0.4);
    r.clock.currentTime = 10;
    curve.value = [point(0, 0), point(1, 0.2)];
    expect(r.programs).toHaveLength(2);
    binding.stop();
    binding.destroy();
    binding.destroy();
    expect(r.holds).toEqual([2.4]);
  });

  test("captures default endpoint; clamps past starts and ended position", () => {
    const r = recording();
    r.clock.currentTime = 3;
    const curve = ramp(),
      binding = new AutomationBinding(r.clock, curve, r.target);
    binding.start({ when: 0 });
    expect(r.programs[0].when).toBe(3);
    r.clock.currentTime = 6;
    expect(binding.position).toBe(1);
    curve.value = [point(0, 0), point(2, 1)];
    expect(r.programs[1].points).toEqual([point(0, 0.5)]);
    binding.destroy();
  });

  test("constant before first point, hold boundaries and zero-length range", () => {
    const r = recording(),
      curve = new AutomationCurve([point(1, 0.2), point(2, 0.8, "hold"), point(3, 0.4)]);
    const binding = new AutomationBinding(r.clock, curve, r.target);
    binding.start({ to: 4 });
    expect(r.programs[0].points).toEqual([point(0, 0.2, "hold"), point(1, 0.2), point(2, 0.8, "hold"), point(3, 0.4), point(4, 0.4, "hold")]);
    binding.start({ from: 2.5, to: 2.5 });
    expect(r.programs[1].points).toEqual([point(0, 0.8, "hold")]);
    binding.destroy();
  });

  test.each([
    { from: -1 },
    { to: -1 },
    { from: 2, to: 1 },
    { when: -1 },
    { when: NaN },
    { secondsPerUnit: 0 },
    { secondsPerUnit: Infinity },
    { to: 1e308, secondsPerUnit: 1e308 },
  ])("invalid starts leave the existing run untouched: %j", (options) => {
    const r = recording(),
      binding = new AutomationBinding(r.clock, ramp(), r.target);
    binding.start();
    expect(() => binding.start(options)).toThrow("AutomationBinding needs finite nonnegative times");
    expect(r.programs).toHaveLength(1);
    expect(r.holds).toHaveLength(0);
    binding.destroy();
    expect(() => binding.start()).toThrow("AutomationBinding is destroyed.");
  });

  test("target reads do not subscribe the binding to native readback or other controls", () => {
    const r = recording(),
      other = new Param({ default: 1 }),
      curve = ramp();
    const target: AutomationTarget = {
      hold() {},
      program(points, when) {
        void other.value;
        r.target.program(points, when);
      },
    };
    const binding = new AutomationBinding(r.clock, curve, target);
    binding.start();
    curve.value = [point(0, 1)];
    other.value = 2;
    expect(r.programs).toHaveLength(2);
    binding.destroy();
    curve.value = [point(0, 3)];
    expect(r.programs).toHaveLength(2);
    other.destroy();
  });

  test("target failure cancels a partial schedule and leaves the binding restartable", () => {
    const r = recording();
    let fail = true;
    const target: AutomationTarget = {
      hold: r.target.hold,
      program(points, when) {
        if (fail) throw new Error("target rejected");
        r.target.program(points, when);
      },
    };
    const binding = new AutomationBinding(r.clock, ramp(), target);
    expect(() => binding.start()).toThrow("target rejected");
    expect(r.holds).toEqual([0]);
    fail = false;
    binding.start();
    expect(r.programs).toHaveLength(1);
    binding.destroy();
  });

  test("a live target failure stops the run, and a restart retains reactive editing", () => {
    const r = recording(),
      curve = ramp();
    let fail = false;
    const target: AutomationTarget = {
      hold: r.target.hold,
      program(points, when) {
        if (fail) throw new Error("live target rejected");
        r.target.program(points, when);
      },
    };
    const binding = new AutomationBinding(r.clock, curve, target);
    binding.start();
    fail = true;
    expect(() => {
      curve.value = [point(0, 0.3)];
    }).toThrow("live target rejected");
    expect(r.holds).toEqual([0]);
    expect(curve.valueAt(0)).toBe(0.3);
    fail = false;
    binding.start();
    curve.value = [point(0, 0.6)];
    expect(r.programs).toHaveLength(3);
    expect(r.programs.at(-1)!.points[0].value).toBe(0.6);
    binding.destroy();
  });

  test("curve edits before a future start preserve its range and absolute anchor", () => {
    const r = recording(),
      curve = ramp();
    const binding = new AutomationBinding(r.clock, curve, r.target);
    binding.start({ when: 2, from: 0.2, to: 0.8 });
    r.clock.currentTime = 1;
    curve.value = [point(0, 1), point(1, 0)];
    expect(r.programs[1].when).toBe(2);
    expect(r.programs[1].points[0].value).toBeCloseTo(0.8);
    expect(r.programs[1].points[1].time).toBeCloseTo(0.6);
    expect(binding.position).toBe(0.2);
    binding.destroy();
    expect(r.holds).toEqual([1]);
  });
});

const rate = 48000;
function offline(seconds = 0.4, initial = 0.3) {
  const ctx = new OfflineAudioContext(1, Math.ceil(rate * seconds), rate);
  const source = new ConstantSourceNode(ctx, { offset: 1 });
  const gain = new GainNode(ctx, { gain: initial });
  source.connect(gain).connect(ctx.destination);
  source.start();
  return { ctx, gain };
}
function at(buffer: AudioBuffer, time: number) {
  return buffer.getChannelData(0)[Math.round(time * rate)];
}

describe("native rendered automation", () => {
  test("renders cropped/scaled linear and hold segments, without changing pre-start samples", async () => {
    const { ctx, gain } = offline(0.5);
    const curve = new AutomationCurve([point(0, 0), point(0.5, 1, "hold"), point(1, 0.4)]);
    const binding = new AutomationBinding(ctx, curve, audioParamTarget(gain.gain));
    binding.start({ when: 0.05, from: 0.25, to: 1, secondsPerUnit: 0.4 });
    const buffer = await ctx.startRendering();
    expect(at(buffer, 0.02)).toBeCloseTo(0.3, 5);
    expect(at(buffer, 0.05)).toBeCloseTo(0.5, 5);
    expect(at(buffer, 0.1)).toBeCloseTo(0.75, 5);
    expect(at(buffer, 0.25)).toBeCloseTo(1, 5);
    expect(at(buffer, 0.36)).toBeCloseTo(0.4, 5);
    binding.destroy();
  });

  test("stop before future start removes every queued event", async () => {
    const { ctx, gain } = offline();
    const binding = new AutomationBinding(ctx, ramp(), audioParamTarget(gain.gain));
    binding.start({ when: 0.1, secondsPerUnit: 0.2 });
    binding.stop();
    const buffer = await ctx.startRendering();
    expect(at(buffer, 0.2)).toBeCloseTo(0.3, 5);
    expect(at(buffer, 0.35)).toBeCloseTo(0.3, 5);
    binding.destroy();
  });

  test("live replacement reprograms actual PCM at the current curve position", async () => {
    const { ctx, gain } = offline();
    const curve = ramp();
    const binding = new AutomationBinding(ctx, curve, audioParamTarget(gain.gain));
    binding.start({ when: 0.02, secondsPerUnit: 0.3 });
    const suspended = ctx.suspend(0.12);
    const rendered = ctx.startRendering();
    await suspended;
    const time = ctx.currentTime;
    curve.value = [point(0, 1), point(1, 0)];
    await ctx.resume();
    const buffer = await rendered;
    expect(at(buffer, 0.08)).toBeCloseTo(0.2, 4);
    expect(at(buffer, time + 0.03)).toBeCloseTo(1 - (time + 0.03 - 0.02) / 0.3, 4);
    expect(at(buffer, 0.36)).toBeCloseTo(0, 5);
    binding.destroy();
  });

  test.each(["stop", "destroy"] as const)("%s in a ramp holds the native value, not a polled UI snapshot", async (action) => {
    const { ctx, gain } = offline();
    const curve = ramp();
    const param = new SchedulableParam({ default: 0, audioContext: ctx, audioParam: gain.gain });
    const registrations = ParamSync.for(ctx).size;
    const binding = new AutomationBinding(ctx, curve, audioParamTarget(param.audioParam));
    expect(ParamSync.for(ctx).size).toBe(registrations);
    binding.start({ secondsPerUnit: 0.3 });
    const suspended = ctx.suspend(0.1);
    const rendered = ctx.startRendering();
    await suspended;
    const held = ctx.currentTime / 0.3;
    binding[action]();
    curve.value = [point(0, 1)];
    await ctx.resume();
    const buffer = await rendered;
    expect(at(buffer, 0.25)).toBeCloseTo(held, 4);
    expect(at(buffer, 0.35)).toBeCloseTo(held, 4);
    binding.destroy();
    param.destroy();
    expect(ParamSync.for(ctx).size).toBe(0);
  });

  test("restart removes the old endpoint and runs a new range", async () => {
    const { ctx, gain } = offline();
    const curve = ramp();
    const binding = new AutomationBinding(ctx, curve, audioParamTarget(gain.gain));
    binding.start({ secondsPerUnit: 0.3 });
    const suspended = ctx.suspend(0.1);
    const rendered = ctx.startRendering();
    await suspended;
    const held = ctx.currentTime / 0.3;
    binding.start({ when: 0.2, from: 0.8, to: 1, secondsPerUnit: 0.5 });
    await ctx.resume();
    const buffer = await rendered;
    expect(at(buffer, 0.16)).toBeCloseTo(held, 4);
    expect(at(buffer, 0.25)).toBeCloseTo(0.9, 4);
    expect(at(buffer, 0.35)).toBeCloseTo(1, 5);
    binding.destroy();
  });
});
