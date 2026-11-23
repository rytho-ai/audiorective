import { describe, expect, test } from "vitest";
import { effect } from "@audiorective/core";
import { AudioMedia, MidiClip, Project, type AudioClip } from "../src";
import * as modelSourceModule from "../src/model.ts?raw";
import { coverageGaps, watch } from "../../../scripts/tracking-coverage.mjs";

const touchedProject = new Set<string>();
const touchedClip = new Set<string>();

type Ctx = {
  project: Project;
  trackId: string;
  audioTrackId: string;
  busId: string;
  deviceId: string;
  clip: MidiClip;
  beatClip: MidiClip;
  audioClipId: string;
};

const media = () => new AudioMedia(new Blob([new Uint8Array(400)]), 100, 1, 100);
const filter = { id: "f", type: "filter", enabled: true, wet: 1, mode: "lowpass", frequency: 800, q: 1 } as const;
const macros = [{ id: "tone", value: 0.4, targets: [{ slotId: "f", parameter: "frequency", min: 200, max: 8000, scale: "exponential" }] }] as const;

function fixture(): Ctx {
  const project = watch(new Project({ bpm: 120 }), touchedProject);
  const trackId = project.addTrack("Keys", "midi").id;
  const audioTrackId = project.addTrack("Audio", "audio").id;
  const clip = watch(project.addMidiClip(trackId, { duration: 1, notes: [] }, 2), touchedClip);
  const beatClip = watch(project.addMidiClip(trackId, { duration: 1, notes: [] }, 8), touchedClip);
  const audioClipId = project.addAudioClip(audioTrackId, { sampleRate: 8000, channels: [new Float32Array(800)] }, 0).id;
  const busId = project.addTrack("Bus", "bus").id;
  const deviceId = project.addWebClapDevice(trackId, { pluginId: "q", name: "Q", vendor: "v", version: "1", bundleUrl: "/q" }).id;
  return { project, trackId, audioTrackId, busId, deviceId, clip, beatClip, audioClipId };
}

