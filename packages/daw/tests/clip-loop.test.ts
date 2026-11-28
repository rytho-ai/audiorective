import { describe, expect, test } from "vitest";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { Project, openDawProject, saveDawProject } from "../src";
import type { AudioClip, MidiClip, ProjectClip } from "../src";

const RATE = 8;
const SHAPE = "Project clip loop needs { startBeat, endBeat } for MIDI and { startSeconds, endSeconds } for audio.";
const BOUNDS = "Project clip loop needs 0 <= start < end inside the clip's content.";
/** Four seconds of distinct samples. */
const recording = () => Float32Array.from({ length: 4 * RATE }, (_, index) => (index + 1) / 100);
const audio = (clip: ProjectClip | undefined): AudioClip => {
  if (!clip || clip.kind !== "audio") throw new Error("Expected an audio clip");
  return clip;
};
const midi = (clip: ProjectClip | undefined): MidiClip => {
  if (!clip || clip.kind !== "midi") throw new Error("Expected a MIDI clip");
  return clip;
};

function fixture() {
  const project = new Project({ bpm: 120 });
  const audioTrack = project.addTrack("Take", "audio");
  const midiTrack = project.addTrack("Keys", "midi");
  const take = project.addAudioClip(audioTrack.id, { sampleRate: RATE, channels: [recording()] }, 1);
  const pattern = project.addMidiClip(
    midiTrack.id,
    {
      duration: 4,
      notes: [
        { pitch: 60, velocity: 1, start: 0, duration: 0.5 },
        { pitch: 62, velocity: 1, start: 3, duration: 2 },
      ],
    },
    8,
  );
  return { project, audioTrack, midiTrack, take, pattern };
}
const find = (project: Project, id: string) => project.tracks.flatMap((track) => track.clips).find((clip) => clip.id === id);

describe("setClipLoop", () => {
  test("a clip has no loop until one is set", () => {
    const { project, take, pattern } = fixture();
    expect(take.loop).toBeUndefined();
    expect(pattern.loop).toBeUndefined();
    project.dispose();
  });

  test("validates the shape and the bounds with exact messages", () => {
    const { project, take, pattern } = fixture();
    expect(() => project.setClipLoop(take.id, { startBeat: 0, endBeat: 1 })).toThrow(new RangeError(SHAPE));
    expect(() => project.setClipLoop(pattern.id, { startSeconds: 0, endSeconds: 1 })).toThrow(new RangeError(SHAPE));
    for (const bad of [
      { startSeconds: -1, endSeconds: 1 },
      { startSeconds: 1, endSeconds: 1 },
      { startSeconds: 2, endSeconds: 1 },
      { startSeconds: 0, endSeconds: 4.5 },
      { startSeconds: 0, endSeconds: NaN },
    ])
      expect(() => project.setClipLoop(take.id, bad)).toThrow(new RangeError(BOUNDS));
    for (const bad of [
      { startBeat: -1, endBeat: 1 },
      { startBeat: 2, endBeat: 2 },
    ])
      expect(() => project.setClipLoop(pattern.id, bad)).toThrow(new RangeError(BOUNDS));
    expect(() => project.setClipLoop("nope", { startBeat: 0, endBeat: 1 })).toThrow("Project clip does not exist.");
    // MIDI accepts any positive end, even past the clip.
    project.setClipLoop(pattern.id, { startBeat: 1, endBeat: 100 });
    expect(midi(find(project, pattern.id)).loop).toEqual({ startBeat: 1, endBeat: 100 });
    project.dispose();
  });

  test("sets, replaces and removes the loop on both kinds", () => {
    const { project, take, pattern } = fixture();
    project.setClipLoop(take.id, { startSeconds: 1, endSeconds: 2 });
    project.setClipLoop(pattern.id, { startBeat: 0, endBeat: 2 });
    expect(audio(find(project, take.id)).loop).toEqual({ startSeconds: 1, endSeconds: 2 });
    expect(midi(find(project, pattern.id)).loop).toEqual({ startBeat: 0, endBeat: 2 });
    project.setClipLoop(take.id, null);
    project.setClipLoop(pattern.id, null);
    expect(audio(find(project, take.id)).loop).toBeUndefined();
    expect(midi(find(project, pattern.id)).loop).toBeUndefined();
    project.dispose();
  });

  test("undo and redo restore the loop", () => {
    const { project, take, pattern } = fixture();
    project.edit("Loop it", () => {
      project.setClipLoop(take.id, { startSeconds: 0, endSeconds: 1 });
      project.setClipLoop(pattern.id, { startBeat: 0, endBeat: 1 });
    });
    project.undo();
    expect(audio(find(project, take.id)).loop).toBeUndefined();
    expect(midi(find(project, pattern.id)).loop).toBeUndefined();
    project.redo();
    expect(audio(find(project, take.id)).loop).toEqual({ startSeconds: 0, endSeconds: 1 });
    expect(midi(find(project, pattern.id)).loop).toEqual({ startBeat: 0, endBeat: 1 });
    project.edit("Unloop", () => project.setClipLoop(take.id, null));
    project.undo();
    expect(audio(find(project, take.id)).loop).toEqual({ startSeconds: 0, endSeconds: 1 });
    project.dispose();
  });

  test("a time-stretched audio clip cannot loop", () => {
    const { project, audioTrack } = fixture();
    const stretched = project.addAudioClip(audioTrack.id, { sampleRate: RATE, channels: [recording()] }, 20);
    const source = { sampleRate: RATE, channels: [recording()] };
    const next = project.applyAudioClipStretch(stretched, 2, { sampleRate: RATE, channels: [new Float32Array(8 * RATE)] });
    expect(next.stretch).toBeDefined();
    expect(source.channels).toHaveLength(1);
    expect(() => project.setClipLoop(next.id, { startSeconds: 0, endSeconds: 1 })).toThrow(new RangeError(BOUNDS));
    project.dispose();
  });

  test("duplicates keep the loop", () => {
    const { project, take, pattern } = fixture();
    project.setClipLoop(take.id, { startSeconds: 1, endSeconds: 2 });
    project.setClipLoop(pattern.id, { startBeat: 1, endBeat: 2 });
    expect(audio(project.duplicateClip(take.id, 30)).loop).toEqual({ startSeconds: 1, endSeconds: 2 });
    expect(midi(project.duplicateClip(pattern.id, 40)).loop).toEqual({ startBeat: 1, endBeat: 2 });
    project.dispose();
  });
});

