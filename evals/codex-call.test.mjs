import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { callCodex, codexUsageJson } from "./codex-call.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "test-codex-call-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
const executable = join(scratch, "codex");
const log = join(scratch, "calls.jsonl");
writeFileSync(
  executable,
  `#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs';
const stdin = readFileSync(0, 'utf8'); // This would hang if the helper left stdin open.
const args = process.argv.slice(2);
const prompt = args.at(-1) === '-' ? stdin : args.at(-1);
if (process.env.CALL_LOG) appendFileSync(process.env.CALL_LOG, JSON.stringify({args,cwd:process.cwd(),stdinLength:stdin.length})+'\\n');
const emit = (event) => process.stdout.write(JSON.stringify(event)+'\\n');
const item = (value,type='item.completed') => emit({type,item:value});
if (process.env.SCENARIO === 'timeout') { setInterval(()=>{},1000); }
else {
  emit({type:'thread.started',thread_id:'fake-thread'});
  emit({type:'turn.started'});
  item({type:'error',message:'Under-development features enabled: skip_host_skill_discovery, omit_skill_descriptions. Under-development features may be incomplete.'});
  const scenario = process.env.SCENARIO;
  if (scenario === 'warning-error') item({type:'error',message:'API authentication failed'});
  if (scenario === 'top-error') emit({type:'error',message:'API unavailable'});
  if (scenario === 'turn-failed') emit({type:'turn.failed',error:{message:'rate limited'}});
  if (scenario === 'tool') item({id:'tool1',type:'command_execution',command:'echo unsafe'},'item.started');
  if (scenario === 'mcp-wrong-server') item({id:'mcp1',type:'mcp_tool_call',server:'outside',tool:'read_file',arguments:{path:'x'}},'item.started');
  if (scenario === 'mcp-wrong-tool') item({id:'mcp1',type:'mcp_tool_call',server:'eval_reader',tool:'write_file',arguments:{path:'x'}},'item.started');
  if (scenario === 'reader' || scenario === 'reader-error') {
    item({id:'mcp1',type:'mcp_tool_call',server:'eval_reader',tool:'read_file',arguments:{path:'audiorective/SKILL.md'}},'item.started');
    item({id:'mcp1',type:'mcp_tool_call',server:'eval_reader',tool:'read_file',arguments:{path:'audiorective/SKILL.md'},status:'completed',result:{isError:scenario==='reader-error',structuredContent:{path:'audiorective/SKILL.md',kind:'skill',bytes:123,chars:100},content:[{type:'text',text:'PRIVATE FULL BODY'}]}});
  }
  if (scenario === 'invalid-json') process.stdout.write('not json\\n');
  if (scenario === 'null-json') process.stdout.write('null\\n');
  item({type:'reasoning',text:'Thinking'});
  if (scenario !== 'no-message') {
    let code = 'export const answer: number = 42;' + (scenario === 'dom-iterable' ? '\\ndeclare const parameters: AudioParamMap; const gain = parameters.get("gain"); for (const [name, param] of parameters) { void name; void param.value; }' : '');
    if (scenario === 'host-binding') code += '\\nconst borrowed: AudioNode = synthOut;';
    if (scenario === 'jsx-const' || scenario === 'jsx-wrong-prop') code = 'import { View } from "@trial/view"; export const view = <View value={' + (scenario === 'jsx-const' ? '42' : '"wrong"') + '} />;';
    if (scenario === 'jsx-fragment') code = 'export const view = <>42</>;';
    const text = prompt.includes('You are grading code') ? JSON.stringify({expectations:[{met:false,evidence:'deliberately false; deterministic check must win'}],errors:[]}) : '\x60\x60\x60ts\\n' + code + '\\n\x60\x60\x60';
    item({type:'agent_message',text:scenario==='reader-denied'?'MCP tool call requires approval, but approval policy is never.':text});
  }
  if (scenario !== 'no-completion') emit({type:'turn.completed',usage:{input_tokens:100,cached_input_tokens:25,cache_write_input_tokens:0,output_tokens:10,reasoning_output_tokens:4}});
  if (scenario === 'nonzero') process.exitCode=7;
}
`,
);
chmodSync(executable, 0o755);
const base = { prompt: "test", model: "pinned-model", reasoningEffort: "high", executable, timeoutMs: 5000 };
const env = (scenario = "success") => ({ ...process.env, SCENARIO: scenario, CALL_LOG: log });

