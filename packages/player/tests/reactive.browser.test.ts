import { afterEach, expect, expectTypeOf, test, vi } from "vitest";
import { view, onChange } from "./view";
import { effect, type Readable } from "@audiorective/core";
import type { PCMData } from "@audiorective/core/peaks";
import { WavePlayer } from "../src/WavePlayer";
import type { PlaybackVersion, WaveLoadProgress, WaveSourceLoader, WaveStretchProcessor } from "../src/WavePlayer";

const disposers: Array<() => void | Promise<unknown>> = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0).reverse()) await dispose();
  vi.restoreAllMocks();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
const toPcm = (buffer: AudioBuffer): PCMData => ({
  sampleRate: buffer.sampleRate,
  channels: Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c)),
});
const toBuffer = (pcm: PCMData): AudioBuffer => {
  const buffer = new AudioBuffer({ length: pcm.channels[0]!.length, numberOfChannels: pcm.channels.length, sampleRate: pcm.sampleRate });
  pcm.channels.forEach((channel, c) => buffer.copyToChannel(channel as Float32Array<ArrayBuffer>, c));
  return buffer;
};
type Job = { input: PCMData; ratio: number; resolve(pcm: PCMData): void; reject(reason: Error): void };
function fixture(extra: { loadSource?: WaveSourceLoader } = {}) {
  const jobs: Job[] = [];
  const stretch: WaveStretchProcessor = {
    process: (input, options) =>
      new Promise<AudioBuffer>((resolve, reject) => {
        jobs.push({ input: toPcm(input), ratio: options.ratio, resolve: (pcm) => resolve(toBuffer(pcm)), reject });
      }),
  };
  const context = new AudioContext();
  const player = new WavePlayer(context, { stretch, ...extra });
  disposers.push(
    () => context.close(),
    () => player.dispose(),
  );
  return { context, player, jobs };
}
function audio(context: AudioContext, frames = 32000): AudioBuffer {
  const buffer = context.createBuffer(1, frames, 16000);
  buffer.getChannelData(0).fill(0.25);
  return buffer;
}
function rendered(job: Job): PCMData {
  return {
    channels: job.input.channels.map(() => new Float32Array(Math.round(job.input.channels[0].length * job.ratio)).fill(0.5)),
    sampleRate: job.input.sampleRate,
  };
}
/** Counts how often an effect reading `source` re-runs, without `subscribe`. */
function watch<T>(source: Readable<T>) {
  const seen: T[] = [];
  const stop = effect(() => {
    seen.push(source.value);
  });
  disposers.push(stop);
  return seen;
}

test("every WavePlayer cell re-runs an effect through the owner's methods, without subscribe", async () => {
  const gate = deferred<AudioBuffer>();
  let report!: (progress: Exclude<WaveLoadProgress, { phase: "peaks" }>) => void;
  const { context, player, jobs } = fixture({
    loadSource: (url, options) => {
      report = options.onProgress;
      return url === "bad" ? Promise.reject(new Error("nope")) : gate.promise;
    },
  });
  const r = player.cells;
  const loading = watch(r.loading);
  const progress = watch(r.loadProgress);
  const error = watch(r.error);
  const version = watch(r.version);
  const selection = watch(r.selection);
  const looping = watch(r.isLooping);
  const playing = watch(r.isPlaying);
  const processing = watch(r.processing);

  const load = player.load("ok");
  expect(loading).toEqual([false, true]);
  report({ phase: "download", loadedBytes: 2, totalBytes: 10 });
  expect(progress.at(-1)).toEqual({ phase: "download", loadedBytes: 2, totalBytes: 10 });
  gate.resolve(audio(context));
  await load;
  expect(loading).toEqual([false, true, false]);
  expect(progress.at(-1)).toBeNull();
  expect(version.at(-1)?.revision).toBe(1);

  player.setSelection({ start: 0.5, end: 1 });
  expect(selection.at(-1)).toEqual({ start: 0.5, end: 1 });
  expect(Object.isFrozen(selection.at(-1))).toBe(true);
  player.setLooping(true);
  expect(looping.at(-1)).toBe(true);

  await player.play();
  expect(playing.at(-1)).toBe(true);
  player.pause();
  expect(playing.at(-1)).toBe(false);

  const stretch = player.setStretch(2);
  expect(processing.at(-1)).toBe(true);
  jobs[0].resolve(rendered(jobs[0]));
  await stretch;
  expect(processing.at(-1)).toBe(false);
  expect(version.at(-1)?.ratio).toBe(2);

  const failing = player.setStretch(3);
  jobs[1].reject(new Error("stretch failed"));
  await expect(failing).rejects.toThrow("stretch failed");
  expect(error.at(-1)).toBeNull(); // a stretch failure rejects its promise; `cells.error` is for load failures
  expect(processing.at(-1)).toBe(false);

  await expect(player.load("bad")).rejects.toThrow("nope");
  expect(error.at(-1)).toBe("nope");
  expect(version.at(-1)).toBeNull();
  expect(looping.at(-1)).toBe(false);
  expect(selection.at(-1)).toBeNull();
});

