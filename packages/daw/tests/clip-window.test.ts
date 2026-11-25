import { renderSnapshot } from "../src/model";
import { describe, expect, test } from "vitest";
import { unzipSync, zipSync } from "fflate";
import { AudioMediaWriter, Project, openDawProject, saveDawProject, saveDawProjectTo } from "../src";
import type { AudioClip, ProjectClip } from "../src";
import { decodeWav } from "../src/internal/wav";

const RATE = 8;
const EDGES = "Project clip edges must stay inside its recording.";
const recording = () => Float32Array.from({ length: 24 }, (_, index) => (index + 1) / 100);
const audio = (clip: ProjectClip | undefined): AudioClip => {
  if (!clip || clip.kind !== "audio") throw new Error("Expected an audio clip");
  return clip;
};
const samples = (clip: ProjectClip | undefined) => [...audio(clip).channels![0]];
const slice = (from: number, to: number) => [...recording().subarray(from, to)];

function threePieces() {
  const project = new Project();
  const track = project.addTrack("Take", "audio");
  const whole = project.addAudioClip(track.id, { sampleRate: RATE, channels: [recording()] }, 2);
  const [first, rest] = project.splitClip(whole.id, 1);
  const [middle, last] = project.splitClip(rest.id, 1);
  return { project, track, first, middle, last };
}

