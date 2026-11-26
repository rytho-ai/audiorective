/**
 * Clause 4.5: a MIDI file written by `exportMidiFile` is read the same way by an independent implementation (`midi-file`, MIT), and a file written
 * by that library imports into the project as written. The expectations are spelled out by hand from the project, not read back through our own parser.
 */
import { parseMidi, writeMidi } from "midi-file";
import { describe, expect, test } from "vitest";
import { MidiClip, Project, exportMidiFile, importMidiFile } from "../src/project";

const PPQ = 960;
const tick = (beat: number) => Math.round(beat * PPQ);
const velocity = (value: number) => value / 127;

type Row = [tick: number, kind: string, ...rest: number[]];
/** Absolute-tick rows of one parsed track, in a canonical order (tick, kind, then data). */
function rows(events: ReadonlyArray<Record<string, unknown>>): Row[] {
  let at = 0;
  const out: Row[] = [];
  for (const event of events) {
    at += event.deltaTime as number;
    const channel = event.channel as number;
    switch (event.type) {
      case "noteOn":
        out.push([at, (event.velocity as number) === 0 ? "off" : "on", channel, event.noteNumber as number, event.velocity as number]);
        break;
      case "noteOff":
        out.push([at, "off", channel, event.noteNumber as number, 0]);
        break;
      case "controller":
        out.push([at, "cc", channel, event.controllerType as number, event.value as number]);
        break;
      case "pitchBend":
        out.push([at, "bend", channel, event.value as number]);
        break;
      case "programChange":
        out.push([at, "program", channel, event.programNumber as number]);
        break;
    }
  }
  return out.sort(
    (a, b) => a[0] - b[0] || a[1].localeCompare(b[1]) || a.slice(2).join().localeCompare(b.slice(2).join(), undefined, { numeric: true }),
  );
}
const sorted = (list: Row[]) =>
  [...list].sort(
    (a, b) => a[0] - b[0] || a[1].localeCompare(b[1]) || a.slice(2).join().localeCompare(b.slice(2).join(), undefined, { numeric: true }),
  );

/** note on/off rows for a note: channel, pitch, MIDI velocity (0-127), start and length in beats. */
const note = (channel: number, pitch: number, vel: number, start: number, length: number): Row[] => [
  [tick(start), "on", channel, pitch, vel],
  [tick(start + length), "off", channel, pitch, 0],
];

