import { describe, expect, test } from "vitest";
import { Project, openDawProject, saveDawProject } from "../src";

describe("time signature changes in DAWproject", () => {
  test("changes are saved as TimeSignatureAutomation and read back, with the tempo map", () => {
    const project = new Project({ bpm: 96, signature: [4, 4] });
    project.addTrack("Keys", "midi");
    project.setTempoChanges([{ beat: 32, bpm: 120 }]);
    project.setTimeSignatureChanges([
      { beat: 64, numerator: 3, denominator: 4 },
      { beat: 85, numerator: 6, denominator: 8 },
    ]);
    const reopened = openDawProject(saveDawProject(project)).project;
    expect(reopened.signature).toEqual([4, 4]);
    expect(reopened.meterMap.changes).toEqual(project.meterMap.changes);
    expect(reopened.tempoMap.changes).toEqual(project.tempoMap.changes);
    expect(reopened.meterMap.barToBeat(18)).toBe(project.meterMap.barToBeat(18));
    project.dispose();
    reopened.dispose();
  });

  test("a file without changes writes no lane, and a reopened file saves an edited meter map", () => {
    const project = new Project({ bpm: 120, signature: [7, 8] });
    project.addTrack("T", "audio");
    const plain = openDawProject(saveDawProject(project)).project;
    expect(plain.signature).toEqual([7, 8]);
    expect(plain.meterMap.changes).toEqual([]);
    plain.setTimeSignatureChanges([{ beat: 14, numerator: 4, denominator: 4 }]);
    const again = openDawProject(saveDawProject(plain)).project;
    expect(again.meterMap.changes).toEqual([{ beat: 14, numerator: 4, denominator: 4 }]);
    // Editing the lane of an opened file and clearing it.
    again.setTimeSignatureChanges([{ beat: 7, numerator: 5, denominator: 4 }]);
    const edited = openDawProject(saveDawProject(again)).project;
    expect(edited.meterMap.changes).toEqual([{ beat: 7, numerator: 5, denominator: 4 }]);
    edited.setTimeSignatureChanges([]);
    expect(openDawProject(saveDawProject(edited)).project.meterMap.changes).toEqual([]);
    for (const p of [project, plain, again, edited]) p.dispose();
  });
});