// No live model/network calls: the fake executable speaks the CLI JSONL protocol.
test("a prompt over one argv string's limit goes on stdin", async () => {
  const prompt = "x".repeat(200_000);
  const result = await callCodex({ ...base, prompt, env: env() });
  assert.equal(result.error, undefined);
  const call = JSON.parse(readFileSync(log, "utf8").trim().split("\n").at(-1));
  assert.equal(call.args.at(-1), "-");
  assert.equal(call.stdinLength, prompt.length);
  await callCodex({ ...base, env: env() });
  const small = JSON.parse(readFileSync(log, "utf8").trim().split("\n").at(-1));
  assert.equal(small.args.at(-1), "test");
  assert.equal(small.stdinLength, 0);
});

test("success uses a fresh isolated cwd, explicit model/effort, exact tokens and unknown USD", async () => {
  const result = await callCodex({ ...base, env: env() });
  assert.equal(result.error, undefined);
  assert.match(result.text, /answer: number = 42/);
  assert.equal(result.costUsd, null);
  assert.equal(result.usage.costUsd, null);
  assert.deepEqual(result.usage.tokens, {
    input_tokens: 100,
    cached_input_tokens: 25,
    cache_write_input_tokens: 0,
    output_tokens: 10,
    reasoning_output_tokens: 4,
  });
  assert.equal(result.metadata.model, "pinned-model");
  assert.equal(result.metadata.reasoningEffort, "high");
  const call = JSON.parse(readFileSync(log, "utf8").trim().split("\n").at(-1));
  assert.equal(existsSync(call.cwd), false, "scratch removed after the call");
  for (const flag of ["--ignore-user-config", "--ignore-rules", "--ephemeral", "--skip-git-repo-check", "--json"])
    assert.ok(call.args.includes(flag));
  for (const setting of ["project_doc_max_bytes=0", 'web_search="disabled"', "mcp_servers={}", 'model_reasoning_effort="high"'])
    assert.ok(call.args.includes(setting));
  for (const feature of [
    "shell_tool",
    "apps",
    "plugins",
    "hooks",
    "browser_use",
    "computer_use",
    "image_generation",
    "view_image",
    "multi_agent",
    "goals",
    "sleep_tool",
    "skill_search",
    "memories",
  ]) {
    const index = call.args.indexOf(feature);
    assert.equal(call.args[index - 1], "--disable", feature);
  }
  assert.equal(call.args[call.args.indexOf("skip_host_skill_discovery") - 1], "--enable");
  assert.equal(call.args[call.args.indexOf("omit_skill_descriptions") - 1], "--enable");
  assert.equal(call.args[call.args.indexOf("--sandbox") + 1], "read-only");
  const next = await callCodex({ ...base, env: env() });
  assert.equal(next.error, undefined);
  const calls = readFileSync(log, "utf8").trim().split("\n").map(JSON.parse);
  assert.notEqual(calls.at(-1).cwd, calls.at(-2).cwd);
});

for (const [scenario, pattern] of [
  ["nonzero", /code 7/],
  ["turn-failed", /rate limited/],
  ["top-error", /API unavailable/],
  ["warning-error", /authentication failed/],
  ["tool", /isolation violation.*command_execution/],
  ["invalid-json", /invalid JSONL/],
  ["null-json", /invalid JSONL event/],
  ["no-completion", /without a completed turn/],
  ["no-message", /without a final agent message/],
])
  test(`rejects ${scenario} instead of returning a false success`, async () => {
    const result = await callCodex({ ...base, env: env(scenario) });
    assert.match(result.error, pattern);
    assert.equal(result.text, undefined);
    assert.equal(result.costUsd, null);
  });

test("timeout terminates the CLI and cleans its scratch directory", async () => {
  const result = await callCodex({ ...base, env: env("timeout"), timeoutMs: 200 });
  assert.match(result.error, /timed out/);
  assert.equal(result.costUsd, null);
  const call = JSON.parse(readFileSync(log, "utf8").trim().split("\n").at(-1));
  assert.equal(existsSync(call.cwd), false);
});

