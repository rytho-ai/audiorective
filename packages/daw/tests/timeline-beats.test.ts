import { expect, test } from "vitest";
import { unzipSync, zipSync } from "fflate";
import { Project, openDawProject, saveDawProject } from "../src";

const snap = (n: number) => Math.round(n * 1e12) / 1e12;
const xmlOf = (bytes: Uint8Array) => new TextDecoder().decode(unzipSync(bytes)["project.xml"]);
const pcm = (seconds: number) => ({ sampleRate: 1000, channels: [new Float32Array(seconds * 1000).fill(0.25)] });

function tempoProject() {
  const project = new Project({ title: "Tempo", bpm: 100 });
  const track = project.addTrack("Audio", "audio");
  const clip = project.addAudioClip(track.id, pcm(8), 1.25, { envelope: { gain: 0.5, fadeIn: 0.5, fadeOut: 1 } });
  project.setTempoChanges([
    { beat: 0, bpm: 100 },
    { beat: 8, bpm: 140 },
    { beat: 16, bpm: 90 },
  ]);
  project.setMarkers([
    { time: 0, name: "Intro" },
    { time: 9.5, name: "Chorus" },
  ]);
  project.setVolumeAutomation(track.id, [
    { time: 0, value: 1, shape: "linear" },
    { time: 9.5, value: 0.5, shape: "linear" },
  ]);
  return { project, clip, track };
}

test("a fresh file writes the arrangement timeline and fades in beats through the tempo map", () => {
  const { project, clip } = tempoProject();
  const xml = xmlOf(saveDawProject(project));
  const map = project.tempoMap;
  const start = snap(map.secondsToBeat(clip.time));
  const end = snap(map.secondsToBeat(clip.time + clip.duration));
  expect(xml).toContain('<Clips id="track1-clips-beats" timeUnit="beats">'.replace("track1", project.tracks[0].id));
  expect(xml).toContain(`time="${start}" duration="${snap(end - start)}"`);
  expect(xml).toContain('contentTimeUnit="seconds"');
  expect(xml).toContain("<Audio id=");
  expect(xml).toMatch(/<Audio [^>]*timeUnit="seconds"/);
  expect(xml).toContain('<Markers id="projectMarkers" timeUnit="beats">');
  expect(xml).toContain(`<Marker time="${snap(map.secondsToBeat(9.5))}" name="Chorus"/>`);
  expect(xml).toContain('fadeTimeUnit="beats"');
  expect(xml).toContain(`fadeInTime="${snap(map.secondsToBeat(clip.time + 0.5) - start)}"`);
  expect(xml).toContain(`fadeOutTime="${snap(end - map.secondsToBeat(clip.time + clip.duration - 1))}"`);
  expect(xml).not.toContain('fadeTimeUnit="seconds"');
  project.dispose();
});

test("tempo changes round trip: audio clip seconds, fades, markers and automation reopen unchanged to 1e-12 s", () => {
  const { project, clip, track } = tempoProject();
  const reopened = openDawProject(saveDawProject(project)).project;
  const back = reopened.tracks[0].clips[0];
  expect(back.kind).toBe("audio");
  expect(back.time).toBeCloseTo(clip.time, 11);
  expect(back.duration).toBeCloseTo(clip.duration, 11);
  expect(back.kind === "audio" && back.envelope).toMatchObject({ gain: 0.5 });
  expect(back.kind === "audio" && back.envelope?.fadeIn).toBeCloseTo(0.5, 11);
  expect(back.kind === "audio" && back.envelope?.fadeOut).toBeCloseTo(1, 11);
  expect(reopened.markers.map((marker) => marker.name)).toEqual(["Intro", "Chorus"]);
  expect(reopened.markers[1].time).toBeCloseTo(9.5, 11);
  expect(reopened.tracks[0].volumeAutomation[1].time).toBeCloseTo(9.5, 11);
  expect(reopened.tempoMap.changes).toEqual(project.tempoMap.changes);
  void track;
  project.dispose();
  reopened.dispose();
});

