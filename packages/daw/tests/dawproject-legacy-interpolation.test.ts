import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { openDawProject, saveDawProject } from "../src";
import type { Project } from "../src";

/**
 * Files an earlier Audiorective build wrote gave a point's `interpolation` the LEAVING meaning (the model's `shape`) for track volume automation and clip
 * gain curves; the current format gives it Bitwig's ARRIVING meaning and says so with `audiorective/state.json` version 4. The fixture was written by the
 * writer of commit 278ee19 (sidecar version 3, no build of it was released) from the project below; it is not edited by hand.
 */
const legacy = new Uint8Array(
  readFileSync(fileURLToPath(new URL("./fixtures/dawproject/audiorective-legacy-leaving-interpolation.dawproject", import.meta.url))),
);
const clipCurve = [
  { time: 0, value: 0.2, shape: "hold" as const },
  { time: 0.25, value: 0.8, shape: "linear" as const },
  { time: 0.5, value: 0.4, shape: "hold" as const },
  { time: 0.75, value: 0.9, shape: "linear" as const },
  { time: 1, value: 0.5, shape: "hold" as const },
];
const volumeCurve = [
  { time: 0, value: 0.3, shape: "linear" as const },
  { time: 2, value: 1, shape: "hold" as const },
  { time: 4, value: 0.6, shape: "linear" as const },
  { time: 6, value: 0.2, shape: "hold" as const },
];
const sidecar = (archive: Uint8Array) => JSON.parse(strFromU8(unzipSync(archive)["audiorective/state.json"]));
const xmlOf = (archive: Uint8Array) => strFromU8(unzipSync(archive)["project.xml"]);
const interpolations = (xml: string, marker: string) =>
  [
    ...xml
      .slice(xml.indexOf(marker))
      .split("</Points>")[0]
      .matchAll(/interpolation="(\w+)"/g),
  ].map((match) => match[1]);
const clipOf = (project: Project) => {
  const clip = project.tracks.find((track) => track.name === "Voice")!.clips[0];
  if (clip?.kind !== "audio") throw new Error("Expected an audio clip");
  return clip;
};
const volumeOf = (project: Project) => project.tracks.find((track) => track.name === "Voice")!.volumeAutomation;

