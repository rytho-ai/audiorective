import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createSkillReader, codexReadStats, skillFrontmatter } from "./codex-reader.mjs";
const body =
  "---\nname: demo\ndescription: >\n  Build audio tools: channels, sends.\n  Use for browser audio.\nlicense: MIT\n---\n\n# Body only after open\n秘密\n";
function staged(t) {
  const parent = mkdtempSync(join(tmpdir(), "reader-test-")),
    root = join(parent, "skills");
  mkdirSync(join(root, "demo", "references"), { recursive: true });
  writeFileSync(join(root, "demo", "SKILL.md"), body);
  writeFileSync(join(root, "demo", "references", "effect.md"), "# Effect\nGain is reactive.\nGain repeats.\n");
  writeFileSync(join(parent, "auth.json"), "OUTSIDE_SECRET");
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  return { root, parent };
}
test("description discovery exposes exact staged frontmatter, never unopened body", (t) => {
  const { root } = staged(t),
    reader = createSkillReader({ root });
  assert.deepEqual(reader.catalog, [
    { name: "demo", description: "Build audio tools: channels, sends. Use for browser audio.", path: "demo/SKILL.md" },
  ]);
  for (const tool of reader.tools)
    assert.deepEqual(tool.annotations, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
  assert.match(reader.tools[0].description, /Build audio tools: channels, sends/);
  assert.doesNotMatch(JSON.stringify(reader.tools), /Body only after open|秘密/);
  const opened = reader.call("open_skill", { name: "demo" });
  assert.equal(opened.content[0].text, body);
  assert.deepEqual(opened.structuredContent, {
    path: "demo/SKILL.md",
    skill: "demo",
    kind: "skill",
    bytes: Buffer.byteLength(body),
    chars: body.length,
  });
  assert.equal(reader.call("open_skill", { name: "outside" }).isError, true);
});
test("frontmatter supports quoted scalar descriptions with colons and apostrophes", () => {
  assert.deepEqual(skillFrontmatter('---\nname: x\ndescription: "A: b"\n---\n'), { name: "x", description: "A: b" });
  assert.equal(skillFrontmatter("---\nname: x\ndescription: 'It''s audio: yes'\n---\n").description, "It's audio: yes");
});
test("reader resolves Markdown globs and bounded literal search only inside staged skill", (t) => {
  const { root } = staged(t),
    reader = createSkillReader({ root, maxResults: 1 });
  const listed = reader.call("list_files", { glob: "demo/references/*.md" });
  assert.deepEqual(JSON.parse(listed.content[0].text), ["demo/references/effect.md"]);
  const found = reader.call("search", { pattern: "Gain" });
  assert.equal(found.structuredContent.resultCount, 1);
  assert.equal(found.structuredContent.truncated, true);
  assert.equal(JSON.parse(found.content[0].text)[0].path, "demo/references/effect.md");
  assert.deepEqual(JSON.parse(reader.call("search", { pattern: "OUTSIDE_SECRET" }).content[0].text), []);
  assert.equal(reader.call("list_files", { glob: "../*" }).isError, true);
});
test("reader rejects traversal, external/hidden/config/non-Markdown files and symlinks", (t) => {
  const { root, parent } = staged(t),
    reader = createSkillReader({ root });
  writeFileSync(join(root, "demo", "references", "config.toml"), "CONFIG_SECRET");
  writeFileSync(join(root, "demo", ".env"), "ENV_SECRET");
  symlinkSync(join(parent, "auth.json"), join(root, "demo", "references", "leak.md"));
  symlinkSync(join(root, "demo", "references", "effect.md"), join(root, "demo", "references", "internal-link.md"));
  for (const path of [
    "../auth.json",
    "demo/../../auth.json",
    "/etc/passwd",
    join(parent, "auth.json"),
    "demo/.env",
    "demo/references/config.toml",
    "demo/references/leak.md",
    "demo/references/internal-link.md",
    "demo/./SKILL.md",
    "demo\\SKILL.md",
  ]) {
    const r = reader.call("read_file", { path });
    assert.equal(r.isError, true, path);
    assert.doesNotMatch(JSON.stringify(r), /OUTSIDE_SECRET|CONFIG_SECRET|ENV_SECRET/);
  }
  assert.equal(reader.call("read_file", { path: "demo/references/effect.md" }).isError, undefined);
  assert.equal(reader.call("execute", { command: "cat /etc/passwd" }).isError, true);
});
test("read and session budgets fail explicitly without leaking file content", (t) => {
  const { root } = staged(t),
    reader = createSkillReader({ root, maxReadBytes: 256, maxTotalBytes: 1024 });
  writeFileSync(join(root, "demo", "references", "large.md"), "SECRET".repeat(100));
  assert.equal(reader.call("read_file", { path: "demo/references/large.md" }).isError, true);
  const limited = createSkillReader({ root, maxTotalBytes: Buffer.byteLength(body) + 10 });
  assert.equal(limited.call("open_skill", { name: "demo" }).isError, true);
});
test("trigger mode exposes SKILL.md body only, denies references and search/list bypasses", (t) => {
  const { root } = staged(t),
    reader = createSkillReader({ root, skillOnly: true });
  assert.deepEqual(
    reader.tools.map((t) => t.name),
    ["open_skill", "read_file"],
  );
  assert.equal(reader.call("read_file", { path: "demo/SKILL.md" }).content[0].text, body);
  for (const [name, args] of [
    ["read_file", { path: "demo/references/effect.md" }],
    ["search", { pattern: "Body" }],
    ["list_files", {}],
  ])
    assert.equal(reader.call(name, args).isError, true);
});
test("read accounting requires successful full-body metadata; direct SKILL.md reads count", () => {
  const stats = codexReadStats(
    {
      readerCalls: [
        { tool: "list_files", structuredContent: { resultCount: 2 } },
        { tool: "read_file", structuredContent: { path: "demo/SKILL.md", skill: "demo", kind: "skill", bytes: 10, chars: 8 } },
        { tool: "read_file", structuredContent: { path: "demo/references/effect.md", skill: "demo", kind: "reference", bytes: 5, chars: 5 } },
        { tool: "open_skill", structuredContent: { path: "demo/SKILL.md", skill: "demo", kind: "skill", bytes: 10, chars: 8 } },
      ],
    },
    "demo",
  );
  assert.equal(stats.usedSkill, true);
  assert.equal(stats.skillBodyOpens, 2);
  assert.deepEqual(stats.references, ["demo/references/effect.md"]);
  assert.equal(stats.bytes, 25);
  assert.equal(stats.readCalls, 3);
  assert.deepEqual(stats.toolCalls, { list_files: 1, read_file: 2, open_skill: 1 });
  assert.equal(codexReadStats({ readerCalls: [{ tool: "open_skill", arguments: { name: "demo" } }] }, "demo").errors.length, 1);
});
test("stdio MCP handles initialization, notifications, tools and read denial without protocol chatter", async (t) => {
  const { root } = staged(t);
  const child = spawn(process.execPath, [new URL("./codex-reader.mjs", import.meta.url).pathname, "--root", root], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));
  child.stdin.end(
    [
      { jsonrpc: "2.0", id: 0, method: "tools/list" },
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "read_file", arguments: { path: "demo/SKILL.md" } } },
      { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "read_file", arguments: { path: "../auth.json" } } },
      { jsonrpc: "2.0", id: 5, method: "unknown" },
    ]
      .map((x) => JSON.stringify(x))
      .join("\n") + "\n",
  );
  const code = await new Promise((resolve) => child.on("close", resolve));
  assert.equal(code, 0, stderr);
  assert.equal(stderr, "");
  const replies = stdout.trim().split("\n").map(JSON.parse);
  assert.equal(replies.length, 6);
  assert.equal(replies[0].error.code, -32002);
  assert.equal(replies[1].result.serverInfo.name, "eval_reader");
  assert.equal(replies[2].result.tools.length, 4);
  assert.equal(replies[3].result.content[0].text, body);
  assert.equal(replies[4].result.isError, true);
  assert.equal(replies[5].error.code, -32601);
});

test("malformed protocol requests fail in-band and the reader remains usable", async (t) => {
  const { root } = staged(t);
  const child = spawn(process.execPath, [new URL("./codex-reader.mjs", import.meta.url).pathname, "--root", root], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  let text = "",
    stderr = "";
  child.stdout.on("data", (d) => (text += d));
  child.stderr.on("data", (d) => (stderr += d));
  child.stdin.end(
    "null\nnot-json\n" +
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } }) +
      "\n" +
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "open_skill", arguments: { name: "demo" } } }) +
      "\n",
  );
  const code = await new Promise((resolve) => child.on("close", resolve));
  assert.equal(code, 0, stderr);
  const replies = text.trim().split("\n").map(JSON.parse);
  assert.equal(replies[0].error.code, -32600);
  assert.equal(replies[1].error.code, -32700);
  assert.equal(replies[3].result.content[0].text, body);
});
