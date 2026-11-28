import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { openDawProject, saveDawProject } from "../src";
import type { MidiClip, Project } from "../src";
import { parseTree, projectXmlOf, treeDifferences } from "./helpers/xml-tree";

/**
 * What a PreSonus Studio One 7.0.2 file does that DAWproject 1.0 does not, one small file per quirk (tests/fixtures/dawproject/SOURCES.md): the
 * real file (`pnpm probe:studio-one`, download-only) opens by the same rules. A quirk is read when the model can hold it exactly and otherwise
 * reported while the content stays in the file, and a save with no edit writes every one of them back as it was.
 */
const file = (name: string) => new Uint8Array(readFileSync(fileURLToPath(new URL(`./fixtures/dawproject/${name}.dawproject`, import.meta.url))));
const midiClips = (project: Project) => project.tracks.flatMap((track) => track.clips).filter((clip): clip is MidiClip => clip.kind === "midi");
const unchangedSave = (name: string, project: Project) => {
  const saved = saveDawProject(project);
  expect(treeDifferences(parseTree(projectXmlOf(file(name))), parseTree(projectXmlOf(saved)))).toEqual([]);
  return saved;
};

describe("Studio One's DAWproject files", () => {
  test('version "0.1" is read as 1.0 with a warning, and written back as the file had it', () => {
    const { project, warnings } = openDawProject(file("studio-one-version-0.1"));
    expect(warnings.join("\n")).toContain('DAWproject version "0.1"');
    expect(midiClips(project)).toHaveLength(1);
    expect(project.title).toBe("Quirk");
    const saved = unchangedSave("studio-one-version-0.1", project);
    expect(projectXmlOf(saved)).toContain('<Project version="0.1">');
    // An edit changes its clip only; the version stays.
    project.moveClip(midiClips(project)[0].id, project.tracks[0].id, 8);
    expect(projectXmlOf(saveDawProject(project))).toContain('<Project version="0.1">');
    project.dispose();
  });

  test("any other version is still refused", () => {
    const entries = unzipSync(file("studio-one-version-0.1"));
    for (const version of ["0.2", "2.0", "1"]) {
      entries["project.xml"] = strToU8(strFromU8(entries["project.xml"]).replace('version="0.1"', `version="${version}"`));
      expect(() => openDawProject(zipSync(entries))).toThrow("Project needs DAWproject version 1.0.");
    }
  });

  test("HTML entities in metadata.xml are read as the characters they name; the file is saved with those characters", () => {
    const { project, warnings } = openDawProject(file("studio-one-metadata-entity"));
    expect(warnings.join("\n")).not.toContain("metadata");
    expect(project.title).toBe("Quirk");
    const saved = saveDawProject(project);
    expect(strFromU8(unzipSync(saved)["metadata.xml"])).toContain("PreSonus © 2024 — demo");
    // project.xml is untouched by the metadata fix.
    expect(treeDifferences(parseTree(projectXmlOf(file("studio-one-metadata-entity"))), parseTree(projectXmlOf(saved)))).toEqual([]);
    project.dispose();
  });

  test("an entity outside the table is an error that names metadata.xml, not the project XML", () => {
    const entries = unzipSync(file("studio-one-metadata-entity"));
    entries["metadata.xml"] = strToU8(strFromU8(entries["metadata.xml"]).replace("&copy;", "&unknown;"));
    expect(() => openDawProject(zipSync(entries))).toThrow(/Project metadata\.xml is invalid: .*unknown/);
    // The XML's own five entities still work, and a broken project.xml is still reported as the project's.
    entries["metadata.xml"] = strToU8(strFromU8(entries["metadata.xml"]).replace("&unknown;", "&amp;&lt;"));
    expect(() => openDawProject(zipSync(entries))).not.toThrow();
    entries["project.xml"] = strToU8(strFromU8(entries["project.xml"]).replace("<Transport>", "<Transport>&nbsp;&bad;"));
    expect(() => openDawProject(zipSync(entries))).toThrow(/Project XML is invalid/);
  });

  test("a clip with a note before its content start stays in the file and is reported; the other clip plays", () => {
    const { project, warnings } = openDawProject(file("studio-one-negative-note"));
    expect(warnings.join("\n")).toContain("Clip with a note before the start of its content (a negative time)");
    expect(midiClips(project).map((clip) => project.clipName(clip.id))).toEqual(["Pattern 2"]);
    const saved = unchangedSave("studio-one-negative-note", project);
    expect(projectXmlOf(saved)).toContain('time="-0.001269"');
    // Editing the clip that was read leaves the other one's elements alone.
    project.moveClip(midiClips(project)[0].id, project.tracks[0].id, 20);
    const edited = saveDawProject(project);
    expect(projectXmlOf(edited)).toContain('time="-0.001269"');
    expect(openDawProject(edited).project.tracks[0].clips).toHaveLength(1);
    project.dispose();
  });

  test("a note without a channel plays on channel 0 and is written back without one", () => {
    const { project, warnings } = openDawProject(file("studio-one-note-without-channel"));
    expect(warnings.join("\n")).toContain("Notes without a channel attribute were read as channel 0");
    expect(midiClips(project)[0].midi.notes.value.map((note) => note.channel)).toEqual([0, 0]);
    expect(projectXmlOf(unchangedSave("studio-one-note-without-channel", project))).not.toContain("channel=");
    project.dispose();
  });

  test("volume automation with a step (two points at one time) stays in the file and is reported", () => {
    const { project, warnings } = openDawProject(file("studio-one-volume-step"));
    expect(warnings.join("\n")).toContain("Volume automation with a step (two points at one time)");
    expect(project.tracks[0].volumeAutomation).toEqual([]);
    unchangedSave("studio-one-volume-step", project);
    // The track's other values still take edits.
    project.setTrackVolume(project.tracks[0].id, 0.5);
    expect(projectXmlOf(saveDawProject(project))).toContain('<RealPoint time="8.000000" value="0.000000"');
    project.dispose();
  });

  test("a clip without a duration stays in the file and is reported; the others are read", () => {
    const { project, warnings } = openDawProject(file("studio-one-clip-without-duration"));
    expect(warnings.join("\n")).toContain("Clip without a duration (its length is left to its content)");
    expect(project.tracks[1].clips).toHaveLength(0);
    expect(midiClips(project)).toHaveLength(1);
    const saved = unchangedSave("studio-one-clip-without-duration", project);
    expect(unzipSync(saved)["audio/hit.wav"]).toEqual(unzipSync(file("studio-one-clip-without-duration"))["audio/hit.wav"]);
    project.dispose();
  });
});
