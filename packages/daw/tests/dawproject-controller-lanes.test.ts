import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { parseMidi } from "@audiorective/midi";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { MidiClip, Project, exportMidiFile, openDawProject, portabilityReport, saveDawProject } from "../src";
import type { ControllerLane, ProjectMidiEvent } from "../src";
import { controllerEvents, controllerFromNormalized, controllerMax, controllerToNormalized } from "../src/controller-lane";
import { apply, applyAndUndo, fingerprint } from "./edit-ops-support";
import { xsdViolations } from "./helpers/xsd";
import { parseTree, projectXmlOf, treeDifferences, type Tree } from "./helpers/xml-tree";

/**
 * MIDI controller movement (sustain, mod wheel, pitch bend, ...) in a DAWproject file. Clip events are written as `RealPoint` + `unit="normalized"` inside
 * the MIDI clip, track lanes as Bitwig Studio writes them (a `Points` beside the track's `Clips`). The fixture is Bitwig Studio 6.1.7's own file with
 * CC64, CC1 and pitch bend drawn on the Keys track (tests/fixtures/dawproject/SOURCES.md).
 */
const bitwig = new Uint8Array(
  readFileSync(fileURLToPath(new URL("./fixtures/dawproject/bitwig-6.1.7-controller-lanes.dawproject", import.meta.url))),
);
const cc = (time: number, controller: number, value: number, channel = 0): ProjectMidiEvent => ({
  time,
  data: Uint8Array.of(0xb0 | channel, controller, value),
});
const bend = (time: number, value: number, channel = 0): ProjectMidiEvent => ({ time, data: Uint8Array.of(0xe0 | channel, value & 127, value >> 7) });
const pressure = (time: number, value: number): ProjectMidiEvent => ({ time, data: Uint8Array.of(0xd0, value) });
const poly = (time: number, key: number, value: number): ProjectMidiEvent => ({ time, data: Uint8Array.of(0xa0, key, value) });
const program = (time: number, value: number): ProjectMidiEvent => ({ time, data: Uint8Array.of(0xc0, value) });

const find = (tree: Tree, tag: string): Tree[] => [...(tree.tag === tag ? [tree] : []), ...tree.children.flatMap((child) => find(child, tag))];
const targetOf = (points: Tree) => points.children.find((child) => child.tag === "Target")!.attrs;
const projectXml = (archive: Uint8Array) => strFromU8(unzipSync(archive)["project.xml"]);
const withXml = (archive: Uint8Array, edit: (xml: string) => string) => {
  const files = unzipSync(archive);
  files["project.xml"] = strToU8(edit(strFromU8(files["project.xml"])));
  return zipSync(files);
};
const keysOf = (project: Project) => project.tracks.find((track) => track.name === "Keys")!;
const laneOf = (project: Project, expression: ControllerLane["expression"], controller = 0) =>
  keysOf(project).controllerLanes.find((lane) => lane.expression === expression && lane.controller === controller)!;

/** A song with a MIDI clip that holds every controller kind as events, and a track lane beside it. */
function song() {
  const project = new Project({ bpm: 120 });
  const keys = project.addTrack("Keys", "midi");
  project.addMidiClip(
    keys.id,
    {
      duration: 8,
      notes: [{ pitch: 60, start: 0, duration: 1, velocity: 0.8 }],
      events: [
        cc(0, 64, 0),
        cc(1, 64, 127),
        cc(3, 64, 0),
        cc(0.5, 1, 40, 2),
        bend(2, 8192),
        bend(2.5, 16383),
        bend(3.5, 0),
        pressure(4, 99),
        poly(4.5, 60, 12),
        program(5, 5),
      ],
    },
    4,
  );
  project.setControllerLane(keys.id, {
    expression: "channelController",
    channel: 0,
    controller: 7,
    points: [
      { time: 0, value: 100, shape: "linear" },
      { time: 8, value: 20, shape: "linear" },
    ],
  });
  return { project, keys };
}

