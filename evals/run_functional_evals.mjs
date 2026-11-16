#!/usr/bin/env node
// Functional evals: with the skill installed, does Claude Code answer the prompts in
// evals/<skill>/evals.json in a way that meets each prompt's expectations?
//
//   node evals/run_functional_evals.mjs audiorective --json /tmp/after.json
//   node evals/run_functional_evals.mjs audiorective --skill-dir /path/to/old/skills/audiorective --json /tmp/before.json
//   node evals/run_functional_evals.mjs audiorective --ids 3,16,20 --runs 2
//
// Each prompt is answered by `claude -p` in a throwaway project whose .claude/skills/
// holds a dereferenced copy of the skill under test and its sibling skills. The solver
// can only read (Skill, Read, Glob, Grep), so its answer is its final reply. A second,
// separate `claude -p` call with no tools and no skill grades that reply against the
// expectations and never learns which version of the skill produced it.
// Requires the Claude Code CLI on PATH and a login.
//
// Options: --skill-dir <dir> (default skills/<name>)   --ids <a,b,c>   --limit <n>
//          --runs <n> (1)   --concurrency <n> (4)   --timeout <seconds> (600)
//          --model <id>   --grader-model <id>   --json <out-file>

import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

const args = process.argv.slice(2);
const flagsWithValue = new Set(["skill-dir", "ids", "limit", "runs", "concurrency", "timeout", "model", "grader-model", "json"]);
const skillName = args.find((a, i) => !a.startsWith("--") && !(args[i - 1]?.startsWith("--") && flagsWithValue.has(args[i - 1].slice(2))));
const usage = (msg) => {
  if (msg) console.error(`error: ${msg}`);
  console.error(
    "usage: node evals/run_functional_evals.mjs <skill-name> [--skill-dir d] [--ids a,b] [--limit n] [--runs n] [--concurrency n] [--timeout s] [--model m] [--grader-model m] [--json f]",
  );
  process.exit(2);
};
if (!skillName) usage();
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
const skillDir = resolve(opt("skill-dir", join(repoRoot, "skills", skillName)));
const runs = positiveInt("runs", 1);
const concurrency = positiveInt("concurrency", 4);
const timeoutMs = positiveInt("timeout", 600) * 1000;
const model = opt("model", null);
const graderModel = opt("grader-model", model);
const jsonOut = opt("json", null);
const ids = opt("ids", null)
  ?.split(",")
  .map((s) => Number(s.trim()));
const limit = args.includes("--limit") ? positiveInt("limit") : Infinity;

if (!existsSync(join(skillDir, "SKILL.md"))) usage(`no SKILL.md in ${skillDir}`);
let evalSet = JSON.parse(readFileSync(join(here, skillName, "evals.json"), "utf8")).evals;
if (ids) evalSet = evalSet.filter((e) => ids.includes(e.id));
evalSet = evalSet.slice(0, limit);
if (evalSet.length === 0) usage(`no matching evals in evals/${skillName}/evals.json`);

// Stage the skill (and its siblings, which it may route to) in an empty project.
// References are symlinks into docs/, so the copy dereferences them.
const project = mkdtempSync(join(tmpdir(), "functional-eval-"));
const staged = join(project, ".claude", "skills");
mkdirSync(staged, { recursive: true });
cpSync(skillDir, join(staged, skillName), { recursive: true, dereference: true });
for (const sibling of readdirSync(dirname(skillDir), { withFileTypes: true })) {
  const from = join(dirname(skillDir), sibling.name);
  if (!sibling.isDirectory() || sibling.name === basename(skillDir) || !existsSync(join(from, "SKILL.md"))) continue;
  cpSync(from, join(staged, sibling.name), { recursive: true, dereference: true });
}
const graderDir = mkdtempSync(join(tmpdir(), "functional-grade-"));

const env = { ...process.env };
delete env.CLAUDECODE; // allow nesting claude -p inside a Claude Code session

