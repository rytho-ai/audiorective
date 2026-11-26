// Rule A3: each exported name comes from exactly one public entry of its package.
// An agent that sees `X` in two entries cannot tell which one to import; the second entry is a re-export to remove.
// A deliberate re-export (the `daw` root re-exporting its sub-entries) is listed in scripts/check-single-entry.allow.json
// with a reason: `{ "package": "daw", "from": ".", "reason": "…" }` allows every name the entry `from` exports that another
// entry of the package also exports; `{ "package": "x", "name": "Y", "reason": "…" }` allows one name in any entries.
//
// Requires built output: run `pnpm build` first.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { IN_SCOPE, loadPackage, root } from "./lib/entries.mjs";

/** Names exported by more than one entry of a package: `[{ name, entries: [".", "./web"] }]`, sorted by name. */
export function duplicateExports(pkgDir) {
  const { exports } = loadPackage(pkgDir);
  const byName = new Map();
  for (const { entry, name } of exports) {
    if (!byName.has(name)) byName.set(name, new Set());
    byName.get(name).add(entry);
  }
  return [...byName]
    .filter(([, entries]) => entries.size > 1)
    .map(([name, entries]) => ({ name, entries: [...entries].sort() }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** A duplicate is allowed when an allow entry names it, or when one of its entries is an allowed re-exporting entry (`from`). */
export function isAllowed(pkg, dup, allow) {
  return allow.some(
    (a) => a.package === pkg && ((a.name !== undefined && a.name === dup.name) || (a.from !== undefined && dup.entries.includes(a.from))),
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const allowFile = join(root, "scripts/check-single-entry.allow.json");
  const allow = existsSync(allowFile) ? JSON.parse(readFileSync(allowFile, "utf8")) : [];
  const used = new Set();
  let failures = 0;
  let checked = 0;
  for (const pkg of IN_SCOPE) {
    const dir = join(root, "packages", pkg);
    if (!existsSync(join(dir, "dist"))) continue;
    checked++;
    for (const dup of duplicateExports(dir)) {
      const idx = allow.findIndex(
        (a) => a.package === pkg && ((a.name !== undefined && a.name === dup.name) || (a.from !== undefined && dup.entries.includes(a.from))),
      );
      if (idx >= 0) used.add(idx);
      else {
        console.error(
          `packages/${pkg}: \`${dup.name}\` is exported from ${dup.entries.map((e) => `"${pkg}${e.slice(1)}"`).join(" and ")}; keep one entry`,
        );
        failures++;
      }
    }
  }
  if (checked === 0) {
    console.error("check:single-entry: no built packages found. Run `pnpm build` first.");
    process.exit(1);
  }
  allow.forEach((a, i) => {
    if (!used.has(i)) {
      console.error(`check:single-entry: allow-list entry ${JSON.stringify(a)} matches nothing; remove it`);
      failures++;
    }
  });
  if (failures > 0) {
    console.error(`check:single-entry: ${failures} problem(s).`);
    process.exit(1);
  }
  console.log(`check:single-entry: ${checked} package(s), each name from one entry (${allow.length} allowed re-export rule(s)).`);
}
