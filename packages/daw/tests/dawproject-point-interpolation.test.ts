import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { Project, openDawProject, saveDawProject } from "../src";
import { arrivalShapes, foldSteps, leavingShapes } from "../src/internal/point-shape";

/**
 * A DAWproject point's `interpolation` says how the value ARRIVES at that point from the previous one (Bitwig Studio 6.1.7 reads it so on track volume,
 * clip gain and controller lanes; maintainer probe bitwig-roundtrip-001, section F). The model's `shape` says how a point LEAVES toward the next.
 */
const bitwig = new Uint8Array(readFileSync(fileURLToPath(new URL("./fixtures/dawproject/bitwig-6.1.7-interpolation.dawproject", import.meta.url))));
const xmlOf = (archive: Uint8Array) => strFromU8(unzipSync(archive)["project.xml"]);
const interpolations = (xml: string, marker: string) =>
  [
    ...xml
      .slice(xml.indexOf(marker))
      .split("</Points>")[0]
      .matchAll(/interpolation="(\w+)"/g),
  ].map((match) => match[1]);

/** The curve 0.2 held, a jump to 0.8 at 4 s, a ramp to 0.5 at 8 s. */
const curve = [
  { time: 0, value: 0.2, shape: "hold" as const },
  { time: 4, value: 0.8, shape: "linear" as const },
  { time: 8, value: 0.5, shape: "hold" as const },
];

describe("point shapes", () => {
  test("arrival is the previous point's shape and leaving is the next point's arrival", () => {
    expect(arrivalShapes(curve)).toEqual(["hold", "hold", "linear"]);
    expect(leavingShapes(["hold", "hold", "linear"])).toEqual(["hold", "linear", "hold"]);
    expect(leavingShapes(arrivalShapes(curve))).toEqual(curve.map((point) => point.shape));
  });

  test("a pair at one time that repeats the value before it is a hold; a step after a ramp is not foldable", () => {
    const at = (time: number, value: number) => ({ time, value, shape: "linear" as const });
    expect(foldSteps([at(0, 0.2), at(8, 0.2), at(8, 0.8), at(16, 0.5)])).toEqual([at(0, 0.2), { time: 8, value: 0.8, shape: "hold" }, at(16, 0.5)]);
    expect(foldSteps([at(0, 0.2), at(8, 0.4), at(8, 0.8)])).toBeUndefined();
    expect(foldSteps([at(0, 0.2), at(0, 0.8)])).toBeUndefined();
  });
});

describe("track volume automation", () => {
  test("is written so the value arrives at each point the way the model's shape before it says, and reads back unchanged", () => {
    const project = new Project({ bpm: 120 });
    const track = project.addTrack("Vol", "audio");
    project.setVolumeAutomation(track.id, curve);
    const saved = saveDawProject(project);
    // 0.2 holds until the jump to 0.8 (arrives by hold), then the ramp to 0.5 (arrives linearly).
    expect(interpolations(xmlOf(saved), `<Points id="${track.id}-automation"`)).toEqual(["hold", "hold", "linear"]);
    const opened = openDawProject(saved);
    expect(opened.warnings).toEqual([]);
    expect(opened.project.tracks[0].volumeAutomation).toEqual(curve);
    opened.project.dispose();
    project.dispose();
  });

  test("the last point's shape is stored as hold, since nothing follows it", () => {
    const project = new Project();
    const track = project.addTrack("Vol", "audio");
    project.setVolumeAutomation(track.id, [
      { time: 0, value: 1, shape: "linear" },
      { time: 2, value: 0.5, shape: "linear" },
    ]);
    expect(project.tracks[0].volumeAutomation.map((point) => point.shape)).toEqual(["linear", "hold"]);
    project.dispose();
  });

  test("Bitwig Studio 6.1.7's own file (a hold step written as a repeated value) reads as the curve it was made from", () => {
    const opened = openDawProject(bitwig);
    const vol = opened.project.tracks.find((track) => track.name === "VolCurve")!;
    // Bitwig wrote (0, 0.2) (8, 0.2) (8, 0.8) (16, 0.5), all `linear`, in beats at 120 BPM.
    expect(vol.volumeAutomation).toEqual(curve);
    expect(opened.warnings.join()).not.toContain("Volume automation");
    opened.project.dispose();
  });
});

describe("clip gain curve", () => {
  const audio = { sampleRate: 8000, channels: [new Float32Array(8 * 8000).fill(0.5)] };

  test("is written as arrival shapes and a foreign reader gets the same shapes back", () => {
    const project = new Project({ bpm: 120 });
    const track = project.addTrack("Voice", "audio");
    project.addAudioClip(track.id, audio, 0, { gainAutomation: { sourceStart: 0, points: curve } });
    const saved = saveDawProject(project);
    expect(interpolations(xmlOf(saved), '<Target expression="gain"/>')).toEqual(["hold", "hold", "linear"]);
    const files = unzipSync(saved);
    delete files["audiorective/state.json"];
    const foreign = openDawProject(zipSync(files));
    const clip = foreign.project.tracks[0].clips[0];
    expect(clip.kind === "audio" && clip.gainAutomation?.points).toEqual(curve);
    foreign.project.dispose();
    project.dispose();
  });
});

describe("tempo automation", () => {
  const steps = () => {
    const project = new Project({ bpm: 100 });
    project.setTempoChanges([{ beat: 4, bpm: 130 }]);
    const archive = saveDawProject(project);
    project.dispose();
    return archive;
  };
  const withPoint = (interpolation: string) => {
    const files = unzipSync(steps());
    const xml = strFromU8(files["project.xml"]).replace(
      '<RealPoint time="4" value="130" interpolation="hold"/>',
      `<RealPoint time="4" value="130" interpolation="${interpolation}"/>`,
    );
    files["project.xml"] = strToU8(xml);
    return zipSync(files);
  };

  test("a step is written as hold points; Bitwig Studio 6.1.7 shows it as a step", () => {
    expect(interpolations(xmlOf(steps()), "<TempoAutomation")).toEqual(["hold", "hold"]);
    const opened = openDawProject(bitwig);
    // Bitwig wrote (0, 120) (32, 120) (32, 90), all `linear`: a step to 90 at beat 32.
    expect(opened.project.tempoMap.changes).toEqual([{ beat: 32, bpm: 90 }]);
    opened.project.dispose();
  });

  test("a point is a ramp when the value arrives at it linearly, and a step when it arrives by hold", () => {
    const ramp = openDawProject(withPoint("linear"));
    expect(ramp.warnings.join()).toContain("Tempo automation with ramps");
    expect(ramp.project.tempoMap.changes).toEqual([]);
    const step = openDawProject(withPoint("hold"));
    expect(step.warnings).toEqual([]);
    expect(step.project.tempoMap.changes).toEqual([{ beat: 4, bpm: 130 }]);
    ramp.project.dispose();
    step.project.dispose();
  });
});
