#!/usr/bin/env node
// API affordance evals: how well do coding agents guess an API's shape?
//
//   node evals/run_guess_evals.mjs evals/affordance/step-sequencer.json --mode desire --runs 3 --json /tmp/desire.json
//   node evals/run_guess_evals.mjs evals/affordance/step-sequencer.json --mode guess --variant /path/to/variant.d.ts --runs 3
//
// desire: the solver is told a library exists and invents the API it would expect. No compile,
//         no grading; one clustering call per task groups the samples by API shape.
// guess:  the solver gets only a variant's .d.ts. Its code is type-checked with tsc, then a
//         separate grader (never told which variant) scores it against the task's expectations.
//
// Solver, grader and clustering calls are `claude -p` with no tools, no skills and a minimal
// system prompt, run from empty throwaway directories. Requires the Claude Code CLI and a login.
//
// Options: --mode desire|guess   --variant <file.d.ts> (guess)   --ids T1,T2   --runs <n> (3)
//          --concurrency <n> (4)   --model <id>   --grader-model <id>   --timeout <seconds> (300)
//          --json <out-file>   --md <out-file> (desire: markdown cluster report)

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

const args = process.argv.slice(2);
const flagsWithValue = new Set(["mode", "variant", "ids", "runs", "concurrency", "model", "grader-model", "timeout", "json", "md"]);
const suitePath = args.find((a, i) => !a.startsWith("--") && !(args[i - 1]?.startsWith("--") && flagsWithValue.has(args[i - 1].slice(2))));
const usage = (msg) => {
  if (msg) console.error(`error: ${msg}`);
  console.error(
    "usage: node evals/run_guess_evals.mjs <suite.json> --mode desire|guess [--variant f.d.ts] [--ids T1,T2] [--runs n] [--concurrency n] [--model m] [--grader-model m] [--timeout s] [--json f] [--md f]",
  );
  process.exit(2);
};
if (!suitePath) usage();
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};
const positiveInt = (name, fallback) => {
  const raw = opt(name, fallback);
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) usage(`--${name} must be a positive integer, got ${JSON.stringify(raw)}`);
  return n;
};
const mode = opt("mode", null);
if (mode !== "desire" && mode !== "guess") usage("--mode must be desire or guess");
const runs = positiveInt("runs", 3);
const concurrency = positiveInt("concurrency", 4);
const timeoutMs = positiveInt("timeout", 300) * 1000;
const model = opt("model", null);
const graderModel = opt("grader-model", model);
const jsonOut = opt("json", null);
const mdOut = opt("md", null);
const ids = opt("ids", null)
  ?.split(",")
  .map((s) => s.trim());
const variantPath = opt("variant", null);
if (mode === "guess" && (!variantPath || !existsSync(variantPath))) usage("guess mode needs --variant <existing file.d.ts>");
const variantDts = mode === "guess" ? readFileSync(variantPath, "utf8") : null;

const suite = JSON.parse(readFileSync(resolve(suitePath), "utf8"));
let tasks = suite.tasks;
if (ids) tasks = tasks.filter((t) => ids.includes(t.id));
if (tasks.length === 0) usage("no matching tasks");

// TypeScript from the repo (any workspace package, or the pnpm store).
function findTsc() {
  const candidates = [
    ...["core", "clock", "effects", "blocks", "midi", "workspace"].map((p) => join(repoRoot, "packages", p, "node_modules/typescript/bin/tsc")),
    join(repoRoot, "node_modules/typescript/bin/tsc"),
    join(repoRoot, "node_modules/.pnpm/typescript@5.9.3/node_modules/typescript/bin/tsc"),
  ];
  return candidates.find(existsSync);
}
const tsc = mode === "guess" ? findTsc() : null;
if (mode === "guess" && !tsc) usage("could not find the repo's TypeScript (run pnpm install)");

const env = { ...process.env };
delete env.CLAUDECODE; // allow nesting claude -p inside a Claude Code session

const tmpDirs = [];
const scratch = (prefix) => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
};
const emptyDir = scratch("guess-eval-");

const SYSTEM_PROMPT = "You are a helpful assistant. Answer exactly in the format requested.";

