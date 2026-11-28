import { describe, expect, test } from "vitest";
import { MidiClip, Project, exportMidiFile, type ControllerLane, type ControllerPoint, type ProjectEditOperation } from "../src";
import { controllerRestOf, controllerRestValue } from "@audiorective/midi";
import { controllerMessagesIn, controllerValueAt } from "../src/controller-lane";

/** Review B: controller lane rules that need no audio: normalisation, ripple delete and insert, per-lane Undo, the rest value and the MIDI file. */
const lane = (
  controller: number,
  points: ControllerPoint[],
  expression: ControllerLane["expression"] = "channelController",
  channel = 0,
): ControllerLane => ({
  expression,
  channel,
  controller,
  points,
});
const version = (project: Project) => project.cells.version.value;
const edit = (project: Project, ops: ProjectEditOperation[]) => project.applyEdits({ expectedVersion: version(project), label: "Edit", ops });
const setup = () => {
  const project = new Project({ bpm: 120 });
  const track = project.addTrack("Keys", "midi");
  return { project, track };
};
const lanesOf = (project: Project, trackId: string) => project.tracks.find((item) => item.id === trackId)!.controllerLanes;

describe("a lane's points are sorted before the last one is forced to hold", () => {
  const unsorted: ControllerPoint[] = [
    { time: 4, value: 10, shape: "hold" },
    { time: 0, value: 0, shape: "linear" },
    { time: 2, value: 5, shape: "linear" },
  ];
  test("setControllerLane keeps the linear shape of a point that only looked last in the input", () => {
    const { project, track } = setup();
    project.setControllerLane(track.id, lane(1, unsorted));
    expect(lanesOf(project, track.id)[0].points).toEqual([
      { time: 0, value: 0, shape: "linear" },
      { time: 2, value: 5, shape: "linear" },
      { time: 4, value: 10, shape: "hold" },
    ]);
  });
  test("the setControllerLane operation does the same", () => {
    const { project, track } = setup();
    const receipt = edit(project, [
      {
        type: "setControllerLane",
        trackId: track.id,
        expression: "channelController",
        channel: 0,
        controller: 1,
        points: [
          { atBeat: 4, value: 10, shape: "hold" },
          { atBeat: 0, value: 0, shape: "linear" },
          { atBeat: 2, value: 5, shape: "linear" },
        ],
      },
    ]);
    expect(receipt.status).toBe("applied");
    expect(lanesOf(project, track.id)[0].points.map((point) => point.shape)).toEqual(["linear", "linear", "hold"]);
  });
});

describe("ripple delete and an inserting copy keep the curve outside the range", () => {
  const ramp = [
    { time: 0, value: 0, shape: "linear" as const },
    { time: 4, value: 100, shape: "linear" as const },
    { time: 8, value: 50, shape: "hold" as const },
  ];
  const original = (beat: number) => controllerValueAt("channelController", ramp, beat);
  const valueOf = (project: Project, trackId: string, beat: number) =>
    controllerValueAt("channelController", lanesOf(project, trackId)[0].points, beat);

  test("rippleDelete of beats 1 to 2 leaves the ramp's values before it and after it as they were", () => {
    const { project, track } = setup();
    project.setControllerLane(track.id, lane(1, ramp));
    project.rippleDelete({ startBeat: 1, endBeat: 2 });
    for (const beat of [0, 0.5, 0.9, 1, 1.5, 2, 2.5, 2.99, 3, 5, 6.9])
      expect(valueOf(project, track.id, beat)).toBe(original(beat < 1 ? beat : beat + 1));
  });

  test("rippleDelete of a range that starts on a point and ends inside a ramp keeps the shape after it", () => {
    const { project, track } = setup();
    project.setControllerLane(track.id, lane(1, ramp));
    project.rippleDelete({ startBeat: 4, endBeat: 6 });
    for (const beat of [3, 3.9, 4, 4.5, 5, 6]) expect(valueOf(project, track.id, beat)).toBe(original(beat < 4 ? beat : beat + 2));
  });

  test("an inserting copyRange keeps the values before the insert, repeats the range, and resumes the ramp after it", () => {
    const { project, track } = setup();
    project.setControllerLane(track.id, lane(1, ramp));
    const receipt = edit(project, [{ type: "copyRange", range: { startBeat: 1, endBeat: 2 }, atBeat: 6, placement: "insert", as: "c" }]);
    expect(receipt.status).toBe("applied");
    for (const beat of [0, 1, 2.5, 4, 5.5, 5.99]) expect(valueOf(project, track.id, beat)).toBe(original(beat));
    // The copy plays beats 1 to 2 of the ramp again, at 6 to 7.
    for (const beat of [6, 6.25, 6.5, 6.9]) expect(valueOf(project, track.id, beat)).toBe(original(beat - 5));
    // The ramp that was running at beat 6 goes on from there, one beat later.
    for (const beat of [7, 7.5, 8.5, 9.5]) expect(valueOf(project, track.id, beat)).toBe(original(beat - 1));
  });
});

