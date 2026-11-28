// Fails when the "Exports" list in docs/core.md drifts from packages/core/src/index.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Names inside `export { … }` / `export type { … }` blocks, split into values and types. */
function exportedNames(text) {
  const values = new Set();
  const types = new Set();
  for (const m of text.matchAll(/export\s+(type\s+)?\{([^}]*)\}/g)) {
    const target = m[1] ? types : values;
    for (const raw of m[2].split(",")) {
      const name = raw
        .trim()
        .split(/\s+as\s+/)
        .pop();
      if (name) target.add(name);
    }
  }
  return { values, types };
}

test("docs/core.md Exports list matches packages/core/src/index.ts", () => {
  const src = exportedNames(readFileSync(join(root, "packages/core/src/index.ts"), "utf8"));
  const doc = readFileSync(join(root, "docs/core.md"), "utf8");
  const section = doc.slice(doc.indexOf("## Exports"), doc.indexOf("## Common errors"));
  const block = section.match(/```typescript[^\n]*\n([\s\S]*?)```/)[1];
  const listed = exportedNames(block);
  for (const kind of ["values", "types"]) {
    const missing = [...src[kind]].filter((n) => !listed[kind].has(n));
    const extra = [...listed[kind]].filter((n) => !src[kind].has(n));
    assert.deepEqual({ missing, extra }, { missing: [], extra: [] }, `${kind} in docs/core.md Exports`);
  }
});
