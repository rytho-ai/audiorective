import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { openDawProject, saveDawProject, sessionFor } from "../src";
import type { AudioClip, Project } from "../src";
import { xsdViolations } from "./helpers/xsd";
import { parseTree, projectXmlOf, treeDifferences } from "./helpers/xml-tree";

/**
 * Audio clips in the form Bitwig Studio writes (tests/fixtures/dawproject/SOURCES.md): an outer Clip around a Clips with one inner Clip that holds
 * the Audio, directly, with a gain Points or inside Warps. `a-bitwig-export` is the song `blueprints/probes/bitwig-roundtrip-001/build-a.mjs`
 * wrote, edited in Bitwig (Pad late moved from 2.4 s to 7.2 s) and exported, so every other value is the one that script wrote.
 */
const file = (name: string) => new Uint8Array(readFileSync(fileURLToPath(new URL(`./fixtures/dawproject/${name}`, import.meta.url))));
const A = file("a-bitwig-export.dawproject");
const B = file("b-bitwig-native.dawproject");
const lane = (track: number) => `Project/Arrangement[0]/Lanes[0]/Lanes[${track}]/Clips[0]`;
/** Bitwig writes beats as float32 (4 s at 100 BPM is 6.6666669845581055 beats), so a value read back is the original to within this many seconds. */
const FLOAT32 = 1e-6;

const audioClips = (project: Project) => project.tracks.flatMap((track) => track.clips).filter((clip): clip is AudioClip => clip.kind === "audio");
const byName = (project: Project, name: string) => audioClips(project).find((clip) => project.clipName(clip.id) === name)!;
const near = (actual: number, expected: number) => expect(Math.abs(actual - expected)).toBeLessThan(FLOAT32);
const envelope = (clip: AudioClip) => ({ gain: 1, fadeIn: 0, fadeOut: 0, ...clip.envelope });
const messages = (violations: string[]) => new Set(violations.map((line) => line.replace(/^[^ ]+ /, "")));
/** Everything in the archive except project.xml and metadata.xml. */
const others = (archive: Uint8Array) => Object.entries(unzipSync(archive)).filter(([path]) => path !== "project.xml" && path !== "metadata.xml");

async function expectNoNewViolations(before: Uint8Array, after: Uint8Array) {
  const known = messages(await xsdViolations([{ name: "before", bytes: before }]));
  for (const message of messages(await xsdViolations([{ name: "after", bytes: after }]))) expect(known.has(message), message).toBe(true);
}