describe("Undo of a lane edit is recorded lane by lane", () => {
  const sustain = lane(64, [
    { time: 0, value: 0, shape: "hold" },
    { time: 2, value: 127, shape: "hold" },
  ]);
  const volume = lane(7, [{ time: 0, value: 90, shape: "hold" }]);
  const setSustain = (project: Project, trackId: string) =>
    edit(project, [
      {
        type: "setControllerLane",
        trackId,
        expression: "channelController",
        channel: 0,
        controller: 64,
        points: sustain.points.map((point) => ({ atBeat: point.time, value: point.value, shape: point.shape })),
      },
    ]);

  test("a later change to another lane does not block the Undo, and is kept", () => {
    const { project, track } = setup();
    expect(setSustain(project, track.id).status).toBe("applied");
    // A direct edit outside the history, as a macro or a live fader move is.
    project.setControllerLane(track.id, volume);
    expect(lanesOf(project, track.id)).toHaveLength(2);
    expect(project.undo().status).toBe("applied");
    expect(lanesOf(project, track.id).map((item) => item.controller)).toEqual([7]);
  });

  test("a later change to the same lane is a conflict", () => {
    const { project, track } = setup();
    expect(setSustain(project, track.id).status).toBe("applied");
    project.setControllerLane(track.id, lane(64, [{ time: 1, value: 50, shape: "hold" }]));
    expect(project.undo().status).toBe("conflict");
    expect(lanesOf(project, track.id)[0].points).toHaveLength(1);
  });
});

describe("a lane before its first point is at rest", () => {
  const sustain = lane(64, [{ time: 4, value: 127, shape: "hold" }]);
  test("controllerRestValue: pedal and mod wheel 0, bend centre, volume 100, pan 64, none for a program", () => {
    expect(controllerRestValue("channelController", 64)).toBe(0);
    expect(controllerRestValue("channelController", 1)).toBe(0);
    expect(controllerRestValue("channelController", 7)).toBe(100);
    expect(controllerRestValue("channelController", 10)).toBe(64);
    expect(controllerRestValue("channelController", 11)).toBe(127);
    expect(controllerRestValue("pitchBend", 0)).toBe(8192);
    expect(controllerRestValue("channelPressure", 0)).toBe(0);
    expect(controllerRestValue("programChange", 0)).toBeUndefined();
  });
  test("a start or seek before the first point sends the rest value at once, a program lane sends nothing", () => {
    expect(controllerMessagesIn(sustain, 1, 2, true)).toEqual([{ beat: 1, data: Uint8Array.of(0xb0, 64, 0) }]);
    expect(controllerMessagesIn(sustain, 1, 2, false)).toEqual([]);
    const bend = lane(0, [{ time: 4, value: 16383, shape: "hold" }], "pitchBend", 2);
    expect(controllerMessagesIn(bend, 0, 1, true)).toEqual([{ beat: 0, data: Uint8Array.of(0xe2, 0, 64) }]);
    expect(controllerMessagesIn(lane(0, [{ time: 4, value: 3, shape: "hold" }], "programChange"), 0, 1, true)).toEqual([]);
  });
  test("controllerRestOf names the message that undoes another and ignores notes and channel-mode messages", () => {
    expect(controllerRestOf([0xb1, 64, 127])).toMatchObject({ atRest: false, rest: Uint8Array.of(0xb1, 64, 0) });
    expect(controllerRestOf([0xe0, 0, 64])?.atRest).toBe(true);
    expect(controllerRestOf([0x90, 60, 100])).toBeUndefined();
    expect(controllerRestOf([0xb0, 123, 0])).toBeUndefined();
  });
});