describe("resizing a looped clip", () => {
  test("an audio clip extends past its recording on the right and keeps the loop", () => {
    const { project, take } = fixture();
    project.setClipLoop(take.id, { startSeconds: 1, endSeconds: 2 });
    expect(() => project.resizeClip(take.id, { end: 20 })).not.toThrow();
    const longer = audio(find(project, take.id));
    expect(longer).toMatchObject({ time: 1, duration: 19, sourceOffset: 0, sourceLength: 4, loop: { startSeconds: 1, endSeconds: 2 } });
    expect(longer.channels).toHaveLength(1);
    // Without a loop the same edge is refused.
    project.setClipLoop(take.id, null);
    expect(() => project.resizeClip(take.id, { end: 40 })).toThrow("Project clip edges must stay inside its recording.");
    project.dispose();
  });

  test("a left trim enters the loop where playback was", () => {
    const { project, take } = fixture();
    project.setClipLoop(take.id, { startSeconds: 1, endSeconds: 2 });
    project.resizeClip(take.id, { end: 20 });
    // Local 3.5 s: 2 s to the loop end, then 1.5 s into a 1 s loop: 0.5 s into the loop.
    project.resizeClip(take.id, { start: 4.5 });
    expect(audio(find(project, take.id))).toMatchObject({ time: 4.5, sourceOffset: 1.5, loop: { startSeconds: 1, endSeconds: 2 } });
    project.dispose();
  });

  test("a split keeps the loop on both pieces", () => {
    const { project, take } = fixture();
    project.setClipLoop(take.id, { startSeconds: 1, endSeconds: 2 });
    project.resizeClip(take.id, { end: 20 });
    const [left, right] = project.splitClip(take.id, 6);
    expect(audio(left).loop).toEqual({ startSeconds: 1, endSeconds: 2 });
    expect(audio(right).loop).toEqual({ startSeconds: 1, endSeconds: 2 });
    expect(left.duration + right.duration).toBeCloseTo(19);
    project.dispose();
  });

  test("a MIDI clip extends on the right and keeps the loop", () => {
    const { project, pattern } = fixture();
    project.setClipLoop(pattern.id, { startBeat: 0, endBeat: 2 });
    project.resizeClip(pattern.id, { end: 8 + 16 });
    const longer = midi(find(project, pattern.id));
    expect(longer).toMatchObject({ duration: 16, loop: { startBeat: 0, endBeat: 2 } });
    project.dispose();
  });

  test("a MIDI clip's loop stays in content beats when its start edge moves", () => {
    const { project, pattern } = fixture();
    project.setClipLoop(pattern.id, { startBeat: 0, endBeat: 2 });
    const extended = midi(project.resizeClip(pattern.id, { start: 6 }));
    expect([extended.loop, extended.sourceOffset]).toEqual([{ startBeat: 0, endBeat: 2 }, -2]);
    project.resizeClip(pattern.id, { start: 6, end: 20 });
    project.resizeClip(pattern.id, { start: 8 });
    const trimmed = midi(find(project, pattern.id));
    expect(trimmed.loop).toEqual({ startBeat: 0, endBeat: 2 });
    expect(trimmed.sourceOffset).toBe(0);
    expect(trimmed.playbackEvents().length).toBeGreaterThan(0);
    project.dispose();
  });
});

