import { ManualTickSource } from "@audiorective/clock";
import type { SoundFactory } from "@audiorective/core";
import { afterEach, describe, expect, test } from "vitest";
import { Project, Workspace, openWorkspace, saveDawProjectTo, sessionFor, type WorkspaceOptions } from "../src";

const RATE = 48_000;
const QUANTUM = 128;
const worklet = "/@fs" + new URL("../../host/dist/webclap-worklet.js", import.meta.url).pathname.replace(/^\/@fs/, "");
const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A 1 kHz click 20 ms long, made with plain Web Audio. */
const click: SoundFactory = (context) => {
  const osc = new OscillatorNode(context, { frequency: 1000 });
  const gain = new GainNode(context, { gain: 0.5 });
  osc.connect(gain);
  return { output: gain, sources: [osc], duration: 0.02 };
};

/** Offline render with actions at given seconds; the transport ticks every 25 ms as live. */
async function render(
  project: Project,
  seconds: number,
  actions: Array<{ at: number; run: (workspace: Workspace) => void }>,
  options: WorkspaceOptions = {},
  /** Opens the Workspace some other way, for example from a saved file; default `Workspace.create` over `project`. */
  open?: (context: AudioContext, options: WorkspaceOptions) => Promise<Workspace>,
) {
  const frames = Math.round(seconds * RATE);
  const context = new OfflineAudioContext(2, frames, RATE);
  const ticks = new ManualTickSource();
  const all = { destination: context.destination, tickSource: ticks, workletUrl: worklet, ...options };
  const workspace = open
    ? await open(context as unknown as AudioContext, all)
    : await Workspace.create(context as unknown as AudioContext, project, all);
  expect(workspace.cells.warnings.value).toEqual([]);
  const pending = [...actions].sort((a, b) => a.at - b.at);
  while (pending[0]?.at === 0) pending.shift()!.run(workspace);
  await workspace.play();
  ticks.tick();
  await workspace.renderSettled();
  let index = 1;
  let previous = 0;
  const next = () => {
    previous = Math.max(Math.ceil((index++ * 0.025 * RATE) / QUANTUM) * QUANTUM, previous + QUANTUM);
    return previous < frames ? previous : undefined;
  };
  let stop = next();
  let suspended = stop === undefined ? undefined : context.suspend((stop - QUANTUM / 2) / RATE);
  const rendering = context.startRendering();
  while (stop !== undefined && suspended) {
    await suspended;
    while (pending.length && pending[0].at <= stop / RATE) pending.shift()!.run(workspace);
    ticks.tick();
    await workspace.renderSettled();
    stop = next();
    suspended = stop === undefined ? undefined : context.suspend((stop - QUANTUM / 2) / RATE);
    await context.resume();
  }
  const buffer = await rendering;
  workspace.dispose();
  return buffer.getChannelData(0);
}

const onsets = (x: Float32Array, threshold = 0.05) => {
  const found: number[] = [];
  let last = -Infinity;
  for (let i = 0; i < x.length; i++)
    if (Math.abs(x[i]) > threshold) {
      if (i - last > RATE * 0.05) found.push(i / RATE);
      last = i;
    }
  return found;
};

const rms = (x: Float32Array, from: number, to: number) => {
  let energy = 0;
  for (let i = Math.round(from * RATE); i < Math.round(to * RATE); i++) energy += x[i] * x[i];
  return Math.sqrt(energy / Math.max(1, Math.round((to - from) * RATE)));
};
const tone = (() => {
  const buffer = new AudioBuffer({ length: RATE * 12, sampleRate: RATE });
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = 0.3 * Math.sin((2 * Math.PI * 220 * i) / RATE);
  return buffer;
})();

const rounded = (times: number[]) => times.map((t) => Math.round(t * 1000) / 1000);

/** 120 BPM: a beat is 0.5 s, a bar 2 s. A drum track (click) and a bass track (a held tone); the Arrangement is empty. */
function song() {
  const project = new Project({ bpm: 120 });
  const drums = project.addTrack("Drums", "midi");
  const bass = project.addTrack("Bass", "midi");
  const session = sessionFor(project);
  const [intro, drop] = [session.addScene({ name: "Intro" }), session.addScene({ name: "Drop" })];
  const hit = (start: number) => ({ duration: 4, notes: [{ pitch: 60, velocity: 1, start, duration: 0.25 }] });
  session.setMidiClip({ trackId: drums.id, sceneId: intro.id }, hit(0));
  session.setMidiClip({ trackId: drums.id, sceneId: drop.id }, hit(2));
  session.setMidiClip({ trackId: bass.id, sceneId: intro.id }, { duration: 4, notes: [{ pitch: 64, velocity: 1, start: 0, duration: 4 }] });
  cleanups.push(() => project.dispose());
  return { project, session, drums, bass, intro, drop, hit, instruments: { [drums.id]: { sound: click }, [bass.id]: { sound: tone, rootNote: 64 } } };
}

