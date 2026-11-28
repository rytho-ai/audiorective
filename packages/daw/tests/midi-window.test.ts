import { describe, expect, it } from "vitest";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { MidiClip, Project, type ProjectClip, type ProjectOverview } from "../src/project";
import { openDawProject, saveDawProject } from "../src/dawproject";

/** Eight bars of 4/4: one note at the start of each bar, one beat long. */
function eightBars() {
  const project = new Project({ bpm: 120 });
  const track = project.addTrack("Keys", "midi");
  const notes = Array.from({ length: 8 }, (_, bar) => ({ id: `bar${bar + 1}`, pitch: 60 + bar, velocity: 0.8, start: bar * 4, duration: 1 }));
  const clip = project.addMidiClip(track.id, { duration: 32, notes }, 0);
  return { project, track, clip };
}
const asMidi = (clip: ProjectClip | undefined): MidiClip => {
  if (!clip || clip.kind !== "midi") throw new Error("Expected a MIDI clip");
  return clip;
};
const find = (project: Project, id: string) => asMidi(project.tracks.flatMap((track) => track.clips).find((clip) => clip.id === id));
/** `[pitch, beat]` of each note-on the clip plays, `beat` from the clip's start. */
const onsets = (clip: MidiClip) =>
  clip
    .playbackEvents()
    .filter((event) => (event.data[0] & 0xf0) === 0x90)
    .map((event) => [event.data[1], event.beat]);
const offs = (clip: MidiClip) =>
  clip
    .playbackEvents()
    .filter((event) => (event.data[0] & 0xf0) === 0x80)
    .map((event) => [event.data[1], event.beat]);

