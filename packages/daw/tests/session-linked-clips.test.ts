import { describe, expect, it } from "vitest";
import { strToU8, unzipSync, zipSync } from "fflate";
import { MidiClip, Project, sessionFor } from "../src/project";
import { openDawProject, saveDawProject } from "../src/dawproject";

const note = (id: string, start = 0, pitch = 60) => ({ id, start, duration: 1, pitch, velocity: 0.8 });
const asMidi = (clip: unknown) => clip as MidiClip;
const pitches = (clip: unknown) => asMidi(clip).midi.notes.value.map((n) => n.pitch);

/** A pattern stored in scene one's slot, with a timeline copy linked to it. */
function pattern() {
  const project = new Project({ bpm: 120 });
  const keys = project.addTrack("Keys", "midi");
  const session = sessionFor(project);
  const scene = session.addScene({ name: "Pattern 1" });
  const slot = { sceneId: scene.id, trackId: keys.id };
  const stored = session.setMidiClip(slot, { duration: 4, notes: [note("n1"), note("n2", 1, 64)] }, { name: "Pattern" });
  return { project, session, keys, scene, slot, stored };
}

describe("linked clips across Session slots and the timeline", () => {
  it("copyToArrangement({ linked }) shares the slot clip's notes; an edit through either side changes both", () => {
    const { project, session, slot, stored, keys } = pattern();
    const placed = session.copyToArrangement(slot, { atBeat: 8, linked: true });
    expect(project.linkedClips(stored.id).map(({ id }) => id)).toEqual([placed.id]);
    expect(project.linkedClips(placed.id).map(({ id }) => id)).toEqual([stored.id]);
    expect(project.clipName(placed.id)).toBe("Pattern");
    asMidi(placed).midi.edit((notes) => (notes[0].pitch = 70));
    expect(pitches(stored)).toEqual([70, 64]);
    stored.midi.edit((notes) => (notes[1].pitch = 71));
    expect(pitches(placed)).toEqual([70, 71]);
    // Without `linked` the copy stays independent.
    const solo = session.copyToArrangement(slot, { atBeat: 16, trackId: keys.id });
    expect(project.linkedClips(solo.id)).toEqual([]);
  });

  it("copyToSlot puts a linked or independent copy of a timeline or slot clip in a slot", () => {
    const { project, session, keys, stored } = pattern();
    const timeline = project.addMidiClip(keys.id, { duration: 2, notes: [note("t1", 0, 50)] }, 0);
    const two = session.addScene();
    const three = session.addScene();
    const linked = session.copyToSlot(timeline.id, { sceneId: two.id, trackId: keys.id }, { linked: true });
    expect(session.clipAt({ sceneId: two.id, trackId: keys.id })).toBe(linked);
    expect(project.linkedClips(timeline.id).map(({ id }) => id)).toEqual([linked.id]);
    const fromSlot = session.copyToSlot(stored.id, { sceneId: three.id, trackId: keys.id }, { linked: true });
    expect(project.linkedClips(stored.id).map(({ id }) => id)).toEqual([fromSlot.id]);
    const independent = session.copyToSlot(timeline.id, { sceneId: three.id, trackId: keys.id });
    expect(project.linkedClips(independent.id)).toEqual([]);
    expect(project.linkedClips(fromSlot.id)).toEqual([]);
    expect(() => session.copyToSlot("ghost", { sceneId: two.id, trackId: keys.id })).toThrow("Project clip does not exist.");
    const audio = project.addTrack("Audio", "audio");
    expect(() => session.copyToSlot(timeline.id, { sceneId: two.id, trackId: audio.id })).toThrow("must match its track kind");
  });

  it("addMidiClip({ linkedTo }) accepts a slot clip, and an audio clip never links", () => {
    const { project, keys, stored } = pattern();
    const copy = project.addMidiClip(keys.id, { duration: 4, notes: [] }, 4, { linkedTo: stored.id });
    expect(pitches(copy)).toEqual([60, 64]);
    const audio = project.addTrack("Audio", "audio");
    const session = sessionFor(project);
    const clip = session.setAudioClip({ sceneId: session.scenes[0].id, trackId: audio.id }, { sampleRate: 8000, channels: [new Float32Array(800)] });
    expect(() => session.copyToSlot(clip.id, { sceneId: session.scenes[0].id, trackId: audio.id }, { linked: true })).toThrow("only MIDI clips");
  });

  it("overview lists linkedTo in both tracks and session; makeClipUnique works for a slot clip and is one undo step", () => {
    const { project, session, slot, stored } = pattern();
    const placed = session.copyToArrangement(slot, { atBeat: 8, linked: true });
    const view = project.overview();
    expect(view.tracks[0].clips[0].linkedTo).toEqual([stored.id]);
    expect(view.session[0].clips[0].linkedTo).toEqual([placed.id]);
    project.clearHistory();
    const own = project.edit("Unique", () => asMidi(project.makeClipUnique(stored.id)));
    expect(own.id).toBe(stored.id);
    expect(session.clipAt(slot)).toBe(own);
    expect(project.linkedClips(placed.id)).toEqual([]);
    own.midi.edit((notes) => (notes[0].pitch = 99));
    expect(pitches(placed)).toEqual([60, 64]);
    expect("linkedTo" in project.overview().session[0].clips[0]).toBe(false);
    expect(project.undo().status).toBe("conflict");
    own.midi.edit((notes) => (notes[0].pitch = 60));
    expect(project.undo().status).toBe("applied");
    expect(project.linkedClips(placed.id).map(({ id }) => id)).toEqual([stored.id]);
  });

  it("an edit through a slot clip inside project.edit is one undo step across the group, and a later edit blocks it", () => {
    const { project, session, slot, stored } = pattern();
    const placed = session.copyToArrangement(slot, { atBeat: 8, linked: true });
    project.clearHistory();
    project.edit("Transpose", () => stored.midi.edit((notes) => (notes[0].pitch = 80)));
    expect(pitches(placed)[0]).toBe(80);
    expect(project.undo().status).toBe("applied");
    expect(pitches(placed)[0]).toBe(60);
    expect(project.redo().status).toBe("applied");
    expect(pitches(stored)[0]).toBe(80);
    expect(project.undo().status).toBe("applied");
    asMidi(placed).midi.edit((notes) => (notes[1].pitch = 90));
    expect(project.redo().status).toBe("conflict");
    expect(pitches(stored)).toEqual([60, 90]);
  });

  it("clearing a slot or removing a scene leaves the rest of the group linked and alive; removing the timeline clip keeps the slot's notes", () => {
    const { project, session, slot, stored, keys } = pattern();
    const a = session.copyToArrangement(slot, { atBeat: 8, linked: true });
    const b = session.copyToArrangement(slot, { atBeat: 16, linked: true });
    session.clearSlot(slot);
    expect(project.linkedClips(a.id).map(({ id }) => id)).toEqual([b.id]);
    expect(pitches(a)).toEqual([60, 64]);
    const scene = session.addScene();
    const again = session.copyToSlot(a.id, { sceneId: scene.id, trackId: keys.id }, { linked: true });
    project.removeClip(a.id);
    expect(project.linkedClips(again.id).map(({ id }) => id)).toEqual([b.id]);
    session.removeScene(scene.id);
    expect(project.linkedClips(b.id)).toEqual([]);
    expect(pitches(b)).toEqual([60, 64]);
    expect(stored).toBeDefined();
  });

  it("duplicateScene copies stay independent of the original and of the timeline", () => {
    const { project, session, scene, slot, stored, keys } = pattern();
    const placed = session.copyToArrangement(slot, { atBeat: 8, linked: true });
    const copy = session.duplicateScene(scene.id);
    const duplicated = session.clipAt({ sceneId: copy.id, trackId: keys.id })!;
    expect(project.linkedClips(duplicated.id)).toEqual([]);
    expect(project.linkedClips(stored.id).map(({ id }) => id)).toEqual([placed.id]);
  });

  it("snapshots keep links that span slots and the timeline", () => {
    const { project, session, slot, stored } = pattern();
    const placed = session.copyToArrangement(slot, { atBeat: 8, linked: true });
    const copy = project.snapshot();
    expect(copy.linkedClips(stored.id).map(({ id }) => id)).toEqual([placed.id]);
    copy.dispose();
  });

  it("findClips reports a timeline clip linked to a slot clip", () => {
    const { project, session, slot, stored } = pattern();
    const placed = session.copyToArrangement(slot, { atBeat: 8, linked: true });
    expect(project.findClips({ trackName: "Keys" })[0].linkedTo).toEqual([stored.id]);
    expect(placed.id).not.toBe(stored.id);
  });
});

