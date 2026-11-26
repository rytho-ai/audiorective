import { expect, test } from "vitest";
import { unzipSync, zipSync } from "fflate";
import { Project, audioClipSourceDuration, openDawProject, saveDawProject } from "../src";

test("audio clip fades travel in standard XML and clip gain round-trips with Audiorective metadata", async () => {
  const project = new Project();
  const track = project.addTrack("Voice", "audio");
  const original = project.addAudioClip(track.id, { sampleRate: 100, channels: [new Float32Array(100).fill(0.5)] }, 0);
  const settings = { gain: 0.75, fadeIn: 0.2, fadeOut: 0.3 };
  const clip = project.setAudioClipEnvelope(original.id, settings);
  expect(clip.channels).toBe(original.channels);
  expect(() => project.setAudioClipEnvelope(clip.id, { ...settings, fadeIn: 0.9 })).toThrow(/must fit/);
  expect(project.tracks[0].clips[0]).toBe(clip);

  const bytes = await saveDawProject(project);
  const files = unzipSync(bytes);
  // Bitwig reads a fade as beats, so a fresh file writes beats: 0.2 s and 0.3 s at the default 120 BPM.
  expect(new TextDecoder().decode(files["project.xml"])).toContain('fadeTimeUnit="beats" fadeInTime="0.4" fadeOutTime="0.6"');
  const restored = openDawProject(bytes).project;
  expect(restored.tracks[0].clips[0]).toEqual(clip);
  delete files["audiorective/state.json"];
  const portable = openDawProject(zipSync(files)).project.tracks[0].clips[0];
  // Without Audiorective's details the flat standard gain curve still gives the clip its gain.
  expect(portable).toMatchObject({ envelope: { gain: 0.75, fadeIn: 0.2, fadeOut: 0.3 } });
});

test("splitting PCM preserves its backing data and applies existing fades only to retained edges", () => {
  const project = new Project();
  const track = project.addTrack("Clip", "audio");
  const original = project.addAudioClip(track.id, { sampleRate: 100, channels: [new Float32Array(100)] }, 0, {
    envelope: { gain: 0.6, fadeIn: 0.1, fadeOut: 0.3 },
  });
  const [left, right] = project.splitClip(original.id, 0.75);
  if (left.kind !== "audio" || left.media || right.kind !== "audio" || right.media || original.media)
    throw new Error("Expected in-memory audio clips");
  expect(left.channels[0].buffer).toBe(original.channels[0].buffer);
  expect(right.channels[0].buffer).toBe(original.channels[0].buffer);
  expect(left.envelope).toEqual({ gain: 0.6, fadeIn: 0.1, fadeOut: 0 });
  expect(right.envelope).toEqual({ gain: 0.6, fadeIn: 0, fadeOut: 0.25 });
  expect(project.duplicateClip(right.id, 2)).toMatchObject({ envelope: right.envelope });
});

test("clip gain automation retains source coordinates across stretch, trim, move, and archive restore", async () => {
  const project = new Project();
  const track = project.addTrack("Vocal", "audio");
  const audio = { sampleRate: 100, channels: [new Float32Array(200).fill(0.5)] };
  const original = project.addAudioClip(track.id, audio, 0);
  const points = [
    { time: 0, value: 0.25, shape: "linear" },
    { time: 1.5, value: 0.75, shape: "hold" },
  ] as const;
  const edited = project.setAudioClipGainAutomation(original.id, points);
  expect(edited.channels).toBe(original.channels);
  expect(project.setAudioClipGainAutomation(original.id, points)).toBe(edited);
  expect(() => project.setAudioClipGainAutomation(original.id, [...points, points[0]])).toThrow(/unique/);
  expect(project.tracks[0].clips[0]).toBe(edited);
  const stretched = project.applyAudioClipStretch(edited, 2, { ...audio, channels: [new Float32Array(400).fill(0.5)] });
  expect(stretched.gainAutomation).toBe(edited.gainAutomation);
  const [, tail] = project.splitClip(stretched.id, 1);
  if (tail.kind !== "audio") throw new Error("Expected audio");
  expect(audioClipSourceDuration(tail)).toBe(1.5);
  expect(tail.gainAutomation).toEqual({ sourceStart: 0.5, points });
  expect(project.duplicateClip(tail.id, 7)).toMatchObject({ gainAutomation: tail.gainAutomation });

  const bytes = await saveDawProject(project);
  const restored = openDawProject(bytes).project;
  const moved = restored.tracks[0].clips.find((clip) => clip.id === tail.id);
  // The file holds the original audio and its warp, not the render: the clip's place, window, stretch and gain come back; its audio is varispeed.
  expect(moved).toMatchObject({ id: tail.id, time: tail.time, duration: tail.duration, gainAutomation: tail.gainAutomation });
  expect(moved?.kind === "audio" && moved.stretch?.ratio).toBeCloseTo(2, 9);
  expect(moved?.kind === "audio" && moved.stretch?.source).toMatchObject({ sourceOffset: 0.5, sourceLength: 2 });

  const files = unzipSync(bytes);
  const data = JSON.parse(new TextDecoder().decode(files["audiorective/state.json"]));
  data.clips.find((clip: { id: string }) => clip.id === tail.id).gainAutomation.sourceStart = -1;
  files["audiorective/state.json"] = new TextEncoder().encode(JSON.stringify(data));
  const fallback = openDawProject(zipSync(files));
  expect(fallback.warnings).toContain("Invalid Audiorective clip gain automation was skipped.");
  expect(fallback.project.tracks[0].clips.find((clip) => clip.id === tail.id)).not.toHaveProperty("gainAutomation");
});
