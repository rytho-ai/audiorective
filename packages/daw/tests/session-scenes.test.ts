import { describe, expect, test } from "vitest";
import { strFromU8, unzipSync } from "fflate";
import { effect } from "@audiorective/core";
import { Project, openDawProject, portabilityReport, saveDawProject, sessionFor } from "../src";
import type { AudioClip, MidiClip, ProjectClip, SessionSlot } from "../src";

const RATE = 8;
const UNKNOWN = "Project session has no scene or track with that id.";
const KIND = "Project session slot clip must match its track kind.";
const recording = () => Float32Array.from({ length: 4 * RATE }, (_, index) => (index + 1) / 100);
const notes = (...pitches: number[]) => pitches.map((pitch, index) => ({ pitch, velocity: 1, start: index, duration: 0.5 }));
const audio = (clip: ProjectClip | null | undefined): AudioClip => {
  if (!clip || clip.kind !== "audio") throw new Error("Expected an audio clip");
  return clip;
};
const midi = (clip: ProjectClip | null | undefined): MidiClip => {
  if (!clip || clip.kind !== "midi") throw new Error("Expected a MIDI clip");
  return clip;
};

function song() {
  const project = new Project({ bpm: 120 });
  const keys = project.addTrack("Keys", "midi");
  const bass = project.addTrack("Bass", "midi");
  const vocal = project.addTrack("Vocal", "audio");
  const bus = project.addTrack("Bus", "bus", { busRole: "submix" });
  const session = sessionFor(project);
  const [a, b] = [session.addScene({ name: "Intro" }), session.addScene({ name: "Drop" })];
  const slot = (track: { id: string }, scene: { id: string }): SessionSlot => ({ trackId: track.id, sceneId: scene.id });
  return { project, session, keys, bass, vocal, bus, a, b, slot };
}

describe("sessionFor", () => {
  test("returns one object per Project", () => {
    const { project, session } = song();
    expect(sessionFor(project)).toBe(session);
    expect(sessionFor(new Project())).not.toBe(session);
  });

  test("midiClipAt and audioClipAt narrow clipAt by kind", () => {
    const { session, keys, vocal, a, b, slot } = song();
    const m = session.setMidiClip(slot(keys, a), { duration: 4, notes: notes(60) });
    const au = session.setAudioClip(slot(vocal, a), { sampleRate: RATE, channels: [recording()] });
    const notesNow: number = session.midiClipAt(slot(keys, a))!.midi.notes.value[0].pitch; // typed: no cast
    const frames: number = session.audioClipAt(slot(vocal, a))!.channels[0].length;
    expect(notesNow).toBe(60);
    expect(frames).toBe(4 * RATE);
    expect(session.midiClipAt(slot(keys, a))).toBe(m);
    expect(session.audioClipAt(slot(vocal, a))).toBe(au);
    expect(session.midiClipAt(slot(vocal, a))).toBeNull();
    expect(session.audioClipAt(slot(keys, a))).toBeNull();
    expect(session.midiClipAt(slot(keys, b))).toBeNull();
    expect(session.midiClipAt({ trackId: "nope", sceneId: a.id })).toBeNull();
  });

  test("a new Project has no scenes", () => {
    expect(sessionFor(new Project()).scenes).toEqual([]);
  });
});

describe("scenes", () => {
  test("addScene appends, names by default and inserts after a scene", () => {
    const { session, a, b } = song();
    const third = session.addScene();
    expect(third.name).toBe("Scene 3");
    expect(session.scenes.map(({ id }) => id)).toEqual([a.id, b.id, third.id]);
    const between = session.addScene({ name: "Verse", afterSceneId: a.id });
    expect(session.scenes.map(({ id }) => id)).toEqual([a.id, between.id, b.id, third.id]);
    expect(Object.isFrozen(between)).toBe(true);
  });

  test("renameScene changes the name and nothing else; an equal name is no change", () => {
    const { project, session, a } = song();
    const before = project.cells.version.value;
    session.renameScene(a.id, "Intro");
    expect(project.cells.version.value).toBe(before);
    session.renameScene(a.id, "  Opening ");
    expect(session.scenes[0]).toEqual({ id: a.id, name: "Opening" });
  });

  test("removeScene drops the scene and the clips in its slots", () => {
    const { project, session, keys, a, b, slot } = song();
    const clip = session.setMidiClip(slot(keys, a), { notes: notes(60), duration: 4 }, { name: "Hook" });
    session.removeScene(a.id);
    expect(session.scenes.map(({ id }) => id)).toEqual([b.id]);
    expect(session.clipAt(slot(keys, a))).toBeNull();
    expect(project.clipName(clip.id)).toBeUndefined();
    // The id is free again.
    expect(() => project.addMidiClip(keys.id, { notes: [], duration: 1 }, 0, { id: clip.id })).not.toThrow();
  });

  test("duplicateScene copies every slot clip with new ids, names, loops and notes, right after the source by default", () => {
    const { project, session, keys, vocal, a, b, slot } = song();
    const hook = session.setMidiClip(slot(keys, a), { notes: notes(60, 62), duration: 4 }, { name: "Hook" });
    project.setClipLoop(hook.id, { startBeat: 0, endBeat: 2 });
    const take = session.setAudioClip(slot(vocal, a), { sampleRate: RATE, channels: [recording()] }, { name: "Take" });
    const copy = session.duplicateScene(a.id);
    expect(session.scenes.map(({ id }) => id)).toEqual([a.id, copy.id, b.id]);
    const copiedMidi = midi(session.clipAt(slot(keys, copy)));
    const copiedAudio = audio(session.clipAt(slot(vocal, copy)));
    expect(copiedMidi.id).not.toBe(hook.id);
    expect(copiedAudio.id).not.toBe(take.id);
    expect(copiedMidi.loop).toEqual({ startBeat: 0, endBeat: 2 });
    expect(copiedMidi.midi.notes.value.map((note) => note.pitch)).toEqual([60, 62]);
    expect(project.clipName(copiedMidi.id)).toBe("Hook");
    expect(project.clipName(copiedAudio.id)).toBe("Take");
    expect(copiedAudio.channels[0]).not.toBe(take.channels[0]);
    // The copy is independent of the source.
    copiedMidi.midi.edit((draft) => void draft.pop());
    expect(hook.midi.notes.value).toHaveLength(2);
    const last = session.duplicateScene(a.id, { afterSceneId: b.id });
    expect(session.scenes.at(-1)!.id).toBe(last.id);
  });
});