describe("the value mapping", () => {
  test("normalizing is value / max and the inverse is exact for every value of every expression", () => {
    for (const expression of ["channelController", "pitchBend", "channelPressure", "polyPressure", "programChange"] as const)
      for (let value = 0; value <= controllerMax(expression); value++)
        expect(controllerFromNormalized(expression, controllerToNormalized(expression, value)), `${expression} ${value}`).toBe(value);
    expect(controllerToNormalized("channelController", 127)).toBe(1);
    expect(controllerToNormalized("pitchBend", 16383)).toBe(1);
    // Bitwig writes the centre of the bend as exactly 0.5, which is 8191.5 of 16383: rounded half up, to 8192.
    expect(controllerFromNormalized("pitchBend", 0.5)).toBe(8192);
    expect(controllerFromNormalized("channelController", 0.122222)).toBe(16);
    expect(controllerFromNormalized("channelController", 1.0000000001)).toBe(127);
  });

  test("a linear segment is sampled every 1/32 beat where the rounded value changes, a hold segment is not", () => {
    const linear = controllerEvents("channelController", [
      { time: 0, value: 0, shape: "linear" },
      { time: 1, value: 3, shape: "linear" },
    ]);
    // 0 to 3 over one beat: the rounded value changes to 1 at the first 1/32 past 1/6, to 2 at 1/2 and to 3 past 5/6; the next point is always sent.
    expect(linear).toEqual([
      { beat: 0, value: 0 },
      { beat: 6 / 32, value: 1 },
      { beat: 16 / 32, value: 2 },
      { beat: 27 / 32, value: 3 },
      { beat: 1, value: 3 },
    ]);
    const step = controllerEvents("channelController", [
      { time: 0, value: 0, shape: "hold" },
      { time: 4, value: 127, shape: "hold" },
    ]);
    expect(step).toEqual([
      { beat: 0, value: 0 },
      { beat: 4, value: 127 },
    ]);
  });
});

