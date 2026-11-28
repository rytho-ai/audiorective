import { expect, test } from "vitest";
import { AUDIO_RECORDER_WORKLET } from "../src/recording/audio-recorder.worklet";

type Message = {
  type: string;
  frame?: number;
  startFrame?: number;
  endFrame?: number;
  channels?: Float32Array[];
  dropouts?: { startFrame: number; endFrame: number }[];
};

/** Runs the real worklet source against a scripted `currentFrame` sequence, feeding each quantum a distinct ramp. */
function capture(frames: readonly number[]) {
  const messages: Message[] = [];
  const clock = { value: 0 };
  let Processor!: new (options: unknown) => {
    process(inputs: Float32Array[][], outputs: Float32Array[][], parameters: { capture: Float32Array }): boolean;
  };
  class AudioWorkletProcessor {
    port = { onmessage: null, postMessage: (message: Message) => messages.push(message) };
  }
  new Function(
    "AudioWorkletProcessor",
    "registerProcessor",
    "sampleRate",
    "clock",
    AUDIO_RECORDER_WORKLET.replace(/\bcurrentFrame\b/g, "clock.value"),
  )(AudioWorkletProcessor, (_name: string, processor: typeof Processor) => (Processor = processor), 48_000, clock);
  const node = new Processor({ processorOptions: { channels: 1, startFrame: 0, length: null } });
  const outputs = [[new Float32Array(128)]];
  let sample = 0;
  for (const frame of frames) {
    clock.value = frame;
    const input = Float32Array.from({ length: 128 }, () => ++sample);
    node.process([[input]], outputs, { capture: new Float32Array([1]) });
  }
  // Closing the gate one quantum later flushes the take.
  clock.value = Math.max(...frames) + 128;
  node.process([[new Float32Array(128)]], outputs, { capture: new Float32Array([0]) });
  const pcm = messages.filter((m) => m.type === "chunk").flatMap((m) => [...m.channels![0]]);
  return { pcm, done: messages.find((m) => m.type === "done")!, sent: frames.length * 128 };
}

test("a repeated currentFrame that catches up keeps every sample in order with no dropout", () => {
  const { pcm, done, sent } = capture([0, 128, 128, 384, 512]);
  expect(done.dropouts).toEqual([]);
  expect(done.startFrame).toBe(0);
  expect(done.endFrame).toBe(sent);
  expect(pcm).toEqual(Array.from({ length: sent }, (_, index) => index + 1));
});

test("several repeats in one take are all preserved", () => {
  const { pcm, done, sent } = capture([0, 0, 256, 384, 384, 640, 768, 768, 1024]);
  expect(done.dropouts).toEqual([]);
  expect(pcm).toEqual(Array.from({ length: sent }, (_, index) => index + 1));
});

test("a real forward skip is still reported and filled with silence", () => {
  const { pcm, done } = capture([0, 128, 512]);
  expect(done.dropouts).toEqual([{ startFrame: 256, endFrame: 512 }]);
  expect(done.endFrame).toBe(640);
  expect(pcm.slice(0, 256)).toEqual(Array.from({ length: 256 }, (_, index) => index + 1));
  expect(pcm.slice(256, 512).every((value) => value === 0)).toBe(true);
  expect(pcm[512]).toBe(257);
});

test("a skip that follows a repeat reports only the frames actually missing", () => {
  const { done, pcm } = capture([0, 128, 128, 640]);
  expect(done.dropouts).toEqual([{ startFrame: 384, endFrame: 640 }]);
  expect(pcm.slice(0, 384)).toEqual(Array.from({ length: 384 }, (_, index) => index + 1));
});
