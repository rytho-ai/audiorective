import { afterEach, expect, test, vi } from "vitest";
import { AudioRecorder } from "../src/AudioRecorder";

const cleanup: Array<() => void | Promise<unknown>> = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function offline(seconds = 1) {
  const context = new OfflineAudioContext(1, 48_000 * seconds, 48_000);
  const recorder = new AudioRecorder(context, { channels: 1 });
  cleanup.push(() => recorder.dispose());
  const source = new ConstantSourceNode(context, { offset: 0.25 });
  source.connect(recorder.input);
  source.start();
  return { context, recorder };
}

test("a slow writer is serialized and the completion waits for every accepted chunk", async () => {
  const { context, recorder } = offline();
  const gate = deferred();
  cleanup.push(gate.resolve);
  let active = 0,
    maximum = 0,
    settled = false;
  const starts: number[] = [];
  const pending = recorder.record({
    when: 0.1,
    length: 0.3,
    async onChunk(chunk) {
      starts.push(chunk.startFrame);
      active++;
      maximum = Math.max(maximum, active);
      await gate.promise;
      expect(chunk.channels[0][0]).toBeCloseTo(0.25, 6);
      active--;
    },
  });
  void pending.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await vi.waitFor(() => expect(recorder.cells.startsAt.value).toBe(0.1));
  await context.startRendering();
  await vi.waitFor(() => expect(starts.length).toBeGreaterThan(0));
  expect(settled).toBe(false);
  expect(maximum).toBe(1);
  expect(starts).toEqual([4800]);
  expect(recorder.stop({ result: "span" })).toBe(pending);
  expect(recorder.stop({ result: "span" })).toBe(pending);
  gate.resolve();
  const span = await pending;
  expect(starts).toEqual([4800, 8896, 12992, 17088]);
  expect(span.endFrame - span.startFrame).toBe(14400);
  expect(maximum).toBe(1);
  expect(recorder.cells.state.value).toBe("idle");
});

test("abort skips queued callbacks and waits for the active writer before rejecting", async () => {
  const { context, recorder } = offline();
  const gate = deferred();
  cleanup.push(gate.resolve);
  const controller = new AbortController();
  let calls = 0,
    settled = false;
  const pending = recorder.record({
    when: 0.1,
    length: 0.3,
    signal: controller.signal,
    onChunk() {
      calls++;
      return gate.promise;
    },
  });
  void pending.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await vi.waitFor(() => expect(recorder.cells.startsAt.value).toBe(0.1));
  await context.startRendering();
  await vi.waitFor(() => expect(calls).toBe(1));
  controller.abort();
  await Promise.resolve();
  await Promise.resolve();
  expect(settled).toBe(false);
  expect(recorder.cells.state.value).toBe("stopping");
  await expect(recorder.record({ length: 0.01 })).rejects.toThrow("already has an active take");
  gate.resolve();
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  expect(calls).toBe(1);
  expect(recorder.cells.state.value).toBe("idle");
});

test("ready preloads only registration and a subsequent record arms before rendering can resume", async () => {
  const { context, recorder } = offline();
  await recorder.ready;
  expect(recorder.cells.state.value).toBe("idle");
  expect(recorder.cells.startsAt.value).toBeNull();
  const pending = recorder.record({ when: 0.1, length: 0.1 });
  expect(recorder.cells.startsAt.value).toBe(0.1);
  await context.startRendering();
  const take = await pending;
  expect(take.startFrame).toBe(4800);
  expect(take.endFrame).toBe(9600);
  expect(take.channels[0]).toHaveLength(4800);
  expect(take.channels[0][0]).toBeCloseTo(0.25, 6);
  expect(take.channels[0][4799]).toBeCloseTo(0.25, 6);
});

test.each(["cancel", "abort", "writer failure", "dispose"] as const)(
  "%s drains a blocked writer, skips queued calls and preserves borrowed audio",
  async (action) => {
    const context = new AudioContext({ sampleRate: 48_000 });
    const recorder = new AudioRecorder(context, { channels: 1 });
    const source = new ConstantSourceNode(context, { offset: 0.375 });
    source.connect(recorder.input);
    source.start();
    cleanup.push(
      () => context.close(),
      () => recorder.dispose(),
    );
    const gate = deferred();
    cleanup.push(gate.resolve);
    const controller = new AbortController();
    const writerError = new Error("Disk permission revoked");
    let calls = 0,
      settled = false;
    await context.resume();
    await recorder.ready;
    const when = context.currentTime + 0.05;
    const pending = recorder.record({
      when,
      length: 0.35,
      signal: controller.signal,
      async onChunk() {
        calls++;
        await gate.promise;
        if (action === "writer failure") throw writerError;
      },
    });
    void pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await vi.waitFor(() => expect(calls).toBe(1));
    // Let multiple native chunks arrive while the first borrowed chunk is held.
    await vi.waitFor(() => expect(context.currentTime).toBeGreaterThan(when + 0.3));
    if (action === "cancel") recorder.cancel();
    if (action === "abort") controller.abort();
    if (action === "dispose") recorder.dispose();
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toBe(1);
    expect(settled).toBe(false);
    if (action !== "dispose") await expect(recorder.record({ length: 0.01 })).rejects.toThrow("already has an active take");
    gate.resolve();
    if (action === "writer failure") await expect(pending).rejects.toBe(writerError);
    else if (action === "dispose") await expect(pending).rejects.toThrow("AudioRecorder is disposed.");
    else await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(calls).toBe(1);
    expect(context.state).toBe("running");
    if (action !== "dispose") {
      expect(recorder.cells.state.value).toBe("idle");
      const next = await recorder.record({ length: 0.03 });
      expect(next.channels[0]).toHaveLength(1440);
      expect(next.channels[0][0]).toBeCloseTo(0.375, 6);
      expect(recorder.cells.error.value).toBeNull();
    } else expect(recorder.cells.state.value).toBe("disposed");
  },
);

