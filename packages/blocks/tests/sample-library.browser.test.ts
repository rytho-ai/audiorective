import { afterEach, expect, test, vi } from "vitest";
import { cell, effect } from "@audiorective/core";
import { SampleLibrary } from "../src/SampleLibrary";

const disposers: Array<() => void | Promise<unknown>> = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0).reverse()) await dispose();
});

/** A mono 16-bit PCM WAV of constant level. */
function wav(seconds: number, sampleRate = 8000): File {
  const frames = Math.round(seconds * sampleRate);
  const bytes = new ArrayBuffer(44 + frames * 2);
  const view = new DataView(bytes);
  const text = (offset: number, value: string) => [...value].forEach((char, i) => view.setUint8(offset + i, char.charCodeAt(0)));
  text(0, "RIFF");
  view.setUint32(4, 36 + frames * 2, true);
  text(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, frames * 2, true);
  for (let i = 0; i < frames; i++) view.setInt16(44 + i * 2, 8000, true);
  return new File([bytes], "short.wav", { type: "audio/wav" });
}

test("preview publishes playing state and returns to idle when a short sample ends naturally", async () => {
  const context = new AudioContext();
  await context.resume();
  const library = new SampleLibrary(context);
  disposers.push(
    () => library.destroy(),
    () => context.close(),
  );
  const [id] = await library.importFiles([wav(0.15)]);
  expect(library.state.value.rows[0]?.status).toBe("ready");

  const seen: boolean[] = [];
  disposers.push(
    effect(() => {
      const playing = library.state.value.previewPlaying;
      if (seen.at(-1) !== playing) seen.push(playing);
    }),
  );

  await library.preview(id!);
  expect(library.state.value.previewId).toBe(id);
  expect(library.state.value.previewPlaying).toBe(true);

  await expect.poll(() => library.state.value.previewPlaying, { timeout: 3000, interval: 10 }).toBe(false);
  expect(library.state.value.previewId).toBe(id);
  expect(seen).toEqual([false, true, false]);

  library.stopPreview();
  expect(library.state.value.previewId).toBeNull();
});

async function readyLibrary(seconds = 0.15) {
  const context = new AudioContext();
  await context.resume();
  const library = new SampleLibrary(context);
  disposers.push(
    () => library.destroy(),
    () => context.close(),
  );
  const [id] = await library.importFiles([wav(seconds)]);
  return { library, id: id! };
}

test("a preview started inside an effect keeps publishing after that effect re-runs", async () => {
  const { library, id } = await readyLibrary();
  const trigger = cell(0);
  let started = false;
  disposers.push(
    effect(() => {
      void trigger.value;
      if (started) return;
      started = true;
      void library.preview(id);
    }),
  );
  await expect.poll(() => library.state.value.previewPlaying).toBe(true);
  trigger.value = 1;
  await expect.poll(() => library.state.value.previewPlaying, { timeout: 3000, interval: 10 }).toBe(false);
  expect(library.state.value.previewId).toBe(id);
});

test("the state cell is the store: rows, decoded bytes and preview change in single commits", async () => {
  const { library, id } = await readyLibrary();
  const states: unknown[] = [];
  disposers.push(effect(() => void states.push(library.state.value)));
  expect(library.state.value.decodedBytes).toBeGreaterThan(0);
  library.remove(id);
  expect(library.state.value).toMatchObject({ rows: [], decodedBytes: 0, previewId: null, previewPlaying: false });
  expect(states).toHaveLength(2);
});

test("a failed preview releases its lease", async () => {
  const { library, id } = await readyLibrary();
  const connect = vi.spyOn(AudioNode.prototype, "connect").mockImplementationOnce(() => {
    throw new Error("connect failed");
  });
  await expect(library.preview(id)).rejects.toThrow("connect failed");
  connect.mockRestore();
  library.remove(id);
  expect(library.state.value.decodedBytes).toBe(0);
});
