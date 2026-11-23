import { unzipSync } from "fflate";
import { afterEach, describe, expect, test } from "vitest";
import { AudioMedia, Project, Workspace, exportAudioFallbackTo } from "../src";

const RATE = 48_000;
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function open(project: Project): Promise<Workspace> {
  const context = new AudioContext({ sampleRate: RATE });
  const workspace = await Workspace.create(context, project);
  cleanups.push(async () => {
    workspace.dispose();
    project.dispose();
    await context.close();
  });
  return workspace;
}

/** Deterministic, non-repeating PCM in [-0.5, 0.5) whose every frame differs from its neighbours. */
const pattern = (frames: number, seed: number) =>
  Float32Array.from({ length: frames }, (_, i) => (((i * 7919 + seed * 104729) % 2003) / 2003 - 0.5) * 0.9);

type Exported = { names: string[]; wav: Map<string, [Float32Array, Float32Array]>; manifest: Record<string, unknown> };

async function exportZip(workspace: Workspace, options: Parameters<typeof exportAudioFallbackTo>[2] = {}): Promise<Exported> {
  const parts: Uint8Array[] = [];
  await exportAudioFallbackTo(workspace, new WritableStream({ write: (chunk) => void parts.push(chunk) }), options);
  const files = unzipSync(new Uint8Array(await new Blob(parts as BlobPart[]).arrayBuffer()));
  const wav = new Map<string, [Float32Array, Float32Array]>();
  for (const [name, bytes] of Object.entries(files)) {
    if (!name.endsWith(".wav")) continue;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(view.getUint16(20, true)).toBe(3);
    expect(view.getUint16(22, true)).toBe(2);
    expect(view.getUint32(24, true)).toBe(RATE);
    const frames = (bytes.length - 44) / 8;
    const left = new Float32Array(frames);
    const right = new Float32Array(frames);
    for (let frame = 0; frame < frames; frame++) {
      left[frame] = view.getFloat32(44 + frame * 8, true);
      right[frame] = view.getFloat32(44 + frame * 8 + 4, true);
    }
    wav.set(name, [left, right]);
  }
  return { names: Object.keys(files), wav, manifest: JSON.parse(new TextDecoder().decode(files["manifest.json"])) };
}

/** Stereo frames of `source` through the default centre pan, as the stem carries them. */
const stereo = (source: Float32Array, gain: number): [Float32Array, Float32Array] => [source.map((v) => v * gain), source.map((v) => v * gain)];

/** The gain a centred mono clip meets at the stem; measured from the render itself so the tests compare the signal and not a pan-law constant. */
function centreGain(stem: [Float32Array, Float32Array], source: Float32Array, at: number): number {
  let best = 0;
  for (let i = 0; i < source.length; i++) if (Math.abs(source[i]) > Math.abs(source[best])) best = i;
  return stem[0][at + best] / source[best];
}

function expectExact(actual: Float32Array, expected: Float32Array, label: string) {
  expect(actual.length, label).toBe(expected.length);
  let worst = 0;
  let at = -1;
  for (let i = 0; i < actual.length; i++) {
    const difference = Math.abs(actual[i] - expected[i]);
    if (difference > worst) {
      worst = difference;
      at = i;
    }
  }
  expect(worst, `${label}: worst difference at frame ${at}`).toBeLessThan(1e-6);
}