describe("non-destructive audio clip windows", () => {
  test("describes the recording behind a clip", () => {
    const { project, first, middle, last } = threePieces();
    expect([first, middle, last].map((clip) => [audio(clip).sourceOffset, audio(clip).sourceLength])).toEqual([
      [0, 3],
      [1, 3],
      [2, 3],
    ]);
    project.dispose();
  });

  test("resizeClip trims, extends and undoes", () => {
    const { project, first, last } = threePieces();
    const trimmed = project.resizeClip(first.id, { start: 2.5 });
    expect(trimmed).toMatchObject({ id: first.id, time: 2.5, duration: 0.5 });
    expect(samples(trimmed)).toEqual(slice(4, 8));
    expect(audio(trimmed)).toMatchObject({ sourceOffset: 0.5, sourceLength: 3 });
    const extended = project.resizeClip(first.id, { start: 2, end: 5 });
    expect(extended).toMatchObject({ time: 2, duration: 3 });
    expect(samples(extended)).toEqual(slice(0, 24));
    let left!: ProjectClip;
    project.edit("Extend", () => {
      left = project.resizeClip(last.id, { start: 3 });
    });
    expect(left.time).toBe(3);
    expect(samples(left)).toEqual(slice(8, 24));
    expect(audio(left).sourceOffset).toBe(1);
    project.undo();
    expect(project.tracks[0].clips.find((clip) => clip.id === last.id)).toMatchObject({ time: 4, duration: 1 });
    project.dispose();
  });

  test("resizeClip keeps the name and the fades of unmoved edges", () => {
    const project = new Project();
    const track = project.addTrack("Take", "audio");
    const clip = project.addAudioClip(track.id, { sampleRate: RATE, channels: [recording()] }, 0, {
      name: "Vox",
      envelope: { gain: 0.5, fadeIn: 0.25, fadeOut: 0.5 },
    });
    const cut = audio(project.resizeClip(clip.id, { start: 1 }));
    expect(cut.envelope).toEqual({ gain: 0.5, fadeIn: 0, fadeOut: 0.5 });
    expect(project.clipName(clip.id)).toBe("Vox");
    project.dispose();
  });

  test("edges outside the recording throw and change nothing", () => {
    const { project, first, last } = threePieces();
    const before = project.tracks;
    expect(() => project.resizeClip(first.id, { start: 1.9 })).toThrow(EDGES);
    expect(() => project.resizeClip(first.id, { end: 5.2 })).toThrow(EDGES);
    expect(() => project.resizeClip(last.id, { start: 1.9 })).toThrow(EDGES);
    expect(() => project.resizeClip(first.id, { start: 3, end: 3 })).toThrow(EDGES);
    expect(() => project.resizeClip(first.id, { start: 3, end: 2.5 })).toThrow(EDGES);
    expect(project.tracks).toBe(before);
    project.dispose();
  });

  test("a PCM clip extended again plays the original samples", () => {
    const { project, first } = threePieces();
    const original = recording();
    const restored = project.resizeClip(first.id, { end: 5 });
    expect(samples(restored)).toEqual([...original]);
    project.dispose();
  });

  test("saving keeps the whole recording once; reopened pieces share it", () => {
    const { project, middle, last, first } = threePieces();
    project.removeClip(middle.id);
    project.moveClip(last.id, project.tracks[0].id, 10);
    const files = unzipSync(saveDawProject(project));
    const wavs = Object.keys(files).filter((path) => path.startsWith("audio/"));
    expect(wavs).toEqual([`audio/${first.id}.wav`]);
    expect(decodeWav(files[wavs[0]]).channels[0].length).toBe(24);
    const xml = new TextDecoder().decode(files["project.xml"]);
    const clips = [...xml.matchAll(/<Clip [^>]*>/g)].map((match) => match[0]);
    expect(clips).toHaveLength(2);
    expect(clips[0]).toMatch(/playStart="0" playStop="1"|playStop="1"/);
    expect(clips[0]).toContain('playStart="0"');
    expect(clips[0]).toContain('playStop="1"');
    expect(clips[1]).toContain('playStart="2"');
    expect(clips[1]).toContain('playStop="3"');

    const { project: reopened, warnings } = openDawProject(saveDawProject(project));
    expect(warnings).toEqual([]);
    const [a, c] = reopened.tracks[0].clips.map(audio);
    expect([a.id, c.id]).toEqual([first.id, last.id]);
    expect(a.channels![0].buffer).toBe(c.channels![0].buffer);
    expect([a.sourceOffset, a.sourceLength, c.sourceOffset, c.sourceLength]).toEqual([0, 3, 2, 3]);
    const extended = reopened.resizeClip(a.id, { end: a.time + 3 });
    expect(samples(extended)).toEqual([...recording()]);
    expect(samples(reopened.resizeClip(c.id, { start: c.time - 2 }))).toEqual(slice(0, 24));
    reopened.dispose();
    project.dispose();
  });

  test("a file without play attributes opens as before", () => {
    const project = new Project();
    const track = project.addTrack("Take", "audio");
    project.addAudioClip(track.id, { sampleRate: RATE, channels: [recording()] }, 1);
    const { project: reopened } = openDawProject(saveDawProject(project));
    const clip = audio(reopened.tracks[0].clips[0]);
    expect([clip.sourceOffset, clip.sourceLength, clip.duration]).toEqual([0, 3, 3]);
    reopened.dispose();
    project.dispose();
  });

  test("rejects a play window outside the file", () => {
    const { project, first } = threePieces();
    const files = unzipSync(saveDawProject(project));
    const xml = new TextDecoder().decode(files["project.xml"]);
    const bad = new TextEncoder().encode(xml.replace('playStop="1"', 'playStop="9"'));
    expect(() => openDawProject(Object.assign({}, files, { "project.xml": bad }) as never)).toThrow();
    expect(first.id).toBeTruthy();
    project.dispose();
  });

  test("time-stretched clips may shrink but not extend", () => {
    const project = new Project();
    const track = project.addTrack("Take", "audio");
    const clip = project.addAudioClip(track.id, { sampleRate: RATE, channels: [recording()] }, 1);
    const stretched = audio(project.applyAudioClipStretch(clip, 2, { sampleRate: RATE, channels: [new Float32Array(48).fill(0.5)] }));
    expect(stretched.stretch?.source).toMatchObject({ sourceOffset: 0, sourceLength: 3 });
    expect(() => project.resizeClip(stretched.id, { end: 8 })).toThrow("Project cannot extend a time-stretched clip; set its ratio to 1 first.");
    expect(() => project.resizeClip(stretched.id, { start: 0.5 })).toThrow("Project cannot extend a time-stretched clip; set its ratio to 1 first.");
    const shrunk = audio(project.resizeClip(stretched.id, { start: 2, end: 5 }));
    expect(shrunk.time).toBe(2);
    expect(shrunk.duration).toBe(3);
    // Stretched audio is saved as its window alone, so its source is its own recording.
    expect(shrunk.stretch?.source.sourceOffset).toBe(0);
    expect(shrunk.stretch?.source.sourceLength).toBeCloseTo(1.5);
    project.dispose();
  });

  test("a file-backed clip reveals audio inside its media", async () => {
    const chunks: Uint8Array[] = [];
    const writer = new AudioMediaWriter(4, 1, {
      write: async (bytes: Uint8Array) => void chunks.push(new Uint8Array(bytes)),
      finish: async () => new Blob(chunks as BlobPart[]),
      abort: async () => void (chunks.length = 0),
    });
    await writer.writeChunk({ startFrame: 0, channels: [Float32Array.from([1, 2, 3, 4, 5, 6, 7, 8])] });
    const media = await writer.finish({ sampleRate: 4, channelCount: 1, startFrame: 0, endFrame: 8, startTime: 0, endTime: 2 });
    const project = new Project();
    const track = project.addTrack("Take", "audio");
    const clip = project.addAudioMediaClip(track.id, media, 1, { startFrame: 2, frameCount: 4 });
    expect([clip.sourceOffset, clip.sourceLength]).toEqual([0.5, 2]);
    const wider = audio(project.resizeClip(clip.id, { start: 0.5, end: 2.5 }));
    expect([wider.startFrame, wider.frameCount, wider.time, wider.sourceOffset]).toEqual([0, 8, 0.5, 0]);
    expect(() => project.resizeClip(clip.id, { end: 2.9 })).toThrow(EDGES);
    const [left, right] = project.splitClip(clip.id, 1);
    expect([audio(left).sourceOffset, audio(right).sourceOffset]).toEqual([0, 1]);
    const chunksOut: Uint8Array[] = [];
    await saveDawProjectTo(project, new WritableStream({ write: (chunk) => void chunksOut.push(new Uint8Array(chunk)) }));
    const files = unzipSync(new Uint8Array(await new Blob(chunksOut as BlobPart[]).arrayBuffer()));
    expect(Object.keys(files).filter((path) => path.startsWith("audio/"))).toHaveLength(1);
    project.dispose();
  });

  test("MIDI clips extend into empty space and trim notes", () => {
    const project = new Project();
    const track = project.addTrack("Keys", "midi");
    const clip = project.addMidiClip(
      track.id,
      {
        duration: 2,
        notes: [
          { id: "a", pitch: 60, velocity: 0.5, start: 0, duration: 1, channel: 0 },
          { id: "b", pitch: 62, velocity: 0.5, start: 1, duration: 1, channel: 0 },
        ],
      },
      4,
    );
    const trimmed = project.resizeClip(clip.id, { start: 5 });
    if (trimmed.kind !== "midi") throw new Error("Expected MIDI");
    expect([trimmed.time, trimmed.duration]).toEqual([5, 1]);
    expect(trimmed.midi.notes.value.map((note) => [note.pitch, note.start, note.duration])).toEqual([[62, 0, 1]]);
    const wide = project.resizeClip(clip.id, { start: 3, end: 9 });
    if (wide.kind !== "midi") throw new Error("Expected MIDI");
    expect([wide.time, wide.duration]).toEqual([3, 6]);
    expect(wide.midi.notes.value.map((note) => note.start)).toEqual([2]);
    expect(() => project.resizeClip(clip.id, { start: -1 })).toThrow("Project MIDI clip edges need 0 <= start < end.");
    expect(() => project.resizeClip(clip.id, { start: 9, end: 9 })).toThrow("Project MIDI clip edges need 0 <= start < end.");
    project.dispose();
  });
});

