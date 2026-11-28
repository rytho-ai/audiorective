import { afterEach, expect, test, vi } from "vitest";
import { WavePlayer, type WaveSourceLoader } from "@audiorective/player";
import { mountWaveformSelector } from "../src";
import { cleanup, element, host, own, bandsFile } from "./helpers";

afterEach(async () => {
  await cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test("shared views render bytes, indeterminate decode and cancellation from the same block", async () => {
  const context = new AudioContext({ sampleRate: 48_000 });
  own(() => context.close());
  let report!: Parameters<WaveSourceLoader>[1]["onProgress"];
  let finish!: (buffer: AudioBuffer) => void;
  const result = new Promise<AudioBuffer>((resolve) => {
    finish = resolve;
  });
  const player = new WavePlayer(context, {
    loadSource: (_source, options) => {
      report = options.onProgress;
      return result;
    },
  });
  own(() => player.dispose());
  const a = host(),
    b = host();
  const first = mountWaveformSelector(a, { player }),
    second = mountWaveformSelector(b, { player });
  own(() => first.dispose());
  own(() => second.dispose());
  const pending = player.load("/shared.wav");
  report({ phase: "download", loadedBytes: 1048576, totalBytes: 2097152 });
  for (const root of [a, b]) {
    const meter = element<HTMLProgressElement>(root, "load-progress");
    expect(meter.hidden).toBe(false);
    expect(meter.position).toBe(0.5);
    expect(element(root, "loading").textContent).toContain("1.00 MiB / 2.00 MiB");
    expect(root.querySelector(".ar-selector")?.getAttribute("aria-busy")).toBe("true");
  }
  report({ phase: "download", loadedBytes: 1048576, totalBytes: null });
  expect(element<HTMLProgressElement>(a, "load-progress").position).toBe(-1);
  report({ phase: "decode" });
  expect(element(a, "loading").textContent).toBe("Decoding audio…");
  expect(element<HTMLProgressElement>(b, "load-progress").hasAttribute("value")).toBe(false);
  element<HTMLButtonElement>(b, "cancel-load").click();
  report({ phase: "download", loadedBytes: 2097152, totalBytes: 2097152 });
  finish(context.createBuffer(1, 800, 8000));
  await pending;
  for (const root of [a, b]) {
    expect(element(root, "loading").hidden).toBe(true);
    expect(element(root, "load-progress").hidden).toBe(true);
    expect(element(root, "cancel-load").hidden).toBe(true);
    expect(root.querySelector(".ar-selector")?.getAttribute("aria-busy")).toBe("false");
  }
  expect(first.getState()).toMatchObject({ duration: 0, error: null, loading: false, loadProgress: null });
  await player.load(context.createBuffer(1, 800, 8000));
  expect(element<HTMLButtonElement>(a, "play-pause").disabled).toBe(false);
  first.cancelLoad();
  expect(player.duration).toBe(0.1);
});

test("owned selector cancellation stops its request and a retry succeeds", async () => {
  const context = new AudioContext({ sampleRate: 48_000 });
  own(() => context.close());
  let signal!: AbortSignal;
  let finish!: (response: Response) => void;
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation((_url: string, options: RequestInit) => {
      signal = options.signal as AbortSignal;
      return new Promise<Response>((resolve) => {
        finish = resolve;
      });
    }),
  );
  const root = host(),
    selector = mountWaveformSelector(root, { createPlayer: () => new WavePlayer(context) });
  own(() => selector.dispose());
  const pending = selector.load("/pending.wav");
  selector.cancelLoad();
  expect(signal.aborted).toBe(true);
  finish(new Response(await bandsFile().arrayBuffer()));
  await pending;
  expect(selector.getState()).toMatchObject({ duration: 0, loading: false, loadProgress: null, error: null });
  await selector.load(bandsFile(1));
  expect(selector.getState().duration).toBeCloseTo(1, 3);
  selector.dispose();
  expect(() => selector.cancelLoad()).toThrow("Waveform selector is disposed.");
});