describe("our writer", () => {
  test("clip events are RealPoint with unit normalized and interpolation hold, in clip beats, one Points per controller", async () => {
    const { project } = song();
    const saved = saveDawProject(project);
    expect(projectXml(saved)).not.toContain("IntegerPoint");
    const tree = parseTree(projectXml(saved));
    const clipPoints = find(find(tree, "Clip")[0], "Points");
    const byTarget = new Map(clipPoints.map((points) => [JSON.stringify(targetOf(points)), points]));
    expect([...byTarget.keys()].sort()).toEqual(
      [
        { expression: "channelController", channel: "0", controller: "64" },
        { expression: "channelController", channel: "2", controller: "1" },
        { expression: "pitchBend", channel: "0" },
        { expression: "channelPressure", channel: "0" },
        { expression: "polyPressure", channel: "0", key: "60" },
        { expression: "programChange", channel: "0" },
      ]
        .map((target) => JSON.stringify(target))
        .sort(),
    );
    const sustain = byTarget.get(JSON.stringify({ expression: "channelController", channel: "0", controller: "64" }))!;
    expect(sustain.attrs).toMatchObject({ unit: "normalized", timeUnit: "beats" });
    expect(sustain.children.filter((child) => child.tag === "RealPoint").map((point) => point.attrs)).toEqual([
      { time: "0", value: "0", interpolation: "hold" },
      { time: "1", value: "1", interpolation: "hold" },
      { time: "3", value: "0", interpolation: "hold" },
    ]);
    const pitch = byTarget.get(JSON.stringify({ expression: "pitchBend", channel: "0" }))!;
    expect(pitch.children.filter((child) => child.tag === "RealPoint").map((point) => point.attrs.value)).toEqual(["0.500030519", "1", "0"]);
    expect(await xsdViolations([{ name: "ours", bytes: saved }])).toEqual([]);
    project.dispose();
  });

  test("a track lane is a Points beside the track's Clips, in project beats, with the lane's own interpolation", async () => {
    const { project, keys } = song();
    project.setControllerLane(keys.id, {
      expression: "pitchBend",
      channel: 1,
      controller: 0,
      points: [
        { time: 2, value: 8192, shape: "hold" },
        { time: 2, value: 16383, shape: "linear" },
        { time: 6, value: 0, shape: "linear" },
      ],
    });
    const saved = saveDawProject(project);
    const lane = find(parseTree(projectXml(saved)), "Lanes").find((item) => item.attrs.track === keys.id)!;
    expect(lane.children.map((child) => child.tag)).toEqual(["Clips", "Points", "Points"]);
    const [volume, bendLane] = lane.children.slice(1);
    expect(volume.attrs).toMatchObject({ unit: "normalized", timeUnit: "beats" });
    expect(targetOf(volume)).toEqual({ expression: "channelController", channel: "0", controller: "7" });
    expect(volume.children.slice(1).map((point) => point.attrs)).toEqual([
      { time: "0", value: "0.787401575", interpolation: "linear" },
      { time: "8", value: "0.157480315", interpolation: "linear" },
    ]);
    expect(targetOf(bendLane)).toEqual({ expression: "pitchBend", channel: "1" });
    // The lane's points are hold, linear, (last): the file says how each point is reached, as Bitwig reads it, so the second point (the segment into it is a step) says hold, the third linear.
    expect(bendLane.children.slice(1).map((point) => point.attrs.interpolation)).toEqual(["hold", "hold", "linear"]);
    expect(await xsdViolations([{ name: "ours", bytes: saved }])).toEqual([]);
    project.dispose();
  });

  test("our own file reopens equal: clip events byte for byte, lanes point for point, and a second save is the same tree", () => {
    const { project } = song();
    const saved = saveDawProject(project);
    const { project: reopened, warnings } = openDawProject(saved);
    expect(warnings).toEqual([]);
    const clip = reopened.tracks[0].clips[0] as MidiClip;
    const original = project.tracks[0].clips[0] as MidiClip;
    expect(clip.events.map(({ time, data }) => [time, [...data]])).toEqual(original.events.map(({ time, data }) => [time, [...data]]));
    expect(reopened.tracks[0].controllerLanes).toEqual(project.tracks[0].controllerLanes);
    expect(treeDifferences(parseTree(projectXml(saved)), parseTree(projectXml(saveDawProject(reopened))))).toEqual([]);
    reopened.dispose();
    project.dispose();
  });

  test("the report names controller lanes as standard content", () => {
    const { project } = song();
    expect(portabilityReport(project).standardContent).toContain("MIDI controller lanes (sustain, modulation, pitch bend, ...)");
    project.dispose();
  });
});