// One tool-less `claude -p` call. Resolves to { text, costUsd } or { error }.
function claude(prompt, useModel) {
  return new Promise((done) => {
    const argv = [
      "-p",
      prompt,
      "--output-format",
      "stream-json",
      "--verbose",
      "--max-turns",
      "1",
      "--strict-mcp-config",
      "--tools",
      "",
      "--disable-slash-commands",
      "--setting-sources",
      "",
      "--no-session-persistence",
      "--system-prompt",
      SYSTEM_PROMPT,
    ];
    if (useModel) argv.push("--model", useModel);
    const child = spawn("claude", argv, { cwd: emptyDir, env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    let result = null;
    let timedOut = false;
    let spawnError = null;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.on("error", (e) => (spawnError = e));
    child.stderr.on("data", (c) => (err += c));
    child.stdout.on("data", (chunk) => {
      out += chunk;
      let nl;
      while ((nl = out.indexOf("\n")) !== -1) {
        const line = out.slice(0, nl);
        out = out.slice(nl + 1);
        try {
          const event = JSON.parse(line);
          if (event.type === "result") result = event;
        } catch {}
      }
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (spawnError) return done({ error: `could not start claude: ${spawnError.message}` });
      if (timedOut) return done({ error: `timed out after ${timeoutMs / 1000}s` });
      if (!result) return done({ error: `claude exited without a result (code ${code}, signal ${signal}) ${err.slice(0, 200)}` });
      if (result.is_error || result.terminal_reason === "api_error" || result.api_error)
        return done({ error: `claude reported ${result.api_error ?? result.result ?? result.terminal_reason ?? "an error"}` });
      if (result.subtype !== "success") return done({ error: `claude reported ${result.subtype}` });
      done({ text: String(result.result ?? ""), costUsd: result.total_cost_usd ?? 0 });
    });
  });
}

// ---- prompts ---------------------------------------------------------------

const DESIRE_INTRO =
  "Assume a TypeScript library for building web-audio apps exists (packages under `@audiorective/…`). You don't know its API. Write the code you would *expect* to write with it for the task below — invent the API you'd naturally reach for. Reply with one ```ts block (and an ```html block only if your API is markup-based), no explanation.";
const GUESS_INTRO =
  "You are using `@audiorective/*`. Its complete public API is the type declarations below; there are no other docs. Write the code for the task using only this API (plus standard Web Audio/DOM). Reply with one ```ts block (and ```html if needed), no explanation.";

const solverPrompt = (task) =>
  mode === "desire"
    ? `${DESIRE_INTRO}\n\n## Task\n${task.prompt}`
    : `${GUESS_INTRO}\n\n## Type declarations\n\`\`\`ts\n${variantDts}\n\`\`\`\n\n## Task\n${task.prompt}`;

// ---- code extraction and metrics ------------------------------------------

function extractBlocks(text) {
  const blocks = { ts: [], html: [] };
  for (const m of text.matchAll(/```(\w*)[^\n]*\n([\s\S]*?)```/g)) {
    const lang = m[1].toLowerCase();
    if (["ts", "typescript", "tsx", "js", "javascript"].includes(lang)) blocks.ts.push(m[2]);
    else if (lang === "html") blocks.html.push(m[2]);
  }
  return { ts: blocks.ts.join("\n\n"), html: blocks.html.join("\n\n") };
}

// Non-blank, non-comment lines of the ts (and html) code.
function countLoc(code) {
  let n = 0;
  let inBlock = false;
  for (const raw of code.split("\n")) {
    let line = raw.trim();
    if (inBlock) {
      const end = line.indexOf("*/");
      if (end === -1) continue;
      inBlock = false;
      line = line.slice(end + 2).trim();
    }
    if (line.startsWith("<!--")) {
      if (!line.includes("-->")) inBlock = "html";
      continue;
    }
    if (line.startsWith("//")) continue;
    if (line.startsWith("/*")) {
      if (!line.includes("*/")) inBlock = true;
      continue;
    }
    if (line) n++;
  }
  return n;
}

// ---- compile check ---------------------------------------------------------

function compile(variant, tsCode) {
  const dir = scratch("guess-tsc-");
  writeFileSync(join(dir, "variant.d.ts"), variant);
  writeFileSync(join(dir, "main.ts"), tsCode.trim() ? tsCode : "export {};\n");
  const r = spawnSync(
    process.execPath,
    [
      tsc,
      "--noEmit",
      "--strict",
      "--target",
      "es2022",
      "--module",
      "esnext",
      "--moduleResolution",
      "bundler",
      "--lib",
      "es2022,dom",
      "--skipLibCheck",
      "false",
      "--pretty",
      "false",
      "main.ts",
      "variant.d.ts",
    ],
    { cwd: dir, encoding: "utf8", timeout: 120_000 },
  );
  rmSync(dir, { recursive: true, force: true });
  if (r.error) return { error: `tsc failed to run: ${r.error.message}` };
  const lines = `${r.stdout}${r.stderr}`
    .split("\n")
    .filter((l) => /\berror TS\d+:/.test(l))
    .map((l) => l.trim());
  return { passed: r.status === 0 && lines.length === 0, diagnostics: lines.length, first: lines.slice(0, 5), all: lines };
}

// ---- grader ----------------------------------------------------------------

const ERROR_KINDS = ["wrong-name", "wrong-signature", "wrong-concept", "invented-api", "platform-misuse", "other"];

function gradePrompt(task, code, tscResult) {
  return [
    "You are grading code that an agent wrote for a task, against fixed expectations. Judge only what the code actually does.",
    "An expectation is met only if the code clearly satisfies it; if the code is silent on something the expectation requires, it is not met. Where an expectation says 'or an equivalent', accept any approach that achieves the same thing.",
    "You are not told which library API the agent was given. Use the TypeScript compiler diagnostics as evidence of misused or invented API.",
    ...(mode === "guess"
      ? [
          "The API's type declarations are included below. Judge only against the declared API plus standard Web Audio/DOM. Behaviour that the declarations document as a default counts as met when the code relies on it.",
        ]
      : []),
    "Also list every error you find in the code, each with a kind: wrong-name (identifier does not exist but a similar one probably does), wrong-signature (right thing, wrong arguments/units/order/types), wrong-concept (misunderstands what the API does or how to use it), invented-api (uses something that does not exist at all), platform-misuse (Web Audio/DOM/browser misuse, e.g. autoplay, timing), other.",
    'Reply with JSON only, no prose, no code fence: {"expectations":[{"met":true,"evidence":"short reason"}, ...one per expectation in order], "errors":[{"kind":"wrong-name","detail":"..."}]}. "errors" may be empty.',
    "",
    "## Task",
    task.prompt,
    "",
    "## Expectations",
    ...task.expectations.map((e, i) => `${i}. ${e}`),
    "",
    ...(mode === "guess" ? ["## The API's type declarations", "```ts", variantDts, "```", ""] : []),
    "## Code",
    "```ts",
    code,
    "```",
    "",
    "## TypeScript diagnostics",
    tscResult.passed ? "(none: compiled cleanly)" : tscResult.all.slice(0, 40).join("\n"),
  ].join("\n");
}

function extractJson(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

function parseGrade(text, count) {
  const p = extractJson(text);
  if (!p || !Array.isArray(p.expectations) || p.expectations.length !== count) return null;
  return {
    expectations: p.expectations.map((e) => ({ met: e?.met === true, evidence: String(e?.evidence ?? "") })),
    errors: (Array.isArray(p.errors) ? p.errors : []).map((e) => ({
      kind: ERROR_KINDS.includes(e?.kind) ? e.kind : "other",
      detail: String(e?.detail ?? ""),
    })),
  };
}

async function gradeWithRetry(task, code, tscResult) {
  let cost = 0;
  let lastError = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const g = await claude(gradePrompt(task, code, tscResult), graderModel);
    if (g.error) return { error: `grader: ${g.error}`, cost };
    cost += g.costUsd;
    const grade = parseGrade(g.text, task.expectations.length);
    if (grade) return { grade, cost };
    lastError = "reply was not the requested JSON";
  }
  return { error: `grader: ${lastError}`, cost };
}

// ---- one solver run --------------------------------------------------------

async function runOne(task) {
  const solved = await claude(solverPrompt(task), model);
  if (solved.error) return { error: `solver: ${solved.error}` };
  const { ts, html } = extractBlocks(solved.text);
  if (!ts.trim() && !html.trim()) return { error: "solver: reply contained no code block", raw: solved.text };
  const base = {
    raw: solved.text,
    ts,
    html,
    loc: countLoc(ts) + countLoc(html),
    chars: ts.length + html.length,
    costUsd: solved.costUsd,
  };
  if (mode === "desire") return base;
  const tscResult = compile(variantDts, ts);
  if (tscResult.error) return { ...base, error: tscResult.error };
  const graded = await gradeWithRetry(task, ts, tscResult);
  base.costUsd += graded.cost;
  if (graded.error) return { ...base, tsc: tscResult, error: graded.error };
  return { ...base, tsc: tscResult, grade: graded.grade };
}

// ---- desire clustering -----------------------------------------------------

function clusterPrompt(task, samples) {
  return [
    `Below are ${samples.length} independent code samples. Each was written by an agent asked to invent the API it would naturally expect from an unknown TypeScript web-audio library, for the same task.`,
    "Group the samples by API SHAPE (the style of API, e.g. 'class with start(when)', 'pattern string', 'custom element', 'decorator', 'Tone.js-like Transport.scheduleRepeat'), not by surface details.",
    "Reply with JSON only, no prose, no code fence:",
    '{"clusters":[{"shape":"short name","count":N,"samples":[sample numbers],"representative":"a short snippet (<= 12 lines) from one sample"}],',
    ' "recurring":{"names":["method/class/property names that recur across samples, with how many samples"],"signatures":["recurring argument orders / call signatures"],"time_units":"how time/tempo/ms/seconds/beats are expressed","pattern_and_velocity":"how patterns, steps and velocities are expressed","cancellation_cleanup":"how stopping, cancellation and cleanup are done","other":"anything else striking"}}',
    "Cluster counts must sum to the number of samples.",
    "",
    `## Task given to the agents\n${task.prompt}`,
    "",
    ...samples.flatMap((s, i) => [`## Sample ${i + 1}`, "```", s.ts + (s.html ? `\n\n<!-- html -->\n${s.html}` : ""), "```", ""]),
  ].join("\n");
}

async function clusterTask(task, samples) {
  if (samples.length === 0) return { error: "no completed samples" };
  let last = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await claude(clusterPrompt(task, samples), graderModel);
    if (r.error) return { error: `cluster: ${r.error}` };
    const p = extractJson(r.text);
    if (p && Array.isArray(p.clusters)) return { clusters: p.clusters, recurring: p.recurring ?? {}, costUsd: r.costUsd };
    last = "reply was not the requested JSON";
  }
  return { error: `cluster: ${last}` };
}

// ---- driver ----------------------------------------------------------------

async function pool(jobs, size) {
  const results = new Array(jobs.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, jobs.length) }, async () => {
      while (next < jobs.length) {
        const i = next++;
        results[i] = await jobs[i]();
      }
    }),
  );
  return results;
}

