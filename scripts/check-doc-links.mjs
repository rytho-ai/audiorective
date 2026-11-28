// Every relative markdown link in the consumer docs resolves: the file exists and, with a `#anchor`, the heading does too.
// Links into the repository on github.com (`…/blob/main/<path>`) are checked against the local tree the same way.
import { existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { root } from "./lib/entries.mjs";
import { anchors, docFiles, read, rel } from "./lib/markdown.mjs";

const GITHUB = /^https:\/\/github\.com\/audiorective\/audiorective\/(?:blob|tree)\/main\//;

/** Links of one markdown text outside code fences and inline code: `{ target, line }`. */
export function linksIn(text) {
  const out = [];
  let inFence = null;
  text.split("\n").forEach((raw, i) => {
    const f = /^\s*(`{3,}|~{3,})/.exec(raw);
    if (f) {
      if (!inFence) inFence = f[1];
      else if (f[1][0] === inFence[0] && f[1].length >= inFence.length) inFence = null;
      return;
    }
    if (inFence) return;
    const line = raw.replace(/`[^`]*`/g, (m) => " ".repeat(m.length));
    for (const m of line.matchAll(/\[(?:[^\]\\]|\\.)*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) out.push({ target: m[1], line: i + 1 });
    for (const m of line.matchAll(/^\s*\[[^\]]+\]:\s*(\S+)/g)) out.push({ target: m[1], line: i + 1 });
  });
  return out;
}

/** Problems found in `files` (absolute paths): `{ file, line, target, problem }`. */
export function checkLinks(files, base = root) {
  const cache = new Map();
  const anchorsOf = (file) => {
    if (!cache.has(file)) cache.set(file, anchors(read(file)));
    return cache.get(file);
  };
  const problems = [];
  for (const file of files) {
    for (const { target, line } of linksIn(read(file))) {
      let path = target;
      let local = null;
      if (path.startsWith("/") && !path.startsWith("//")) {
        // A site route: /docs/<page> is docs/<page>.md, /showroom[/<demo>] is an Astro page.
        const route = path.split("#")[0].replace(/\/+$/, "");
        const hash = path.includes("#") ? path.slice(path.indexOf("#")) : "";
        const page = /^\/docs\/([\w-]+)$/.exec(route);
        if (page) path = join(base, "docs", `${page[1]}.md`) + hash;
        else if (route === "/showroom" || route.startsWith("/showroom/")) {
          const demo = route.slice("/showroom/".length);
          const dir = join(base, "apps/web/src/pages/showroom");
          const ok = demo === "" || existsSync(join(dir, `${demo}.astro`)) || existsSync(join(dir, demo, "index.astro"));
          if (!ok) problems.push({ file: rel(file, base), line, target, problem: "no showroom page" });
          continue;
        } else continue;
        local = path;
      }
      if (GITHUB.test(path)) local = join(base, path.replace(GITHUB, ""));
      else if (/^[a-z][a-z0-9+.-]*:/i.test(path) || path.startsWith("//")) continue;
      let anchor = "";
      if (local) {
        const at = local.indexOf("#");
        if (at >= 0) [local, anchor] = [local.slice(0, at), local.slice(at + 1)];
      } else {
        const at = path.indexOf("#");
        if (at >= 0) [path, anchor] = [path.slice(0, at), path.slice(at + 1)];
        local = path === "" ? file : resolve(dirname(file), decodeURIComponent(path));
      }
      const report = (problem) => problems.push({ file: rel(file, base), line, target, problem });
      if (!existsSync(local)) {
        report("file does not exist");
        continue;
      }
      if (
        anchor &&
        anchor !== "top" &&
        anchor !== "_top" &&
        statSync(local).isFile() &&
        local.endsWith(".md") &&
        !anchorsOf(local).has(decodeURIComponent(anchor))
      ) {
        report(`no heading "#${anchor}" in ${rel(local, base)}`);
      }
    }
  }
  return problems;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const exclude = process.argv
    .slice(2)
    .filter((a) => a.startsWith("--exclude="))
    .map((a) => a.slice(10));
  const files = docFiles().filter((f) => !exclude.some((e) => rel(f) === e));
  const problems = checkLinks(files);
  for (const p of problems) console.error(`${p.file}:${p.line}: ${p.target} -> ${p.problem}`);
  console.log(`check:doc-links: ${files.length} files, ${problems.length} broken link(s)`);
  if (problems.length) process.exit(1);
}