/** The channel messages of the one MIDI track of a file, in file order, as `[tick, bytes]`. */
function messagesOf(bytes: Uint8Array): Array<[number, number[]]> {
  const out: Array<[number, number[]]> = [];
  let at = 14;
  let trackIndex = 0;
  while (at < bytes.length) {
    const length = (bytes[at + 4] << 24) | (bytes[at + 5] << 16) | (bytes[at + 6] << 8) | bytes[at + 7];
    const end = at + 8 + length;
    let i = at + 8;
    let tick = 0;
    while (i < end) {
      let delta = 0;
      while (bytes[i] & 0x80) delta = (delta << 7) | (bytes[i++] & 0x7f);
      tick += (delta << 7) | bytes[i++];
      if (bytes[i] === 0xff) {
        i += 2 + 1 + bytes[i + 2];
        continue;
      }
      const size = (bytes[i] & 0xf0) === 0xc0 || (bytes[i] & 0xf0) === 0xd0 ? 2 : 3;
      if (trackIndex === 1) out.push([tick, [...bytes.slice(i, i + size)]]);
      i += size;
    }
    at = end;
    trackIndex++;
  }
  return out;
}

describe("exportMidiFile", () => {
  function track() {
    const { project, track } = setup();
    // The clip: a note 0 to 1 beat, one from 2 beats on, its own CC1 and pedal events at beat 2, and a program change at beat 2.
    project.addMidiClip(
      track.id,
      {
        duration: 4,
        notes: [
          { pitch: 60, velocity: 1, start: 0, duration: 2 },
          { pitch: 64, velocity: 1, start: 2, duration: 1 },
        ],
        events: [
          { time: 2, data: Uint8Array.of(0xb0, 1, 99) },
          { time: 2, data: Uint8Array.of(0xb0, 64, 127) },
        ],
      },
      0,
    );
    return { project, track };
  }

  test("at one beat the lane's program change and controllers come before the clip's note-on, and a note-off still comes first", () => {
    const { project, track: keys } = track();
    project.setControllerLane(keys.id, lane(7, [{ time: 2, value: 80, shape: "hold" }]));
    project.setControllerLane(keys.id, lane(0, [{ time: 2, value: 5, shape: "hold" }], "programChange"));
    const atTwo = messagesOf(exportMidiFile(project, { ppq: 480 })).filter(([tick]) => tick === 960);
    const kinds = atTwo.map(([, data]) => (data[0] & 0xf0) + (data[0] === 0x90 ? 0 : 0));
    expect(kinds.indexOf(0x80)).toBeLessThan(kinds.indexOf(0xc0));
    expect(kinds.indexOf(0xc0)).toBeLessThan(kinds.indexOf(0xb0));
    expect(kinds.indexOf(0xb0)).toBeLessThan(kinds.indexOf(0x90));
  });

  test("a lane replaces the clip's own events for the same controller, and other controllers stay", () => {
    const { project, track: keys } = track();
    project.setControllerLane(keys.id, lane(1, [{ time: 0, value: 7, shape: "hold" }]));
    const sent = messagesOf(exportMidiFile(project, { ppq: 480 })).map(([, data]) => data.join(","));
    expect(sent).toContain("176,1,7");
    expect(sent).not.toContain("176,1,99");
    // The pedal has no lane: the clip's own event stays.
    expect(sent).toContain("176,64,127");
    // The notes are untouched.
    expect(sent.filter((message) => message.startsWith("144,"))).toHaveLength(2);
  });

  test("a clip's own events are all kept without a lane", () => {
    const { project } = track();
    const sent = messagesOf(exportMidiFile(project, { ppq: 480 })).map(([, data]) => data.join(","));
    expect(sent).toContain("176,1,99");
    expect(project.tracks[0].clips[0]).toBeInstanceOf(MidiClip);
  });
});
