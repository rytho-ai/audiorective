import { expect, test } from "vitest";
import { unzipSync, zipSync, strToU8, strFromU8 } from "fflate";
import { Project, openDawProject, openDawProjectBlob, saveDawProject, saveDawProjectTo, MidiClip } from "../src";

const pcm = { sampleRate: 48000, channels: [new Float32Array(480).fill(0.5)] };
async function stored(project: Project) {
  const parts: Uint8Array<ArrayBuffer>[] = [];
  await saveDawProjectTo(
    project,
    new WritableStream({
      write: (bytes) => {
        parts.push(new Uint8Array(bytes));
      },
    }),
  );
  return new Blob(parts);
}

test("both open paths reject CRC corruption and a missing final byte", async () => {
  const project = new Project();
  project.addAudioClip(project.addTrack("Audio", "audio").id, pcm, 0);
  const bytes = new Uint8Array(await (await stored(project)).arrayBuffer());
  const corrupted = bytes.slice();
  const wav = new TextDecoder().decode(corrupted).indexOf("RIFF");
  corrupted[wav + 44 + 100] ^= 1;
  for (const invalid of [corrupted, bytes.slice(0, -1)]) {
    expect(() => openDawProject(invalid)).toThrow(/archive/i);
    await expect(openDawProjectBlob(new Blob([invalid]))).rejects.toThrow(/archive/i);
  }
});

test("both open paths reject a ZIP directory that disagrees with its local records", async () => {
  const bytes = new Uint8Array(await (await stored(new Project())).arrayBuffer());
  const data = new DataView(bytes.buffer);
  const directoryOffset = data.getUint32(bytes.length - 22 + 16, true);
  for (const offset of [14, directoryOffset + 42]) {
    const bad = bytes.slice();
    bad[offset] ^= 1;
    expect(() => openDawProject(bad)).toThrow(/archive/i);
    await expect(openDawProjectBlob(new Blob([bad]))).rejects.toThrow(/archive/i);
  }
});

test("unsupported master state fails to open", () => {
  const files = unzipSync(saveDawProject(new Project()));
  files["project.xml"] = strToU8(
    strFromU8(files["project.xml"]).replace('<Volume id="masterVolume"', '<Mute value="true"/><Volume id="masterVolume"'),
  );
  expect(() => openDawProject(zipSync(files))).toThrow(/unsupported master/i);
});

test("recorded channel messages survive both save paths", async () => {
  const project = new Project();
  const track = project.addTrack("Keys", "midi");
  const events = [
    [0xe0, 0, 80],
    [0xc0, 5],
    [0xd0, 50],
    [0xa0, 60, 50],
  ].map((data, i) => ({
    time: i / 8,
    data: new Uint8Array(data),
  }));
  project.addMidiClip(track.id, { duration: 1, notes: [], events }, 0);
  for (const opened of [openDawProject(saveDawProject(project)), await openDawProjectBlob(await stored(project))]) {
    expect((opened.project.tracks[0].clips[0] as MidiClip).events).toEqual(events);
  }
});

test("audio sidecar follows file identity and reports missing details", () => {
  const project = new Project();
  const track = project.addTrack("Audio", "audio");
  project.addAudioClip(track.id, pcm, 0, { id: "first", envelope: { gain: 0.25, fadeIn: 0, fadeOut: 0 } });
  project.addAudioClip(track.id, pcm, 1, { id: "second" });
  const files = unzipSync(saveDawProject(project));
  const xml = strFromU8(files["project.xml"]);
  const [a, b] = xml.match(/<Clip .*?<\/Clip>/g)!;
  files["project.xml"] = strToU8(xml.replace(a + b, b + a));
  const reordered = openDawProject(zipSync(files));
  expect(reordered.project.tracks[0].clips.map((clip) => clip.id)).toEqual(["first", "second"]);
  expect(reordered.project.tracks[0].clips[0]).toMatchObject({ envelope: { gain: 0.25 } });
  delete files["audiorective/state.json"];
  expect(openDawProject(zipSync(files)).warnings).toEqual(expect.arrayContaining([expect.stringMatching(/audio clip/i)]));
});

test("XML text round-trips and illegal characters fail at input", () => {
  const name = "a&<\uFFFD🎵\r\nb\tc";
  const project = new Project({ title: name });
  project.addTrack(name, "audio");
  const opened = openDawProject(saveDawProject(project)).project;
  expect(opened.title).toBe(name);
  expect(opened.tracks[0].name).toBe(name);
  expect(() => project.setTitle("bad\u0001")).toThrow(/XML/);
  expect(() => project.addTrack("bad\ud800", "audio")).toThrow(/XML/);
});

test("deleted generated IDs are retired across saves and reserved XML IDs fail early", () => {
  const project = new Project();
  const track = project.addTrack("Audio", "audio");
  const { id } = project.addAudioClip(track.id, pcm, 0);
  project.removeClip(id);
  const opened = openDawProject(saveDawProject(project)).project;
  expect(opened.addAudioClip(track.id, pcm, 0).id).not.toBe(id);
  expect(() => opened.addTrack("Reserved", "audio", { id: "masterTrack" })).toThrow(/XML IDs/);
  expect(() => opened.addTrack("Collision", "audio", { id: track.id + "-channel" })).toThrow(/XML IDs/);
});

test("an external MIDI edit cannot allocate the ID of another clip", () => {
  const project = new Project();
  const track = project.addTrack("Keys", "midi");
  const pattern = { duration: 1, notes: [{ id: "note", pitch: 60, velocity: 0.8, channel: 0, start: 0, duration: 0.5 }] };
  project.addMidiClip(track.id, pattern, 0, { id: "edited" });
  project.addMidiClip(track.id, pattern, 2, { id: "clip1" });
  const files = unzipSync(saveDawProject(project));
  files["project.xml"] = strToU8(strFromU8(files["project.xml"]).replace('vel="0.8"', 'vel="0.7"'));
  const opened = openDawProject(zipSync(files)).project;
  expect(opened.tracks[0].clips[1].id).toBe("clip1");
  expect(opened.tracks[0].clips[0].id).not.toBe("clip1");
});

test("disposed projects reject editing and both save paths", async () => {
  const project = new Project();
  project.dispose();
  expect(() => project.setTitle("Closed")).toThrow(/disposed/);
  expect(() => saveDawProject(project)).toThrow(/disposed/);
  await expect(stored(project)).rejects.toThrow(/disposed/);
});
