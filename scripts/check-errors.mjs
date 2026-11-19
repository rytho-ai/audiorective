#!/usr/bin/env node
// Documentation check: every error message a package can throw must have a row in a
// "Common errors" table (docs/*.md, or the cross-cutting table in skills/audiorective/SKILL.md).
// Pure Node, no dependencies. See AGENTS.md, "Errors are documentation, in two tiers".
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Marks a runtime-derived part of a message: `\u0001name\u0001` (name may be empty). */
const W = "\u0001";
const WILD = new RegExp(`${W}[^${W}]*${W}`, "g");

// ---------------------------------------------------------------- rule data

/**
 * Messages that are deliberately not documented. Key: `<file>::<message>` where message uses
 * `${}` for runtime parts, or `<file>::dynamic:<argument text>` for pass-through arguments.
 * Keep each reason to one line.
 */
export const ALLOWLIST = {
  "packages/core/src/errors.ts::dynamic:message":
    "base constructor of EngineEnvironmentError; the concrete messages are extracted from its call sites",
  "packages/devtools/src/assertLatency.ts::dynamic:formatMismatch(name, declared, runs, tolerance)":
    "multi-line latency report whose numbers differ per run; see assertLatency in docs/devtools.md",
  "packages/core/src/graph.ts::defineGraph: node not present in the last solve":
    "module-internal sentinel, always caught and translated to LatencyUnknownError",
  "packages/host/src/webclap-worklet.js::*": "worklet failures are relayed to the page as `WebCLAP plug-in error: …`",
  "packages/host/src/webclap.ts::dynamic:String(message.message)": "relays the plug-in's own message; documented as `WebCLAP plug-in error: …`",
  "packages/effects/src/TimeStretch.ts::dynamic:event.data.error": "relays the worker's own message; documented under TimeStretch worker failures",
};

/**
 * Files whose templates reference variables bound at their call sites. The host factory builds
 * `${title}`/`${name}` from the string each widget passes to `createPluginHost("<name>", ...)`.
 */
const HOST_FILE = "packages/widgets/src/plugin-host.ts";
const HOST_CALL = /\bcreatePluginHost\s*(?:<[^>(]*(?:<[^>]*>[^>(]*)*>)?\s*\(\s*([^,)]*)/g;

// ---------------------------------------------------------------- lexing

/** Index just past the string/template literal starting at `i`, or `i` if none starts there. */
function skipLiteral(src, i) {
  const q = src[i];
  if (q === '"' || q === "'") {
    let j = i + 1;
    while (j < src.length && src[j] !== q && src[j] !== "\n") j += src[j] === "\\" ? 2 : 1;
    return j + 1;
  }
  if (q === "`") {
    let j = i + 1;
    while (j < src.length && src[j] !== "`") {
      if (src[j] === "\\") j += 2;
      else if (src[j] === "$" && src[j + 1] === "{") j = skipBraces(src, j + 1);
      else j++;
    }
    return j + 1;
  }
  return i;
}

/** Index just past the `{...}` block starting at `i`. */
function skipBraces(src, i) {
  let depth = 0;
  let j = i;
  while (j < src.length) {
    const next = skipLiteral(src, j);
    if (next !== j) {
      j = next;
      continue;
    }
    if (src[j] === "{") depth++;
    else if (src[j] === "}" && --depth === 0) return j + 1;
    j++;
  }
  return j;
}

/** Blank out comments (keeping newlines, so line numbers survive) without touching strings. */
export function stripComments(src) {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const next = skipLiteral(src, i);
    if (next !== i) {
      out += src.slice(i, next);
      i = next;
    } else if (src[i] === "/" && src[i + 1] === "/") {
      const end = src.indexOf("\n", i);
      const stop = end < 0 ? src.length : end;
      out += " ".repeat(stop - i);
      i = stop;
    } else if (src[i] === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end < 0 ? src.length : end + 2;
      out += src.slice(i, stop).replace(/[^\n]/g, " ");
      i = stop;
    } else out += src[i++];
  }
  return out;
}

/** Text of a literal token with escapes resolved and `${x}` replaced by a wildcard marker. */
function literalText(token) {
  const q = token[0];
  const body = token.slice(1, -1);
  let out = "";
  for (let i = 0; i < body.length; i++) {
    if (body[i] === "\\") {
      const c = body[++i];
      out += c === "n" ? "\n" : c === "t" ? "\t" : c;
    } else if (q === "`" && body[i] === "$" && body[i + 1] === "{") {
      const end = skipBraces(body, i + 1);
      const inner = body.slice(i + 2, end - 1).trim();
      out += `${W}${/^[\w$]+$/.test(inner) ? inner : ""}${W}`;
      i = end - 1;
    } else out += body[i];
  }
  return out;
}

/** Split an argument expression at top-level `+`. */
function splitPlus(expr) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < expr.length; ) {
    const next = skipLiteral(expr, i);
    if (next !== i) {
      i = next;
      continue;
    }
    const c = expr[i];
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    else if (c === "+" && depth === 0) {
      parts.push(expr.slice(start, i));
      start = i + 1;
    }
    i++;
  }
  parts.push(expr.slice(start));
  return parts.map((p) => p.trim());
}

