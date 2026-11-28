/** Manual interoperability probe against a public Cubase 14 DAWproject export: it opens, keeps what the model has no field for, and takes an edit. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { unzipSync } from "fflate";
import { openDawProject, openDawProjectBlob, saveDawProject } from "../dist/index.js";

const url = "https://forums.steinberg.net/uploads/short-url/9BDdFVxCrHTVqDOozXOnXsSLs5b.zip";
let bytes;
if (process.argv[2]) {
  bytes = new Uint8Array(await readFile(process.argv[2]));
} else {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Cubase fixture download failed: HTTP ${response.status}`);
  const outer = unzipSync(new Uint8Array(await response.arrayBuffer()));
  bytes = outer["test.dawproject"];
}
assert.ok(bytes, "Public forum ZIP needs test.dawproject");
const sha256 = createHash("sha256").update(bytes).digest("hex");
assert.equal(sha256, "b45bdefe6101b58db1aad86757801d816350c9b6c0eb7b9ff5a9f55edea25708", "Source fixture changed");
const warnings = (result) => result.warnings.join("\n");
const bufferOpen = openDawProject(bytes);
const blobOpen = await openDawProjectBlob(new Blob([bytes]));
for (const opened of [bufferOpen, blobOpen]) {
  assert.deepEqual(
    opened.project.tracks.map((track) => track.name),
    ["Instrument Track 01"],
  );
  for (const kept of ["Track without a Channel", "Device Equalizer", "Master channel devices", "Time signature automation"])
    assert.match(warnings(opened), new RegExp(kept));
}
// An edit: a clip on the instrument track. Everything else, including the EQs, the folder Track, the standalone master Channel and the presets, stays.
const { project } = bufferOpen;
project.addMidiClip(project.tracks[0].id, { duration: 4, notes: [{ id: "n", pitch: 60, velocity: 0.8, start: 0, duration: 1 }] }, 0);
const saved = unzipSync(saveDawProject(project));
const xml = new TextDecoder().decode(saved["project.xml"]);
assert.match(xml, /<Application name="Cubase" version="14.0.32"/);
assert.equal((xml.match(/<Equalizer /g) ?? []).length, 2);
assert.match(xml, /<Channel role="master"/);
assert.match(xml, /<Track contentType="tracks"/);
assert.match(xml, /<Clip /);
for (const path of Object.keys(unzipSync(bytes))) assert.ok(saved[path], `${path} is still in the archive`);
console.log("Cubase 14 export: opens from memory and from a Blob, reports what it keeps, takes a new clip and writes back all of its own content.");