describe("review regressions", () => {
  test("extending left never places a clip before 0; an edge dragged to 0 off the sample grid lands on 0", () => {
    const project = new Project();
    const track = project.addTrack("A", "audio");
    const clip = project.addAudioClip(track.id, { sampleRate: 44_100, channels: [new Float32Array(44_100 * 4).fill(0.1)] }, 0);
    project.resizeClip(clip.id, { start: 2 });
    project.moveClip(clip.id, track.id, 0.5);
    expect(() => project.resizeClip(clip.id, { start: -1 })).toThrow("Project clips cannot start before 0.");
    expect(project.tracks[0].clips[0].time).toBe(0.5);
    project.moveClip(clip.id, track.id, 60 / 113);
    const atZero = project.resizeClip(clip.id, { start: 0 });
    expect(atZero.time).toBe(0);
    const reopened = openDawProject(saveDawProject(project)).project;
    expect(reopened.tracks[0].clips[0].time).toBe(0);
    project.dispose();
    reopened.dispose();
  });

  test("render snapshots share audio instead of copying whole recordings", () => {
    const project = new Project();
    const track = project.addTrack("A", "audio");
    const clip = project.addAudioClip(track.id, { sampleRate: 8000, channels: [new Float32Array(8000 * 60).fill(0.1)] }, 0);
    project.resizeClip(clip.id, { end: 1 });
    const render = renderSnapshot(project);
    const original = project.tracks[0].clips[0] as { channels: Float32Array[] };
    expect((render.tracks[0].clips[0] as { channels: Float32Array[] }).channels[0].buffer).toBe(original.channels[0].buffer);
    render.dispose();
    project.dispose();
  });

  test("a negative playStart in a file is rejected", () => {
    const project = new Project();
    const track = project.addTrack("A", "audio");
    const clip = project.addAudioClip(track.id, { sampleRate: 8000, channels: [new Float32Array(8000 * 4).fill(0.1)] }, 0);
    project.resizeClip(clip.id, { start: 1, end: 2 });
    const entries = unzipSync(saveDawProject(project));
    const xml = new TextDecoder()
      .decode(entries["project.xml"])
      .replace(/playStart="[^"]*"/, 'playStart="-1"')
      .replace(/playStop="[^"]*"/, 'playStop="0"');
    entries["project.xml"] = new TextEncoder().encode(xml);
    expect(() => openDawProject(zipSync(entries))).toThrow("Project XML has invalid playStart on Clip.");
    project.dispose();
  });
});

