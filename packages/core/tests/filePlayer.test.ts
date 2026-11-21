import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { FilePlayer, effect } from "../src";

/** Build a valid silent WAV data URI so a real <audio> element can load + play it. */
function wavDataUri(seconds = 0.3, sampleRate = 8000): string {
  const n = Math.max(1, Math.floor(seconds * sampleRate));
  const bytes = 44 + n * 2;
  const ab = new ArrayBuffer(bytes);
  const dv = new DataView(ab);
  const w = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i));
  };
  w(0, "RIFF");
  dv.setUint32(4, bytes - 8, true);
  w(8, "WAVE");
  w(12, "fmt ");
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);
  dv.setUint16(22, 1, true);
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * 2, true);
  dv.setUint16(32, 2, true);
  dv.setUint16(34, 16, true);
  w(36, "data");
  dv.setUint32(40, n * 2, true);
  // samples left as zero (silence)
  let bin = "";
  const u8 = new Uint8Array(ab);
  for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i]!);
  return "data:audio/wav;base64," + btoa(bin);
}
function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
function once(el: HTMLMediaElement, type: string, timeoutMs = 8000): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), timeoutMs);
    el.addEventListener(
      type,
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });
}

function makePlayer(ctx: AudioContext, opts?: ConstructorParameters<typeof FilePlayer>[1]): FilePlayer {
  const p = new FilePlayer(ctx, opts);
  p.output.connect(ctx.destination); // real usage routes output to destination; required for the media element to progress
  return p;
}

