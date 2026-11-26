import { afterEach, describe, expect, test } from "vitest";
import { Project, Workspace, sessionFor } from "../src";
import { mcpTools, type McpToolResult } from "../src/mcp";
import { PROJECT_EDIT_TYPES } from "../src/project-edits";

const RATE = 48_000;
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function song() {
  const project = new Project({ bpm: 120 });
  const drums = project.addTrack("Drums", "audio");
  const keys = project.addTrack("Keys", "midi");
  const clip = project.addAudioClip(drums.id, { sampleRate: RATE, channels: [new Float32Array(4 * RATE).fill(0.1)] }, 0);
  project.addMidiClip(keys.id, { duration: 8, notes: [{ pitch: 60, start: 0, duration: 1, velocity: 0.8 }] }, 0);
  const context = new AudioContext({ sampleRate: RATE });
  const workspace = await Workspace.create(context, project);
  cleanups.push(async () => {
    workspace.dispose();
    project.dispose();
    await context.close();
  });
  const tools = mcpTools(workspace);
  const call = (name: string, args: unknown): Promise<McpToolResult> => tools.find((tool) => tool.name === name)!.call(args);
  const edit = async (label: string, ops: unknown[]) =>
    JSON.parse((await call("apply_edits", { expectedVersion: project.cells.version.value, label, ops })).content);
  return { project, workspace, tools, call, edit, drums, keys, clip };
}

