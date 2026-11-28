import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { strFromU8, unzipSync, zipSync } from "fflate";
import { openDawProject, saveDawProject } from "../src";
import type { AudioClip, Project } from "../src";
import { parseTree, projectXmlOf, treeDifferences } from "./helpers/xml-tree";

/**
 * A moving clip gain curve in Bitwig's nested form: an outer `Clip` > `Clips` > inner `Clip` > `Lanes` holding the `Audio` and a `Points` with
 * `Target expression="gain"`. `bitwig-6.1.7-interpolation.dawproject` is Bitwig Studio 6.1.7's own export of a 12 s sine on track `GainCurve` whose
 * curve is 0.2 held, a jump to 0.8 at 4 s and a ramp to 0.5 at 8 s. Bitwig wrote it in beats at 120 BPM (0, 8, 8, 16) with no `timeUnit` on the
 * `Points`, and a hold as the value repeated at the next time.
 */
const bytes = new Uint8Array(readFileSync(fileURLToPath(new URL("./fixtures/dawproject/bitwig-6.1.7-interpolation.dawproject", import.meta.url))));
const projectXml = (archive: Uint8Array) => strFromU8(unzipSync(archive)["project.xml"]);
const gainBlock = /<Points[^>]*>\s*<Target expression="gain"\/>[\s\S]*?<\/Points>/;
const toneB = (project: Project): AudioClip => {
  const clip = project.tracks.find((track) => track.name === "GainCurve")!.clips[0];
  if (clip?.kind !== "audio") throw new Error("Expected an audio clip");
  return clip;
};
const curve = [
  { time: 0, value: 0.2, shape: "hold" as const },
  { time: 4, value: 0.8, shape: "linear" as const },
  { time: 8, value: 0.5, shape: "hold" as const },
];

describe("Bitwig's moving clip gain curve", () => {
  test("is read into the clip's gain automation in source seconds", () => {
    const opened = openDawProject(bytes);
    // Beats at 120 BPM are half a second each, so (0, 8, 8, 16) is 0, 4 s and 8 s; the pair at 8 repeats 0.2 and then jumps, which is a hold.
    expect(toneB(opened.project).gainAutomation).toEqual({ sourceStart: 0, points: curve });
    expect(toneB(opened.project).envelope?.gain ?? 1).toBe(1);
    expect(opened.warnings.join()).not.toContain("gain curve");
    expect(opened.warnings.join()).not.toContain("nested clip");
    opened.project.dispose();
  });

  test("a save with no edit keeps project.xml and every other entry as Bitwig wrote them", () => {
    const opened = openDawProject(bytes);
    const saved = saveDawProject(opened.project);
    expect(treeDifferences(parseTree(projectXmlOf(bytes)), parseTree(projectXmlOf(saved)))).toEqual([]);
    const before = unzipSync(bytes);
    const after = unzipSync(saved);
    for (const path of Object.keys(before).filter((path) => path.startsWith("audio/"))) expect(after[path], path).toEqual(before[path]);
    opened.project.dispose();
  }, 60_000);

  test("editing one point changes only that curve, in beats, and Bitwig's own points stay where they can", () => {
    const opened = openDawProject(bytes);
    opened.project.setAudioClipGainAutomation(toneB(opened.project).id, [curve[0], { time: 4, value: 0.6, shape: "linear" }, curve[2]]);
    const saved = saveDawProject(opened.project);
    const after = projectXml(saved);
    // Everything outside the gain curve of Tone B is as Bitwig wrote it; the curve's own `Points` now states its unit, which Bitwig reads in seconds without it.
    const changed = treeDifferences(parseTree(projectXmlOf(bytes)), parseTree(projectXmlOf(saved)));
    expect(changed.every((path) => /Lanes\[1\]\/Clips\[0\]\/Clip\[0\]\/Clips\[0\]\/Clip\[0\]\/Lanes\[0\]\/Points\[0\]/.test(path))).toBe(true);
    const block = gainBlock.exec(after.slice(after.indexOf("Tone B")))![0];
    expect(block).toContain('timeUnit="beats"');
    const points = [...block.matchAll(/<RealPoint[^>]*>/g)].map((match) => match[0]);
    // Seconds 0, 4, 8 are beats 0, 8, 16: the value 0.8 at beat 8 became 0.6, and the last point is the one Bitwig wrote.
    expect(points.map((point) => /time="([^"]+)"/.exec(point)![1]).map(Number)).toEqual([0, 8, 16]);
    expect(points.map((point) => /value="([^"]+)"/.exec(point)![1]).map(Number)).toEqual([0.2, 0.6, 0.5]);
    expect(points[2]).toBe('<RealPoint value="0.500000" interpolation="linear" time="16.000000"/>');
    const again = openDawProject(saved);
    expect(toneB(again.project).gainAutomation).toEqual({ sourceStart: 0, points: [curve[0], { time: 4, value: 0.6, shape: "linear" }, curve[2]] });
    again.project.dispose();
    opened.project.dispose();
  });

  test("a trimmed clip's curve stays in the file, unmodeled: where its time 0 falls was not verified in Bitwig", () => {
    const files = unzipSync(bytes);
    const xml = strFromU8(files["project.xml"]);
    const at = xml.indexOf('name="Tone B"');
    const start = xml.lastIndexOf("<Clip ", at);
    const segment = xml.slice(start, xml.indexOf("</Clips>", at));
    const trimmed = segment
      .replace('duration="24.0" playStart="0.0"', 'duration="20.0" playStart="4.0"')
      .replace('duration="24.0" contentTimeUnit="seconds" playStart="0.0"', 'duration="20.0" contentTimeUnit="seconds" playStart="2.0"');
    expect(trimmed).not.toBe(segment);
    files["project.xml"] = new TextEncoder().encode(xml.replace(segment, trimmed));
    const opened = openDawProject(zipSync(files));
    expect(opened.project.tracks.find((track) => track.name === "GainCurve")!.clips).toHaveLength(0);
    expect(opened.warnings.join()).toContain("moving gain curve inside a trimmed nested clip");
    opened.project.dispose();
  });
});
