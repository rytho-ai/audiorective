import { describe, expect, test } from "vitest";
import { Project, openDawProject, openDawProjectBlob, saveDawProject } from "../src";

/** Bytes that do not compress, so the archive entry really is this large. */
function noise(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  let seed = 0x9e3779b9;
  for (let at = 0; at < length; at++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    bytes[at] = seed >>> 24;
  }
  return bytes;
}

describe("a plug-in state larger than 8 MiB", () => {
  test("opens from bytes and from a Blob with the same state", async () => {
    const project = new Project({ bpm: 120 });
    const track = project.addTrack("Sampler", "midi");
    const state = noise(9 * 1024 * 1024);
    const device = project.addDevice(track.id, {
      kind: "webclap",
      pluginId: "com.example.sampler",
      name: "Sampler",
      vendor: "v",
      version: "1",
      bundleUrl: "/sampler.wclap",
      state,
    });
    const saved = saveDawProject(project);
    const fromBytes = openDawProject(saved);
    const fromBlob = await openDawProjectBlob(new Blob([saved as Uint8Array<ArrayBuffer>]));
    for (const opened of [fromBytes, fromBlob]) {
      expect(opened.warnings).toEqual([]);
      const read = opened.project.tracks[0].devices.find((item) => item.id === device.id)!;
      expect(read.state.length).toBe(state.length);
      expect(Buffer.compare(Buffer.from(read.state), Buffer.from(state))).toBe(0);
      opened.project.dispose();
    }
    project.dispose();
  }, 60_000);
});
