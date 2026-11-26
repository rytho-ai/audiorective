import { captureDeviceState } from "../src/model";
import { AutomationCurve } from "@audiorective/core/automation";
import { describe, expect, it } from "vitest";
import { MidiClip, Project, type ProjectClip, type ProjectEditOperation, type ProjectVersion } from "../src/project";
import { openDawProject, saveDawProject } from "../src/dawproject";

const SAMPLE_RATE = 100;
const pcm = (seconds: number, value = 0.5) => ({
  sampleRate: SAMPLE_RATE,
  channels: [new Float32Array(Math.round(seconds * SAMPLE_RATE)).fill(value)],
});

/** Beats 8-16 are the chorus. The tempo changes inside it and again right after it. */
function song() {
  const project = new Project({ bpm: 120 });
  project.setTempoChanges([
    { beat: 8, bpm: 60 },
    { beat: 12, bpm: 120 },
    { beat: 16, bpm: 90 },
  ]);
  project.setMarkers([
    { time: 0, name: "Intro" },
    { time: 4, name: "Chorus" },
    { time: 10, name: "Outro" },
  ]);
  const drums = project.addTrack("Drums", "audio");
  const vocals = project.addTrack("Vocals", "audio");
  const keys = project.addTrack("Keys", "midi");
  const drumChorus = project.addAudioClip(drums.id, pcm(6), 4);
  const drumOutro = project.addAudioClip(drums.id, pcm(2), 10);
  const vocal = project.addAudioClip(vocals.id, pcm(4), 4);
  const keyChorus = project.addMidiClip(keys.id, { duration: 8, notes: [{ id: "n1", pitch: 60, velocity: 0.5, start: 1, duration: 1 }] }, 8);
  const keyOutro = project.addMidiClip(keys.id, { duration: 4, notes: [{ id: "n2", pitch: 62, velocity: 0.5, start: 0, duration: 1 }] }, 16);
  return { project, drums, vocals, keys, drumChorus, drumOutro, vocal, keyChorus, keyOutro };
}

const copyChorus: ProjectEditOperation = {
  type: "copyRange",
  range: { startBeat: 8, endBeat: 16 },
  atBeat: 16,
  placement: "insert",
  as: "copy",
};

const version = (project: Project): ProjectVersion => project.cells.version.value;
const clipById = (project: Project, id: string): ProjectClip | undefined =>
  project.tracks.flatMap((track) => track.clips).find((clip) => clip.id === id);
const fingerprint = (project: Project) =>
  JSON.stringify({
    tempo: project.tempoMap.changes,
    markers: project.markers,
    tracks: project.tracks.map((track) => ({
      id: track.id,
      automation: track.volumeAutomation,
      clips: track.clips.map((clip) => ({
        id: clip.id,
        time: clip.time,
        duration: clip.duration,
        notes: clip instanceof MidiClip ? clip.midi.notes.value : undefined,
      })),
    })),
  });

