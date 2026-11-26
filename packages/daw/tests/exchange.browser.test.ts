import { afterEach, describe, expect, test } from "vitest";
import { encodeWavBytes } from "@audiorective/core";
import { Project, Workspace, importAudioFiles, renderStems } from "../src";

const RATE = 48_000;
const worklet = "/@fs" + new URL("../../host/dist/webclap-worklet.js", import.meta.url).pathname.replace(/^\/@fs/, "");
const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function open(project = new Project({ bpm: 120 })) {
  const context = new AudioContext({ sampleRate: RATE });
  const workspace = await Workspace.create(context, project, { workletUrl: worklet });
  cleanups.push(async () => {
    workspace.dispose();
    project.dispose();
    await context.close();
  });
  return { project, workspace };
}

/** A mono file at `rate` with a one-sample click at `at` seconds and silence everywhere else. */
function clickFile(rate: number, seconds: number, at: number, bits: 16 | 32 = 32) {
  const channel = new Float32Array(Math.round(rate * seconds));
  channel[Math.round(rate * at)] = 1;
  return encodeWavBytes({ sampleRate: rate, channels: [channel] }, { bitDepth: bits });
}
const peakAt = (x: Float32Array) => x.reduce((best, value, index) => (Math.abs(value) > Math.abs(x[best]) ? index : best), 0);

describe("importAudioFiles", () => {
  test("44.1 kHz and 48 kHz WAVs land at the Workspace rate with equal length and the same sample for the click; leading silence stays; one undo step", async () => {
    const { project, workspace } = await open();
    const files = [
      { name: "drums.wav", bytes: clickFile(44_100, 2, 0.5) },
      { name: "fx.final.wav", bytes: clickFile(48_000, 2, 0.5) },
      new File([new Uint8Array(clickFile(44_100, 2, 0.75))], "bass.wav"),
    ];
    const result = await importAudioFiles(workspace, files);
    expect(result.sampleRate).toBe(RATE);
    expect(result.tracks.map((track) => track.name)).toEqual(["drums", "fx.final", "bass"]);
    const audio = result.tracks.map((track) => {
      const clip = track.clips[0];
      if (clip.kind !== "audio" || clip.media) throw new Error("expected PCM audio");
      return clip;
    });
    expect(audio.map((clip) => clip.sampleRate)).toEqual([RATE, RATE, RATE]);
    expect(audio[0].channels[0].length).toBe(audio[1].channels[0].length);
    expect(audio[0].channels[0].length).toBe(2 * RATE);
    // The click is at the same sample in the 44.1 kHz and the 48 kHz file, and nothing comes before it beyond the filter's short ringing.
    const [a, b] = [peakAt(audio[0].channels[0]), peakAt(audio[1].channels[0])];
    expect(a).toBe(24_000);
    expect(b).toBe(24_000);
    expect(audio[0].channels[0].subarray(0, 23_900).every((value) => value === 0)).toBe(true);
    // Cross-correlation of the two clicks peaks at lag 0.
    let bestLag = 0;
    let best = -Infinity;
    for (let lag = -3; lag <= 3; lag++) {
      let sum = 0;
      for (let i = 23_990; i < 24_010; i++) sum += audio[0].channels[0][i] * audio[1].channels[0][i + lag];
      if (sum > best) [best, bestLag] = [sum, lag];
    }
    expect(bestLag).toBe(0);
    expect(audio.map((clip) => clip.time)).toEqual([0, 0, 0]);
    // One undo step; the Workspace asks for a sync as for any track change.
    expect(project.cells.history.value.undo).toBe("Import audio files");
    expect(workspace.cells.needsSync.value).toBe(true);
    await workspace.sync();
    expect(workspace.cells.needsSync.value).toBe(false);
    expect(project.undo().status).toBe("applied");
    expect(project.tracks).toHaveLength(0);
    expect(project.redo().status).toBe("applied");
    expect(project.tracks).toHaveLength(3);
  });

  test("atBeat places every clip at that beat through the tempo map; 16-bit WAVs decode; bad files fail clearly", async () => {
    const { project, workspace } = await open();
    const { tracks } = await importAudioFiles(workspace, [{ name: "a.wav", bytes: clickFile(44_100, 1, 0.25, 16) }], { atBeat: 4 });
    expect(tracks[0].clips[0].time).toBe(2);
    const clip = tracks[0].clips[0];
    expect(clip.kind === "audio" && peakAt(clip.channels[0])).toBe(12_000);
    await expect(importAudioFiles(workspace, [{ name: "junk.bin", bytes: new Uint8Array([1, 2, 3, 4]) }])).rejects.toThrow(
      /could not decode "junk.bin"/,
    );
    await expect(importAudioFiles(workspace, [], { atBeat: -1 })).rejects.toThrow(/atBeat/);
    expect(project.tracks).toHaveLength(1);
    expect((await importAudioFiles(workspace, [])).tracks).toEqual([]);
  });
});

