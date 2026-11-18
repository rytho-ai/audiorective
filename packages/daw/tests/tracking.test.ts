import { describe, expect, test } from "vitest";
import { effect } from "@audiorective/core";
import { MidiClip, Project } from "../src";

type Ctx = { project: Project; trackId: string; audioTrackId: string; clip: MidiClip; audioClipId: string };

function fixture(): Ctx {
  const project = new Project({ bpm: 120 });
  const trackId = project.addTrack("Keys", "midi").id;
  const audioTrackId = project.addTrack("Audio", "audio").id;
  const clip = project.addMidiClip(trackId, { duration: 1, notes: [] }, 1);
  const audioClipId = project.addAudioClip(audioTrackId, { sampleRate: 8000, channels: [new Float32Array(800)] }, 0).id;
  return { project, trackId, audioTrackId, clip, audioClipId };
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
  { name: "Project.tempoMap", read: (c) => c.project.tempoMap, mutate: (c) => c.project.setTempoChanges([{ beat: 4, bpm: 60 }]) },
  { name: "Project.markers", read: (c) => c.project.markers, mutate: (c) => c.project.setMarkers([{ time: 1, name: "A" }]) },
  { name: "Project.cells.revision", read: (c) => c.project.cells.revision.value, mutate: (c) => c.project.setTitle("Revised") },
  { name: "MidiClip.time", read: (c) => c.clip.time, mutate: (c) => c.project.moveClip(c.clip.id, c.trackId, 3) },
  { name: "MidiClip.duration", read: (c) => c.clip.duration, mutate: (c) => c.clip.sequence.setData({ duration: 9, notes: [] }) },
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
    ctx.project.destroy();
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
    project.destroy();
  });
});
