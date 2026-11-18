import { describe, expect, test } from "vitest";
import { unzipSync, zipSync } from "fflate";
import type { RecordedMidi } from "@audiorective/midi";
import { Project, TempoMap, openDawProject, saveDawProject } from "../src";

const text = new TextDecoder();
const bytes = new TextEncoder();

function midiTake(releaseFirst: boolean): RecordedMidi {
  const off = { audioTime: 10.03, data: new Uint8Array([0x80, 60, 0]), noteId: "note-1" };
  const pedal = { audioTime: 10.03, data: new Uint8Array([0xb0, 64, 127]) };
  return {
    startTime: 10,
    endTime: 10.1,
    duration: 0.1,
    notes: [{ id: "note-1", start: 0, end: 0.03, pitch: 60, velocity: 90, channel: 0, track: 0 }],
    events: [{ audioTime: 10, data: new Uint8Array([0x90, 60, 90]), noteId: "note-1" }, ...(releaseFirst ? [off, pedal] : [pedal, off])],
  };
}

const midiBytes = (events: readonly { data: Uint8Array }[]) => events.map((event) => [...event.data]);

describe("project tempo map", () => {
  test("mixed MIDI units remain ordered by audible project time after a tempo edit", () => {
    const project = new Project({ bpm: 120 });
    project.setTempoChanges([{ beat: 4, bpm: 60 }]);
    const track = project.addTrack("Keys", "midi");
    const seconds = project.addMidiClip(track.id, { duration: 1, notes: [] }, 3.5);
    const beats = project.addMidiClip(track.id, { duration: 1, notes: [] }, 6, { timeUnit: "beats" });
    expect(project.tracks[0].clips.map((clip) => clip.id)).toEqual([seconds.id, beats.id]);
    project.setTempoChanges([{ beat: 4, bpm: 120 }]);
    expect(project.tracks[0].clips.map((clip) => clip.id)).toEqual([beats.id, seconds.id]);
    project.destroy();
  });

  test("beat MIDI stretches across tempo changes while seconds MIDI stays fixed", () => {
    const project = new Project({ bpm: 120 });
    project.setTempoChanges([{ beat: 4, bpm: 60 }]);
    const track = project.addTrack("Keys", "midi");
    const take: RecordedMidi = {
      startTime: 10, endTime: 12, duration: 2,
      notes: [{ id: "held", start: 0, end: 1.5, pitch: 60, velocity: 90, channel: 0, track: 0 }],
      events: [
        { audioTime: 10, data: new Uint8Array([0x90, 60, 90]), noteId: "held" },
        { audioTime: 10.5, data: new Uint8Array([0xb0, 64, 127]) },
        { audioTime: 11.5, data: new Uint8Array([0x80, 60, 0]), noteId: "held" },
        { audioTime: 12, data: new Uint8Array([0xb0, 64, 0]) },
      ],
    };
    const beatClip = project.addMidiTake(track.id, take, 1.5, { timeUnit: "beats" });
    const secondsClip = project.addMidiTake(track.id, take, 1.5);
    expect(beatClip.time).toBe(3);
    expect(beatClip.duration).toBe(2.5);
    expect(beatClip.sequence.getState().notes[0]).toMatchObject({ start: 0, end: 2 });
    expect(beatClip.playbackEvents().map((event) => event.time)).toEqual([0, 1, 2, 2.5]);
    expect(midiBytes(beatClip.playbackEvents())).toEqual(midiBytes(secondsClip.playbackEvents()));
    project.setTempoChanges([{ beat: 4, bpm: 120 }]);
    expect(project.clipTimeSeconds(beatClip, 2)).toBe(2.5);
    expect(project.clipTimeSeconds(secondsClip, 1.5)).toBe(3);
    const opened = openDawProject(saveDawProject(project));
    expect(opened.warnings).toEqual([]);
    const roundTrip = opened.project.tracks[0].clips.find((clip) => clip.kind === "midi" && clip.timeUnit === "beats");
    expect(roundTrip).toBeDefined();
    if (roundTrip?.kind !== "midi") throw new Error("Expected beat MIDI clip");
    expect(roundTrip.playbackEvents().map((event) => event.time)).toEqual([0, 1, 2, 2.5]);
    expect(midiBytes(roundTrip.playbackEvents())).toEqual(midiBytes(beatClip.playbackEvents()));
    const [left, right] = opened.project.splitClip(roundTrip.id, 1);
    expect([left.time, right.time]).toEqual([3, 4]);
    expect(right.kind === "midi" && right.timeUnit).toBe("beats");
    opened.project.destroy();
    project.destroy();
  });

  test("a legacy seconds sidecar cannot attach to beat-labelled XML", () => {
    const project = new Project();
    const track = project.addTrack("Keys", "midi");
    project.addMidiTake(track.id, midiTake(true), 0);
    const files = unzipSync(saveDawProject(project));
    const privateState = JSON.parse(text.decode(files["audiorective/state.json"]));
    privateState.version = 1;
    const plain = JSON.stringify({ time: 0, duration: 0.1, notes: [[0, 0.03, 60, 90, 0]], controls: [{ time: 10.03 - 10, channel: 0, controller: 64, value: 127 }] });
    let hash = 2166136261;
    for (const char of plain) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
    privateState.clips[0].fingerprint = (hash >>> 0).toString(16).padStart(8, "0");
    files["audiorective/state.json"] = bytes.encode(JSON.stringify(privateState));
    const legacy = openDawProject(zipSync(files));
    expect(legacy.warnings).toEqual([]);
    legacy.project.destroy();
    const xml = text.decode(files["project.xml"]).replaceAll('contentTimeUnit="seconds"', 'contentTimeUnit="beats"')
      .replace(/(<Clips[^>]*?)timeUnit="seconds"/, '$1timeUnit="beats"')
      .replace(/(<(?:Lanes|Notes|Points) id="clip[^"]+" )timeUnit="seconds"/g, '$1timeUnit="beats"');
    files["project.xml"] = bytes.encode(xml);
    expect(openDawProject(zipSync(files)).warnings.some((warning) => warning.includes("no matching Audiorective event details"))).toBe(true);
    project.destroy();
  });
  test("converts both sides of a step and snaps in musical beats", () => {
    const map = new TempoMap(120, [{ beat: 4, bpm: 60 }]);
    expect([0, 2, 4, 6, 8].map((beat) => map.beatToSeconds(beat))).toEqual([0, 1, 2, 4, 6]);
    expect([0, 1, 2, 4, 6].map((second) => map.secondsToBeat(second))).toEqual([0, 2, 4, 6, 8]);
    expect(map.snapSeconds(4.4)).toBe(4);
    expect(map.snapSeconds(4.6)).toBe(5);
    expect(map.bpmAtBeat(4)).toBe(60);
    expect(() => new TempoMap(120, [{ beat: 4, bpm: 60 }, { beat: 4, bpm: 90 }])).toThrow("unique positive beats");
    expect(() => new TempoMap(120, [{ beat: -1, bpm: 60 }])).toThrow("unique positive beats");
    expect(() => new TempoMap(Number.MIN_VALUE, [{ beat: 1, bpm: 60 }])).toThrow("unique positive beats");
  });

  test("saves hold tempo automation, reopens it, and preserves snapshots", () => {
    const project = new Project({ bpm: 120 });
    project.setTempoChanges([{ beat: 4, bpm: 60 }]);
    const track = project.addTrack("Keys", "midi");
    project.addMidiClip(track.id, { duration: 2, notes: [] }, 4);
    const files = unzipSync(saveDawProject(project));
    const xml = text.decode(files["project.xml"]);
    expect(xml).toContain('<TempoAutomation id="projectTempo" timeUnit="beats" unit="bpm">');
    expect(xml).toContain('<RealPoint time="4" value="60" interpolation="hold"/>');
    const opened = openDawProject(zipSync(files));
    expect(opened.warnings).toEqual([]);
    expect(opened.project.tempoMap.beatToSeconds(8)).toBe(6);
    expect(opened.project.tracks[0].clips[0].time).toBe(4);
    const snapshot = opened.project.snapshot();
    expect(snapshot.tempoMap.secondsToBeat(4)).toBe(6);
    const changed = { ...files, "project.xml": bytes.encode(xml.replace('interpolation="hold"', 'interpolation="linear"')) };
    expect(() => openDawProject(zipSync(changed))).toThrow("Project has unsupported tempo interpolation.");
    snapshot.destroy();
    opened.project.destroy();
    project.destroy();
  });
});

describe("DAWproject native slice", () => {
  test("round trips an Equalizer as one ordered slot and preserves all bands", () => {
    const project = new Project();
    const track = project.addTrack("EQ track", "audio");
    project.setTrackEffects(track.id, [{
      id: "three", type: "eq", wet: 0.6, enabled: false,
      bands: [
        { frequency: 250, gain: -3, q: 0.7 },
        { frequency: 1000, gain: 6, q: 1 },
        { frequency: 4000, gain: 0, q: 0.8 },
      ],
    }]);
    const reopened = openDawProject(saveDawProject(project)).project;
    expect(reopened.tracks[0].effects).toEqual(project.tracks[0].effects);
  });

  test("round trips ordered Filter and Delay settings and rejects missing state", () => {
    const project = new Project();
    const track = project.addTrack("Keys", "midi");
    project.addWebClapDevice(track.id, { pluginId: "test.synth", name: "Synth", vendor: "Test", version: "1", bundleUrl: "./synth" });
    const effects = [
      { id: "filter", type: "filter", enabled: false, wet: 0.8, frequency: 480, mode: "highpass", q: 0.8 },
      { id: "delay", type: "delay", enabled: true, wet: 0.25, delayTime: 0.45, feedback: 0.4 },
    ] as const;
    project.setTrackEffects(track.id, effects);
    expect(() => project.setTrackEffects(track.id, [effects[0], effects[0]])).toThrow("EffectRack needs unique slot IDs");
    expect(project.tracks[0].effects).toEqual(effects);
    const files = unzipSync(saveDawProject(project));
    const xml = text.decode(files["project.xml"]);
    expect(xml.indexOf("<ClapPlugin")).toBeLessThan(xml.indexOf('<BuiltinDevice deviceID="audiorective.insert.filter"'));
    const opened = openDawProject(zipSync(files));
    expect(opened.warnings).toEqual([]);
    expect(opened.project.tracks[0].effects).toEqual(effects);
    delete files["plugins/ar-insert-1.json"];
    expect(() => openDawProject(zipSync(files))).toThrow("Project built-in effect state is missing or reused.");
    opened.project.destroy();
    project.destroy();
  });

  test("saves macro positions and preserves the rack when private mappings are invalid", () => {
    const project = new Project();
    const track = project.addTrack("Bus", "bus");
    const filter = { id: "filter", type: "filter", enabled: true, wet: 0.8, frequency: 480, mode: "highpass", q: 0.8 } as const;
    const macros = [{ id: "tone", value: 0.4, targets: [{ slotId: filter.id, parameter: "frequency", min: 200, max: 8000, scale: "exponential" }] }] as const;
    project.setTrackRackPreset(track.id, { effects: [filter], macros });
    project.setTrackMacroValue(track.id, "tone", 0.65);
    const changed = project.tracks[0];
    expect(() => project.setTrackRackPreset(track.id, { effects: [filter], macros: [...macros, { ...macros[0], id: "copy" }] })).toThrow(/distinct valid targets/);
    expect(project.tracks[0]).toBe(changed);
    const archive = saveDawProject(project);
    const reopened = openDawProject(archive);
    expect(reopened.project.tracks[0].effectMacros).toEqual(changed.effectMacros);
    expect(reopened.warnings).toEqual([]);
    reopened.project.setTrackEffects(track.id, []);
    expect(reopened.project.tracks[0].effectMacros).toEqual([{ id: "tone", value: 0.65, targets: [] }]);
    const files = unzipSync(archive);
    const state = JSON.parse(text.decode(files["audiorective/state.json"]));
    state.rackMacros[track.id][0].targets[0].slotId = "missing";
    files["audiorective/state.json"] = new TextEncoder().encode(JSON.stringify(state));
    const fallback = openDawProject(zipSync(files));
    expect(fallback.warnings).toContain("Invalid Audiorective rack macros on Bus were skipped.");
    expect(fallback.project.tracks[0].effects).toEqual([filter]);
    expect(fallback.project.tracks[0].effectMacros).toEqual([]);
  });

  test("splits and trims audio at sample boundaries, then saves both pieces", () => {
    const project = new Project();
    const track = project.addTrack("Mic", "audio");
    const original = project.addAudioClip(track.id, { sampleRate: 4, channels: [new Float32Array([1, 2, 3, 4, 5, 6, 7, 8])] }, 2);
    const [left, right] = project.splitClip(original.id, 1);
    expect(left).toMatchObject({ id: original.id, time: 2, duration: 1 });
    expect(right).toMatchObject({ time: 3, duration: 1 });
    if (left.kind !== "audio" || right.kind !== "audio") throw new Error("Expected audio clips");
    expect([...left.channels[0]]).toEqual([1, 2, 3, 4]);
    expect([...right.channels[0]]).toEqual([5, 6, 7, 8]);
    const trimmed = project.trimClip(right.id, 0.25, 0.75);
    if (trimmed.kind !== "audio") throw new Error("Expected audio clip");
    expect(trimmed.time).toBe(3.25);
    expect([...trimmed.channels[0]]).toEqual([6, 7]);
    const opened = openDawProject(saveDawProject(project));
    expect(opened.project.tracks[0].clips.map((clip) => [clip.id, clip.time, clip.duration])).toEqual([
      [left.id, 2, 1],
      [right.id, 3.25, 0.5],
    ]);
    expect(() => project.splitClip(left.id, 0)).toThrow("Project split needs a time inside the clip.");
    expect(() => project.trimClip(left.id, 1, 1)).toThrow("Project trim needs 0 <= start < end <= clip duration.");
    expect(project.tracks[0].clips).toHaveLength(2);
    opened.project.destroy();
    project.destroy();
  });

  test("splits MIDI crossing notes and keeps controller timing", () => {
    const project = new Project();
    const track = project.addTrack("Keys", "midi");
    const clip = project.addMidiClip(
      track.id,
      {
        duration: 2,
        notes: [{ id: "held", start: 0.5, end: 1.5, pitch: 60, velocity: 90, channel: 0, track: 0 }],
        events: [{ time: 1.25, data: new Uint8Array([0xb0, 1, 80]) }],
      },
      4,
    );
    const [left, right] = project.splitClip(clip.id, 1);
    if (left.kind !== "midi" || right.kind !== "midi") throw new Error("Expected MIDI clips");
    expect(left.sequence.getState().notes[0]).toMatchObject({ start: 0.5, end: 1 });
    expect(right.sequence.getState().notes[0]).toMatchObject({ start: 0, end: 0.5 });
    expect(right.playbackEvents().find((event) => event.data[0] === 0xb0)?.time).toBe(0.25);
    const trimmed = project.trimClip(right.id, 0.25, 1);
    if (trimmed.kind !== "midi") throw new Error("Expected MIDI clip");
    expect(trimmed.time).toBe(5.25);
    expect(trimmed.sequence.getState().notes[0]).toMatchObject({ start: 0, end: 0.25 });
    expect(trimmed.playbackEvents().find((event) => event.data[0] === 0xb0)?.time).toBe(0);
    const opened = openDawProject(saveDawProject(project));
    expect(opened.project.tracks[0].clips).toHaveLength(2);
    opened.project.destroy();
    project.destroy();
  });

  test("split MIDI carries sustain into the right clip and releases it at each clip end", () => {
    const project = new Project();
    const track = project.addTrack("Keys", "midi");
    const clip = project.addMidiClip(
      track.id,
      {
        duration: 2,
        notes: [{ id: "held", start: 0.5, end: 1.5, pitch: 60, velocity: 90, channel: 0, track: 0 }],
        events: [
          { time: 0.75, data: new Uint8Array([0xb0, 64, 127]) },
          { time: 1.75, data: new Uint8Array([0xb0, 64, 0]) },
        ],
      },
      0,
    );
    const [left, right] = project.splitClip(clip.id, 1);
    if (left.kind !== "midi" || right.kind !== "midi") throw new Error("Expected MIDI clips");
    const controls = (part: typeof left) =>
      part
        .playbackEvents()
        .filter((event) => event.data[1] === 64)
        .map((event) => [event.time, event.data[2]]);
    expect(controls(left)).toEqual([
      [0.75, 127],
      [1, 0],
    ]);
    expect(controls(right)).toEqual([
      [0, 127],
      [0.75, 0],
    ]);
    const boundary = project.addMidiClip(
      track.id,
      {
        duration: 2,
        notes: [],
        events: [
          { time: 0.75, data: new Uint8Array([0xb0, 64, 127]) },
          { time: 1, data: new Uint8Array([0xb0, 64, 0]) },
        ],
      },
      3,
    );
    const [, boundaryRight] = project.splitClip(boundary.id, 1);
    if (boundaryRight.kind !== "midi") throw new Error("Expected MIDI clip");
    expect(controls(boundaryRight)).toEqual([[0, 0]]);
    const opened = openDawProject(saveDawProject(project));
    expect(opened.warnings).toEqual([]);
    opened.project.destroy();
    project.destroy();
  });

  test("preserves WebCLAP device identity, bundle location and state in a project round trip", () => {
    const project = new Project({ title: "Synth" });
    const track = project.addTrack("Keys", "midi");
    const device = project.addWebClapDevice(track.id, {
      pluginId: "com.example.synth",
      name: "Synth",
      vendor: "Example",
      version: "1.2",
      bundleUrl: "/bundles/synth.wclap",
      state: new Uint8Array([1, 2, 3]),
    });
    project.setDeviceState(device.id, new Uint8Array([4, 5, 6]));
    const files = unzipSync(saveDawProject(project));
    expect(text.decode(files["project.xml"])).toContain('<ClapPlugin id="device2" deviceID="com.example.synth"');
    expect(files["plugins/device2.bin"]).toEqual(new Uint8Array([4, 5, 6]));
    const opened = openDawProject(zipSync(files));
    expect(opened.warnings).toEqual([]);
    expect(opened.project.tracks[0].devices[0]).toMatchObject({
      kind: "webclap",
      id: "device2",
      pluginId: "com.example.synth",
      bundleUrl: "/bundles/synth.wclap",
      state: new Uint8Array([4, 5, 6]),
    });
    const withoutLocator = { ...files };
    delete withoutLocator["audiorective/host.json"];
    const portable = openDawProject(zipSync(withoutLocator));
    expect(portable.warnings).toContain("WebCLAP device device2 needs a bundle location.");
    expect(portable.project.tracks[0].devices[0]).toMatchObject({
      pluginId: "com.example.synth",
      bundleUrl: "",
      state: new Uint8Array([4, 5, 6]),
    });
    portable.project.destroy();
    const withoutState = { ...files };
    delete withoutState["plugins/device2.bin"];
    expect(() => openDawProject(zipSync(withoutState))).toThrow("Project device state asset is missing.");
    opened.project.destroy();
    project.destroy();
  });

  test("saves an audio/MIDI project and reopens its edited playback state", () => {
    const project = new Project({ title: "A & B", bpm: 120, signature: [4, 4] });
    const midiTrack = project.addTrack("Keys", "midi");
    const audioTrack = project.addTrack("Mic", "audio");
    const midi = project.addMidiTake(midiTrack.id, midiTake(true), 0.5);
    midi.sequence.updateNote("note-1", { pitch: 62 });
    const samples = new Float32Array([0, 0.25, -0.3, 0.75]);
    project.addAudioClip(audioTrack.id, { sampleRate: 48_000, channels: [samples] }, 1);
    project.setVolumeAutomation(midiTrack.id, [
      { time: 0, value: 1, shape: "linear" },
      { time: 2, value: 0.5, shape: "hold" },
    ]);
    const archive = saveDawProject(project);
    const entries = unzipSync(archive);
    expect(Object.keys(entries).sort()).toEqual(["audio/clip4.wav", "audiorective/state.json", "metadata.xml", "project.xml"]);
    expect(text.decode(entries["project.xml"])).toContain('contentTimeUnit="seconds"');
    expect(text.decode(entries["metadata.xml"])).toContain("A &amp; B");

    const opened = openDawProject(archive);
    expect(opened.warnings).toEqual([]);
    expect(opened.project.title).toBe("A & B");
    expect(opened.project.bpm).toBe(120);
    expect(opened.project.signature).toEqual([4, 4]);
    const loadedMidi = opened.project.tracks[0].clips[0];
    expect(loadedMidi.kind).toBe("midi");
    if (loadedMidi.kind !== "midi") throw new Error("Expected MIDI clip");
    expect(loadedMidi.sequence.getState().notes[0].id).toBe("note-1");
    expect(loadedMidi.sequence.getState().notes[0].pitch).toBe(62);
    expect(midiBytes(loadedMidi.playbackEvents())).toEqual([
      [0x90, 62, 90],
      [0x80, 62, 0],
      [0xb0, 64, 127],
    ]);
    expect(opened.project.tracks[0].volumeAutomation).toEqual([
      { time: 0, value: 1, shape: "linear" },
      { time: 2, value: 0.5, shape: "hold" },
    ]);
    const loadedAudio = opened.project.tracks[1].clips[0];
    expect(loadedAudio.kind).toBe("audio");
    if (loadedAudio.kind !== "audio") throw new Error("Expected audio clip");
    expect(loadedAudio.time).toBe(1);
    expect(loadedAudio.sampleRate).toBe(48_000);
    expect(loadedAudio.channels[0]).toEqual(samples);
    expect(openDawProject(saveDawProject(opened.project)).warnings).toEqual([]);
    opened.project.destroy();
    project.destroy();
  });

  test("the private detail distinguishes equal-time pedal/release order", () => {
    const files = [true, false].map((releaseFirst) => {
      const project = new Project();
      const track = project.addTrack("Keys", "midi");
      const clip = project.addMidiTake(track.id, midiTake(releaseFirst), 0);
      clip.sequence.updateNote("note-1", { pitch: 62 });
      const archive = saveDawProject(project);
      project.destroy();
      return archive;
    });
    expect(unzipSync(files[0])["project.xml"]).toEqual(unzipSync(files[1])["project.xml"]);
    const orders = files.map((file) => {
      const opened = openDawProject(file);
      const clip = opened.project.tracks[0].clips[0];
      if (clip.kind !== "midi") throw new Error("Expected MIDI clip");
      const order = midiBytes(clip.playbackEvents());
      opened.project.destroy();
      return order;
    });
    expect(orders[0]).toEqual([
      [0x90, 62, 90],
      [0x80, 62, 0],
      [0xb0, 64, 127],
    ]);
    expect(orders[1]).toEqual([
      [0x90, 62, 90],
      [0xb0, 64, 127],
      [0x80, 62, 0],
    ]);
  });

  test("interleaved controller lanes keep their private event alignment", () => {
    const take = midiTake(false);
    const project = new Project();
    const track = project.addTrack("Keys", "midi");
    project.addMidiTake(
      track.id,
      {
        ...take,
        events: [
          take.events[0],
          { audioTime: 10.01, data: new Uint8Array([0xb0, 64, 127]) },
          { audioTime: 10.02, data: new Uint8Array([0xb0, 1, 80]) },
          { audioTime: 10.025, data: new Uint8Array([0xb0, 64, 0]) },
          take.events[2],
        ],
      },
      0,
    );
    const opened = openDawProject(saveDawProject(project));
    expect(opened.warnings).toEqual([]);
    const clip = opened.project.tracks[0].clips[0];
    if (clip.kind !== "midi") throw new Error("Expected MIDI clip");
    expect(midiBytes(clip.playbackEvents())).toEqual([
      [0x90, 60, 90],
      [0xb0, 64, 127],
      [0xb0, 1, 80],
      [0xb0, 64, 0],
      [0x80, 60, 0],
    ]);
    opened.project.destroy();
    project.destroy();
  });

  test("unsupported MIDI messages fail on save before portable content can be lost", () => {
    const project = new Project();
    const track = project.addTrack("Keys", "midi");
    const take = midiTake(true);
    project.addMidiTake(track.id, { ...take, events: [...take.events, { audioTime: 10.05, data: new Uint8Array([0xc0, 12]) }] }, 0);
    expect(() => saveDawProject(project)).toThrow("Project MIDI has events outside supported portable content.");
    project.destroy();
  });

  test("an externally changed XML clip cannot reuse stale private MIDI events", () => {
    const project = new Project();
    const track = project.addTrack("Keys", "midi");
    project.addMidiTake(track.id, midiTake(true), 0);
    const entries = unzipSync(saveDawProject(project));
    entries["project.xml"] = bytes.encode(text.decode(entries["project.xml"]).replace('key="60"', 'key="65"'));
    const opened = openDawProject(zipSync(entries));
    expect(opened.warnings).toHaveLength(1);
    const clip = opened.project.tracks[0].clips[0];
    if (clip.kind !== "midi") throw new Error("Expected MIDI clip");
    expect(clip.sequence.getState().notes[0].pitch).toBe(65);
    expect(midiBytes(clip.playbackEvents())).toEqual([
      [0x90, 65, 90],
      [0xb0, 64, 127],
      [0x80, 65, 0],
    ]);
    opened.project.destroy();
    project.destroy();
  });

  test("missing media and unsupported routing fail instead of dropping content", () => {
    const project = new Project();
    const track = project.addTrack("Mic", "audio");
    project.addAudioClip(track.id, { sampleRate: 48_000, channels: [new Float32Array([0.25])] }, 0);
    const entries = unzipSync(saveDawProject(project));
    delete entries["audio/clip2.wav"];
    expect(() => openDawProject(zipSync(entries))).toThrow("Project audio asset is missing.");
    const routing = unzipSync(saveDawProject(project));
    routing["project.xml"] = bytes.encode(text.decode(routing["project.xml"]).replace('destination="masterChannel"', 'destination="otherBus"'));
    expect(() => openDawProject(zipSync(routing))).toThrow("Project has unsupported track routing.");
    const fade = unzipSync(saveDawProject(project));
    fade["project.xml"] = bytes.encode(text.decode(fade["project.xml"]).replace("<Clip ", '<Clip fadeInTime="0.01" '));
    expect(() => openDawProject(zipSync(fade))).toThrow("Clip gain must be non-negative and fades must fit its duration.");
    const tempo = unzipSync(saveDawProject(project));
    tempo["project.xml"] = bytes.encode(text.decode(tempo["project.xml"]).replace(/(<Tempo [^>]+)\/>/, "$1><Points/></Tempo>"));
    expect(() => openDawProject(zipSync(tempo))).toThrow("Project XML has unsupported Tempo content.");
    const extra = unzipSync(saveDawProject(project));
    extra["plugins/unknown-state.bin"] = new Uint8Array([1]);
    expect(() => openDawProject(zipSync(extra))).toThrow("Project archive has unsupported files.");
    expect(() => project.addAudioClip(track.id, { sampleRate: 48_000, channels: [new Float32Array([Number.NaN])] }, 0)).toThrow(
      "Project audio clips need a time, sample rate and equal-length PCM channels.",
    );
    project.destroy();
  });

  test("arrangement edits and mixer state survive a DAWproject round trip", () => {
    const project = new Project({ title: "Arrangement" });
    const first = project.addTrack("Keys A", "midi");
    const second = project.addTrack("Keys B", "midi");
    const audio = project.addTrack("Drums", "audio");
    const clip = project.addMidiTake(first.id, midiTake(true), 0);
    const sequence = clip.sequence;
    project.moveClip(clip.id, second.id, 2);
    expect(project.tracks[0].clips).toHaveLength(0);
    expect(project.tracks[1].clips[0]).toBe(clip);
    expect(clip.sequence).toBe(sequence);
    expect(clip.time).toBe(2);
    const copy = project.duplicateClip(clip.id, 4);
    expect(copy.id).not.toBe(clip.id);
    expect(copy.kind).toBe("midi");
    project.removeClip(clip.id);
    project.setTrackName(second.id, "Lead");
    project.setTrackMuted(second.id, true);
    project.setTrackSolo(audio.id, true);
    project.setTrackPan(audio.id, -0.6);
    project.setMarkers([
      { time: 0, name: "Intro" },
      { time: 4, name: "Chorus" },
    ]);
    project.setTitle("Arranged song");
    project.removeTrack(first.id);
    const archive = saveDawProject(project);
    const xml = text.decode(unzipSync(archive)["project.xml"]);
    expect(xml).toContain(`<Mute id="${second.id}-mute" value="true"/>`);
    expect(xml).toContain('solo="true"');
    expect(xml).toContain('unit="normalized" value="0.2"');
    const opened = openDawProject(archive);
    expect(opened.warnings).toEqual([]);
    expect(opened.project.title).toBe("Arranged song");
    expect(opened.project.markers).toEqual([
      { time: 0, name: "Intro" },
      { time: 4, name: "Chorus" },
    ]);
    expect(opened.project.tracks[0]).toMatchObject({ name: "Lead", muted: true, solo: false, pan: 0 });
    expect(opened.project.tracks[0].clips[0].time).toBe(4);
    expect(opened.project.tracks[1]).toMatchObject({ solo: true, pan: -0.6 });
    expect(() => project.moveClip(copy.id, audio.id, 1)).toThrow("Project clip needs a matching track.");
    expect(() => project.setTrackPan(audio.id, 2)).toThrow();
    expect(() =>
      project.setMarkers([
        { time: 1, name: "A" },
        { time: 1, name: "B" },
      ]),
    ).toThrow("Project markers need unique non-negative times and names.");
    opened.project.destroy();
    project.destroy();
  });
});
