// Codex-specific skill discovery: native/global skills stay disabled. This server
// exposes only dereferenced Markdown staged for one eval, never the repo or HOME.
import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const READER_TOOLS = ["open_skill", "read_file", "list_files", "search"];
const MAX_READ_BYTES = 256 * 1024;
const MAX_RESULTS = 100;
const MAX_TOTAL_BYTES = 16 * 1024 * 1024;
const within = (root, file) => {
  const r = relative(root, file);
  return r !== ".." && !r.startsWith(`..${sep}`) && !isAbsolute(r);
};
const textResult = (text, structuredContent) => ({ content: [{ type: "text", text }], structuredContent });

// The shipped skills use YAML plain/quoted scalars and folded description blocks.
// This intentionally parses only those frontmatter scalars, not executable YAML.
export function skillFrontmatter(markdown) {
  const block = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(markdown)?.[1];
  if (!block) throw new Error("Reader: SKILL.md requires frontmatter");
  const scalar = (key) => {
    const lines = block.split(/\r?\n/),
      i = lines.findIndex((line) => line.startsWith(`${key}:`));
    if (i < 0) throw new Error(`Reader: SKILL.md requires ${key}`);
    const value = lines[i].slice(key.length + 1).trim();
    if (/^[>|][-+]?\s*$/.test(value)) {
      const body = [];
      for (let j = i + 1; j < lines.length && (/^\s/.test(lines[j]) || !lines[j]); j++) body.push(lines[j].replace(/^\s{1,2}/, ""));
      return value[0] === ">" ? body.join(" ").replace(/\s+/g, " ").trim() : body.join("\n").trim();
    }
    if (value.startsWith('"')) {
      try {
        return JSON.parse(value);
      } catch {
        throw new Error(`Reader: invalid quoted ${key}`);
      }
    }
    if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replace(/''/g, "'");
    return value;
  };
  const name = scalar("name"),
    description = scalar("description");
  if (typeof name !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name) || typeof description !== "string" || !description.trim())
    throw new Error("Reader: invalid skill name or description");
  return { name, description };
}
function globPattern(glob) {
  if (typeof glob !== "string" || glob.length > 1024 || isAbsolute(glob) || glob.includes("\\") || glob.split("/").includes(".."))
    throw new Error("Reader: glob must stay relative to staged skills");
  let out = "^";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      i++;
      if (glob[i + 1] === "/") {
        i++;
        out += "(?:.*/)?";
      } else out += ".*";
    } else if (c === "*") out += "[^/]*";
    else if (c === "?") out += "[^/]";
    else out += c.replace(/[\\^$+?.()|{}[\]]/g, "\\$&");
  }
  return new RegExp(out + "$");
}
export function createSkillReader({
  root,
  skillOnly = false,
  maxReadBytes = MAX_READ_BYTES,
  maxResults = MAX_RESULTS,
  maxTotalBytes = MAX_TOTAL_BYTES,
}) {
  if (!root || lstatSync(root).isSymbolicLink()) throw new Error("Reader: root must be a real staged directory");
  root = realpathSync(root);
  if (!lstatSync(root).isDirectory()) throw new Error("Reader: root must be a directory");
  for (const [name, n] of Object.entries({ maxReadBytes, maxResults, maxTotalBytes }))
    if (!Number.isInteger(n) || n < 1) throw new Error(`Reader: invalid ${name}`);
  let totalBytes = 0;
  const catalog = [];
  const resolveFile = (path) => {
    if (typeof path !== "string" || !path || path.length > 2048 || isAbsolute(path) || path.includes("\\") || path.includes("\0"))
      throw new Error("Reader: invalid relative path");
    const parts = path.split("/");
    if (parts.some((p) => !p || p === "." || p === ".." || p.startsWith("."))) throw new Error("Reader: hidden paths and traversal are forbidden");
    if (!/\.md$/i.test(path) || !((parts.length === 2 && parts[1] === "SKILL.md") || (parts.length >= 3 && parts[1] === "references")))
      throw new Error("Reader: only staged skill Markdown is readable");
    if (skillOnly && !(parts.length === 2 && parts[1] === "SKILL.md")) throw new Error("Reader: references are disabled in trigger mode");
    let file = root;
    for (const part of parts) {
      file = join(file, part);
      let st;
      try {
        st = lstatSync(file);
      } catch {
        throw new Error("Reader: staged file not found");
      }
      if (st.isSymbolicLink()) throw new Error("Reader: symlinks are forbidden");
    }
    if (!within(root, realpathSync(file)) || !lstatSync(file).isFile()) throw new Error("Reader: file is outside staged Markdown");
    return file;
  };
  const read = (path) => {
    const file = resolveFile(path);
    let fd;
    try {
      fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      const st = fstatSync(fd);
      if (!st.isFile() || st.size > maxReadBytes) throw new Error("Reader: read byte limit exceeded");
      if (totalBytes + st.size > maxTotalBytes) throw new Error("Reader: session read budget exceeded");
      const data = readFileSync(fd);
      if (data.length > maxReadBytes) throw new Error("Reader: read byte limit exceeded");
      totalBytes += data.length;
      const text = data.toString("utf8");
      return { text, bytes: data.length, chars: text.length };
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  };
  for (const dir of readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!dir.isDirectory() || dir.name.startsWith(".")) continue;
    const path = `${dir.name}/SKILL.md`,
      { text } = read(path),
      info = skillFrontmatter(text);
    if (catalog.some((s) => s.name === info.name)) throw new Error("Reader: duplicate staged skill names");
    catalog.push({ ...info, path });
  }
  if (!catalog.length) throw new Error("Reader: staged root contains no skills");
  const folders = new Set(catalog.map((s) => s.path.split("/")[0]));
  const permitted = (path) => folders.has(path.split("/")[0]);
  const files = () => {
    const found = [];
    const walk = (dir, prefix) => {
      for (const item of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (item.name.startsWith(".") || item.isSymbolicLink()) continue;
        const path = prefix + item.name;
        if (item.isDirectory()) {
          if (found.length > 10000) throw new Error("Reader: file catalog limit exceeded");
          walk(join(dir, item.name), path + "/");
        } else if (item.isFile() && /\.md$/i.test(item.name)) {
          try {
            resolveFile(path);
            if (permitted(path)) found.push(path);
          } catch {}
        }
      }
    };
    walk(root, "");
    return found;
  };
  const tools = [
    {
      name: "open_skill",
      description: `Open the full body of a relevant staged skill. Choose by these exact staged descriptions; do not open unrelated skills. Catalog: ${JSON.stringify(catalog.map(({ name, description }) => ({ name, description })))}`,
      inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"], additionalProperties: false },
    },
    {
      name: "read_file",
      description:
        "Read staged skill Markdown by a root-relative path, such as audiorective/SKILL.md or audiorective/references/effects.md. No external paths, hidden files, scripts or configuration.",
      inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false },
    },
    {
      name: "list_files",
      description: "List staged Markdown paths matching a relative glob, such as **/SKILL.md or audiorective/references/*.md. Results are bounded.",
      inputSchema: { type: "object", properties: { glob: { type: "string" } }, additionalProperties: false },
    },
    {
      name: "search",
      description: "Search staged Markdown for a literal text pattern. Returns bounded matching lines, never outside the staged skills.",
      inputSchema: { type: "object", properties: { pattern: { type: "string" } }, required: ["pattern"], additionalProperties: false },
    },
  ];
  for (const tool of tools) tool.annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
  return {
    catalog,
    tools: skillOnly ? tools.filter((t) => ["open_skill", "read_file"].includes(t.name)) : tools,
    call(name, args = {}) {
      try {
        if (skillOnly && !["open_skill", "read_file"].includes(name)) throw new Error("Reader: tool disabled in trigger mode");
        if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("Reader: arguments must be an object");
        if (name === "open_skill" || name === "read_file") {
          const skill = name === "open_skill" ? catalog.find((s) => s.name === args.name) : null;
          if (name === "open_skill" && !skill) throw new Error("Reader: unknown staged skill");
          const path = skill?.path ?? args.path;
          if (typeof path !== "string" || !permitted(path)) throw new Error("Reader: unknown staged skill path");
          const { text, bytes, chars } = read(path),
            owner = catalog.find((s) => s.path.split("/")[0] === path.split("/")[0]);
          return textResult(text, { path, skill: owner.name, kind: path === owner.path ? "skill" : "reference", bytes, chars });
        }
        if (name === "list_files") {
          const matches = files().filter((p) => globPattern(args.glob ?? "**/*.md").test(p));
          const paths = matches.slice(0, maxResults);
          return textResult(JSON.stringify(paths), { resultCount: paths.length, truncated: matches.length > maxResults });
        }
        if (name === "search") {
          if (typeof args.pattern !== "string" || !args.pattern || args.pattern.length > 1024)
            throw new Error("Reader: search requires a bounded literal pattern");
          const matches = [];
          let filesScanned = 0,
            bytesScanned = 0,
            truncated = false;
          outer: for (const path of files()) {
            const data = read(path);
            filesScanned++;
            bytesScanned += data.bytes;
            for (const [i, line] of data.text.split(/\r?\n/).entries())
              if (line.includes(args.pattern)) {
                if (matches.length === maxResults) {
                  truncated = true;
                  break outer;
                }
                matches.push({ path, line: i + 1, text: line.slice(0, 500) });
              }
          }
          const text = JSON.stringify(matches);
          return textResult(text, { resultCount: matches.length, filesScanned, bytesScanned, charsReturned: text.length, truncated });
        }
        throw new Error("Reader: unknown tool");
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text", text: String(error.message?.startsWith("Reader:") ? error.message : "Reader: staged read failed") }],
        };
      }
    },
  };
}

