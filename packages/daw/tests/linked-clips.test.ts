import { describe, expect, it } from "vitest";
import { strToU8, unzipSync, zipSync } from "fflate";
import { MidiClip, Project, sessionFor } from "../src/project";
import { openDawProject, saveDawProject } from "../src/dawproject";

const note = (id: string, start = 0, pitch = 60) => ({ id, start, duration: 1, pitch, velocity: 0.8 });

function setup() {
  const project = new Project({ bpm: 120 });
  const keys = project.addTrack("Keys", "midi");
  const source = project.addMidiClip(keys.id, { duration: 4, notes: [note("n1"), note("n2", 1, 64)] }, 0, { name: "Pattern" });
  return { project, keys, source };
}

const pitches = (clip: { midi: MidiClip["midi"] }) => clip.midi.notes.value.map((n) => n.pitch);
const asMidi = (clip: unknown) => clip as MidiClip;

describe("linked MIDI clips", () => {
  it("duplicateClip({ linked }) makes a new clip that shares the notes, and takes the track in the options", () => {
    const { project, keys, source } = setup();
    const other = project.addTrack("Bass", "midi");
    const copy = asMidi(project.duplicateClip(source.id, 8, { linked: true }));
    const onOther = asMidi(project.duplicateClip(source.id, 0, { trackId: other.id, linked: true }));
    const plain = asMidi(project.duplicateClip(source.id, 16, { trackId: keys.id }));
    expect(copy.id).not.toBe(source.id);
    expect(project.clipName(copy.id)).toBe("Pattern");
    expect(project.linkedClips(source.id).map(({ id }) => id)).toEqual([copy.id, onOther.id]);
    expect(project.linkedClips(copy.id).map(({ id }) => id)).toContain(source.id);
    expect(project.linkedClips(plain.id)).toEqual([]);
    source.midi.edit((notes) => {
      notes[0].pitch = 72;
    });
    expect(pitches(copy)).toEqual(pitches(source));
    expect(pitches(onOther)).toEqual(pitches(source));
    expect(pitches(plain)).toEqual([60, 64]);
    copy.midi.setNotes([note("x", 0, 40)]);
    expect(pitches(source)).toEqual([40]);
  });

  it("refuses to link an audio clip", () => {
    const project = new Project();
    const track = project.addTrack("A", "audio");
    const clip = project.addAudioClip(track.id, { sampleRate: 100, channels: [new Float32Array(100)] }, 0);
    expect(() => project.duplicateClip(clip.id, 2, { linked: true })).toThrow("Project can link only MIDI clips");
  });

  it("an edit inside project.edit is one undo step that restores every placement, and redo brings it back", () => {
    const { project, source } = setup();
    const copy = asMidi(project.duplicateClip(source.id, 8, { linked: true }));
    project.clearHistory();
    project.edit("Transpose", () => {
      source.midi.edit((notes) => notes.forEach((n) => (n.pitch += 12)));
    });
    expect(pitches(copy)).toEqual([72, 76]);
    expect(project.undo().status).toBe("applied");
    expect(pitches(source)).toEqual([60, 64]);
    expect(pitches(copy)).toEqual([60, 64]);
    expect(project.linkedClips(source.id)).toHaveLength(1);
    expect(project.redo().status).toBe("applied");
    expect(pitches(source)).toEqual([72, 76]);
    expect(pitches(copy)).toEqual([72, 76]);
    source.midi.edit((notes) => notes.push(note("n3", 2, 70)));
    expect(copy.midi.notes.value).toHaveLength(3);
  });

  it("making a link and undoing it removes the copy and leaves the source's notes alone", () => {
    const { project, source } = setup();
    project.edit("Link", () => void project.duplicateClip(source.id, 8, { linked: true }));
    expect(project.linkedClips(source.id)).toHaveLength(1);
    project.undo();
    expect(project.linkedClips(source.id)).toEqual([]);
    expect(project.redo().status).toBe("applied");
    expect(project.linkedClips(source.id)).toHaveLength(1);
    source.midi.edit((notes) => notes.forEach((n) => (n.pitch += 1)));
    expect(pitches(source)).toEqual([61, 65]);
  });

  it("makeClipUnique gives one clip its own notes; the rest stay linked; it is undoable and a no-op when not linked", () => {
    const { project, source } = setup();
    const a = asMidi(project.duplicateClip(source.id, 8, { linked: true }));
    const b = asMidi(project.duplicateClip(source.id, 16, { linked: true }));
    expect(project.makeClipUnique(b.id).id).toBe(b.id);
    expect(project.linkedClips(b.id)).toEqual([]);
    expect(project.linkedClips(source.id).map(({ id }) => id)).toEqual([a.id]);
    const unique = asMidi(project.tracks[0].clips.find(({ id }) => id === b.id));
    source.midi.edit((notes) => (notes[0].pitch = 1));
    expect(pitches(unique)).toEqual([60, 64]);
    expect(pitches(a)).toEqual([1, 64]);
    expect(project.clipName(b.id)).toBe("Pattern");
    const solo = project.tracks[0].clips.find(({ id }) => id === b.id)!;
    expect(project.makeClipUnique(b.id)).toBe(solo);

    project.clearHistory();
    project.edit("Unlink", () => void project.makeClipUnique(a.id));
    expect(project.linkedClips(source.id)).toEqual([]);
    project.undo();
    expect(project.linkedClips(source.id).map(({ id }) => id)).toEqual([a.id]);
    source.midi.edit((notes) => (notes[0].pitch = 2));
    expect(pitches(asMidi(project.tracks[0].clips.find(({ id }) => id === a.id)))).toEqual([2, 64]);
  });

  it("resize keeps the link, each member with its own window; a split makes independent pieces; remove leaves the rest linked", () => {
    const { project, source } = setup();
    const a = asMidi(project.duplicateClip(source.id, 8, { linked: true }));
    const b = asMidi(project.duplicateClip(source.id, 16, { linked: true }));
    project.resizeClip(a.id, { end: 10 });
    expect(project.linkedClips(source.id).map(({ id }) => id)).toEqual([a.id, b.id]);
    expect(project.tracks[0].clips.find(({ id }) => id === a.id)!.duration).toBe(2);
    const trimmed = asMidi(project.resizeClip(a.id, { start: 9 }));
    expect([trimmed.time, trimmed.sourceOffset]).toEqual([9, 1]);
    expect(project.linkedClips(a.id).map(({ id }) => id)).toEqual([source.id, b.id]);
    const [left, right] = project.splitClip(b.id, 2);
    expect(project.linkedClips(left.id)).toEqual([]);
    expect(project.linkedClips(right.id)).toEqual([]);
    expect(project.linkedClips(source.id).map(({ id }) => id)).toEqual([a.id]);
    project.makeClipUnique(a.id);
    expect(project.linkedClips(source.id)).toEqual([]);
    const other = asMidi(project.duplicateClip(source.id, 24, { linked: true }));
    expect(project.linkedClips(source.id)).toHaveLength(1);
    project.removeClip(other.id);
    expect(project.linkedClips(source.id)).toEqual([]);
    const c = project.duplicateClip(source.id, 30, { linked: true });
    const d = project.duplicateClip(source.id, 40, { linked: true });
    project.removeClip(c.id);
    expect(project.linkedClips(source.id).map(({ id }) => id)).toEqual([d.id]);
    expect(() => source.midi.edit((notes) => (notes[0].pitch = 3))).not.toThrow();
    expect(pitches(asMidi(d))).toEqual([3, 64]);
  });

  it("setClipLoop and snapshots keep the link", () => {
    const { project, source } = setup();
    const copy = project.duplicateClip(source.id, 8, { linked: true });
    project.setClipLoop(copy.id, { startBeat: 0, endBeat: 2 });
    expect(project.linkedClips(source.id).map(({ id }) => id)).toEqual([copy.id]);
    const snapshot = project.snapshot();
    expect(snapshot.linkedClips(source.id).map(({ id }) => id)).toEqual([copy.id]);
    source.midi.edit((notes) => (notes[0].pitch = 99));
    expect(snapshot.linkedClips(source.id)).toHaveLength(1);
    expect(pitches(asMidi(snapshot.tracks[0].clips[0]))).toEqual([60, 64]);
    snapshot.dispose();
  });

  it("overview lists linkedTo only for linked clips", () => {
    const { project, source } = setup();
    const copy = project.duplicateClip(source.id, 8, { linked: true });
    const solo = project.duplicateClip(source.id, 16);
    const clips = project.overview().tracks[0].clips;
    expect(clips.find(({ id }) => id === source.id)!.linkedTo).toEqual([copy.id]);
    expect(clips.find(({ id }) => id === copy.id)!.linkedTo).toEqual([source.id]);
    expect("linkedTo" in clips.find(({ id }) => id === solo.id)!).toBe(false);
  });

  it("applyEdits: copyRange makes independent copies, makeClipUnique unlinks, editNotes reaches every placement", () => {
    const { project, source } = setup();
    const copy = asMidi(project.duplicateClip(source.id, 8, { linked: true }));
    let receipt = project.applyEdits({
      expectedVersion: project.cells.version.value,
      label: "Soften",
      ops: [{ type: "editNotes", clip: { clipId: source.id }, notes: [{ id: "n1", velocity: 0.1 }] }],
    });
    expect(receipt.status).toBe("applied");
    expect(copy.midi.notes.value[0].velocity).toBe(0.1);
    receipt = project.applyEdits({
      expectedVersion: project.cells.version.value,
      label: "Copy",
      ops: [{ type: "copyRange", range: { startBeat: 0, endBeat: 4 }, atBeat: 20, placement: "insert", as: "c" }],
    });
    expect(receipt.status).toBe("applied");
    const copied = project.tracks[0].clips.find((clip) => clip.time >= 20)!;
    expect(project.linkedClips(copied.id)).toEqual([]);
    receipt = project.applyEdits({
      expectedVersion: project.cells.version.value,
      label: "Unlink",
      ops: [{ type: "makeClipUnique", clip: { clipId: copy.id } }],
    });
    expect(receipt.status).toBe("applied");
    expect(project.linkedClips(source.id)).toEqual([]);
    expect(project.undo().status).toBe("applied");
    expect(project.linkedClips(source.id)).toHaveLength(1);
  });
});

