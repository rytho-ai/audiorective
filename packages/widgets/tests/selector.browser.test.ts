import { afterEach, describe, expect, test, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { mountWaveformSelector, type WaveformSelectorOptions } from "../src";
import { bandsFile, cleanup, delay, drag, element, host, own, pointer } from "./helpers";

function fixture(options: Omit<WaveformSelectorOptions, "context"> = {}) {
  const context = new AudioContext();
  own(() => context.close());
  const root = host();
  const handle = mountWaveformSelector(root, { context, ...options });
  own(() => handle.destroy());
  const click = (id: string) => element<HTMLButtonElement>(root, id).click();
  return { root, context, handle, click };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function peak(analyser: AnalyserNode): number {
  const samples = new Float32Array(analyser.fftSize);
  analyser.getFloatTimeDomainData(samples);
  return samples.reduce((max, value) => Math.max(max, Math.abs(value)), 0);
}

function frequency(analyser: AnalyserNode, context: AudioContext): number {
  const bins = new Float32Array(analyser.frequencyBinCount);
  analyser.getFloatFrequencyData(bins);
  let max = 0;
  for (let i = 1; i < bins.length; i++) if (bins[i] > bins[max]) max = i;
  return (max * context.sampleRate) / analyser.fftSize;
}

async function audioFixture() {
  const result = fixture({ source: bandsFile() });
  await result.handle.ready;
  const analyser = result.context.createAnalyser();
  analyser.fftSize = 4096;
  analyser.smoothingTimeConstant = 0;
  result.handle.output.connect(analyser);
  analyser.connect(result.context.destination);
  own(() => analyser.disconnect());
  return { ...result, analyser };
}

afterEach(async () => {
  await cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("complete waveform selector source lifecycle", () => {
  test("mounts without a source, then decodes a File and renders the complete selector", async () => {
    const { root, handle } = fixture();
    await handle.ready;
    expect(handle.output).toBeInstanceOf(AudioNode);
    expect(handle.getState()).toMatchObject({ duration: 0, selection: null, position: 0, loading: false, error: null, isPlaying: false });
    expect(element<HTMLButtonElement>(root, "play-pause").disabled).toBe(true);
    await handle.load(bandsFile());
    expect(handle.getState().duration).toBeCloseTo(6, 3);
    expect(element(root, "wave-path").getAttribute("d")!.length).toBeGreaterThan(100);
    expect(element(root, "ruler").childElementCount).toBeGreaterThan(1);
    expect(element<HTMLButtonElement>(root, "play-pause").disabled).toBe(false);
  });

  test("URL errors are exposed through ready, state and UI, and a subsequent URL load recovers", async () => {
    const bytes = await bandsFile().arrayBuffer();
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response(bytes));
    vi.stubGlobal("fetch", fetch);
    const { root, handle } = fixture({ source: "/missing.wav" });
    await expect(handle.ready).rejects.toThrow(/404/);
    expect(handle.getState()).toMatchObject({ duration: 0, loading: false, isPlaying: false });
    expect(handle.getState().error).toMatch(/404/);
    expect(element(root, "error").hidden).toBe(false);
    await handle.load("/recovered.wav");
    expect(fetch).toHaveBeenLastCalledWith("/recovered.wav", expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(handle.getState()).toMatchObject({ loading: false, error: null });
    expect(handle.getState().duration).toBeCloseTo(6, 3);
    expect(element(root, "error").hidden).toBe(true);
  });

  test("file input replacement resets playback, range, loop, playhead and zoom", async () => {
    const { root, handle, click } = await audioFixture();
    handle.setSelection({ start: 2, end: 3 });
    click("loop");
    click("play-pause");
    await expect.poll(() => handle.getState().isPlaying).toBe(true);
    click("zoom-in");
    click("zoom-in");
    const transfer = new DataTransfer();
    transfer.items.add(bandsFile(1));
    const fileInput = element<HTMLInputElement>(root, "source-file");
    fileInput.files = transfer.files;
    fileInput.dispatchEvent(new Event("change", { bubbles: true }));
    expect(handle.getState()).toMatchObject({ loading: true, selection: null, position: 0, isPlaying: false, isLooping: false });
    await expect.poll(() => handle.getState().loading).toBe(false);
    expect(handle.getState().duration).toBeCloseTo(1, 3);
    expect(handle.getState()).toMatchObject({ selection: null, position: 0, isPlaying: false, isLooping: false, error: null });
    expect(fileInput.value).toBe("");
    expect(element<HTMLElement>(root, "viewport").scrollLeft).toBe(0);
    expect(element(root, "selection").hidden).toBe(true);
  });

  test("latest request wins even when an aborted fetch completes after the new source", async () => {
    const slow = deferred<Response>();
    let signal!: AbortSignal;
    vi.stubGlobal(
      "fetch",
      vi.fn((_url, options) => {
        signal = options.signal;
        return slow.promise; // Deliberately ignore abort to exercise the request-generation guard.
      }),
    );
    const { root, handle } = fixture();
    const oldLoad = handle.load("/slow.wav");
    expect(handle.getState().loading).toBe(true);
    expect(element(root, "loading").hidden).toBe(false);
    await handle.load(bandsFile(1));
    expect(signal.aborted).toBe(true);
    slow.resolve(new Response(await bandsFile().arrayBuffer()));
    await oldLoad;
    expect(handle.getState().duration).toBeCloseTo(1, 3);
    expect(handle.getState()).toMatchObject({ loading: false, error: null });
  });

  test("a stale decode cannot overwrite newer data or resurrect a destroyed selector", async () => {
    const { root, context, handle } = fixture();
    const decode = deferred<AudioBuffer>();
    const spy = vi.spyOn(context, "decodeAudioData").mockImplementationOnce(() => decode.promise);
    const oldLoad = handle.load(bandsFile());
    await expect.poll(() => spy.mock.calls.length).toBe(1);
    await handle.load(bandsFile(1));
    decode.resolve(context.createBuffer(1, context.sampleRate * 6, context.sampleRate));
    await oldLoad;
    expect(handle.getState().duration).toBeCloseTo(1, 3);

    const late = deferred<AudioBuffer>();
    spy.mockImplementationOnce(() => late.promise);
    const pending = handle.load(bandsFile());
    await expect.poll(() => spy.mock.calls.length).toBe(3);
    handle.destroy();
    late.resolve(context.createBuffer(1, context.sampleRate * 6, context.sampleRate));
    await pending;
    expect(root.childElementCount).toBe(0);
    expect(context.state).not.toBe("closed");
    await expect(handle.load(bandsFile())).rejects.toThrow(/destroyed/);
  });

  test("programmatic and keyboard edits stay stopped, while pointer creation and resizing audition", async () => {
    const onSelectionChange = vi.fn();
    const { root, handle, click } = fixture({ source: bandsFile(), onSelectionChange });
    await handle.ready;
    const range = { start: 1, end: 2 };
    handle.setSelection(range);
    range.start = 5;
    const state = handle.getState();
    state.selection!.start = 5;
    expect(handle.getState().selection).toEqual({ start: 1, end: 2 });
    expect(handle.getState().isPlaying).toBe(false);
    expect(onSelectionChange).toHaveBeenLastCalledWith({ start: 1, end: 2 });
    element(root, "selection-end").focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(handle.getState().selection!.end).toBeCloseTo(2.01, 3);
    expect(handle.getState().isPlaying).toBe(false);
    await drag(element(root, "waveform"), 6, 3, 2.5);
    await expect.poll(() => handle.getState().isPlaying).toBe(true);
    expect(handle.getState().isLooping).toBe(true);
    click("stop");
    const grip = element(root, "selection-end");
    const rect = grip.getBoundingClientRect();
    // Start from the actual interactive grip, ending at a new source boundary.
    const surface = element(root, "waveform").getBoundingClientRect();
    await pointer({ action: "down", x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });
    await pointer({ action: "move", x: surface.x + (3.5 / 6) * surface.width, y: rect.y + rect.height / 2 });
    await pointer({ action: "up" });
    await expect.poll(() => handle.getState().isPlaying).toBe(true);
    expect(handle.getState().selection!.end).toBeCloseTo(3.5, 1);
    expect(handle.getState().isLooping).toBe(true);
    click("clear");
    expect(handle.getState().selection).toBeNull();
    expect(handle.getState().isLooping).toBe(false);
    click("stop");
    await drag(element(root, "waveform"), 6, 5, 5);
    await expect.poll(() => handle.getState().isPlaying).toBe(true);
    expect(handle.getState().position).toBeGreaterThanOrEqual(4.9);
    expect(handle.getState().position).toBeLessThan(5.6);
  });
});

describe("selector audible output", () => {
  test("selected-band native loop, pause/resume and bounded one-shot agree with actual output", async () => {
    const { handle, click, context, analyser } = await audioFixture();
    handle.setSelection({ start: 3.5, end: 3.8 });
    click("loop");
    click("play-pause");
    await expect.poll(() => peak(analyser)).toBeGreaterThan(0.1);
    await delay(750); // More than two wraps of this 300ms range.
    const looped = handle.getState();
    expect(looped.isPlaying).toBe(true);
    expect(looped.position).toBeGreaterThanOrEqual(3.5);
    expect(looped.position).toBeLessThan(3.8);
    expect(frequency(analyser, context)).toBeGreaterThan(420);
    expect(frequency(analyser, context)).toBeLessThan(460);

    click("play-pause");
    const paused = handle.getState().position;
    await delay(160);
    expect(handle.getState().isPlaying).toBe(false);
    expect(handle.getState().position).toBeCloseTo(paused, 3);
    expect(peak(analyser)).toBeLessThan(0.001);
    click("play-pause");
    await expect.poll(() => handle.getState().isPlaying).toBe(true);
    const resumed = handle.getState().position;
    const elapsed = (resumed - paused + 0.3) % 0.3;
    expect(elapsed).toBeLessThan(0.15);
    await expect.poll(() => peak(analyser)).toBeGreaterThan(0.1);

    click("stop");
    handle.setSelection({ start: 2.2, end: 2.45 });
    click("loop");
    click("play-pause");
    await expect.poll(() => handle.getState().isPlaying).toBe(true);
    await expect.poll(() => handle.getState().isPlaying).toBe(false);
    expect(handle.getState().position).toBeCloseTo(2.45, 2);
    await expect.poll(() => peak(analyser)).toBeLessThan(0.001);
  });

  test("live range changes immediately change the audible band and cancel an old scheduled stop", async () => {
    const { handle, click, context, analyser } = await audioFixture();
    handle.setSelection({ start: 3.3, end: 3.9 });
    click("play-pause"); // This session schedules a non-looping stop.
    await expect.poll(() => peak(analyser)).toBeGreaterThan(0.1);
    expect(frequency(analyser, context)).toBeGreaterThan(420);
    expect(frequency(analyser, context)).toBeLessThan(460);
    click("loop");
    const beforeChange = context.currentTime;
    handle.setSelection({ start: 4.5, end: 4.8 });
    const changedPosition = handle.getState().position;
    const elapsed = context.currentTime - beforeChange;
    // A disjoint range must restart now. Remapping the old position into the new
    // range can look correct on screen while the old audible band keeps playing.
    expect(changedPosition).toBeGreaterThanOrEqual(4.5);
    expect(changedPosition).toBeLessThanOrEqual(4.5 + elapsed + 1 / context.sampleRate);
    await delay(160); // Enough for the FFT window, shorter than the old source reaching the new range.
    expect(frequency(analyser, context)).toBeGreaterThan(860);
    expect(frequency(analyser, context)).toBeLessThan(900);
    await delay(750); // Beyond the obsolete one-shot stop, and two new loop wraps.
    expect(handle.getState()).toMatchObject({ isPlaying: true, isLooping: true });
    expect(handle.getState().position).toBeGreaterThanOrEqual(4.5);
    expect(handle.getState().position).toBeLessThan(4.8);
    expect(frequency(analyser, context)).toBeGreaterThan(860);
  });

  test("destroy silences its own output while caller context and an independently routed peer survive", async () => {
    const { root, handle, click, context, analyser } = await audioFixture();
    const peer = context.createOscillator();
    const gain = context.createGain();
    const peerAnalyser = context.createAnalyser();
    gain.gain.value = 0.1;
    peer.connect(gain);
    gain.connect(peerAnalyser);
    peerAnalyser.connect(context.destination);
    peer.start();
    own(() => {
      peer.stop();
      peer.disconnect();
      gain.disconnect();
      peerAnalyser.disconnect();
    });
    click("play-pause");
    await expect.poll(() => peak(analyser)).toBeGreaterThan(0.1);
    handle.destroy();
    handle.destroy();
    await expect.poll(() => peak(analyser)).toBeLessThan(0.001);
    expect(peak(peerAnalyser)).toBeGreaterThan(0.05);
    expect(context.state).toBe("running");
    expect(root.childElementCount).toBe(0);
  });
});
