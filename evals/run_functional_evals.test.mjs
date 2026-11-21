import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, existsSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { main, runCodexFunctional, parseGrades } from "./run_functional_evals.mjs";
import { createSkillReader } from "./codex-reader.mjs";
const usage = (n = 1) => ({
  backend: "codex",
  tokens: {
    input_tokens: 100 * n,
    cached_input_tokens: 20 * n,
    cache_write_input_tokens: null,
    output_tokens: 30 * n,
    reasoning_output_tokens: null,
  },
  turns: 1,
  costUsd: null,
});
const fullRead = (path = "audiorective/SKILL.md", kind = "skill") => ({
  tool: "read_file",
  structuredContent: { path, kind, skill: "audiorective", bytes: 20, chars: 18 },
});
const item = { prompt: "Build a mix console.", expectations: ["Use channel strips.", "Compensate latency."] };
const opts = {
  skillName: "audiorective",
  staged: "/unused/staged",
  model: "pinned-model",
  graderModel: "pinned-grader",
  reasoningEffort: "medium",
  graderReasoningEffort: "low",
  timeoutMs: 1234,
};
function temp(t) {
  const dir = mkdtempSync(join(tmpdir(), "functional-runner-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function skills(t) {
  const dir = temp(t),
    skill = join(dir, "skills", "audiorective");
  mkdirSync(join(skill, "references"), { recursive: true });
  writeFileSync(join(skill, "SKILL.md"), "---\nname: audiorective\ndescription: Build audio tools.\n---\n# Skill body\n");
  writeFileSync(join(dir, "original-reference.md"), "# Candidate-only reference\n");
  symlinkSync(join(dir, "original-reference.md"), join(skill, "references", "effects.md"));
  return { dir, skill };
}
test("functional solver receives only staged-reader tools; grader has no reader and actual usage stays separate", async () => {
  const calls = [];
  const result = await runCodexFunctional(item, {
    ...opts,
    call: async (options) => {
      calls.push(options);
      return options.reader
        ? {
            text: "Use channels with PDC.",
            usage: usage(),
            metadata: { readerCalls: [fullRead(), fullRead("audiorective/references/effects.md", "reference")] },
          }
        : {
            text: JSON.stringify({
              results: [
                { index: 0, passed: true, evidence: "channels" },
                { index: 1, passed: false, evidence: "no detail" },
              ],
            }),
            usage: usage(2),
            metadata: { readerCalls: [] },
          };
    },
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].model, "pinned-model");
  assert.equal(calls[0].reasoningEffort, "medium");
  assert.equal(calls[0].timeoutMs, 1234);
  assert.deepEqual(calls[0].reader.allowedTools, ["open_skill", "read_file", "list_files", "search"]);
  assert.equal(calls[1].reader, undefined);
  assert.equal(calls[1].model, "pinned-grader");
  assert.equal(calls[1].reasoningEffort, "low");
  assert.equal(result.usedSkill, true);
  assert.equal(result.readStats.skillBodyOpens, 1);
  assert.deepEqual(result.references, ["audiorective/references/effects.md"]);
  assert.deepEqual(
    result.grades.map((g) => g.passed),
    [true, false],
  );
  assert.equal(result.costUsd, null);
  assert.equal(result.solverUsage.tokens.input_tokens, 100);
  assert.equal(result.graderUsage.tokens.input_tokens, 200);
});
test("functional solver errors retain actual usage and never invoke grader", async () => {
  let calls = 0;
  const result = await runCodexFunctional(item, {
    ...opts,
    call: async () => {
      calls++;
      return { error: "Codex timed out", usage: usage(), metadata: { readerCalls: [] } };
    },
  });
  assert.equal(calls, 1);
  assert.match(result.error, /solver: Codex timed out/);
  assert.equal(result.solverUsage.tokens.input_tokens, 100);
  assert.equal(result.grades, undefined);
});
test("functional grader errors and invalid JSON retain answer and both call usages", async () => {
  for (const grader of [
    { error: "no login", usage: usage(2) },
    { text: "not JSON", usage: usage(2) },
  ]) {
    const result = await runCodexFunctional(item, {
      ...opts,
      call: async (o) => (o.reader ? { text: "answer", usage: usage(), metadata: { readerCalls: [] } } : grader),
    });
    assert.match(result.error, /grader:/);
    assert.equal(result.answer, "answer");
    assert.equal(result.graderUsage.tokens.input_tokens, 200);
    assert.equal(result.costUsd, null);
  }
});
test("missing successful read metadata is an accounting error, not skill-not-used", async () => {
  const result = await runCodexFunctional(item, {
    ...opts,
    call: async () => ({ text: "answer", usage: usage(), metadata: { readerCalls: [{ tool: "open_skill", arguments: { name: "audiorective" } }] } }),
  });
  assert.match(result.error, /reader accounting/);
  assert.equal(result.grades, undefined);
});
test("functional end-to-end Codex output stages resolved references, records exact reads and keeps unknown USD null", async (t) => {
  const { dir, skill } = skills(t),
    out = join(dir, "codex.json");
  let stagedRoot,
    calls = 0;
  const expectations = JSON.parse(readFileSync(new URL("./audiorective/evals.json", import.meta.url), "utf8")).evals.find((e) => e.id === 13)
    .expectations.length;
  const code = await main(
    [
      "audiorective",
      "--backend",
      "codex",
      "--model",
      "pinned-model",
      "--reasoning-effort",
      "medium",
      "--skill-dir",
      skill,
      "--ids",
      "13",
      "--runs",
      "3",
      "--concurrency",
      "1",
      "--json",
      out,
    ],
    {
      codexCall: async (options) => {
        calls++;
        if (options.reader) {
          stagedRoot = options.reader.args[2];
          const reader = createSkillReader({ root: stagedRoot });
          const body = reader.call("read_file", { path: "audiorective/SKILL.md" }),
            ref = reader.call("read_file", { path: "audiorective/references/effects.md" });
          assert.match(ref.content[0].text, /Candidate-only/);
          assert.notEqual(stagedRoot, join(dir, "skills"));
          return {
            text: "answer",
            usage: usage(),
            metadata: {
              readerCalls: [
                { tool: "read_file", structuredContent: body.structuredContent },
                { tool: "read_file", structuredContent: ref.structuredContent },
              ],
            },
          };
        }
        return {
          text: JSON.stringify({ results: Array.from({ length: expectations }, (_, index) => ({ index, passed: true, evidence: "present" })) }),
          usage: usage(2),
          metadata: { readerCalls: [] },
        };
      },
    },
  );
  const result = JSON.parse(readFileSync(out, "utf8"));
  assert.equal(code, 0);
  assert.equal(calls, 6);
  assert.equal(existsSync(stagedRoot), false);
  assert.equal(result.backend, "codex");
  assert.match(result.discovery, /not comparable/);
  assert.equal(result.reasoningEffort, "medium");
  assert.equal(result.results[0].usedSkill, 3);
  assert.equal(result.results[0].readStats.length, 3);
  assert.equal(result.results[0].costUsd, null);
  assert.equal(result.usage.costUsd, null);
  assert.equal(result.usage.graderCostUsd, null);
  assert.equal(result.usage.tokens.input_tokens, 900);
  assert.equal(result.usage.tokens.cached_input_tokens, 180);
  assert.equal(result.usage.tokens.cache_write_input_tokens, null);
  assert.equal(result.usage.priceTableUsdPerMTok, undefined);
});
test("Codex CLI requires pinned model and reasoning effort before calling any backend", () => {
  for (const flags of [[], ["--model", "pinned"]]) {
    const result = spawnSync(
      process.execPath,
      [new URL("./run_functional_evals.mjs", import.meta.url).pathname, "audiorective", "--backend", "codex", ...flags],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 2);
    assert.match(result.stderr, /requires explicit --model and --reasoning-effort/);
  }
});
test("default Claude functional path retains native skill detection and USD totals using a fake local CLI", (t) => {
  const { dir, skill } = skills(t),
    bin = join(dir, "bin"),
    out = join(dir, "claude.json");
  mkdirSync(bin);
  const fake = join(bin, "claude");
  writeFileSync(
    fake,
    `#!/usr/bin/env node
const args=process.argv.slice(2),prompt=args[args.indexOf('-p')+1];
if(args[args.indexOf('--setting-sources')+1]!=='project')process.exit(9);
const grading=prompt.startsWith('You are grading');
if(!grading)console.log(JSON.stringify({type:'assistant',message:{content:[{type:'tool_use',id:'skill',name:'Skill',input:{skill:'audiorective'}}]}}));
const n=grading?(prompt.split('## Expectations\\n')[1].split('\\n\\n## Answer')[0].match(/^\\d+\\./gm)||[]).length:0;
console.log(JSON.stringify({type:'result',subtype:'success',result:grading?JSON.stringify({results:Array.from({length:n},(_,index)=>({index,passed:true,evidence:'ok'}))}):'answer',num_turns:1,total_cost_usd:0.02,usage:{input_tokens:100,output_tokens:10}}));
`,
  );
  chmodSync(fake, 0o755);
  const result = spawnSync(
    process.execPath,
    [new URL("./run_functional_evals.mjs", import.meta.url).pathname, "audiorective", "--skill-dir", skill, "--ids", "13", "--json", out],
    { encoding: "utf8", env: { ...process.env, PATH: bin + ":" + process.env.PATH } },
  );
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const data = JSON.parse(readFileSync(out, "utf8"));
  assert.equal(data.backend, "claude");
  assert.equal(data.results[0].usedSkill, 1);
  assert.equal(data.results[0].costUsd, 0.04);
  assert.equal(data.usage.costUsd, 0.04);
  assert.equal(data.usage.graderCostUsd, 0.02);
  assert.match(result.stdout, /cost: \$0\.04/);
});

test("functional preserves successful solver observations when grader fails, while failing the run", async (t) => {
  const { dir, skill } = skills(t),
    out = join(dir, "grader-error.json");
  const code = await main(
    ["audiorective", "--backend", "codex", "--model", "pinned", "--reasoning-effort", "high", "--skill-dir", skill, "--ids", "81", "--json", out],
    {
      codexCall: async (options) =>
        options.reader
          ? { text: "answer", usage: usage(), metadata: { readerCalls: [fullRead(), fullRead("audiorective/references/effects.md", "reference")] } }
          : { error: "grader unavailable", usage: usage(2), metadata: { readerCalls: [] } },
    },
  );
  const data = JSON.parse(readFileSync(out, "utf8")),
    result = data.results[0];
  assert.equal(code, 1);
  assert.match(result.errors[0], /grader unavailable/);
  assert.equal(result.usedSkill, 1);
  assert.deepEqual(result.references, ["audiorective/references/effects.md"]);
  assert.equal(result.readStats[0].usedSkill, true);
  assert.equal(result.expectations[0].of, 0);
  assert.equal(data.usage.tokens.input_tokens, 300);
});
test("functional refuses cross-backend output replacement before any model call", (t) => {
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
        new URL("./run_functional_evals.mjs", import.meta.url).pathname,
        "audiorective",
        "--backend",
        backend,
        "--model",
        "pinned",
        "--reasoning-effort",
        "high",
        "--ids",
        "81",
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

test("grader indices are unique and complete, normalize reorderings, and require actual booleans", () => {
  const grade = (results) => parseGrades(JSON.stringify({ results }), 2);
  assert.deepEqual(
    grade([
      { index: 1, passed: false, evidence: "second" },
      { index: 0, passed: true, evidence: "first" },
    ]),
    [
      { passed: true, evidence: "first" },
      { passed: false, evidence: "second" },
    ],
  );
  for (const invalid of [
    [
      { index: 0, passed: true },
      { index: 0, passed: false },
    ],
    [{ index: 0, passed: true }],
    [{ passed: true }, { index: 1, passed: false }],
    [
      { index: -1, passed: true },
      { index: 1, passed: false },
    ],
    [
      { index: 0, passed: true },
      { index: 2, passed: false },
    ],
    [
      { index: "0", passed: true },
      { index: 1, passed: false },
    ],
    [
      { index: 0, passed: "true" },
      { index: 1, passed: false },
    ],
    [
      { index: 0, passed: true },
      { index: 1, passed: 0 },
    ],
  ])
    assert.equal(grade(invalid), null, JSON.stringify(invalid));
});