describe("project.applyEdits", () => {
  it("inserts a copied section, delays the copied vocal by one beat and keeps later material on its beat", () => {
    const { project, vocals, keys, drumChorus, drumOutro, vocal, keyChorus, keyOutro } = song();
    const receipt = project.applyEdits({
      expectedVersion: version(project),
      label: "Repeat chorus",
      ops: [copyChorus, { type: "moveClip", clip: { fromCopy: "copy", trackId: vocals.id }, position: { byBeats: 1 } }],
    });
    if (receipt.status !== "applied") throw new Error(receipt.reason);

    expect(project.tempoMap.changes).toEqual([
      { beat: 8, bpm: 60 },
      { beat: 12, bpm: 120 },
      { beat: 16, bpm: 60 },
      { beat: 20, bpm: 120 },
      { beat: 24, bpm: 90 },
    ]);
    expect(project.markers).toEqual([
      { time: 0, name: "Intro" },
      { time: 4, name: "Chorus" },
      { time: 10, name: "Chorus" },
      { time: 16, name: "Outro" },
    ]);

    expect(clipById(project, drumChorus.id)?.time).toBe(4);
    expect(clipById(project, vocal.id)?.time).toBe(4);
    expect(clipById(project, keyChorus.id)?.time).toBe(8);
    expect(clipById(project, drumOutro.id)?.time).toBeCloseTo(16, 9);
    expect(clipById(project, keyOutro.id)?.time).toBe(24);

    const copies = receipt.copies.copy;
    expect(copies).toHaveLength(3);
    const copyOf = (id: string) => clipById(project, copies.find((copy) => copy.from === id)!.id)!;
    expect(copyOf(drumChorus.id).time).toBeCloseTo(10, 9);
    expect(copyOf(vocal.id).time).toBeCloseTo(11, 9);
    expect(copyOf(keyChorus.id).time).toBe(16);
    expect(project.tracks.find(({ id }) => id === keys.id)!.clips).toHaveLength(3);
    expect(receipt.created.toSorted()).toEqual(copies.map((copy) => copy.id).toSorted());
    expect(receipt.changed.toSorted()).toEqual([drumOutro.id, keyOutro.id].toSorted());
    expect(receipt.removed).toEqual([]);
    expect(receipt.version).toBe(version(project));
  });

  it("splits a clip crossing the insert point and keeps both sides of its audio", () => {
    const project = new Project({ bpm: 60 });
    const track = project.addTrack("Bed", "audio");
    const channel = Float32Array.from({ length: 400 }, (_, index) => index);
    const bed = project.addAudioClip(track.id, { sampleRate: SAMPLE_RATE, channels: [channel] }, 0);
    const receipt = project.applyEdits({
      expectedVersion: version(project),
      label: "Repeat",
      ops: [{ type: "copyRange", range: { startBeat: 1, endBeat: 2 }, atBeat: 2, placement: "insert", as: "copy" }],
    });
    if (receipt.status !== "applied") throw new Error(receipt.reason);
    const clips = project.tracks[0].clips.map((clip) => {
      if (clip.kind !== "audio" || clip.media) throw new Error("Expected PCM.");
      return { time: clip.time, first: clip.channels[0][0], frames: clip.channels[0].length };
    });
    expect(clips).toEqual([
      { time: 0, first: 0, frames: 200 },
      { time: 2, first: 100, frames: 100 },
      { time: 3, first: 200, frames: 200 },
    ]);
    expect(bed.id).toBe(project.tracks[0].clips[0].id);
  });

  it("copies volume automation with the section and shifts the rest", () => {
    const project = new Project({ bpm: 60 });
    const track = project.addTrack("Bed", "audio");
    project.addAudioClip(track.id, pcm(1), 1);
    project.setVolumeAutomation(track.id, [
      { time: 0, value: 1, shape: "hold" },
      { time: 1, value: 0.25, shape: "hold" },
      { time: 2, value: 0.75, shape: "hold" },
    ]);
    project.applyEdits({
      expectedVersion: version(project),
      label: "Repeat",
      ops: [{ type: "copyRange", range: { startBeat: 1, endBeat: 2 }, atBeat: 2, placement: "insert", as: "copy" }],
    });
    expect(project.tracks[0].volumeAutomation.map(({ time, value }) => [time, value])).toEqual([
      [0, 1],
      [1, 0.25],
      [2, 0.25],
      [3, 0.75],
    ]);
  });

  it("publishes nothing when a later step fails", () => {
    const { project, keyChorus } = song();
    const before = fingerprint(project);
    const expectedVersion = version(project);
    const revision = project.cells.revision.value;
    const receipt = project.applyEdits({
      expectedVersion,
      label: "Bad",
      ops: [
        copyChorus,
        { type: "editNotes", clip: { clipId: keyChorus.id }, notes: [{ id: "n1", velocity: 0.9 }] },
        { type: "moveClip", clip: { clipId: "missing" }, position: { byBeats: 1 } },
      ],
    });
    expect(receipt).toMatchObject({ status: "rejected", opIndex: 2, code: "clip-not-found", version: expectedVersion });
    expect(fingerprint(project)).toBe(before);
    expect(version(project)).toBe(expectedVersion);
    expect(project.cells.revision.value).toBe(revision);
    expect(project.cells.history.value).toEqual({});
    const fresh = project.addTrack("After", "audio");
    expect(fresh.id).toBe("track9");
  });

  it("rejects a placement that lands on another clip", () => {
    const { project, drumChorus } = song();
    const before = fingerprint(project);
    const receipt = project.applyEdits({
      expectedVersion: version(project),
      label: "Overlap",
      ops: [{ type: "moveClip", clip: { clipId: drumChorus.id }, position: { byBeats: 1 } }],
    });
    expect(receipt).toMatchObject({ status: "rejected", opIndex: 0, code: "overlap" });
    expect(fingerprint(project)).toBe(before);
  });

  it("moves adjacent clips together in any order and judges overlap on the final arrangement", () => {
    for (const order of [
      [0, 1],
      [1, 0],
    ]) {
      const project = new Project({ bpm: 60 });
      const track = project.addTrack("A", "audio");
      const clips = [project.addAudioClip(track.id, pcm(2), 0), project.addAudioClip(track.id, pcm(2), 2)];
      const receipt = project.applyEdits({
        expectedVersion: version(project),
        label: "Move",
        ops: order.map((index) => ({ type: "moveClip", clip: { clipId: clips[index].id }, position: { byBeats: 1 } })),
      });
      expect(receipt.status).toBe("applied");
      expect(clips.map(({ id }) => clipById(project, id)?.time)).toEqual([1, 3]);
    }
    const project = new Project({ bpm: 60 });
    const track = project.addTrack("A", "audio");
    const first = project.addAudioClip(track.id, pcm(2), 0);
    const second = project.addAudioClip(track.id, pcm(2), 2);
    const third = project.addAudioClip(track.id, pcm(1), 4);
    const before = fingerprint(project);
    const receipt = project.applyEdits({
      expectedVersion: version(project),
      label: "Blocked",
      ops: [
        { type: "moveClip", clip: { clipId: first.id }, position: { byBeats: 1 } },
        { type: "moveClip", clip: { clipId: second.id }, position: { byBeats: 1 } },
      ],
    });
    expect(receipt).toMatchObject({ status: "rejected", code: "overlap", opIndex: 1 });
    expect(fingerprint(project)).toBe(before);
    expect(third.time).toBe(4);
  });

  it("rejects both position forms and an ambiguous copied clip", () => {
    const { project, drumOutro } = song();
    const both = project.applyEdits({
      expectedVersion: version(project),
      label: "Both",
      ops: [{ type: "moveClip", clip: { clipId: drumOutro.id }, position: { atBeat: 40, byBeats: 1 } } as unknown as ProjectEditOperation],
    });
    expect(both).toMatchObject({ status: "rejected", code: "invalid-operation" });
    const ambiguous = project.applyEdits({
      expectedVersion: version(project),
      label: "Ambiguous",
      ops: [copyChorus, { type: "moveClip", clip: { fromCopy: "copy" }, position: { byBeats: 1 } }],
    });
    expect(ambiguous).toMatchObject({ status: "rejected", opIndex: 1, code: "ambiguous-clip" });
  });

  it("edits a note of a clip created earlier in the same request", () => {
    const { project, keys, keyChorus } = song();
    const receipt = project.applyEdits({
      expectedVersion: version(project),
      label: "Accent copy",
      ops: [copyChorus, { type: "editNotes", clip: { fromCopy: "copy", trackId: keys.id }, notes: [{ id: "n1", velocity: 0.9 }] }],
    });
    if (receipt.status !== "applied") throw new Error(receipt.reason);
    const copy = clipById(project, receipt.copies.copy.find(({ from }) => from === keyChorus.id)!.id) as MidiClip;
    expect(copy.midi.notes.value[0].velocity).toBe(0.9);
    expect(keyChorus.midi.notes.value[0].velocity).toBe(0.5);
  });

  it("keeps the same meaning after a JSON round trip", () => {
    const { project, vocals } = song();
    const request = {
      expectedVersion: version(project),
      label: "Repeat chorus",
      ops: [copyChorus, { type: "moveClip", clip: { fromCopy: "copy", trackId: vocals.id }, position: { byBeats: 1 } }],
    };
    expect(project.applyEdits(JSON.parse(JSON.stringify(request)))).toMatchObject({ status: "applied" });
  });

  it("reports a conflict for stale structure or a stale note edit and changes nothing", () => {
    const { project, drums, keyChorus, drumOutro } = song();
    const staleStructure = version(project);
    project.setTrackVolume(drums.id, 0.5);
    const op: ProjectEditOperation = { type: "moveClip", clip: { clipId: drumOutro.id }, position: { byBeats: 1 } };
    expect(project.applyEdits({ expectedVersion: staleStructure, label: "Late", ops: [op] }).status).toBe("conflict");

    const staleNotes = version(project);
    keyChorus.midi.edit((notes) => {
      notes[0].velocity = 0.7;
    });
    expect(version(project)).not.toBe(staleNotes);
    expect(project.applyEdits({ expectedVersion: staleNotes, label: "Late", ops: [op] }).status).toBe("conflict");
    expect(clipById(project, drumOutro.id)?.time).toBe(10);
  });

  it("does not accept a version from another project", () => {
    const first = new Project();
    const second = new Project();
    expect(first.cells.version.value).not.toBe(second.cells.version.value);
    expect(first.applyEdits({ expectedVersion: second.cells.version.value, label: "x", ops: [] }).status).toBe("conflict");
  });
});