describe("renderStems", () => {
  async function band() {
    const project = new Project({ bpm: 120 });
    const sine = (hz: number, seconds: number, level: number) => ({
      sampleRate: RATE,
      channels: [Float32Array.from({ length: Math.round(RATE * seconds) }, (_, i) => level * Math.sin((2 * Math.PI * hz * i) / RATE))],
    });
    const names = ["Drums", "Bass", "Keys"];
    names.forEach((name, index) => {
      const track = project.addTrack(name, "audio", { volume: 0.8 - index * 0.2, pan: index - 1 });
      project.addAudioClip(track.id, sine(220 * (index + 1), 1 + index * 0.5, 0.3), index * 0.25);
    });
    return open(project);
  }

  test("every stem and the mix share one start and length; the stems add up to the mix when there are no sends or master effects", async () => {
    const { workspace } = await band();
    await workspace.sync();
    const result = await renderStems(workspace, { tailSeconds: 0.5 });
    if (result.status !== "rendered") throw new Error("expected a render");
    expect(result.sampleRate).toBe(RATE);
    expect(result.stems.map((stem) => stem.name)).toEqual(["Drums", "Bass", "Keys"]);
    // The song ends where the last clip ends (0.5 + 2 s), plus the tail.
    const frames = Math.round(2.5 * RATE) + Math.round(0.5 * RATE);
    expect(result.durationSeconds).toBe(frames / RATE);
    for (const stem of result.stems) expect(stem.audio.channels.map((c) => c.length)).toEqual([frames, frames]);
    expect(result.mix!.channels.map((c) => c.length)).toEqual([frames, frames]);
    let worst = 0;
    for (let channel = 0; channel < 2; channel++)
      for (let i = 0; i < frames; i++) {
        const sum = result.stems.reduce((total, stem) => total + stem.audio.channels[channel][i], 0);
        worst = Math.max(worst, Math.abs(sum - result.mix!.channels[channel][i]));
      }
    expect(worst).toBeLessThan(1e-4);
    // Each stem is that track alone: the first one is silent before its own clip would be, the second starts at 0.25 s.
    const bass = result.stems[1].audio.channels[0];
    expect(bass.subarray(0, Math.round(0.25 * RATE) - 2).every((value) => Math.abs(value) < 1e-6)).toBe(true);
    expect(Math.max(...bass.subarray(Math.round(0.3 * RATE), Math.round(0.4 * RATE)).map(Math.abs))).toBeGreaterThan(0.01);
    // Encoded stems are ordinary WAV files of the same length.
    const wav = encodeWavBytes(result.stems[0].audio, { bitDepth: 24 });
    expect(wav.length).toBe(44 + frames * 2 * 3);
  });

  test("mute silences a stem and the mix, includeMix false skips it, a range limits every file, and an old version conflicts", async () => {
    const { project, workspace } = await band();
    await workspace.sync();
    const bass = project.tracks[1];
    project.setTrackMuted(bass.id, true);
    const version = project.cells.version.value;
    const result = await renderStems(workspace, {
      tailSeconds: 0,
      includeMix: false,
      range: { startSeconds: 0.5, endSeconds: 1.5 },
      expectedVersion: version,
    });
    if (result.status !== "rendered") throw new Error("expected a render");
    expect(result.mix).toBeUndefined();
    expect(result.stems).toHaveLength(3);
    for (const stem of result.stems) expect(stem.audio.channels[0].length).toBe(RATE);
    expect(result.stems[1].audio.channels[0].every((value) => value === 0)).toBe(true);
    expect(Math.max(...result.stems[0].audio.channels[0].map(Math.abs))).toBeGreaterThan(0.01);
    project.setTrackName(bass.id, "Bass 2");
    const stale = await renderStems(workspace, { expectedVersion: version });
    expect(stale.status).toBe("conflict");
    await expect(renderStems(workspace, { tailSeconds: -1 })).rejects.toThrow(/tailSeconds/);
    await expect(renderStems(workspace, { range: { startSeconds: 2, endSeconds: 1 } })).rejects.toThrow(/range/);
  });

  test("a send return is only in the mix, and a soloed track does not change the stems", async () => {
    const project = new Project({ bpm: 120 });
    const bus = project.addTrack("Echo", "bus", { busRole: "effect" });
    const lead = project.addTrack("Lead", "audio");
    const other = project.addTrack("Other", "audio");
    const tone = { sampleRate: RATE, channels: [Float32Array.from({ length: RATE / 2 }, (_, i) => 0.3 * Math.sin((2 * Math.PI * 440 * i) / RATE))] };
    project.addAudioClip(lead.id, tone, 0);
    project.addAudioClip(other.id, tone, 0);
    project.setTrackRouting(lead.id, { outputBusId: null, sends: [{ busId: bus.id, gain: 1 }] });
    project.setTrackSolo(other.id, true);
    const { workspace } = await open(project);
    await workspace.sync();
    const soloed = await renderStems(workspace, { tailSeconds: 0, includeMix: false });
    project.setTrackSolo(other.id, false);
    const result = await renderStems(workspace, { tailSeconds: 0 });
    if (result.status !== "rendered" || soloed.status !== "rendered") throw new Error("expected a render");
    expect(result.stems.map((stem) => stem.name)).toEqual(["Lead", "Other"]);
    const peak = (pcm: { channels: Float32Array[] }) => Math.max(...pcm.channels[0].map(Math.abs));
    expect(peak(result.stems[0].audio)).toBeGreaterThan(0.1);
    // Solo is ignored: the stems are the same with and without it.
    result.stems.forEach((stem, index) => {
      const same = soloed.stems[index].audio.channels[0];
      expect(Math.max(...stem.audio.channels[0].map((value, i) => Math.abs(value - same[i])))).toBeLessThan(1e-6);
    });
    // The mix holds the return of Lead's send on top of the dry stems.
    const [lead0, other0, mix] = [result.stems[0].audio.channels[0], result.stems[1].audio.channels[0], result.mix!.channels[0]];
    expect(Math.max(...mix.map((value, i) => Math.abs(value - lead0[i] - other0[i] - lead0[i])))).toBeLessThan(1e-3);
  });
});