describe("slots", () => {
  test("setMidiClip and setAudioClip fill a slot at time 0, replace what it held and name the clip", () => {
    const { project, session, keys, vocal, a, slot } = song();
    const first = session.setMidiClip(slot(keys, a), { notes: notes(60), duration: 4 });
    expect(first.time).toBe(0);
    expect(session.clipAt(slot(keys, a))).toBe(first);
    const second = session.setMidiClip(slot(keys, a), { notes: notes(64), duration: 2 }, { name: "Second" });
    expect(session.clipAt(slot(keys, a))).toBe(second);
    expect(project.clipName(second.id)).toBe("Second");
    expect(project.clipName(first.id)).toBeUndefined();
    const take = session.setAudioClip(slot(vocal, a), { sampleRate: RATE, channels: [recording()] });
    expect(take.time).toBe(0);
    expect(take.duration).toBe(4);
    expect(session.clipAt(slot(vocal, a))).toBe(take);
    // Slot clips are not on the timeline.
    expect(project.tracks.flatMap((track) => track.clips)).toEqual([]);
    expect(project.findClips({})).toEqual([]);
    expect(project.overview().tracks.flatMap((track) => track.clips)).toEqual([]);
  });

  test("clearSlot empties a slot; an empty slot stays empty", () => {
    const { session, keys, a, slot } = song();
    session.setMidiClip(slot(keys, a), { notes: [], duration: 1 });
    session.clearSlot(slot(keys, a));
    expect(session.clipAt(slot(keys, a))).toBeNull();
    expect(() => session.clearSlot(slot(keys, a))).not.toThrow();
  });

  test("moveClip moves the clip with its id to a track of the same kind and replaces the target", () => {
    const { project, session, keys, bass, a, b, slot } = song();
    const clip = session.setMidiClip(slot(keys, a), { notes: notes(60), duration: 4 }, { name: "Moved" });
    const other = session.setMidiClip(slot(bass, b), { notes: notes(40), duration: 4 }, { name: "Gone" });
    session.moveClip(slot(keys, a), slot(bass, b));
    expect(session.clipAt(slot(keys, a))).toBeNull();
    expect(session.clipAt(slot(bass, b))).toBe(clip);
    expect(project.clipName(clip.id)).toBe("Moved");
    expect(project.clipName(other.id)).toBeUndefined();
    session.moveClip(slot(bass, b), slot(bass, b));
    expect(session.clipAt(slot(bass, b))).toBe(clip);
  });

  test("copyToArrangement places a copy at a beat or at seconds and leaves the slot alone", () => {
    const { project, session, keys, bass, vocal, a, slot } = song();
    const hook = session.setMidiClip(slot(keys, a), { notes: notes(60), duration: 4 }, { name: "Hook" });
    const placed = midi(session.copyToArrangement(slot(keys, a), { atBeat: 8 }));
    expect(placed.id).not.toBe(hook.id);
    expect(placed.time).toBe(8);
    expect(project.clipName(placed.id)).toBe("Hook");
    expect(project.tracks.find((track) => track.id === keys.id)!.clips).toEqual([placed]);
    expect(session.clipAt(slot(keys, a))).toBe(hook);
    // 120 bpm: 2 seconds is 4 beats.
    expect(midi(session.copyToArrangement(slot(keys, a), { atSeconds: 2, trackId: bass.id })).time).toBe(4);
    const take = session.setAudioClip(slot(vocal, a), { sampleRate: RATE, channels: [recording()] });
    const copy = audio(session.copyToArrangement(slot(vocal, a), { atBeat: 4 }));
    expect(copy.time).toBe(2);
    expect(copy.channels[0]).not.toBe(take.channels[0]);
    expect(audio(session.copyToArrangement(slot(vocal, a), { atSeconds: 7 })).time).toBe(7);
  });

  test("copyToArrangement needs exactly one position, a track of the clip's kind and a clip", () => {
    const { session, keys, vocal, a, b, slot } = song();
    session.setMidiClip(slot(keys, a), { notes: [], duration: 1 });
    const both = "Project session copyToArrangement needs exactly one of atBeat and atSeconds.";
    expect(() => session.copyToArrangement(slot(keys, a), {})).toThrow(new RangeError(both));
    expect(() => session.copyToArrangement(slot(keys, a), { atBeat: 1, atSeconds: 1 })).toThrow(new RangeError(both));
    expect(() => session.copyToArrangement(slot(keys, a), { atBeat: 1, trackId: vocal.id })).toThrow(new RangeError(KIND));
    expect(() => session.copyToArrangement(slot(keys, a), { atBeat: 1, trackId: "nope" })).toThrow(new RangeError(UNKNOWN));
    expect(() => session.copyToArrangement(slot(keys, a), { atBeat: -1 })).toThrow(
      new RangeError("Project clip time must be finite and non-negative."),
    );
    expect(() => session.copyToArrangement(slot(keys, b), { atBeat: 1 })).toThrow(new RangeError("Project session slot has no clip."));
  });

  test("errors name the unknown scene or track and a clip of the wrong kind", () => {
    const { project, session, keys, vocal, bus, a, slot } = song();
    const pcm = { sampleRate: RATE, channels: [recording()] };
    const data = { notes: [], duration: 1 };
    expect(() => session.setMidiClip({ trackId: keys.id, sceneId: "nope" }, data)).toThrow(new RangeError(UNKNOWN));
    expect(() => session.setMidiClip({ trackId: "nope", sceneId: a.id }, data)).toThrow(new RangeError(UNKNOWN));
    expect(() => session.setAudioClip({ trackId: "nope", sceneId: a.id }, pcm)).toThrow(new RangeError(UNKNOWN));
    expect(() => session.clearSlot({ trackId: keys.id, sceneId: "nope" })).toThrow(new RangeError(UNKNOWN));
    expect(() => session.moveClip(slot(keys, a), { trackId: "nope", sceneId: a.id })).toThrow(new RangeError(UNKNOWN));
    expect(() => session.renameScene("nope", "x")).toThrow(new RangeError(UNKNOWN));
    expect(() => session.removeScene("nope")).toThrow(new RangeError(UNKNOWN));
    expect(() => session.duplicateScene("nope")).toThrow(new RangeError(UNKNOWN));
    expect(() => session.addScene({ afterSceneId: "nope" })).toThrow(new RangeError(UNKNOWN));
    expect(() => session.setMidiClip(slot(vocal, a), data)).toThrow(new RangeError(KIND));
    expect(() => session.setAudioClip(slot(keys, a), pcm)).toThrow(new RangeError(KIND));
    expect(() => session.setMidiClip(slot(bus, a), data)).toThrow(new RangeError(KIND));
    session.setMidiClip(slot(keys, a), data);
    expect(() => session.moveClip(slot(keys, a), slot(vocal, a))).toThrow(new RangeError(KIND));
    expect(() => session.moveClip(slot(vocal, a), slot(keys, a))).toThrow(new RangeError("Project session slot has no clip."));
    expect(() => session.renameScene(a.id, "  ")).toThrow(new RangeError("Project session scene name must not be empty."));
    expect(session.clipAt({ trackId: "nope", sceneId: a.id })).toBeNull();
    // A failed call changes nothing.
    const version = project.cells.version.value;
    expect(() => session.setMidiClip(slot(vocal, a), data)).toThrow();
    expect(project.cells.version.value).toBe(version);
  });

  test("removing a track removes its slots", () => {
    const { project, session, keys, bass, a, b, slot } = song();
    const gone = session.setMidiClip(slot(keys, a), { notes: [], duration: 1 }, { name: "Gone" });
    const kept = session.setMidiClip(slot(bass, b), { notes: [], duration: 1 });
    project.removeTrack(keys.id);
    expect(session.clipAt(slot(keys, a))).toBeNull();
    expect(session.clipAt(slot(bass, b))).toBe(kept);
    expect(project.clipName(gone.id)).toBeUndefined();
    expect(session.scenes).toHaveLength(2);
  });
});