describe("linked clips: later edits and shared events", () => {
  it("undoing makeClipUnique does not overwrite a later edit of the clips it was linked to", () => {
    const { project, source } = setup();
    const a = asMidi(project.duplicateClip(source.id, 8, { linked: true }));
    project.clearHistory();
    project.edit("Unlink", () => void project.makeClipUnique(a.id));
    source.midi.edit((notes) => (notes[0].pitch = 99));
    expect(project.undo().status).toBe("conflict");
    expect(pitches(source)).toEqual([99, 64]);
    expect(project.linkedClips(source.id)).toEqual([]);
  });

  it("redoing a link does not overwrite a later edit of the source", () => {
    const { project, source } = setup();
    project.edit("Link", () => void project.duplicateClip(source.id, 8, { linked: true }));
    expect(project.undo().status).toBe("applied");
    source.midi.edit((notes) => (notes[0].pitch = 99));
    expect(project.redo().status).toBe("conflict");
    expect(pitches(source)).toEqual([99, 64]);
    expect(project.linkedClips(source.id)).toEqual([]);
  });

  it("undo and redo of a link or unlink still apply when nothing else changed", () => {
    const { project, source } = setup();
    project.edit("Link", () => void project.duplicateClip(source.id, 8, { linked: true }));
    expect(project.undo().status).toBe("applied");
    expect(project.redo().status).toBe("applied");
    expect(project.linkedClips(source.id)).toHaveLength(1);
    const a = project.linkedClips(source.id)[0];
    project.edit("Unlink", () => void project.makeClipUnique(a.id));
    expect(project.undo().status).toBe("applied");
    expect(project.redo().status).toBe("applied");
    expect(project.linkedClips(source.id)).toEqual([]);
  });

  it("undoing addMidiClip({ linkedTo }) and removeClip of a linked clip leave later edits to the group alone", () => {
    const { project, keys, source } = setup();
    project.clearHistory();
    project.edit("Add", () => void project.addMidiClip(keys.id, { duration: 2, notes: [] }, 8, { linkedTo: source.id }));
    source.midi.edit((notes) => (notes[0].pitch = 99));
    expect(project.undo().status).toBe("conflict");
    expect(pitches(source)).toEqual([99, 64]);
    project.clearHistory();
    const copy = project.duplicateClip(source.id, 8, { linked: true });
    project.edit("Remove", () => project.removeClip(copy.id));
    source.midi.edit((notes) => (notes[0].pitch = 98));
    expect(project.undo().status).toBe("conflict");
    expect(pitches(source)).toEqual([98, 64]);
  });

  it("a linked clip shares the group's events; addMidiClip({ linkedTo }) ignores the events and notes it is given, and save keeps them", () => {
    const project = new Project({ bpm: 120 });
    const keys = project.addTrack("Keys", "midi");
    const cc = { time: 1, data: new Uint8Array([0xb0, 7, 100]) };
    const s = project.addMidiClip(keys.id, { duration: 4, notes: [note("n1")], events: [cc] }, 0);
    const linked = project.addMidiClip(keys.id, { duration: 4, notes: [note("zz")], events: [] }, 8, { linkedTo: s.id });
    expect(linked.events).toHaveLength(1);
    expect(pitches(linked)).toEqual([60]);
    const dup = project.duplicateClip(s.id, 16, { linked: true }) as MidiClip;
    expect(dup.events).toHaveLength(1);
    const reopened = openDawProject(saveDawProject(project)).project;
    for (const id of [s.id, linked.id, dup.id]) {
      const clip = reopened.tracks[0].clips.find((item) => item.id === id) as MidiClip;
      expect(clip.events).toHaveLength(1);
    }
    expect(project.makeClipUnique(linked.id)).toBeDefined();
    expect((project.tracks[0].clips.find((c) => c.id === linked.id) as MidiClip).events).toHaveLength(1);
    reopened.dispose();
  });

  it("setClipLoop undo and redo respect later note edits for unlinked timeline and slot clips", () => {
    const { project, keys, source } = setup();
    project.clearHistory();
    project.edit("Loop", () => void project.setClipLoop(source.id, { startBeat: 0, endBeat: 2 }));
    const now = () => asMidi(project.tracks[0].clips.find(({ id }) => id === source.id));
    now().midi.edit((notes) => (notes[0].pitch = 99));
    expect(project.undo().status).toBe("conflict");
    expect(now().loop).toBeDefined();
    expect(pitches(now())).toEqual([99, 64]);
    project.clearHistory();
    project.edit("Loop off", () => void project.setClipLoop(source.id, null));
    expect(project.undo().status).toBe("applied");
    now().midi.edit((notes) => (notes[0].pitch = 98));
    expect(project.redo().status).toBe("conflict");
    expect(pitches(now())).toEqual([98, 64]);
    expect(now().loop).toBeDefined();

    const sceneId = sessionFor(project).addScene().id;
    const slotKey = { sceneId, trackId: keys.id };
    const slot = sessionFor(project).setMidiClip(slotKey, { duration: 4, notes: [note("s1")] });
    project.clearHistory();
    const slotNow = () => asMidi(sessionFor(project).clipAt(slotKey));
    project.edit("Loop slot", () => void project.setClipLoop(slot.id, { startBeat: 0, endBeat: 2 }));
    slotNow().midi.edit((notes) => (notes[0].pitch = 97));
    expect(project.undo().status).toBe("conflict");
    expect(pitches(slotNow())).toEqual([97]);
  });
});

