import { expect, test } from "vitest";
import { effect } from "@audiorective/core";
import { Convolver } from "../src";

const invalidImpulse = "data:audio/wav;base64,AAAA";

test("failed loading and retry publish coherent status and error together", async () => {
  const context = new AudioContext();
  const convolver = new Convolver(context);
  const seen: Array<{ status: string; failed: boolean }> = [];
  const stop = effect(() => void seen.push({ status: convolver.cells.status.value, failed: convolver.cells.error.value !== null }));
  try {
    await expect(convolver.load(invalidImpulse)).rejects.toBeTruthy();
    expect(seen).toEqual([
      { status: "loading", failed: false },
      { status: "error", failed: true },
    ]);
    seen.length = 0;
    const retry = convolver.load(invalidImpulse);
    expect(seen).toEqual([{ status: "loading", failed: false }]);
    await expect(retry).rejects.toBeTruthy();
    expect(seen).toEqual([
      { status: "loading", failed: false },
      { status: "error", failed: true },
    ]);
  } finally {
    stop();
    convolver.dispose();
    await context.close();
  }
});

test("replacing or clearing an impulse publishes its buffer and readiness atomically", async () => {
  const context = new AudioContext();
  const convolver = new Convolver(context);
  await expect(convolver.load(invalidImpulse)).rejects.toBeTruthy();
  const seen: unknown[][] = [];
  const stop = effect(() => void seen.push([convolver.cells.status.value, convolver.cells.error.value !== null, convolver.cells.buffer.value]));
  const impulse = context.createBuffer(1, 16, context.sampleRate);
  seen.length = 0;
  try {
    convolver.buffer = impulse;
    expect(seen).toEqual([["ready", false, impulse]]);
    seen.length = 0;
    convolver.buffer = null;
    expect(seen).toEqual([["loading", false, null]]);
  } finally {
    stop();
    convolver.dispose();
    await context.close();
  }
});