describe("reading what other applications write in a clip", () => {
  test("a file with IntegerPoint (what this package wrote before) still reads, raw values, as steps", () => {
    const { project } = song();
    const raw = withXml(saveDawProject(project), (xml) =>
      xml.replace(/<Points id="clip[^>]*>[\s\S]*?<\/Points>/g, (block) => {
        const max = block.includes("pitchBend") ? 16383 : 127;
        return block
          .replace(' unit="normalized"', "")
          .replace(
            /<RealPoint time="([^"]+)" value="([^"]+)" interpolation="hold"\/>/g,
            (_, time: string, value: string) => `<IntegerPoint time="${time}" value="${Math.round(Number(value) * max)}"/>`,
          );
      }),
    );
    const files = unzipSync(raw);
    delete files["audiorective/state.json"];
    const { project: reopened } = openDawProject(zipSync(files));
    const events = (reopened.tracks[0].clips[0] as MidiClip).events.map(({ time, data }) => [time, ...data]);
    expect(events).toContainEqual([1, 0xb0, 64, 127]);
    expect(events).toContainEqual([2.5, 0xe0, 127, 127]);
    expect(events).toContainEqual([4.5, 0xa0, 60, 12]);
    expect(events).toHaveLength(10);
    reopened.dispose();
    project.dispose();
  });

  test("a clip-level RealPoint lane reads instead of throwing: normalized or no unit, hold or linear (linear is sampled)", () => {
    const { project } = song();
    const files = unzipSync(saveDawProject(project));
    delete files["audiorective/state.json"];
    const linear = zipSync({
      ...files,
      // No unit (Bitwig 5), one linear lane: sustain from 0 at beat 0 to 127 at beat 4.
      "project.xml": strToU8(
        strFromU8(files["project.xml"]).replace(
          /<Points id="clip\d+-control0"[\s\S]*?<\/Points>/,
          `<Points id="clip2-control0" timeUnit="beats"><Target expression="channelController" channel="0" controller="64"/><RealPoint time="0" value="0" interpolation="linear"/><RealPoint time="4" value="1" interpolation="linear"/></Points>`,
        ),
      ),
    });
    const { project: reopened, warnings } = openDawProject(linear);
    expect(warnings.join("\n")).not.toContain("unsupported");
    const events = (reopened.tracks[0].clips[0] as MidiClip).events.filter(({ data }) => data[0] === 0xb0 && data[1] === 64);
    expect(events[0]).toMatchObject({ time: 0 });
    expect(events.at(-1)).toMatchObject({ time: 4 });
    expect([...events.at(-1)!.data]).toEqual([0xb0, 64, 127]);
    // 127 steps over 4 beats: one event wherever the rounded value changes, on the 1/32 grid.
    expect(events).toHaveLength(128);
    expect(events.every(({ time }) => Math.abs(time * 32 - Math.round(time * 32)) < 1e-9)).toBe(true);
    reopened.dispose();
    project.dispose();
  });

  test("a clip lane with an expression or a unit the model cannot read is a warning, kept in the file, and survives an edit of the clip's notes", () => {
    const { project } = song();
    const files = unzipSync(saveDawProject(project));
    delete files["audiorective/state.json"];
    const xml = strFromU8(files["project.xml"]).replace(
      /(<Points id="clip\d+-control0"[\s\S]*?<\/Points>)/,
      `$1<Points id="odd-timbre" timeUnit="beats"><Target expression="timbre"/><RealPoint time="0" value="0.5" interpolation="linear"/></Points><Points id="odd-unit" timeUnit="beats" unit="percent"><Target expression="channelController" channel="0" controller="11"/><RealPoint time="0" value="50" interpolation="linear"/></Points>`,
    );
    const { project: reopened, warnings } = openDawProject(zipSync({ ...files, "project.xml": strToU8(xml) }));
    expect(warnings.join("\n")).toContain('MIDI clip Points with expression "timbre"');
    expect(warnings.join("\n")).toContain('MIDI clip Points with channelController in unit "percent"');
    const clip = reopened.tracks[0].clips[0] as MidiClip;
    expect(clip.events.some(({ data }) => data[1] === 11)).toBe(false);
    clip.midi.edit((draft) => void draft.push({ id: "extra", pitch: 64, start: 2, duration: 1, velocity: 0.5, channel: 0 }));
    const saved = saveDawProject(reopened);
    const text = projectXml(saved);
    expect(text).toContain('id="odd-timbre"');
    expect(text).toContain('id="odd-unit"');
    expect(text).toContain('key="64"');
    reopened.dispose();
    project.dispose();
  });
});