describe("exportMidiFile read by midi-file", () => {
  function song() {
    const project = new Project({ bpm: 100, title: "Third Party" });
    project.setTempoChanges([
      { beat: 8, bpm: 140 },
      { beat: 24, bpm: 90 },
    ]);
    project.setTimeSignatureChanges([
      { beat: 16, numerator: 3, denominator: 4 },
      { beat: 34, numerator: 7, denominator: 8 },
    ]);
    const lead = project.addTrack("Lead", "midi");
    const bass = project.addTrack("Bass Guitar", "midi");
    const drums = project.addTrack("Drums", "midi");
    const pad = project.addTrack("Pad", "midi");
    project.addTrack("Vocals", "audio");

    const phrase = [
      { pitch: 60, velocity: velocity(100), start: 0, duration: 1 },
      { pitch: 62, velocity: velocity(64), start: 1, duration: 1 },
      { pitch: 64, velocity: velocity(127), start: 2, duration: 2 },
    ];
    // Plain clip at the start.
    project.addMidiClip(lead.id, { notes: phrase, duration: 4 }, 0);
    // A window: content beats [1, 3) play at beat 12, the last note is cut at the window edge.
    project.addMidiClip(lead.id, { notes: phrase, duration: 2, sourceOffset: 1 }, 12);
    // A loop: content beats [0, 2) repeat over 6 beats from beat 20.
    const looped = project.addMidiClip(lead.id, { notes: phrase, duration: 6 }, 20);
    project.setClipLoop(looped.id, { startBeat: 0, endBeat: 2 });

    project.addMidiClip(
      bass.id,
      {
        notes: [
          { pitch: 36, velocity: velocity(90), start: 0.5, duration: 0.75, channel: 3 },
          { pitch: 43, velocity: velocity(95), start: 4.25, duration: 1.5, channel: 3 },
        ],
        duration: 8,
      },
      0,
    );
    const hits: Array<[number, number]> = [
      [36, 0],
      [38, 1],
      [36, 2],
      [38, 3],
      [42, 0.5],
      [42, 1.5],
      [42, 2.5],
      [42, 3.5],
    ];
    project.addMidiClip(
      drums.id,
      { notes: hits.map(([pitch, start]) => ({ pitch, velocity: velocity(110), start, duration: 0.25, channel: 9 })), duration: 4 },
      4,
    );
    // Pad: controllers, a sustain pedal and a bend, at clip-relative times; the clip sits at beat 4.
    project.addMidiClip(
      pad.id,
      {
        notes: [{ pitch: 72, velocity: velocity(70), start: 0, duration: 3, channel: 2 }],
        duration: 8,
        events: [
          { time: 0, data: new Uint8Array([0xb2, 64, 127]) },
          { time: 3, data: new Uint8Array([0xb2, 1, 40]) },
          { time: 7.5, data: new Uint8Array([0xb2, 64, 0]) },
          { time: 5, data: new Uint8Array([0xe2, 0x00, 0x60]) },
        ],
      },
      4,
    );
    return project;
  }

  const expectedRows = {
    // Window plays content [1,3) at beat 12: 62 at 12 (1 beat), 64 at 13 cut to 1 beat. Loop plays 60 and 62 three times from beat 20.
    Lead: sorted([
      ...note(0, 60, 100, 0, 1),
      ...note(0, 62, 64, 1, 1),
      ...note(0, 64, 127, 2, 2),
      ...note(0, 62, 64, 12, 1),
      ...note(0, 64, 127, 13, 1),
      ...[20, 22, 24].flatMap((at) => [...note(0, 60, 100, at, 1), ...note(0, 62, 64, at + 1, 1)]),
    ]),
    "Bass Guitar": sorted([...note(3, 36, 90, 0.5, 0.75), ...note(3, 43, 95, 4.25, 1.5)]),
    Drums: sorted(
      [
        [36, 0],
        [38, 1],
        [36, 2],
        [38, 3],
        [42, 0.5],
        [42, 1.5],
        [42, 2.5],
        [42, 3.5],
      ].flatMap(([pitch, start]) => note(9, pitch!, 110, 4 + start!, 0.25)),
    ),
    Pad: sorted([
      ...note(2, 72, 70, 4, 3),
      [tick(4), "cc", 2, 64, 127],
      [tick(7), "cc", 2, 1, 40],
      [tick(9), "bend", 2, 0x60 * 128 - 8192],
      [tick(11.5), "cc", 2, 64, 0],
    ]),
  };

  test("track count and names, every note and controller, tempo and time signature events", () => {
    const project = song();
    const parsed = parseMidi(exportMidiFile(project));
    expect(parsed.header.format).toBe(1);
    expect(parsed.header.ticksPerBeat).toBe(PPQ);
    expect(parsed.header.numTracks).toBe(5);
    expect(parsed.tracks).toHaveLength(5);

    const names = parsed.tracks.map((events) => (events.find((event) => event.type === "trackName") as { text: string } | undefined)?.text);
    expect(names).toEqual(["Third Party", "Lead", "Bass Guitar", "Drums", "Pad"]);

    // Conductor track: tempo and time signature events at the right ticks, no notes.
    let at = 0;
    const tempos: Array<[number, number]> = [];
    const signatures: Array<[number, number, number]> = [];
    for (const event of parsed.tracks[0]!) {
      at += event.deltaTime;
      if (event.type === "setTempo") tempos.push([at, Math.round(60_000_000 / event.microsecondsPerBeat)]);
      if (event.type === "timeSignature") signatures.push([at, event.numerator, event.denominator]);
      expect(["noteOn", "noteOff"]).not.toContain(event.type);
    }
    expect(tempos).toEqual([
      [0, 100],
      [tick(8), 140],
      [tick(24), 90],
    ]);
    expect(signatures).toEqual([
      [0, 4, 4],
      [tick(16), 3, 4],
      [tick(34), 7, 8],
    ]);

    for (const [index, name] of (["Lead", "Bass Guitar", "Drums", "Pad"] as const).entries()) {
      const actual = rows(parsed.tracks[index + 1] as unknown as ReadonlyArray<Record<string, unknown>>);
      expect(actual, name).toEqual(expectedRows[name]);
    }
    // The audio track exports nothing, and every track ends with an end-of-track event.
    for (const events of parsed.tracks) expect(events[events.length - 1]!.type).toBe("endOfTrack");
    project.dispose();
  });

  test("running status and another resolution read back the same", () => {
    const project = song();
    for (const options of [{ ppq: 480 }, { runningStatus: true }, { ppq: 192, runningStatus: true }]) {
      const ppq = options.ppq ?? PPQ;
      const parsed = parseMidi(exportMidiFile(project, options));
      expect(parsed.header.ticksPerBeat).toBe(ppq);
      const bass = rows(parsed.tracks[2] as unknown as ReadonlyArray<Record<string, unknown>>);
      expect(bass).toEqual(
        sorted([
          [Math.round(0.5 * ppq), "on", 3, 36, 90],
          [Math.round(1.25 * ppq), "off", 3, 36, 0],
          [Math.round(4.25 * ppq), "on", 3, 43, 95],
          [Math.round(5.75 * ppq), "off", 3, 43, 0],
        ]),
      );
    }
    project.dispose();
  });
});