describe("our song edited and exported by Bitwig Studio 6.1.7", { timeout: 60_000 }, () => {
  test("every audio clip is read with the values the song was written with", () => {
    const { project, warnings } = openDawProject(A);
    expect(warnings.join()).not.toMatch(/Audio clip/);
    expect(project.tracks.map((track) => track.clips.filter((clip) => clip.kind === "audio").length)).toEqual([2, 2, 0, 0]);
    const fades = byName(project, "Vox fades");
    expect([fades.time, fades.duration, fades.sourceOffset, fades.sourceLength]).toEqual([0, 4, 0, 4]);
    expect(fades.channels).toHaveLength(1);
    near(envelope(fades).gain, 0.5);
    near(envelope(fades).fadeIn, 0.5);
    near(envelope(fades).fadeOut, 0.6);
    const trimmed = byName(project, "Vox trimmed");
    near(trimmed.time, 9.6);
    near(trimmed.duration, 3);
    // The trim 1.5 s to 4.5 s of a 6 s recording.
    expect([trimmed.sourceOffset, trimmed.sourceLength]).toEqual([1.5, 6]);
    expect(envelope(trimmed)).toEqual({ gain: 1, fadeIn: 0, fadeOut: 0 });
    // Bitwig moved this clip from 2.4 s to beat 12.
    const pad = byName(project, "Pad late");
    near(pad.time, 7.2);
    near(pad.duration, 3);
    expect(pad.channels).toHaveLength(2);
    near(envelope(pad).gain, 0.7);
    near(envelope(pad).fadeIn, 0);
    near(envelope(pad).fadeOut, 0.3);
    const padB = byName(project, "Pad B");
    near(padB.time, 14.4);
    near(padB.duration, 4);
    // The Session slot clip is the same form.
    const session = sessionFor(project);
    const slot = session.clipAt({ trackId: project.tracks[0].id, sceneId: session.scenes[1].id }) as AudioClip;
    expect(slot.kind).toBe("audio");
    expect(project.clipName(slot.id)).toBe("slot audio");
    near(slot.duration, 2);
    // The tempo map, not just the first tempo, places a clip: Pad B ends at beat 30, before the change to 130 BPM at beat 32.
    expect(project.tempoMap.changes).toEqual([{ beat: 32, bpm: 130 }]);
    project.dispose();
  });

  test("a save with no edit leaves project.xml the same tree and every other entry the same bytes", async () => {
    const { project } = openDawProject(A);
    const saved = saveDawProject(project);
    expect(treeDifferences(parseTree(projectXmlOf(A)), parseTree(projectXmlOf(saved)))).toEqual([]);
    const before = Object.fromEntries(others(A));
    for (const [path, bytes] of others(saved)) {
      if (path.startsWith("audiorective/")) continue;
      expect(bytes, path).toEqual(before[path]);
    }
    expect(Object.keys(before).every((path) => path in unzipSync(saved))).toBe(true);
    await expectNoNewViolations(A, saved);
    project.dispose();
  });

  test("moving one clip changes that clip's own XML and reopens at the new place", async () => {
    const { project } = openDawProject(A);
    const clip = byName(project, "Vox trimmed");
    project.moveClip(clip.id, project.tracks[0].id, clip.time + 2.4);
    const saved = saveDawProject(project);
    // Four beats on: only the outer clip's time moves; lengths, the window and the inner clip stay as Bitwig wrote them.
    expect(treeDifferences(parseTree(projectXmlOf(A)), parseTree(projectXmlOf(saved)))).toEqual([`${lane(0)}/Clip[1]@time`]);
    expect(parseTree(projectXmlOf(saved)).children.find((child) => child.tag === "Arrangement")).toBeDefined();
    await expectNoNewViolations(A, saved);
    const reopened = openDawProject(saved);
    const moved = byName(reopened.project, "Vox trimmed");
    near(moved.time, 12);
    near(moved.duration, 3);
    expect(moved.sourceOffset).toBe(1.5);
    expect(treeDifferences(parseTree(projectXmlOf(saved)), parseTree(projectXmlOf(saveDawProject(reopened.project))))).toEqual([]);
    reopened.project.dispose();
    project.dispose();
  });

  test("a clip moved past a tempo change keeps its seconds: its length in beats follows the tempo", () => {
    const { project } = openDawProject(A);
    const clip = byName(project, "Pad B");
    project.moveClip(clip.id, project.tracks[1].id, 30);
    const saved = saveDawProject(project);
    const changed = treeDifferences(parseTree(projectXmlOf(A)), parseTree(projectXmlOf(saved)));
    expect(changed.every((path) => path.startsWith(`${lane(1)}/Clip[1]`))).toBe(true);
    expect(changed).toContain(`${lane(1)}/Clip[1]@time`);
    expect(changed).toContain(`${lane(1)}/Clip[1]@duration`);
    expect(changed).toContain(`${lane(1)}/Clip[1]/Clips[0]/Clip[0]@duration`);
    const reopened = openDawProject(saved);
    const again = byName(reopened.project, "Pad B");
    near(again.time, 30);
    near(again.duration, 4);
    reopened.project.dispose();
    project.dispose();
  });

  test("trimming, resizing, fades, gain and a name are written into the form the file uses and reopen equal", async () => {
    const { project } = openDawProject(A);
    const trimmed = byName(project, "Vox trimmed");
    const window = project.setClipSourceRange(trimmed.id, { start: 2, end: 4 }) as AudioClip;
    near(window.duration, 2);
    project.setAudioClipEnvelope(trimmed.id, { gain: 0.25, fadeIn: 0.3, fadeOut: 0.2 });
    project.setClipName(trimmed.id, "Vox tightened");
    const ends = project.resizeClip(byName(project, "Pad B").id, { end: 14.4 + 3 }) as AudioClip;
    near(ends.duration, 3);
    const saved = saveDawProject(project);
    const changed = treeDifferences(parseTree(projectXmlOf(A)), parseTree(projectXmlOf(saved)));
    expect(changed.length).toBeGreaterThan(0);
    for (const path of changed) expect(path.startsWith(`${lane(0)}/Clip[1]`) || path.startsWith(`${lane(1)}/Clip[1]`), path).toBe(true);
    // Still the nested form: the edited clips keep their one Clips child and no Audio moved up beside it.
    const edited = parseTree(projectXmlOf(saved)).children.find((child) => child.tag === "Arrangement")!.children[0].children[0].children[0]
      .children[1];
    expect(edited.children.map((child) => child.tag)).toEqual(["Clips"]);
    await expectNoNewViolations(A, saved);
    const reopened = openDawProject(saved);
    expect(reopened.warnings.join()).not.toMatch(/Audio clip/);
    const again = byName(reopened.project, "Vox tightened");
    near(again.time, 9.6);
    near(again.duration, 2);
    expect(again.sourceOffset).toBeCloseTo(2, 5);
    expect(again.sourceLength).toBe(6);
    near(envelope(again).gain, 0.25);
    near(envelope(again).fadeIn, 0.3);
    near(envelope(again).fadeOut, 0.2);
    const padB = byName(reopened.project, "Pad B");
    near(padB.duration, 3);
    // Everything else is as it was.
    near(byName(reopened.project, "Vox fades").duration, 4);
    expect(treeDifferences(parseTree(projectXmlOf(saved)), parseTree(projectXmlOf(saveDawProject(reopened.project))))).toEqual([]);
    reopened.project.dispose();
    project.dispose();
  });

  test("removing a clip takes out its elements and nothing else; a duplicate and a split arrive in the same nested form", async () => {
    const { project } = openDawProject(A);
    project.removeClip(byName(project, "Pad late").id);
    const removed = saveDawProject(project);
    const clipsOf = (archive: Uint8Array) =>
      parseTree(projectXmlOf(archive)).children.find((child) => child.tag === "Arrangement")!.children[0].children[1].children[0].children;
    // The clip's elements are gone; the other clip of the lane is the tree Bitwig wrote.
    expect(clipsOf(A).map((clip) => clip.attrs.name)).toEqual(["Pad late", "Pad B"]);
    expect(clipsOf(removed)).toEqual([clipsOf(A)[1]]);
    expect(audioClips(openDawProject(removed).project)).toHaveLength(3);
    project.dispose();

    const second = openDawProject(A).project;
    const copy = second.duplicateClip(byName(second, "Vox fades").id, 20) as AudioClip;
    const [left, right] = second.splitClip(byName(second, "Pad B").id, 1.5) as unknown as [AudioClip, AudioClip];
    const saved = saveDawProject(second);
    const reopened = openDawProject(saved);
    expect(reopened.warnings.join()).not.toMatch(/Audio clip/);
    const clips = audioClips(reopened.project);
    expect(clips).toHaveLength(6);
    expect(reopened.project.tracks[0].clips.filter((clip) => clip.kind === "audio")).toHaveLength(3);
    const copied = clips.find((clip) => Math.abs(clip.time - 20) < FLOAT32)!;
    near(copied.duration, copy.duration);
    near(envelope(copied).gain, 0.5);
    near(envelope(copied).fadeIn, 0.5);
    near(envelope(copied).fadeOut, 0.6);
    const pieces = clips.filter((clip) => Math.abs(clip.time - left.time) < FLOAT32 || Math.abs(clip.time - right.time) < FLOAT32);
    expect(pieces.map((clip) => Math.round(clip.sourceOffset * 1e4) / 1e4).sort()).toEqual([0, 1.5]);
    // Every audio clip of the saved file is in the nested form: the outer Clip holds a Clips, never the Audio itself.
    const arrangement = parseTree(projectXmlOf(saved)).children.find((child) => child.tag === "Arrangement")!;
    for (const track of [0, 1]) {
      const outers = arrangement.children[0].children[track].children[0].children;
      expect(outers).toHaveLength(3);
      for (const outer of outers) expect(outer.children.map((child) => child.tag)).toEqual(["Clips"]);
    }
    await expectNoNewViolations(A, saved);
    reopened.project.dispose();
    second.dispose();
  });
});