/** Each public stateful reader is read inside an effect, changed through the owner's public method, and must re-run with a new value. */
const rows: Array<{ name: string; read: (ctx: Ctx) => unknown; mutate: (ctx: Ctx) => void }> = [
  { name: "Project.title", read: (c) => c.project.title, mutate: (c) => c.project.setTitle("Renamed") },
  { name: "Project.tracks (addTrack)", read: (c) => c.project.tracks, mutate: (c) => void c.project.addTrack("More", "audio") },
  { name: "Project.tracks (setTrackVolume)", read: (c) => c.project.tracks[0].volume, mutate: (c) => c.project.setTrackVolume(c.trackId, 0.2) },
  { name: "Project.tracks (setTrackName)", read: (c) => c.project.tracks[0].name, mutate: (c) => c.project.setTrackName(c.trackId, "Lead") },
  { name: "Project.tracks (setTrackMuted)", read: (c) => c.project.tracks[0].muted, mutate: (c) => c.project.setTrackMuted(c.trackId, true) },
  { name: "Project.tracks (setTrackSolo)", read: (c) => c.project.tracks[0].solo, mutate: (c) => c.project.setTrackSolo(c.trackId, true) },
  { name: "Project.tracks (setTrackPan)", read: (c) => c.project.tracks[0].pan, mutate: (c) => c.project.setTrackPan(c.trackId, 0.5) },
  {
    name: "Project.tracks (setTrackEffects)",
    read: (c) => c.project.tracks[0].effects,
    mutate: (c) => c.project.setTrackEffects(c.trackId, [{ id: "f", type: "filter", enabled: true, wet: 1, mode: "lowpass", frequency: 800, q: 1 }]),
  },
  {
    name: "Project.tracks (setVolumeAutomation)",
    read: (c) => c.project.tracks[0].volumeAutomation,
    mutate: (c) => c.project.setVolumeAutomation(c.trackId, [{ time: 0, value: 1, shape: "linear" }]),
  },
  {
    name: "Project.tracks (addWebClapDevice)",
    read: (c) => c.project.tracks[0].devices,
    mutate: (c) => void c.project.addWebClapDevice(c.trackId, { pluginId: "p", name: "P", vendor: "v", version: "1", bundleUrl: "/p" }),
  },
  { name: "Project.tracks (removeTrack)", read: (c) => c.project.tracks, mutate: (c) => c.project.removeTrack(c.audioTrackId) },
  { name: "Project.tracks (removeClip)", read: (c) => c.project.tracks[1].clips, mutate: (c) => c.project.removeClip(c.audioClipId) },
  { name: "Project.tracks (splitClip)", read: (c) => c.project.tracks[1].clips, mutate: (c) => void c.project.splitClip(c.audioClipId, 0.05) },
  { name: "Project.tracks (trimClip)", read: (c) => c.project.tracks[1].clips, mutate: (c) => void c.project.trimClip(c.audioClipId, 0, 0.05) },
  { name: "Project.tracks (duplicateClip)", read: (c) => c.project.tracks[1].clips, mutate: (c) => void c.project.duplicateClip(c.audioClipId, 1) },
  { name: "Project.masterVolume", read: (c) => c.project.masterVolume, mutate: (c) => c.project.setMasterVolume(0.3) },
  {
    name: "Project.hasFileBackedAudio",
    read: (c) => c.project.hasFileBackedAudio,
    mutate: (c) => void c.project.addAudioMediaClip(c.audioTrackId, media(), 0),
  },
  {
    name: "Project.tracks (addAudioMediaClip)",
    read: (c) => c.project.tracks[1].clips,
    mutate: (c) => void c.project.addAudioMediaClip(c.audioTrackId, media(), 1),
  },
  {
    name: "Project.tracks (addMidiTake)",
    read: (c) => c.project.tracks[0].clips,
    mutate: (c) => void c.project.addMidiTake(c.trackId, { duration: 1, notes: [], startTime: 0, endTime: 1, events: [] }, 2),
  },
  {
    name: "Project.tracks (applyAudioClipStretch)",
    read: (c) => c.project.tracks[1].clips,
    mutate: (c) =>
      void c.project.applyAudioClipStretch(c.project.tracks[1].clips[0] as AudioClip, 2, { sampleRate: 8000, channels: [new Float32Array(1600)] }),
  },
  {
    name: "Project.tracks (setAudioClipEnvelope)",
    read: (c) => c.project.tracks[1].clips,
    mutate: (c) => void c.project.setAudioClipEnvelope(c.audioClipId, { gain: 0.5, fadeIn: 0, fadeOut: 0 }),
  },
  {
    name: "Project.tracks (setAudioClipGainAutomation)",
    read: (c) => c.project.tracks[1].clips,
    mutate: (c) => void c.project.setAudioClipGainAutomation(c.audioClipId, [{ time: 0, value: 0.5, shape: "linear" }]),
  },
  {
    name: "Project.tracks (setTrackRouting)",
    read: (c) => c.project.tracks[0].routing,
    mutate: (c) => c.project.setTrackRouting(c.trackId, { outputBusId: c.busId, sends: [] }),
  },
  {
    name: "Project.tracks (setTrackRackPreset)",
    read: (c) => c.project.tracks[0].effectMacros,
    mutate: (c) => c.project.setTrackRackPreset(c.trackId, { effects: [filter], macros }),
  },
  {
    name: "Project.tracks (setTrackMacroValue)",
    read: (c) => {
      const macro = c.project.tracks[0].effectMacros[0];
      return macro?.value ?? null;
    },
    mutate: (c) => {
      c.project.setTrackRackPreset(c.trackId, { effects: [filter], macros });
      c.project.setTrackMacroValue(c.trackId, "tone", 0.9);
    },
  },
  {
    name: "Project.tracks (setDeviceState)",
    read: (c) => c.project.tracks[0].devices[0].state,
    mutate: (c) => c.project.setDeviceState(c.deviceId, new Uint8Array([1, 2, 3])),
  },
  { name: "Project.tracks (removeDevice)", read: (c) => c.project.tracks[0].devices, mutate: (c) => c.project.removeDevice(c.deviceId) },
  { name: "Project.tempoMap", read: (c) => c.project.tempoMap, mutate: (c) => c.project.setTempoChanges([{ beat: 4, bpm: 60 }]) },
  {
    name: "Project.clipName (setClipName)",
    read: (c) => c.project.clipName(c.audioClipId) ?? null,
    mutate: (c) => c.project.setClipName(c.audioClipId, "Hook"),
  },
  {
    name: "Project.overview (setTrackName)",
    read: (c) => c.project.overview().tracks[0].name,
    mutate: (c) => c.project.setTrackName(c.trackId, "Lead"),
  },
  {
    name: "Project.findMarker (setMarkers)",
    read: (c) => c.project.findMarker({ name: "Hook" })?.time ?? null,
    mutate: (c) => c.project.setMarkers([{ time: 1, name: "Hook" }]),
  },
  {
    name: "Project.findClips (duplicateClip)",
    read: (c) => c.project.findClips({ trackId: c.audioTrackId }).length,
    mutate: (c) => void c.project.duplicateClip(c.audioClipId, 1),
  },
  {
    name: "Project.cells.version (applyEdits)",
    read: (c) => c.project.cells.version.value,
    mutate: (c) =>
      void c.project.applyEdits({
        expectedVersion: c.project.cells.version.value,
        label: "Move",
        ops: [{ type: "moveClip", clip: { clipId: c.audioClipId }, position: { atBeat: 4 } }],
      }),
  },
  {
    name: "Project.cells.history (edit)",
    read: (c) => c.project.cells.history.value,
    mutate: (c) => c.project.edit("Move", () => c.project.moveClip(c.audioClipId, c.audioTrackId, 3)),
  },
  {
    name: "Project.tracks (undo)",
    read: (c) => c.project.tracks[1].clips,
    mutate: (c) => {
      c.project.edit("Move", () => c.project.moveClip(c.audioClipId, c.audioTrackId, 3));
      c.project.undo();
    },
  },
  {
    name: "Project.tracks (redo)",
    read: (c) => c.project.tracks[1].clips,
    mutate: (c) => {
      c.project.edit("Move", () => c.project.moveClip(c.audioClipId, c.audioTrackId, 3));
      c.project.undo();
      c.project.redo();
    },
  },
  {
    name: "Project.cells.history (clearHistory)",
    read: (c) => c.project.cells.history.value,
    mutate: (c) => {
      c.project.edit("Move", () => c.project.moveClip(c.audioClipId, c.audioTrackId, 3));
      c.project.clearHistory();
    },
  },
  {
    name: "Project.tracks (captureDeviceState)",
    read: (c) => c.project.tracks[0].devices[0].state,
    mutate: (c) => c.project.captureDeviceState(c.deviceId, new Uint8Array([4])),
  },
  { name: "Project.markers", read: (c) => c.project.markers, mutate: (c) => c.project.setMarkers([{ time: 1, name: "A" }]) },
  { name: "Project.cells.revision", read: (c) => c.project.cells.revision.value, mutate: (c) => c.project.setTitle("Revised") },
  {
    name: "Project.clipTimeSeconds (tempo change)",
    read: (c) => c.project.clipTimeSeconds(c.beatClip),
    mutate: (c) => c.project.setTempoChanges([{ beat: 1, bpm: 60 }]),
  },
  { name: "MidiClip.time", read: (c) => c.clip.time, mutate: (c) => c.project.moveClip(c.clip.id, c.trackId, 3) },
  {
    name: "Project.cells.content (note edit)",
    read: (c) => c.project.cells.content.value.midi.get(c.clip.id)?.notes,
    mutate: (c) => c.clip.midi.setNotes([{ id: "n", pitch: 60, velocity: 0.5, start: 0, duration: 1 }]),
  },
];

