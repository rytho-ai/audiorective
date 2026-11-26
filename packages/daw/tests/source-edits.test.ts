import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { Project, openDawProject, saveDawProject } from "../src";
import { xsdViolations } from "./helpers/xsd";

/** Edits to files another application wrote: track order, Bitwig's tempo steps and beat markers, plug-in state. */
const dir = new URL("./fixtures/dawproject/", import.meta.url);
const file = (name: string) => new Uint8Array(readFileSync(fileURLToPath(new URL(name, dir))));
const xmlOf = (archive: Uint8Array) => strFromU8(unzipSync(archive)["project.xml"]);
const flat = (xml: string) =>
  xml
    .replace(/<\?xml[^>]*\?>/, "")
    .replace(/>\s+</g, "><")
    .trim();
const messages = (violations: string[]) => new Set(violations.map((line) => line.replace(/^[^ ]+ /, "")));
const noNewViolations = async (before: Uint8Array, after: Uint8Array) => {
  const known = messages(await xsdViolations([{ name: "before", bytes: before }]));
  for (const message of messages(await xsdViolations([{ name: "after", bytes: after }]))) expect(known.has(message), message).toBe(true);
};

describe("a track added to a file that lists its master first", () => {
  test.each(["ts-cc1-in-clips", "ts-pitchbend-on-track", "ts-audio-mixer", "ts-features"])("%s reopens in the model's track order", (name) => {
    const source = file(`${name}.dawproject`);
    const { project } = openDawProject(source);
    project.addTrack("Added", "midi");
    const expected = project.tracks.map((track) => track.name);
    expect(expected.at(-1)).toBe("Added");
    const reopened = openDawProject(saveDawProject(project));
    expect(reopened.project.tracks.map((track) => track.name)).toEqual(expected);
    reopened.project.dispose();
    project.dispose();
  });
});