test("load and stretch commit coherent states: an effect never sees an intermediate combination", async () => {
  const { context, player, jobs } = fixture();
  const snapshots: Array<{
    loading: boolean;
    processing: boolean;
    error: string | null;
    version: PlaybackVersion | null;
    selection: { start: number; end: number } | null;
    looping: boolean;
    progress: WaveLoadProgress | null;
  }> = [];
  disposers.push(
    effect(() => {
      const r = player.cells;
      snapshots.push({
        loading: r.loading.value,
        processing: r.processing.value,
        error: r.error.value,
        version: r.version.value,
        selection: r.selection.value,
        looping: r.isLooping.value,
        progress: r.loadProgress.value,
      });
    }),
  );
  await player.load(audio(context));
  snapshots.length = 0;

  player.setSelection({ start: 1, end: 1.5 });
  player.setLooping(true);
  snapshots.length = 0;

  // Replacing the source: one run for the reset, one for the peaks phase, one for the commit.
  await player.load(audio(context, 16000));
  expect(snapshots).toHaveLength(3);
  expect(snapshots[0]).toMatchObject({ loading: true, version: null, selection: null, looping: false, error: null, progress: null });
  expect(snapshots[1]).toMatchObject({ loading: true, version: null, progress: { phase: "peaks" } });
  expect(snapshots[2]).toMatchObject({ loading: false, selection: null, looping: false, error: null, progress: null });
  expect(snapshots[2].version?.revision).toBe(2);

  player.setSelection({ start: 0.25, end: 0.5 });
  snapshots.length = 0;
  const before = snapshots.length;
  const stretch = player.setStretch(2);
  expect(snapshots).toHaveLength(before + 1);
  expect(snapshots[0]).toMatchObject({ processing: true, error: null });
  expect(snapshots[0].version?.ratio).toBe(1);
  jobs[0].resolve(rendered(jobs[0]));
  await stretch;
  // Commit: new version, scaled selection and processing=false arrive together.
  expect(snapshots).toHaveLength(2);
  expect(snapshots[1]).toMatchObject({ processing: false, selection: { start: 0.5, end: 1 } });
  expect(snapshots[1].version?.ratio).toBe(2);

  // Failure: processing clears and the promise rejects.
  const failing = player.setStretch(4);
  jobs[1].reject(new Error("boom"));
  await expect(failing).rejects.toThrow("boom");
  expect(snapshots.at(-1)).toMatchObject({ processing: false, error: null });

  // Superseding a stretch never exposes processing=false in between.
  snapshots.length = 0;
  const first = player.setStretch(2);
  const second = player.setStretch(3);
  expect(snapshots.every((s) => s.processing)).toBe(true);
  jobs[2].resolve(rendered(jobs[2]));
  jobs[3].resolve(rendered(jobs[3]));
  await Promise.all([first, second]);
});

test("owner methods called inside an effect do not subscribe it", async () => {
  const { context, player, jobs } = fixture();
  await player.load(audio(context));
  let runs = 0;
  disposers.push(
    effect(() => {
      runs++;
      player.setSelection({ start: 0, end: 1 });
      player.setLooping(true);
      player.seek(0.5);
      void player.play();
      player.pause();
      player.stop();
      void player.audition();
      void player.setStretch(2);
      player.cancelLoad();
    }),
  );
  expect(runs).toBe(1);
  player.setLooping(false);
  player.setSelection(null);
  jobs[0].resolve(rendered(jobs[0]));
  await new Promise((done) => setTimeout(done, 20));
  await player.load(audio(context, 16000));
  expect(runs).toBe(1);
});