describe("Session scenes in the Workspace", () => {
  test("launching a scene with an empty slot stops that track on the scene's boundary", async () => {
    const { project, instruments } = song();
    const x = await render(
      project,
      8,
      [
        { at: 0.2, run: (w) => w.cells.session.value.launchScene(0) },
        { at: 2.5, run: (w) => w.cells.session.value.launchScene(1) },
      ],
      { instruments },
    );
    // The bass holds a note from the bar at 2 s and is stopped at the bar at 4 s, where the Drop has no bass clip.
    expect(rms(x, 2.2, 3.9)).toBeGreaterThan(0.05);
    expect(rms(x, 4.3, 4.9)).toBeLessThan(0.001);
    expect(rms(x, 5.2, 6.9)).toBeLessThan(0.001);
    // The drums play the Intro's hit on beat 1 at 2 s, then the Drop's hit on beat 3 of each bar from 4 s: 5 s, 7 s.
    expect(rounded(onsets(x, 0.2).filter((t) => t > 4.2))).toEqual([5, 7]);
  }, 30_000);

  test("slot clips play while the Arrangement is empty, and loop on the bar", async () => {
    const { project, instruments } = song();
    const x = await render(project, 7, [{ at: 0.2, run: (w) => w.cells.session.value.launchScene(0) }], {
      instruments: { [project.tracks[0].id]: instruments[project.tracks[0].id] },
    });
    expect(project.tracks.flatMap((track) => track.clips)).toEqual([]);
    expect(rounded(onsets(x))).toEqual([2, 4, 6]);
  }, 30_000);

  test("the Arrangement and the Session are independent: edits to one leave the other alone", async () => {
    const { project, session, drums, intro, hit } = song();
    project.addMidiClip(drums.id, hit(2), 0);
    const x = await render(
      project,
      8,
      [
        { at: 0.2, run: (w) => w.cells.session.value.tracks[drums.id]!.clips[0]!.launch() },
        {
          at: 2.5,
          run: () => {
            // Replacing the slot clip changes the Session, not the timeline; the new clip replaces the old one at once.
            session.setMidiClip({ trackId: drums.id, sceneId: intro.id }, hit(1));
          },
        },
        { at: 3, run: (w) => w.cells.session.value.tracks[drums.id]!.clips[0]!.launch() },
      ],
      { instruments: { [drums.id]: { sound: click } }, arrangement: true },
    );
    expect(project.tracks[0].clips).toHaveLength(1);
    expect(project.tracks[0].clips[0].time).toBe(0);
    // The Arrangement's hit on beat 3 (1 s) sounds before the first launch takes the track at 2 s; the Intro's hit on beat 1 sounds at 2 s; the edited clip, launched at 3 s, starts at the
    // bar at 4 s with its hit on beat 2: 4.5, 6.5.
    expect(rounded(onsets(x))).toEqual([1, 2, 4.5, 6.5]);
  }, 30_000);

  test("adding, duplicating and removing scenes leaves playing Session clips playing", async () => {
    const { project, session, intro, drop, instruments } = song();
    const x = await render(
      project,
      9,
      [
        { at: 0.2, run: (w) => w.cells.session.value.launchScene(1) },
        { at: 2.5, run: () => void session.addScene({ afterSceneId: intro.id }) },
        { at: 3.5, run: () => void session.duplicateScene(drop.id) },
        { at: 5.5, run: () => session.removeScene(intro.id) },
      ],
      { instruments },
    );
    // The Drop's hit on beat 3 of each bar from 2 s: 3, 5, 7 and 9 s, whatever happens to the scenes around it.
    expect(rounded(onsets(x, 0.2))).toEqual([3, 5, 7]);
  }, 30_000);

  test("moving a scene leaves playing and queued Session clips alone and keeps the launcher", async () => {
    const { project, session, drums, intro, drop } = song();
    let launcher: Workspace["session"]["value"] | undefined;
    let playing: unknown;
    const x = await render(
      project,
      9,
      [
        { at: 0.2, run: (w) => w.cells.session.value.launchScene(1) },
        {
          at: 2.5,
          run: (w) => {
            launcher = w.cells.session.value;
            playing = w.sessionClip(drums.id, session.clipAt({ trackId: drums.id, sceneId: drop.id })!.id);
            // The Intro waits for the bar at 4 s while the Drop plays.
            w.cells.session.value.launchScene(0);
          },
        },
        { at: 2.6, run: () => session.moveScene(intro.id, 1) },
        {
          at: 3.1,
          run: (w) => {
            expect(w.cells.session.value).toBe(launcher);
            expect(w.cells.session.value.scenes.map((scene) => scene.name)).toEqual(["Drop", "Intro"]);
            expect(w.sessionClip(drums.id, session.clipAt({ trackId: drums.id, sceneId: drop.id })!.id)).toBe(playing);
            expect((playing as { index: number; playing: { value: boolean } }).index).toBe(0);
            expect((playing as { playing: { value: boolean } }).playing.value).toBe(true);
          },
        },
      ],
      { instruments: { [drums.id]: { sound: click } } },
    );
    // The Drop's hit on beat 3 of the bar from 2 s (3 s); the queued Intro starts at 4 s on its beat 1 and loops: 4, 6, 8.
    expect(rounded(onsets(x, 0.2))).toEqual([3, 4, 6, 8]);
  }, 30_000);

  test("sessionClip finds the clip by id and follows scene order", async () => {
    const { project, session, drums, intro, drop } = song();
    const context = new OfflineAudioContext(2, RATE, RATE);
    const workspace = await Workspace.create(context as unknown as AudioContext, project, {
      workletUrl: worklet,
      instruments: { [drums.id]: { sound: click } },
    });
    cleanups.push(() => workspace.dispose());
    const second = session.clipAt({ trackId: drums.id, sceneId: drop.id })!;
    expect(workspace.sessionClip(drums.id, second.id)).toBe(workspace.cells.session.value.tracks[drums.id]!.clips[1]);
    expect(workspace.cells.session.value.scenes.map((scene) => scene.name)).toEqual(["Intro", "Drop"]);
    // Scenes change in place: the launcher stays, names follow, and the clip keeps its launcher clip.
    const before = workspace.cells.session.value;
    const keptClip = workspace.sessionClip(drums.id, second.id);
    session.addScene({ afterSceneId: intro.id, name: "Verse" });
    session.renameScene(drop.id, "Chorus");
    await workspace.flush();
    expect(workspace.cells.session.value).toBe(before);
    expect(workspace.cells.session.value.scenes.map((scene) => scene.name)).toEqual(["Intro", "Verse", "Chorus"]);
    expect(workspace.sessionClip(drums.id, second.id)).toBe(keptClip);
    expect(keptClip!.index).toBe(2);
    session.removeScene(intro.id);
    await workspace.flush();
    expect(workspace.cells.session.value.scenes.map((scene) => scene.name)).toEqual(["Verse", "Chorus"]);
    expect(workspace.sessionClip(drums.id, second.id)).toBe(keptClip);
    expect(keptClip!.index).toBe(1);
  }, 30_000);
});

