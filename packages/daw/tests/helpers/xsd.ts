import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { unzipSync } from "fflate";
import { validateXML } from "xmllint-wasm";

const schemaDir = new URL("../fixtures/dawproject/schema/", import.meta.url);
const read = (name: string) => readFileSync(fileURLToPath(new URL(name, schemaDir)), "utf8");
const decoder = new TextDecoder();

/**
 * Validate the `project.xml` and `metadata.xml` of .dawproject archives against the official DAWproject XSDs
 * (https://github.com/bitwig/dawproject, MIT). Returns one message per violation; an empty list means every file is valid.
 * Dev-only: xmllint-wasm is a devDependency of this package.
 */
export async function xsdViolations(
  archives: ReadonlyArray<{ name: string; bytes: Uint8Array }>,
  options: { ownOnly?: boolean } = {},
): Promise<string[]> {
  const projects: Array<{ fileName: string; contents: string }> = [];
  const metadata: Array<{ fileName: string; contents: string }> = [];
  for (const { name, bytes } of archives) {
    const files = unzipSync(bytes, { filter: (file) => file.name === "project.xml" || file.name === "metadata.xml" });
    // Another application's file keeps that application's own XML, schema slips included; sample tests judge it against its source.
    if (options.ownOnly && !/<Application\s[^>]*name="Audiorective"/.test(decoder.decode(files["project.xml"] ?? new Uint8Array()))) continue;
    if (files["project.xml"]) projects.push({ fileName: `${name}!project.xml`, contents: decoder.decode(files["project.xml"]) });
    if (files["metadata.xml"]) metadata.push({ fileName: `${name}!metadata.xml`, contents: decoder.decode(files["metadata.xml"]) });
  }
  return [...(await xsdViolationsOfXml(projects, "Project.xsd")), ...(await xsdViolationsOfXml(metadata, "MetaData.xsd"))];
}

export async function xsdViolationsOfXml(xml: ReadonlyArray<{ fileName: string; contents: string }>, schema: "Project.xsd" | "MetaData.xsd") {
  if (!xml.length) return [];
  const result = await validateXML({
    xml: [...xml],
    schema: [{ fileName: schema, contents: read(schema) }],
    initialMemoryPages: 512,
    maxMemoryPages: 4096,
  });
  return result.valid ? [] : result.errors.map((error) => `${error.loc?.fileName ?? "?"}:${error.loc?.lineNumber ?? "?"} ${error.message}`);
}