/** The b file is a Bitwig project with one clip whose Warps hold two points: 4 s of audio over 8 beats. */
describe("a clip with warp markers from Bitwig Studio 6.1.7", () => {
  const withTempo = (bpm: number) => {
    const entries = unzipSync(B);
    entries["project.xml"] = strToU8(
      strFromU8(entries["project.xml"])
        .replaceAll('value="100.000000" id="id0"', `value="${bpm}.000000" id="id0"`)
        .replace('<RealPoint value="100.000000"', `<RealPoint value="${bpm}.000000"`),
    );
    return zipSync(entries);
  };

  test("at the project's 100 BPM the 8 beats last 4.8 s for 4 s of audio: it is a stretched clip and the file is saved untouched", () => {
    const { project, warnings } = openDawProject(B);
    expect(warnings.join()).not.toMatch(/Audio clip/);
    const [clip] = audioClips(project);
    expect(clip.stretch?.ratio).toBeCloseTo(1.2, 9);
    expect(project.tracks[0].clips).toHaveLength(1);
    const saved = saveDawProject(project);
    expect(treeDifferences(parseTree(projectXmlOf(B)), parseTree(projectXmlOf(saved)))).toEqual([]);
    expect(unzipSync(saved)["audio/click44.wav"]).toEqual(unzipSync(B)["audio/click44.wav"]);
    project.dispose();
  });

  test("the same file at 120 BPM (the tempo of its warp) has the two points as the identity and is an ordinary clip", async () => {
    const source = withTempo(120);
    const { project, warnings } = openDawProject(source);
    expect(warnings.join()).not.toMatch(/Audio clip/);
    const clip = audioClips(project)[0];
    // The clip starts at beat 1: 0.5 s at 120 BPM; 8 beats are 4 s, the whole 44.1 kHz recording.
    expect([clip.time, clip.duration, clip.sourceOffset, clip.sampleRate, clip.channels[0].length]).toEqual([0.5, 4, 0, 44_100, 176_400]);
    expect(project.clipName(clip.id)).toBe("click44");
    const saved = saveDawProject(project);
    expect(treeDifferences(parseTree(projectXmlOf(source)), parseTree(projectXmlOf(saved)))).toEqual([]);
    // Move it one beat and cut it short: the Warps are rewritten for the new window and it reopens the same.
    project.moveClip(clip.id, project.tracks[1].id, 1);
    project.setClipSourceRange(clip.id, { start: 1, end: 3 });
    project.setAudioClipEnvelope(clip.id, { gain: 0.5, fadeIn: 0.25, fadeOut: 0 });
    const edited = saveDawProject(project);
    const reopened = openDawProject(edited);
    expect(reopened.warnings.join()).not.toMatch(/Audio clip/);
    const again = audioClips(reopened.project)[0];
    expect([again.time, again.duration, again.sourceOffset]).toEqual([1, 2, 1]);
    near(envelope(again).gain, 0.5);
    near(envelope(again).fadeIn, 0.25);
    expect(projectXmlOf(edited)).toContain("<Warps");
    const changed = treeDifferences(parseTree(projectXmlOf(source)), parseTree(projectXmlOf(edited)));
    expect(changed.every((path) => path.includes("Clips[0]/Clip[0]"))).toBe(true);
    await expectNoNewViolations(source, edited);
    reopened.project.dispose();
    project.dispose();
  });
});