const SOLVER_NOTE =
  "\n\n(You can read files but cannot write files or run commands here. Put the complete answer, including all code, in your reply.)";

// One `claude -p` run. Resolves to { text, skills, references, turns, costUsd } when the
// run completed, and { error } when it did not (timeout, CLI failure, no result event).
function claude(prompt, { cwd, tools, maxTurns, useModel }) {
  return new Promise((done) => {
    const argv = [
      "-p",
      prompt,
      "--output-format",
      "stream-json",
      "--verbose",
      "--max-turns",
      String(maxTurns),
      "--strict-mcp-config",
      "--tools",
      tools,
    ];
    if (useModel) argv.push("--model", useModel);
    const child = spawn("claude", argv, { cwd, env, stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    let result = null;
    let timedOut = false;
    let spawnError = null;
    const skills = new Set();
    const references = new Set();
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.on("error", (err) => (spawnError = err));
    child.stdout.on("data", (chunk) => {
      out += chunk;
      let nl;
      while ((nl = out.indexOf("\n")) !== -1) {
        const line = out.slice(0, nl);
        out = out.slice(nl + 1);
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }
        if (event.type === "result") result = event;
        const blocks = event?.message?.content;
        if (event.type !== "assistant" || !Array.isArray(blocks)) continue;
        for (const b of blocks) {
          if (b.type !== "tool_use") continue;
          if (b.name === "Skill") skills.add(String(b.input?.skill ?? b.input?.command ?? ""));
          const path = b.name === "Read" ? String(b.input?.file_path ?? "") : "";
          const at = path.indexOf("/.claude/skills/");
          if (at !== -1) references.add(path.slice(at + "/.claude/skills/".length));
        }
      }
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (spawnError) return done({ error: `could not start claude: ${spawnError.message}` });
      if (timedOut) return done({ error: `timed out after ${timeoutMs / 1000}s` });
      if (!result) return done({ error: `claude exited without a result (code ${code}, signal ${signal})` });
      if (result.is_error || result.terminal_reason === "api_error" || result.api_error)
        return done({ error: `claude reported ${result.api_error ?? result.terminal_reason ?? "an error"}` });
      if (result.subtype !== "success") return done({ error: `claude reported ${result.subtype}` });
      done({
        text: String(result.result ?? ""),
        skills: [...skills],
        references: [...references].sort(),
        turns: result.num_turns,
        costUsd: result.total_cost_usd,
      });
    });
  });
}

function gradePrompt(item, answer) {
  return [
    "You are grading one answer against a fixed list of expectations. Judge only what the answer actually contains.",
    "An expectation passes only if the answer clearly satisfies it; if the answer is silent on something the expectation requires, it fails.",
    'Where an expectation says "or an equivalent", accept any approach that achieves the same thing.',
    'Reply with JSON only, no prose and no code fence: {"results":[{"index":0,"passed":true,"evidence":"short quote or reason"}, ...]} with one entry per expectation, in order.',
    "",
    "## Request the answer responds to",
    item.prompt,
    "",
    "## Expectations",
    ...item.expectations.map((e, i) => `${i}. ${e}`),
    "",
    "## Answer",
    answer,
  ].join("\n");
}

function parseGrades(text, count) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    if (!Array.isArray(parsed.results) || parsed.results.length !== count) return null;
    return parsed.results.map((r) => ({ passed: r.passed === true, evidence: String(r.evidence ?? "") }));
  } catch {
    return null;
  }
}

