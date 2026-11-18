import { effect, ParamSync } from "@audiorective/core";
import { AutomationBinding, AutomationCurve } from "@audiorective/core/automation";
import { Filter } from "../src";
import { expect, test, vi } from "vitest";
import { EffectRack, type RackFilter, type RackMacroSettings } from "../src/rack";

const low: RackFilter = { id: "low", type: "filter", mode: "lowpass", enabled: true, wet: 1, frequency: 120, q: 0.7 };
const high: RackFilter = { id: "high", type: "filter", mode: "highpass", enabled: true, wet: 0, frequency: 1800, q: 0.7 };
const tone: RackMacroSettings = {
  id: "tone",
  value: 0,
  targets: [
    { slotId: "low", parameter: "frequency", min: 120, max: 12_000, scale: "exponential" },
    { slotId: "low", parameter: "q", min: 0.7, max: 1.3 },
  ],
};
const space: RackMacroSettings = { id: "space", value: 0, targets: [{ slotId: "high", parameter: "wet", min: 0, max: 1 }] };

test("two independent macros fan out to native ramps and hold steps on the audio thread", async () => {
  const sampleRate = 48000;
  const context = new OfflineAudioContext(2, sampleRate, sampleRate);
  const rack = new EffectRack(context, [low, high], [tone, space]);
  const lowReference = new Filter(context, { frequency: 120, Q: 0.7, wet: 1 });
  const highReference = new Filter(context, { frequency: 1800, Q: 0.7, wet: 0, type: "highpass" });
  const toneBinding = new AutomationBinding(
    context,
    new AutomationCurve([
      { time: 0, value: 0, shape: "linear" },
      { time: 0.5, value: 1, shape: "hold" },
    ]),
    rack.macro("tone")!.automation,
  );
  const spaceBinding = new AutomationBinding(
    context,
    new AutomationCurve([
      { time: 0, value: 0, shape: "hold" },
      { time: 0.6, value: 0.8, shape: "hold" },
    ]),
    rack.macro("space")!.automation,
  );
  try {
    const merger = context.createChannelMerger(2);
    const oscillator = context.createOscillator();
    oscillator.frequency.value = 1000;
    oscillator.connect(rack.input);
    rack.output.connect(merger, 0, 0);
    oscillator.connect(lowReference.input);
    lowReference.output.connect(highReference.input);
    highReference.output.connect(merger, 0, 1);
    merger.connect(context.destination);
    const when = 0.05;
    toneBinding.start({ when });
    spaceBinding.start({ when });
    lowReference.params.frequency.setValueAtTime(120, when).exponentialRampToValueAtTime(12_000, when + 0.5);
    lowReference.params.Q.setValueAtTime(0.7, when).linearRampToValueAtTime(1.3, when + 0.5);
    highReference.params.wet.setValueAtTime(0, when).setValueAtTime(0.8, when + 0.6);
    oscillator.start();
    const output = await context.startRendering();
    const actual = output.getChannelData(0),
      reference = output.getChannelData(1);
    const peak = (from: number, to: number) => Math.max(...actual.slice(from * sampleRate, to * sampleRate).map(Math.abs));
    expect(peak(0.005, 0.03)).toBeLessThan(0.03);
    expect(peak(0.45, 0.55)).toBeGreaterThan(0.8);
    expect(peak(0.8, 0.95)).toBeLessThan(0.55);
    expect(actual.reduce((error, value, i) => Math.max(error, Math.abs(value - reference[i])), 0)).toBeLessThan(0.0001);
  } finally {
    toneBinding.destroy();
    spaceBinding.destroy();
    rack.destroy();
    lowReference.destroy();
    highReference.destroy();
  }
});