test("a fade in beats that spans a tempo change reads as the seconds the tempo map gives it", () => {
  const { project, clip } = tempoProject();
  const bytes = saveDawProject(project);
  const files = unzipSync(bytes);
  // Clip starts at 1.25 s (beat 2.083); a 10-beat fade-in runs past the 8-beat tempo change, so it lasts less than 10 beats at 100 BPM.
  files["project.xml"] = new TextEncoder().encode(xmlOf(bytes).replace(/fadeInTime="[^"]*"/, 'fadeInTime="10"'));
  const reopened = openDawProject(zipSync(files)).project;
  const map = project.tempoMap;
  const start = map.secondsToBeat(clip.time);
  const fade = (reopened.tracks[0].clips[0] as typeof clip).envelope!.fadeIn!;
  expect(fade).toBeCloseTo(map.beatToSeconds(start + 10) - clip.time, 11);
  expect(fade).toBeLessThan(6);
  project.dispose();
  reopened.dispose();
});

test("clip gain and its curve are also written as a standard gain curve, and Audiorective's details stay the authority", () => {
  const project = new Project();
  const track = project.addTrack("Voice", "audio");
  const flat = project.addAudioClip(track.id, pcm(2), 0, { envelope: { gain: 0.5, fadeIn: 0, fadeOut: 0 } });
  const curved = project.addAudioClip(track.id, pcm(2), 4);
  project.setAudioClipGainAutomation(curved.id, [
    { time: 0, value: 0.2, shape: "linear" },
    { time: 1, value: 1, shape: "linear" },
  ]);
  project.setAudioClipEnvelope(curved.id, { gain: 0.5, fadeIn: 0, fadeOut: 0 });
  const bytes = saveDawProject(project);
  const xml = xmlOf(bytes);
  expect(xml).toContain(`<Lanes id="${flat.id}-content" timeUnit="seconds"><Audio id="${flat.id}-audio"`);
  expect(xml).toContain('<Target expression="gain"/><RealPoint time="0" value="0.5" interpolation="linear"/><RealPoint time="2" value="0.5"');
  // Each value of a curve is scaled by the clip gain: 0.2 x 0.5 and 1 x 0.5.
  expect(xml).toContain('<RealPoint time="0" value="0.1" interpolation="linear"/><RealPoint time="1" value="0.5" interpolation="linear"/>');
  const reopened = openDawProject(bytes);
  expect(reopened.warnings).toEqual([]);
  const [back, backCurved] = reopened.project.tracks[0].clips;
  expect(back.kind === "audio" && back.envelope?.gain).toBe(0.5);
  expect(backCurved.kind === "audio" && backCurved.gainAutomation?.points).toEqual([
    { time: 0, value: 0.2, shape: "linear" },
    { time: 1, value: 1, shape: "linear" },
  ]);
  // Without Audiorective's details a flat curve is the clip's gain and a moving one is the clip's gain automation.
  const files = unzipSync(bytes);
  delete files["audiorective/state.json"];
  const foreign = openDawProject(zipSync(files));
  expect(foreign.project.tracks[0].clips).toHaveLength(2);
  const [flatBack, curvedBack] = foreign.project.tracks[0].clips;
  expect(flatBack.kind === "audio" && flatBack.envelope?.gain).toBe(0.5);
  // The standard curve carries the clip gain in its values: 0.2 x 0.5 and 1 x 0.5.
  expect(curvedBack.kind === "audio" && curvedBack.gainAutomation?.points).toEqual([
    { time: 0, value: 0.1, shape: "linear" },
    { time: 1, value: 0.5, shape: "linear" },
  ]);
  expect(foreign.warnings.join()).not.toContain("gain curve");
  project.dispose();
  reopened.project.dispose();
  foreign.project.dispose();
});
