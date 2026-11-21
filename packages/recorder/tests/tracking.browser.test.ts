import { afterEach, describe, expect, test, vi } from "vitest";
import { effect } from "@audiorective/core";
import { AudioRecorder } from "../src/AudioRecorder";
import * as audioRecorderSourceModule from "../src/AudioRecorder.ts?raw";
import { coverageGaps, watch } from "../../../scripts/tracking-coverage.mjs";

const touched = {
  audioRecorder: new Set<string>(),
};

const disposers: Array<() => void | Promise<unknown>> = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0).reverse()) await dispose();
});

describe("AudioRecorder readers are tracked", () => {
  test("cells.state follows start and cancel", async () => {
    const context = new OfflineAudioContext(1, 48_000, 48_000);
    const recorder = watch(new AudioRecorder(context, { channels: 1 }), touched.audioRecorder);
    disposers.push(() => recorder.dispose());
    const states: string[] = [];
    const stop = effect(() => void states.push(recorder.cells.state.value));
    const started = recorder.record({ when: 0.1 });
    started.catch(() => undefined);
    await new Promise((done) => setTimeout(done, 20));
    recorder.cancel();
    await started.catch(() => undefined);
    stop();
    expect(states[0]).toBe("idle");
    expect(states).toContain("armed");
    expect(states[states.length - 1]).toBe("idle");
  });
});

describe("commands called inside an effect do not subscribe it", () => {
  test("AudioRecorder commands and the clock-facing hooks", async () => {
    const context = new OfflineAudioContext(1, 48_000, 48_000);
    const recorder = watch(new AudioRecorder(context, { channels: 1 }), touched.audioRecorder);
    disposers.push(() => recorder.dispose());
    let runs = 0;
    const stop = effect(() => {
      runs++;
      recorder.schedule();
      recorder.reset("pause");
      recorder.attached({ timeline: context as never, state: { value: "stopped" }, meter: { value: [4, 4] }, detach() {} })();
      expect(() => recorder.stop()).toThrow("AudioRecorder has no started take to stop.");
      void recorder.record({ when: 0.1 }).catch(() => undefined);
      recorder.cancel();
    });
    await new Promise((done) => setTimeout(done, 20));
    stop();
    expect(runs).toBe(1);
  });
});

describe("AudioRecorder commands drive tracked state", () => {
  const take = async (stream: boolean) => {
    const sampleRate = 48_000;
    const context = new OfflineAudioContext(1, sampleRate / 2, sampleRate);
    const recorder = watch(new AudioRecorder(context, { channels: 1 }), touched.audioRecorder);
    disposers.push(() => recorder.dispose());
    const states: string[] = [];
    let runs = 0;
    const stopEffect = effect(() => {
      runs++;
      states.push(recorder.cells.state.value);
    });
    await recorder.ready;
    if (stream) {
      const recording = recorder.record({ when: 0.1, onChunk() {} });
      const pending = recorder.stop({ result: "span", when: 0.3 });
      await context.startRendering();
      await Promise.all([recording, pending]);
    } else {
      const pending = recorder.record({ when: 0.1 });
      await vi.waitFor(() => expect(recorder.cells.startsAt.value).toBe(0.1));
      const stopped = recorder.stop({ when: 0.3 });
      await context.startRendering();
      await Promise.all([pending, stopped]);
    }
    stopEffect();
    return { states, runs };
  };
  test.each([
    ["record", false],
    ["streaming record and span stop", true],
  ])("cells.state follows %s", async (_name, stream) => {
    const { states, runs } = await take(stream);
    expect(states[0]).toBe("idle");
    expect(states.some((state) => state !== "idle")).toBe(true);
    expect(states[states.length - 1]).toBe("idle");
    expect(runs).toBe(states.length);
  });
});

describe("every public member of a tracked block is covered", () => {
  test.each([
    [
      "AudioRecorder",
      AudioRecorder,
      audioRecorderSourceModule.default,
      touched.audioRecorder,
      {
        input: "constant gain node the caller wires; not state",
        output: "always undefined; the recorder is a sink",
      },
    ],
  ] as const)("%s", (_name, ctor, source, seen, excluded) => {
    expect(coverageGaps(ctor, source, seen, excluded)).toEqual([]);
  });
});