describe("project history", () => {
  it("undoes and redoes a whole edit, including note and tempo changes", () => {
    const { project, vocals, keyChorus } = song();
    const before = fingerprint(project);
    const start = version(project);
    const receipt = project.applyEdits({
      expectedVersion: start,
      label: "Repeat chorus",
      ops: [
        copyChorus,
        { type: "moveClip", clip: { fromCopy: "copy", trackId: vocals.id }, position: { byBeats: 1 } },
        { type: "editNotes", clip: { clipId: keyChorus.id }, notes: [{ id: "n1", velocity: 0.9 }] },
      ],
    });
    if (receipt.status !== "applied") throw new Error(receipt.reason);
    const after = fingerprint(project);
    expect(project.cells.history.value).toEqual({ undo: "Repeat chorus" });

    const undone = project.undo({ expectedVersion: receipt.version });
    expect(undone.status).toBe("applied");
    expect(fingerprint(project)).toBe(before);
    expect(version(project)).not.toBe(start);
    expect(version(project)).not.toBe(receipt.version);
    expect(project.cells.history.value).toEqual({ redo: "Repeat chorus" });

    expect(project.redo().status).toBe("applied");
    expect(fingerprint(project)).toBe(after);
    expect(project.undo().status).toBe("applied");
    expect(fingerprint(project)).toBe(before);
  });

  it("refuses to undo over a later edit of the same clip", () => {
    const { project, drumOutro } = song();
    const receipt = project.applyEdits({
      expectedVersion: version(project),
      label: "Move",
      ops: [{ type: "moveClip", clip: { clipId: drumOutro.id }, position: { byBeats: 2 } }],
    });
    if (receipt.status !== "applied") throw new Error(receipt.reason);
    const moved = clipById(project, drumOutro.id)!.time;
    project.moveClip(drumOutro.id, project.tracks[0].id, moved + 1);
    expect(project.undo().status).toBe("conflict");
    expect(clipById(project, drumOutro.id)?.time).toBe(moved + 1);
  });

  it("refuses to undo over a later note edit of the same clip", () => {
    const { project, keyChorus } = song();
    project.applyEdits({
      expectedVersion: version(project),
      label: "Accent",
      ops: [{ type: "editNotes", clip: { clipId: keyChorus.id }, notes: [{ id: "n1", velocity: 0.9 }] }],
    });
    keyChorus.midi.edit((notes) => {
      notes[0].pitch = 72;
    });
    expect(project.undo().status).toBe("conflict");
    expect(keyChorus.midi.notes.value[0]).toMatchObject({ pitch: 72, velocity: 0.9 });
  });

  it("keeps an unrelated later edit when undoing without a version, and refuses with the older version", () => {
    const { project, drums, drumOutro } = song();
    const receipt = project.applyEdits({
      expectedVersion: version(project),
      label: "Move",
      ops: [{ type: "moveClip", clip: { clipId: drumOutro.id }, position: { byBeats: 2 } }],
    });
    if (receipt.status !== "applied") throw new Error(receipt.reason);
    project.setTrackVolume(drums.id, 0.25);
    expect(project.undo({ expectedVersion: receipt.version }).status).toBe("conflict");
    expect(project.undo().status).toBe("applied");
    expect(clipById(project, drumOutro.id)?.time).toBe(10);
    expect(project.tracks.find(({ id }) => id === drums.id)?.volume).toBe(0.25);
  });

  it("brings a split MIDI clip back as a working clip", () => {
    const { project, keyChorus } = song();
    project.edit("Split", () => project.splitClip(keyChorus.id, 4));
    project.undo();
    const restored = clipById(project, keyChorus.id) as MidiClip;
    expect(restored).toBe(keyChorus);
    restored.midi.edit((notes) => {
      notes[0].velocity = 0.8;
    });
    expect(restored.midi.notes.value[0].velocity).toBe(0.8);
  });

  it("drops redo after a new edit and disposes clips no state can reach", () => {
    const { project, keys } = song();
    const clip = project.edit("Add", () => project.addMidiClip(keys.id, { duration: 1, notes: [] }, 40));
    project.undo();
    project.edit("Rename title is out of scope, move instead", () => project.addMidiClip(keys.id, { duration: 1, notes: [] }, 50));
    expect(project.cells.history.value.redo).toBeUndefined();
    expect(() => clip.midi.setNotes([])).toThrow(/disposed/);
  });

  it("limits history to 50 edits", () => {
    const { project, keys } = song();
    for (let index = 0; index < 55; index++)
      project.edit(`Add ${index}`, () => project.addMidiClip(keys.id, { duration: 1, notes: [] }, 100 + index));
    let undone = 0;
    while (project.undo().status === "applied") undone++;
    expect(undone).toBe(50);
  });

  it("does not let a device-state capture invalidate a version or get undone", () => {
    const { project, keys, drumOutro } = song();
    const device = project.addWebClapDevice(keys.id, {
      pluginId: "p",
      name: "Synth",
      vendor: "v",
      version: "1",
      bundleUrl: "synth.zip",
      state: new Uint8Array([1]),
    });
    const expectedVersion = version(project);
    const receipt = project.applyEdits({
      expectedVersion,
      label: "Move",
      ops: [{ type: "moveClip", clip: { clipId: drumOutro.id }, position: { byBeats: 2 } }],
    });
    if (receipt.status !== "applied") throw new Error(receipt.reason);
    captureDeviceState(project, device.id, new Uint8Array([2]));
    expect(version(project)).toBe(receipt.version);
    expect(project.undo({ expectedVersion: receipt.version }).status).toBe("applied");
    expect([...project.tracks.find(({ id }) => id === keys.id)!.devices[0].state]).toEqual([2]);
  });
});

