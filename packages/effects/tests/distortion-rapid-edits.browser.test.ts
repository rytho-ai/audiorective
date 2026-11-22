import { expect, test } from "vitest";
import { Distortion } from "../src";

const rate = 44100;
async function render(
  writes: readonly (readonly [number, number])[],
  initial = 0.05,
  disposeAt?: number,
  afterWrite?: (quantum: number, context: OfflineAudioContext) => void,
  sampleRate = rate,
) {
  const context = new OfflineAudioContext(1, sampleRate / 2, sampleRate);
  const distortion = new Distortion(context, { distortion: initial });
  const source = new ConstantSourceNode(context, { offset: 0.4 });
  source.connect(distortion.input);
  distortion.output.connect(context.destination);
  source.start();
  const grouped = new Map<number, number[]>();
  for (const [quantum, value] of writes) grouped.set(quantum, [...(grouped.get(quantum) ?? []), value]);
  for (const [quantum, values] of grouped) {
    void context.suspend((quantum * 128) / sampleRate).then(() => {
      for (const value of values) distortion.params.distortion.value = value;
      afterWrite?.(quantum, context);
      return context.resume();
    });
  }
  if (disposeAt !== undefined) {
    void context.suspend((disposeAt * 128) / sampleRate).then(() => {
      distortion.dispose();
      return context.resume();
    });
  }
  try {
    return (await context.startRendering()).getChannelData(0);
  } finally {
    distortion.dispose();
  }
}

test.each([
  {
    name: "two synchronous writes",
    writes: [
      [80, 0.5],
      [80, 1],
    ] as const,
  },
  {
    name: "a drive drag every render quantum",
    writes: [
      [80, 0.1],
      [81, 0.3],
      [82, 0.5],
      [83, 0.7],
      [84, 1],
    ] as const,
  },
  ...[3, 4, 6, 12].map((interval) => ({
    name: `a drive drag every ${interval} render quanta`,
    writes: Array.from({ length: 6 }, (_, i): [number, number] => [80 + i * interval, 0.05 + ((i + 1) * 0.95) / 6]),
  })),
  {
    name: "a caller suspend at a queued handover",
    writes: [
      [80, 0.1],
      [81, 0.3],
      [82, 0.5],
      [83, 0.7],
      [84, 1],
      [87, 1],
    ] as const,
  },
])("$name stays continuous and reaches the latest drive", async ({ writes }) => {
  const output = await render(writes);
  const reference = await render([], 1);
  let largestStep = 0;
  for (let i = 80 * 128; i < output.length; i++) largestStep = Math.max(largestStep, Math.abs(output[i] - output[i - 1]));
  const change = output.at(-1)! - output[80 * 128 - 1];
  expect(change).toBeGreaterThan(0.2);
  expect(largestStep).toBeLessThan(change / 20);
  expect(output.at(-1)).toBeCloseTo(reference.at(-1)!, 5);
});

test("disposing during overlapping handovers leaves the offline render under caller control", async () => {
  const output = await render(
    [
      [80, 0.1],
      [81, 0.3],
      [82, 0.5],
      [83, 0.7],
      [84, 1],
    ],
    0.05,
    85,
  );
  expect(output).toHaveLength(rate / 2);
  expect(output.at(-1)).toBe(0);
});

test.each([8000, 24000, 48000, 96000])("native handovers stay continuous at %s Hz", async (sampleRate) => {
  const start = Math.ceil((sampleRate * 0.1) / 128);
  const writes = [0.1, 0.3, 0.5, 0.7, 1].map((value, i): [number, number] => [start + i, value]);
  const output = await render(writes, 0.05, undefined, undefined, sampleRate);
  const reference = await render([], 1, undefined, undefined, sampleRate);
  let largestStep = 0;
  let smallestStep = 0;
  for (let i = start * 128; i < output.length; i++) {
    const delta = output[i] - output[i - 1];
    largestStep = Math.max(largestStep, Math.abs(delta));
    smallestStep = Math.min(smallestStep, delta);
  }
  const change = output.at(-1)! - output[start * 128 - 1];
  expect(change).toBeGreaterThan(0.2);
  expect(largestStep).toBeLessThan(change / 20);
  expect(smallestStep).toBeGreaterThan(-1e-6);
  expect(output.at(-1)).toBeCloseTo(reference.at(-1)!, 5);
});

test("caller suspend reservations made after a drive edit retain their pause and resume ownership", async () => {
  let pause: Promise<void> | undefined;
  let failure: unknown;
  let heldByCaller = false;
  const output = await render(
    [
      [80, 0.1],
      [81, 0.3],
      [82, 0.5],
      [83, 0.7],
      [84, 1],
    ],
    0.05,
    undefined,
    (quantum, context) => {
      if (quantum !== 84) return;
      pause = context.suspend((87 * 128) / rate).then(
        async () => {
          const time = context.currentTime;
          await new Promise((resolve) => setTimeout(resolve, 10));
          heldByCaller = context.state === "suspended" && context.currentTime === time;
          await context.resume();
        },
        (error: unknown) => {
          failure = error;
        },
      );
    },
  );
  await pause;
  expect(failure).toBeUndefined();
  expect(heldByCaller).toBe(true);
  expect(output).toHaveLength(rate / 2);
});