describe("Bitwig Studio's own track lanes (CC64, CC1 and pitch bend drawn on the Keys track)", () => {
  test("they are in the model, with the beats the file gives and the values rounded from the normalized ones", () => {
    const { project, warnings } = openDawProject(bitwig);
    expect(warnings.join("\n")).not.toContain("Controller lane");
    const keys = keysOf(project);
    expect(keys.controllerLanes.map(({ expression, channel, controller }) => [expression, channel, controller])).toEqual([
      ["channelController", 0, 64],
      ["channelController", 0, 1],
      ["pitchBend", 0, 0],
    ]);
    // Every point of Bitwig's lanes arrives linearly, so each leaves linearly; the last has no next point and is hold.
    const shape = (lane: ControllerLane) => lane.points.map(({ time, value, shape }) => [time, value, shape]);
    expect(shape(laneOf(project, "channelController", 64))).toEqual([
      [0, 0, "linear"],
      [3, 16, "linear"],
      [9, 121, "linear"],
      [16, 16, "linear"],
      [23, 121, "hold"],
    ]);
    expect(shape(laneOf(project, "channelController", 1))).toEqual([
      [0, 0, "linear"],
      [3, 30, "linear"],
      [9, 100, "linear"],
      [16, 58, "linear"],
      [23, 114, "hold"],
    ]);
    expect(shape(laneOf(project, "pitchBend"))).toEqual([
      [0, 8192, "linear"],
      [2.53174, 8192, "linear"],
      [16, 2002, "linear"],
      [23, 12924, "hold"],
    ]);
    // The other tracks have none, and the clip's notes still read.
    expect(project.tracks.filter((track) => track !== keys).every((track) => track.controllerLanes.length === 0)).toBe(true);
    expect((keys.clips[0] as MidiClip).midi.notes.value).toHaveLength(24);
    project.dispose();
  });

  test("a save with no edit leaves project.xml the same tree", () => {
    const { project } = openDawProject(bitwig);
    expect(treeDifferences(parseTree(projectXmlOf(bitwig)), parseTree(projectXmlOf(saveDawProject(project))))).toEqual([]);
    project.dispose();
  });

  test("editing one lane changes that lane's Points and nothing else; it stays beside the Clips as RealPoint, in its own unit", async () => {
    const { project } = openDawProject(bitwig);
    const keys = keysOf(project);
    const sustain = laneOf(project, "channelController", 64);
    project.setControllerLane(keys.id, { ...sustain, points: sustain.points.map((point, i) => (i === 2 ? { ...point, value: 127 } : point)) });
    const saved = saveDawProject(project);
    const differences = treeDifferences(parseTree(projectXmlOf(bitwig)), parseTree(projectXmlOf(saved)));
    expect(differences.length).toBeGreaterThan(0);
    const lanes = find(parseTree(projectXmlOf(saved)), "Lanes").find((lane) => lane.attrs.track === "id12")!;
    const before = find(parseTree(projectXmlOf(bitwig)), "Lanes").find((lane) => lane.attrs.track === "id12")!;
    expect(lanes.children.map((child) => child.tag)).toEqual(["Clips", "Points", "Points", "Points"]);
    expect(lanes.children[1].attrs).toEqual(before.children[1].attrs);
    // Only the edited point is written again; the points the edit left alone keep Bitwig's own text.
    expect(lanes.children[1].children.slice(1).map((child) => child.attrs.value)).toEqual(["0.000000", "0.122222", "1", "0.122222", "0.955556"]);
    // Every difference is inside the first lane's Points; the other two Points and the clip are untouched.
    expect(differences.every((path) => path.startsWith("Project/Arrangement[0]/Lanes[0]/Lanes[2]/Points[0]"))).toBe(true);
    const reopened = openDawProject(saved).project;
    expect(laneOf(reopened, "channelController", 64).points[2]).toMatchObject({ time: 9, value: 127 });
    expect(laneOf(reopened, "channelController", 1)).toEqual(laneOf(project, "channelController", 1));
    expect(await xsdViolations([{ name: "edited", bytes: saved }]).then((lines) => lines.length)).toBe(
      (await xsdViolations([{ name: "original", bytes: bitwig }])).length,
    );
    reopened.dispose();
    project.dispose();
  });

  test("removing a lane removes its Points, and a lane added to the track is written beside the Clips", () => {
    const { project } = openDawProject(bitwig);
    const keys = keysOf(project);
    project.setControllerLane(keys.id, { ...laneOf(project, "pitchBend"), points: [] });
    project.setControllerLane(keys.id, { expression: "channelPressure", channel: 0, controller: 0, points: [{ time: 4, value: 90, shape: "hold" }] });
    const tree = parseTree(projectXmlOf(saveDawProject(project)));
    const lane = find(tree, "Lanes").find((item) => item.attrs.track === "id12")!;
    expect(lane.children.filter((child) => child.tag === "Points").map((points) => targetOf(points).expression)).toEqual([
      "channelController",
      "channelController",
      "channelPressure",
    ]);
    project.dispose();
  });

  test("a lane Bitwig wrote in seconds is read as beats through the tempo map and written back in seconds", () => {
    const seconds = withXml(bitwig, (xml) =>
      xml.replace(/<Points unit="normalized" id="id49">/, '<Points unit="normalized" timeUnit="seconds" id="id49">'),
    );
    const { project } = openDawProject(seconds);
    // The file's seconds go through the song's tempo map.
    const tempo = project.tempoMap;
    const beats = laneOf(project, "channelController", 64).points.map(({ time }) => time);
    [0, 3, 9, 16, 23].forEach((at, i) => expect(Math.abs(beats[i] - tempo.secondsToBeat(at))).toBeLessThan(1e-9));
    const keys = keysOf(project);
    const lane = laneOf(project, "channelController", 64);
    project.setControllerLane(keys.id, { ...lane, points: lane.points.map((point, i) => (i === 1 ? { ...point, value: 50 } : point)) });
    const written = find(parseTree(projectXmlOf(saveDawProject(project))), "Points").find((points) => points.attrs.id === "id49")!;
    expect(written.children.slice(1).map((point) => Number(point.attrs.time))).toEqual([0, 3, 9, 16, 23]);
    project.dispose();
  });
});