describe("history under review cases", () => {
  const accent = (project: Project, clipId: string, velocity: number) =>
    project.applyEdits({
      expectedVersion: version(project),
      label: `Velocity ${velocity}`,
      ops: [{ type: "editNotes", clip: { clipId }, notes: [{ id: "n1", velocity }] }],
    });

  it("undoes consecutive edits of one MIDI clip", () => {
    const { project, keyChorus } = song();
    accent(project, keyChorus.id, 0.6);
    accent(project, keyChorus.id, 0.7);
    expect(project.undo().status).toBe("applied");
    expect(project.undo().status).toBe("applied");
    expect(keyChorus.midi.notes.value[0].velocity).toBe(0.5);
    expect(project.redo().status).toBe("applied");
    expect(project.redo().status).toBe("applied");
    expect(keyChorus.midi.notes.value[0].velocity).toBe(0.7);
  });

  it("does not touch notes or their listeners for a rejected request, and earlier undo still works", () => {
    const { project, keyChorus } = song();
    accent(project, keyChorus.id, 0.6);
    const notes = keyChorus.midi.notes.value;
    let fired = 0;
    const stop = keyChorus.midi.revision.subscribe(() => fired++);
    const receipt = project.applyEdits({
      expectedVersion: version(project),
      label: "Bad",
      ops: [
        { type: "editNotes", clip: { clipId: keyChorus.id }, notes: [{ id: "n1", velocity: 0.9 }] },
        { type: "moveClip", clip: { clipId: "missing" }, position: { byBeats: 1 } },
      ],
    });
    stop();
    expect(receipt.status).toBe("rejected");
    expect(fired).toBe(0);
    expect(keyChorus.midi.notes.value).toBe(notes);
    expect(project.undo().status).toBe("applied");
    expect(keyChorus.midi.notes.value[0].velocity).toBe(0.5);
  });

  it("keeps undo after an unrelated track is removed", () => {
    const { project, keys, drumOutro } = song();
    project.applyEdits({
      expectedVersion: version(project),
      label: "Move",
      ops: [{ type: "moveClip", clip: { clipId: drumOutro.id }, position: { byBeats: 2 } }],
    });
    project.removeTrack(keys.id);
    expect(project.undo().status).toBe("applied");
    expect(clipById(project, drumOutro.id)?.time).toBe(10);
  });

  it("refuses an undo that would land on content added afterwards", () => {
    const project = new Project({ bpm: 60 });
    const track = project.addTrack("B", "audio");
    const clip = project.addAudioClip(track.id, pcm(4), 2);
    project.applyEdits({
      expectedVersion: version(project),
      label: "Insert",
      ops: [{ type: "copyRange", range: { startBeat: 0, endBeat: 2 }, atBeat: 2, placement: "insert", as: "gap" }],
    });
    project.addAudioClip(track.id, pcm(1), 2.5);
    expect(project.undo().status).toBe("conflict");
    expect(clipById(project, clip.id)?.time).toBe(4);
  });

  it("does not move volume before the insert point", () => {
    const project = new Project({ bpm: 60 });
    const track = project.addTrack("B", "audio");
    project.setVolumeAutomation(track.id, [
      { time: 10, value: 0.2, shape: "linear" },
      { time: 20, value: 0.8, shape: "hold" },
    ]);
    project.applyEdits({
      expectedVersion: version(project),
      label: "Insert",
      ops: [{ type: "copyRange", range: { startBeat: 15, endBeat: 16 }, atBeat: 4, placement: "insert", as: "copy" }],
    });
    const curve = new AutomationCurve(project.tracks[0].volumeAutomation);
    expect(curve.valueAt(1)).toBeCloseTo(0.2, 6);
    expect(curve.valueAt(3.5)).toBeCloseTo(0.2, 6);
    expect(curve.valueAt(4.5)).toBeCloseTo(0.5 + 0.03, 1);
  });

  it("treats a copy split by a later copyRange as two clips", () => {
    const project = new Project({ bpm: 60 });
    const track = project.addTrack("Keys", "midi");
    project.addMidiClip(track.id, { duration: 8, notes: [{ id: "n1", pitch: 60, velocity: 0.5, start: 6, duration: 1 }] }, 0);
    const ops: ProjectEditOperation[] = [
      { type: "copyRange", range: { startBeat: 0, endBeat: 8 }, atBeat: 8, placement: "insert", as: "a" },
      { type: "copyRange", range: { startBeat: 0, endBeat: 2 }, atBeat: 12, placement: "insert", as: "b" },
    ];
    expect(
      project.applyEdits({
        expectedVersion: version(project),
        label: "Stale",
        ops: [...ops, { type: "moveClip", clip: { fromCopy: "a" }, position: { atBeat: 40 } }],
      }),
    ).toMatchObject({ status: "rejected", code: "ambiguous-clip", opIndex: 2 });
    const receipt = project.applyEdits({ expectedVersion: version(project), label: "Split", ops });
    if (receipt.status !== "applied") throw new Error(receipt.reason);
    expect(receipt.copies.a).toHaveLength(2);
  });

  it("refuses clearHistory during an edit and keeps the clip usable", () => {
    const { project, keyChorus } = song();
    accent(project, keyChorus.id, 0.6);
    expect(() =>
      project.edit("Bad", () => {
        project.resizeClip(keyChorus.id, { end: keyChorus.time + 4 });
        project.clearHistory();
      }),
    ).toThrow(/during an edit/);
    keyChorus.midi.edit((notes) => {
      notes[0].velocity = 0.4;
    });
    expect(keyChorus.midi.notes.value[0].velocity).toBe(0.4);
  });
});

