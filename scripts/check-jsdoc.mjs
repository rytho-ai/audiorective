// Rule A2: every public class member and exported function or const in a shipped declaration has a JSDoc comment.
// A coding agent that reads only `packages/*/dist/**/*.d.ts` learns units, ranges, defaults and edge behaviour from it.
//
// Scope: the in-scope packages (see scripts/lib/entries.mjs). A class needs a comment on itself and on each non-private
// member (constructors excluded: their parameters are described on the class). Interfaces and type aliases are not checked.
// Self-evident members are listed in scripts/check-jsdoc.exemptions.json, one reason per entry.
// A violation that is not exempt fails the check, in any package. `--list` prints every violation.
//
// Requires built output: run `pnpm build` first.
import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { IN_SCOPE, loadPackage, position, root, ts } from "./lib/entries.mjs";

const here = join(root, "scripts");

/** Wildcard (`*`) match of a pattern against a violation key such as `core/Cell.value`. */
export function matchKey(pattern, key) {
  const re = new RegExp(
    "^" +
      pattern
        .split("*")
        .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
        .join(".*") +
      "$",
  );
  return re.test(key);
}

function hasDoc(node) {
  return ts.getJSDocCommentsAndTags(node).some((d) => ts.isJSDoc(d) && (d.comment || d.tags?.length));
}

function isPrivate(member) {
  const mods = ts.canHaveModifiers(member) ? ts.getModifiers(member) : undefined;
  return !!mods?.some((m) => m.kind === ts.SyntaxKind.PrivateKeyword) || (member.name && ts.isPrivateIdentifier(member.name));
}

/** Undocumented public declarations of one package directory: `[{ key, kind, file, line }]`. Overloads and accessor pairs count as documented when any one is. */
export function findUndocumented(pkgDir, pkgName) {
  const { exports } = loadPackage(pkgDir);
  /** key -> { documented, node, kind } */
  const items = new Map();
  const note = (key, kind, node) => {
    const prev = items.get(key);
    const documented = hasDoc(node) || (prev?.documented ?? false);
    if (!prev || (!prev.documented && documented) || !prev.node) items.set(key, { documented, node: prev?.node ?? node, kind });
    else prev.documented = documented;
  };
  const seen = new Set();
  for (const { symbol } of exports) {
    for (const decl of symbol.declarations ?? []) {
      if (seen.has(decl)) continue;
      seen.add(decl);
      // Re-exports of a dependency (`export { effect } from "alien-signals"`) are documented upstream.
      if (decl.getSourceFile().fileName.includes("/node_modules/")) continue;
      if (ts.isClassDeclaration(decl) && decl.name) {
        const owner = decl.name.text;
        note(`${pkgName}/${owner}`, "class", decl);
        for (const m of decl.members) {
          if (ts.isConstructorDeclaration(m) || ts.isIndexSignatureDeclaration(m) || ts.isClassStaticBlockDeclaration?.(m) || isPrivate(m)) continue;
          if (!m.name) continue;
          const name = ts.isComputedPropertyName(m.name) ? m.name.expression.getText() : m.name.getText();
          note(`${pkgName}/${owner}.${name}`, "member", m);
        }
      } else if (ts.isFunctionDeclaration(decl) && decl.name) {
        note(`${pkgName}/${decl.name.text}`, "function", decl);
      } else if (ts.isVariableDeclaration(decl) && ts.isIdentifier(decl.name)) {
        // The comment sits on the statement; fall back to the declaration itself.
        const stmt = decl.parent?.parent;
        note(`${pkgName}/${decl.name.text}`, "const", stmt && ts.isVariableStatement(stmt) ? stmt : decl);
      }
    }
  }
  const out = [];
  for (const [key, { documented, node, kind }] of items) {
    if (documented) continue;
    out.push({ key, kind, ...position(node) });
  }
  return out;
}

/** Split violations into those that fail and those tolerated by exemptions. */
export function classify(violations, exemptions) {
  const failing = [];
  const exempted = [];
  const usedExemptions = new Set();
  for (const v of violations) {
    const ex = exemptions.findIndex((e) => matchKey(e.pattern, v.key));
    if (ex >= 0) {
      usedExemptions.add(ex);
      exempted.push(v);
    } else failing.push(v);
  }
  const unusedExemptions = exemptions.filter((_, i) => !usedExemptions.has(i));
  return { failing, exempted, unusedExemptions };
}

function readJson(file, fallback) {
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : fallback;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const all = [];
  for (const pkg of IN_SCOPE) {
    const dir = join(root, "packages", pkg);
    if (!existsSync(join(dir, "dist"))) continue;
    all.push(...findUndocumented(dir, pkg));
  }
  if (all.length === 0 && !existsSync(join(root, "packages/core/dist"))) {
    console.error("check:jsdoc: no built declarations found. Run `pnpm build` first.");
    process.exit(1);
  }
  const exemptions = readJson(join(here, "check-jsdoc.exemptions.json"), []);
  if (process.argv.includes("--list")) {
    for (const v of all) console.log(`${relative(root, v.file)}:${v.line}\t${v.key}`);
    process.exit(0);
  }
  const { failing, exempted, unusedExemptions } = classify(all, exemptions);
  for (const v of failing) console.error(`${relative(root, v.file)}:${v.line}: ${v.kind} \`${v.key}\` has no JSDoc comment`);
  for (const e of unusedExemptions) console.error(`check:jsdoc: exemption \`${e.pattern}\` matches nothing; remove it`);
  if (failing.length || unusedExemptions.length) {
    console.error(`check:jsdoc: ${failing.length} undocumented, ${unusedExemptions.length} unused exemption(s).`);
    process.exit(1);
  }
  console.log(`check:jsdoc: clean (${exempted.length} exempt).`);
}
