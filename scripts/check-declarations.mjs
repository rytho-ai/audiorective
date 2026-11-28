// Fails when a shipped declaration file exposes internals: a member or exported name that starts with `_`, or an `@internal` tag.
// Rule A1: a coding agent that reads only `packages/*/dist/**/*.d.ts` must see no internal API.
//
// Requires built output: run `pnpm build` first. The check fails with a clear message when no `dist` declarations exist.
// `private` members are ignored: TypeScript emits them as name-only stubs (`private _x;`) that carry no type or behaviour.
// Hide an internal member from the declarations with a `/** @internal */` tag; every package builds with `stripInternal`.
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const MEMBER = /^\s+(?:(?:public|protected|static|readonly|abstract|declare|get|set|async)\s+)*(_[\w$]*)\s*[?(:<;=]/;
const EXPORT_DECL = /^\s*export\s+(?:declare\s+)?(?:abstract\s+)?(?:class|function|const|let|var|interface|type|enum|namespace)\s+(_[\w$]*)/;
const EXPORT_LIST = /^\s*export\s+(?:type\s+)?\{([^}]*)\}/;

/** The bundler splits shared code into hashed chunks (`model-Dqid4iXN.d.ts`) whose export lists use mangled aliases such as `Cell as _`; entries re-export the real names. */
const CHUNK = /-[\w-]{8}\.d\.ts$/;

/** Issues for one declaration file's text: `{ line, message }`. Pass the file name so bundler chunks skip export-list aliases. */
export function scanDeclaration(text, fileName = "") {
  const chunk = CHUNK.test(fileName);
  const issues = [];
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    const n = i + 1;
    if (/@internal\b/.test(line)) issues.push({ line: n, message: "`@internal` tag in a shipped declaration" });
    const trimmed = line.trim();
    if (trimmed.startsWith("*") || trimmed.startsWith("/*") || trimmed.startsWith("//")) return;
    if (/^\s+private\b/.test(line)) return;
    const member = MEMBER.exec(line);
    if (member) issues.push({ line: n, message: `member \`${member[1]}\` starts with an underscore` });
    const decl = EXPORT_DECL.exec(line);
    if (decl) issues.push({ line: n, message: `exported name \`${decl[1]}\` starts with an underscore` });
    const list = chunk ? null : EXPORT_LIST.exec(line);
    if (list) {
      for (const raw of list[1].split(",")) {
        const name = raw
          .trim()
          .split(/\s+as\s+/)
          .pop();
        if (name?.startsWith("_")) issues.push({ line: n, message: `exported name \`${name}\` starts with an underscore` });
      }
    }
  });
  return issues;
}

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.name.endsWith(".d.ts")) yield full;
  }
}

/** Every `packages/*\/dist/**\/*.d.ts` path under `base`. */
export function declarationFiles(base = root) {
  const packages = join(base, "packages");
  const files = [];
  for (const pkg of readdirSync(packages)) {
    const dist = join(packages, pkg, "dist");
    if (existsSync(dist) && statSync(dist).isDirectory()) files.push(...walk(dist));
  }
  return files;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const files = declarationFiles();
  if (files.length === 0) {
    console.error("check:declarations: no packages/*/dist/**/*.d.ts found. Run `pnpm build` first.");
    process.exit(1);
  }
  let failures = 0;
  for (const file of files) {
    for (const issue of scanDeclaration(readFileSync(file, "utf8"), file)) {
      console.error(`${relative(root, file)}:${issue.line}: ${issue.message}`);
      failures++;
    }
  }
  if (failures > 0) {
    console.error(`check:declarations: ${failures} issue(s) in ${files.length} declaration file(s).`);
    process.exit(1);
  }
  console.log(`check:declarations: ${files.length} declaration file(s) clean.`);
}
