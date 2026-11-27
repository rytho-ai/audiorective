import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { DOMParser } from "@xmldom/xmldom";
import type { Element } from "@xmldom/xmldom";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { openDawProject, saveDawProject } from "../src";
import type { Project } from "../src";

/**
 * A song-wide time edit (`rippleDelete`, an inserting `copyRange`) moves the content the model carries; the content an opened file keeps verbatim
 * (clips the model cannot play, automation it does not model) has to move the same way, in its own unit, or the edit is refused before it changes anything.
 */
const dir = new URL("./fixtures/dawproject/", import.meta.url);
const file = (name: string) => new Uint8Array(readFileSync(fileURLToPath(new URL(name, dir))));
const NEGATIVE = "studio-one-negative-note.dawproject";
const NO_DURATION = "studio-one-clip-without-duration.dawproject";
const CANON = "bitwig-5.3-canon-in-d.dawproject";

const xmlOf = (bytes: Uint8Array) => strFromU8(unzipSync(bytes)["project.xml"]).replace(/^﻿/, "");
function clipsOf(bytes: Uint8Array): Record<string, { time: string | null; duration: string | null }> {
  const document = new DOMParser().parseFromString(xmlOf(bytes), "text/xml");
  const out: Record<string, { time: string | null; duration: string | null }> = {};
  for (const clip of Array.from(document.getElementsByTagName("Clip")) as Element[])
    if (clip.getAttribute("name")) out[clip.getAttribute("name")!] = { time: clip.getAttribute("time"), duration: clip.getAttribute("duration") };
  return out;
}
const times = (bytes: Uint8Array) => Object.fromEntries(Object.entries(clipsOf(bytes)).map(([name, clip]) => [name, Number(clip.time)]));
const open = (name: string) => openDawProject(file(name)).project;
const withXml = (name: string, edit: (xml: string) => string) => {
  const entries = unzipSync(file(name));
  entries["project.xml"] = strToU8(edit(strFromU8(entries["project.xml"])));
  return openDawProject(zipSync(entries)).project;
};
const message = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("expected the edit to be refused");
};

describe("a ripple delete moves the content a file keeps verbatim with the content the model carries", () => {
  test("Studio One negative note: the kept Pattern 1 and the modelled Pattern 2 both move one beat earlier", () => {
    const project = open(NEGATIVE);
    expect(project.tracks[0].clips).toHaveLength(1);
    project.rippleDelete({ startBeat: 0, endBeat: 1 });
    expect(project.tracks[0].clips[0].time).toBe(15);
    expect(times(saveDawProject(project))).toMatchObject({ "Pattern 1": 3, "Pattern 2": 15 });
    project.dispose();
  });

  test("Studio One clip without a duration: the kept audio Hit moves with the modelled pattern", () => {
    const project = open(NO_DURATION);
    project.rippleDelete({ startBeat: 0, endBeat: 1 });
    expect(times(saveDawProject(project))).toMatchObject({ "Pattern 1": 3, Hit: 7 });
    project.dispose();
  });

  test("a kept clip in seconds moves by the seconds the range lasts, not by its beats", () => {
    // 100 BPM: a second is 5/3 beats. The modelled MIDI clip moves by beats, the kept audio clip (a seconds lane) by seconds.
    const project = withXml(NO_DURATION, (xml) => xml.replace('<Lanes id="id24" track="id7">', '<Lanes id="id24" track="id7" timeUnit="seconds">'));
    project.rippleDelete({ startSeconds: 0, endSeconds: 1 });
    const saved = times(saveDawProject(project));
    expect(saved.Hit).toBe(7);
    expect(saved["Pattern 1"]).toBeCloseTo(4 - 5 / 3, 9);
    project.dispose();
  });

  test("a kept clip that the range crosses refuses the edit before anything changes, naming the clip", () => {
    const project = open(NEGATIVE);
    const before = saveDawProject(project);
    const reason = message(() => project.rippleDelete({ startBeat: 5, endBeat: 6 }));
    expect(reason).toBe(
      'Project ripple delete is blocked by kept content: clip "Pattern 1" on track "Keys" lies across the removed range. ' +
        "The file keeps content the model does not carry unchanged, and only content the model carries can be trimmed, copied or split.",
    );
    expect(project.tracks[0].clips[0].time).toBe(16);
    expect(project.cells.version.value).toBeDefined();
    expect(clipsOf(saveDawProject(project))).toEqual(clipsOf(before));
    expect(project.undo().status).toBe("rejected");
    project.dispose();
  });

  test("the same refusal comes back from applyEdits as a rejected request that changed nothing", () => {
    const project = open(NEGATIVE);
    const receipt = project.applyEdits({
      expectedVersion: project.cells.version.value,
      label: "cut",
      ops: [{ type: "rippleDelete", range: { startBeat: 5, endBeat: 6 } }],
    });
    expect(receipt).toMatchObject({ status: "rejected", opIndex: 0 });
    expect((receipt as { reason: string }).reason).toContain("is blocked by kept content");
    expect(times(saveDawProject(project))).toMatchObject({ "Pattern 1": 4, "Pattern 2": 16 });
    project.dispose();
  });

  test("undo puts the kept clip back with the text the file had, redo moves it again, repeated saves agree", () => {
    const project = open(NEGATIVE);
    project.rippleDelete({ startBeat: 0, endBeat: 1 });
    expect(times(saveDawProject(project))["Pattern 1"]).toBe(3);
    expect(times(saveDawProject(project))["Pattern 1"]).toBe(3);
    expect(project.undo().status).toBe("applied");
    const undone = saveDawProject(project);
    expect(clipsOf(undone)["Pattern 1"].time).toBe("4.000000");
    expect(times(undone)["Pattern 2"]).toBe(16);
    expect(project.redo().status).toBe("applied");
    expect(times(saveDawProject(project))).toMatchObject({ "Pattern 1": 3, "Pattern 2": 15 });
    project.dispose();
  });

  test("two cuts in a row move the kept clip by both, and undoing one leaves the other", () => {
    const project = open(NEGATIVE);
    project.rippleDelete({ startBeat: 0, endBeat: 1 });
    project.rippleDelete({ startBeat: 0, endBeat: 2 });
    expect(times(saveDawProject(project))["Pattern 1"]).toBe(1);
    project.undo();
    expect(times(saveDawProject(project))["Pattern 1"]).toBe(3);
    project.dispose();
  });

  test("Canon in D: the kept controller 121 lane stays where it is for a cut after it, and a cut over its point is refused", () => {
    const project = open(CANON);
    const reason = message(() => project.rippleDelete({ startBeat: 0, endBeat: 4 }));
    expect(reason).toContain('is blocked by kept content: the "automation lane of channelController controller 121" on track');
    expect(reason).toContain("has a point inside the removed range");
    project.rippleDelete({ startBeat: 8, endBeat: 12 });
    const saved = xmlOf(saveDawProject(project));
    expect(saved).toMatch(
      /<Target expression="channelController" channel="0" controller="121"\/>\s*<RealPoint value="0.000000" interpolation="linear" time="0.000000"\/>/,
    );
    project.dispose();
  });
});

