// Test helper: a throwaway package with hand-written declarations, so the declaration checks run without a build.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** `files` maps a path under `dist/` to its text; `exports` maps an entry to its `dist/` file. Returns the package directory. */
export function fixturePackage(exports, files) {
  const dir = mkdtempSync(join(tmpdir(), "ar-fixture-"));
  const map = Object.fromEntries(Object.entries(exports).map(([entry, file]) => [entry, `./dist/${file}`]));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fixture", exports: map }));
  for (const [path, text] of Object.entries(files)) {
    const full = join(dir, "dist", path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, text);
  }
  return dir;
}