test("a failed whole-rack recall preserves both macros, their observers and queued audio", async () => {
  const context = new OfflineAudioContext(1, 48000, 48000);
  const rack = new EffectRack(context, [low, high], [tone, space]);
  const control = rack.macro("tone")!;
  const seen: number[] = [];
  const stop = effect(() => seen.push(control.param.value));
  try {
    control.param.$(0.25);
    expect(seen.at(-1)).toBe(0.25);
    control.automation.program(
      [
        { time: 0, value: 0, shape: "hold" },
        { time: 0.25, value: 1, shape: "hold" },
      ],
      0,
    );
    const size = ParamSync.for(context).size;
    const allocate = context.createConstantSource.bind(context);
    let allocated = 0;
    const spy = vi.spyOn(context, "createConstantSource").mockImplementation(() => {
      if (++allocated === 2) throw new Error("fixture rejected the second macro");
      return allocate();
    });
    try {
      expect(() =>
        rack.setPreset({
          effects: [low],
          macros: [
            { ...tone, value: 0.1 },
            { id: "newA", value: 0, targets: [] },
            { id: "newB", value: 0, targets: [] },
          ],
        }),
      ).toThrow("fixture rejected the second macro");
    } finally {
      spy.mockRestore();
    }
    expect(ParamSync.for(context).size).toBe(size);
    expect(rack.cells.macros.value.map(({ id }) => id)).toEqual(["tone", "space"]);
    expect(rack.macro("tone")).toBe(control);
    expect(() => rack.setPreset({ effects: [low], macros: [tone, { ...tone, id: "conflict" }] })).toThrow(/distinct valid targets/);

    // Reorder without replacing any macro timeline, then remove an unrelated target.
    rack.setEffects([high, low]);
    rack.setEffects([low]);
    expect(rack.capturePreset().macros?.[1].targets).toEqual([]);
    const osc = context.createOscillator();
    osc.frequency.value = 1000;
    osc.connect(rack.input);
    rack.output.connect(context.destination);
    osc.start();
    const output = (await context.startRendering()).getChannelData(0);
    expect(Math.max(...output.slice(1000, 2400).map(Math.abs))).toBeLessThan(0.03);
    expect(Math.max(...output.slice(23000, 25000).map(Math.abs))).toBeGreaterThan(0.8);
    rack.setPreset({ effects: [low, high], macros: [{ ...tone, value: 0.25 }, space] });
    expect(rack.macro("tone")).toBe(control);
    expect(control.param.value).toBe(0.25);
  } finally {
    stop();
    rack.destroy();
  }
  expect(ParamSync.for(context).size).toBe(0);
});

test("a wet macro continues in time across bypass and resumes at its live phase", async () => {
  const rate = 48000;
  const context = new OfflineAudioContext(1, rate, rate);
  const wet: RackMacroSettings = { id: "wet", value: 1, targets: [{ slotId: "low", parameter: "wet", min: 0, max: 1 }] };
  const rack = new EffectRack(context, [low], [wet]);
  try {
    const oscillator = context.createOscillator();
    oscillator.frequency.value = 1000;
    oscillator.connect(rack.input);
    rack.output.connect(context.destination);
    oscillator.start();
    rack.macro("wet")!.automation.program(
      [
        { time: 0, value: 1, shape: "linear" },
        { time: 0.8, value: 0, shape: "hold" },
      ],
      0,
    );
    const bypass = context.suspend(0.25).then(async () => {
      rack.setEffects([{ ...low, enabled: false }]);
      await context.resume();
    });
    const enable = context.suspend(0.5).then(async () => {
      rack.setEffects([low]);
      await context.resume();
    });
    const rendering = context.startRendering();
    const [rendered] = await Promise.all([rendering, bypass, enable]);
    const samples = rendered.getChannelData(0);
    const peak = (from: number, to: number) => Math.max(...samples.slice(from * rate, to * rate).map(Math.abs));
    expect(peak(0.14, 0.16)).toBeGreaterThan(0.16);
    expect(peak(0.14, 0.16)).toBeLessThan(0.23);
    expect(peak(0.3, 0.35)).toBeCloseTo(1, 4);
    expect(peak(0.63, 0.65)).toBeGreaterThan(0.78);
    expect(peak(0.63, 0.65)).toBeLessThan(0.84);
  } finally {
    rack.destroy();
  }
});
