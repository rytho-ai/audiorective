import { unzipSync } from "fflate";
import { afterEach, describe, expect, test, vi } from "vitest";
import { AudioMedia, Project, Workspace, exportAudioFallbackTo, openWorkspace, renderMixRange, saveWorkspace, saveWorkspaceTo } from "../src";

const RATE = 48_000;
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const pattern = (frames: number, seed: number) =>
  Float32Array.from({ length: frames }, (_, i) => (((i * 7919 + seed * 104729) % 2003) / 2003 - 0.5) * 0.4);

async function stems(workspace: Workspace): Promise<Map<string, Float32Array>> {
  const parts: Uint8Array[] = [];
  await exportAudioFallbackTo(workspace, new WritableStream({ write: (chunk) => void parts.push(chunk) }), { tailSeconds: 0 });
  const files = unzipSync(new Uint8Array(await new Blob(parts as BlobPart[]).arrayBuffer()));
  const out = new Map<string, Float32Array>();
  for (const [name, bytes] of Object.entries(files)) {
    if (!name.endsWith(".wav")) continue;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const left = new Float32Array((bytes.length - 44) / 8);
    for (let frame = 0; frame < left.length; frame++) left[frame] = view.getFloat32(44 + frame * 8, true);
    out.set(name, left);
  }
  return out;
}

function worstDifference(actual: Float32Array, expected: Float32Array): number {
  expect(actual.length).toBe(expected.length);
  let worst = 0;
  for (let index = 0; index < actual.length; index++) worst = Math.max(worst, Math.abs(actual[index] - expected[index]));
  return worst;
}

function expectAt(stem: Float32Array, source: Float32Array, frame: number, gain: number) {
  const window = stem.subarray(frame, frame + source.length);
  expect(
    worstDifference(
      window,
      source.map((value) => value * gain),
    ),
  ).toBeLessThan(1e-6);
}