test("reader is opt-in, server/tool whitelisted, with successful metadata but no body content", async () => {
  const reader = { command: "node", args: ["reader.mjs"], allowedTools: ["read_file"] };
  const denied = await callCodex({ ...base, env: env("reader") });
  assert.match(denied.error, /isolation violation/);
  for (const scenario of ["mcp-wrong-server", "mcp-wrong-tool"]) {
    const rejected = await callCodex({ ...base, reader, env: env(scenario) });
    assert.match(rejected.error, /isolation violation/);
  }
  const result = await callCodex({ ...base, reader, env: env("reader") });
  assert.equal(result.error, undefined);
  assert.deepEqual(result.metadata.readerCalls, [
    {
      tool: "read_file",
      arguments: { path: "audiorective/SKILL.md" },
      structuredContent: { path: "audiorective/SKILL.md", kind: "skill", bytes: 123, chars: 100 },
    },
  ]);
  assert.ok(!JSON.stringify(result.metadata).includes("PRIVATE FULL BODY"));
  const failed = await callCodex({ ...base, reader, env: env("reader-error") });
  assert.match(failed.error, /reader call failed/);
  assert.deepEqual(failed.metadata.readerCalls, []);
  assert.equal(failed.metadata.readerErrors.length, 1);
  const call = JSON.parse(readFileSync(log, "utf8").trim().split("\n").at(-1));
  assert.ok(
    call.args.includes(
      'mcp_servers={eval_reader={command="node",args=["reader.mjs"],enabled_tools=["read_file"],default_tools_approval_mode="approve"}}',
    ),
  );
});

test("missing executable fails cleanly; explicit model and effort are required", async () => {
  const result = await callCodex({ ...base, executable: join(scratch, "absent") });
  assert.match(result.error, /could not start Codex/);
  await assert.rejects(callCodex({ ...base, model: null }), /explicit model/);
  await assert.rejects(callCodex({ ...base, reasoningEffort: null }), /explicit reasoningEffort/);
});

test("accounting preserves null USD and does not invent missing token fields", () => {
  const usage = codexUsageJson([{ label: "solver", runs: [{ tokens: { input_tokens: 100, cached_input_tokens: 25, output_tokens: 10 } }] }]);
  assert.equal(usage.costUsd, null);
  assert.equal(usage.tokens.input_tokens, 100);
  assert.equal(usage.tokens.output_tokens, 10);
  assert.equal(usage.tokens.cache_write_input_tokens, null);
  assert.equal(usage.tokens.reasoning_output_tokens, null);
  assert.equal(usage.priceTableUsdPerMTok, undefined);
});

function runGuess(args, extraEnv = {}) {
  return new Promise((resolveResult) => {
    const child = spawn(process.execPath, [join(here, "run_guess_evals.mjs"), ...args], {
      cwd: resolve(here, ".."),
      env: { ...env(), PATH: `${scratch}:${process.env.PATH}`, ...extraEnv },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data) => {
      stdout += data;
    });
    child.stderr.on("data", (data) => {
      stderr += data;
    });
    child.on("close", (code) => resolveResult({ code, stdout, stderr }));
  });
}

test("guess runner uses unchanged real compile/grader/checks and emits Codex null-USD metadata", async () => {
  const suite = join(scratch, "suite.json");
  const variant = join(scratch, "variant.d.ts");
  const output = join(scratch, "result.json");
  writeFileSync(
    suite,
    JSON.stringify({
      area: "backend-test",
      tasks: [{ id: "T1", prompt: "Export answer as number 42.", expectations: ["Exports 42."], checks: [{ expectation: 0, all: ["\\b42\\b"] }] }],
    }),
  );
  writeFileSync(variant, "// @step-base 0\ninterface Test { value: number; }\n");
  const args = [
    suite,
    "--mode",
    "guess",
    "--variant",
    variant,
    "--backend",
    "codex",
    "--model",
    "pinned-model",
    "--reasoning-effort",
    "high",
    "--runs",
    "1",
    "--json",
    output,
  ];
  const result = await runGuess(args);
  assert.equal(result.code, 0, result.stderr + result.stdout);
  const json = JSON.parse(readFileSync(output, "utf8"));
  assert.equal(json.backend, "codex");
  assert.equal(json.model, "pinned-model");
  assert.equal(json.graderModel, "pinned-model");
  assert.equal(json.reasoningEffort, "high");
  assert.equal(json.costUsd, null);
  assert.equal(json.usage.costUsd, null);
  assert.equal(json.usage.tokens.input_tokens, 200, "solver + grader actual token totals");
  assert.equal(json.usage.tokens.cached_input_tokens, 50);
  assert.equal(json.usage.priceTableUsdPerMTok, undefined);
  assert.equal(json.results[0].compilePassed, 1);
  assert.equal(json.results[0].samples[0].costUsd, null);
  assert.equal(json.results[0].samples[0].calls.length, 2);
  assert.equal(json.results[0].expectations[0].met, 1, "deterministic override still wins");
  assert.equal(json.results[0].expectations[0].llmMet, 0);
  assert.ok(!result.stdout.includes("cost: $0"));
  assert.ok(!result.stdout.includes("price table"));
  const mismatch = await runGuess([suite, "--mode", "guess", "--variant", variant, "--regrade", output]);
  assert.equal(mismatch.code, 2);
  assert.match(mismatch.stderr, /different backend/);
  const oldOutput = join(scratch, "claude-result.json");
  writeFileSync(oldOutput, JSON.stringify({ backend: "claude", results: [] }));
  const noOverwrite = await runGuess([...args.slice(0, -1), oldOutput]);
  assert.equal(noOverwrite.code, 2);
  assert.match(noOverwrite.stderr, /overwrite another backend/);
  assert.equal(JSON.parse(readFileSync(oldOutput, "utf8")).backend, "claude");
});