describe("non-destructive MIDI windows", () => {
  it("trimming the end hides notes and extending it brings them back unchanged", () => {
    const { project, clip } = eightBars();
    const before = onsets(clip);
    const short = asMidi(project.resizeClip(clip.id, { end: 16 }));
    expect([short.time, short.sourceOffset, short.duration]).toEqual([0, 0, 16]);
    expect(onsets(short)).toEqual(before.slice(0, 4));
    expect(short.midi.notes.value).toHaveLength(8);
    const restored = asMidi(project.resizeClip(clip.id, { end: 32 }));
    expect(onsets(restored)).toEqual(before);
    expect(restored.midi.notes.value.map((note) => note.id)).toEqual(clip.midi.notes.value.map((note) => note.id));
    project.dispose();
  });

  it("trimming the start moves time and sourceOffset together and reveals the first bar again", () => {
    const { project, clip } = eightBars();
    const trimmed = asMidi(project.resizeClip(clip.id, { start: 8 }));
    expect([trimmed.time, trimmed.sourceOffset, trimmed.duration]).toEqual([8, 8, 24]);
    // Bar 3 starts at 8 in the content and still sounds at project beat 8.
    expect(onsets(trimmed)[0]).toEqual([62, 0]);
    const back = asMidi(project.resizeClip(clip.id, { start: 0 }));
    expect([back.time, back.sourceOffset, back.duration]).toEqual([0, 0, 32]);
    expect(onsets(back)).toHaveLength(8);
    project.dispose();
  });

  it("extending the start past the content only moves sourceOffset below 0", () => {
    const { project, clip } = eightBars();
    project.moveClip(clip.id, project.tracks[0].id, 4);
    expect(find(project, clip.id).time).toBe(4);
    const wider = asMidi(project.resizeClip(clip.id, { start: 2 }));
    expect([wider.time, wider.sourceOffset, wider.duration]).toEqual([2, -2, 34]);
    expect(onsets(wider)[0]).toEqual([60, 2]);
    expect(() => project.resizeClip(clip.id, { start: -1 })).toThrow("Project MIDI clip edges need 0 <= start < end.");
    project.dispose();
  });

  it("a note crossing a window edge is shortened at playback and the stored note is untouched", () => {
    const { project, track } = eightBars();
    const clip = project.addMidiClip(track.id, { duration: 8, notes: [{ id: "long", pitch: 70, velocity: 1, start: 2, duration: 4 }] }, 64);
    const cut = asMidi(project.resizeClip(clip.id, { start: 66 + 1, end: 66 + 3 }));
    expect([cut.sourceOffset, cut.duration]).toEqual([3, 2]);
    expect(onsets(cut)).toEqual([[70, 0]]);
    expect(offs(cut)).toEqual([[70, 2]]);
    expect(cut.midi.notes.value[0]).toMatchObject({ start: 2, duration: 4 });
    const clean = asMidi(project.resizeClip(clip.id, { start: 64, end: 70 }));
    expect(offs(clean)).toEqual([[70, 6]]);
    project.dispose();
  });

  it("every note-on has its note-off inside the window, and a held pedal is released where the content goes on", () => {
    const { project, track } = eightBars();
    const pedal = (value: number) => new Uint8Array([0xb0, 64, value]);
    const clip = project.addMidiClip(
      track.id,
      {
        duration: 16,
        notes: [{ id: "long", pitch: 70, velocity: 1, start: 1, duration: 10 }],
        events: [
          { time: 2, data: pedal(127) },
          { time: 12, data: pedal(0) },
        ],
      },
      64,
    );
    const windowed = asMidi(project.resizeClip(clip.id, { start: 66, end: 70 }));
    const events = windowed.playbackEvents();
    expect(events.filter((event) => event.data[0] === 0x90).map((event) => event.beat)).toEqual([0]);
    expect(events.filter((event) => event.data[0] === 0x80).map((event) => event.beat)).toEqual([4]);
    // The pedal went down at content beat 2 (the window's start) and its release lies outside, so one is sent at the window's end.
    expect(events.filter((event) => event.data[0] === 0xb0).map((event) => [event.data[2], event.beat])).toEqual([
      [127, 0],
      [0, 4],
    ]);
    // A window that starts after the pedal went down carries it in at beat 0.
    const later = asMidi(project.resizeClip(clip.id, { start: 68, end: 72 }));
    expect(
      later
        .playbackEvents()
        .filter((event) => event.data[0] === 0xb0)
        .map((event) => [event.data[2], event.beat])[0],
    ).toEqual([127, 0]);
    project.dispose();
  });

  it("a pedal still down at the window end is released there even when no later event follows", () => {
    const { project, track } = eightBars();
    const pedal = (value: number) => new Uint8Array([0xb0, 64, value]);
    const clip = project.addMidiClip(track.id, { duration: 16, notes: [], events: [{ time: 2, data: pedal(127) }] }, 64);
    const windowed = asMidi(project.resizeClip(clip.id, { start: 64, end: 68 }));
    expect(
      windowed
        .playbackEvents()
        .filter((event) => event.data[0] === 0xb0)
        .map((event) => [event.data[2], event.beat]),
    ).toEqual([
      [127, 2],
      [0, 4],
    ]);
    // Playback only: the stored events are untouched.
    expect(windowed.events.map((event) => [event.data[2], event.time])).toEqual([[127, 2]]);
    project.dispose();
  });

  it("splitClip gives two independent pieces that keep the whole content", () => {
    const { project, clip } = eightBars();
    const [left, right] = project.splitClip(clip.id, 8);
    const l = asMidi(left);
    const r = asMidi(right);
    expect([l.time, l.sourceOffset, l.duration]).toEqual([0, 0, 8]);
    expect([r.time, r.sourceOffset, r.duration]).toEqual([8, 8, 24]);
    expect(project.linkedClips(l.id)).toEqual([]);
    expect(l.midi).not.toBe(r.midi);
    expect(l.midi.notes.value).toHaveLength(8);
    expect(r.midi.notes.value).toHaveLength(8);
    const short = asMidi(project.resizeClip(r.id, { end: 12 }));
    expect(onsets(short)).toEqual([[62, 0]]);
    const longer = asMidi(project.resizeClip(r.id, { end: 20 }));
    expect(onsets(longer)).toEqual([
      [62, 0],
      [63, 4],
      [64, 8],
    ]);
    // Editing one piece's content leaves the other alone.
    l.midi.edit((notes) => void (notes[0].pitch = 1));
    expect(r.midi.notes.value[0].pitch).toBe(60);
    project.dispose();
  });

  it("setClipSourceRange slides the window and keeps the clip where it is", () => {
    const { project, clip } = eightBars();
    project.resizeClip(clip.id, { start: 4, end: 12 });
    const slid = asMidi(project.setClipSourceRange(clip.id, { start: 16, end: 20 }));
    expect([slid.time, slid.sourceOffset, slid.duration]).toEqual([4, 16, 4]);
    expect(onsets(slid)).toEqual([[64, 0]]);
    const empty = asMidi(project.setClipSourceRange(clip.id, { start: -3, end: 1 }));
    expect(onsets(empty)).toEqual([[60, 3]]);
    expect(() => project.setClipSourceRange(clip.id, { start: 2, end: 2 })).toThrow("Project MIDI source range needs finite start < end beats.");
    project.dispose();
  });

  it("setClipSourceRange on a looped clip makes the range the loop and the start and keeps the clip's span", () => {
    const { project, clip } = eightBars();
    project.setClipLoop(clip.id, { startBeat: 0, endBeat: 4 });
    project.resizeClip(clip.id, { end: 16 });
    const slipped = asMidi(project.setClipSourceRange(clip.id, { start: 16, end: 20 }));
    expect([slipped.time, slipped.sourceOffset, slipped.duration, slipped.loop]).toEqual([0, 16, 16, { startBeat: 16, endBeat: 20 }]);
    // The bar-5 note (pitch 64) now starts every pass of the loop: beats 0, 4, 8, 12.
    expect(onsets(slipped)).toEqual([
      [64, 0],
      [64, 4],
      [64, 8],
      [64, 12],
    ]);
    expect(slipped.midi).toBe(clip.midi);
    expect(() => project.setClipSourceRange(clip.id, { start: 3, end: 3 })).toThrow("Project MIDI source range needs finite start < end beats.");
    expect(() => project.setClipSourceRange(clip.id, { start: -1, end: 2 })).toThrow(
      "Project clip loop needs 0 <= start < end inside the clip's content.",
    );
    project.edit("Slip", () => void project.setClipSourceRange(clip.id, { start: 8, end: 10 }));
    expect(find(project, clip.id)).toMatchObject({ sourceOffset: 8, loop: { startBeat: 8, endBeat: 10 } });
    project.undo();
    expect(find(project, clip.id)).toMatchObject({ sourceOffset: 16, duration: 16, loop: { startBeat: 16, endBeat: 20 } });
    const reopened = asMidi(openDawProject(saveDawProject(project)).project.tracks[0].clips[0]);
    expect([reopened.sourceOffset, reopened.duration, reopened.loop]).toEqual([16, 16, { startBeat: 16, endBeat: 20 }]);
    project.dispose();
  });

  it("loops are in content beats and the entry follows sourceOffset", () => {
    const { project, clip } = eightBars();
    project.resizeClip(clip.id, { end: 16 });
    project.setClipLoop(clip.id, { startBeat: 4, endBeat: 8 });
    // Entry at 0: plays [0, 8), then repeats [4, 8).
    expect(onsets(find(project, clip.id))).toEqual([
      [60, 0],
      [61, 4],
      [61, 8],
      [61, 12],
    ]);
    // Moving the start edge into the loop enters it there: [6, 8) first, then the loop again.
    project.resizeClip(clip.id, { start: 6, end: 22 });
    expect(find(project, clip.id).sourceOffset).toBe(6);
    expect(onsets(find(project, clip.id))).toEqual([
      [61, 2],
      [61, 6],
      [61, 10],
      [61, 14],
    ]);
    project.dispose();
  });

  it("a split of a looped clip keeps the loop and continues it where it was", () => {
    const { project, clip } = eightBars();
    project.resizeClip(clip.id, { end: 16 });
    project.setClipLoop(clip.id, { startBeat: 4, endBeat: 8 });
    const [left, right] = project.splitClip(clip.id, 10).map(asMidi);
    expect(right.loop).toEqual({ startBeat: 4, endBeat: 8 });
    // At local 10: first pass is 8 beats, then 2 beats into the loop = content 6.
    expect(right.sourceOffset).toBe(6);
    expect([left.sourceOffset, left.duration, right.duration]).toEqual([0, 10, 6]);
    // The right piece starts at content 6 and plays on from there, as the whole clip did at local beat 10.
    expect(onsets(right)).toEqual([[61, 2]]);
    project.dispose();
  });

  it("undo and redo restore each window edit", () => {
    const { project, clip } = eightBars();
    const state = (id: string) => {
      const c = find(project, id);
      return [c.time, c.sourceOffset, c.duration, c.midi.notes.value.length];
    };
    project.edit("Trim end", () => void project.resizeClip(clip.id, { end: 16 }));
    expect(state(clip.id)).toEqual([0, 0, 16, 8]);
    project.edit("Trim start", () => void project.resizeClip(clip.id, { start: 4 }));
    expect(state(clip.id)).toEqual([4, 4, 12, 8]);
    project.edit("Slide", () => void project.setClipSourceRange(clip.id, { start: 12, end: 16 }));
    expect(state(clip.id)).toEqual([4, 12, 4, 8]);
    expect(project.undo().status).toBe("applied");
    expect(state(clip.id)).toEqual([4, 4, 12, 8]);
    expect(project.undo().status).toBe("applied");
    expect(state(clip.id)).toEqual([0, 0, 16, 8]);
    expect(project.redo().status).toBe("applied");
    expect(project.redo().status).toBe("applied");
    expect(state(clip.id)).toEqual([4, 12, 4, 8]);
    project.edit("Split", () => void project.splitClip(clip.id, 2));
    expect(project.tracks[0].clips).toHaveLength(2);
    expect(project.undo().status).toBe("applied");
    expect(project.tracks[0].clips).toHaveLength(1);
    expect(state(clip.id)).toEqual([4, 12, 4, 8]);
    project.dispose();
  });

  it("linked clips share the content but each has its own window", () => {
    const { project, clip } = eightBars();
    const copy = asMidi(project.duplicateClip(clip.id, 40, { linked: true }));
    expect(copy.sourceOffset).toBe(0);
    const a = asMidi(project.resizeClip(clip.id, { start: 8, end: 16 }));
    const b = asMidi(project.resizeClip(copy.id, { start: 44, end: 56 }));
    expect(project.linkedClips(a.id).map(({ id }) => id)).toEqual([copy.id]);
    expect([a.sourceOffset, a.duration, b.sourceOffset, b.duration]).toEqual([8, 8, 4, 12]);
    expect(onsets(a)).toEqual([
      [62, 0],
      [63, 4],
    ]);
    expect(onsets(b)).toEqual([
      [61, 0],
      [62, 4],
      [63, 8],
    ]);
    a.midi.edit((notes) => void (notes[2].pitch = 99));
    expect(onsets(find(project, copy.id))[1]).toEqual([99, 4]);
    const slid = asMidi(project.setClipSourceRange(copy.id, { start: 0, end: 4 }));
    expect(project.linkedClips(slid.id).map(({ id }) => id)).toEqual([a.id]);
    project.dispose();
  });

  it("a duplicate keeps the window; a snapshot keeps it and the link", () => {
    const { project, clip } = eightBars();
    project.resizeClip(clip.id, { start: 8, end: 16 });
    const copy = asMidi(project.duplicateClip(clip.id, 40));
    expect([copy.sourceOffset, copy.duration]).toEqual([8, 8]);
    const snapshot = project.snapshot();
    expect(asMidi(snapshot.tracks[0].clips[1]).sourceOffset).toBe(8);
    snapshot.dispose();
    project.dispose();
  });

  it("overview and findClips report sourceOffset and loop for MIDI clips only", () => {
    const { project, clip } = eightBars();
    project.resizeClip(clip.id, { start: 8 });
    project.setClipLoop(clip.id, { startBeat: 8, endBeat: 12 });
    const audio = project.addTrack("Take", "audio");
    project.addAudioClip(audio.id, { sampleRate: 100, channels: [new Float32Array(100)] }, 0);
    const overview: ProjectOverview = project.overview();
    expect(overview.tracks[0].clips[0]).toMatchObject({ kind: "midi", sourceOffset: 8, loop: { startBeat: 8, endBeat: 12 } });
    expect(overview.tracks[1].clips[0]).not.toHaveProperty("sourceOffset");
    expect(project.findClips({ trackName: "Keys" })[0]).toMatchObject({ sourceOffset: 8 });
    project.dispose();
  });
});

