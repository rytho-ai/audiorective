import { afterEach, expect, expectTypeOf, test, vi } from "vitest";
import { effect, type Readable } from "@audiorective/core";
import type { PCMData } from "@audiorective/core/peaks";
import { MidiSequence, WavePlayer } from "../src";
import type { MidiSequenceState, PlaybackVersion, WaveLoadProgress, WaveSourceLoader, WaveStretchProcessor } from "../src";
import type { MidiNote } from "../src/midi";

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
type Job = { input: PCMData; ratio: number; resolve(pcm: PCMData): void; reject(reason: Error): void };
function fixture(extra: { loadSource?: WaveSourceLoader } = {}) {
  const jobs: Job[] = [];
  const stretch: WaveStretchProcessor = {
    process: (input, options) =>
      new Promise<PCMData>((resolve, reject) => {
        jobs.push({ input, ratio: options.ratio, resolve, reject });
      }),
  };
  const context = new AudioContext();
  const player = new WavePlayer(context, { stretch, ...extra });
  disposers.push(
    () => context.close(),
    () => player.destroy(),
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
  expect(error.at(-1)).toBe("stretch failed");
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

  // Failure: processing and error arrive together.
  const failing = player.setStretch(4);
  jobs[1].reject(new Error("boom"));
  await expect(failing).rejects.toThrow("boom");
  expect(snapshots.at(-1)).toMatchObject({ processing: false, error: "boom" });

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
      player.sourceToOutput(1);
      player.outputToSource(1);
    }),
  );
  expect(runs).toBe(1);
  player.setLooping(false);
  player.setSelection(null);
  jobs[0].resolve(rendered(jobs[0]));
  await new Promise((done) => setTimeout(done, 20));
  await player.load(audio(context, 16000));
  expect(runs).toBe(1);

  const m = midi();
  let midiRuns = 0;
  disposers.push(
    effect(() => {
      midiRuns++;
      m.setSelection({ start: 0, end: 1 });
      m.updateNote("a", { end: 1.5 });
      m.setData({ duration: 4, notes: [note("a", 0, 1)] });
    }),
  );
  m.setSelection(null);
  m.updateNote("a", { end: 2 });
  expect(midiRuns).toBe(1);
});

