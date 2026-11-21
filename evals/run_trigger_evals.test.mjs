import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { main, runCodexTrigger } from "./run_trigger_evals.mjs";
const usage = {
  backend: "codex",
  tokens: { input_tokens: 100, cached_input_tokens: 20, cache_write_input_tokens: null, output_tokens: 30, reasoning_output_tokens: null },
  turns: 1,
  costUsd: null,
};
const proof = { tool: "read_file", structuredContent: { path: "audiorective/SKILL.md", skill: "audiorective", kind: "skill", bytes: 10, chars: 10 } };
const opts = { skillName: "audiorective", staged: "/staged", model: "pinned", reasoningEffort: "medium", timeoutMs: 500 };
const queries = JSON.parse(readFileSync(new URL("./audiorective/trigger_eval.json", import.meta.url), "utf8"));
const positive = queries.findIndex((q) => q.should_trigger) + 1,
  negative = queries.findIndex((q) => !q.should_trigger) + 1;
function temp(t) {
  const dir = mkdtempSync(join(tmpdir(), "trigger-runner-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
test("trigger accepts successful direct SKILL.md body read, uses only body reader tools", async () => {
  let options;
  const result = await runCodexTrigger("build audio", {
    ...opts,
    call: async (o) => {
      options = o;
      return { text: "answer", usage, metadata: { readerCalls: [proof] } };
    },
  });
  assert.equal(result.hit, true);
  assert.equal(result.readStats.skillBodyOpens, 1);
  assert.deepEqual(options.reader.allowedTools, ["open_skill", "read_file"]);
  assert.ok(options.reader.args.includes("--skill-only"));
  assert.equal(options.model, "pinned");
  assert.equal(options.reasoningEffort, "medium");
  assert.equal(result.costUsd, null);
});
test("catalog/list/search/reference access alone is not a trigger", async () => {
  const result = await runCodexTrigger("near miss", {
    ...opts,
    call: async () => ({
      text: "answer",
      usage,
      metadata: {
        readerCalls: [
          { tool: "list_files", structuredContent: { resultCount: 1 } },
          { tool: "read_file", structuredContent: { ...proof.structuredContent, path: "audiorective/references/effects.md", kind: "reference" } },
        ],
      },
    }),
  });
  assert.equal(result.hit, false);
});
test("Codex CLI failure or missing body metadata never becomes a passing non-trigger", async () => {
  for (const result of [
    { error: "Codex timed out", usage, metadata: { readerCalls: [] } },
    { error: "CLI failed after body open", usage, metadata: { readerCalls: [proof] } },
    { text: "answer", usage, metadata: { readerCalls: [{ tool: "open_skill", arguments: { name: "audiorective" } }] } },
  ]) {
    const out = await runCodexTrigger("negative query", { ...opts, call: async () => result });
    assert.ok(out.error);
    assert.equal(out.hit, undefined);
    assert.equal(out.usage.tokens.input_tokens, 100);
  }
});
test("three-run majority and per-query error accounting keep positive/negative checks intact", async (t) => {
  const dir = temp(t),
    out = join(dir, "result.json"),
    counts = new Map();
  const code = await main(
    [
      "audiorective",
      "--backend",
      "codex",
      "--model",
      "pinned",
      "--reasoning-effort",
      "medium",
      "--ids",
      `${positive},${negative}`,
      "--runs",
      "3",
      "--concurrency",
      "1",
      "--json",
      out,
    ],
    {
      codexCall: async (o) => {
        const n = (counts.get(o.prompt) ?? 0) + 1;
        counts.set(o.prompt, n);
        if (o.prompt === queries[negative - 1].query && n === 3) return { error: "rate limit", usage, metadata: { readerCalls: [] } };
        return { text: "answer", usage, metadata: { readerCalls: o.prompt === queries[positive - 1].query && n <= 2 ? [proof] : [] } };
      },
    },
  );
  const data = JSON.parse(readFileSync(out, "utf8"));
  assert.equal(code, 1);
  const pos = data.results.find((r) => r.queryIndex === positive),
    neg = data.results.find((r) => r.queryIndex === negative);
  assert.equal(pos.hits, 2);
  assert.equal(pos.pass, true);
  assert.equal(neg.hits, 0);
  assert.equal(neg.pass, false);
  assert.equal(neg.errors.length, 1);
  assert.equal(data.usage.tokens.input_tokens, 600);
  assert.equal(data.usage.costUsd, null);
  assert.match(data.discovery, /not comparable/);
  assert.equal(neg.calls.length, 3);
});
test("Codex requires both pinning flags and refuses user settings", () => {
  for (const flags of [[], ["--model", "pinned"], ["--model", "pinned", "--reasoning-effort", "medium", "--user-settings"]]) {
    const result = spawnSync(
      process.execPath,
      [new URL("./run_trigger_evals.mjs", import.meta.url).pathname, "audiorective", "--backend", "codex", ...flags],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 2);
    assert.match(result.stderr, /requires explicit|unavailable for isolated/);
  }
});
test("default Claude trigger still distinguishes native skill hits from broken CLI", (t) => {
  const dir = temp(t),
    bin = join(dir, "bin");
  mkdirSync(bin);
  const fake = join(bin, "claude");
  writeFileSync(
    fake,
    `#!/usr/bin/env node
const a=process.argv.slice(2);if(a[a.indexOf('--setting-sources')+1]!=='project')process.exit(9);
if(process.env.TRIGGER_FAKE_FAIL==='yes')process.exit(17);
const q=a[a.indexOf('-p')+1];if(q===${JSON.stringify(queries[positive - 1].query)})console.log(JSON.stringify({type:'assistant',message:{content:[{type:'tool_use',name:'Skill',input:{skill:'audiorective'}}]}}));
console.log(JSON.stringify({type:'result',subtype:'success',result:'answer'}));
`,
  );
  chmodSync(fake, 0o755);
  for (const fail of [false, true]) {
    const out = join(dir, `claude-${fail}.json`);
    const result = spawnSync(
      process.execPath,
      [
        new URL("./run_trigger_evals.mjs", import.meta.url).pathname,
        "audiorective",
        "--ids",
        `${positive},${negative}`,
        "--runs",
        "1",
        "--json",
        out,
      ],
      { encoding: "utf8", env: { ...process.env, PATH: bin + ":" + process.env.PATH, TRIGGER_FAKE_FAIL: fail ? "yes" : "no" } },
    );
    assert.equal(result.status, fail ? 1 : 0, result.stderr + result.stdout);
    const data = JSON.parse(readFileSync(out, "utf8"));
    assert.equal(data.backend, "claude");
    assert.equal(
      data.results.every((r) => r.pass),
      !fail,
    );
    if (fail) assert.ok(data.results.every((r) => r.errors.length === 1));
    assert.equal(data.usage, undefined);
  }
});

test("trigger refuses cross-backend output replacement including historical unlabeled Claude data", (t) => {
  const dir = temp(t),
    out = join(dir, "existing.json");
  for (const [previous, backend] of [
    [{ results: [] }, "codex"],
    [{ backend: "claude", results: [] }, "codex"],
    [{ backend: "codex", results: [] }, "claude"],
  ]) {
    const original = JSON.stringify(previous);
    writeFileSync(out, original);
    const result = spawnSync(
      process.execPath,
      [
        new URL("./run_trigger_evals.mjs", import.meta.url).pathname,
        "audiorective",
        "--backend",
        backend,
        "--model",
        "pinned",
        "--reasoning-effort",
        "high",
        "--ids",
        "1",
        "--json",
        out,
      ],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /refusing to overwrite another backend/);
    assert.equal(readFileSync(out, "utf8"), original);
  }
});