describe("MIDI playback of a loop", () => {
  const starts = (clip: MidiClip) =>
    clip
      .playbackEvents()
      .filter((event) => (event.data[0] & 0xf0) === 0x90)
      .map((event) => [event.data[1], event.beat]);
  const ends = (clip: MidiClip) =>
    clip
      .playbackEvents()
      .filter((event) => (event.data[0] & 0xf0) === 0x80)
      .map((event) => [event.data[1], event.beat]);

  test("notes in the loop repeat until the clip ends and are cut at the loop end", () => {
    const { project, pattern } = fixture();
    project.setClipLoop(pattern.id, { startBeat: 0, endBeat: 2 });
    project.resizeClip(pattern.id, { end: 8 + 6 });
    const clip = midi(find(project, pattern.id));
    // The note at beat 3 lies outside the loop: only the first pass of the whole clip's notes up to the loop end plays.
    expect(starts(clip)).toEqual([
      [60, 0],
      [60, 2],
      [60, 4],
    ]);
    expect(ends(clip)).toEqual([
      [60, 0.5],
      [60, 2.5],
      [60, 4.5],
    ]);
    project.dispose();
  });

  test("a note crossing the loop end is cut at the end of each pass", () => {
    const { project, midiTrack } = fixture();
    const clip = project.addMidiClip(midiTrack.id, { duration: 5, notes: [{ pitch: 64, velocity: 1, start: 1, duration: 3 }] }, 0);
    project.setClipLoop(clip.id, { startBeat: 1, endBeat: 2 });
    const looped = midi(find(project, clip.id));
    expect(ends(looped)).toEqual([
      [64, 2],
      [64, 3],
      [64, 4],
      [64, 5],
    ]);
    project.dispose();
  });

  test("a note edited in the pattern changes every repetition", () => {
    const { project, pattern } = fixture();
    project.setClipLoop(pattern.id, { startBeat: 0, endBeat: 2 });
    project.resizeClip(pattern.id, { end: 8 + 6 });
    const clip = midi(find(project, pattern.id));
    clip.midi.edit((draft) => {
      draft[0].pitch = 65;
    });
    expect(starts(clip).map(([pitch]) => pitch)).toEqual([65, 65, 65]);
    project.dispose();
  });
});

describe("saving a loop", () => {
  test("an audio loop and the clip's length survive save and reopen", () => {
    const { project, take } = fixture();
    project.setClipLoop(take.id, { startSeconds: 1, endSeconds: 2 });
    project.resizeClip(take.id, { end: 20 });
    const { project: reopened, warnings } = openDawProject(saveDawProject(project));
    expect(warnings).toEqual([]);
    const clip = audio(reopened.tracks[0].clips[0]);
    expect(clip).toMatchObject({ time: 1, duration: 19, sourceOffset: 0, sourceLength: 4, loop: { startSeconds: 1, endSeconds: 2 } });
    expect([...clip.channels![0]]).toEqual([...recording()]);
    reopened.dispose();
    project.dispose();
  });

  test("an audio loop keeps a trimmed start offset and a shorter clip", () => {
    const { project, take } = fixture();
    project.setClipLoop(take.id, { startSeconds: 1, endSeconds: 2 });
    project.resizeClip(take.id, { start: 1.5, end: 2.25 });
    const before = audio(find(project, take.id));
    const reopened = openDawProject(saveDawProject(project)).project;
    const clip = audio(reopened.tracks[0].clips[0]);
    expect(clip).toMatchObject({ time: before.time, duration: before.duration, sourceOffset: before.sourceOffset, loop: before.loop });
    reopened.dispose();
    project.dispose();
  });

  test("a MIDI loop and the clip's length survive save and reopen", () => {
    const { project, pattern } = fixture();
    project.setClipLoop(pattern.id, { startBeat: 1, endBeat: 3 });
    project.resizeClip(pattern.id, { end: 8 + 12 });
    const { project: reopened, warnings } = openDawProject(saveDawProject(project));
    expect(warnings).toEqual([]);
    expect(midi(reopened.tracks[1].clips[0])).toMatchObject({ time: 8, duration: 12, loop: { startBeat: 1, endBeat: 3 } });
    reopened.dispose();
    project.dispose();
  });

  test("a removed loop is not saved and files without loops open as before", () => {
    const { project, take, pattern } = fixture();
    project.setClipLoop(take.id, { startSeconds: 1, endSeconds: 2 });
    project.setClipLoop(pattern.id, { startBeat: 0, endBeat: 1 });
    project.setClipLoop(take.id, null);
    project.setClipLoop(pattern.id, null);
    const reopened = openDawProject(saveDawProject(project)).project;
    expect(reopened.tracks[0].clips[0].loop).toBeUndefined();
    expect(reopened.tracks[1].clips[0].loop).toBeUndefined();
    reopened.dispose();
    project.dispose();
  });
});

