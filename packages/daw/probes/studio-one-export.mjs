/**
 * Manual interoperability probe against a public PreSonus Studio One 7.0.2 DAWproject export ("Get Some Air", the Studio One Pro 7 demo song):
 * it opens from memory and from a Blob, prints what it reads and what it keeps, and checks that a save with no edit writes the same project.xml tree.
 * The file is 27.7 MB and is not stored in the repository: it is downloaded, or read from the path given as the first argument.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { DOMParser } from "@xmldom/xmldom";
import { strFromU8, unzipSync } from "fflate";
import { openDawProject, openDawProjectBlob, saveDawProject } from "../dist/index.js";

const url = "https://raw.githubusercontent.com/zarfld/dawproject_c/master/05-implementation/tests/data/fixtures/valid/multi-track.dawproject";
let bytes;
if (process.argv[2]) bytes = new Uint8Array(await readFile(process.argv[2]));
else {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Studio One fixture download failed: HTTP ${response.status}`);
  bytes = new Uint8Array(await response.arrayBuffer());
}
const sha256 = createHash("sha256").update(bytes).digest("hex");
assert.equal(sha256, "d8828597df45c590faa1c73dbfc02cf2aaffc43b924044e73c6a42e0e58675de", "Source fixture changed");

const tree = (element) => ({
  tag: element.tagName,
  attrs: Object.fromEntries(
    Array.from({ length: element.attributes.length }, (_, i) => [element.attributes.item(i).name, element.attributes.item(i).value]),
  ),
  children: Array.from(element.childNodes)
    .filter((node) => node.nodeType === 1)
    .map(tree),
});
const projectTree = (archive) =>
  tree(new DOMParser().parseFromString(strFromU8(unzipSync(archive)["project.xml"]).replace(/^﻿/, ""), "application/xml").documentElement);

const buffer = openDawProject(bytes);
const blob = await openDawProjectBlob(new Blob([bytes]));
for (const opened of [buffer, blob]) {
  assert.equal(opened.project.tracks.length, buffer.project.tracks.length);
  assert.match(opened.warnings.join("\n"), /DAWproject version "0\.1"/);
  assert.match(opened.warnings.join("\n"), /Notes without a channel attribute/);
}
const { project, warnings } = buffer;
const count = (kind) => project.tracks.flatMap((track) => track.clips).filter((clip) => clip.kind === kind).length;
assert.ok(count("audio") > 0, "the Ogg audio of the export is read as audio clips");
console.log(
  `Studio One 7.0.2 export: ${project.tracks.length} tracks, ${count("midi")} MIDI clips, ${count("audio")} audio clips, ${project.tracks.reduce((n, t) => n + (t.kind === "midi" ? t.clips.reduce((m, c) => m + c.midi.notes.value.length, 0) : 0), 0)} notes read.`,
);
console.log(`${warnings.length} warnings:`);
for (const warning of warnings) console.log(`  - ${warning}`);
assert.deepEqual(projectTree(saveDawProject(project)), projectTree(bytes), "a save with no edit changes project.xml");
console.log("An unchanged save leaves project.xml the same tree.");

// The same file in a browser Workspace: the browser decodes the Ogg audio (tests/studio-one-workspace.browser.test.ts, run by vitest).
if (process.argv[2]) {
  const run = spawnSync("pnpm", ["exec", "vitest", "run", "--project", "browser", "tests/studio-one-workspace.browser.test.ts", "--reporter=dot"], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: { ...process.env, VITE_STUDIO_ONE_FILE: process.argv[2], NO_COLOR: "1", FORCE_COLOR: "0" },
    encoding: "utf8",
  });
  const text = `${run.stdout}${run.stderr}`;
  const lines = text
    .split("\n")
    .filter((line) => !/^stdout \|/.test(line) && /Studio One export in a browser|warnings;|^\s+- |save leaves|Tests |FAIL|Error/.test(line));
  console.log(lines.join("\n"));
  assert.equal(run.status, 0, "the browser Workspace stage failed");
} else console.log("Pass the downloaded file's path as the first argument to also open it in a browser Workspace.");