describe("Session slots of a reopened file", () => {
  async function archive(project: Project): Promise<Blob> {
    const chunks: BlobPart[] = [];
    await saveDawProjectTo(project, new WritableStream<Uint8Array>({ write: (chunk) => void chunks.push(chunk.slice()) }));
    return new Blob(chunks);
  }
  const until = async (ready: () => boolean) => {
    for (let wait = 0; wait < 200 && !ready(); wait++) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(ready()).toBe(true);
  };

  test("a scene whose audio slots are file-backed launches once the audio is read", async () => {
    const project = new Project({ bpm: 120 });
    const track = project.addTrack("Take", "audio");
    const session = sessionFor(project);
    const [plain, looped] = [session.addScene({ name: "Plain" }), session.addScene({ name: "Loop" })];
    // 4 s: 0.5 for the first second, then 0.2.
    const channel = new Float32Array(4 * RATE).fill(0.2);
    channel.fill(0.5, 0, RATE);
    session.setAudioClip({ trackId: track.id, sceneId: plain.id }, { sampleRate: RATE, channels: [channel] });
    const loop = session.setAudioClip({ trackId: track.id, sceneId: looped.id }, { sampleRate: RATE, channels: [channel] });
    project.setClipLoop(loop.id, { startSeconds: 1, endSeconds: 2 });
    cleanups.push(() => project.dispose());
    const blob = await archive(project);
    const reopened: Workspace[] = [];
    const x = await render(project, 6, [{ at: 0.2, run: (w) => w.cells.session.value.launchScene(0) }], {}, async (context, options) => {
      const workspace = await openWorkspace(context, blob, options);
      reopened.push(workspace);
      const grid = sessionFor(workspace.project);
      const slots = grid.scenes.map((scene) => grid.clipAt({ trackId: track.id, sceneId: scene.id })!);
      expect(slots.every((clip) => clip.kind === "audio" && !!clip.media)).toBe(true);
      expect(workspace.sessionClip(track.id, slots[0].id)).toBeNull(); // not read yet
      await until(() => slots.every((clip) => workspace.sessionClip(track.id, clip.id) !== null));
      expect(workspace.cells.session.value.tracks[track.id]!.clips.map((clip) => clip !== null)).toEqual([true, true]);
      return workspace;
    });
    // Launched on the bar at 2 s: the plain clip plays 0.5 for a second, then 0.2 and loops from its start.
    const level = (at: number) => x[Math.round(at * RATE)] * Math.SQRT2; // panned centre
    expect(Math.abs(level(2.5) - 0.5)).toBeLessThan(0.03);
    expect(Math.abs(level(3.5) - 0.2)).toBeLessThan(0.03);
    expect(reopened[0].project.cells.version.value).toBeTruthy();
  }, 30_000);
});