describe("project.edit", () => {
  it("rolls every step back when the action throws", () => {
    const { project, keys, keyChorus, drumOutro } = song();
    const before = fingerprint(project);
    const expectedVersion = version(project);
    expect(() =>
      project.edit("Fail", () => {
        project.addMidiClip(keys.id, { duration: 1, notes: [] }, 40);
        project.moveClip(drumOutro.id, project.tracks[0].id, 20);
        project.removeClip(keyChorus.id);
        throw new Error("stop");
      }),
    ).toThrow("stop");
    expect(fingerprint(project)).toBe(before);
    expect(version(project)).toBe(expectedVersion);
    keyChorus.midi.setNotes([]);
    expect(project.addMidiClip(keys.id, { duration: 1, notes: [] }, 60).id).toBe("clip9");
  });

  it("disposes a trimmed replacement when a later step fails", () => {
    const { project, keyChorus } = song();
    let replacement: ProjectClip | undefined;
    expect(() =>
      project.edit("Fail", () => {
        replacement = project.resizeClip(keyChorus.id, { end: keyChorus.time + 4 });
        throw new Error("stop");
      }),
    ).toThrow("stop");
    expect(clipById(project, keyChorus.id)).toBe(keyChorus);
    // A resize only moves the window over the same content, so the content outlives the discarded replacement.
    expect((replacement as MidiClip).midi).toBe(keyChorus.midi);
    expect(() => keyChorus.midi.setNotes([])).not.toThrow();
  });

  it("rejects an async action and records a mixer change as an undoable step", () => {
    const { project, drums } = song();
    const before = fingerprint(project);
    expect(() => project.edit("Async", (async () => undefined) as () => unknown)).toThrow(/synchronous/);
    expect(fingerprint(project)).toBe(before);
    project.edit("Mixer", () => project.setTrackVolume(drums.id, 0.1));
    expect(project.tracks.find(({ id }) => id === drums.id)?.volume).toBe(0.1);
    expect(project.undo().status).toBe("applied");
    expect(project.tracks.find(({ id }) => id === drums.id)?.volume).toBe(1);
  });

  it("records no history for an edit that changes nothing", () => {
    const { project } = song();
    project.edit("Nothing", () => undefined);
    expect(project.cells.history.value).toEqual({});
  });
});

describe("base tempo", () => {
  it("changes beat 0 as an undoable edit, keeps later changes, and survives save and reopen", () => {
    const { project, keyChorus, vocal } = song();
    const beforeSeconds = project.clipTimeSeconds(keyChorus);
    const later = project.tempoMap.changes;
    project.edit("Tempo", () => project.setTempoChanges([{ beat: 0, bpm: 60 }, ...later]));
    expect(project.bpm).toBe(60);
    expect(project.tempoMap.changes).toHaveLength(3);
    expect(keyChorus.time).toBe(8);
    expect(project.clipTimeSeconds(keyChorus)).toBe(8);
    expect(clipById(project, vocal.id)?.time).toBe(4);
    expect(openDawProject(saveDawProject(project)).project.bpm).toBe(60);
    expect(project.snapshot().bpm).toBe(60);
    project.undo();
    expect(project.bpm).toBe(120);
    expect(project.clipTimeSeconds(keyChorus)).toBe(beforeSeconds);
    expect(() => project.setTempoChanges([{ beat: 0, bpm: 0 }])).toThrow(/at least 1/);
    expect(() => project.setTempoChanges([{ beat: 0, bpm: Number.MIN_VALUE }])).toThrow(/at least 1/);
    expect(() =>
      project.setTempoChanges([
        { beat: 0, bpm: 90 },
        { beat: 0, bpm: 100 },
      ]),
    ).toThrow(/unique/);
    project.setTempoChanges([{ beat: 4, bpm: 90 }]);
    expect(project.bpm).toBe(120);
  });
});

describe("project queries", () => {
  it("reads a serializable overview with both time units", () => {
    const { project, vocal } = song();
    const overview = JSON.parse(JSON.stringify(project.overview()));
    expect(overview.version).toBe(version(project));
    expect(overview.tempoChanges).toHaveLength(3);
    const summary = overview.tracks[1].clips[0];
    expect(summary).toEqual({
      id: vocal.id,
      kind: "audio",
      trackId: overview.tracks[1].id,
      trackName: "Vocals",
      startSeconds: 4,
      durationSeconds: 4,
      startBeat: 8,
      durationBeats: 4,
    });
  });

  it("finds markers by occurrence and clips by track and half-open range", () => {
    const { project, drumChorus, drumOutro, vocal, keyChorus } = song();
    project.setMarkers([...project.markers, { time: 14, name: "Chorus" }]);
    expect(project.findMarker({ name: "Chorus", occurrence: 2 })?.time).toBe(14);
    expect(project.findMarker({ name: "Chorus", occurrence: 3 })).toBeUndefined();
    const inChorus = project.findClips({ range: { startBeat: 8, endBeat: 16 } }).map(({ id }) => id);
    expect(inChorus.toSorted()).toEqual([drumChorus.id, vocal.id, keyChorus.id].toSorted());
    expect(inChorus).not.toContain(drumOutro.id);
    expect(project.findClips({ trackName: "Vocals" }).map(({ id }) => id)).toEqual([vocal.id]);
    expect(project.findClips({ range: { startBeat: 9, endBeat: 10 }, relation: "contained" })).toEqual([]);
  });
});

