import { afterEach, expect, test, vi } from "vitest";
import { effect } from "@audiorective/core";
import { AudioRecorder, MicrophoneInput } from "../src/AudioRecorder";

const disposers: Array<() => void | Promise<unknown>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const dispose of disposers.splice(0).reverse()) await dispose();
});

function setup() {
  const context = new AudioContext();
  disposers.push(() => context.close());
  const device = context.createMediaStreamDestination();
  const [track] = device.stream.getAudioTracks();
  const stop = vi.spyOn(track, "stop");
  const request = vi.spyOn(navigator.mediaDevices, "getUserMedia").mockResolvedValue(device.stream);
  return { context, device, track, stop, request };
}

test("open asks for permission when called, with the audio constraints, and resolves with a live input", async () => {
  const { context, request } = setup();
  expect(request).not.toHaveBeenCalled();
  const mic = await MicrophoneInput.open(context, { audio: { echoCancellation: false } });
  disposers.push(() => mic.dispose());
  expect(request).toHaveBeenCalledWith({ audio: { echoCancellation: false } });
  expect(mic.cells.state.value).toBe("live");
  expect(mic.stream.getAudioTracks()).toHaveLength(1);
  expect(mic.output).toBeInstanceOf(MediaStreamAudioSourceNode);
});

test.each(["NotAllowedError", "NotFoundError", "NotReadableError", "OverconstrainedError", "SecurityError"])(
  "open rejects with getUserMedia's own %s and opens nothing",
  async (name) => {
    const { context, request } = setup();
    const denied = new DOMException("denied", name);
    request.mockRejectedValue(denied);
    await expect(MicrophoneInput.open(context)).rejects.toBe(denied);
    await expect(MicrophoneInput.open(context)).rejects.toMatchObject({ name });
  },
);

test("open rejects NotSupportedError without mediaDevices", async () => {
  const { context } = setup();
  vi.spyOn(navigator, "mediaDevices", "get").mockReturnValue(undefined as never);
  await expect(MicrophoneInput.open(context)).rejects.toMatchObject({ name: "NotSupportedError" });
});

test("dispose and Symbol.dispose stop every track and end the input; twice is safe", async () => {
  const { context, stop } = setup();
  const mic = await MicrophoneInput.open(context);
  mic[Symbol.dispose]();
  expect(stop).toHaveBeenCalledTimes(1);
  expect(mic.cells.state.value).toBe("ended");
  expect(() => mic.dispose()).not.toThrow();
  expect(() => mic.connect(context.destination)).toThrow("MicrophoneInput is disposed.");
});

test("a track that ends on its own (device unplugged) sets state ended", async () => {
  const { context, track } = setup();
  const mic = await MicrophoneInput.open(context);
  disposers.push(() => mic.dispose());
  const states: string[] = [];
  const stop = effect(() => void states.push(mic.cells.state.value));
  track.stop();
  track.dispatchEvent(new Event("ended"));
  stop();
  expect(states).toEqual(["live", "ended"]);
});

test("an aborted signal rejects open with the signal's reason, and a stream that arrives late is stopped", async () => {
  const { context, request } = setup();
  const early = new AbortController();
  early.abort();
  await expect(MicrophoneInput.open(context, { signal: early.signal })).rejects.toMatchObject({ name: "AbortError" });
  expect(request).not.toHaveBeenCalled();

  const lateStream = context.createMediaStreamDestination().stream;
  const lateStop = vi.spyOn(lateStream.getAudioTracks()[0], "stop");
  const late = new AbortController();
  request.mockImplementation(async () => {
    late.abort();
    return lateStream;
  });
  await expect(MicrophoneInput.open(context, { signal: late.signal })).rejects.toMatchObject({ name: "AbortError" });
  expect(lateStop).toHaveBeenCalledTimes(1);
});

test("aborting the signal after open disposes the input and stops the tracks", async () => {
  const { context, stop } = setup();
  const controller = new AbortController();
  const mic = await MicrophoneInput.open(context, { signal: controller.signal });
  controller.abort();
  expect(stop).toHaveBeenCalledTimes(1);
  expect(mic.cells.state.value).toBe("ended");
});

test("monitoring is a writable cell, and mic.connect(recorder) captures the microphone", async () => {
  const { context, device } = setup();
  const mic = await MicrophoneInput.open(context);
  const recorder = new AudioRecorder(context, { channels: 1 });
  disposers.push(
    () => recorder.dispose(),
    () => mic.dispose(),
  );
  expect(mic.cells.monitoring.value).toBe(false);
  mic.connect(recorder);
  const tone = new ConstantSourceNode(context, { offset: 0.5 });
  tone.connect(device);
  tone.start();
  await context.resume();
  await recorder.ready;
  mic.cells.monitoring.value = true;
  const take = await recorder.record({ length: 0.2 });
  expect(take.channels[0].some((sample) => Math.abs(sample) > 0.1)).toBe(true);
  mic.cells.monitoring.value = false;
});