describe("FilePlayer", () => {
  let ctx: AudioContext;
  beforeEach(async () => {
    ctx = new AudioContext();
    await ctx.resume();
  });
  afterEach(() => {
    void ctx.close();
  });

  test("output is an AudioNode and volume param drives it", () => {
    const p = makePlayer(ctx, { volume: 0.5 });
    expect(p.output).toBeInstanceOf(AudioNode);
    expect((p.output as GainNode).gain.value).toBeCloseTo(0.5);
    p.params.volume.value = 0.25;
    expect((p.output as GainNode).gain.value).toBeCloseTo(0.25);
    p.dispose();
  });

  test("loadedmetadata populates the duration cell", async () => {
    const p = makePlayer(ctx, { src: wavDataUri(0.3) });
    await once(p.audio, "loadedmetadata");
    expect(p.cells.duration.value).toBeGreaterThan(0.2);
    expect(p.cells.duration.value).toBeLessThan(0.6);
    p.dispose();
  });

  test("play sets isPlaying; pause clears it", async () => {
    const p = makePlayer(ctx, { src: wavDataUri(2) });
    await once(p.audio, "loadedmetadata");
    await p.play();
    expect(p.cells.isPlaying.value).toBe(true);
    p.pause();
    await delay(30);
    expect(p.cells.isPlaying.value).toBe(false);
    p.dispose();
  });

  test("seek sets currentTime and clamps to duration", async () => {
    const p = makePlayer(ctx, { src: wavDataUri(2) });
    await once(p.audio, "loadedmetadata");
    p.seek(1);
    expect(p.cells.currentTime.value).toBeCloseTo(1, 1);
    p.seek(99);
    expect(p.cells.currentTime.value).toBeLessThanOrEqual(p.cells.duration.value + 0.01);
    p.dispose();
  });

  test("stop pauses and rewinds to 0", async () => {
    const p = makePlayer(ctx, { src: wavDataUri(2) });
    await once(p.audio, "loadedmetadata");
    p.seek(0.5);
    p.stop();
    expect(p.cells.isPlaying.value).toBe(false);
    expect(p.cells.currentTime.value).toBe(0);
    p.dispose();
  });

  test("loop sets audio.loop", () => {
    const p = makePlayer(ctx, { src: wavDataUri(1), loop: true });
    expect(p.audio.loop).toBe(true);
    p.loop = false;
    expect(p.audio.loop).toBe(false);
    p.dispose();
  });

  test("onEnded fires once when a non-looping clip finishes", async () => {
    const p = makePlayer(ctx, { src: wavDataUri(0.3) });
    let ended = 0;
    p.onEnded(() => {
      ended++;
    });
    await once(p.audio, "loadedmetadata");
    await p.play();
    await once(p.audio, "ended", 8000);
    expect(ended).toBe(1);
    expect(p.cells.isPlaying.value).toBe(false);
    p.dispose();
  });

  test("setting src resets currentTime and duration", async () => {
    const p = makePlayer(ctx, { src: wavDataUri(2) });
    await once(p.audio, "loadedmetadata");
    p.seek(1);
    expect(p.cells.currentTime.value).toBeCloseTo(1, 1);
    p.src = wavDataUri(0.3);
    expect(p.cells.currentTime.value).toBe(0);
    expect(Number.isNaN(p.cells.duration.value)).toBe(true);
    p.dispose();
  });

  test("dispose disconnects without throwing", () => {
    const p = makePlayer(ctx, { src: wavDataUri(1) });
    expect(() => p.dispose()).not.toThrow();
  });

  test("play() with no src rejects with NotSupportedError and stays stopped", async () => {
    const p = makePlayer(ctx);
    await expect(p.play()).rejects.toMatchObject({ name: "NotSupportedError" });
    expect(p.cells.isPlaying.value).toBe(false);
    p.dispose();
  });

  test("play() rejects with the element's NotAllowedError instead of swallowing it", async () => {
    const p = makePlayer(ctx, { src: wavDataUri(1) });
    const blocked = new DOMException("blocked", "NotAllowedError");
    const spy = vi.spyOn(p.audio, "play").mockRejectedValue(blocked);
    await expect(p.play()).rejects.toBe(blocked);
    expect(p.cells.isPlaying.value).toBe(false);
    spy.mockRestore();
    p.dispose();
  });

  test("play() rejects with AbortError when pause() interrupts it", async () => {
    const p = makePlayer(ctx, { src: wavDataUri(1) });
    const interrupted = new DOMException("interrupted", "AbortError");
    vi.spyOn(p.audio, "play").mockRejectedValue(interrupted);
    await expect(p.play()).rejects.toMatchObject({ name: "AbortError" });
    p.dispose();
  });

  test("dispose() while actively playing does not throw", async () => {
    const p = makePlayer(ctx, { src: wavDataUri(2) });
    await once(p.audio, "loadedmetadata");
    await p.play();
    expect(() => p.dispose()).not.toThrow();
  });

  test("src is tracked by effects", () => {
    const p = makePlayer(ctx);
    const seen: Array<string | null> = [];
    const stop = effect(() => {
      seen.push(p.src);
    });
    p.src = wavDataUri(0.1);
    expect(seen.length).toBe(2);
    expect(seen[0]).toBeNull();
    expect(p.src).toBe(seen[1]);
    stop();
    p.dispose();
  });

  test("position reads the element's playhead live, between timeupdate events", async () => {
    const p = makePlayer(ctx, { src: wavDataUri(2) });
    await once(p.audio, "loadedmetadata");
    expect(p.position).toBe(0);
    await p.play();
    const first = p.position;
    await delay(80);
    expect(p.position).toBeGreaterThan(first);
    expect(p.position).toBe(p.audio.currentTime);
    p.dispose();
  });

  test("cells.error holds the element's MediaError and clears when a new src is set", async () => {
    const p = makePlayer(ctx);
    expect(p.cells.error.value).toBeNull();
    p.src = "data:audio/wav;base64,AAAA";
    await once(p.audio, "error");
    expect(p.cells.error.value).toBe(p.audio.error);
    expect(p.cells.error.value).not.toBeNull();
    p.src = wavDataUri(0.3);
    expect(p.cells.error.value).toBeNull();
    p.dispose();
  });
});
