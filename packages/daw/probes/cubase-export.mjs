/** Manual interoperability probe against a public Cubase 14 DAWproject export. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { unzipSync } from "fflate";
import { openDawProject, openDawProjectBlob } from "../dist/index.js";

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
assert.throws(() => openDawProject(bytes), /Project XML has unsupported Structure content/);
await assert.rejects(openDawProjectBlob(new Blob([bytes])), /Project XML has unsupported Structure content/);
console.log("Cubase 14 export: verified genuine fixture hash; both open paths reject unsupported Structure without dropping it.");