describe("foreign files that give one window edge", () => {
  const edit = (bytes: Uint8Array, change: (xml: string) => string) => {
    const files = unzipSync(bytes);
    files["project.xml"] = new TextEncoder().encode(change(new TextDecoder().decode(files["project.xml"])));
    return zipSync(files);
  };
  const saved = () => {
    const project = new Project();
    const track = project.addTrack("Take", "audio");
    const clip = project.addAudioClip(track.id, { sampleRate: RATE, channels: [recording()] }, 1);
    project.resizeClip(clip.id, { start: 1, end: 2 });
    return saveDawProject(project);
  };

  test("playStart alone ends the clip after its duration", () => {
    const bytes = edit(saved(), (xml) => xml.replace(/ playStop="[^"]*"/, ""));
    const { project, warnings } = openDawProject(bytes);
    const clip = audio(project.tracks[0].clips[0]);
    expect(warnings.join()).not.toContain("does not match");
    expect([clip.sourceOffset, clip.duration, clip.channels[0].length]).toEqual([0, 1, 8]);
    expect(clip.time).toBe(1);
  });

  test("playStop alone starts at the beginning of the recording", () => {
    const project = new Project();
    const track = project.addTrack("Take", "audio");
    const clip = project.addAudioClip(track.id, { sampleRate: RATE, channels: [recording()] }, 0);
    project.resizeClip(clip.id, { end: 2 });
    const bytes = edit(saveDawProject(project), (xml) => xml.replace(/ playStart="[^"]*"/, ""));
    const reopened = audio(openDawProject(bytes).project.tracks[0].clips[0]);
    expect([reopened.sourceOffset, reopened.duration]).toEqual([0, 2]);
  });

  test("an edge that contradicts the duration still fails", () => {
    const bytes = edit(saved(), (xml) => xml.replace(/ playStop="[^"]*"/, "").replace(/ duration="1"/, ' duration="9"'));
    expect(() => openDawProject(bytes)).toThrow();
  });
});