describe("copyRange with placement insert moves kept content after the insert point and refuses what it cannot copy or split", () => {
  const insert = (project: Project, range: { startBeat: number; endBeat: number }, atBeat: number) =>
    project.applyEdits({
      expectedVersion: project.cells.version.value,
      label: "copy",
      ops: [{ type: "copyRange", range, atBeat, placement: "insert", as: "section" }],
    });

  test("a kept clip after the insert point moves later by the copied length", () => {
    const project = open(NEGATIVE);
    const receipt = insert(project, { startBeat: 0, endBeat: 2 }, 0);
    expect(receipt.status).toBe("applied");
    expect(times(saveDawProject(project))).toMatchObject({ "Pattern 1": 6, "Pattern 2": 18 });
    project.dispose();
  });

  test("a kept clip inside the copied range, or across the insert point, refuses the copy", () => {
    const project = open(NEGATIVE);
    const inside = insert(project, { startBeat: 2, endBeat: 6 }, 20);
    expect(inside).toMatchObject({ status: "rejected" });
    expect((inside as { reason: string }).reason).toContain(
      'Project copyRange is blocked by kept content: clip "Pattern 1" on track "Keys" lies inside the copied range',
    );
    const across = insert(project, { startBeat: 0, endBeat: 2 }, 6);
    expect((across as { reason: string }).reason).toContain("lies across the insert point");
    expect(times(saveDawProject(project))).toMatchObject({ "Pattern 1": 4, "Pattern 2": 16 });
    project.dispose();
  });

  test("a kept clip in seconds moves later by the seconds the insert opens", () => {
    const project = withXml(NO_DURATION, (xml) => xml.replace('<Lanes id="id24" track="id7">', '<Lanes id="id24" track="id7" timeUnit="seconds">'));
    expect(insert(project, { startBeat: 0, endBeat: 3 }, 0).status).toBe("applied");
    // 3 beats at 100 BPM last 1.8 s.
    expect(times(saveDawProject(project)).Hit).toBeCloseTo(8 + 1.8, 9);
    project.dispose();
  });
});

describe("a clip an edit places must not land on a clip the file keeps", () => {
  test("moveClip onto the kept Pattern 1 is an overlap, next to it is not", () => {
    const project = open(NEGATIVE);
    const id = project.tracks[0].clips[0].id;
    const onto = project.applyEdits({
      expectedVersion: project.cells.version.value,
      label: "move",
      ops: [{ type: "moveClip", clip: { clipId: id }, position: { atBeat: 6 } }],
    });
    expect(onto).toMatchObject({ status: "rejected", code: "overlap" });
    expect((onto as { reason: string }).reason).toBe(`Clip "${id}" would overlap kept clip "Pattern 1", which the file keeps unchanged.`);
    const beside = project.applyEdits({
      expectedVersion: project.cells.version.value,
      label: "move",
      ops: [{ type: "moveClip", clip: { clipId: id }, position: { atBeat: 12 } }],
    });
    expect(beside.status).toBe("applied");
    project.dispose();
  });
});