console.error(`suite: ${suite.area ?? suitePath}  mode: ${mode}${variantPath ? `  variant: ${variantPath}` : ""}`);
console.error(`${tasks.length} tasks × ${runs} runs, concurrency ${concurrency}${model ? `, model ${model}` : ""}…`);

const jobs = [];
for (const [ti, task] of tasks.entries()) for (let r = 0; r < runs; r++) jobs.push(async () => ({ ti, ...(await runOne(task)) }));
const flat = await pool(jobs, concurrency);

const sum = (xs, f) => xs.reduce((n, x) => n + f(x), 0);
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const pct = (n, d) => (d ? `${((100 * n) / d).toFixed(0)}%` : "n/a");

const results = tasks.map((task, ti) => {
  const mine = flat.filter((x) => x.ti === ti);
  const errors = mine.filter((x) => x.error).map((x) => x.error);
  const ok = mine.filter((x) => !x.error);
  const out = {
    id: task.id,
    prompt: task.prompt,
    runs: mine.length,
    errors,
    completed: ok.length,
    meanLoc: mean(ok.map((x) => x.loc)),
    meanChars: mean(ok.map((x) => x.chars)),
  };
  if (mode === "guess") {
    out.compilePassed = ok.filter((x) => x.tsc.passed).length;
    out.meanDiagnostics = mean(ok.map((x) => x.tsc.diagnostics));
    out.expectations = task.expectations.map((text, i) => ({
      text,
      met: ok.filter((x) => x.grade.expectations[i].met).length,
      of: ok.length,
      evidence: ok.map((x) => x.grade.expectations[i].evidence),
    }));
    out.errorKinds = Object.fromEntries(ERROR_KINDS.map((k) => [k, sum(ok, (x) => x.grade.errors.filter((e) => e.kind === k).length)]));
  }
  out.samples = mine.map((x) => ({
    error: x.error ?? null,
    ts: x.ts ?? null,
    html: x.html ?? null,
    loc: x.loc ?? null,
    chars: x.chars ?? null,
    raw: x.raw ?? null,
    tsc: x.tsc ? { passed: x.tsc.passed, diagnostics: x.tsc.diagnostics, first: x.tsc.first } : null,
    grade: x.grade ?? null,
  }));
  out._ok = ok;
  return out;
});

