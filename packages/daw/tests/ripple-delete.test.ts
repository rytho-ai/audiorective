import { describe, expect, it } from "vitest";
import { MidiClip, Project, type AudioClip, type ProjectClip } from "../src/project";

const RATE = 1000;
/** The sample at frame n holds n, so any window of the recording says where in it the audio came from. */
const ramp = (seconds: number) => ({ sampleRate: RATE, channels: [Float32Array.from({ length: Math.round(seconds * RATE) }, (_, i) => i)] });

const audioClips = (project: Project, trackId: string) => project.tracks.find((track) => track.id === trackId)!.clips as AudioClip[];
const edges = (clip: ProjectClip) => [clip.time, clip.time + clip.duration];

function podcast() {
  const project = new Project({ bpm: 120 });
  const tracks = ["Host", "Guest", "Music"].map((name) => project.addTrack(name, "audio"));
  const clips = tracks.map((track) => project.addAudioClip(track.id, ramp(60), 0));
  project.setMarkers([{ time: 40, name: "Q&A" }]);
  project.setVolumeAutomation(tracks[0].id, [
    { time: 0, value: 1, shape: "hold" },
    { time: 30, value: 0.5, shape: "hold" },
    { time: 50, value: 0.25, shape: "hold" },
  ]);
  return { project, tracks, clips };
}

const snapshot = (project: Project) =>
  JSON.stringify({
    tempo: project.tempoMap.changes,
    markers: project.markers,
    tracks: project.tracks.map((track) => ({
      id: track.id,
      automation: track.volumeAutomation,
      clips: track.clips.map((clip) => ({ id: clip.id, time: clip.time, duration: clip.duration, envelope: (clip as AudioClip).envelope })),
    })),
  });

describe("project.rippleDelete in seconds", () => {
  it("cuts every track, moves markers and automation, and is one Undo step inside edit", () => {
    const { project, tracks } = podcast();
    const before = snapshot(project);
    project.edit("Cut intro chatter", () => project.rippleDelete({ startSeconds: 10, endSeconds: 20 }));

    for (const track of tracks) {
      const clips = audioClips(project, track.id);
      expect(clips.map(edges)).toEqual([
        [0, 10],
        [10, 50],
      ]);
      expect(clips.map((clip) => clip.sourceOffset)).toEqual([0, 20]);
      expect(clips[1].channels[0][0]).toBe(20 * RATE);
    }
    expect(project.markers).toEqual([{ time: 30, name: "Q&A" }]);
    expect(project.tracks[0].volumeAutomation).toEqual([
      { time: 0, value: 1, shape: "hold" },
      { time: 10, value: 1, shape: "hold" },
      { time: 20, value: 0.5, shape: "hold" },
      { time: 40, value: 0.25, shape: "hold" },
    ]);
    expect(project.undo().status).toBe("applied");
    expect(snapshot(project)).toBe(before);
  });

  it("carries the value at the range end into the cut and holds a curve whose points were all inside", () => {
    const project = new Project({ bpm: 120 });
    const track = project.addTrack("Bed", "audio");
    project.addAudioClip(track.id, ramp(30), 0);
    project.setVolumeAutomation(track.id, [
      { time: 0, value: 1, shape: "hold" },
      { time: 12, value: 0.2, shape: "hold" },
    ]);
    project.rippleDelete({ startSeconds: 10, endSeconds: 20 });
    expect(project.tracks[0].volumeAutomation).toEqual([
      { time: 0, value: 1, shape: "hold" },
      { time: 10, value: 0.2, shape: "hold" },
    ]);
  });

  it("removes a clip entirely inside the range and moves one that starts at its end", () => {
    const project = new Project({ bpm: 120 });
    const track = project.addTrack("Takes", "audio");
    const inside = project.addAudioClip(track.id, ramp(5), 12);
    const after = project.addAudioClip(track.id, ramp(5), 20);
    project.rippleDelete({ startSeconds: 10, endSeconds: 20 });
    const clips = audioClips(project, track.id);
    expect(clips.map(({ id }) => id)).toEqual([after.id]);
    expect(clips[0].time).toBe(10);
    expect(project.tracks[0].clips.some(({ id }) => id === inside.id)).toBe(false);
  });

  it("crosses fades over the join with the real recording in the overlap", () => {
    const { project, tracks } = podcast();
    project.rippleDelete({ startSeconds: 10, endSeconds: 20 }, { crossfade: 0.02 });
    for (const track of tracks) {
      const [left, right] = audioClips(project, track.id);
      expect(left.time + left.duration).toBeCloseTo(10.01, 9);
      expect(right.time).toBeCloseTo(9.99, 9);
      expect(left.envelope?.fadeOut).toBeCloseTo(0.02, 9);
      expect(right.envelope?.fadeIn).toBeCloseTo(0.02, 9);
      // The left piece now plays source 10 s to 10.01 s; the right one starts 0.01 s before its cut at source 20 s.
      expect(left.channels[0][left.channels[0].length - 1]).toBe(10.01 * RATE - 1);
      expect(right.channels[0][0]).toBe(19.99 * RATE);
    }
  });

  it("shrinks the overlap to what the join can hold", () => {
    const project = new Project({ bpm: 120 });
    const track = project.addTrack("Edge", "audio");
    project.addAudioClip(track.id, ramp(12), 0);
    // Each side may grow only into the deleted audio, half of it each, so a 20 s crossfade over a 1 s cut becomes 2 x 0.5 s.
    project.rippleDelete({ startSeconds: 5, endSeconds: 6 }, { crossfade: 20 });
    const [left, right] = audioClips(project, track.id);
    const overlap = left.time + left.duration - right.time;
    expect(overlap).toBeCloseTo(1, 9);
    expect(left.envelope?.fadeOut).toBeCloseTo(1, 9);
    expect(right.envelope?.fadeIn).toBeCloseTo(1, 9);
  });

  it("rejects invalid ranges and crossfades with the exact messages and changes nothing", () => {
    const { project } = podcast();
    const before = snapshot(project);
    const range = "Project ripple delete needs 0 <= start < end.";
    for (const bad of [
      { startSeconds: 5, endSeconds: 5 },
      { startSeconds: -1, endSeconds: 5 },
      { startSeconds: 0, endSeconds: Infinity },
      { startBeat: 4, endBeat: 2 },
      { startBeat: 1, endBeat: 2, startSeconds: 1, endSeconds: 2 },
      {},
    ])
      expect(() => project.rippleDelete(bad as never)).toThrow(new RangeError(range));
    for (const crossfade of [-1, NaN, Infinity, "1" as never])
      expect(() => project.rippleDelete({ startSeconds: 1, endSeconds: 2 }, { crossfade })).toThrow(
        new RangeError("Project ripple delete crossfade must be true, false or a non-negative number of seconds."),
      );
    expect(snapshot(project)).toBe(before);
  });
});

