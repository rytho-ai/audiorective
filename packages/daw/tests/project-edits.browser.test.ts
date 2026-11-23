import { unzipSync } from "fflate";
import { afterEach, describe, expect, test } from "vitest";
import { Project, Workspace, exportAudioFallbackTo, openWorkspace, saveWorkspace } from "../src";

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
    expect(workspace.clock.state.value).toBe("playing");
    expect(workspace.cells.needsSync.value).toBe(false);
    expect(workspace.cells.error.value).toBeNull();
    workspace.stop();
  }, 20_000);
});