describe("a file an earlier build wrote", () => {
  test("the fixture is what that writer produced: sidecar version 3 and the model's own shapes in `interpolation`", () => {
    expect(sidecar(legacy).version).toBe(3);
    expect(interpolations(xmlOf(legacy), '<Target expression="gain"/>')).toEqual(["hold", "linear", "hold", "linear", "hold"]);
    expect(interpolations(xmlOf(legacy), '<Target parameter="track1-volume"/>')).toEqual(["linear", "hold", "linear", "hold"]);
  });

  test("reopens with the curves it was saved with, not shifted by a point", () => {
    const opened = openDawProject(legacy);
    expect(opened.warnings).toEqual([]);
    expect(volumeOf(opened.project)).toEqual(volumeCurve);
    expect(clipOf(opened.project).gainAutomation).toEqual({ sourceStart: 0, points: clipCurve });
    // The controller events of the MIDI clip (pedal and mod wheel, written as hold points) are as they were.
    const keys = opened.project.tracks.find((track) => track.name === "Keys")!.clips[0];
    expect(keys.kind === "midi" && keys.events.map((event) => [event.time, ...event.data])).toEqual([
      [0, 0xb0, 64, 127],
      [0.5, 0xb0, 1, 32],
      [1, 0xb0, 1, 96],
      [1.5, 0xb0, 64, 0],
    ]);
    opened.project.dispose();
  });

  test("the clip's XML curve is read the same way when its details do not match the clip", () => {
    const files = unzipSync(legacy);
    const state = JSON.parse(strFromU8(files["audiorective/state.json"]));
    // The details no longer name this clip, so the curve comes from the XML, which the older build wrote with the leaving meaning.
    state.clips[0].id = "clip99";
    state.clips[0].fingerprint = "audio/other.wav";
    files["audiorective/state.json"] = strToU8(JSON.stringify(state));
    const opened = openDawProject(zipSync(files));
    expect(clipOf(opened.project).gainAutomation).toEqual({ sourceStart: 0, points: clipCurve });
    opened.project.dispose();
  });

  test("saving writes the arriving meaning and the version 4 marker, and the curves reopen identical, also after a second save", () => {
    const opened = openDawProject(legacy);
    const saved = saveDawProject(opened.project);
    expect(sidecar(saved).version).toBe(4);
    // Arrival is the previous point's shape (the first writes its own).
    expect(interpolations(xmlOf(saved), '<Target expression="gain"/>')).toEqual(["hold", "hold", "linear", "hold", "linear"]);
    expect(interpolations(xmlOf(saved), '<Target parameter="track1-volume"/>')).toEqual(["linear", "linear", "hold", "linear"]);
    const again = openDawProject(saved);
    expect(volumeOf(again.project)).toEqual(volumeCurve);
    expect(clipOf(again.project).gainAutomation).toEqual({ sourceStart: 0, points: clipCurve });
    const third = openDawProject(saveDawProject(again.project));
    expect(volumeOf(third.project)).toEqual(volumeCurve);
    expect(clipOf(third.project).gainAutomation).toEqual({ sourceStart: 0, points: clipCurve });
    for (const project of [opened.project, again.project, third.project]) project.dispose();
  });

  test("a file kept as an overlay is converted in its own XML, so its sidecar and its curves agree after a save", () => {
    const files = unzipSync(legacy);
    // Another lane the model does not carry makes the save patch the file's own XML instead of writing it afresh.
    files["project.xml"] = strToU8(
      strFromU8(files["project.xml"]).replace(
        '<Lanes id="track3-lane"',
        '<Lanes id="orphan" track="nowhere"><Clips id="orphan-clips"/></Lanes><Lanes id="track3-lane"',
      ),
    );
    const opened = openDawProject(zipSync(files));
    expect(opened.warnings.join()).toContain("Kept in the file");
    const saved = saveDawProject(opened.project);
    expect(sidecar(saved).version).toBe(4);
    expect(interpolations(xmlOf(saved), '<Target parameter="track1-volume"/>')).toEqual(["linear", "linear", "hold", "linear"]);
    const again = openDawProject(saved);
    expect(volumeOf(again.project)).toEqual(volumeCurve);
    expect(clipOf(again.project).gainAutomation).toEqual({ sourceStart: 0, points: clipCurve });
    opened.project.dispose();
    again.project.dispose();
  });
});

describe("the marker rule", () => {
  test("a file without the Audiorective sidecar, or from another application, reads the arriving meaning", () => {
    const files = unzipSync(legacy);
    delete files["audiorective/state.json"];
    const stripped = openDawProject(zipSync(files));
    // Without a sidecar nothing says the file is old, so `interpolation` is how a value arrives: 0.3 ramps to 1 first, the others follow.
    expect(volumeOf(stripped.project).map((point) => point.shape)).toEqual(["hold", "linear", "hold", "hold"]);
    stripped.project.dispose();

    const withSidecar = unzipSync(legacy);
    withSidecar["project.xml"] = strToU8(
      strFromU8(withSidecar["project.xml"]).replace('<Application name="Audiorective"', '<Application name="Bitwig Studio"'),
    );
    const foreign = openDawProject(zipSync(withSidecar));
    expect(volumeOf(foreign.project).map((point) => point.shape)).toEqual(["hold", "linear", "hold", "hold"]);
    foreign.project.dispose();
  });

  test("a sidecar of version 4 reads the arriving meaning", () => {
    const opened = openDawProject(legacy);
    const saved = saveDawProject(opened.project);
    const reopened = openDawProject(saved);
    expect(volumeOf(reopened.project)).toEqual(volumeCurve);
    opened.project.dispose();
    reopened.project.dispose();
  });

  test("Bitwig Studio 6.1.7's own file still reads the arriving meaning", () => {
    const bitwig = new Uint8Array(
      readFileSync(fileURLToPath(new URL("./fixtures/dawproject/bitwig-6.1.7-interpolation.dawproject", import.meta.url))),
    );
    const opened = openDawProject(bitwig);
    expect(opened.project.tracks.find((track) => track.name === "VolCurve")!.volumeAutomation).toEqual([
      { time: 0, value: 0.2, shape: "hold" },
      { time: 4, value: 0.8, shape: "linear" },
      { time: 8, value: 0.5, shape: "hold" },
    ]);
    opened.project.dispose();
  });
});