let clusterCost = 0;
if (mode === "desire") {
  const clustered = await pool(
    results.map((r, i) => async () => clusterTask(tasks[i], r._ok)),
    concurrency,
  );
  clustered.forEach((c, i) => {
    results[i].cluster = c;
    if (c.error) results[i].errors.push(c.error);
    clusterCost += c.costUsd ?? 0;
  });
}
const costUsd = sum(flat, (x) => x.costUsd ?? 0) + clusterCost;
for (const r of results) delete r._ok;
for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });

// ---- report ----------------------------------------------------------------

function clusterMarkdown(r) {
  const lines = [`## ${r.id}`, "", r.prompt, ""];
  if (r.cluster.error) return [...lines, `Error: ${r.cluster.error}`, ""].join("\n");
  lines.push(`${r.completed} samples, mean LOC ${r.meanLoc.toFixed(1)}.`, "", "### Shapes", "");
  for (const c of [...r.cluster.clusters].sort((a, b) => (b.count ?? 0) - (a.count ?? 0))) {
    lines.push(
      `- **${c.shape}** (${c.count}; samples ${(c.samples ?? []).join(", ")})`,
      "",
      "  ```ts",
      ...String(c.representative ?? "")
        .split("\n")
        .map((l) => `  ${l}`),
      "  ```",
      "",
    );
  }
  lines.push("### Recurring", "");
  for (const [k, v] of Object.entries(r.cluster.recurring)) lines.push(`- **${k}**: ${Array.isArray(v) ? v.join("; ") : v}`);
  return [...lines, ""].join("\n");
}