test("guess solver tool violations fail the sample and runner without false compile/grade passes", async () => {
  const suite = join(scratch, "suite.json");
  const variant = join(scratch, "variant.d.ts");
  const output = join(scratch, "failed-result.json");
  const result = await runGuess(
    [
      suite,
      "--mode",
      "guess",
      "--variant",
      variant,
      "--backend",
      "codex",
      "--model",
      "pinned-model",
      "--reasoning-effort",
      "high",
      "--runs",
      "1",
      "--json",
      output,
    ],
    { SCENARIO: "tool" },
  );
  assert.equal(result.code, 1);
  const json = JSON.parse(readFileSync(output, "utf8"));
  assert.equal(json.costUsd, null);
  assert.equal(json.results[0].completed, 0);
  assert.equal(json.results[0].compilePassed, 0);
  assert.match(json.results[0].samples[0].error, /isolation violation/);
});

test("checks-only inherits recorded backend/model/effort and does not call either CLI", async () => {
  const before = readFileSync(log, "utf8").trim().split("\n").length;
  const output = join(scratch, "checked-result.json");
  const result = await runGuess([join(scratch, "suite.json"), "--checks-only", join(scratch, "result.json"), "--json", output]);
  assert.equal(result.code, 0, result.stderr + result.stdout);
  assert.equal(readFileSync(log, "utf8").trim().split("\n").length, before);
  const json = JSON.parse(readFileSync(output, "utf8"));
  assert.equal(json.backend, "codex");
  assert.equal(json.model, "pinned-model");
  assert.equal(json.reasoningEffort, "high");
  assert.equal(json.costUsd, null);
  assert.equal(json.usage.runs, 0);
  assert.equal(json.results[0].expectations[0].met, 1);
});

test("Claude remains the default backend and keeps numeric reported USD accounting", async () => {
  const claude = join(scratch, "claude");
  writeFileSync(
    claude,
    `#!/usr/bin/env node
const prompt = process.argv[3];
const result = prompt.includes('You are grading code') ? JSON.stringify({expectations:[{met:false,evidence:'check overrides'}],errors:[]}) : '\x60\x60\x60ts\\nexport const answer: number = 42;\\n\x60\x60\x60';
process.stdout.write(JSON.stringify({type:'result',subtype:'success',result,total_cost_usd:0.01,num_turns:1,usage:{input_tokens:100,output_tokens:10}})+'\\n');
`,
  );
  chmodSync(claude, 0o755);
  const output = join(scratch, "default-claude-result.json");
  const result = await runGuess([
    join(scratch, "suite.json"),
    "--mode",
    "guess",
    "--variant",
    join(scratch, "variant.d.ts"),
    "--runs",
    "1",
    "--json",
    output,
  ]);
  assert.equal(result.code, 0, result.stderr + result.stdout);
  const json = JSON.parse(readFileSync(output, "utf8"));
  assert.equal(json.backend, "claude");
  assert.equal(json.costUsd, 0.02);
  assert.equal(json.usage.costUsd, 0.02);
  assert.ok(json.usage.priceTableUsdPerMTok);
  assert.equal(json.results[0].compilePassed, 1);
  assert.equal(json.results[0].expectations[0].met, 1);
});

