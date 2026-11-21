import { afterEach, describe, expect, test } from "vitest";
import { Sampler, effect } from "../src";
import * as samplerSourceModule from "../src/Sampler.ts?raw";
import { coverageGaps, watch } from "../../../scripts/tracking-coverage.mjs";

const touched = { sampler: new Set<string>() };
const disposers: Array<() => void | Promise<unknown>> = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0).reverse()) await dispose();
});

/** Reads the value inside an effect, changes it through the owner's public method, and checks the effect re-ran with a new value. */
function expectTracked(read: () => unknown, mutate: () => void) {
  const seen: unknown[] = [];
  const stop = effect(() => void seen.push(read()));
  const first = seen[0];
  try {
    mutate();
  } finally {
    stop();
  }
  expect(seen.length).toBeGreaterThan(1);
  expect(Object.is(seen[seen.length - 1], first)).toBe(false);
}

function fixture() {
  const context = new AudioContext();
  const buffer = context.createBuffer(1, 16000, 16000);
  const sampler = watch(new Sampler(context, { sound: buffer }), touched.sampler);
  disposers.push(
    () => context.close(),
    () => sampler.dispose(),
  );
  return { context, buffer, sampler };
}

describe("Sampler readers are tracked", () => {
  test("cells.activeVoices follows trigger, noteOn, noteOff and stopAll", () => {
    const { sampler } = fixture();
    expectTracked(
      () => sampler.cells.activeVoices.value,
      () => void sampler.trigger(),
    );
    expectTracked(
      () => sampler.cells.activeVoices.value,
      () => void sampler.noteOn("C4"),
    );
    expectTracked(
      () => sampler.cells.activeVoices.value,
      () => sampler.noteOff("C4"),
    );
    expectTracked(
      () => sampler.cells.activeVoices.value,
      () => sampler.stopAll(),
    );
  });

  test("cells.heldNotes follows noteOn and noteOff", () => {
    const { sampler } = fixture();
    expectTracked(
      () => sampler.cells.heldNotes.value,
      () => void sampler.noteOn("C4"),
    );
    expectTracked(
      () => sampler.cells.heldNotes.value,
      () => sampler.noteOff("C4"),
    );
  });

  test("params.release and params.sustain follow assignment", () => {
    const { sampler } = fixture();
    expectTracked(
      () => sampler.params.release.value,
      () => {
        sampler.params.release.value = 0.5;
      },
    );
    expectTracked(
      () => sampler.params.sustain.value,
      () => {
        sampler.params.sustain.value = true;
      },
    );
  });

  test("sound follows assignment", () => {
    const { context, sampler } = fixture();
    expectTracked(
      () => sampler.sound,
      () => {
        sampler.sound = context.createBuffer(1, 8000, 16000);
      },
    );
  });

  test("a voice's playing cell follows stop", () => {
    const { sampler } = fixture();
    const voice = sampler.trigger()!;
    expectTracked(
      () => voice.playing.value,
      () => voice.stop(),
    );
  });
});

describe("command methods called inside an effect do not subscribe it", () => {
  test("Sampler commands", () => {
    const { sampler } = fixture();
    let runs = 0;
    const stop = effect(() => {
      runs++;
      sampler.trigger();
      sampler.noteOn(64);
      sampler.noteOff(64);
      sampler.stopAll();
    });
    sampler.trigger();
    sampler.stopAll();
    stop();
    expect(runs).toBe(1);
  });
});

describe("every public member of a tracked block is covered", () => {
  test("Sampler", () => {
    expect(coverageGaps(Sampler, samplerSourceModule.default, touched.sampler, { output: "constant gain node the caller wires; not state" })).toEqual(
      [],
    );
  });
});