async function runOne(item) {
  const solved = await claude(item.prompt + SOLVER_NOTE, { cwd: project, tools: "Skill,Read,Glob,Grep", maxTurns: 40, useModel: model });
  if (solved.error) return { error: `solver: ${solved.error}` };
  if (!solved.text.trim()) return { error: "solver: empty answer" };
  const graded = await claude(gradePrompt(item, solved.text), { cwd: graderDir, tools: "", maxTurns: 1, useModel: graderModel });
  if (graded.error) return { error: `grader: ${graded.error}`, answer: solved.text };
  const grades = parseGrades(graded.text, item.expectations.length);
  if (!grades) return { error: "grader: reply was not the requested JSON", answer: solved.text };
  return {
    answer: solved.text,
    usedSkill: solved.skills.some((s) => s.includes(skillName)),
    references: solved.references,
    turns: solved.turns,
    costUsd: (solved.costUsd ?? 0) + (graded.costUsd ?? 0),
    grades,
  };
}

async function pool(tasks, size) {
  const results = new Array(tasks.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, tasks.length) }, async () => {
      while (next < tasks.length) {
        const i = next++;
        results[i] = await tasks[i]();
      }
    }),
  );
  return results;
}

console.error(`skill: ${skillName}  (${skillDir})`);
console.error(`${evalSet.length} evals × ${runs} runs, concurrency ${concurrency}${model ? `, model ${model}` : ""}…`);

const tasks = [];
for (const [ei, item] of evalSet.entries()) for (let r = 0; r < runs; r++) tasks.push(async () => ({ ei, ...(await runOne(item)) }));
const flat = await pool(tasks, concurrency);
rmSync(project, { recursive: true, force: true });
rmSync(graderDir, { recursive: true, force: true });

const results = evalSet.map((item, ei) => {
  const mine = flat.filter((x) => x.ei === ei);
  const errors = mine.filter((x) => x.error).map((x) => x.error);
  const completed = mine.filter((x) => x.grades);
  // An expectation's score is the share of completed runs in which it passed.
  const expectations = item.expectations.map((text, i) => ({
    text,
    passed: completed.filter((x) => x.grades[i].passed).length,
    of: completed.length,
    evidence: completed.map((x) => x.grades[i].evidence),
  }));
  const score = completed.length ? expectations.reduce((sum, e) => sum + e.passed / e.of, 0) : 0;
  return {
    id: item.id,
    prompt: item.prompt,
    errors,
    runs: mine.length,
    score,
    total: item.expectations.length,
    usedSkill: completed.filter((x) => x.usedSkill).length,
    references: [...new Set(completed.flatMap((x) => x.references))].sort(),
    costUsd: mine.reduce((sum, x) => sum + (x.costUsd ?? 0), 0),
    expectations,
    answers: mine.map((x) => x.answer ?? null),
  };
});

for (const r of results) {
  const mark = r.errors.length ? "ERROR" : r.score === r.total ? "PASS " : "PART ";
  console.log(
    `${mark} #${String(r.id).padEnd(3)} ${r.score.toFixed(1).padStart(4)}/${r.total}  skill ${r.usedSkill}/${r.runs}  ${r.prompt.slice(0, 70)}`,
  );
  for (const e of new Set(r.errors)) console.log(`        ${e}`);
  for (const e of r.expectations) if (e.of && e.passed < e.of) console.log(`        ✗ ${e.passed}/${e.of}  ${e.text.slice(0, 110)}`);
}
const scored = results.filter((r) => !r.errors.length);
const sum = (xs, f) => xs.reduce((n, x) => n + f(x), 0);
console.log(`\nexpectations met: ${sum(scored, (r) => r.score).toFixed(1)}/${sum(scored, (r) => r.total)}`);
console.log(`evals fully met:  ${scored.filter((r) => r.score === r.total).length}/${scored.length}`);
if (results.length !== scored.length)
  console.log(`${results.length - scored.length} eval(s) had runs that did not complete; they are excluded above and fail the run.`);
console.log(`cost: $${sum(results, (r) => r.costUsd).toFixed(2)}`);

if (jsonOut) writeFileSync(jsonOut, JSON.stringify({ skill: skillName, skillDir, model, graderModel, runs, results }, null, 2) + "\n");
process.exit(results.every((r) => !r.errors.length) ? 0 : 1);