describe("applyEdits window operations", () => {
  it("resizeClip and setClipSourceRange apply as one undo step and keep the content", () => {
    const { project, clip } = eightBars();
    const receipt = project.applyEdits({
      expectedVersion: project.cells.version.value,
      label: "Window",
      ops: [
        { type: "resizeClip", clip: { clipId: clip.id }, start: 8, end: 24 },
        { type: "setClipSourceRange", clip: { clipId: clip.id }, start: 0, end: 4 },
      ],
    });
    expect(receipt.status).toBe("applied");
    const c = find(project, clip.id);
    expect([c.time, c.sourceOffset, c.duration, c.midi.notes.value.length]).toEqual([8, 0, 4, 8]);
    expect(project.undo({ expectedVersion: project.cells.version.value }).status).toBe("applied");
    const back = find(project, clip.id);
    expect([back.time, back.sourceOffset, back.duration]).toEqual([0, 0, 32]);
    project.dispose();
  });

  it("rejects bad input, an overlap, and a stale version", () => {
    const { project, track, clip } = eightBars();
    const next = project.addMidiClip(track.id, { duration: 4, notes: [] }, 40);
    const run = (ops: Parameters<Project["applyEdits"]>[0]["ops"], expectedVersion = project.cells.version.value) =>
      project.applyEdits({ expectedVersion, label: "x", ops });
    const empty = run([{ type: "resizeClip", clip: { clipId: clip.id } }]);
    expect(empty).toMatchObject({ status: "rejected", code: "invalid-operation", opIndex: 0 });
    expect(run([{ type: "setClipSourceRange", clip: { clipId: clip.id }, start: 3, end: 1 }])).toMatchObject({
      status: "rejected",
      code: "invalid-operation",
    });
    expect(run([{ type: "resizeClip", clip: { clipId: "missing" }, end: 3 }])).toMatchObject({ status: "rejected", code: "clip-not-found" });
    expect(run([{ type: "resizeClip", clip: { clipId: clip.id }, end: 44 }])).toMatchObject({ status: "rejected", code: "overlap" });
    expect(find(project, clip.id).duration).toBe(32);
    const stale = project.cells.version.value;
    project.resizeClip(next.id, { end: 46 });
    expect(run([{ type: "resizeClip", clip: { clipId: clip.id }, end: 16 }], stale).status).toBe("conflict");
    expect(find(project, clip.id).duration).toBe(32);
    project.dispose();
  });
});

