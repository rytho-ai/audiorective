import { afterEach, expect, test, vi } from "vitest";
import { WavePlayer } from "../src/WavePlayer";

const disposers: Array<() => void | Promise<unknown>> = [];
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
function fixture() {
  const context = new AudioContext();
  const player = new WavePlayer(context);
  disposers.push(
    () => context.close(),
    () => player.dispose(),
  );
  return { context, player };
}
function bands(context: AudioContext, seconds = 6) {
  const buffer = context.createBuffer(1, context.sampleRate * seconds, context.sampleRate);
  const channel = buffer.getChannelData(0);
  for (let i = 0; i < channel.length; i++) {
    const t = i / context.sampleRate;
    channel[i] = 0.25 * Math.sin(2 * Math.PI * (t < 2 ? 220 : t < 4 ? 440 : 880) * t);
  }
  return buffer;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function peak(analyser: AnalyserNode) {
  const data = new Float32Array(analyser.fftSize);
  analyser.getFloatTimeDomainData(data);
  return data.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
}
function frequency(analyser: AnalyserNode, context: AudioContext) {
  const bins = new Float32Array(analyser.frequencyBinCount);
  analyser.getFloatFrequencyData(bins);
  let max = 0;
  for (let i = 1; i < bins.length; i++) if (bins[i] > bins[max]) max = i;
  return (max * context.sampleRate) / analyser.fftSize;
}
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const dispose of disposers.splice(0).reverse()) await dispose();
});

test("decoded source and selection work without constructing DOM; copies and invalid edits are atomic", async () => {
  const { context, player } = fixture();
  const buffer = bands(context);
  const dom = vi.spyOn(document, "createElement");
  await player.load(buffer);
  expect(dom).not.toHaveBeenCalled();
  expect(player.buffer).toBe(buffer);
  const range = { start: 1, end: 2 };
  player.setSelection(range);
  range.start = 4;
  player.getState().selection!.start = 5;
  expect(player.getSelection()).toEqual({ start: 1, end: 2 });
  for (const invalid of [
    { start: -1, end: 2 },
    { start: 2, end: 1 },
    { start: 0, end: 9 },
    { start: NaN, end: 2 },
  ]) {
    expect(() => player.setSelection(invalid)).toThrow(/Selection must/);
    expect(player.getSelection()).toEqual({ start: 1, end: 2 });
  }
  expect(() => player.seek(NaN)).toThrow(/finite/);
  expect(player.getState().isPlaying).toBe(false);
  player.seek(99);
  expect(player.position).toBe(6);
  player.stop();
  expect(player.position).toBe(1);
  player.setSelection(null);
  expect(player.getSelection()).toBeNull();
});

test("URL failure rejects with observable error, then File decode recovers", async () => {
  const { context, player } = fixture();
  const buffer = bands(context);
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 404 })));
  await expect(player.load("/missing.wav")).rejects.toThrow(/404/);
  expect(player.getState()).toMatchObject({ duration: 0, loading: false, error: expect.stringContaining("404") });
  const decode = vi.spyOn(context, "decodeAudioData").mockResolvedValue(buffer);
  await player.load(new File([new Uint8Array([1])], "source.wav"));
  expect(decode).toHaveBeenCalledOnce();
  expect(player.getState()).toMatchObject({ duration: 6, loading: false, error: null });
  await expect(player.load("  ")).rejects.toThrow("Enter an audio URL.");
});

test("a slow fetch cannot replace a later decoded source, and its signal is aborted", async () => {
  const { context, player } = fixture();
  const slow = deferred<Response>();
  let signal!: AbortSignal;
  vi.stubGlobal(
    "fetch",
    vi.fn((_url, options) => {
      signal = options.signal;
      return slow.promise;
    }),
  );
  const old = player.load("/slow.wav");
  const replacement = bands(context, 1);
  await player.load(replacement);
  slow.resolve(new Response(new Uint8Array([1])));
  await old;
  expect(signal.aborted).toBe(true);
  expect(player.buffer).toBe(replacement);
});

test("stale decode and destruction cannot resurrect a source", async () => {
  const { context, player } = fixture();
  const decode = deferred<AudioBuffer>();
  const spy = vi.spyOn(context, "decodeAudioData").mockReturnValue(decode.promise);
  const old = player.load(new File(["x"], "old.wav"));
  await expect.poll(() => spy.mock.calls.length).toBe(1);
  const current = bands(context, 1);
  await player.load(current);
  decode.resolve(bands(context));
  await old;
  expect(player.buffer).toBe(current);
  const late = deferred<AudioBuffer>();
  spy.mockReturnValue(late.promise);
  const pending = player.load(new File(["x"], "late.wav"));
  await expect.poll(() => spy.mock.calls.length).toBe(2);
  player.dispose();
  late.resolve(current);
  await pending;
  expect(player.buffer).toBeNull();
  expect(player.getState().isPlaying).toBe(false);
  expect(context.state).not.toBe("closed");
  await expect(player.load(current)).rejects.toThrow(/disposed/);
  expect(() => player.seek(0)).toThrow(/disposed/);
  player.dispose();
});

