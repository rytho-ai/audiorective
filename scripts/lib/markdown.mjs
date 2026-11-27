// Shared by the doc checks (check-doc-examples, check-doc-links): which markdown files are consumer documentation,
// and how to read their fenced code blocks and headings.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { root } from "./entries.mjs";

/** Consumer-facing markdown, as absolute paths: `docs/*.md`, the skills' SKILL.md, package READMEs and the DAW demo README. */
export function docFiles(base = root) {
  const out = [];
  const add = (file) => existsSync(file) && out.push(file);
  const dir = join(base, "docs");
  if (existsSync(dir)) {
    for (const name of readdirSync(dir).sort()) if (name.endsWith(".md")) add(join(dir, name));
  }
  add(join(base, "README.md"));
  const skills = join(base, "skills");
  if (existsSync(skills)) {
    for (const name of readdirSync(skills).sort()) add(join(skills, name, "SKILL.md"));
  }
  const packages = join(base, "packages");
  if (existsSync(packages)) {
    for (const name of readdirSync(packages).sort()) add(join(packages, name, "README.md"));
  }
  add(join(base, "apps", "daw-demo", "README.md"));
  return out;
}

export const rel = (file, base = root) => relative(base, file);

/**
 * Every fenced code block: `{ lang, info, line, code, fence }` where `line` is the 1-based line of the first code line.
 * `info` is the words after the language on the fence, e.g. `["fragment"]`.
 */
export function fencedBlocks(text) {
  const lines = text.split("\n");
  const blocks = [];
  let open = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!open) {
      const m = /^(\s*)(`{3,}|~{3,})\s*([^\s`]*)\s*(.*)$/.exec(line);
      if (m) open = { fence: m[2], indent: m[1].length, lang: m[3].toLowerCase(), info: m[4].split(/\s+/).filter(Boolean), line: i + 2, body: [] };
    } else if (new RegExp(`^\\s*${open.fence[0]}{${open.fence.length},}\\s*$`).test(line)) {
      blocks.push({ lang: open.lang, info: open.info, line: open.line, code: open.body.join("\n"), fence: open.fence });
      open = null;
    } else {
      open.body.push(open.indent ? line.slice(Math.min(open.indent, line.length - line.trimStart().length)) : line);
    }
  }
  return blocks;
}

/** GitHub-style heading slug. */
export function slug(heading) {
  return heading
    .replace(/(?<!\\)<[^>]+>/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\\([\\`*_{}[\]()<>#+.!|-])/g, "$1")
    .replace(/[`*~]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s/g, "-");
}

/** The anchors a markdown file defines: its heading slugs (duplicates get `-1`, `-2`, as on GitHub) and explicit `id="…"` attributes. */
export function anchors(text) {
  const seen = new Map();
  const out = new Set();
  let inFence = null;
  for (const line of text.split("\n")) {
    const f = /^\s*(`{3,}|~{3,})/.exec(line);
    if (f) {
      if (!inFence) inFence = f[1];
      else if (f[1][0] === inFence[0] && f[1].length >= inFence.length) inFence = null;
      continue;
    }
    if (inFence) continue;
    const h = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) {
      const base = slug(h[1]);
      const n = seen.get(base) ?? 0;
      seen.set(base, n + 1);
      out.add(n === 0 ? base : `${base}-${n}`);
    }
    for (const m of line.matchAll(/\bid="([^"]+)"/g)) out.add(m[1]);
  }
  return out;
}

export const read = (file) => readFileSync(file, "utf8");
