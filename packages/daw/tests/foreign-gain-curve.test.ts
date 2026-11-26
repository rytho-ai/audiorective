import { unzipSync, zipSync } from "fflate";
import { describe, expect, test } from "vitest";
import { openDawProject, saveDawProject } from "../src";
import { foreignGainFile, projectXml } from "./helpers/foreign-gain";

const clipOf = (project: ReturnType<typeof openDawProject>["project"]) => {
  const clip = project.tracks[0].clips[0];
  if (clip?.kind !== "audio") throw new Error("Expected an audio clip");
  return clip;
};

describe("a moving gain curve from another application's file", () => {
  test("seconds, hold and linear points become the clip's gain automation", () => {
    const { bytes } = foreignGainFile([
      { time: 0, value: 0.2, interpolation: "hold" },
      { time: 1, value: 0.8, interpolation: "linear" },
      { time: 3, value: 0.2, interpolation: "linear" },
    ]);
    const opened = openDawProject(bytes);
    const clip = clipOf(opened.project);
    expect(clip.envelope?.gain ?? 1).toBe(1);
    expect(clip.gainAutomation?.sourceStart).toBe(0);
    expect(clip.gainAutomation?.points).toEqual([
      { time: 0, value: 0.2, shape: "hold" },
      { time: 1, value: 0.8, shape: "linear" },
      { time: 3, value: 0.2, shape: "linear" },
    ]);
    expect(opened.warnings.join()).not.toContain("gain curve");
    opened.project.dispose();
  });

  test("beats points run at the tempo where the clip starts, and a same-time pair is a step", () => {
    const { bytes } = foreignGainFile(
      [
        { time: 0, value: 0.2 },
        { time: 2, value: 0.2 },
        { time: 2, value: 1 },
        { time: 6, value: 0.5 },
      ],
      { timeUnit: "beats", bpm: 120 },
    );
    const opened = openDawProject(bytes);
    // 120 BPM is half a second per beat; the earlier of the two points at beat 2 gives way to the later one.
    expect(clipOf(opened.project).gainAutomation?.points).toEqual([
      { time: 0, value: 0.2, shape: "linear" },
      { time: 1, value: 1, shape: "linear" },
      { time: 3, value: 0.5, shape: "linear" },
    ]);
    opened.project.dispose();
  });

  test("a file that is saved unchanged keeps its project.xml byte for byte", () => {
    const { bytes, xml } = foreignGainFile([
      { time: 0, value: 0.2 },
      { time: 2, value: 1 },
    ]);
    const opened = openDawProject(bytes);
    expect(projectXml(saveDawProject(opened.project))).toBe(xml);
    opened.project.dispose();
  });

  test("an edit to the curve patches the source's points and keeps its lanes, ids and unit", () => {
    for (const timeUnit of ["seconds", "beats"] as const) {
      const scale = timeUnit === "beats" ? 2 : 1;
      const { bytes, xml } = foreignGainFile(
        [
          { time: 0, value: 0.2 },
          { time: 2 * scale, value: 1 },
        ],
        { timeUnit },
      );
      const opened = openDawProject(bytes);
      const clip = clipOf(opened.project);
      opened.project.setAudioClipGainAutomation(clip.id, [
        { time: 0, value: 0.5, shape: "linear" },
        { time: 1, value: 0.5, shape: "hold" },
        { time: 3, value: 0, shape: "linear" },
      ]);
      const saved = projectXml(saveDawProject(opened.project));
      expect(saved).toContain(`<Points id="gain1" timeUnit="${timeUnit}" unit="linear"><Target expression="gain"/>`);
      expect(saved).toContain(
        `<RealPoint time="0" value="0.5" interpolation="linear"/><RealPoint time="${1 * scale}" value="0.5" interpolation="hold"/><RealPoint time="${3 * scale}" value="0" interpolation="linear"/>`,
      );
      // Everything outside the points is as the source wrote it.
      const outside = (text: string) => text.replace(/<Points [\s\S]*?<\/Points>/, "");
      expect(outside(saved)).toBe(outside(xml));
      const again = openDawProject(saveDawProject(opened.project));
      expect(clipOf(again.project).gainAutomation?.points).toEqual(clipOf(opened.project).gainAutomation?.points);
      again.project.dispose();
      opened.project.dispose();
    }
  });

  test("pan and other expressions stay kept, not played", () => {
    const { bytes } = foreignGainFile([
      { time: 0, value: 0.2 },
      { time: 2, value: 1 },
    ]);
    const files = unzipSync(bytes);
    files["project.xml"] = new TextEncoder().encode(projectXml(bytes).replace('expression="gain"', 'expression="pan"'));
    const opened = openDawProject(zipSync(files));
    expect(opened.project.tracks[0].clips).toHaveLength(0);
    expect(opened.warnings.join()).toContain("gain curve or other automation");
    opened.project.dispose();
  });
});