test("stop rejects the wrong result mode without destroying either take and legacy stream commands are absent", async () => {
  const { context, recorder } = offline();
  await recorder.ready;
  expect("startStream" in recorder).toBe(false);
  expect("stopStream" in recorder).toBe(false);
  const buffered = recorder.record({ when: 0.1 });
  await expect(recorder.stop({ result: "span", when: 0.2 })).rejects.toMatchObject({ name: "InvalidStateError" });
  expect(recorder.cells.state.value).toBe("armed");
  recorder.cancel();
  await expect(buffered).rejects.toMatchObject({ name: "AbortError" });
  const streamed = recorder.record({ when: 0.1, length: 0.1, onChunk() {} });
  await expect(recorder.stop({ when: 0.2 })).rejects.toMatchObject({ name: "InvalidStateError" });
  expect(recorder.cells.state.value).toBe("armed");
  await context.startRendering();
  expect(await streamed).toMatchObject({ startFrame: 4800, endFrame: 9600, channelCount: 1 });
});

test("an invalid dynamic chunk writer rejects without leaving a capture active", async () => {
  const { recorder } = offline();
  await expect(recorder.record({ onChunk: 42 as never })).rejects.toMatchObject({
    name: "TypeError",
    message: "AudioRecorder stream needs a chunk writer.",
  });
  expect(recorder.cells.state.value).toBe("idle");
});

test("exactly 64 pending chunks are accepted and all finish in order when the writer resumes", async () => {
  const { context, recorder } = offline(6);
  const gate = deferred();
  cleanup.push(gate.resolve);
  let calls = 0;
  const pending = recorder.record({
    when: 0.1,
    length: 262144 / 48000,
    async onChunk(chunk) {
      calls++;
      expect(chunk.startFrame).toBe(4800 + (calls - 1) * 4096);
      await gate.promise;
    },
  });
  await vi.waitFor(() => expect(recorder.cells.startsAt.value).toBe(0.1));
  await context.startRendering();
  await vi.waitFor(() => expect(recorder.cells.state.value).toBe("stopping"));
  expect(calls).toBe(1);
  expect(recorder.cells.error.value).toBeNull();
  gate.resolve();
  const span = await pending;
  expect(span.endFrame - span.startFrame).toBe(262144);
  expect(calls).toBe(64);
});

test.each([false, true])(
  "abort during cold initialization (pre-aborted: %s) cannot resurrect a stream and the same owner is reusable",
  async (preAborted) => {
    const { context, recorder } = offline();
    const controller = new AbortController();
    if (preAborted) controller.abort();
    let cancelledWrites = 0;
    const pending = recorder.record({
      when: 0.1,
      length: 0.1,
      signal: controller.signal,
      onChunk() {
        cancelledWrites++;
      },
    });
    if (!preAborted) controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(recorder.cells.state.value).toBe("idle");
    let frames = 0;
    const reused = recorder.record({
      when: 0.2,
      length: 0.1,
      onChunk(chunk) {
        frames += chunk.channels[0].length;
      },
    });
    await vi.waitFor(() => expect(recorder.cells.startsAt.value).toBe(0.2));
    await context.startRendering();
    expect(await reused).toMatchObject({ startFrame: 9600, endFrame: 14400 });
    expect(frames).toBe(4800);
    expect(cancelledWrites).toBe(0);
  },
);

test("a preloaded recorder captures the first offline frame without a startup sleep", async () => {
  const { context, recorder } = offline();
  await recorder.ready;
  const pending = recorder.record({ length: 0.1 });
  await context.startRendering();
  const take = await pending;
  expect(take.startFrame).toBe(0);
  expect(take.endFrame).toBe(4800);
  expect(take.channels[0][0]).toBeCloseTo(0.25, 6);
  expect(take.channels[0][4799]).toBeCloseTo(0.25, 6);
});
