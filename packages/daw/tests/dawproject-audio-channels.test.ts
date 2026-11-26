/**
 * The `audioChannels` row of docs/dawproject-support.md: written from the track's first audio clip (mono 1, stereo 2; 2 for MIDI tracks and the master),
 * ignored on read (the clip's own channel count is what plays), so a foreign value never changes the audio.
 */
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { describe, expect, test } from "vitest";
import { Project, openDawProject, saveDawProject } from "../src";
import type { PcmAudioClip } from "../src";

const RATE = 48_000;
const frames = (seed: number) => Float32Array.from({ length: 480 }, (_, i) => Math.sin(i * seed) * 0.5);
const projectXml = (bytes: Uint8Array) => strFromU8(unzipSync(bytes)["project.xml"]!);
const channelOf = (xml: string, trackName: string) => {
  const track = new RegExp(`<Track [^>]*name="${trackName}"[^>]*>[\\s\\S]*?<Channel [^>]*>`).exec(xml)?.[0];
  return /audioChannels="(\d+)"/.exec(track?.slice(track.lastIndexOf("<Channel")) ?? "")?.[1];
};

function build() {
  const project = new Project({ bpm: 120 });
  const mono = project.addTrack("Mono", "audio");
  const stereo = project.addTrack("Stereo", "audio");
  const keys = project.addTrack("Keys", "midi");
  project.addAudioClip(mono.id, { sampleRate: RATE, channels: [frames(0.1)] }, 0);
  project.addAudioClip(stereo.id, { sampleRate: RATE, channels: [frames(0.2), frames(0.3)] }, 0);
  project.addMidiClip(keys.id, { notes: [{ pitch: 60, velocity: 1, start: 0, duration: 1 }], duration: 4 }, 0);
  return project;
}

describe("audioChannels", () => {
  test("is written from the first audio clip: 1 for mono, 2 for stereo, MIDI tracks and the master", () => {
    const xml = projectXml(saveDawProject(build()));
    expect(channelOf(xml, "Mono")).toBe("1");
    expect(channelOf(xml, "Stereo")).toBe("2");
    expect(channelOf(xml, "Keys")).toBe("2");
    expect(xml).toMatch(/<Channel [^>]*role="master"[^>]*audioChannels="2"|<Channel [^>]*audioChannels="2"[^>]*role="master"/);
  });

  test("a foreign value is ignored on read: the clips keep their own channel count, and saving writes the clip's count again", () => {
    const entries = unzipSync(saveDawProject(build()));
    const xml = strFromU8(entries["project.xml"]!).replace(/audioChannels="\d+"/g, 'audioChannels="6"');
    expect(xml).toContain('audioChannels="6"');
    const forced = zipSync({ ...entries, "project.xml": strToU8(xml) });
    const opened = openDawProject(forced);
    const clipOf = (name: string) => opened.project.tracks.find((track) => track.name === name)!.clips[0] as PcmAudioClip;
    expect(clipOf("Mono").channels).toHaveLength(1);
    expect(clipOf("Stereo").channels).toHaveLength(2);
    const again = projectXml(saveDawProject(opened.project));
    expect(channelOf(again, "Mono")).toBe("1");
    expect(channelOf(again, "Stereo")).toBe("2");
    opened.project.dispose();
  });
});