describe("saved edits", () => {
  it("reopens an edited project with the same arrangement and tempo", () => {
    const { project, vocals } = song();
    project.applyEdits({
      expectedVersion: version(project),
      label: "Repeat chorus",
      ops: [copyChorus, { type: "moveClip", clip: { fromCopy: "copy", trackId: vocals.id }, position: { byBeats: 1 } }],
    });
    const { project: reopened } = openDawProject(saveDawProject(project));
    expect(reopened.tempoMap.changes).toEqual(project.tempoMap.changes);
    const place = (item: Project) =>
      item.tracks.map((track) => track.clips.map((clip) => [Number(item.clipTimeSeconds(clip).toFixed(6)), Number(clip.duration.toFixed(6))]));
    expect(place(reopened)).toEqual(place(project));
    const receipt = reopened.applyEdits({ expectedVersion: version(reopened), label: "Again", ops: [copyChorus] });
    expect(receipt.status).toBe("applied");
  });
});

describe("copyRange insert invariants", () => {
  const random = (seed: number) => () => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  };

  it("keeps every tempo, automation value and clip on its musical position across generated projects", () => {
    for (let seed = 1; seed <= 150; seed++) {
      const next = random(seed * 7919);
      const int = (low: number, high: number) => low + Math.floor(next() * (high - low + 1));
      const project = new Project({ bpm: int(60, 180) });
      const beats = [...new Set(Array.from({ length: int(0, 5) }, () => int(1, 47)))];
      project.setTempoChanges(beats.map((beat) => ({ beat, bpm: int(50, 200) })));
      const audio = project.addTrack("Audio", "audio");
      const midi = project.addTrack("Midi", "midi");
      for (let beat = 0; beat < 44; beat += int(3, 7)) {
        const length = int(1, 3);
        const start = project.tempoMap.beatToSeconds(beat);
        const seconds = Math.max(0.1, project.tempoMap.beatToSeconds(beat + length) - start);
        project.addAudioClip(audio.id, pcm(Math.floor(seconds * SAMPLE_RATE) / SAMPLE_RATE), Math.round(start * SAMPLE_RATE) / SAMPLE_RATE);
        project.addMidiClip(midi.id, { duration: length, notes: [{ pitch: 60, velocity: 0.5, start: 0, duration: length }] }, beat);
      }
      const times = [...new Set(Array.from({ length: int(2, 6) }, () => int(0, 40)))].sort((a, b) => a - b);
      project.setVolumeAutomation(
        audio.id,
        times.map((time) => ({ time, value: next(), shape: next() < 0.5 ? ("linear" as const) : ("hold" as const) })),
      );

      const startBeat = int(0, 30);
      const endBeat = startBeat + int(1, 10);
      const atBeat = next() < 0.5 ? Math.max(1, startBeat) : endBeat + int(0, 6);
      if (atBeat > startBeat && atBeat < endBeat) continue;
      const before = project.tempoMap;
      const curveBefore = new AutomationCurve(project.tracks[0].volumeAutomation);
      const original = fingerprint(project);
      const receipt = project.applyEdits({
        expectedVersion: version(project),
        label: "Insert",
        ops: [{ type: "copyRange", range: { startBeat, endBeat }, atBeat, placement: "insert", as: "copy" }],
      });
      if (receipt.status !== "applied") throw new Error(`seed ${seed}: ${receipt.reason}`);
      const after = project.tempoMap;
      const length = endBeat - startBeat;
      const curveAfter = new AutomationCurve(project.tracks[0].volumeAutomation);
      for (let beat = 0.125; beat < 60; beat += 0.5) {
        const moved = beat < atBeat ? beat : beat + length;
        expect(after.bpmAtBeat(moved), `seed ${seed} tempo at ${beat}`).toBe(before.bpmAtBeat(beat));
        const nearEdge = [atBeat, startBeat, endBeat].some((edge) => Math.abs(beat - edge) < 0.01);
        if (!nearEdge)
          expect(curveAfter.valueAt(after.beatToSeconds(moved)), `seed ${seed} automation at ${beat}`).toBeCloseTo(
            curveBefore.valueAt(before.beatToSeconds(beat)),
            2,
          );
        if (beat > startBeat && beat < endBeat) {
          const copied = atBeat + beat - startBeat;
          expect(after.bpmAtBeat(copied), `seed ${seed} copied tempo`).toBe(before.bpmAtBeat(beat));
          expect(curveAfter.valueAt(after.beatToSeconds(copied)), `seed ${seed} copied automation`).toBeCloseTo(
            curveBefore.valueAt(before.beatToSeconds(beat)),
            2,
          );
        }
      }
      for (const track of project.tracks)
        for (let index = 1; index < track.clips.length; index++) {
          const previous = track.clips[index - 1];
          // Audio cuts round to the nearest frame, so neighbours may share less than one frame.
          const tolerance = previous.kind === "audio" ? 1 / SAMPLE_RATE : 1e-6;
          expect(previous.time + previous.duration, `seed ${seed} overlap on ${track.name}`).toBeLessThanOrEqual(track.clips[index].time + tolerance);
        }
      const edited = fingerprint(project);
      expect(project.undo().status).toBe("applied");
      expect(fingerprint(project), `seed ${seed} undo`).toBe(original);
      expect(project.redo().status).toBe("applied");
      expect(fingerprint(project), `seed ${seed} redo`).toBe(edited);
      project.dispose();
    }
  });
});