describe("offline audio fallback export", () => {
  test("keeps exact PCM across many clip starts and ends, and silence between them", async () => {
    const project = new Project({ title: "Churn", bpm: 120 });
    const track = project.addTrack("Churn", "audio");
    // Clips start and end on frames that are not render-quantum boundaries; each is its own graph edit.
    const clips = Array.from({ length: 24 }, (_, i) => ({ at: 4800 * (i + 1) + 37 * i, frames: 1500 + 101 * i, seed: i + 1 }));
    for (const clip of clips) project.addAudioClip(track.id, { sampleRate: RATE, channels: [pattern(clip.frames, clip.seed)] }, clip.at / RATE);
    const workspace = await open(project);
    const out = await exportZip(workspace, { tailSeconds: 0.25 });
    const stem = out.wav.get(`tracks/${track.id}.wav`)!;
    const last = clips[clips.length - 1];
    expect(stem[0].length).toBe(Math.ceil((workspace.duration + 0.25) * RATE));
    expect(stem[0].length).toBeGreaterThan(last.at + last.frames);
    const gain = centreGain(stem, pattern(clips[0].frames, clips[0].seed), clips[0].at);
    expect(gain).toBeGreaterThan(0.5);
    const expected = new Float32Array(stem[0].length);
    for (const clip of clips)
      expected.set(
        pattern(clip.frames, clip.seed).map((v) => v * gain),
        clip.at,
      );
    expectExact(stem[0], expected, "stem left");
    expectExact(stem[1], expected, "stem right");
    expect(out.manifest.durationSeconds).toBe(stem[0].length / RATE);
  });

  test("a slow file-backed read holds the render instead of rendering silence", async () => {
    const frames = 4.5 * RATE; // three two-second media chunks
    const source = pattern(frames, 9);
    const bytes = new Float32Array(frames);
    bytes.set(source);
    const delays: number[] = [];
    class SlowMedia extends AudioMedia {
      override async readFrames(start: number, count: number) {
        delays.push(start);
        await new Promise((resolve) => setTimeout(resolve, 400));
        return super.readFrames(start, count);
      }
    }
    const media = new SlowMedia(new Blob([bytes.buffer as ArrayBuffer]), RATE, 1, frames);
    const project = new Project({ title: "Slow", bpm: 120 });
    const track = project.addTrack("Slow", "audio");
    project.addAudioMediaClip(track.id, media, 0);
    const workspace = await open(project);
    const out = await exportZip(workspace, { tailSeconds: 0 });
    const stem = out.wav.get(`tracks/${track.id}.wav`)!;
    expect(delays.length).toBeGreaterThanOrEqual(3);
    const gain = centreGain(stem, source, 0);
    expect(gain).toBeGreaterThan(0.5);
    expectExact(
      stem[0],
      source.map((v) => v * gain),
      "stem left",
    );
  });

  test("cancelling mid-render rejects with AbortError, aborts the destination and removes temporary storage", async () => {
    const project = new Project({ title: "Cancel", bpm: 120 });
    const track = project.addTrack("Long", "audio");
    for (let i = 0; i < 20; i++) project.addAudioClip(track.id, { sampleRate: RATE, channels: [pattern(RATE, i)] }, i);
    const workspace = await open(project);
    const root = await navigator.storage.getDirectory();
    const listing = async () => {
      const names: string[] = [];
      const directory = await root.getDirectoryHandle("audiorective-takes", { create: true });
      for await (const [name] of directory as unknown as AsyncIterable<[string, unknown]>) names.push(name);
      return names;
    };
    const before = await listing();
    const controller = new AbortController();
    const progress: number[] = [];
    let aborted: unknown;
    const destination = new WritableStream<Uint8Array>({ abort: (reason) => void (aborted = reason) });
    const started = performance.now();
    await expect(
      exportAudioFallbackTo(workspace, destination, {
        tailSeconds: 0,
        signal: controller.signal,
        onProgress: (fraction) => {
          progress.push(fraction);
          if (fraction >= 0.2) controller.abort();
        },
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(performance.now() - started).toBeLessThan(20_000);
    expect(progress.length).toBeGreaterThan(0);
    expect(Math.max(...progress)).toBeLessThan(1);
    expect((aborted as DOMException).name).toBe("AbortError");
    expect(await listing()).toEqual(before);
  });

  test("exports the mix and post-mixer stems, and drops stems above fifteen tracks", async () => {
    const project = new Project({ title: "Stems", bpm: 120 });
    const a = project.addTrack("A", "audio");
    const b = project.addTrack("B", "audio");
    const ax = pattern(9600, 3);
    const bx = pattern(7200, 4);
    project.addAudioClip(a.id, { sampleRate: RATE, channels: [ax] }, 0.1);
    project.addAudioClip(b.id, { sampleRate: RATE, channels: [bx] }, 0.2);
    project.setTrackVolume(b.id, 0.5);
    project.setMasterVolume(0.6);
    const workspace = await open(project);
    const out = await exportZip(workspace, { tailSeconds: 0.1 });
    expect(out.names).toEqual(["mix.wav", `tracks/${a.id}.wav`, `tracks/${b.id}.wav`, "manifest.json"]);
    expect(out.manifest).toMatchObject({ format: "audiorective-audio-fallback", version: 1, sampleRate: RATE, mix: "mix.wav", stemsOmitted: false });
    const stemA = out.wav.get(`tracks/${a.id}.wav`)!;
    const stemB = out.wav.get(`tracks/${b.id}.wav`)!;
    const mix = out.wav.get("mix.wav")!;
    const gain = centreGain(stemA, ax, 4800);
    const expectedA = new Float32Array(stemA[0].length);
    expectedA.set(
      ax.map((v) => v * gain),
      4800,
    );
    const expectedB = new Float32Array(stemA[0].length);
    expectedB.set(
      bx.map((v) => v * gain * 0.5),
      9600,
    );
    expectExact(stemA[0], expectedA, "stem A");
    expectExact(stemB[0], expectedB, "stem B");
    expectExact(
      mix[0],
      expectedA.map((v, i) => (v + expectedB[i]) * 0.6),
      "mix",
    );
    const wide = new Project({ title: "Wide", bpm: 120 });
    for (let i = 0; i < 16; i++) wide.addTrack(`T${i}`, "audio");
    wide.addAudioClip(wide.tracks[0].id, { sampleRate: RATE, channels: [pattern(4800, 5)] }, 0);
    const wideOut = await exportZip(await open(wide), { tailSeconds: 0 });
    expect(wideOut.names).toEqual(["mix.wav", "manifest.json"]);
    expect(wideOut.manifest.stemsOmitted).toBe(true);
    expectExact(
      wideOut.wav.get("mix.wav")![0].subarray(0, 4800),
      stereo(pattern(4800, 5), centreGain(wideOut.wav.get("mix.wav")!, pattern(4800, 5), 0))[0],
      "wide mix",
    );
  });

  test("an unresolved device fails before any audio is rendered", async () => {
    const project = new Project({ title: "Unresolved", bpm: 120 });
    const track = project.addTrack("Synth", "midi");
    project.addWebClapDevice(track.id, {
      pluginId: "missing.plugin",
      name: "Missing",
      vendor: "x",
      version: "1",
      bundleUrl: "",
      state: new Uint8Array(),
    });
    const workspace = await open(project);
    let aborted = false;
    await expect(exportAudioFallbackTo(workspace, new WritableStream({ abort: () => void (aborted = true) }))).rejects.toThrow(/unresolved devices/);
    expect(aborted).toBe(true);
  });
});