describe("the model's rules", () => {
  test("a lane belongs to a MIDI track, takes integer values in the controller's range, and an empty list removes it", () => {
    const { project, keys } = song();
    const audio = project.addTrack("Audio", "audio");
    const lane = { expression: "channelController", channel: 0, controller: 1, points: [{ time: 0, value: 1, shape: "hold" }] } as const;
    expect(() => project.setControllerLane(audio.id, lane)).toThrow("Project controller lane needs a MIDI track.");
    expect(() => project.setControllerLane("nope", lane)).toThrow("Project controller lane needs an existing track.");
    expect(() => project.setControllerLane(keys.id, { ...lane, points: [{ time: 0, value: 128, shape: "hold" }] })).toThrow(
      /value must be an integer from 0 to 127/,
    );
    expect(() => project.setControllerLane(keys.id, { ...lane, points: [{ time: 0, value: 1.5, shape: "hold" }] })).toThrow(/integer/);
    expect(() =>
      project.setControllerLane(keys.id, { ...lane, expression: "pitchBend", controller: 0, points: [{ time: 0, value: 16384, shape: "hold" }] }),
    ).toThrow(/0 to 16383/);
    expect(() => project.setControllerLane(keys.id, { ...lane, points: [{ time: -1, value: 1, shape: "hold" }] })).toThrow(/finite number of beats/);
    expect(() => project.setControllerLane(keys.id, { ...lane, controller: 120 })).toThrow(/0 to 119/);
    expect(() => project.setControllerLane(keys.id, { ...lane, channel: 16 })).toThrow(/channel must be/);
    expect(() => project.setControllerLane(keys.id, { ...lane, expression: "programChange", controller: 3 })).toThrow(/must be 0/);
    const count = project.tracks[0].controllerLanes.length;
    project.setControllerLane(keys.id, { ...lane, points: [] });
    expect(project.tracks[0].controllerLanes).toHaveLength(count);
    project.setControllerLane(keys.id, {
      ...lane,
      points: [
        { time: 2, value: 5, shape: "linear" },
        { time: 1, value: 4, shape: "hold" },
      ],
    });
    expect(project.tracks[0].controllerLanes.at(-1)!.points.map(({ time }) => time)).toEqual([1, 2]);
    project.setControllerLane(keys.id, { ...lane, points: [] });
    expect(project.tracks[0].controllerLanes).toHaveLength(count);
    project.dispose();
  });

  test("a lane edit is in Undo and is part of the version", () => {
    const { project, keys } = song();
    const version = project.cells.version.value;
    const before = fingerprint(project);
    project.edit("Sustain", () =>
      project.setControllerLane(keys.id, {
        expression: "channelController",
        channel: 0,
        controller: 64,
        points: [{ time: 0, value: 127, shape: "hold" }],
      }),
    );
    expect(project.cells.version.value).not.toBe(version);
    expect(project.cells.history.value.undo).toBe("Sustain");
    project.undo();
    expect(fingerprint(project)).toBe(before);
    expect(project.cells.version.value).not.toBe(version);
    project.dispose();
  });

  test("ripple delete and copyRange insert move a lane with the song", () => {
    const { project, keys } = song();
    project.setControllerLane(keys.id, {
      expression: "channelController",
      channel: 0,
      controller: 64,
      points: [
        { time: 0, value: 0, shape: "hold" },
        { time: 2, value: 127, shape: "hold" },
        { time: 6, value: 0, shape: "hold" },
      ],
    });
    const sustain = () =>
      keysOf(project)
        .controllerLanes.find((lane) => lane.controller === 64)!
        .points.map(({ time, value }) => [time, value]);
    project.rippleDelete({ startBeat: 1, endBeat: 3 });
    expect(sustain()).toEqual([
      [0, 0],
      [1, 127],
      [4, 0],
    ]);
    project.undo();
    expect(sustain()).toEqual([
      [0, 0],
      [2, 127],
      [6, 0],
    ]);
    const receipt = project.applyEdits({
      expectedVersion: project.cells.version.value,
      label: "Insert",
      ops: [{ type: "copyRange", range: { startBeat: 1, endBeat: 3 }, atBeat: 4, placement: "insert", as: "copy" }],
    });
    expect(receipt.status).toBe("applied");
    // Beats 1 to 3 (the pedal goes down at 2) are copied to 4; from 6 on, the pedal's own later points move 2 beats on.
    expect(sustain()).toEqual([
      [0, 0],
      [2, 127],
      [4, 0],
      [5, 127],
      [6, 127],
      [8, 0],
    ]);
    project.dispose();
  });
});