describe("clip names", () => {
  it("survive save, reopen, duplicate, split, trim and snapshot", () => {
    const project = new Project({ bpm: 120 });
    const audio = project.addTrack("Vocals", "audio");
    const midi = project.addTrack("Keys", "midi");
    const vocal = project.addAudioClip(audio.id, pcm(4), 0, { name: "Lead Vocal" });
    const keys = project.addMidiClip(midi.id, { duration: 4, notes: [] }, 0, { name: "Chords" });
    const { project: reopened } = openDawProject(saveDawProject(project));
    expect(reopened.tracks.map((track) => reopened.clipName(track.clips[0].id))).toEqual(["Lead Vocal", "Chords"]);
    const copy = project.snapshot();
    expect(copy.clipName(copy.tracks[0].clips[0].id)).toBe("Lead Vocal");
    expect(project.clipName(project.duplicateClip(vocal.id, 10).id)).toBe("Lead Vocal");
    expect(project.splitClip(keys.id, 2).map((clip) => project.clipName(clip.id))).toEqual(["Chords", "Chords"]);
    expect(project.clipName(project.resizeClip(vocal.id, { start: vocal.time + 1, end: vocal.time + 2 }).id)).toBe("Lead Vocal");
    project.removeClip(vocal.id);
    expect(project.clipName(vocal.id)).toBeUndefined();
  });

  it("opens a file whose clips carry a standard name attribute", () => {
    const project = new Project({ bpm: 120 });
    const track = project.addTrack("Keys", "midi");
    project.addMidiClip(track.id, { duration: 1, notes: [] }, 0, { name: "Foreign" });
    const reopened = openDawProject(saveDawProject(project)).project;
    expect(reopened.clipName(reopened.tracks[0].clips[0].id)).toBe("Foreign");
  });

  it("are found exactly, can repeat, and can select a copy", () => {
    const { project, vocals, vocal, drumChorus, keyChorus } = song();
    project.setClipName(vocal.id, "Hook");
    project.setClipName(drumChorus.id, "Hook");
    project.setClipName(keyChorus.id, "Pad");
    expect(project.findClips({ name: "Hook" })).toHaveLength(2);
    expect(project.findClips({ name: "Hook", trackId: vocals.id }).map(({ id }) => id)).toEqual([vocal.id]);
    expect(project.findClips({ name: "hook" })).toEqual([]);
    expect(project.overview().tracks[1].clips[0].name).toBe("Hook");
    const ambiguous = project.applyEdits({
      expectedVersion: version(project),
      label: "Ambiguous",
      ops: [copyChorus, { type: "moveClip", clip: { fromCopy: "copy", name: "Hook" }, position: { byBeats: 1 } }],
    });
    expect(ambiguous).toMatchObject({ status: "rejected", code: "ambiguous-clip", opIndex: 1 });
    const receipt = project.applyEdits({
      expectedVersion: version(project),
      label: "Named",
      ops: [copyChorus, { type: "moveClip", clip: { fromCopy: "copy", name: "Hook", trackId: vocals.id }, position: { byBeats: 1 } }],
    });
    expect(receipt.status).toBe("applied");
  });

  it("rename as an undoable edit without replacing any clip object", () => {
    const { project, vocal, keyChorus } = song();
    const start = version(project);
    const receipt = project.applyEdits({
      expectedVersion: start,
      label: "Rename",
      ops: [
        { type: "setClipName", clip: { clipId: vocal.id }, name: "Lead" },
        { type: "setClipName", clip: { clipId: keyChorus.id }, name: "Pad" },
      ],
    });
    if (receipt.status !== "applied") throw new Error(receipt.reason);
    expect(receipt.changed.toSorted()).toEqual([vocal.id, keyChorus.id].toSorted());
    expect(project.clipName(vocal.id)).toBe("Lead");
    expect(clipById(project, vocal.id)).toBe(vocal);
    expect(clipById(project, keyChorus.id)).toBe(keyChorus);
    expect(project.clipName(keyChorus.id)).toBe("Pad");
    expect(version(project)).not.toBe(start);
    expect(project.undo().status).toBe("applied");
    expect(project.clipName(vocal.id)).toBeUndefined();
    expect(project.clipName(keyChorus.id)).toBeUndefined();
    expect(project.redo().status).toBe("applied");
    expect(project.clipName(keyChorus.id)).toBe("Pad");
  });

  it("keep the arrangement array through rename, undo and redo", () => {
    const { project, vocals, vocal } = song();
    const clips = () => project.tracks.find(({ id }) => id === vocals.id)!.clips;
    const before = clips();
    project.applyEdits({
      expectedVersion: version(project),
      label: "Name",
      ops: [{ type: "setClipName", clip: { clipId: vocal.id }, name: "Lead" }],
    });
    expect(clips()).toBe(before);
    project.undo();
    expect(clips()).toBe(before);
    project.redo();
    expect(clips()).toBe(before);
  });

  it("restores a name when a later step fails, and rejects a blank name", () => {
    const { project, keyChorus } = song();
    const receipt = project.applyEdits({
      expectedVersion: version(project),
      label: "Bad",
      ops: [
        { type: "setClipName", clip: { clipId: keyChorus.id }, name: "Pad" },
        { type: "setClipName", clip: { clipId: keyChorus.id }, name: "   " },
      ],
    });
    expect(receipt).toMatchObject({ status: "rejected", opIndex: 1 });
    expect(project.clipName(keyChorus.id)).toBeUndefined();
    expect(() => project.setClipName(keyChorus.id, "")).toThrow(/must not be empty/);
  });
});

