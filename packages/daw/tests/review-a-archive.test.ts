import { expect, test } from "vitest";
import { unzipSync, strToU8 } from "fflate";
import { Project, openDawProject, openDawProjectBlob, saveDawProject } from "../src";
import { buildZip, type Zip64Mode } from "./helpers/review-a-zip";

const filesOf = (project: Project) => Object.entries(unzipSync(saveDawProject(project))).map(([name, data]) => ({ name, data }));

test("an archive whose entry inflates past the size its directory declares stops at that size on both open paths", async () => {
  const bomb = buildZip([
    ...filesOf(new Project()).filter(({ name }) => name !== "project.xml"),
    // States 100 bytes, holds 6 MB of zeros that expand from a few kilobytes.
    { name: "project.xml", data: new Uint8Array(6 * 1024 * 1024), declaredSize: 100 },
  ]);
  expect(bomb.length).toBeLessThan(64 * 1024);
  expect(() => openDawProject(bomb)).toThrow("Project archive entry is larger than its directory declares: project.xml.");
  await expect(openDawProjectBlob(new Blob([bomb as Uint8Array<ArrayBuffer>]))).rejects.toThrow(
    "Project archive entry is larger than its directory declares: project.xml.",
  );
});

test("an archive that declares more than the unpacked limit is refused before any entry inflates", () => {
  const big = buildZip([{ name: "project.xml", data: new Uint8Array(10), declaredSize: 200 * 1024 * 1024 }]);
  expect(() => openDawProject(big)).toThrow("Project archive is too large.");
});

test("an entry that is shorter than its directory declares is corrupt", () => {
  const files = filesOf(new Project()).map((file) => (file.name === "metadata.xml" ? { ...file, declaredSize: file.data.length + 1 } : file));
  expect(() => openDawProject(buildZip(files))).toThrow("Project archive entry is corrupt: metadata.xml.");
});

for (const mode of ["none", "directory", "full"] as Zip64Mode[])
  for (const method of [8, 0] as const)
    test(`a ${mode === "none" ? "plain" : `zip64 (${mode})`} archive with ${method === 8 ? "deflated" : "stored"} entries opens on both paths`, async () => {
      const project = new Project({ title: "Zip64 round trip" });
      const files = filesOf(project).map((file) => ({ ...file, method }));
      const bytes = buildZip(files, mode);
      const bytesOpened = openDawProject(bytes);
      expect(bytesOpened.project.title).toBe("Zip64 round trip");
      bytesOpened.project.dispose();
      const blobOpened = await openDawProjectBlob(new Blob([bytes as Uint8Array<ArrayBuffer>]));
      expect(blobOpened.project.title).toBe("Zip64 round trip");
      blobOpened.project.dispose();
    });

test("a zip64 archive with a missing zip64 record or extra field is incomplete or corrupt", () => {
  const files = filesOf(new Project());
  const bytes = buildZip(files, "directory");
  // Break the locator signature.
  const noLocator = bytes.slice();
  const at = noLocator.length - 22 - 20;
  noLocator[at] ^= 1;
  expect(() => openDawProject(noLocator)).toThrow("Project archive is incomplete or corrupt.");
  // The directory entry says 0xFFFFFFFF but its extra field is gone: rename the extra id.
  const noExtra = bytes.slice();
  const text = new TextDecoder("latin1").decode(noExtra);
  const first = text.indexOf("PK\x01\x02");
  noExtra[first + 46 + strToU8(files[0].name).length] = 9;
  expect(() => openDawProject(noExtra)).toThrow("Project archive is incomplete or corrupt.");
});
