import { afterEach, expect, test, vi } from "vitest";
import { WavePlayer, type WavePlayerOptions, type WaveSourceLoader } from "../src/WavePlayer";

const cleanups: Array<() => void | Promise<unknown>> = [];
afterEach(async () => {
  for (const dispose of cleanups.splice(0).reverse()) await dispose();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function fixture(options: WavePlayerOptions = {}) {
  const context = new AudioContext();
  const player = new WavePlayer(context, options);
  cleanups.push(
    () => context.close(),
    () => player.destroy(),
  );
  const states: ReturnType<WavePlayer["getState"]>[] = [];
  player.subscribe(() => states.push(player.getState()));
  return { context, player, states };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function wav() {
  const bytes = new Uint8Array(44 + 1600),
    view = new DataView(bytes.buffer);
  const text = (at: number, value: string) => {
    for (let i = 0; i < value.length; i++) bytes[at + i] = value.charCodeAt(i);
  };
  text(0, "RIFF");
  view.setUint32(4, bytes.length - 8, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 8000, true);
  view.setUint32(28, 16000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, 1600, true);
  for (let i = 0; i < 800; i++) view.setInt16(44 + 2 * i, 12000 * Math.sin(i * 0.2), true);
  return bytes;
}
function response(headers: HeadersInit = {}) {
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      stream = controller;
    },
    cancel,
  });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body, { headers })));
  return { stream, cancel };
}

test("known bytes, delayed decode and peaks have one coherent observable lifecycle", async () => {
  const { context, player, states } = fixture();
  const bytes = wav(),
    { stream } = response({ "Content-Length": String(bytes.length) });
  const decode = deferred<void>(),
    native = context.decodeAudioData.bind(context);
  vi.spyOn(context, "decodeAudioData").mockImplementation(async (data) => {
    await decode.promise;
    return native(data);
  });
  const pending = player.load("/audio.wav");
  stream.enqueue(bytes.slice(0, 100));
  await expect.poll(() => player.getState().loadProgress).toEqual({ phase: "download", loadedBytes: 100, totalBytes: bytes.length });
  const snapshot = player.getState().loadProgress!;
  expect(Object.isFrozen(snapshot)).toBe(true);
  stream.enqueue(bytes.slice(100));
  stream.close();
  await expect.poll(() => player.getState().loadProgress).toEqual({ phase: "decode" });
  expect(player.getState()).toMatchObject({ loading: true, duration: 0, error: null });
  decode.resolve();
  await pending;
  expect(states.some((s) => s.loading && s.loadProgress?.phase === "peaks" && s.duration === 0)).toBe(true);
  expect(player.getState()).toMatchObject({ duration: 0.1, loading: false, loadProgress: null, error: null });
  expect(snapshot).toEqual({ phase: "download", loadedBytes: 100, totalBytes: bytes.length });
});

for (const headers of [{}, { "Content-Length": "1", "Content-Encoding": "gzip" }, { "Content-Length": "not-a-size" }]) {
  test(`unknown/encoded totals stay indeterminate: ${JSON.stringify(headers)}`, async () => {
    const { player } = fixture();
    const { stream } = response(headers);
    const pending = player.load("/audio.wav");
    stream.enqueue(wav().slice(0, 80));
    await expect.poll(() => player.getState().loadProgress).toEqual({ phase: "download", loadedBytes: 80, totalBytes: null });
    stream.enqueue(wav().slice(80));
    stream.close();
    await pending;
    expect(player.getState()).toMatchObject({ loading: false, loadProgress: null, error: null });
  });
}

test("File reports real read bytes; borrowed AudioBuffer reports only peaks", async () => {
  const adapter = vi.fn();
  const { context, player, states } = fixture({ loadSource: adapter });
  const bytes = wav();
  await player.load(new File([bytes], "audio.wav"));
  expect(
    states.some((s) => s.loadProgress?.phase === "read" && s.loadProgress.loadedBytes === bytes.length && s.loadProgress.totalBytes === bytes.length),
  ).toBe(true);
  expect(states.some((s) => s.loadProgress?.phase === "decode")).toBe(true);
  expect(adapter).not.toHaveBeenCalled();
  states.length = 0;
  await player.load(context.createBuffer(1, 800, 8000));
  expect(states.filter((s) => s.loadProgress).map((s) => s.loadProgress?.phase)).toEqual(["peaks"]);
});

for (const size of [10, 2000]) {
  test(`mismatched Content-Length ${size} fails before decoding and can recover`, async () => {
    const { context, player } = fixture();
    const decode = vi.spyOn(context, "decodeAudioData");
    const { stream } = response({ "Content-Length": String(size) });
    const pending = player.load("/truncated.wav");
    stream.enqueue(wav());
    stream.close();
    await expect(pending).rejects.toThrow("Audio download size does not match Content-Length.");
    expect(decode).not.toHaveBeenCalled();
    expect(player.getState()).toMatchObject({ loading: false, loadProgress: null, error: expect.any(String) });
    await player.load(context.createBuffer(1, 800, 8000));
    expect(player.getState()).toMatchObject({ error: null, loadProgress: null, duration: 0.1 });
  });
}