describe("Project and MidiClip public readers are tracked", () => {
  test.each(rows)("$name", ({ read, mutate }) => {
    const ctx = fixture();
    const seen: unknown[] = [];
    const stop = effect(() => void seen.push(read(ctx)));
    const first = seen[0];
    mutate(ctx);
    stop();
    expect(seen.length).toBeGreaterThan(1);
    expect(Object.is(seen[seen.length - 1], first)).toBe(false);
    ctx.project.dispose();
  });

  test("mutators called inside an effect do not subscribe it", () => {
    const { project, trackId, clip } = fixture();
    let runs = 0;
    const stop = effect(() => {
      runs++;
      project.setTitle("Inside");
      project.setTrackVolume(trackId, 0.5);
      project.moveClip(clip.id, trackId, 2);
    });
    expect(runs).toBe(1);
    project.setTitle("Outside");
    stop();
    expect(runs).toBe(1);
    project.dispose();
  });
});

/** Commands read content for their own logic; calling one inside a caller's effect must not subscribe that effect. */
const commands: Array<{ name: string; run: (ctx: Ctx) => unknown }> = [
  { name: "duplicateClip (audio)", run: (c) => c.project.duplicateClip(c.audioClipId, 2) },
  { name: "duplicateClip (midi)", run: (c) => c.project.duplicateClip(c.clip.id, 5) },
  { name: "snapshot", run: (c) => c.project.snapshot().dispose() },
  { name: "trimClip (midi)", run: (c) => c.project.trimClip(c.clip.id, 0, 0.5) },
  { name: "splitClip (midi)", run: (c) => c.project.splitClip(c.clip.id, 0.5) },
  { name: "trimClip (audio)", run: (c) => c.project.trimClip(c.audioClipId, 0, 0.05) },
  { name: "splitClip (audio)", run: (c) => c.project.splitClip(c.audioClipId, 0.05) },
  { name: "MidiClip.playbackEvents", run: (c) => c.clip.playbackEvents() },
];