test("public readers are tracked: an effect over getState/getSelection/isLooping re-runs for every state change", async () => {
  const gate = deferred<AudioBuffer>();
  const { context, player } = fixture({ loadSource: (url) => (url === "bad" ? Promise.reject(new Error("nope")) : gate.promise) });
  const states: ReturnType<typeof view>[] = [];
  const selections: unknown[] = [];
  const loops: boolean[] = [];
  disposers.push(
    effect(() => {
      states.push(view(player));
    }),
    effect(() => {
      selections.push(player.cells.selection.value);
    }),
    effect(() => {
      loops.push(player.cells.isLooping.value);
    }),
  );
  const load = player.load("ok");
  expect(states.at(-1)).toMatchObject({ loading: true });
  gate.resolve(audio(context));
  await load;
  expect(states.at(-1)).toMatchObject({ loading: false, duration: 2, revision: 1 });
  player.setSelection({ start: 0.5, end: 1 });
  expect(states.at(-1)?.selection).toEqual({ start: 0.5, end: 1 });
  expect(selections.at(-1)).toEqual({ start: 0.5, end: 1 });
  player.setLooping(true);
  expect(states.at(-1)?.isLooping).toBe(true);
  expect(loops).toEqual([false, true]);
  await expect(player.load("bad")).rejects.toThrow("nope");
  expect(states.at(-1)).toMatchObject({ error: "nope", selection: null, isLooping: false });
});

test("a listener that reads state is notified exactly once per operation", async () => {
  const { context, player } = fixture();
  await player.load(audio(context));
  const listener = vi.fn(() => {
    view(player);
    player.cells.selection.value;
  });
  disposers.push(onChange(player, listener));
  // Transport changes notify from the player's own effect; listeners must not subscribe it to the state they read.
  await player.play();
  player.pause();
  listener.mockClear();
  player.setSelection({ start: 0, end: 1 });
  expect(listener).toHaveBeenCalledTimes(1);
  player.setLooping(true);
  expect(listener).toHaveBeenCalledTimes(2);
  player.seek(0.25);
  expect(listener).toHaveBeenCalledTimes(3);
  player.setSelection(null);
  expect(listener).toHaveBeenCalledTimes(4);
});

test("read-only cells are Readable and cannot be written", async () => {
  const { player } = fixture();
  const r = player.cells;
  expectTypeOf(r.selection).toExtend<Readable<{ start: number; end: number } | null>>();
  expectTypeOf(r.isLooping).toExtend<Readable<boolean>>();
  expectTypeOf(r.version).toExtend<Readable<PlaybackVersion | null>>();
  expectTypeOf(r.isPlaying).toExtend<Readable<boolean>>();
  expectTypeOf(r.playhead).toExtend<Readable<{ position: number; startedAt: number | null }>>();
  // @ts-expect-error read-only: no setter on `.value`
  expect(() => (r.isLooping.value = true)).toThrow(TypeError);
  // @ts-expect-error read-only: `$` takes no argument
  r.isLooping.$(true);
  (r.selection.$ as (v: unknown) => void)({ start: 0, end: 1 });
  expect(r.isLooping.value).toBe(false);
  expect(r.selection.value).toBeNull();
  expect(Object.isFrozen(r)).toBe(true);
});

test("cells.playhead changes on every play, pause, seek, stop and load, and carries the position and start time", async () => {
  const { context, player } = fixture();
  const seen: Array<{ position: number; startedAt: number | null }> = [];
  disposers.push(effect(() => void seen.push(player.cells.playhead.value)));
  expect(seen[0]).toEqual({ position: 0, startedAt: null });
  await player.load(audio(context));
  player.seek(0.25);
  expect(player.cells.playhead.value).toEqual({ position: 0.25, startedAt: null });
  await player.play();
  const playing = player.cells.playhead.value;
  expect(playing.position).toBe(0.25);
  expect(playing.startedAt).toBeGreaterThanOrEqual(0);
  const before = seen.length;
  player.pause();
  expect(seen.length).toBeGreaterThan(before);
  expect(player.cells.playhead.value.startedAt).toBeNull();
  expect(player.cells.playhead.value.position).toBeGreaterThanOrEqual(0.25);
  player.stop();
  expect(player.cells.playhead.value).toEqual({ position: 0, startedAt: null });
});