// Successful MCP calls only. Metadata contains exact delivered file sizes; no
// characters/4 token estimates, no fabricated USD, no counting failed reads.
export function codexReadStats(metadata, skillName) {
  const calls = metadata?.readerCalls ?? [],
    reads = [],
    errors = [];
  const toolCalls = {};
  for (const call of calls) {
    toolCalls[call.tool] = (toolCalls[call.tool] ?? 0) + 1;
    if (!["open_skill", "read_file"].includes(call.tool)) continue;
    const m = call.structuredContent;
    if (
      !m ||
      typeof m.path !== "string" ||
      typeof m.skill !== "string" ||
      !Number.isInteger(m.bytes) ||
      m.bytes < 0 ||
      !Number.isInteger(m.chars) ||
      m.chars < 0 ||
      !["skill", "reference"].includes(m.kind)
    ) {
      errors.push(`Successful ${call.tool} is missing exact staged read metadata`);
      continue;
    }
    if ((call.tool === "open_skill" && m.kind !== "skill") || (m.kind === "skill" && !m.path.endsWith("/SKILL.md"))) {
      errors.push(`Successful ${call.tool} has inconsistent skill-body metadata`);
      continue;
    }
    reads.push({ ...m, via: call.tool });
  }
  const bodyOpens = reads.filter((r) => r.kind === "skill");
  return {
    errors,
    usedSkill: bodyOpens.some((r) => r.skill === skillName),
    targetSkillBodyOpens: bodyOpens.filter((r) => r.skill === skillName).length,
    skillBodyOpens: bodyOpens.length,
    referenceReadCalls: reads.filter((r) => r.kind === "reference").length,
    openedSkills: [...new Set(bodyOpens.map((r) => r.skill))],
    references: [...new Set(reads.filter((r) => r.kind === "reference").map((r) => r.path))].sort(),
    reads,
    toolCalls,
    readCalls: reads.length,
    bytes: reads.reduce((n, r) => n + r.bytes, 0),
    chars: reads.reduce((n, r) => n + r.chars, 0),
    searches: calls.filter((c) => c.tool === "search").map((c) => c.structuredContent ?? null),
  };
}
export const discoveryMetadata = {
  backend: "codex",
  method: "explicit staged-skill MCP catalog and successful full-body reads",
  comparison:
    "Compare only matched Codex runs with identical model, reasoning effort, evals, reader and staging; not native Claude Skill-tool scores.",
};
export function codexReaderConfig(root, { skillOnly = false } = {}) {
  return {
    command: process.execPath,
    args: [fileURLToPath(import.meta.url), "--root", resolve(root), ...(skillOnly ? ["--skill-only"] : [])],
    allowedTools: skillOnly ? ["open_skill", "read_file"] : READER_TOOLS,
  };
}
export async function serveReader({ input = process.stdin, output = process.stdout, reader }) {
  let buffer = "",
    initialized = false;
  const send = (id, result, error) => output.write(JSON.stringify({ jsonrpc: "2.0", id, ...(error ? { error } : { result }) }) + "\n");
  input.setEncoding("utf8");
  for await (const chunk of input) {
    buffer += chunk;
    if (buffer.length > 1024 * 1024 && !buffer.includes("\n")) {
      send(null, null, { code: -32700, message: "Request size limit exceeded" });
      buffer = "";
      continue;
    }
    let at;
    while ((at = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, at);
      buffer = buffer.slice(at + 1);
      if (!line.trim()) continue;
      if (line.length > 1024 * 1024) {
        send(null, null, { code: -32700, message: "Request size limit exceeded" });
        continue;
      }
      let req;
      try {
        req = JSON.parse(line);
      } catch {
        send(null, null, { code: -32700, message: "Parse error" });
        continue;
      }
      if (!req || typeof req !== "object" || Array.isArray(req)) {
        send(null, null, { code: -32600, message: "Invalid Request" });
        continue;
      }
      if (req.id === undefined) continue;
      if (req.jsonrpc !== "2.0" || typeof req.method !== "string") {
        send(req.id, null, { code: -32600, message: "Invalid Request" });
        continue;
      }
      if (req.method === "initialize") {
        initialized = true;
        send(req.id, {
          protocolVersion: req.params?.protocolVersion ?? "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "eval_reader", version: "1.0.0" },
          instructions: "Only staged skills are available. Open a skill only when its catalog description matches the request.",
        });
        continue;
      }
      if (!initialized) {
        send(req.id, null, { code: -32002, message: "Initialize the staged reader first" });
        continue;
      }
      if (req.method === "ping") send(req.id, {});
      else if (req.method === "tools/list") send(req.id, { tools: reader.tools });
      else if (req.method === "tools/call") send(req.id, reader.call(req.params?.name, req.params?.arguments));
      else send(req.id, null, { code: -32601, message: "Method not found" });
    }
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const at = process.argv.indexOf("--root");
  if (at < 0 || !process.argv[at + 1]) {
    console.error("usage: codex-reader.mjs --root <staged-skills> [--skill-only]");
    process.exitCode = 2;
  } else
    try {
      await serveReader({ reader: createSkillReader({ root: process.argv[at + 1], skillOnly: process.argv.includes("--skill-only") }) });
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
}