describe("applyEdits setControllerLane", () => {
  test("replaces one lane, accepts atBeat or atSeconds, and Undo restores it", () => {
    const { project, keys } = song();
    const receipt = applyAndUndo(project, [
      {
        type: "setControllerLane",
        trackId: keys.id,
        expression: "channelController",
        channel: 0,
        controller: 64,
        points: [
          { atBeat: 0, value: 0, shape: "hold" },
          { atSeconds: 1, value: 127, shape: "hold" },
          { atBeat: 4, value: 0, shape: "hold" },
        ],
      },
    ]);
    expect(receipt.changedTracks).toEqual([keys.id]);
    expect(keysOf(project).controllerLanes.find((lane) => lane.controller === 64)!.points).toEqual([
      { time: 0, value: 0, shape: "hold" },
      { time: 2, value: 127, shape: "hold" },
      { time: 4, value: 0, shape: "hold" },
    ]);
    project.dispose();
  });

  test("a lane equal to the one the track has is a noop, an empty list removes the lane, and a bad field is rejected", () => {
    const { project, keys } = song();
    const lane = project.tracks[0].controllerLanes[0];
    const rows = lane.points.map(({ time, value, shape }) => ({ atBeat: time, value, shape }));
    const op = {
      type: "setControllerLane",
      trackId: keys.id,
      expression: lane.expression,
      channel: lane.channel,
      controller: lane.controller,
      points: rows,
    } as const;
    const first = project.cells.version.value;
    // The rows are what read_automation shows, sent back unchanged: nothing changes, so the version stays.
    expect(apply(project, [op]).version).toBe(first);
    apply(project, [{ ...op, points: [] }]);
    expect(keysOf(project).controllerLanes).toHaveLength(0);
    const rejected = (bad: Record<string, unknown>) =>
      project.applyEdits({ expectedVersion: project.cells.version.value, label: "Bad", ops: [{ ...op, ...bad } as never] });
    expect(rejected({ expression: "timbre" })).toMatchObject({ status: "rejected", code: "invalid-operation" });
    expect(rejected({ channel: 16 })).toMatchObject({ status: "rejected", code: "invalid-operation" });
    expect(rejected({ controller: undefined })).toMatchObject({ status: "rejected", code: "invalid-operation" });
    expect(rejected({ expression: "pitchBend", controller: 3 })).toMatchObject({ status: "rejected", code: "invalid-operation" });
    expect(rejected({ points: [{ atBeat: 0, value: 200 }] })).toMatchObject({ status: "rejected", code: "invalid-operation" });
    expect(rejected({ points: [{ atBeat: 0, value: 1, shape: "curve" }] })).toMatchObject({ status: "rejected", code: "invalid-operation" });
    expect(rejected({ trackId: "missing" })).toMatchObject({ status: "rejected", code: "track-not-found" });
    project.dispose();
  });
});