describe("apply_edits through mcpTools", () => {
  test("the schema stays small: it names every operation type and the description lists each one with its fields", async () => {
    const { tools } = await song();
    const tool = tools.find((candidate) => candidate.name === "apply_edits")!;
    const ops = (tool.inputSchema.properties as Record<string, { items: { properties: { type: { enum: string[] } }; required: string[] } }>).ops
      .items;
    expect(ops.properties.type.enum).toEqual([...PROJECT_EDIT_TYPES]);
    expect(ops.required).toEqual(["type"]);
    for (const type of PROJECT_EDIT_TYPES) expect(tool.description).toContain(`- ${type}{`);
    // About 6,000 tokens is the budget for the schema and description together.
    expect(JSON.stringify({ d: tool.description, s: tool.inputSchema }).length).toBeLessThan(24_000);
    expect(tool.description).toContain("the left piece keeps the clip's ID and `as` names the right piece");
    expect(tool.description).toContain("tempo changes first in `ops`");
  });

  test("the executor still rejects an unknown field and names the allowed ones", async () => {
    const { edit, drums } = await song();
    const receipt = await edit("Bad", [{ type: "setTrackVolume", trackId: drums.id, value: 0.5 }]);
    expect(receipt).toMatchObject({ status: "rejected", code: "invalid-operation" });
    expect(receipt.reason).toContain("allowed: type, trackId, volume");
  });

  test("split, remove, volume, tempo and a new scene reach playback", async () => {
    const { project, workspace, edit, drums, clip } = await song();
    const split = await edit("Split", [{ type: "splitClip", clip: { clipId: clip.id }, atSeconds: 1, as: "tail" }]);
    expect(split).toMatchObject({ status: "applied", playback: { status: "applied", inPlayback: true, needsSync: false } });
    expect(split.copies.tail).toHaveLength(1);
    expect(project.tracks[0].clips).toHaveLength(2);

    const removed = await edit("Remove", [{ type: "removeClip", clip: { fromCopy: "none" } }]);
    expect(removed).toMatchObject({ status: "rejected", code: "clip-not-found" });
    const removeTail = await edit("Remove", [{ type: "removeClip", clip: { clipId: split.copies.tail[0].id } }]);
    expect(removeTail).toMatchObject({ status: "applied", removed: [split.copies.tail[0].id], playback: { inPlayback: true } });

    const volume = await edit("Level", [{ type: "setTrackVolume", trackId: drums.id, volume: 0.25 }]);
    expect(volume).toMatchObject({ status: "applied", playback: { status: "applied", inPlayback: true } });
    expect(project.tracks[0].volume).toBe(0.25);

    const tempo = await edit("Tempo", [{ type: "setTempoChanges", changes: [{ beat: 0, bpm: 90 }] }]);
    expect(tempo).toMatchObject({ status: "applied", playback: { inPlayback: true } });
    expect(project.bpm).toBe(90);

    const scene = await edit("Scene", [{ type: "addScene", name: "Drop", as: "drop" }]);
    expect(scene).toMatchObject({ status: "applied", createdScenes: [{ as: "drop" }] });
    expect(sessionFor(project).scenes.map(({ name }) => name)).toEqual(["Drop"]);
    expect(workspace.cells.needsSync.value).toBe(false);

    // One Undo step each: the person's Undo reverts the last agent edit.
    expect(project.cells.history.value.undo).toBe("Agent: Scene");
  });

  test("read_project shows what the mixer operations target", async () => {
    const { call, edit, drums } = await song();
    await edit("Mix", [
      { type: "setTrackPan", trackId: drums.id, pan: -0.5 },
      { type: "setMarkers", markers: [{ name: "Drop", atBeat: 4 }] },
      {
        type: "setTrackEffects",
        trackId: drums.id,
        effects: [{ id: "f", type: "filter", enabled: true, wet: 1, mode: "lowpass", frequency: 800, q: 1 }],
      },
    ]);
    const { decode } = await import("@toon-format/toon");
    const view = decode((await call("read_project", {})).content) as Record<string, any>;
    expect(view.tracks[0]).toMatchObject({ id: drums.id, volume: 1, muted: false, solo: false, pan: -0.5, output: "master" });
    expect(view.trackEffects[0]).toMatchObject({ trackId: drums.id });
    expect(view.markers[0]).toMatchObject({ name: "Drop", atBeat: 4, atSeconds: 2 });
    expect(view.masterVolume).toBe(1);
  });

  test("adding or removing a track waits for sync until the topology matches the running one again", async () => {
    const { project, workspace, edit, keys } = await song();
    const added = await edit("Add track", [{ type: "addTrack", name: "Pad", kind: "midi", as: "pad" }]);
    expect(added).toMatchObject({ status: "applied", playback: { status: "needs-sync", inPlayback: false, needsSync: true } });
    // Taking the new track away again restores the running topology, so playback has it.
    const undone = await edit("Remove track", [{ type: "removeTrack", trackId: added.createdTracks[0].id }]);
    expect(undone).toMatchObject({ status: "applied", playback: { status: "applied", inPlayback: true, needsSync: false } });
    const removed = await edit("Remove Keys", [{ type: "removeTrack", trackId: keys.id }]);
    expect(removed).toMatchObject({ status: "applied", playback: { status: "needs-sync", needsSync: true } });
    expect(project.tracks).toHaveLength(1);
    await workspace.sync();
    expect(workspace.cells.needsSync.value).toBe(false);
  });
});