test.each(["effect", "subscribe"] as const)(
  "a stretch started re-entrantly from an observer (%s) is not overwritten by the older request",
  async (kind) => {
    const { context, player, jobs } = fixture();
    await player.load(audio(context));
    let newer: Promise<void> | undefined;
    let started = false;
    const react = () => {
      // Guard before the call: a listener is notified again by the re-entrant call itself.
      if (!player.cells.processing.value || started) return;
      started = true;
      newer = player.setStretch(3);
    };
    if (kind === "effect") disposers.push(effect(react));
    else disposers.push(onChange(player, react));

    const older = player.setStretch(2);
    expect(newer).toBeDefined();
    // The newer request finishes first; anything the older request still has in flight settles late.
    const latest = jobs.findLast((job) => job.ratio === 3)!;
    latest.resolve(rendered(latest));
    await newer;
    expect(player.cells.version.value?.ratio).toBe(3);
    for (const job of jobs) if (job !== latest) job.resolve(rendered(job));
    await older;
    await new Promise((done) => setTimeout(done, 20));
    expect(player.cells.version.value?.ratio).toBe(3);
    expect(view(player)).toMatchObject({ stretchRatio: 3, processing: false, error: null });
    expect(player.duration).toBeCloseTo(6, 5);
  },
);

test("a load started re-entrantly from an observer is not overwritten by the older load", async () => {
  const gates: Array<{ url: string; gate: ReturnType<typeof deferred<AudioBuffer>> }> = [];
  const { context, player } = fixture({
    loadSource: (url) => {
      const gate = deferred<AudioBuffer>();
      gates.push({ url: String(url), gate });
      return gate.promise;
    },
  });
  let newer: Promise<void> | undefined;
  let started = false;
  disposers.push(
    effect(() => {
      if (!player.cells.loading.value || started) return;
      started = true;
      newer = player.load("newer");
    }),
  );
  const older = player.load("older");
  expect(newer).toBeDefined();
  gates.find((g) => g.url === "newer")!.gate.resolve(audio(context, 16000));
  await newer;
  expect(player.duration).toBeCloseTo(1, 5);
  for (const g of gates) if (g.url === "older") g.gate.resolve(audio(context, 48000));
  await older;
  await new Promise((done) => setTimeout(done, 20));
  expect(player.duration).toBeCloseTo(1, 5);
  expect(view(player)).toMatchObject({ loading: false, error: null });
});

test.each(["effect", "subscribe"] as const)(
  "a pause and a newer play({ when }) issued re-entrantly from an observer (%s) supersede the older scheduled start",
  async (kind) => {
    const { context, player } = fixture();
    await context.resume();
    await player.load(audio(context));
    const first = context.currentTime + 0.5,
      second = context.currentTime + 5;
    let newer: Promise<number | null> | undefined;
    const react = () => {
      if (player.cells.isPlaying.value && !newer) {
        player.pause();
        newer = player.play({ when: second });
      }
    };
    if (kind === "effect") disposers.push(effect(react));
    else disposers.push(onChange(player, react));

    // The older request started nothing that survives, so it must not report a start time.
    expect(await player.play({ when: first })).toBeNull();
    expect(newer).toBeDefined();
    expect(await newer).toBe(second);
    expect(view(player)).toMatchObject({ isPlaying: true, position: 0 });
    await new Promise((done) => setTimeout(done, 700));
    // Past the superseded `first`: still queued for `second`, so the playhead has not moved.
    expect(context.currentTime).toBeGreaterThan(first);
    expect(player.position).toBe(0);

    // A pause alone from an observer leaves the player stopped and the request unanswered.
    player.pause();
    newer = undefined;
    let paused = false;
    const cancel = () => {
      if (player.cells.isPlaying.value && !paused) {
        paused = true;
        player.pause();
      }
    };
    if (kind === "effect") disposers.push(effect(cancel));
    else disposers.push(onChange(player, cancel));
    newer = Promise.resolve(null); // disarm the first observer
    expect(await player.play({ when: context.currentTime + 0.2 })).toBeNull();
    expect(paused).toBe(true);
    expect(view(player).isPlaying).toBe(false);
  },
);