test("public readers are tracked: an effect over getState/getSelection/isLooping re-runs for every state change", async () => {
  const gate = deferred<AudioBuffer>();
  const { context, player } = fixture({ loadSource: (url) => (url === "bad" ? Promise.reject(new Error("nope")) : gate.promise) });
  const states: ReturnType<WavePlayer["getState"]>[] = [];
  const selections: unknown[] = [];
  const loops: boolean[] = [];
  disposers.push(
    effect(() => {
      states.push(player.getState());
    }),
    effect(() => {
      selections.push(player.getSelection());
    }),
    effect(() => {
      loops.push(player.isLooping);
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

  const m = midi();
  const seen: MidiSequenceState[] = [];
  const picked: unknown[] = [];
  const queried: number[] = [];
  disposers.push(
    effect(() => {
      seen.push(m.getState());
    }),
    effect(() => {
      picked.push(m.getSelection());
    }),
    effect(() => {
      queried.push(m.query({ start: 0, end: 4 }).length);
    }),
  );
  m.setSelection({ start: 0, end: 1 });
  expect(seen.at(-1)?.selection).toEqual({ start: 0, end: 1 });
  expect(picked.at(-1)).toEqual({ start: 0, end: 1 });
  m.setData({ duration: 4, notes: [note("z", 0, 1)] });
  expect(queried.at(-1)).toBe(1);
});

test("a listener that reads state is notified exactly once per operation", async () => {
  const { context, player } = fixture();
  await player.load(audio(context));
  const listener = vi.fn(() => {
    player.getState();
    player.getSelection();
  });
  disposers.push(player.subscribe(listener));
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

  const m = midi();
  const midiListener = vi.fn(() => {
    m.getState();
  });
  disposers.push(m.subscribe(midiListener));
  m.setSelection({ start: 0, end: 1 });
  m.updateNote("a", { end: 1.5 });
  expect(midiListener).toHaveBeenCalledTimes(2);
});

test("read-only cells are Readable, cannot be written, and getState/subscribe still follow them", async () => {
  const { context, player } = fixture();
  const r = player.cells;
  expectTypeOf(r.selection).toExtend<Readable<{ start: number; end: number } | null>>();
  expectTypeOf(r.isLooping).toExtend<Readable<boolean>>();
  expectTypeOf(r.version).toExtend<Readable<PlaybackVersion | null>>();
  expectTypeOf(r.isPlaying).toExtend<Readable<boolean>>();
  // @ts-expect-error read-only: no setter on `.value`
  expect(() => (r.isLooping.value = true)).toThrow(TypeError);
  // @ts-expect-error read-only: `$` takes no argument
  r.isLooping.$(true);
  (r.selection.$ as (v: unknown) => void)({ start: 0, end: 1 });
  expect(r.isLooping.value).toBe(false);
  expect(r.selection.value).toBeNull();
  expect(Object.isFrozen(r)).toBe(true);

  const listener = vi.fn();
  disposers.push(player.subscribe(listener));
  expect(listener).not.toHaveBeenCalled();
  await player.load(audio(context));
  expect(listener).toHaveBeenCalled();
  listener.mockClear();
  player.setLooping(true);
  expect(listener).toHaveBeenCalledTimes(1);
  expect(player.getState().isLooping).toBe(r.isLooping.value);
  player.setSelection({ start: 0, end: 1 });
  expect(player.getState().selection).toEqual(r.selection.value);
  expect(player.getSelection()).not.toBe(r.selection.value);
});

const note = (id: string, start: number, end: number): MidiNote => ({ id, start, end, pitch: 60, velocity: 90, channel: 0, track: 0 });
function midi() {
  const m = new MidiSequence({ duration: 4, notes: [note("a", 0, 1), note("b", 1, 2)] });
  disposers.push(() => m.destroy());
  return m;
}

test("every MidiSequence cell re-runs an effect through the owner's methods, without subscribe", () => {
  const m = midi();
  const r = m.cells;
  const notes = watch(r.notes);
  const duration = watch(r.duration);
  const selection = watch(r.selection);
  const revision = watch(r.revision);
  const state = watch(r.state);

  m.setSelection({ start: 1, end: 2 });
  expect(selection.at(-1)).toEqual({ start: 1, end: 2 });
  expect(notes).toHaveLength(1); // a selection change leaves the notes slice quiet
  expect(duration).toHaveLength(1);

  m.updateNote("a", { end: 5 });
  expect(duration.at(-1)).toBe(5);
  expect(notes).toHaveLength(2);
  expect(notes.at(-1)?.[0].end).toBe(5);

  m.setData({ duration: 3, notes: [note("c", 0, 3)] });
  expect(notes.at(-1)?.map((n) => n.id)).toEqual(["c"]);
  expect(selection.at(-1)).toBeNull();
  expect(revision.at(-1)).toBe(m.getState().revision);
  expect(state.at(-1)).toBe(m.getState());
});

test("MidiSequence commits are atomic and subscribe keeps its semantics", () => {
  const m = midi();
  const runs: Array<{ state: MidiSequenceState; notes: readonly MidiNote[]; selection: unknown; revision: number; duration: number }> = [];
  disposers.push(
    effect(() => {
      runs.push({
        state: m.cells.state.value,
        notes: m.cells.notes.value,
        selection: m.cells.selection.value,
        revision: m.cells.revision.value,
        duration: m.cells.duration.value,
      });
    }),
  );
  m.setSelection({ start: 0, end: 1 });
  runs.length = 0;
  const listener = vi.fn();
  const bad = vi.fn(() => {
    throw new Error("listener");
  });
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  disposers.push(m.subscribe(bad), m.subscribe(listener));
  expect(listener).not.toHaveBeenCalled();

  m.setData({ duration: 2, notes: [note("z", 0, 2)] });
  expect(runs).toHaveLength(1);
  expect(runs[0]).toMatchObject({ selection: null, duration: 2, revision: m.getState().revision });
  expect(runs[0].notes.map((n) => n.id)).toEqual(["z"]);
  expect(runs[0].state).toBe(m.getState());
  expect(listener).toHaveBeenCalledTimes(1);
  expect(log).toHaveBeenCalled();

  expect(() => m.setSelection({ start: 0, end: 99 })).toThrow(RangeError);
  expect(runs).toHaveLength(1);

  expectTypeOf(m.cells.notes).toExtend<Readable<readonly MidiNote[]>>();
  // @ts-expect-error read-only: no setter on `.value`
  expect(() => (m.cells.notes.value = [])).toThrow(TypeError);
  // @ts-expect-error read-only: `$` takes no argument
  m.cells.selection.$({ start: 0, end: 1 });
  expect(m.cells.selection.value).toBeNull();
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
    else disposers.push(player.subscribe(react));

    const older = player.setStretch(2);
    expect(newer).toBeDefined();
    // The newer request finishes first; anything the older request still has in flight settles late.
    const latest = jobs.findLast((job) => job.ratio === 3)!;
    latest.resolve(rendered(latest));
    await newer;
    expect(player.version?.ratio).toBe(3);
    for (const job of jobs) if (job !== latest) job.resolve(rendered(job));
    await older;
    await new Promise((done) => setTimeout(done, 20));
    expect(player.version?.ratio).toBe(3);
    expect(player.getState()).toMatchObject({ stretchRatio: 3, processing: false, error: null });
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
  expect(player.getState()).toMatchObject({ loading: false, error: null });
});