describe("project.rippleDelete in beats", () => {
  function song() {
    const project = new Project({ bpm: 120 });
    project.setTempoChanges([{ beat: 48, bpm: 60 }]);
    const t = project.tempoMap;
    const bar = (n: number) => t.beatToSeconds((n - 1) * 4);
    project.setMarkers([
      { time: bar(1), name: "Intro" },
      { time: bar(9), name: "Verse" },
      { time: bar(17), name: "Chorus" },
    ]);
    const keys = project.addTrack("Keys", "midi");
    const bass = project.addTrack("Bass", "audio");
    const notes = [
      { id: "a", pitch: 60, velocity: 0.5, start: 0, duration: 1 },
      { id: "b", pitch: 62, velocity: 0.5, start: 20, duration: 1 },
    ];
    const early = project.addMidiClip(keys.id, { duration: 8, notes: [notes[0]] }, 0);
    const late = project.addMidiClip(keys.id, { duration: 8, notes: [{ ...notes[0], id: "c" }] }, 48);
    const crossing = project.addMidiClip(keys.id, { duration: 40, notes }, 16);
    const audioStart = t.beatToSeconds(24);
    const bed = project.addAudioClip(bass.id, ramp(60), 0);
    return { project, keys, bass, early, late, crossing, bed, audioStart, bar };
  }

  it("keeps the music after the cut on its musical position", () => {
    const { project, keys, bass, early, late, crossing, bed } = song();
    const before = project.tempoMap;
    const lengthSeconds = before.beatToSeconds(48) - before.beatToSeconds(32);
    const bar17 = before.beatToSeconds(64);
    const bed48 = before.beatToSeconds(48);
    project.rippleDelete({ startBeat: 32, endBeat: 48 });

    expect(project.markers.map(({ name }) => name)).toEqual(["Intro", "Chorus"]);
    expect(project.markers[1].time).toBeCloseTo(project.tempoMap.beatToSeconds(48), 9);
    expect(project.markers[1].time).toBeCloseTo(bar17 - lengthSeconds, 9);
    expect(project.tempoMap.changes).toEqual([{ beat: 32, bpm: 60 }]);

    const midi = project.tracks.find((track) => track.id === keys.id)!.clips as MidiClip[];
    const byId = (id: string) => midi.find((clip) => clip.id === id)!;
    expect(byId(early.id).time).toBe(0);
    expect(byId(late.id).time).toBe(32);
    expect(byId(late.id).midi.notes.value.map(({ start }) => start)).toEqual([0]);
    // The crossing clip (beats 16-56) is split: 16-32 stays, 48-56 moves to 32; its second note (beat 36) is inside the cut.
    expect(midi.filter(({ id }) => id !== early.id && id !== late.id).map((clip) => [clip.time, clip.duration])).toEqual([
      [16, 16],
      [32, 8],
    ]);
    expect(byId(crossing.id).time).toBe(16);

    // The audio bed is cut at 32 beats (16 s) to 48 beats (24 s); the tail moves earlier by 8 s and lands on the same bar.
    const [head, tail] = audioClips(project, bass.id);
    expect(edges(head)).toEqual([0, before.beatToSeconds(32)]);
    expect(tail.time).toBeCloseTo(before.beatToSeconds(32), 9);
    expect(tail.sourceOffset).toBeCloseTo(bed48, 9);
    expect(project.tempoMap.secondsToBeat(tail.time + (bed.duration - bed48))).toBeCloseTo(
      project.tempoMap.secondsToBeat(tail.time + tail.duration),
      9,
    );
  });

  it("applies the op as one labelled Undo step and rejects invalid ranges without a change", () => {
    const { project } = song();
    const before = snapshot(project);
    const version = project.cells.version.value;
    const receipt = project.applyEdits({
      expectedVersion: version,
      label: "Cut verse",
      ops: [{ type: "rippleDelete", range: { startBeat: 32, endBeat: 48 } }],
    });
    expect(receipt.status).toBe("applied");
    expect(snapshot(project)).not.toBe(before);
    expect(project.undo().status).toBe("applied");
    expect(snapshot(project)).toBe(before);

    for (const op of [
      { type: "rippleDelete", range: { startBeat: 8, endBeat: 8 } },
      { type: "rippleDelete", range: { startSeconds: 1, endSeconds: 2 }, crossfade: -1 },
    ] as const) {
      const rejected = project.applyEdits({ expectedVersion: project.cells.version.value, label: "Bad", ops: [op] });
      expect(rejected).toMatchObject({ status: "rejected", code: "invalid-operation", opIndex: 0 });
      expect(snapshot(project)).toBe(before);
    }
  });
});