describe("shared content across Session slots and the timeline in DAWproject files", () => {
  it("writes the notes once and references them, and reopening restores the groups both ways", () => {
    const { project, session, slot, stored, keys, scene } = pattern();
    const placed = session.copyToArrangement(slot, { atBeat: 8, linked: true });
    const two = session.addScene();
    const second = session.copyToSlot(stored.id, { sceneId: two.id, trackId: keys.id }, { linked: true });
    const bytes = saveDawProject(project);
    const xml = new TextDecoder().decode(unzipSync(bytes)["project.xml"]);
    expect(xml.match(/<Notes /g)).toHaveLength(1);
    expect(xml.match(/reference="/g)).toHaveLength(2);
    const opened = openDawProject(bytes).project;
    const group = opened.linkedClips(stored.id).map(({ id }) => id);
    expect(group.sort()).toEqual([placed.id, second.id].sort());
    expect(sessionFor(opened).clipAt({ sceneId: scene.id, trackId: keys.id })!.id).toBe(stored.id);
    expect(sessionFor(opened).clipAt({ sceneId: two.id, trackId: keys.id })!.id).toBe(second.id);
    expect(opened.overview().session[1].clips[0].linkedTo).toContain(stored.id);
    expect(opened.clipName(second.id)).toBe("Pattern");
    asMidi(opened.tracks[0].clips[0]).midi.edit((notes) => (notes[0].pitch = 100));
    expect(pitches(sessionFor(opened).clipAt({ sceneId: two.id, trackId: keys.id }))[0]).toBe(100);
    opened.dispose();
  });

  it("a group whose first member is on the timeline round-trips with the slot as the reference", () => {
    const project = new Project({ bpm: 120 });
    const keys = project.addTrack("Keys", "midi");
    const source = project.addMidiClip(keys.id, { duration: 4, notes: [note("n1")] }, 0, { name: "Riff" });
    const session = sessionFor(project);
    const scene = session.addScene();
    const slotted = session.copyToSlot(source.id, { sceneId: scene.id, trackId: keys.id }, { linked: true });
    const bytes = saveDawProject(project);
    const xml = new TextDecoder().decode(unzipSync(bytes)["project.xml"]);
    expect(xml.match(/<Notes /g)).toHaveLength(1);
    const opened = openDawProject(bytes).project;
    expect(opened.linkedClips(source.id).map(({ id }) => id)).toEqual([slotted.id]);
    opened.dispose();
  });

  /** A file from another program: an arrangement clip references the notes of a clip that sits in a scene. */
  const handWritten = (reference: string) => {
    const { project, session, slot, keys } = pattern();
    session.copyToArrangement(slot, { atBeat: 0, trackId: keys.id });
    const files = unzipSync(saveDawProject(project));
    project.dispose();
    let xml = new TextDecoder().decode(files["project.xml"]);
    // Drop the arrangement's own content and put the reference in its place.
    xml = xml.replace(
      /(<Clips [^>]*>)[\s\S]*?(<\/Clips>)/,
      `$1<Clip name="Ref" time="8" duration="2" contentTimeUnit="beats" reference="${reference}"/>$2`,
    );
    return zipSync({ ...files, "project.xml": strToU8(xml) });
  };

  it("opens an arrangement clip that references a slot clip's content, by Notes or Lanes id", () => {
    for (const to of ["notes", "content"]) {
      const source = pattern();
      const id = source.stored.id;
      source.project.dispose();
      const { project } = openDawProject(handWritten(`${id}-${to}`));
      const slotClip = sessionFor(project).clipAt({ sceneId: sessionFor(project).scenes[0].id, trackId: project.tracks[0].id })!;
      const ref = project.tracks[0].clips[0] as MidiClip;
      expect(ref.time).toBe(8);
      expect(ref.duration).toBe(2);
      expect(project.linkedClips(slotClip.id).map(({ id: other }) => other)).toEqual([ref.id]);
      ref.midi.edit((notes) => (notes[0].pitch = 77));
      expect(pitches(slotClip)[0]).toBe(77);
      project.dispose();
    }
  });

  it("an unknown reference still fails clearly", () => {
    expect(() => openDawProject(handWritten("ghost"))).toThrow('Project clip reference "ghost" does not match any MIDI notes');
  });
});
