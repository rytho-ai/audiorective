import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { Project, openDawProject, openDawProjectBlob, portabilityReport, saveDawProject, saveDawProjectTo } from "../src";
import type { AudioClip } from "../src";
import { parseTree, projectXmlOf, treeDifferences } from "./helpers/xml-tree";

/**
 * Audio a file stores in a format the reader does not decode itself (Ogg Vorbis, FLAC, MP3, Opus) opens as ordinary clips whose audio is pending
 * decode: the clip's place, length and window come from the XML and the Audio element's sampleRate, channels and duration. The browser decodes it when
 * a Workspace opens the file (`dawproject-compressed-audio.browser.test.ts`). The files are in tests/fixtures/compressed-audio (SOURCES.md there).
 */
const path = (name: string) => fileURLToPath(new URL(`./fixtures/compressed-audio/${name}`, import.meta.url));
const fixture = () => new Uint8Array(readFileSync(path("compressed-audio.dawproject")));
const audioClips = (project: Project) => Object.fromEntries(project.tracks.map((track) => [track.name, track.clips[0] as AudioClip | undefined]));
const audioEntries = (archive: Uint8Array) => Object.fromEntries(Object.entries(unzipSync(archive)).filter(([name]) => name.startsWith("audio/")));

describe("compressed audio in a DAWproject file", () => {
  test("every clip exists with its place, length and window; its audio is pending decode", () => {
    const { project, warnings } = openDawProject(fixture());
    expect(warnings).toEqual([]);
    const clips = audioClips(project);
    // [time s, duration s, source offset s, recording rate]: 120 BPM, so a beat is half a second.
    const expected = {
      Ogg: [1, 1, 0, 44100],
      Flac: [1, 0.5, 0.25, 48000],
      Mp3: [2, 1, 0, 44100],
      Opus: [4, 1, 0, 48000],
      Broken: [6, 1, 0, 44100],
    } as const;
    for (const [name, [time, duration, offset, rate]] of Object.entries(expected)) {
      const clip = clips[name]!;
      expect(clip.kind, name).toBe("audio");
      expect([clip.time, clip.duration, clip.sourceOffset, clip.sampleRate, clip.sourceLength], name).toEqual([time, duration, offset, rate, 1]);
      expect(clip.media?.pending, name).toBe(true);
    }
    expect(clips.Ogg!.media!.channelCount).toBe(2);
    expect(project.tracks.map((track) => track.clips.length)).toEqual([1, 1, 1, 1, 1]);
    project.dispose();
  });

  test("a pending clip cannot be read, and the error says how to decode it", async () => {
    const { project } = openDawProject(fixture());
    const { media } = audioClips(project).Ogg!;
    await expect(media!.readFrames(0, 10)).rejects.toThrow(
      'AudioMedia is not decoded yet: open the project with openWorkspace so the browser decodes "audio/click.ogg".',
    );
    await expect(media!.peaks()).rejects.toThrow("AudioMedia is not decoded yet");
    project.dispose();
  });

  test("a Blob opens the same way", async () => {
    const { project, warnings } = await openDawProjectBlob(new Blob([fixture() as Uint8Array<ArrayBuffer>]));
    expect(warnings).toEqual([]);
    expect(audioClips(project).Mp3!.media!.pending).toBe(true);
    project.dispose();
  });

  test("a save with no edit keeps project.xml's tree and every audio entry byte for byte", async () => {
    const original = fixture();
    const { project } = openDawProject(original);
    const saved = saveDawProject(project);
    expect(treeDifferences(parseTree(projectXmlOf(original)), parseTree(projectXmlOf(saved)))).toEqual([]);
    expect(audioEntries(saved)).toEqual(audioEntries(original));
    expect(Object.keys(audioEntries(saved)).sort()).toEqual([
      "audio/broken.ogg",
      "audio/click.flac",
      "audio/click.mp3",
      "audio/click.ogg",
      "audio/click.opus",
    ]);
    // The streaming save writes the same archive content.
    const chunks: Uint8Array[] = [];
    await saveDawProjectTo(project, new WritableStream({ write: (chunk) => void chunks.push(chunk) }));
    const streamed = new Uint8Array(chunks.reduce((n, chunk) => n + chunk.length, 0));
    chunks.reduce((at, chunk) => (streamed.set(chunk, at), at + chunk.length), 0);
    expect(audioEntries(streamed)).toEqual(audioEntries(original));
    project.dispose();
  });

  test("edited clips keep pointing at the same files, with the file's own Audio attributes, and the audio bytes do not change", () => {
    const original = fixture();
    const { project } = openDawProject(original);
    const clips = audioClips(project);
    project.moveClip(clips.Ogg!.id, project.tracks[0].id, 3);
    project.resizeClip(clips.Mp3!.id, { end: clips.Mp3!.time + 0.6 });
    project.setAudioClipEnvelope(clips.Flac!.id, { gain: 0.5, fadeIn: 0.1, fadeOut: 0 });
    project.setAudioClipEnvelope(clips.Opus!.id, { gain: 1, fadeIn: 0, fadeOut: 0.2 });
    const saved = saveDawProject(project);
    expect(audioEntries(saved)).toEqual(audioEntries(original));
    const xml = projectXmlOf(saved);
    for (const file of ["click.ogg", "click.flac", "click.mp3", "click.opus"]) expect(xml.split(`path="audio/${file}"`)).toHaveLength(2);
    // The Audio elements still state the files' rates, channels and duration, not the model's.
    expect(xml).toMatch(/<Audio [^>]*sampleRate="44100"[^>]*duration="1\.000000"[^>]*channels="2"|<Audio [^>]*channels="2"[^>]*sampleRate="44100"/);
    expect((xml.match(/sampleRate="48000"/g) ?? []).length).toBe(2);
    // The Studio One form of the moved clip stays: an outer Clip around a nested Clip with Warps.
    expect(xml).toContain("<Warps");
    const reopened = openDawProject(saved);
    const after = audioClips(reopened.project);
    expect(after.Ogg!.time).toBe(3);
    expect(after.Mp3!.duration).toBeCloseTo(0.6, 6);
    expect(after.Flac!.envelope).toMatchObject({ gain: 0.5, fadeIn: 0.1 });
    expect(after.Opus!.envelope).toMatchObject({ fadeOut: 0.2 });
    for (const clip of Object.values(after)) expect(clip!.media!.pending).toBe(true);
    reopened.project.dispose();
    project.dispose();
  });

  test("an Audio element without sampleRate, channels and duration leaves the clip in the file with a warning", () => {
    const entries = unzipSync(fixture());
    entries["project.xml"] = strToU8(
      strFromU8(entries["project.xml"]).replace(
        / duration="1\.000000" channels="1"><File external="false" path="audio\/click\.mp3"/,
        ' channels="1"><File external="false" path="audio/click.mp3"',
      ),
    );
    const { project, warnings } = openDawProject(zipSync(entries));
    expect(project.tracks[2].clips).toHaveLength(0);
    expect(warnings.join("\n")).toContain(
      "Audio in a format the model cannot read, with no sampleRate, channels and duration stated: audio/click.mp3",
    );
    expect(audioEntries(saveDawProject(project))["audio/click.mp3"]).toEqual(entries["audio/click.mp3"]);
    project.dispose();
  });

  test("the portability report says the compressed files travel unchanged, only for a project that has them", () => {
    const { project } = openDawProject(fixture());
    expect(portabilityReport(project).standardContent).toContain(
      "audio clips that keep their original compressed files (Ogg, MP3, FLAC, ...) byte for byte",
    );
    project.dispose();
    const plain = new Project({ bpm: 120 });
    expect(portabilityReport(plain).standardContent.join()).not.toContain("compressed");
    plain.dispose();
  });
});