test("text/SPA response fails clearly without decoding", async () => {
  const { context, player } = fixture();
  const decode = vi.spyOn(context, "decodeAudioData");
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({ cancel });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body, { headers: { "Content-Type": "text/html" } })));
  await expect(player.load("/missing.wav")).rejects.toThrow("Audio request returned text instead of audio.");
  expect(decode).not.toHaveBeenCalled();
  expect(cancel).toHaveBeenCalledOnce();
  expect(player.getState()).toMatchObject({ loading: false, loadProgress: null });
});

test("cancel releases the stream, clears progress without an error, and permits retry", async () => {
  const { context, player } = fixture();
  const { stream, cancel } = response();
  const pending = player.load("/slow.wav");
  stream.enqueue(wav().slice(0, 50));
  await expect.poll(() => player.getState().loadProgress).toMatchObject({ loadedBytes: 50 });
  player.cancelLoad();
  await pending;
  expect(cancel).toHaveBeenCalledOnce();
  expect(player.getState()).toMatchObject({ loading: false, loadProgress: null, error: null, duration: 0 });
  await player.load(context.createBuffer(1, 800, 8000));
  const version = player.version;
  player.cancelLoad();
  expect(player.version).toBe(version);
  expect(context.state).not.toBe("closed");
});

for (const action of ["cancel", "replace", "destroy"] as const) {
  test(`late decode after ${action} cannot publish`, async () => {
    const { context, player } = fixture();
    const decoded = deferred<AudioBuffer>();
    vi.spyOn(context, "decodeAudioData").mockReturnValue(decoded.promise);
    const pending = player.load(new File([wav()], "slow.wav"));
    await expect.poll(() => player.getState().loadProgress?.phase).toBe("decode");
    if (action === "replace") await player.load(context.createBuffer(1, 1600, 8000));
    else if (action === "cancel") player.cancelLoad();
    else player.destroy();
    decoded.resolve(context.createBuffer(1, 800, 8000));
    await pending;
    expect(player.getState()).toMatchObject({ duration: action === "replace" ? 0.2 : 0, loading: false, loadProgress: null, error: null });
  });
}

test("a shared cache adapter keeps peer loads alive and stale progress is ignored", async () => {
  const cached = deferred<AudioBuffer>();
  const requests: Parameters<WaveSourceLoader>[1][] = [];
  const loader: WaveSourceLoader = (_source, options) => {
    requests.push(options);
    return cached.promise;
  };
  const a = fixture({ loadSource: loader }),
    b = fixture({ loadSource: loader });
  const old = a.player.load("/same.wav"),
    peer = b.player.load("/same.wav");
  requests[0].onProgress({ phase: "download", loadedBytes: 5, totalBytes: null });
  expect(a.player.getState().loading).toBe(true);
  a.player.cancelLoad();
  expect(requests[0].signal.aborted).toBe(true);
  expect(requests[1].signal.aborted).toBe(false);
  await a.player.load(a.context.createBuffer(1, 1600, 8000));
  requests[0].onProgress({ phase: "decode" });
  expect(a.player.getState()).toMatchObject({ loadProgress: null, duration: 0.2 });
  requests[1].onProgress({ phase: "decode" });
  cached.resolve(b.context.createBuffer(1, 800, 8000));
  await Promise.all([old, peer]);
  expect(a.player.duration).toBe(0.2);
  expect(b.player.duration).toBe(0.1);
  requests[1].onProgress({ phase: "decode" });
  expect(b.player.getState().loadProgress).toBeNull();
  expect(requests[0].context).toBe(a.context);
});

test("invalid adapter progress rejects, while cancelled invalid callbacks are ignored", async () => {
  let report!: Parameters<WaveSourceLoader>[1]["onProgress"];
  const { context, player } = fixture({
    loadSource: async (_source, options) => {
      report = options.onProgress;
      report({ phase: "download", loadedBytes: -1, totalBytes: null });
      return context.createBuffer(1, 800, 8000);
    },
  });
  await expect(player.load("/bad.wav")).rejects.toThrow(/Load progress needs/);
  expect(player.getState()).toMatchObject({ loading: false, loadProgress: null });
  await player.load(context.createBuffer(1, 800, 8000));
  expect(() => report({ phase: "download", loadedBytes: -1, totalBytes: null })).not.toThrow();
});

test("cancel in the peaks notification prevents publication", async () => {
  const { context, player } = fixture();
  player.subscribe(() => {
    if (player.getState().loadProgress?.phase === "peaks") player.cancelLoad();
  });
  await player.load(context.createBuffer(1, 800, 8000));
  expect(player.getState()).toMatchObject({ duration: 0, loading: false, loadProgress: null, error: null });
  player.destroy();
  expect(() => player.cancelLoad()).toThrow("WavePlayer is destroyed.");
});