const isLiteralToken = (s) => {
  const t = s.trim();
  return /^["'`]/.test(t) && skipLiteral(t, 0) === t.length;
};

/** Every string/template literal token in `expr`, at any depth. */
function allLiterals(expr) {
  const out = [];
  for (let i = 0; i < expr.length; ) {
    const next = skipLiteral(expr, i);
    if (next !== i) {
      out.push(literalText(expr.slice(i, next)));
      i = next;
    } else i++;
  }
  return out;
}

/** Index just past the `(...)` call whose `(` is at `open`. */
function skipParens(src, open) {
  let depth = 0;
  for (let i = open; i < src.length; ) {
    const next = skipLiteral(src, i);
    if (next !== i) {
      i = next;
      continue;
    }
    if (src[i] === "(") depth++;
    else if (src[i] === ")" && --depth === 0) return i + 1;
    i++;
  }
  return src.length;
}

/** The first argument of the call whose `(` is at `open`. */
function firstArg(src, open) {
  const end = skipParens(src, open) - 1;
  let depth = 0;
  for (let i = open + 1; i < end; ) {
    const next = skipLiteral(src, i);
    if (next !== i) {
      i = next;
      continue;
    }
    const c = src[i];
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    else if (c === "," && depth === 0) return src.slice(open + 1, i);
    i++;
  }
  return src.slice(open + 1, end);
}

// ---------------------------------------------------------------- extraction

/** Module-level `const NAME = ...;` and `function NAME(...) {...}` definitions, as raw text. */
function collectDefinitions(src) {
  const defs = new Map();
  for (const m of src.matchAll(/^(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*/gm)) {
    let i = m.index + m[0].length;
    const start = i;
    let depth = 0;
    while (i < src.length) {
      const next = skipLiteral(src, i);
      if (next !== i) {
        i = next;
        continue;
      }
      const c = src[i];
      if ("([{".includes(c)) depth++;
      else if (")]}".includes(c)) depth--;
      else if (c === ";" && depth === 0) break;
      i++;
    }
    defs.set(m[1], src.slice(start, i));
  }
  for (const m of src.matchAll(/^(?:export\s+)?function\s+([A-Za-z_$][\w$]*)\s*[<(]/gm)) {
    const brace = src.indexOf("{", skipParens(src, src.indexOf("(", m.index)));
    if (brace >= 0) defs.set(m[1], src.slice(brace, skipBraces(src, brace)));
  }
  return defs;
}

/** Messages carried by one argument expression; `dynamic` is the unresolved argument text, if any. */
function messagesOf(expr, defs, seen = new Set()) {
  const call = expr.trim().match(/^([A-Za-z_$][\w$]*)\s*\(/);
  if (call && defs.has(call[1]) && defs.get(call[1]).trimStart().startsWith("{")) return { dynamic: expr.trim().replace(/\s+/g, " ") };
  if (call && defs.has(call[1]) && !seen.has(call[1])) {
    seen.add(call[1]);
    const inner = messagesOf(defs.get(call[1]), defs, seen);
    if (inner.messages?.length) return inner;
  }
  const parts = splitPlus(expr);
  if (parts.length > 1) {
    return { messages: [parts.map((p) => (isLiteralToken(p) ? literalText(p.trim()) : W + W)).join("")] };
  }
  const literals = allLiterals(expr);
  if (literals.length > 0) return { messages: literals };
  const id = expr.trim().match(/^([A-Za-z_$][\w$]*)\s*(?:\(|$)/);
  if (id && defs.has(id[1]) && !seen.has(id[1])) {
    seen.add(id[1]);
    const inner = messagesOf(defs.get(id[1]), defs, seen);
    if (inner.messages?.length) return inner;
  }
  return { dynamic: expr.trim().replace(/\s+/g, " ") };
}

// Built-in classes only: custom subclasses are covered through their own `super(...)` call.
const ERROR_NEW = /\bnew\s+(?:Error|TypeError|RangeError|SyntaxError|EvalError|URIError|DOMException)\s*\(/g;
const ERROR_CLASS = /\bclass\s+[\w$]+\s+extends\s+[A-Za-z]*Error\b[^{]*\{/g;

/**
 * @param {string} file repo-relative path
 * @param {string} source
 * @returns {{ file: string, line: number, message?: string, dynamic?: string }[]}
 */
export function extractMessages(file, source) {
  const src = stripComments(source);
  const defs = collectDefinitions(src);
  const lineAt = (idx) => src.slice(0, idx).split("\n").length;
  const out = [];
  const add = (idx, open) => {
    const r = messagesOf(firstArg(src, open), defs);
    if (r.dynamic === "") return; // `new Error()`: nothing to document
    if (r.dynamic !== undefined) out.push({ file, line: lineAt(idx), dynamic: r.dynamic });
    else for (const message of r.messages) if (message.trim() !== "") out.push({ file, line: lineAt(idx), message });
  };
  for (const m of src.matchAll(ERROR_NEW)) add(m.index, m.index + m[0].length - 1);
  for (const m of src.matchAll(ERROR_CLASS)) {
    const sup = src.indexOf("super(", m.index + m[0].length);
    if (sup >= 0) add(sup, sup + 5);
  }
  return out;
}

/** Concrete names passed to `createPluginHost("<name>", ...)` across the sources. */
export function pluginHostNames(files) {
  const names = [];
  const problems = [];
  for (const [file, source] of Object.entries(files)) {
    if (file === HOST_FILE) continue;
    const src = stripComments(source);
    for (const m of src.matchAll(HOST_CALL)) {
      const line = src.slice(0, m.index).split("\n").length;
      if (isLiteralToken(m[1])) names.push(literalText(m[1].trim()));
      else problems.push({ file, line, message: `createPluginHost needs a string literal name so its messages can be checked (got ${m[1].trim()})` });
    }
  }
  return { names, problems };
}

const capitalize = (s) => s[0].toUpperCase() + s.slice(1);

/** Replace the plugin host's `${title}` / `${name}` with each widget's concrete texts. */
function expandHost(entry, names) {
  return names.map((name) => ({
    ...entry,
    message: entry.message.replaceAll(`${W}title${W}`, capitalize(name)).replaceAll(`${W}name${W}`, name),
  }));
}

/** @returns {{ file: string, line: number, message: string }[]} plus problems that need a human. */
export function collectThrown(files) {
  const { names, problems } = pluginHostNames(files);
  const messages = [];
  const issues = [...problems];
  for (const [file, source] of Object.entries(files)) {
    for (const entry of extractMessages(file, source)) {
      if (entry.dynamic !== undefined) {
        if (!ALLOWLIST[`${file}::dynamic:${entry.dynamic}`] && !ALLOWLIST[`${file}::*`])
          issues.push({
            file,
            line: entry.line,
            message: `unresolvable message \`${entry.dynamic}\`: use a literal, or allowlist it in scripts/check-errors.mjs with a reason`,
          });
      } else if (file === HOST_FILE) messages.push(...expandHost(entry, names));
      else messages.push(entry);
    }
  }
  return { messages: messages.filter((m) => !ALLOWLIST[`${m.file}::*`] && !ALLOWLIST[`${m.file}::${m.message.replace(WILD, "${}")}`]), issues };
}

// ---------------------------------------------------------------- docs

/**
 * Message patterns from error tables: the backticked spans of each row's first cell, in every
 * table whose first header cell names messages, errors or symptoms ("Common errors" tables,
 * and the TimeStretch / PCM error tables the reference docs keep next to their feature).
 * @returns {{ text: string, prefix: boolean }[]}
 */
export function parseDocMessages(markdown) {
  const out = [];
  let inErrorTable = false;
  let prevWasTable = false;
  for (const line of markdown.split("\n")) {
    const isRow = line.startsWith("|");
    if (isRow && !prevWasTable) {
      inErrorTable = /message|error|symptom/i.test((line.split(/(?<!\\)\|/)[1] ?? "").replace(/`[^`]*`/g, ""));
      prevWasTable = true;
      continue;
    }
    prevWasTable = isRow;
    if (!isRow || !inErrorTable || /^\|\s*-+/.test(line)) continue;
    const cell = line.split(/(?<!\\)\|/)[1] ?? "";
    for (const span of cell.matchAll(/`([^`]+)`/g)) {
      let text = span[1].replace(/\\\|/g, "|").trim();
      text = text.replace(/^[A-Za-z]*Error:\s*/, "");
      const prefix = /(…|\.\.\.)/.test(text);
      text = text.split(/…|\.\.\./)[0].trimEnd();
      text = text.replace(/<[^>]*>/g, W + W).replace(/\bX\b/g, W + W);
      if (text.length > 0) out.push({ text, prefix });
    }
  }
  return out;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const patternRegex = (pattern, tail) => new RegExp("^" + pattern.split(WILD).map(escapeRe).join(".*") + tail, "s");

/** Is a thrown message (with wildcards) covered by a documented message? */
export function covers(doc, message) {
  const concrete = (s) => s.replace(WILD, "\u0000");
  // Doc text as a regex over the message: `<id>` in the doc matches runtime parts and literal text alike.
  const docRe = patternRegex(doc.text, doc.prefix ? "" : "$");
  if (docRe.test(concrete(message))) return true;
  if (!doc.prefix) return patternRegex(message, "$").test(doc.text.replace(WILD, "\u0000"));
  // An abbreviated row covers every message that begins with its text; `${x}` in the message matches anything.
  return isPrefixOfInstance(message.split(WILD), doc.text.replace(WILD, "\u0000"), 0, 0);
}

/** Can `text` (from `pos`) be a prefix of the message made of literal `segs` joined by wildcards? */
function isPrefixOfInstance(segs, text, si, pos) {
  const lit = segs[si];
  const rest = text.slice(pos);
  if (lit.startsWith(rest)) return true;
  if (!rest.startsWith(lit)) return false;
  if (si === segs.length - 1) return false;
  // A runtime part is a single token (a name, number or URL): it never spans a space, so a message
  // that opens with one cannot be covered by an unrelated abbreviated row.
  for (let k = pos + lit.length; k <= text.length; k++) {
    if (isPrefixOfInstance(segs, text, si + 1, k)) return true;
    if (/\s/.test(text[k] ?? "")) break;
  }
  return false;
}

export function checkErrors({ files, docs }) {
  const { messages, issues } = collectThrown(files);
  const documented = Object.values(docs).flatMap(parseDocMessages);
  const uncovered = messages.filter((m) => !documented.some((d) => covers(d, m.message)));
  return {
    uncovered: uncovered.map((m) => ({ file: m.file, line: m.line, message: m.message.replace(WILD, "${}") })),
    issues,
    checked: messages.length,
  };
}

// ---------------------------------------------------------------- filesystem

const SKIP_DIRS = new Set(["node_modules", "dist", "tests", "__tests__"]);
const SRC_FILE = /\.(ts|tsx|js)$/;
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$|\.d\.ts$/;

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (!SKIP_DIRS.has(name)) walk(p, out);
    } else if (SRC_FILE.test(name) && !TEST_FILE.test(name)) out.push(p);
  }
  return out;
}

export function loadWorkspace(root) {
  const files = {};
  const docs = {};
  const pkgsDir = join(root, "packages");
  for (const pkg of readdirSync(pkgsDir)) {
    const src = join(pkgsDir, pkg, "src");
    if (!existsSync(src)) continue;
    for (const f of walk(src)) files[relative(root, f).split("\\").join("/")] = readFileSync(f, "utf8");
  }
  const docsDir = join(root, "docs");
  for (const name of readdirSync(docsDir)) if (name.endsWith(".md")) docs[`docs/${name}`] = readFileSync(join(docsDir, name), "utf8");
  const skill = join(root, "skills/audiorective/SKILL.md");
  if (existsSync(skill)) docs["skills/audiorective/SKILL.md"] = readFileSync(skill, "utf8").split("### Errors by area")[0];
  return { files, docs };
}

function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const { uncovered, issues, checked } = checkErrors(loadWorkspace(root));
  if (uncovered.length === 0 && issues.length === 0) {
    console.log(`check-errors: ok (${checked} thrown messages documented)`);
    return;
  }
  for (const x of issues) console.error(`${x.file}:${x.line}  ${x.message}`);
  for (const x of uncovered) console.error(`${x.file}:${x.line}  ${x.message}  — no row in a Common errors table`);
  console.error(`\ncheck-errors: ${uncovered.length} undocumented message(s), ${issues.length} unresolved`);
  process.exit(1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