describe("linked clips in DAWproject files", () => {
  it("writes the notes once and references them, and reopening keeps the groups, ids, positions and note ids", () => {
    const { project, keys, source } = setup();
    const bass = project.addTrack("Bass", "midi");
    const a = project.duplicateClip(source.id, 8, { linked: true });
    const b = project.duplicateClip(source.id, 0, { trackId: bass.id, linked: true });
    project.setClipLoop(a.id, { startBeat: 0, endBeat: 2 });
    const solo = project.duplicateClip(source.id, 16);
    const bytes = saveDawProject(project);
    const xml = new TextDecoder().decode(unzipSync(bytes)["project.xml"]);
    expect(xml.match(/<Notes /g)).toHaveLength(2);
    expect(xml.match(/reference="/g)).toHaveLength(2);
    const opened = openDawProject(bytes).project;
    const groups = opened.overview().tracks.flatMap((track) => track.clips);
    expect(
      groups
        .find(({ id }) => id === source.id)!
        .linkedTo?.slice()
        .sort(),
    ).toEqual([a.id, b.id].sort());
    expect(groups.find(({ id }) => id === b.id)!.linkedTo).toContain(a.id);
    expect("linkedTo" in groups.find(({ id }) => id === solo.id)!).toBe(false);
    expect(groups.find(({ id }) => id === a.id)!.startBeat).toBe(8);
    expect(opened.clipName(a.id)).toBe("Pattern");
    const reopened = opened.tracks.find(({ id }) => id === keys.id)!.clips.find(({ id }) => id === a.id) as MidiClip;
    expect(reopened.loop).toEqual({ startBeat: 0, endBeat: 2 });
    expect(reopened.midi.notes.value.map(({ id }) => id)).toEqual(["n1", "n2"]);
    reopened.midi.edit((notes) => (notes[0].pitch = 100));
    expect((opened.tracks.find(({ id }) => id === bass.id)!.clips[0] as MidiClip).midi.notes.value[0].pitch).toBe(100);
    opened.dispose();
  });

  /** A file from another program: the arrangement's clips are replaced by hand-written XML. */
  const document = (clips: string) => {
    const project = new Project({ bpm: 120 });
    project.addMidiClip(project.addTrack("Keys", "midi").id, { duration: 4, notes: [] }, 0);
    const files = unzipSync(saveDawProject(project));
    project.dispose();
    const xml = new TextDecoder().decode(files["project.xml"]).replace(/(<Clips [^>]*>)[\s\S]*?(<\/Clips>)/, `$1${clips}$2`);
    return zipSync({ ...files, "project.xml": strToU8(xml) });
  };
  const content =
    `<Clip name="A" time="0" duration="4" contentTimeUnit="beats"><Lanes id="lanesA" timeUnit="beats">` +
    `<Notes id="notesA" timeUnit="beats"><Note time="0" duration="1" channel="0" key="60" vel="0.5"/></Notes></Lanes></Clip>`;

  it("opens another program's reference clips, including a reference that comes before its content", () => {
    const ref = (time: number, to: string) => `<Clip name="R" time="${time}" duration="2" contentTimeUnit="beats" reference="${to}"/>`;
    const { project } = openDawProject(document(ref(8, "notesA") + content + ref(16, "lanesA")));
    const clips = project.tracks[0].clips as MidiClip[];
    expect(clips.map(({ time }) => time)).toEqual([0, 8, 16]);
    expect(clips[1].duration).toBe(2);
    expect(project.linkedClips(clips[0].id)).toHaveLength(2);
    clips[0].midi.edit((notes) => (notes[0].pitch = 70));
    expect(clips[2].midi.notes.value[0].pitch).toBe(70);
    project.dispose();
  });

  it("fails clearly when a reference names nothing", () => {
    const ref = `<Clip time="8" duration="2" contentTimeUnit="beats" reference="ghost"/>`;
    expect(() => openDawProject(document(content + ref))).toThrow('Project clip reference "ghost" does not match any MIDI notes');
  });
});
