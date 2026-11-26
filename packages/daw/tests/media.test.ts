import { describe, expect, test } from "vitest";
import { unzipSync, zipSync } from "fflate";
import { AudioMedia, AudioMediaWriter, Project, openDawProject, openDawProjectBlob, saveDawProject, saveDawProjectTo } from "../src";

function memoryStorage() {
  const chunks: Uint8Array[] = [];
  return {
    chunks,
    write: async (bytes: Uint8Array) => {
      chunks.push(new Uint8Array(bytes));
    },
    finish: async () => new Blob(chunks as BlobPart[]),
    abort: async () => {
      chunks.length = 0;
    },
  };
}

async function archive(project: Project): Promise<Blob> {
  const chunks: Uint8Array[] = [];
  await saveDawProjectTo(
    project,
    new WritableStream({
      write: (chunk) => {
        chunks.push(new Uint8Array(chunk));
      },
    }),
  );
  return new Blob(chunks as BlobPart[]);
}

describe("file-backed audio", () => {
  test("project snapshot isolates editable PCM, MIDI and device state", () => {
    const project = new Project();
    const audio = project.addTrack("Audio", "audio");
    const midi = project.addTrack("MIDI", "midi");
    const source = new Float32Array([0.25, 0.5]);
    project.addAudioClip(audio.id, { sampleRate: 4, channels: [source] }, 0);
    const clip = project.addMidiClip(
      midi.id,
      {
        duration: 1,
        notes: [{ id: "note1", start: 0, duration: 1, pitch: 60, velocity: 0.8, channel: 0 }],
      },
      0,
    );
    const device = project.addWebClapDevice(midi.id, {
      pluginId: "example.synth",
      name: "Synth",
      vendor: "Example",
      version: "1",
      bundleUrl: "/synth.wclap",
      state: new Uint8Array([3]),
    });
    const copy = project.snapshot();
    const originalAudio = project.tracks[0].clips[0];
    if (originalAudio.kind !== "audio" || !originalAudio.channels) throw new Error("Expected audio clip");
    originalAudio.channels[0][0] = 0;
    clip.midi.setNotes([]);
    project.setDeviceState(device.id, new Uint8Array([9]));
    const copiedAudio = copy.tracks[0].clips[0];
    const copiedMidi = copy.tracks[1].clips[0];
    if (copiedAudio.kind !== "audio" || copiedMidi.kind !== "midi" || !copiedAudio.channels) throw new Error("Expected copied clips");
    expect(copiedAudio.channels[0][0]).toBe(0.25);
    expect(copiedMidi.midi.notes.value).toHaveLength(1);
    expect([...copy.tracks[1].devices[0].state]).toEqual([3]);
    project.dispose();
    expect(copiedMidi.midi.notes.value).toHaveLength(1);
    copy.dispose();
  });

  test("recorder chunks become a borrowed asset and edits retain frame windows", async () => {
    const storage = memoryStorage();
    const writer = new AudioMediaWriter(4, 2, storage);
    await writer.writeChunk({ startFrame: 10, channels: [new Float32Array([0.25, -0.5]), new Float32Array([0.75, 1])] });
    await writer.writeChunk({ startFrame: 12, channels: [new Float32Array([0.5, 0.25]), new Float32Array([-0.25, -0.75])] });
    const media = await writer.finish({ sampleRate: 4, channelCount: 2, startFrame: 10, endFrame: 14, startTime: 2.5, endTime: 3.5 });
    expect(media.frameCount).toBe(4);
    expect([...(await media.readFrames(1, 2))[0]]).toEqual([-0.5, 0.5]);
    expect([...(await media.peaks()).max]).toEqual([0.75, 1, 0.5, 0.25]);
    const project = new Project();
    const track = project.addTrack("Take", "audio");
    const clip = project.addAudioMediaClip(track.id, media, 2);
    const [left, right] = project.splitClip(clip.id, 0.5);
    if (left.kind !== "audio" || right.kind !== "audio" || !left.media || !right.media) throw new Error("Expected media clips");
    expect([left.startFrame, left.frameCount, right.startFrame, right.frameCount]).toEqual([0, 2, 2, 2]);
    const copy = project.duplicateClip(right.id, 5);
    expect(copy.kind === "audio" && copy.media === media).toBe(true);
    const trimmed = project.resizeClip(right.id, { start: right.time + 0.25, end: right.time + 0.5 });
    expect(trimmed.kind === "audio" && trimmed.media && [trimmed.startFrame, trimmed.frameCount]).toEqual([3, 1]);
    project.dispose();
  });

  test("streams a portable WAV archive and reopens file-backed audio", async () => {
    const storage = memoryStorage();
    const writer = new AudioMediaWriter(4, 1, storage);
    await writer.writeChunk({ startFrame: 0, channels: [new Float32Array([0.1, 0.2, 0.3, 0.4])] });
    const media = await writer.finish({ sampleRate: 4, channelCount: 1, startFrame: 0, endFrame: 4, startTime: 0, endTime: 1 });
    const project = new Project();
    const track = project.addTrack("Mic", "audio");
    const clip = project.addAudioMediaClip(track.id, media, 2);
    project.resizeClip(clip.id, { start: clip.time + 0.25, end: clip.time + 0.75 });
    const blob = await archive(project);
    const archiveBytes = new Uint8Array(await blob.arrayBuffer());
    const view = new DataView(archiveBytes.buffer);
    let at = 0;
    let localHeaders = 0;
    while (view.getUint32(at, true) === 0x04034b50) {
      expect(view.getUint16(at + 6, true) & 8).toBe(0); // no data descriptor
      expect(view.getUint32(at + 14, true)).not.toBe(0); // local CRC for conservative DAW readers
      at += 30 + view.getUint16(at + 26, true) + view.getUint16(at + 28, true) + view.getUint32(at + 18, true);
      localHeaders++;
    }
    expect(localHeaders).toBe(4);
    const entries = unzipSync(archiveBytes);
    expect(entries[`audio/${clip.id}.wav`].length).toBe(60); // the whole recording, not the trimmed window
    const opened = await openDawProjectBlob(blob);
    const result = opened.project.tracks[0].clips[0];
    if (result.kind !== "audio" || !result.media) throw new Error("Expected reopened media clip");
    expect(result.time).toBe(2.25);
    expect(result.duration).toBe(0.5);
    expect([result.sourceOffset, result.sourceLength]).toEqual([0.25, 1]);
    expect((await result.media.readFrames(result.startFrame, 2))[0]).toEqual(new Float32Array([0.2, 0.3]));
    const bytes = new Uint8Array(await blob.arrayBuffer());
    expect(() => openDawProject(bytes)).not.toThrow();
    opened.project.dispose();
    project.dispose();
  });

  test("rejects missing frames and non-empty unsupported metadata", async () => {
    const writer = new AudioMediaWriter(4, 1, memoryStorage());
    await writer.writeChunk({ startFrame: 0, channels: [new Float32Array([1])] });
    expect(() => writer.writeChunk({ startFrame: 2, channels: [new Float32Array([1])] })).toThrow("lost captured frames");
    await writer.abort();
    const project = new Project();
    const files = unzipSync(new Uint8Array(await archive(project).then((blob) => blob.arrayBuffer())));
    files["metadata.xml"] = new TextEncoder().encode("<MetaData><Title/><Artist/><Album/></MetaData>");
    const emptyFields = openDawProject(zipSync(files));
    expect(emptyFields.project.title).toBe("Untitled");
    emptyFields.project.dispose();
    files["metadata.xml"] = new TextEncoder().encode("<MetaData><Title/><Artist>Someone</Artist></MetaData>");
    // Metadata the model has no field for is kept in the file and listed in the warnings, not rejected.
    const kept = openDawProject(zipSync(files));
    expect(kept.warnings.join()).toContain("MetaData/Artist");
    expect(new TextDecoder().decode(unzipSync(saveDawProject(kept.project))["metadata.xml"])).toContain("<Artist>Someone</Artist>");
    kept.project.dispose();
    project.dispose();
  });

  test("propagates a failed archive destination", async () => {
    const project = new Project();
    const stream = new WritableStream<Uint8Array>({
      write: () => {
        throw new Error("disk full");
      },
    });
    await expect(saveDawProjectTo(project, stream)).rejects.toThrow("disk full");
    project.dispose();
  });

  test("rejects non-finite PCM before writing or playback", async () => {
    const writer = new AudioMediaWriter(4, 1, memoryStorage());
    expect(() => writer.writeChunk({ startFrame: 0, channels: [new Float32Array([Number.NaN])] })).toThrow("finite PCM samples");
    await writer.abort();
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setFloat32(0, Number.POSITIVE_INFINITY, true);
    const media = new AudioMedia(new Blob([bytes]), 4, 1, 1);
    await expect(media.readFrames(0, 1)).rejects.toThrow("non-finite PCM samples");
  });
});