describe("project edits through the audio graph", () => {
  test("a repeated chorus renders on the right frames, undoes exactly and survives save and reopen", async () => {
    const project = new Project({ bpm: 120 });
    project.setTempoChanges([
      { beat: 8, bpm: 60 },
      { beat: 12, bpm: 120 },
      { beat: 16, bpm: 90 },
    ]);
    const drums = project.addTrack("Drums", "audio");
    const vocals = project.addTrack("Vocals", "audio");
    const drumChorus = pattern(6 * RATE, 1);
    const drumOutro = pattern(RATE, 2);
    const vocal = pattern(2 * RATE, 3);
    project.addAudioClip(drums.id, { sampleRate: RATE, channels: [drumChorus] }, 4);
    project.addAudioClip(drums.id, { sampleRate: RATE, channels: [drumOutro] }, 10);
    project.addAudioClip(vocals.id, { sampleRate: RATE, channels: [vocal] }, 4);

    const context = new AudioContext({ sampleRate: RATE });
    const workspace = await Workspace.create(context, project);
    cleanups.push(async () => {
      workspace.dispose();
      project.dispose();
      await context.close();
    });
    const baseline = await stems(workspace);
    const drumPath = `tracks/${drums.id}.wav`;
    const vocalPath = `tracks/${vocals.id}.wav`;
    const gain = baseline.get(vocalPath)![4 * RATE + 1] / vocal[1];

    const receipt = project.applyEdits({
      expectedVersion: project.cells.version.value,
      label: "Repeat chorus",
      ops: [
        { type: "copyRange", range: { startBeat: 8, endBeat: 16 }, atBeat: 16, placement: "insert", as: "copy" },
        { type: "moveClip", clip: { fromCopy: "copy", trackId: vocals.id }, position: { byBeats: 1 } },
      ],
    });
    expect(receipt.status).toBe("applied");
    await workspace.flush();
    expect(workspace.cells.needsSync.value).toBe(false);
    expect(workspace.cells.error.value).toBeNull();

    const edited = await stems(workspace);
    expectAt(edited.get(drumPath)!, drumChorus, 4 * RATE, gain);
    expectAt(edited.get(drumPath)!, drumChorus, 10 * RATE, gain);
    expectAt(edited.get(drumPath)!, drumOutro, 16 * RATE, gain);
    expectAt(edited.get(vocalPath)!, vocal, 4 * RATE, gain);
    expectAt(edited.get(vocalPath)!, vocal, 11 * RATE, gain);

    expect(project.undo().status).toBe("applied");
    await workspace.flush();
    const undone = await stems(workspace);
    for (const [name, stem] of baseline) expect(worstDifference(undone.get(name)!, stem), name).toBe(0);

    expect(project.redo().status).toBe("applied");
    await workspace.flush();
    const redone = await stems(workspace);
    for (const [name, stem] of edited) expect(worstDifference(redone.get(name)!, stem), name).toBe(0);

    const reopenedContext = new AudioContext({ sampleRate: RATE });
    const reopened = await openWorkspace(reopenedContext, await saveWorkspace(workspace), { ownsProject: true });
    cleanups.push(async () => {
      reopened.dispose();
      await reopenedContext.close();
    });
    const saved = await stems(reopened);
    for (const [name, stem] of edited) expect(worstDifference(saved.get(name)!, stem), name).toBeLessThan(1e-6);
    expect(
      reopened.project.applyEdits({
        expectedVersion: reopened.project.cells.version.value,
        label: "Keep editing",
        ops: [{ type: "copyRange", range: { startBeat: 8, endBeat: 16 }, atBeat: 16, placement: "insert", as: "again" }],
      }).status,
    ).toBe("applied");
  }, 60_000);

  test("an edit during playback keeps the transport running and applies without a rebuild", async () => {
    const project = new Project({ bpm: 120 });
    const track = project.addTrack("Bed", "audio");
    project.addAudioClip(track.id, { sampleRate: RATE, channels: [pattern(RATE, 4)] }, 0);
    project.addAudioClip(track.id, { sampleRate: RATE, channels: [pattern(RATE, 5)] }, 2);
    const context = new AudioContext({ sampleRate: RATE });
    const workspace = await Workspace.create(context, project);
    cleanups.push(async () => {
      workspace.dispose();
      project.dispose();
      await context.close();
    });
    await context.resume();
    await workspace.play();
    const receipt = project.applyEdits({
      expectedVersion: project.cells.version.value,
      label: "Repeat",
      ops: [{ type: "copyRange", range: { startBeat: 0, endBeat: 2 }, atBeat: 2, placement: "insert", as: "copy" }],
    });
    expect(receipt.status).toBe("applied");
    await workspace.flush();
    expect(workspace.transport.state.value).toBe("playing");
    expect(workspace.cells.needsSync.value).toBe(false);
    expect(workspace.cells.error.value).toBeNull();
    workspace.stop();
  }, 20_000);

  async function workspaceFor(project: Project) {
    const context = new AudioContext({ sampleRate: RATE });
    const workspace = await Workspace.create(context, project);
    cleanups.push(async () => {
      workspace.dispose();
      project.dispose();
      await context.close();
    });
    return workspace;
  }

  test("renderMixRange returns the same frames as the full mix, across tempo changes and PCM or file-backed clips", async () => {
    const project = new Project({ bpm: 120 });
    project.setTempoChanges([
      { beat: 4, bpm: 90 },
      { beat: 8, bpm: 150 },
    ]);
    const audio = project.addTrack("Audio", "audio");
    const file = project.addTrack("File", "audio");
    project.addAudioClip(audio.id, { sampleRate: RATE, channels: [pattern(4 * RATE, 6)] }, 0.25);
    const stored = pattern(3 * RATE, 7);
    project.addAudioMediaClip(file.id, new AudioMedia(new Blob([stored.slice().buffer]), RATE, 1, stored.length), 1.5);
    const workspace = await workspaceFor(project);
    const full = (await stems(workspace)).get("mix.wav")!;
    const range = { startBeat: 3, endBeat: 7 };
    const result = await renderMixRange(workspace, { expectedVersion: project.cells.version.value, range, prerollSeconds: 0.5 });
    if (result.status !== "rendered") throw new Error(result.reason);
    const start = Math.round(project.tempoMap.beatToSeconds(3) * RATE);
    const end = Math.round(project.tempoMap.beatToSeconds(7) * RATE);
    expect(result.startSeconds).toBe(start / RATE);
    expect(result.audio.channels[0].length).toBe(end - start);
    expect(worstDifference(result.audio.channels[0], full.subarray(start, end))).toBeLessThan(1e-6);
    expect(result.peakDbFS).toBeGreaterThan(-20);
    expect(result.loudnessLUFS).toBeLessThan(0);
    expect(workspace.transport.state.value).toBe("stopped");
  }, 30_000);

  test("renderMixRange hears an earlier delay only through preroll", async () => {
    const project = new Project({ bpm: 60 });
    const track = project.addTrack("Echo", "audio");
    project.addAudioClip(track.id, { sampleRate: RATE, channels: [new Float32Array(RATE / 10).fill(0.5)] }, 0.9);
    project.setTrackEffects(track.id, [{ id: "delay", type: "delay", enabled: true, wet: 1, delayTime: 0.3, feedback: 0.2 }]);
    project.addAudioClip(track.id, { sampleRate: RATE, channels: [new Float32Array(1)] }, 3);
    const workspace = await workspaceFor(project);
    const expectedVersion = project.cells.version.value;
    const range = { startBeat: 1.05, endBeat: 1.5 };
    const warm = await renderMixRange(workspace, { expectedVersion, range, prerollSeconds: 1 });
    const cold = await renderMixRange(workspace, { expectedVersion, range, prerollSeconds: 0 });
    if (warm.status !== "rendered" || cold.status !== "rendered") throw new Error("Expected renders.");
    const energy = (channel: Float32Array) => channel.reduce((sum, value) => sum + value * value, 0);
    expect(energy(warm.audio.channels[0])).toBeGreaterThan(energy(cold.audio.channels[0]) * 2);
  }, 30_000);

  test("renderMixRange finds a click at a bad join, not at a clean one, and refuses a stale version", async () => {
    const tone = (start: number, frames: number) =>
      Float32Array.from({ length: frames }, (_, index) => 0.4 * Math.sin((2 * Math.PI * 220 * (start + index)) / RATE));
    const project = new Project({ bpm: 60 });
    const track = project.addTrack("Tone", "audio");
    project.addAudioClip(track.id, { sampleRate: RATE, channels: [tone(0, RATE)] }, 0);
    project.addAudioClip(track.id, { sampleRate: RATE, channels: [tone(RATE, RATE)] }, 1);
    project.addAudioClip(track.id, { sampleRate: RATE, channels: [tone(137, RATE)] }, 2);
    const workspace = await workspaceFor(project);
    const expectedVersion = project.cells.version.value;
    const result = await renderMixRange(workspace, { expectedVersion, range: { startBeat: 0.5, endBeat: 2.5 }, seamBeats: [1, 2] });
    if (result.status !== "rendered") throw new Error(result.reason);
    expect(result.seams.map(({ beat, hasClick }) => [beat, hasClick])).toEqual([
      [1, false],
      [2, true],
    ]);
    project.setTrackVolume(track.id, 0.5);
    expect((await renderMixRange(workspace, { expectedVersion, range: { startBeat: 0, endBeat: 1 } })).status).toBe("conflict");
  }, 30_000);

  test("editStatus reports applied, needs-sync and superseded", async () => {
    const project = new Project({ bpm: 120 });
    const track = project.addTrack("Bed", "audio");
    const clip = project.addAudioClip(track.id, { sampleRate: RATE, channels: [pattern(RATE, 8)] }, 0);
    const workspace = await workspaceFor(project);
    const receipt = project.applyEdits({
      expectedVersion: project.cells.version.value,
      label: "Name",
      ops: [{ type: "setClipName", clip: { clipId: clip.id }, name: "Bed" }],
    });
    if (receipt.status !== "applied") throw new Error(receipt.reason);
    expect(await workspace.editStatus(receipt.version)).toBe("applied");
    project.addTrack("New", "midi");
    expect(await workspace.editStatus(receipt.version)).toBe("superseded");
    expect(await workspace.editStatus(project.cells.version.value)).toBe("needs-sync");
    await workspace.sync();
    expect(await workspace.editStatus(project.cells.version.value)).toBe("applied");
  }, 20_000);

  test("renaming an audio clip does not change the render", async () => {
    const project = new Project({ bpm: 120 });
    const track = project.addTrack("Bed", "audio");
    const clip = project.addAudioClip(track.id, { sampleRate: RATE, channels: [pattern(RATE, 9)] }, 0);
    const workspace = await workspaceFor(project);
    const before = (await stems(workspace)).get("mix.wav")!;
    project.setClipName(clip.id, "Bed");
    await workspace.flush();
    expect(worstDifference((await stems(workspace)).get("mix.wav")!, before)).toBe(0);
  }, 20_000);

  test("renderMixRange reports a click on a range edge", async () => {
    const tone = (start: number, frames: number) =>
      Float32Array.from({ length: frames }, (_, index) => 0.4 * Math.sin((2 * Math.PI * 220 * (start + index)) / RATE));
    const project = new Project({ bpm: 60 });
    const track = project.addTrack("Tone", "audio");
    project.addAudioClip(track.id, { sampleRate: RATE, channels: [tone(0, RATE)] }, 0);
    project.addAudioClip(track.id, { sampleRate: RATE, channels: [tone(137, RATE)] }, 1);
    project.addAudioClip(track.id, { sampleRate: RATE, channels: [tone(246, RATE)] }, 2);
    const workspace = await workspaceFor(project);
    const result = await renderMixRange(workspace, {
      expectedVersion: project.cells.version.value,
      range: { startBeat: 1, endBeat: 2 },
      seamBeats: [1, 2],
    });
    if (result.status !== "rendered") throw new Error(result.reason);
    expect(result.seams.map(({ frame, hasClick }) => [frame, hasClick])).toEqual([
      [0, true],
      [RATE, true],
    ]);
    expect(result.audio.channels[0].length).toBe(RATE);
  }, 20_000);

  test("seam checks do not change the audio, and a short preroll over MIDI is flagged", async () => {
    const project = new Project({ bpm: 60 });
    const track = project.addTrack("Echo", "audio");
    project.addAudioClip(track.id, { sampleRate: RATE, channels: [new Float32Array(RATE).fill(0.5)] }, 0);
    project.addAudioClip(track.id, { sampleRate: RATE, channels: [new Float32Array(RATE)] }, 2);
    project.setTrackEffects(track.id, [{ id: "delay", type: "delay", enabled: true, wet: 1, delayTime: 0.03, feedback: 0 }]);
    const midi = project.addTrack("Keys", "midi");
    project.addMidiClip(midi.id, { duration: 3, notes: [{ pitch: 60, velocity: 1, start: 0, duration: 3 }] }, 0);
    const workspace = await workspaceFor(project);
    const expectedVersion = project.cells.version.value;
    const options = { expectedVersion, range: { startBeat: 1, endBeat: 1.5 }, prerollSeconds: 0 };
    const plain = await renderMixRange(workspace, options);
    const checked = await renderMixRange(workspace, { ...options, seamBeats: [1.25] });
    if (plain.status !== "rendered" || checked.status !== "rendered") throw new Error("Expected renders.");
    expect(worstDifference(checked.audio.channels[0], plain.audio.channels[0])).toBe(0);
    expect(plain.historyTruncated).toBe(true);
    const full = await renderMixRange(workspace, { expectedVersion, range: options.range });
    if (full.status !== "rendered") throw new Error(full.reason);
    expect(full.historyTruncated).toBe(false);
  }, 20_000);

  test("renderMixRange aborts while a media read hangs", async () => {
    class HangingBlob extends Blob {
      override slice(): Blob {
        const hanging = new Blob([]);
        hanging.arrayBuffer = () => new Promise(() => undefined);
        return hanging;
      }
    }
    const project = new Project({ bpm: 60 });
    const track = project.addTrack("File", "audio");
    project.addAudioMediaClip(track.id, new AudioMedia(new HangingBlob([new Float32Array(RATE).buffer]), RATE, 1, RATE), 0);
    const workspace = await workspaceFor(project);
    const controller = new AbortController();
    const rendering = renderMixRange(workspace, {
      expectedVersion: project.cells.version.value,
      range: { startBeat: 0, endBeat: 1 },
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 100);
    await expect(rendering).rejects.toMatchObject({ name: "AbortError" });
  }, 5_000);

  test("renderMixRange removes its abort listener when it returns a conflict", async () => {
    const project = new Project({ bpm: 60 });
    project.addTrack("Keys", "midi");
    const workspace = await workspaceFor(project);
    const stale = project.cells.version.value;
    project.addTrack("More", "midi");
    const controller = new AbortController();
    const added = vi.spyOn(controller.signal, "addEventListener");
    const removed = vi.spyOn(controller.signal, "removeEventListener");
    const result = await renderMixRange(workspace, { expectedVersion: stale, range: { startBeat: 0, endBeat: 1 }, signal: controller.signal });
    expect(result.status).toBe("conflict");
    expect(added).toHaveBeenCalledTimes(1);
    expect(removed).toHaveBeenCalledTimes(1);
  }, 20_000);

  test("editStatus rejects after dispose", async () => {
    const project = new Project();
    const workspace = await workspaceFor(project);
    const version = project.cells.version.value;
    workspace.dispose();
    await expect(workspace.editStatus(version)).rejects.toThrow(/disposed/);
  });

  test("a versioned save refuses a moved project and aborts its destination", async () => {
    const project = new Project({ bpm: 120 });
    const track = project.addTrack("Bed", "audio");
    project.addAudioClip(track.id, { sampleRate: RATE, channels: [pattern(RATE, 10)] }, 0);
    const workspace = await workspaceFor(project);
    const version = project.cells.version.value;
    expect((await saveWorkspace(workspace, { expectedVersion: version })).length).toBeGreaterThan(0);
    project.setTrackVolume(track.id, 0.5);
    await expect(saveWorkspace(workspace, { expectedVersion: version })).rejects.toThrow(/changed after expectedVersion/);
    let aborted = false;
    let written = 0;
    const destination = new WritableStream<Uint8Array>({ write: () => void written++, abort: () => void (aborted = true) });
    await expect(saveWorkspaceTo(workspace, destination, { expectedVersion: version })).rejects.toThrow(/changed after expectedVersion/);
    expect(aborted).toBe(true);
    expect(written).toBe(0);
  }, 20_000);
});