describe("the MIDI file export", () => {
  test("a track's lanes are sampled into the file with the clip's events, sorted by beat", () => {
    const { project, keys } = song();
    project.setControllerLane(keys.id, {
      expression: "pitchBend",
      channel: 0,
      controller: 0,
      points: [
        { time: 0, value: 8192, shape: "linear" },
        { time: 1, value: 16383, shape: "hold" },
        { time: 2, value: 0, shape: "hold" },
      ],
    });
    const parsed = parseMidi(exportMidiFile(project, { ppq: 960 }));
    const track = parsed.tracks.find((item) => item.name === "Keys")!;
    const beats = track.events.map(({ beat }) => beat);
    expect(beats).toEqual([...beats].sort((a, b) => a - b));
    const volume = track.events.filter(({ data }) => data[0] === 0xb0 && data[1] === 7);
    expect(volume[0]).toMatchObject({ beat: 0 });
    expect(volume[0].data[2]).toBe(100);
    expect(volume.at(-1)!.beat).toBe(8);
    expect(volume.at(-1)!.data[2]).toBe(20);
    expect(volume.length).toBeGreaterThan(40);
    const bendValues = track.events.filter(({ data }) => data[0] === 0xe0).map(({ beat, data }) => [beat, data[1] + (data[2] << 7)]);
    // The lane (beats 0 to 2) and the clip's own bends (the clip starts at beat 4).
    expect(bendValues.filter(([beat]) => beat <= 2).at(-1)).toEqual([2, 0]);
    expect(bendValues.filter(([beat]) => beat > 4)).toEqual([
      [6, 8192],
      [6.5, 16383],
      [7.5, 0],
    ]);
    project.dispose();
  });

  test("a track with no lane exports as before", () => {
    const project = new Project({ bpm: 120 });
    const track = project.addTrack("Keys", "midi");
    project.addMidiClip(track.id, { duration: 4, notes: [{ pitch: 60, start: 0, duration: 1, velocity: 1 }], events: [cc(1, 64, 127)] }, 0);
    const parsed = parseMidi(exportMidiFile(project));
    expect(parsed.tracks.find((item) => item.name === "Keys")!.events.map(({ beat, data }) => [beat, ...data])).toEqual([
      [1, 0xb0, 64, 127],
      // The pedal still down at the clip's end is released there, as playback does.
      [4, 0xb0, 64, 0],
    ]);
    project.dispose();
  });
});
