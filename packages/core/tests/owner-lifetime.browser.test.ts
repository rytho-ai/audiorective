import { expect, test } from "vitest";
import { cell, effect, Sampler, defineGraph, type GraphHandle } from "../src";
import { AutomationBinding, AutomationCurve, audioParamTarget } from "../src/automation";

test("a retained sampler keeps its sustain handling after its creator effect reruns", async () => {
  const context = new AudioContext();
  const revision = cell(0);
  let sampler: Sampler | undefined;
  const stop = effect(() => {
    void revision.value;
    sampler ??= new Sampler(context, { sound: (ctx) => new ConstantSourceNode(ctx) });
  });
  const owner = sampler!;
  try {
    owner.params.sustain.value = true;
    const voice = owner.noteOn(60)!;
    owner.noteOff(60);
    expect(voice.playing.value).toBe(true);
    revision.value = 1;
    owner.params.sustain.value = false;
    expect(voice.playing.value).toBe(false);
  } finally {
    stop();
    owner.dispose();
    owner.dispose();
    await context.close();
  }
});

test("a retained automation binding keeps reprogramming after its creator effect reruns or stops", async () => {
  const context = new AudioContext();
  const revision = cell(0);
  const curve = new AutomationCurve([{ time: 0, value: 0, shape: "hold" }]);
  const gain = new GainNode(context);
  const source = new ConstantSourceNode(context, { offset: 0.1 });
  source.connect(gain).connect(context.destination);
  source.start();
  await context.resume();
  let binding: AutomationBinding | undefined;
  const stop = effect(() => {
    void revision.value;
    binding ??= new AutomationBinding(context, curve, audioParamTarget(gain.gain));
  });
  try {
    binding!.start({ to: 10 });
    revision.value = 1;
    stop();
    curve.value = [{ time: 0, value: 0.75, shape: "hold" }];
    await expect.poll(() => gain.gain.value).toBe(0.75);
    binding!.dispose();
    curve.value = [{ time: 0, value: 0.25, shape: "hold" }];
    expect(gain.gain.value).toBe(0.75);
  } finally {
    stop();
    binding!.dispose();
    await context.close();
  }
});

test("a retained graph follows edits until its own handle is disposed", async () => {
  const context = new AudioContext();
  const revision = cell(0);
  const enabled = cell(true);
  const source = new GainNode(context);
  let graph: GraphHandle | undefined;
  const stop = effect(() => {
    void revision.value;
    graph ??= defineGraph(() => (enabled.value ? [[source, context.destination]] : []), { context });
  });
  try {
    expect(graph!.reaches(source, context.destination)).toBe(true);
    revision.value = 1;
    stop();
    enabled.value = false;
    expect(graph!.reaches(source, context.destination)).toBe(false);
    graph!.dispose();
    const solved = graph!.snapshot().solveId;
    enabled.value = true;
    expect(graph!.snapshot().solveId).toBe(solved);
  } finally {
    stop();
    graph!.dispose();
    await context.close();
  }
});