describe("Bitwig 5.3 tempo steps and beat markers", () => {
  const canon = "bitwig-5.3-canon-in-d.dawproject";
  const celesta = "bitwig-5.3-sugar-plum-celesta.dawproject";

  test("same-time point pairs read as steps, not ramps", () => {
    const { project, warnings } = openDawProject(file(canon));
    expect(warnings.join("\n")).not.toContain("Tempo automation with ramps");
    expect(project.tempoMap.changes).toEqual([
      { beat: 400, bpm: 50.000083 },
      { beat: 400.997916, bpm: 100.000167 },
      { beat: 402, bpm: 50.000083 },
      { beat: 403.997916, bpm: 100.000167 },
    ]);
    project.dispose();
  });

  test.each([canon, celesta])("%s: changing and adding tempo changes is saved in Bitwig's own step pairs and reopens equal", async (name) => {
    const source = file(name);
    const { project } = openDawProject(source);
    const before = project.tempoMap.changes;
    const [first, ...rest] = before;
    project.setTempoChanges([{ ...first, bpm: 90 }, ...rest, { beat: 500, bpm: 77 }]);
    const wanted = project.tempoMap.changes;
    const saved = saveDawProject(project);
    const out = xmlOf(saved);
    expect(out).toContain('time="500"');
    const reopened = openDawProject(saved);
    expect(reopened.project.tempoMap.changes).toEqual(wanted);
    expect(reopened.project.bpm).toBe(project.bpm);
    // Everything but the tempo lane and the transport is as written; a second save changes nothing.
    expect(flat(xmlOf(saveDawProject(reopened.project)))).toBe(flat(out));
    await noNewViolations(source, saved);
    reopened.project.dispose();
    project.dispose();
  });

  test("a tempo edit leaves the untouched parts of the file as they were", () => {
    const source = file(canon);
    const { project } = openDawProject(source);
    project.setTempoChanges([...project.tempoMap.changes, { beat: 600, bpm: 80 }]);
    const out = xmlOf(saveDawProject(project));
    const strip = (xml: string) => xml.replace(/<TempoAutomation[\s\S]*?<\/TempoAutomation>/, "");
    expect(flat(strip(out))).toBe(flat(strip(xmlOf(source))));
    project.dispose();
  });

  test("clearing the tempo changes removes the lane; a true ramp stays refused", () => {
    const { project } = openDawProject(file(canon));
    project.setTempoChanges([]);
    const out = xmlOf(saveDawProject(project));
    expect(out).not.toContain("<TempoAutomation");
    project.dispose();
    const ramp = xmlOf(file(canon)).replace(
      '<RealPoint value="50.000083" interpolation="linear" time="400.997916"/>',
      '<RealPoint value="75" interpolation="linear" time="400.997916"/>',
    );
    const archive = zipSync({ ...unzipSync(file(canon)), "project.xml": strToU8(ramp) });
    const opened = openDawProject(archive);
    expect(opened.warnings.join("\n")).toContain("Tempo automation with ramps or in seconds");
    opened.project.setTempoChanges([{ beat: 16, bpm: 90 }]);
    expect(() => saveDawProject(opened.project)).toThrow("Project tempo changes cannot be saved");
    opened.project.dispose();
  });

  test("markers in beats are read and move, rename and add back in beats, keeping their colour", async () => {
    const source = file(celesta);
    const { project, warnings } = openDawProject(source);
    expect(warnings.join("\n")).not.toContain("Markers in beats");
    expect(project.markers).toHaveLength(1);
    expect(project.markers[0].name).toBe("Untitled");
    expect(project.tempoMap.secondsToBeat(project.markers[0].time)).toBeCloseTo(105, 6);
    // Untouched, the marker is exactly as the file has it.
    expect(flat(xmlOf(saveDawProject(project)))).toBe(flat(xmlOf(source)));
    const at = (beat: number) => project.tempoMap.beatToSeconds(beat);
    project.setMarkers([
      { time: at(110), name: "Bridge" },
      { time: at(20), name: "Intro" },
    ]);
    const wanted = project.markers.map((marker) => ({ name: marker.name, beat: project.tempoMap.secondsToBeat(marker.time) }));
    const saved = saveDawProject(project);
    const out = xmlOf(saved);
    expect(out).toContain('time="110"');
    expect(out).toContain('time="20"');
    await noNewViolations(source, saved);
    const reopened = openDawProject(saved);
    expect(reopened.project.markers.map((marker) => marker.name)).toEqual(wanted.map((marker) => marker.name));
    for (const [i, marker] of reopened.project.markers.entries()) {
      expect(reopened.project.tempoMap.secondsToBeat(marker.time)).toBeCloseTo(wanted[i].beat, 6);
      expect(marker.time).toBeCloseTo(project.markers[i].time, 6);
    }
    reopened.project.dispose();
    project.dispose();
  });

  test("a tempo edit moves no marker in the model's seconds: the file's beats follow", () => {
    const { project } = openDawProject(file(celesta));
    const seconds = project.markers[0].time;
    project.setTempoChanges([{ beat: 10, bpm: 120 }, ...project.tempoMap.changes.filter((change) => change.beat > 10)]);
    const reopened = openDawProject(saveDawProject(project));
    expect(reopened.project.markers[0].time).toBeCloseTo(seconds, 6);
    reopened.project.dispose();
    project.dispose();
  });
});

describe("a WebCLAP device in a file opened from a source", () => {
  test("a set device state is saved and reopens", () => {
    const own = new Project({ title: "Synth" });
    const track = own.addTrack("Keys", "midi");
    own.addDevice(track.id, {
      kind: "webclap",
      pluginId: "com.example.synth",
      name: "Synth",
      vendor: "Example",
      version: "1.2",
      bundleUrl: "/bundles/synth.wclap",
      state: new Uint8Array([1, 2, 3]),
    });
    const files = unzipSync(saveDawProject(own));
    own.dispose();
    // Another application's file: the codec patches its XML instead of rewriting it.
    files["project.xml"] = strToU8(strFromU8(files["project.xml"]).replace('name="Audiorective"', 'name="Other DAW"'));
    const { project } = openDawProject(zipSync(files));
    const device = project.tracks[0].devices[0];
    expect(device.kind).toBe("webclap");
    project.setDeviceState(device.id, new Uint8Array([9, 8, 7]));
    const saved = saveDawProject(project);
    expect(unzipSync(saved)[`plugins/${device.id}.bin`]).toEqual(new Uint8Array([9, 8, 7]));
    const reopened = openDawProject(saved);
    expect(reopened.project.tracks[0].devices[0]).toMatchObject({ kind: "webclap", state: new Uint8Array([9, 8, 7]) });
    reopened.project.dispose();
    project.dispose();
  });
});