describe("read_project rows go back into the replace ops", () => {
  test("the receipt names changed tracks, scenes and song settings", async () => {
    const { project, edit, drums } = await song();
    const receipt = await edit("Song", [
      { type: "setTrackPan", trackId: drums.id, pan: 0.3 },
      { type: "setTempoChanges", changes: [{ beat: 8, bpm: 90 }] },
      { type: "setTitle", title: "Demo" },
      { type: "addScene", name: "A", as: "a" },
    ]);
    expect(receipt).toMatchObject({
      status: "applied",
      changedTracks: [drums.id],
      removedTracks: [],
      changedScenes: [],
      removedScenes: [],
      song: ["tempo", "title"],
    });
    const removed = await edit("Scene", [{ type: "removeScene", sceneId: sessionFor(project).scenes[0].id }]);
    expect(removed).toMatchObject({ removedScenes: [receipt.createdScenes[0].id], changedTracks: [], song: [] });
  });

  /** Every whole-list op, built from the rows read_project shows, sent back unchanged. */
  async function roundTrip() {
    const { project, call, drums, keys } = await song();
    const bus = project.addTrack("Reverb", "bus", { busRole: "effect" });
    project.setTempoChanges([
      { beat: 0, bpm: 97 },
      { beat: 6, bpm: 133 },
    ]);
    project.setTimeSignatureChanges([{ beat: 4, numerator: 3, denominator: 4 }]);
    project.setMarkers([
      { time: project.tempoMap.beatToSeconds(5.5), name: "Verse" },
      { time: project.tempoMap.beatToSeconds(9.25), name: "Chorus" },
    ]);
    project.setVolumeAutomation(drums.id, [
      { time: 0.3, value: 0.5, shape: "linear" },
      { time: project.tempoMap.beatToSeconds(7.3), value: 1.25, shape: "hold" },
    ]);
    project.setTrackEffects(drums.id, [{ id: "f", type: "filter", enabled: true, wet: 0.5, mode: "lowpass", frequency: 800, q: 1.3 }]);
    project.setTrackRouting(drums.id, { outputBusId: bus.id, sends: [{ busId: bus.id, gain: 0.3 }] });
    project.setTrackRouting(keys.id, { outputBusId: null, sends: [{ busId: bus.id, gain: 0.45 }] });
    const clip = project.tracks[0].clips[0];
    project.setAudioClipGainAutomation(clip.id, [
      { time: 0.1, value: 0.2, shape: "linear" },
      { time: 1.7, value: 1.5, shape: "hold" },
    ]);
    return { project, call, drums, keys, clip };
  }

  test("setTempoChanges, setTimeSignatureChanges, setMarkers, setVolumeAutomation, setAudioClipGainAutomation, setTrackEffects and setTrackRouting accept them as they are", async () => {
    const { project, call, clip } = await roundTrip();
    const { decode } = await import("@toon-format/toon");
    const view = decode((await call("read_project", {})).content) as Record<string, any>;
    const rows: unknown[] = [
      { type: "setTempoChanges", changes: view.tempoChanges },
      { type: "setTimeSignatureChanges", changes: view.signatureChanges },
      { type: "setMarkers", markers: view.markers },
      ...view.volumeAutomation.map((row: any) => ({ type: "setVolumeAutomation", trackId: row.trackId, points: row.points })),
      ...view.clipGainAutomation.map((row: any) => ({ type: "setAudioClipGainAutomation", clip: { clipId: row.clipId }, points: row.points })),
      ...view.trackEffects.map((row: any) => ({ type: "setTrackEffects", trackId: row.trackId, effects: row.effects })),
      ...view.routing.map((row: any) => ({ type: "setTrackRouting", trackId: row.trackId, routing: row.routing })),
    ];
    expect(view.markers[0]).toEqual({ name: "Verse", atBeat: expect.any(Number), atSeconds: expect.any(Number) });
    expect(view.clipGainAutomation[0].clipId).toBe(clip.id);
    expect(view.routing).toHaveLength(2);
    const types = new Set(rows.map((row) => (row as { type: string }).type));
    expect([...types].sort()).toEqual(
      [
        "setAudioClipGainAutomation",
        "setMarkers",
        "setTempoChanges",
        "setTimeSignatureChanges",
        "setTrackEffects",
        "setTrackRouting",
        "setVolumeAutomation",
      ].sort(),
    );
    const before = JSON.stringify({
      tempo: project.tempoMap.changes,
      meter: project.meterMap.changes,
      markers: project.markers,
      tracks: project.tracks.map((track) => [track.volumeAutomation, track.effects, track.routing]),
      gain: project.tracks[0].clips[0].kind === "audio" ? (project.tracks[0].clips[0] as { gainAutomation?: unknown }).gainAutomation : null,
    });
    for (const op of rows) {
      const version = project.cells.version.value;
      const receipt = JSON.parse((await call("apply_edits", { expectedVersion: version, label: "Back", ops: [op] })).content);
      expect(receipt, JSON.stringify(op)).toMatchObject({ status: "noop", version });
    }
    // All of them in one request, too.
    const all = JSON.parse((await call("apply_edits", { expectedVersion: project.cells.version.value, label: "Back", ops: rows })).content);
    expect(all.status).toBe("noop");
    expect(
      JSON.stringify({
        tempo: project.tempoMap.changes,
        meter: project.meterMap.changes,
        markers: project.markers,
        tracks: project.tracks.map((track) => [track.volumeAutomation, track.effects, track.routing]),
        gain: (project.tracks[0].clips[0] as { gainAutomation?: unknown }).gainAutomation,
      }),
    ).toBe(before);
  });

  test("a curve of more than 32 points is a count with its first and last position, and read_automation returns the points as rows", async () => {
    const { project, call, drums, clip } = await song();
    const { decode } = await import("@toon-format/toon");
    project.setVolumeAutomation(
      drums.id,
      Array.from({ length: 500 }, (_, index) => ({ time: index / 4, value: 0.5 + (index % 5) / 10, shape: "linear" as const })),
    );
    project.setAudioClipGainAutomation(
      clip.id,
      Array.from({ length: 33 }, (_, index) => ({ time: index / 10, value: 0.5 + (index % 3) / 10, shape: "hold" as const })),
    );
    const view = decode((await call("read_project", {})).content) as Record<string, any>;
    expect(view.volumeAutomation).toEqual([
      { trackId: drums.id, count: 500, first: { atBeat: 0, atSeconds: 0 }, last: { atBeat: 249.5, atSeconds: 124.75 } },
    ]);
    expect(view.clipGainAutomation).toEqual([{ clipId: clip.id, count: 33, first: { atSourceSeconds: 0 }, last: { atSourceSeconds: 3.2 } }]);

    const track = await call("read_automation", { trackId: drums.id });
    expect(track.isError).toBeUndefined();
    const all = decode(track.content) as Record<string, any>;
    expect(all).toMatchObject({ trackId: drums.id, total: 500, count: 500 });
    expect(all.points[3]).toEqual({ atBeat: 1.5, atSeconds: 0.75, value: 0.8, shape: "linear" });
    // The rows go straight back into the op.
    const sent = JSON.parse(
      (
        await call("apply_edits", {
          expectedVersion: project.cells.version.value,
          label: "Back",
          ops: [{ type: "setVolumeAutomation", trackId: drums.id, points: all.points }],
        })
      ).content,
    );
    expect(sent.status).toBe("noop");
    const part = decode((await call("read_automation", { trackId: drums.id, range: { startBeat: 2, endBeat: 4 } })).content) as Record<string, any>;
    expect([part.total, part.count, part.points.map((point: any) => point.atSeconds)]).toEqual([500, 4, [1, 1.25, 1.5, 1.75]]);

    const gain = decode((await call("read_automation", { clipId: clip.id, range: { startSeconds: 0.5, endSeconds: 0.8 } })).content) as Record<
      string,
      any
    >;
    expect(gain).toMatchObject({ clipId: clip.id, total: 33, count: 3 });
    expect(gain.points[0]).toEqual({ atSourceSeconds: 0.5, value: 0.7, shape: "hold" });

    expect((await call("read_automation", {})).isError).toBe(true);
    expect((await call("read_automation", { trackId: drums.id, clipId: clip.id })).isError).toBe(true);
    expect((await call("read_automation", { trackId: "nope" })).isError).toBe(true);
    expect((await call("read_automation", { clipId: "nope" })).isError).toBe(true);
    expect((await call("read_automation", { trackId: drums.id, extra: 1 })).content).toContain("allowed: trackId, clipId, range");
  });
});