describe("review regressions", () => {
  test("removing a loop from an extended audio clip cuts it to its recording and still saves and reopens", () => {
    for (const end of [3, 20]) {
      const { project, take } = fixture();
      project.setClipLoop(take.id, { startSeconds: 1, endSeconds: 2 });
      project.resizeClip(take.id, { end });
      project.setClipLoop(take.id, null);
      const clip = audio(find(project, take.id));
      expect(clip.loop).toBeUndefined();
      expect(clip.duration).toBeLessThanOrEqual(clip.sourceLength - clip.sourceOffset);
      expect(clip.channels![0].length).toBe(Math.round(clip.duration * RATE));
      const reopened = openDawProject(saveDawProject(project)).project;
      expect(reopened.tracks[0].clips[0]).toMatchObject({ time: 1, duration: clip.duration });
      reopened.dispose();
      project.dispose();
    }
  });

  test("a looped clip keeps its fades through save and reopen, also when shorter than its recording", () => {
    for (const edges of [{ end: 20 }, { start: 1.5, end: 2.25 }]) {
      const { project, take } = fixture();
      project.setClipLoop(take.id, { startSeconds: 1, endSeconds: 2 });
      project.resizeClip(take.id, edges);
      const duration = audio(find(project, take.id)).duration;
      const envelope = { gain: 0.5, fadeIn: Math.min(0.25, duration / 2), fadeOut: Math.min(0.5, duration / 2) };
      project.setAudioClipEnvelope(take.id, envelope);
      const reopened = openDawProject(saveDawProject(project)).project;
      expect(audio(reopened.tracks[0].clips[0]).envelope).toEqual(envelope);
      reopened.dispose();
      project.dispose();
    }
  });

  test("a foreign file whose playStop marks the content end opens; an impossible playStop does not", () => {
    const { project, take } = fixture();
    project.setClipLoop(take.id, { startSeconds: 1, endSeconds: 2 });
    project.resizeClip(take.id, { end: 9 });
    const files = unzipSync(saveDawProject(project));
    const xml = strFromU8(files["project.xml"]);
    expect(xml).toContain('playStop="4"');
    const open = (playStop: string) => {
      const edited = { ...files, "project.xml": strToU8(xml.replace('playStop="4"', `playStop="${playStop}"`)) };
      return openDawProject(zipSync(edited)).project;
    };
    const reopened = open("2");
    expect(audio(reopened.tracks[0].clips[0])).toMatchObject({ duration: 8, loop: { startSeconds: 1, endSeconds: 2 } });
    reopened.dispose();
    expect(() => open("0")).toThrow("Project audio asset does not match its XML metadata.");
    expect(() => open("5")).toThrow("Project audio asset does not match its XML metadata.");
    project.dispose();
  });

  test("a left trim moves gain automation's origin by the recording distance", () => {
    const { project, take } = fixture();
    project.setClipLoop(take.id, { startSeconds: 1, endSeconds: 2 });
    project.resizeClip(take.id, { end: 20 });
    project.setAudioClipGainAutomation(take.id, [
      { time: 0, value: 1, shape: "linear" },
      { time: 3, value: 0.5, shape: "linear" },
    ]);
    project.resizeClip(take.id, { start: 3 });
    // Local 2 s is the loop start (1 s) in the recording: the window starts there.
    expect(audio(find(project, take.id)).gainAutomation?.sourceStart).toBeCloseTo(1);
    project.dispose();
  });
});