describe("DAWproject windows", () => {
  const playAttrs = (xml: string) =>
    [...xml.matchAll(/<Clip [^>]*>/g)].map((match) => match[0]).filter((tag) => tag.includes('contentTimeUnit="beats"'));

  it("writes playStart and playStop only when the window is not the clip's own start, and reads them back", () => {
    const { project, clip } = eightBars();
    const xml = strFromU8(unzipSync(saveDawProject(project))["project.xml"]);
    expect(playAttrs(xml).join()).not.toContain("playStart");
    project.resizeClip(clip.id, { start: 8, end: 20 });
    const saved = saveDawProject(project);
    const tags = playAttrs(strFromU8(unzipSync(saved)["project.xml"])).join();
    expect(tags).toContain('playStart="8"');
    expect(tags).toContain('playStop="20"');
    const { project: reopened, warnings } = openDawProject(saved);
    expect(warnings).toEqual([]);
    const again = asMidi(reopened.tracks[0].clips[0]);
    expect([again.time, again.sourceOffset, again.duration, again.midi.notes.value.length]).toEqual([8, 8, 12, 8]);
    expect(onsets(again)).toEqual(onsets(find(project, clip.id)));
    reopened.dispose();
    project.dispose();
  });

  it("keeps a loop, a negative offset and a linked group's separate windows through save and reopen", () => {
    const { project, clip } = eightBars();
    project.resizeClip(clip.id, { end: 16 });
    project.setClipLoop(clip.id, { startBeat: 4, endBeat: 8 });
    const copy = asMidi(project.duplicateClip(clip.id, 40, { linked: true }));
    project.setClipLoop(copy.id, null);
    project.setClipSourceRange(copy.id, { start: -2, end: 6 });
    const { project: reopened } = openDawProject(saveDawProject(project));
    const [first, second] = reopened.tracks[0].clips.map(asMidi);
    expect(first.loop).toEqual({ startBeat: 4, endBeat: 8 });
    expect([second.sourceOffset, second.duration]).toEqual([-2, 8]);
    expect(reopened.linkedClips(first.id).map(({ id }) => id)).toEqual([second.id]);
    expect(onsets(second)).toEqual(onsets(find(project, copy.id)));
    reopened.dispose();
    project.dispose();
  });

  it("opens a hand-written playStart on a Notes clip, with and without playStop", () => {
    const { project } = eightBars();
    const files = unzipSync(saveDawProject(project));
    const xml = strFromU8(files["project.xml"]);
    const clipTag = playAttrs(xml)[0];
    const open = (extra: string) =>
      openDawProject(zipSync({ ...files, "project.xml": strToU8(xml.replace(clipTag, clipTag.replace(">", ` ${extra}>`))) })).project;
    const both = open('playStart="4" playStop="36"');
    expect(asMidi(both.tracks[0].clips[0]).sourceOffset).toBe(4);
    both.dispose();
    const only = open('playStart="2"');
    expect(asMidi(only.tracks[0].clips[0]).sourceOffset).toBe(2);
    only.dispose();
    expect(() => open('playStart="4" playStop="4"')).toThrow("Project MIDI clip needs playStart before playStop.");
    project.dispose();
  });
});