describe("slot clips are ordinary clips by id", () => {
  test("setClipLoop, resizeClip, setClipName, setAudioClipEnvelope and note edits work on them and stay in the slot", () => {
    const { project, session, keys, vocal, a, slot } = song();
    const hook = session.setMidiClip(slot(keys, a), { notes: notes(60, 62), duration: 4 });
    project.setClipLoop(hook.id, { startBeat: 0, endBeat: 2 });
    expect(midi(session.clipAt(slot(keys, a))).loop).toEqual({ startBeat: 0, endBeat: 2 });
    const resized = project.resizeClip(hook.id, { start: 1, end: 3 });
    expect(session.clipAt(slot(keys, a))).toBe(resized);
    expect(resized.time).toBe(0);
    project.setClipName(resized.id, "Renamed");
    expect(project.clipName(resized.id)).toBe("Renamed");
    midi(session.clipAt(slot(keys, a))).midi.edit((draft) => void (draft[0].velocity = 0.25));
    expect(midi(session.clipAt(slot(keys, a))).midi.notes.value[0].velocity).toBe(0.25);

    const take = session.setAudioClip(slot(vocal, a), { sampleRate: RATE, channels: [recording()] });
    const shaped = project.setAudioClipEnvelope(take.id, { gain: 0.5, fadeIn: 0.5, fadeOut: 0 });
    expect(session.clipAt(slot(vocal, a))).toBe(shaped);
    expect(shaped.envelope).toEqual({ gain: 0.5, fadeIn: 0.5, fadeOut: 0 });
    project.setClipLoop(take.id, { startSeconds: 1, endSeconds: 3 });
    expect(audio(session.clipAt(slot(vocal, a))).loop).toEqual({ startSeconds: 1, endSeconds: 3 });
    project.setClipLoop(take.id, null);
    expect(audio(session.clipAt(slot(vocal, a))).loop).toBeUndefined();
    expect(project.tracks.flatMap((track) => track.clips)).toEqual([]);
  });

  test("timeline-only methods never reach a slot clip", () => {
    const { project, session, keys, a, slot } = song();
    const hook = session.setMidiClip(slot(keys, a), { notes: notes(60), duration: 4 });
    expect(() => project.moveClip(hook.id, keys.id, 4)).toThrow();
    expect(() => project.duplicateClip(hook.id, 4)).toThrow("Project clip does not exist.");
    expect(() => project.splitClip(hook.id, 1)).toThrow("Project clip does not exist.");
    expect(() => project.removeClip(hook.id)).toThrow("Project clip does not exist.");
    project.addMidiClip(keys.id, { notes: [], duration: 8 }, 0);
    project.rippleDelete({ startBeat: 0, endBeat: 2 });
    expect(session.clipAt(slot(keys, a))).toBe(hook);
    expect(project.findClips({ range: { startBeat: 0, endBeat: 100 } }).map((clip) => clip.id)).not.toContain(hook.id);
  });

  test("applyEdits renames a slot clip and sets a note velocity in it", () => {
    const { project, session, keys, a, slot } = song();
    const hook = session.setMidiClip(slot(keys, a), { notes: notes(60), duration: 4 });
    const noteId = hook.midi.notes.value[0].id;
    const receipt = project.applyEdits({
      expectedVersion: project.cells.version.value,
      label: "Tweak",
      ops: [
        { type: "renameClip", clip: { clipId: hook.id }, name: "Tweaked" },
        { type: "setNoteVelocity", clip: { clipId: hook.id }, noteId, velocity: 0.3 },
      ],
    });
    expect(receipt.status).toBe("applied");
    expect(project.clipName(hook.id)).toBe("Tweaked");
    expect(hook.midi.notes.value[0].velocity).toBe(0.3);
    expect(project.undo().status).toBe("applied");
    expect(project.clipName(hook.id)).toBeUndefined();
    expect(hook.midi.notes.value[0].velocity).toBe(1);
  });
});

