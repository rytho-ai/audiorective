import { afterAll, vi } from "vitest";
import { xsdViolations } from "../helpers/xsd";

// Every archive a node test saves is also validated against the official DAWproject XSDs once the file's tests have run, so each
// existing save test doubles as a schema test. Identical archives are validated once.
const saved = new Map<string, Uint8Array>();
const remember = (bytes: Uint8Array) => {
  const key = `${bytes.length}:${[...bytes.subarray(0, 64), ...bytes.subarray(-64)].join(",")}`;
  if (!saved.has(key)) saved.set(key, bytes.slice());
};

vi.mock("../../src/dawproject", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/dawproject")>();
  return {
    ...original,
    saveDawProject(project: Parameters<typeof original.saveDawProject>[0]) {
      const bytes = original.saveDawProject(project);
      remember(bytes);
      return bytes;
    },
    async saveDawProjectTo(project: Parameters<typeof original.saveDawProjectTo>[0], destination: WritableStream<Uint8Array>) {
      const chunks: Uint8Array[] = [];
      const writer = destination.getWriter();
      const tee = new WritableStream<Uint8Array>({
        write: async (chunk) => {
          chunks.push(chunk.slice());
          await writer.write(chunk);
        },
        close: async () => {
          await writer.close();
        },
      });
      await original.saveDawProjectTo(project, tee);
      const bytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
      let at = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, at);
        at += chunk.length;
      }
      remember(bytes);
    },
  };
});

afterAll(async () => {
  const violations = await xsdViolations(
    [...saved.values()].map((bytes, i) => ({ name: `save${i}`, bytes })),
    { ownOnly: true },
  );
  if (violations.length) throw new Error(`Saved DAWproject XML violates the official schema:\n${violations.slice(0, 20).join("\n")}`);
});