describe("note edits and field checks", () => {
  describe("note edits", () => {
    const notesOf = (clip: ProjectClip) => (clip.kind === "midi" ? clip.midi.notes.value : []);

    it("adds, edits and removes notes as one undo step with the rest of the request", () => {
      const { project, keyChorus } = song();
      const clip = { clipId: keyChorus.id };
      const receipt = project.applyEdits({
        expectedVersion: version(project),
        label: "Notes",
        ops: [
          {
            type: "addNotes",
            clip,
            notes: [
              { pitch: 64, start: 4, duration: 1 },
              { pitch: 67, start: 4, duration: 1, velocity: 0.7 },
            ],
          },
          { type: "editNotes", clip, notes: [{ id: "n1", pitch: 72, velocity: 0.9 }] },
        ],
      });
      expect(receipt.status).toBe("applied");
      const notes = notesOf(keyChorus);
      if (receipt.status !== "applied") throw new Error("expected applied");
      expect(receipt.createdNotes).toHaveLength(1);
      expect(receipt.createdNotes[0].clipId).toBe(keyChorus.id);
      expect(receipt.createdNotes[0].ids.map((id) => notes.find((note) => note.id === id)?.pitch)).toEqual([64, 67]);
      expect(notes.map(({ pitch, start, velocity }) => [pitch, start, velocity])).toEqual([
        [72, 1, 0.9],
        [64, 4, 0.8],
        [67, 4, 0.7],
      ]);
      const added = notes.find(({ pitch }) => pitch === 64)!;
      expect(
        project.applyEdits({
          expectedVersion: version(project),
          label: "Remove",
          ops: [{ type: "removeNotes", clip, noteIds: [added.id, "n1"] }],
        }).status,
      ).toBe("applied");
      expect(notesOf(keyChorus).map(({ pitch }) => pitch)).toEqual([67]);
      expect(project.undo().status).toBe("applied");
      expect(notesOf(keyChorus)).toHaveLength(3);
      expect(project.undo().status).toBe("applied");
      expect(notesOf(keyChorus).map(({ id }) => id)).toEqual(["n1"]);
      expect(notesOf(keyChorus)[0]).toMatchObject({ pitch: 60, velocity: 0.5 });
    });

    it("rejects bad notes and leaves the project untouched", () => {
      const { project, keyChorus, drumChorus } = song();
      const clip = { clipId: keyChorus.id };
      const before = fingerprint(project);
      const bad = (op: unknown, code: string, reason: RegExp) => {
        const receipt = project.applyEdits({ expectedVersion: version(project), label: "Bad", ops: [op as ProjectEditOperation] });
        expect(receipt).toMatchObject({ status: "rejected", code, opIndex: 0 });
        expect((receipt as { reason: string }).reason).toMatch(reason);
      };
      bad({ type: "addNotes", clip, notes: [{ pitch: 128, start: 0, duration: 1 }] }, "invalid-operation", /pitch/);
      bad({ type: "addNotes", clip, notes: [{ pitch: 60, start: -1, duration: 1 }] }, "invalid-operation", /start/);
      bad({ type: "addNotes", clip, notes: [{ pitch: 60, start: 0, duration: 0 }] }, "invalid-operation", /duration/);
      bad({ type: "addNotes", clip, notes: [{ pitch: 60, start: 0 }] }, "invalid-operation", /needs duration/);
      bad(
        { type: "addNotes", clip, notes: [{ pitch: 60, start: 0, duration: 1, vel: 1 }] },
        "invalid-operation",
        /unknown field "vel"; allowed: pitch/,
      );
      bad({ type: "addNotes", clip, notes: [] }, "invalid-operation", /non-empty/);
      bad({ type: "addNotes", clip: { clipId: drumChorus.id }, notes: [{ pitch: 60, start: 0, duration: 1 }] }, "invalid-operation", /MIDI clip/);
      bad({ type: "removeNotes", clip, noteIds: ["nope"] }, "note-not-found", /nope/);
      bad({ type: "editNotes", clip, notes: [{ id: "nope", pitch: 61 }] }, "note-not-found", /nope/);
      bad({ type: "editNotes", clip, notes: [{ id: "n1" }] }, "invalid-operation", /changes nothing/);
      bad({ type: "editNotes", clip, notes: [{ id: "n1", velocity: 2 }] }, "invalid-operation", /velocity/);
      expect(fingerprint(project)).toBe(before);
    });

    it("conflicts on a stale version like any other operation", () => {
      const { project, keyChorus } = song();
      const stale = version(project);
      project.setClipName(keyChorus.id, "Changed");
      const receipt = project.applyEdits({
        expectedVersion: stale,
        label: "Late",
        ops: [{ type: "addNotes", clip: { clipId: keyChorus.id }, notes: [{ pitch: 60, start: 0, duration: 1 }] }],
      });
      expect(receipt.status).toBe("conflict");
      expect(notesOf(keyChorus)).toHaveLength(1);
    });
  });

  it("rejects an unknown field on an operation, selector, range or position and names the allowed ones", () => {
    const { project, keyChorus } = song();
    const before = fingerprint(project);
    const reject = (op: unknown) =>
      project.applyEdits({ expectedVersion: version(project), label: "Bad", ops: [op as ProjectEditOperation] }) as {
        status: string;
        code: string;
        reason: string;
      };
    expect(reject({ type: "setClipName", clip: { clipId: keyChorus.id }, name: "x", title: "y" })).toMatchObject({
      status: "rejected",
      code: "invalid-operation",
      reason: 'setClipName has unknown field "title"; allowed: type, clip, name.',
    });
    expect(reject({ type: "moveClip", clip: { clipId: keyChorus.id }, position: { atBeat: 1, to: 2 } }).reason).toMatch(
      /position has unknown field "to"/,
    );
    expect(reject({ type: "rippleDelete", range: { startBeat: 0, endBeat: 1, start: 2 } }).reason).toMatch(/range has unknown field "start"/);
    expect(fingerprint(project)).toBe(before);
  });
});