describe("version, undo and redo", () => {
  test("every session change advances the version", () => {
    const { project, session, keys, vocal, a, b, slot } = song();
    const seen = new Set<string>([project.cells.version.value]);
    const step = (change: () => void) => {
      change();
      const version = project.cells.version.value;
      expect(seen.has(version)).toBe(false);
      seen.add(version);
    };
    step(() => void session.addScene());
    step(() => session.renameScene(a.id, "Renamed"));
    step(() => void session.setMidiClip(slot(keys, a), { notes: notes(60), duration: 4 }));
    step(() => void session.setAudioClip(slot(vocal, a), { sampleRate: RATE, channels: [recording()] }));
    step(() => session.moveClip(slot(keys, a), slot(keys, b)));
    step(() => void session.copyToArrangement(slot(keys, b), { atBeat: 0 }));
    step(() => midi(session.clipAt(slot(keys, b))).midi.edit((draft) => void (draft[0].pitch = 61)));
    step(() => session.clearSlot(slot(keys, b)));
    step(() => void session.duplicateScene(a.id));
    step(() => session.removeScene(b.id));
  });

  test("a failed edit leaves the version and the grid as they were", () => {
    const { project, session, keys, a, slot } = song();
    const version = project.cells.version.value;
    expect(() =>
      project.edit("Broken", () => {
        session.setMidiClip(slot(keys, a), { notes: [], duration: 1 });
        session.addScene();
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(project.cells.version.value).toBe(version);
    expect(session.scenes).toHaveLength(2);
    expect(session.clipAt(slot(keys, a))).toBeNull();
    expect(project.cells.history.value).toEqual({});
  });

  const undoable: Array<[string, (c: ReturnType<typeof song>) => () => void, (c: ReturnType<typeof song>) => unknown]> = [
    [
      "addScene",
      ({ session }) =>
        () =>
          void session.addScene({ name: "New" }),
      ({ session }) => session.scenes.map(({ name }) => name),
    ],
    [
      "renameScene",
      ({ session, a }) =>
        () =>
          session.renameScene(a.id, "Renamed"),
      ({ session }) => session.scenes.map(({ name }) => name),
    ],
    [
      "removeScene",
      ({ session, keys, a, slot }) => {
        session.setMidiClip(slot(keys, a), { notes: notes(60), duration: 4 }, { name: "Hook" });
        return () => session.removeScene(a.id);
      },
      ({ session, project, keys, a, slot }) => {
        const clip = session.clipAt(slot(keys, a));
        return [session.scenes.length, clip ? midi(clip).midi.notes.value.length : null, clip ? (project.clipName(clip.id) ?? null) : null];
      },
    ],
    [
      "duplicateScene",
      ({ session, keys, a, slot }) => {
        session.setMidiClip(slot(keys, a), { notes: notes(60), duration: 4 });
        return () => void session.duplicateScene(a.id);
      },
      ({ session }) => session.scenes.length,
    ],
    [
      "setMidiClip",
      ({ session, keys, a, slot }) =>
        () =>
          void session.setMidiClip(slot(keys, a), { notes: notes(60), duration: 4 }),
      ({ session, keys, a, slot }) => session.clipAt(slot(keys, a))?.id ?? null,
    ],
    [
      "setAudioClip over a clip",
      ({ session, vocal, a, slot }) => {
        session.setAudioClip(slot(vocal, a), { sampleRate: RATE, channels: [recording()] });
        return () => void session.setAudioClip(slot(vocal, a), { sampleRate: RATE, channels: [recording()] });
      },
      ({ session, vocal, a, slot }) => session.clipAt(slot(vocal, a))?.id ?? null,
    ],
    [
      "moveClip",
      ({ session, keys, bass, a, b, slot }) => {
        session.setMidiClip(slot(keys, a), { notes: notes(60), duration: 4 });
        session.setMidiClip(slot(bass, b), { notes: notes(40), duration: 4 });
        return () => session.moveClip(slot(keys, a), slot(bass, b));
      },
      ({ session, keys, bass, a, b, slot }) => [session.clipAt(slot(keys, a))?.id ?? null, session.clipAt(slot(bass, b))?.id ?? null],
    ],
    [
      "clearSlot",
      ({ session, keys, a, slot }) => {
        session.setMidiClip(slot(keys, a), { notes: notes(60), duration: 4 });
        return () => session.clearSlot(slot(keys, a));
      },
      ({ session, keys, a, slot }) => session.clipAt(slot(keys, a))?.id ?? null,
    ],
    [
      "copyToArrangement",
      ({ session, keys, a, slot }) => {
        session.setMidiClip(slot(keys, a), { notes: notes(60), duration: 4 });
        return () => void session.copyToArrangement(slot(keys, a), { atBeat: 2 });
      },
      ({ project, keys }) => project.tracks.find((track) => track.id === keys.id)!.clips.map(({ id }) => id),
    ],
    [
      "setClipLoop",
      ({ project, session, keys, a, slot }) => {
        const clip = session.setMidiClip(slot(keys, a), { notes: notes(60, 62), duration: 4 });
        return () => project.setClipLoop(clip.id, { startBeat: 0, endBeat: 2 });
      },
      ({ session, keys, a, slot }) => midi(session.clipAt(slot(keys, a))).loop ?? null,
    ],
    [
      "resizeClip",
      ({ project, session, keys, a, slot }) => {
        const clip = session.setMidiClip(slot(keys, a), { notes: notes(60, 62), duration: 4 });
        return () => void project.resizeClip(clip.id, { end: 2 });
      },
      ({ session, keys, a, slot }) => midi(session.clipAt(slot(keys, a))).duration,
    ],
    [
      "setClipName",
      ({ project, session, keys, a, slot }) => {
        const clip = session.setMidiClip(slot(keys, a), { notes: [], duration: 4 });
        return () => project.setClipName(clip.id, "Named");
      },
      ({ project, session, keys, a, slot }) => project.clipName(session.clipAt(slot(keys, a))!.id) ?? null,
    ],
    [
      "setAudioClipEnvelope",
      ({ project, session, vocal, a, slot }) => {
        const clip = session.setAudioClip(slot(vocal, a), { sampleRate: RATE, channels: [recording()] });
        return () => void project.setAudioClipEnvelope(clip.id, { gain: 0.5, fadeIn: 0, fadeOut: 0 });
      },
      ({ session, vocal, a, slot }) => audio(session.clipAt(slot(vocal, a))).envelope ?? null,
    ],
  ];

  test.each(undoable)("%s is one Undo step", (_name, prepare, read) => {
    const ctx = song();
    const change = prepare(ctx);
    const before = JSON.stringify(read(ctx));
    const clipsBefore = ctx.project.tracks.flatMap((track) => track.clips).length;
    ctx.project.edit("Session edit", change);
    const after = JSON.stringify(read(ctx));
    expect(after).not.toBe(before);
    expect(ctx.project.cells.history.value.undo).toBe("Session edit");
    expect(ctx.project.undo().status).toBe("applied");
    expect(JSON.stringify(read(ctx))).toBe(before);
    expect(ctx.project.tracks.flatMap((track) => track.clips)).toHaveLength(clipsBefore);
    expect(ctx.project.redo().status).toBe("applied");
    expect(JSON.stringify(read(ctx))).toBe(after);
    expect(ctx.project.undo().status).toBe("applied");
    expect(JSON.stringify(read(ctx))).toBe(before);
  });

  test("a note edit in a slot clip inside project.edit is one Undo step and restores the notes", () => {
    const { project, session, keys, a, slot } = song();
    const hook = session.setMidiClip(slot(keys, a), { notes: notes(60, 62), duration: 4 });
    const original = hook.midi.notes.value.map((note) => note.pitch);
    const version = project.cells.version.value;
    project.edit("Transpose", () => hook.midi.edit((draft) => draft.forEach((note) => void (note.pitch += 12))));
    expect(project.cells.version.value).not.toBe(version);
    expect(hook.midi.notes.value.map((note) => note.pitch)).toEqual([72, 74]);
    expect(project.undo().status).toBe("applied");
    expect(hook.midi.notes.value.map((note) => note.pitch)).toEqual(original);
    expect(project.redo().status).toBe("applied");
    expect(hook.midi.notes.value.map((note) => note.pitch)).toEqual([72, 74]);
  });

  test("several session edits in one project.edit are one Undo step", () => {
    const { project, session, keys, a, b, slot } = song();
    project.edit("Build", () => {
      const hook = session.setMidiClip(slot(keys, a), { notes: notes(60), duration: 4 });
      session.moveClip(slot(keys, a), slot(keys, b));
      session.renameScene(b.id, "Chorus");
      project.setClipName(hook.id, "Hook");
    });
    expect(project.undo().status).toBe("applied");
    expect(session.clipAt(slot(keys, b))).toBeNull();
    expect(session.scenes[1].name).toBe("Drop");
    expect(project.undo().status).toBe("rejected");
  });

  test("undo of a track's slot clip conflicts once the track is gone", () => {
    const { project, session, keys, a, slot } = song();
    project.edit("Fill", () => void session.setMidiClip(slot(keys, a), { notes: [], duration: 1 }));
    project.removeTrack(keys.id);
    expect(project.undo().status).toBe("conflict");
  });

  test("undo reports a conflict instead of restoring a scene whose id has been taken", () => {
    const { project, session, keys, a } = song();
    project.edit("Remove", () => session.removeScene(a.id));
    project.addMidiClip(keys.id, { notes: [], duration: 1 }, 0, { id: a.id });
    expect(project.undo().status).toBe("conflict");
    expect(session.scenes.map(({ id }) => id)).not.toContain(a.id);
    // The same holds for a slot clip's id.
    const second = song();
    const clip = second.session.setMidiClip(second.slot(second.keys, second.a), { notes: [], duration: 1 });
    second.project.edit("Clear", () => second.session.clearSlot(second.slot(second.keys, second.a)));
    second.project.addMidiClip(second.bass.id, { notes: [], duration: 1 }, 0, { id: clip.id });
    expect(second.project.undo().status).toBe("conflict");
  });

  test("an unrelated session or track change does not block undoing a scene edit", () => {
    const { project, session, keys, bass, a, slot } = song();
    session.addScene({ name: "Edited" });
    project.edit("Add scene", () => void session.addScene({ name: "Later" }));
    // Another scene changing, a slot filled and a track removed since: the undone step touched none of them.
    session.renameScene(a.id, "Renamed");
    session.setMidiClip(slot(bass, a), { notes: [], duration: 1 });
    project.removeTrack(keys.id);
    expect(project.undo().status).toBe("applied");
    expect(session.scenes.map(({ name }) => name)).toEqual(["Renamed", "Drop", "Edited"]);
    expect(session.clipAt(slot(bass, a))).not.toBeNull();
  });

  test("undoing a scene removal puts the scene back where it was", () => {
    const { project, session, a, b } = song();
    const third = session.addScene({ name: "Third" });
    project.edit("Remove", () => session.removeScene(b.id));
    project.undo();
    expect(session.scenes.map(({ id }) => id)).toEqual([a.id, b.id, third.id]);
  });

  test("snapshot copies the session", () => {
    const { project, session, keys, vocal, a, slot } = song();
    const hook = session.setMidiClip(slot(keys, a), { notes: notes(60), duration: 4 }, { name: "Hook" });
    session.setAudioClip(slot(vocal, a), { sampleRate: RATE, channels: [recording()] });
    const copy = project.snapshot();
    const copied = sessionFor(copy);
    expect(copied.scenes).toEqual(session.scenes);
    expect(midi(copied.clipAt(slot(keys, a))).midi.notes.value).toEqual(hook.midi.notes.value);
    expect(midi(copied.clipAt(slot(keys, a)))).not.toBe(hook);
    expect(copy.clipName(hook.id)).toBe("Hook");
    hook.midi.edit((draft) => void draft.pop());
    expect(midi(copied.clipAt(slot(keys, a))).midi.notes.value).toHaveLength(1);
    copy.dispose();
  });
});

describe("save and reopen", () => {
  test("keeps scenes, names, slot clips and the arrangement apart", () => {
    const { project, session, keys, vocal, a, b, slot } = song();
    project.addMidiClip(keys.id, { notes: notes(48), duration: 2 }, 4, { name: "Timeline" });
    project.addAudioClip(vocal.id, { sampleRate: RATE, channels: [recording()] }, 1);
    const hook = session.setMidiClip(slot(keys, a), { notes: notes(60, 64), duration: 4 }, { name: "Hook" });
    project.setClipLoop(hook.id, { startBeat: 0, endBeat: 2 });
    const take = session.setAudioClip(slot(vocal, b), { sampleRate: RATE, channels: [recording()] }, { name: "Take" });
    const windowed = project.resizeClip(take.id, { start: 1, end: 3 });
    project.setAudioClipEnvelope(windowed.id, { gain: 0.5, fadeIn: 0.25, fadeOut: 0 });
    const looped = session.setAudioClip(slot(vocal, a), { sampleRate: RATE, channels: [recording()] }, { name: "Loop" });
    project.setClipLoop(looped.id, { startSeconds: 1, endSeconds: 2 });
    project.resizeClip(looped.id, { end: 6 });

    const { project: reopened, warnings } = openDawProject(saveDawProject(project));
    expect(warnings).toEqual([]);
    const grid = sessionFor(reopened);
    expect(grid.scenes).toEqual(session.scenes);
    const reopenedHook = midi(grid.clipAt(slot(keys, a)));
    expect(reopenedHook.id).toBe(hook.id);
    expect(reopenedHook.time).toBe(0);
    expect(reopenedHook.duration).toBe(4);
    expect(reopenedHook.loop).toEqual({ startBeat: 0, endBeat: 2 });
    expect(reopenedHook.midi.notes.value.map((note) => note.pitch)).toEqual([60, 64]);
    expect(reopened.clipName(hook.id)).toBe("Hook");
    const reopenedTake = audio(grid.clipAt(slot(vocal, b)));
    expect(reopenedTake.time).toBe(0);
    expect(reopenedTake.duration).toBe(2);
    expect(reopenedTake.sourceOffset).toBe(1);
    expect(reopenedTake.envelope).toEqual({ gain: 0.5, fadeIn: 0.25, fadeOut: 0 });
    expect(reopened.clipName(reopenedTake.id)).toBe("Take");
    const reopenedLoop = audio(grid.clipAt(slot(vocal, a)));
    expect(reopenedLoop.loop).toEqual({ startSeconds: 1, endSeconds: 2 });
    expect(reopenedLoop.duration).toBe(6);
    expect(grid.clipAt(slot(keys, b))).toBeNull();
    // The arrangement holds only its own clips.
    expect(reopened.tracks.find((track) => track.id === keys.id)!.clips.map((clip) => reopened.clipName(clip.id))).toEqual(["Timeline"]);
    expect(reopened.tracks.find((track) => track.id === vocal.id)!.clips).toHaveLength(1);
    // Ids stay unique: the reopened project saves and opens again.
    const again = openDawProject(saveDawProject(reopened)).project;
    expect(sessionFor(again).scenes).toEqual(session.scenes);
    expect(again.cells.version.value).not.toBe(reopened.cells.version.value);
  });

  test("writes Scenes after Arrangement, one ClipSlot per filled slot, with no ids that collide", () => {
    const { project, session, keys, vocal, a, b, slot } = song();
    session.setMidiClip(slot(keys, a), { notes: notes(60), duration: 4 });
    session.setAudioClip(slot(vocal, b), { sampleRate: RATE, channels: [recording()] });
    const xml = strFromU8(unzipSync(saveDawProject(project))["project.xml"]);
    expect(xml.indexOf("<Scenes>")).toBeGreaterThan(xml.indexOf("</Arrangement>"));
    expect(xml).toContain(`<Scene id="${a.id}" name="Intro">`);
    expect(xml.match(/<ClipSlot /g)).toHaveLength(2);
    expect(xml).toContain(`<ClipSlot track="${keys.id}" timeUnit="beats">`);
    expect(xml).toContain(`<ClipSlot track="${vocal.id}" timeUnit="seconds">`);
    expect(xml).not.toContain("hasStop");
    const ids = [...xml.matchAll(/ id="([^"]+)"/g)].map((match) => match[1]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("a project without scenes writes no Scenes and opens with an empty session", () => {
    const project = new Project();
    project.addTrack("Keys", "midi");
    const bytes = saveDawProject(project);
    expect(strFromU8(unzipSync(bytes)["project.xml"])).not.toContain("Scenes");
    expect(sessionFor(openDawProject(bytes).project).scenes).toEqual([]);
  });

  test("a scene with no clips survives", () => {
    const { project, a, b } = song();
    const grid = sessionFor(openDawProject(saveDawProject(project)).project);
    expect(grid.scenes.map(({ id }) => id)).toEqual([a.id, b.id]);
  });

  test("a reopened project keeps issuing unique scene and clip ids", () => {
    const { project, keys, a, slot } = song();
    sessionFor(project).setMidiClip(slot(keys, a), { notes: [], duration: 1 });
    const reopened = openDawProject(saveDawProject(project)).project;
    const grid = sessionFor(reopened);
    const added = grid.addScene();
    expect(grid.scenes.map(({ id }) => id)).toEqual([...new Set(grid.scenes.map(({ id }) => id))]);
    expect(added.id).not.toBe(a.id);
    const clip = grid.setMidiClip({ trackId: keys.id, sceneId: added.id }, { notes: [], duration: 1 });
    expect(clip.id).not.toBe(grid.clipAt(slot(keys, a))!.id);
  });
});

describe("overview and portability", () => {
  test("overview lists the scenes and their slot clips apart from the timeline", () => {
    const { project, session, keys, vocal, a, b, slot } = song();
    const hook = session.setMidiClip(slot(keys, a), { notes: notes(60), duration: 4 }, { name: "Hook" });
    const take = session.setAudioClip(slot(vocal, b), { sampleRate: RATE, channels: [recording()] });
    project.addMidiClip(keys.id, { notes: [], duration: 2 }, 0);
    const overview = JSON.parse(JSON.stringify(project.overview()));
    expect(overview.tracks.find((track: { id: string }) => track.id === keys.id).clips).toHaveLength(1);
    expect(overview.session).toEqual([
      {
        id: a.id,
        name: "Intro",
        clips: [{ id: hook.id, name: "Hook", kind: "midi", trackId: keys.id, trackName: "Keys", duration: 4, unit: "beats", sourceOffset: 0 }],
      },
      { id: b.id, name: "Drop", clips: [{ id: take.id, kind: "audio", trackId: vocal.id, trackName: "Vocal", duration: 4, unit: "seconds" }] },
    ]);
    expect(new Project().overview().session).toEqual([]);
  });

  test("portabilityReport counts scenes and slot clips, and the track's channel count follows a slot clip", () => {
    const { project, session, vocal, a, slot } = song();
    expect(portabilityReport(project).standardContent).toContain("Session scenes and clip slots");
    expect(portabilityReport(project).standardContent).not.toContain("audio clips");
    session.setAudioClip(slot(vocal, a), { sampleRate: RATE, channels: [recording(), recording()] });
    expect(portabilityReport(project).standardContent).toContain("audio clips");
    const xml = strFromU8(unzipSync(saveDawProject(project))["project.xml"]);
    expect(xml).toMatch(new RegExp(`<Channel id="${vocal.id}-channel"[^>]*audioChannels="2"`));
    const mono = song();
    mono.session.setAudioClip(mono.slot(mono.vocal, mono.a), { sampleRate: RATE, channels: [recording()] });
    expect(strFromU8(unzipSync(saveDawProject(mono.project))["project.xml"])).toMatch(
      new RegExp(`<Channel id="${mono.vocal.id}-channel"[^>]*audioChannels="1"`),
    );
  });
});

describe("tracking", () => {
  test("scenes and clipAt re-run an effect on every session change", () => {
    const { session, keys, a, slot } = song();
    const scenes: unknown[] = [];
    const clips: unknown[] = [];
    const stop = effect(() => {
      scenes.push(session.scenes);
      clips.push(session.clipAt(slot(keys, a)));
    });
    session.setMidiClip(slot(keys, a), { notes: [], duration: 1 });
    session.addScene();
    stop();
    expect(clips.at(-1)).not.toBeNull();
    expect(scenes.at(-1)).toHaveLength(3);
  });

  test("commands do not subscribe a calling effect", () => {
    const { session, keys, a, slot } = song();
    let runs = 0;
    const stop = effect(() => {
      runs++;
      session.addScene();
      session.setMidiClip(slot(keys, a), { notes: [], duration: 1 });
      session.duplicateScene(a.id);
      session.copyToArrangement(slot(keys, a), { atBeat: 0 });
      session.clearSlot(slot(keys, a));
    });
    session.addScene();
    stop();
    expect(runs).toBe(1);
  });
});