describe("Project commands do not subscribe a calling effect", () => {
  test.each(commands)("$name", ({ run }) => {
    const ctx = fixture();
    let runs = 0;
    const stop = effect(() => {
      runs++;
      run(ctx);
    });
    expect(runs).toBe(1);
    ctx.project.setTitle("Elsewhere");
    ctx.project.setTempoChanges([{ beat: 4, bpm: 90 }]);
    ctx.project.setMarkers([{ time: 1, name: "M" }]);
    ctx.project.addTrack("Another", "audio");
    for (const clip of [ctx.clip, ctx.beatClip]) {
      try {
        clip.midi.setNotes([]);
      } catch {
        // A command may have replaced and disposed the clip it read.
      }
    }
    stop();
    expect(runs).toBe(1);
    ctx.project.dispose();
  });
});

describe("Project has one store", () => {
  test("a multi-field edit is observed once, after it completes", () => {
    const { project } = fixture();
    const seen: number[] = [];
    const stop = effect(() => void seen.push(project.cells.revision.value));
    seen.length = 0;
    project.setTempoChanges([{ beat: 4, bpm: 60 }]);
    stop();
    expect(seen).toHaveLength(1);
    project.dispose();
  });
});

describe("every public Project and MidiClip member is covered", () => {
  test("Project", () => {
    expect(coverageGaps(Project, modelSourceModule.default, touchedProject, {})).toEqual([]);
  });
  test("MidiClip", () => {
    expect(
      coverageGaps(MidiClip, modelSourceModule.default, touchedClip, {
        events: "immutable copy of the construction-time source events; nothing changes it",
        dispose: "teardown owned by Project (removeClip, removeTrack, dispose); a disposed clip leaves the tracks it was removed from",
      }),
    ).toEqual([]);
  });
});