it("on its own, rippleDelete is one atomic Undo step", () => {
  const project = new Project();
  const track = project.addTrack("A", "audio");
  project.addAudioClip(track.id, { sampleRate: 8000, channels: [new Float32Array(8000 * 30).fill(0.1)] }, 0);
  project.rippleDelete({ startSeconds: 10, endSeconds: 20 });
  expect(project.tracks[0].clips.map((c) => [c.time, c.duration])).toEqual([
    [0, 10],
    [10, 10],
  ]);
  expect(project.cells.history.value).toEqual({ undo: "Ripple delete" });
  project.undo();
  expect(project.tracks[0].clips.map((c) => [c.time, c.duration])).toEqual([[0, 30]]);
  project.dispose();
});

describe("review regressions", () => {
  const take = (seconds: number) => Float32Array.from({ length: 8000 * seconds }, (_, i) => Math.sin(i / 9) * 0.5);

  it("caps the crossfade by the pieces' lengths", () => {
    const project = new Project();
    const track = project.addTrack("A", "audio");
    project.addAudioClip(track.id, { sampleRate: 8000, channels: [take(21)] }, 0);
    project.resizeClip(project.tracks[0].clips[0].id, { end: 20.01 });
    project.rippleDelete({ startSeconds: 10, endSeconds: 20 }, { crossfade: 0.1 });
    const [left, right] = project.tracks[0].clips as AudioClip[];
    expect(right.time).toBeLessThan(10);
    expect(right.envelope!.fadeIn).toBeLessThanOrEqual(right.duration);
    expect(left.envelope!.fadeOut).toBeCloseTo(right.envelope!.fadeIn, 9);
    project.dispose();
  });

  it("never plays deleted-range audio twice: each side grows by at most half the deleted length", () => {
    const project = new Project();
    const track = project.addTrack("A", "audio");
    project.addAudioClip(track.id, { sampleRate: 8000, channels: [take(30)] }, 0);
    project.rippleDelete({ startSeconds: 10, endSeconds: 10.02 }, { crossfade: 0.2 });
    const [left, right] = project.tracks[0].clips as AudioClip[];
    expect(left.sourceOffset + left.duration).toBeLessThanOrEqual(right.sourceOffset + 1e-9);
    project.dispose();
  });

  it("does not write unchanged tempo or markers, so a later tempo edit leaves undo possible", () => {
    const project = new Project();
    const track = project.addTrack("A", "audio");
    project.addAudioClip(track.id, { sampleRate: 8000, channels: [take(30)] }, 0);
    project.rippleDelete({ startSeconds: 10, endSeconds: 20 });
    project.setTempoChanges([{ beat: 200, bpm: 100 }]);
    expect(project.undo().status).toBe("applied");
    expect(project.tracks[0].clips.map((c) => [c.time, c.duration])).toEqual([[0, 30]]);
    project.dispose();
  });
});

it("crossfade: true uses a short default; false and 0 cut hard", () => {
  const make = () => {
    const project = new Project();
    const track = project.addTrack("A", "audio");
    project.addAudioClip(track.id, { sampleRate: 8000, channels: [Float32Array.from({ length: 8000 * 30 }, (_, i) => Math.sin(i / 9))] }, 0);
    return project;
  };
  const on = make();
  on.rippleDelete({ startSeconds: 10, endSeconds: 20 }, { crossfade: true });
  const [left, right] = on.tracks[0].clips as AudioClip[];
  expect(left.time + left.duration - right.time).toBeCloseTo(0.005, 9);
  for (const crossfade of [false, 0] as const) {
    const off = make();
    off.rippleDelete({ startSeconds: 10, endSeconds: 20 }, { crossfade });
    const [a, b] = off.tracks[0].clips as AudioClip[];
    expect(a.time + a.duration).toBe(b.time);
    off.dispose();
  }
  on.dispose();
});