for (const r of results) {
  const mark = r.errors.length ? "ERROR" : "OK   ";
  if (mode === "guess") {
    const met = sum(r.expectations, (e) => e.met);
    const of = sum(r.expectations, (e) => e.of);
    const kinds =
      Object.entries(r.errorKinds)
        .filter(([, n]) => n)
        .map(([k, n]) => `${k}:${n}`)
        .join(" ") || "none";
    console.log(
      `${mark} ${r.id.padEnd(20)} compile ${r.compilePassed}/${r.completed}  expectations ${pct(met, of)}  LOC ${r.meanLoc.toFixed(1)}  errors ${kinds}`,
    );
    for (const e of r.expectations) if (e.of && e.met < e.of) console.log(`        x ${e.met}/${e.of}  ${e.text.slice(0, 100)}`);
  } else {
    console.log(`${mark} ${r.id.padEnd(20)} ${r.completed}/${r.runs} samples  LOC ${r.meanLoc.toFixed(1)}`);
  }
  for (const e of new Set(r.errors)) console.log(`        ${e}`);
}

const scored = results.filter((r) => r.completed > 0);
if (mode === "guess") {
  const done = sum(scored, (r) => r.completed);
  const met = sum(scored, (r) => sum(r.expectations, (e) => e.met));
  const of = sum(scored, (r) => sum(r.expectations, (e) => e.of));
  const kinds = {};
  for (const r of scored) for (const [k, n] of Object.entries(r.errorKinds)) kinds[k] = (kinds[k] ?? 0) + n;
  console.log(
    `\ncompile pass rate: ${sum(scored, (r) => r.compilePassed)}/${done} (${pct(
      sum(scored, (r) => r.compilePassed),
      done,
    )})`,
  );
  console.log(`expectations met:  ${met}/${of} (${pct(met, of)})`);
  console.log(`mean LOC:          ${mean(scored.map((r) => r.meanLoc)).toFixed(1)}`);
  console.log(
    `error kinds:       ${
      Object.entries(kinds)
        .map(([k, n]) => `${k}:${n}`)
        .join(" ") || "none"
    }`,
  );
} else {
  console.log(`\nmean LOC: ${mean(scored.map((r) => r.meanLoc)).toFixed(1)}`);
  const md = [`# Desire clusters: ${suite.area ?? suitePath}`, "", ...results.map(clusterMarkdown)].join("\n");
  if (mdOut) writeFileSync(mdOut, md);
  console.log(`\n${md}`);
}
const failed = results.filter((r) => r.errors.length);
if (failed.length) console.log(`\n${sum(failed, (r) => r.errors.length)} error(s) occurred; erroring runs are excluded from the totals.`);
console.log(`cost: $${costUsd.toFixed(2)}`);

if (jsonOut)
  writeFileSync(
    jsonOut,
    JSON.stringify({ suite: suite.area, mode, variant: variantPath, model, graderModel, runs, costUsd, results }, null, 2) + "\n",
  );
process.exit(failed.length ? 1 : 0);