describe("importMidiFile reads a file written by midi-file", () => {
  test("tracks, names, notes, channels, controllers, tempo and meter come in as written", () => {
    const ppq = 480;
    const meta = (type: string, extra: object) => ({ deltaTime: 0, meta: true, type, ...extra }) as never;
    const conductor = [
      meta("trackName", { text: "Conductor" }),
      meta("setTempo", { microsecondsPerBeat: 600_000 }), // 100 bpm
      meta("timeSignature", { numerator: 4, denominator: 4, metronome: 24, thirtyseconds: 8 }),
      { deltaTime: 16 * ppq, meta: true, type: "setTempo", microsecondsPerBeat: 400_000 } as never, // 150 bpm at beat 16
      { deltaTime: 0, meta: true, type: "timeSignature", numerator: 3, denominator: 4, metronome: 24, thirtyseconds: 8 } as never,
      { deltaTime: 0, meta: true, type: "endOfTrack" } as never,
    ];
    const keys = [
      meta("trackName", { text: "Keys" }),
      { deltaTime: 0, channel: 1, type: "controller", controllerType: 64, value: 127 } as never,
      { deltaTime: 0, channel: 1, type: "noteOn", noteNumber: 60, velocity: 100 } as never,
      { deltaTime: ppq, channel: 1, type: "noteOff", noteNumber: 60, velocity: 0 } as never,
      { deltaTime: ppq, channel: 1, type: "noteOn", noteNumber: 64, velocity: 50 } as never,
      { deltaTime: 2 * ppq, channel: 1, type: "noteOff", noteNumber: 64, velocity: 0 } as never,
      { deltaTime: 0, channel: 1, type: "controller", controllerType: 64, value: 0 } as never,
      { deltaTime: 0, meta: true, type: "endOfTrack" } as never,
    ];
    const drums = [
      meta("trackName", { text: "Drum Kit" }),
      { deltaTime: 4 * ppq, channel: 9, type: "noteOn", noteNumber: 36, velocity: 127 } as never,
      { deltaTime: ppq / 4, channel: 9, type: "noteOff", noteNumber: 36, velocity: 0 } as never,
      { deltaTime: 3 * ppq + ppq / 2, channel: 9, type: "noteOn", noteNumber: 42, velocity: 80 } as never,
      { deltaTime: ppq / 4, channel: 9, type: "noteOff", noteNumber: 42, velocity: 0 } as never,
      { deltaTime: 0, meta: true, type: "endOfTrack" } as never,
    ];
    const bytes = Uint8Array.from(writeMidi({ header: { format: 1, numTracks: 3, ticksPerBeat: ppq }, tracks: [conductor, keys, drums] }));

    const project = new Project({ bpm: 120 });
    const result = importMidiFile(project, bytes);
    expect(result.tempoMapUsed).toBe("file");
    expect(result.warnings).toEqual([]);
    expect(project.bpm).toBe(100);
    expect(project.tempoMap.changes).toEqual([{ beat: 16, bpm: 150 }]);
    expect(project.signature).toEqual([4, 4]);
    expect(project.meterMap.changes).toEqual([{ beat: 16, numerator: 3, denominator: 4 }]);
    expect(project.tracks.map((track) => track.name)).toEqual(["Keys", "Drum Kit"]);

    const clipOf = (name: string) => project.tracks.find((track) => track.name === name)!.clips[0] as MidiClip;
    const keysClip = clipOf("Keys");
    expect(keysClip.midi.notes.value.map((n) => [n.pitch, n.channel, n.start, n.duration, Math.round(n.velocity * 127)])).toEqual([
      [60, 1, 0, 1, 100],
      [64, 1, 2, 2, 50],
    ]);
    expect(keysClip.events.map((event) => [event.time, [...event.data]])).toEqual([
      [0, [0xb1, 64, 127]],
      [4, [0xb1, 64, 0]],
    ]);
    expect(clipOf("Drum Kit").midi.notes.value.map((n) => [n.pitch, n.channel, n.start, n.duration, Math.round(n.velocity * 127)])).toEqual([
      [36, 9, 4, 0.25, 127],
      [42, 9, 7.75, 0.25, 80],
    ]);
    project.dispose();
  });
});