for (const command of ["pause", "stop", "seek", "load", "dispose"] as const) {
  test(`pending resume cannot start after ${command}`, async () => {
    const { context, player } = fixture();
    const buffer = bands(context);
    await player.load(buffer);
    const resume = deferred<void>();
    vi.spyOn(context, "resume").mockReturnValue(resume.promise);
    const pending = player.play();
    if (command === "seek") player.seek(2);
    else if (command === "load") await player.load(buffer);
    else player[command]();
    resume.resolve();
    await pending;
    expect(player.getState().isPlaying).toBe(false);
  });
}

test("notifications are coherent, unsubscribe works and shared ownership survives observer removal", async () => {
  const { context, player } = fixture();
  const states: ReturnType<WavePlayer["getState"]>[] = [];
  const off = player.subscribe(() => states.push(player.getState()));
  await player.load(bands(context));
  player.setSelection({ start: 1, end: 2 });
  expect(states.at(-1)).toMatchObject({ duration: 6, selection: { start: 1, end: 2 }, loading: false });
  off();
  const count = states.length;
  player.setSelection({ start: 2, end: 3 });
  expect(states).toHaveLength(count);
  expect(player.getSelection()).toEqual({ start: 2, end: 3 });
  player.setSelection(null);
  player.setLooping(true);
  player.setSelection(null);
  expect(player.isLooping).toBe(false);
});

test("audition, live disjoint range and obsolete one-shot stop agree with actual sound", async () => {
  const { context, player } = fixture();
  await player.load(bands(context));
  const analyser = context.createAnalyser();
  analyser.fftSize = 4096;
  analyser.smoothingTimeConstant = 0;
  player.output.connect(analyser);
  analyser.connect(context.destination);
  disposers.push(() => analyser.disconnect());
  player.setSelection({ start: 3.3, end: 3.9 });
  await player.play();
  await expect.poll(() => peak(analyser)).toBeGreaterThan(0.1);
  expect(frequency(analyser, context)).toBeGreaterThan(420);
  expect(frequency(analyser, context)).toBeLessThan(460);
  player.setLooping(true);
  player.setSelection({ start: 4.5, end: 4.8 });
  await delay(160);
  expect(frequency(analyser, context)).toBeGreaterThan(860);
  await delay(750);
  expect(player.isPlaying).toBe(true);
  expect(player.position).toBeGreaterThanOrEqual(4.5);
  expect(player.position).toBeLessThan(4.8);
  player.pause();
  const paused = player.position;
  await delay(160);
  expect(player.position).toBeCloseTo(paused, 4);
  expect(peak(analyser)).toBeLessThan(0.001);
  await player.audition();
  await expect.poll(() => peak(analyser)).toBeGreaterThan(0.1);
  player.params.volume.value = 0;
  await expect.poll(() => peak(analyser)).toBeLessThan(0.001);
  player.params.volume.value = 1;
  player.stop();
  player.setLooping(false);
  player.setSelection({ start: 2.2, end: 2.4 });
  await player.play();
  await expect.poll(() => player.isPlaying).toBe(false);
  expect(player.position).toBeCloseTo(2.4, 2);
  await expect.poll(() => peak(analyser)).toBeLessThan(0.001);
});

test("dispose silences owned audio but leaves caller context and peer running", async () => {
  const { context, player } = fixture();
  await player.load(bands(context));
  player.setSelection({ start: 1, end: 1.2 });
  const analyser = context.createAnalyser();
  player.output.connect(analyser);
  analyser.connect(context.destination);
  const peer = context.createOscillator();
  const peerAnalyser = context.createAnalyser();
  peer.connect(peerAnalyser);
  peerAnalyser.connect(context.destination);
  peer.start();
  disposers.push(() => {
    peer.stop();
    peer.disconnect();
    peerAnalyser.disconnect();
    analyser.disconnect();
  });
  await player.audition();
  await expect.poll(() => peak(analyser)).toBeGreaterThan(0.1);
  player.dispose();
  player.dispose();
  await delay(160);
  expect(peak(analyser)).toBeLessThan(0.001);
  expect(peak(peerAnalyser)).toBeGreaterThan(0.1);
  expect(context.state).toBe("running");
});

test("dispose does not notify subscribers after the player is disposed", async () => {
  const { context, player } = fixture();
  await player.load(bands(context, 1));
  await player.play();
  const seen: unknown[] = [];
  player.subscribe(() => seen.push(1));
  player.dispose();
  expect(seen).toEqual([]);
});