test("guess compiler includes native DOM iterable AudioParamMap methods identically for every variant", async () => {
  const output = join(scratch, "dom-iterable-result.json");
  const result = await runGuess(
    [
      join(scratch, "suite.json"),
      "--mode",
      "guess",
      "--variant",
      join(scratch, "variant.d.ts"),
      "--backend",
      "codex",
      "--model",
      "pinned-model",
      "--reasoning-effort",
      "high",
      "--runs",
      "1",
      "--json",
      output,
    ],
    { SCENARIO: "dom-iterable" },
  );
  assert.equal(result.code, 0, result.stderr + result.stdout);
  const json = JSON.parse(readFileSync(output, "utf8"));
  assert.equal(json.results[0].compilePassed, 1, JSON.stringify(json.results[0].samples[0].tsc));
});

test("reader approval-denial final text is an infrastructure error even without tool events", async () => {
  const result = await callCodex({
    ...base,
    reader: { command: "node", args: ["reader.mjs"], allowedTools: ["read_file"] },
    env: env("reader-denied"),
  });
  assert.match(result.error, /reader blocked.*approval policy is never/);
  assert.equal(result.text, undefined);
  assert.deepEqual(result.metadata.readerCalls, []);
});

test("guess compiler supplies only explicitly typed task host bindings", async () => {
  const originalSuite = JSON.parse(readFileSync(join(scratch, "suite.json"), "utf8"));
  for (const [name, declaration, expected] of [
    ["valid", "declare const synthOut: AudioNode;", 1],
    ["wrong-type", "declare const synthOut: number;", 0],
    ["wrong-name", "declare const anotherSource: AudioNode;", 0],
  ]) {
    const suite = structuredClone(originalSuite);
    suite.tasks[0].hostDeclarations = declaration;
    const suitePath = join(scratch, `host-${name}.json`);
    const output = join(scratch, `host-${name}-result.json`);
    writeFileSync(suitePath, JSON.stringify(suite));
    const result = await runGuess(
      [
        suitePath,
        "--mode",
        "guess",
        "--variant",
        join(scratch, "variant.d.ts"),
        "--backend",
        "codex",
        "--model",
        "pinned-model",
        "--reasoning-effort",
        "high",
        "--runs",
        "1",
        "--json",
        output,
      ],
      { SCENARIO: "host-binding" },
    );
    assert.equal(result.code, 0, result.stderr + result.stdout);
    const json = JSON.parse(readFileSync(output, "utf8"));
    assert.equal(json.results[0].compilePassed, expected, JSON.stringify(json.results[0].samples[0].tsc));
    assert.equal(json.results[0].samples[0].tsc.hostDeclarations, declaration);
  }
});

test("guess compiler checks JSX assignments and fragments with real React types and rejects wrong props", async () => {
  const suite = join(scratch, "jsx-suite.json");
  const variant = join(scratch, "jsx-variant.d.ts");
  writeFileSync(suite, JSON.stringify({ area: "jsx", tasks: [{ id: "J1", prompt: "Render View with value 42.", expectations: ["Uses View."] }] }));
  writeFileSync(variant, 'declare module "@trial/view" { export function View(props: { value: number }): import("react").ReactElement; }\n');
  for (const [scenario, expected] of [
    ["jsx-const", 1],
    ["jsx-wrong-prop", 0],
    ["jsx-fragment", 1],
  ]) {
    const output = join(scratch, `${scenario}.json`);
    const result = await runGuess(
      [
        suite,
        "--mode",
        "guess",
        "--variant",
        variant,
        "--backend",
        "codex",
        "--model",
        "pinned-model",
        "--reasoning-effort",
        "high",
        "--runs",
        "1",
        "--json",
        output,
      ],
      { SCENARIO: scenario },
    );
    assert.equal(result.code, 0, result.stderr + result.stdout);
    const json = JSON.parse(readFileSync(output, "utf8"));
    const sample = json.results[0].samples[0];
    assert.equal(json.results[0].compilePassed, expected, JSON.stringify(sample.tsc));
    if (!expected) assert.match(sample.tsc.first.join("\n"), /TS2322.*not assignable to type 'number'/);
  }
});
