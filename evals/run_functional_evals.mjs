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
// Default: Claude Code CLI. Codex: --backend codex --model <pinned> --reasoning-effort <pinned>.
// Codex uses only an explicit staged MCP reader; grader calls have no tools.
// Its body-open measurements are a separate backend, not historical Claude scores.
//
// Options: --skill-dir <dir> (default skills/<name>)   --ids <a,b,c>   --limit <n>
//          --runs <n> (1)   --concurrency <n> (4)   --timeout <seconds> (600)
//          --model <id>   --grader-model <id>   --json <out-file>
//          --user-settings  (load ~/.claude: user plugins, skills, CLAUDE.md, memory; off by default)

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertNoSymlinks, copyResolved } from "./stage_skill.mjs";
import { callCodex, codexUsageJson, printCodexUsageReport } from "./codex-call.mjs";
import { codexReadStats } from "./codex-reader.mjs";
import { createUsageTracker, printUsageReport, summarizeRuns, sumUsage, attributeReads, usageJson } from "./usage.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

export function gradePrompt(item, answer) {
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

export function parseGrades(text, count) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    if (!Array.isArray(parsed.results) || parsed.results.length !== count) return null;
    const ordered = new Array(count);
    for (const r of parsed.results) {
      if (!r || !Number.isInteger(r.index) || r.index < 0 || r.index >= count || typeof r.passed !== "boolean" || ordered[r.index] !== undefined)
        return null;
      ordered[r.index] = { passed: r.passed, evidence: String(r.evidence ?? "") };
    }
    return ordered;
  } catch {
    return null;
  }
}

export const CODEX_DISCOVERY =
  "Codex-specific staged MCP skill catalog/body-open semantics; not comparable to historical native Claude Skill-tool scores";
const readerConfig = (staged) => ({
  command: process.execPath,
  args: [join(here, "codex-reader.mjs"), "--root", staged],
  allowedTools: ["open_skill", "read_file", "list_files", "search"],
});
function referenceRouting(item, references) {
  const required = item.required_references ?? [];
  if (!Array.isArray(required) || required.some((path) => typeof path !== "string" || !/^[^/]+\/references\/[^/]+\.md$/.test(path)))
    throw new TypeError("required_references must list canonical skill/reference Markdown paths.");
  const missingReferences = required.filter((path) => !references.includes(path));
  return { requiredReferences: [...required], runReferences: [...references], missingReferences, passed: missingReferences.length === 0 };
}

export async function runCodexSolver(item, { skillName, staged, model, reasoningEffort, timeoutMs, call = callCodex }) {
  referenceRouting(item, []); // Validate the declared routing contract before any model call.
  let solved;
  try {
    solved = await call({
      prompt: item.prompt,
      model,
      reasoningEffort,
      timeoutMs,
      reader: readerConfig(staged),
      systemPrompt:
        "Answer the request using the relevant staged skills when their catalog descriptions apply. The eval_reader MCP server is the only source of skill guidance. Its open_skill tool lists the exact staged descriptions; open relevant skills, then read their references as needed. All native/global skills, shell, browser and other tools are unavailable. Provide the requested answer as your final reply.",
    });
  } catch (error) {
    return { error: `solver: ${error.message}`, costUsd: null };
  }
  const readStats = codexReadStats(solved.metadata, skillName),
    context = { solverUsage: solved.usage, solverMetadata: solved.metadata, readStats, costUsd: null };
  if (readStats.errors.length) return { ...context, error: `solver reader accounting: ${readStats.errors.join("; ")}` };
  if (solved.error) return { ...context, error: `solver: ${solved.error}` };
  const answer = String(solved.text ?? "");
  if (!answer.trim()) return { ...context, error: "solver: empty answer" };
  return {
    ...context,
    answer,
    usedSkill: readStats.openedSkills.includes(skillName),
    references: readStats.references,
    turns: solved.usage?.turns,
    routing: referenceRouting(item, readStats.references),
  };
}

export async function runCodexFunctional(item, options) {
  const solved = await runCodexSolver(item, options);
  if (solved.error || !solved.routing.passed) return solved;
  const { model, graderModel = model, reasoningEffort, graderReasoningEffort = reasoningEffort, timeoutMs, call = callCodex } = options;
  const answer = solved.answer;
  let graded;
  try {
    graded = await call({
      prompt: gradePrompt(item, answer),
      model: graderModel,
      reasoningEffort: graderReasoningEffort,
      timeoutMs,
      systemPrompt: "Grade only the supplied answer and expectations. No tools, skills or external sources are available.",
    });
  } catch (error) {
    return { ...solved, error: `grader: ${error.message}` };
  }
  const gradeContext = { ...solved, graderUsage: graded.usage, graderMetadata: graded.metadata };
  if (graded.error) return { ...gradeContext, error: `grader: ${graded.error}` };
  const grades = parseGrades(String(graded.text ?? ""), item.expectations.length);
  if (!grades) return { ...gradeContext, error: "grader: reply was not the requested JSON" };
  return {
    ...gradeContext,
    grades,
  };
}

export async function main(args = process.argv.slice(2), { codexCall = callCodex } = {}) {
  const flagsWithValue = new Set([
    "skill-dir",
    "ids",
    "limit",
    "runs",
    "concurrency",
    "timeout",
    "model",
    "grader-model",
    "json",
    "backend",
    "reasoning-effort",
    "grader-reasoning-effort",
  ]);
  const skillName = args.find((a, i) => !a.startsWith("--") && !(args[i - 1]?.startsWith("--") && flagsWithValue.has(args[i - 1].slice(2))));
  const usage = (msg) => {
    if (msg) console.error(`error: ${msg}`);
    console.error(
      "usage: node evals/run_functional_evals.mjs <skill-name> [--skill-dir d] [--ids a,b] [--limit n] [--runs n] [--concurrency n] [--timeout s] [--model m] [--grader-model m] [--json f] [--backend claude|codex] [--reasoning-effort e] [--grader-reasoning-effort e] [--user-settings]",
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
  const backend = opt("backend", "claude");
  const reasoningEffort = opt("reasoning-effort", null);
  const graderReasoningEffort = opt("grader-reasoning-effort", reasoningEffort);
  if (!["claude", "codex"].includes(backend)) usage("--backend must be claude or codex");
  if (backend === "codex" && (!model?.trim() || model.startsWith("--") || !reasoningEffort?.trim() || reasoningEffort.startsWith("--")))
    usage("--backend codex requires explicit --model and --reasoning-effort");
  if (backend === "codex" && args.includes("--user-settings")) usage("--user-settings is unavailable for isolated Codex evals");
  const jsonOut = opt("json", null);
  // By default only the throwaway project's settings load, so the run measures the skill and not the
  // maintainer's installed plugins, user skills, CLAUDE.md or memory. --user-settings opts back in.
  // Historical output without a backend label came from the default Claude runner.
  if (jsonOut && existsSync(jsonOut)) {
    let previous;
    try {
      previous = JSON.parse(readFileSync(jsonOut, "utf8"));
    } catch {}
    if (previous?.results && (previous.backend ?? "claude") !== backend)
      usage("refusing to overwrite another backend's results; choose a separate --json file");
  }
  const settingSources = args.includes("--user-settings") ? "user,project,local" : "project";
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
  // References are symlinks into docs/, so the copy resolves them into real files.
  const project = mkdtempSync(join(tmpdir(), "functional-eval-"));
  const staged = join(project, ".claude", "skills");
  mkdirSync(staged, { recursive: true });
  copyResolved(skillDir, join(staged, skillName));
  for (const sibling of readdirSync(dirname(skillDir), { withFileTypes: true })) {
    const from = join(dirname(skillDir), sibling.name);
    if (!sibling.isDirectory() || sibling.name === basename(skillDir) || !existsSync(join(from, "SKILL.md"))) continue;
    copyResolved(from, join(staged, sibling.name));
  }
  assertNoSymlinks(staged);
  const graderDir = mkdtempSync(join(tmpdir(), "functional-grade-"));

  const env = { ...process.env };
  delete env.CLAUDECODE; // allow nesting claude -p inside a Claude Code session

  const SOLVER_NOTE =
    "\n\n(You can read files but cannot write files or run commands here. Put the complete answer, including all code, in your reply.)";

  // One `claude -p` run. Resolves to { text, skills, references, turns, costUsd, usage } when the
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
        "--setting-sources",
        settingSources,
      ];
      if (useModel) argv.push("--model", useModel);
      const child = spawn("claude", argv, { cwd, env, stdio: ["ignore", "pipe", "ignore"] });
      let out = "";
      let result = null;
      let timedOut = false;
      let spawnError = null;
      const tracker = createUsageTracker();
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
          tracker.feed(event);
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
          usage: tracker.finish(result),
        });
      });
    });
  }

  if (backend === "codex") assertNoSymlinks(staged);
  async function runOne(item) {
    if (backend === "codex")
      return runCodexFunctional(item, { skillName, staged, model, graderModel, reasoningEffort, graderReasoningEffort, timeoutMs, call: codexCall });
    const solved = await claude(item.prompt + SOLVER_NOTE, { cwd: project, tools: "Skill,Read,Glob,Grep", maxTurns: 40, useModel: model });
    if (solved.error) return { error: `solver: ${solved.error}` };
    const routing = referenceRouting(item, solved.references);
    const solverUsage = solved.usage;
    if (!solved.text.trim()) return { error: "solver: empty answer", solverUsage };
    if (!routing.passed) return { answer: solved.text, solverUsage, references: solved.references, routing, costUsd: solved.costUsd };
    const graded = await claude(gradePrompt(item, solved.text), { cwd: graderDir, tools: "", maxTurns: 1, useModel: graderModel });
    if (graded.error) return { error: `grader: ${graded.error}`, answer: solved.text, solverUsage };
    const grades = parseGrades(graded.text, item.expectations.length);
    if (!grades) return { error: "grader: reply was not the requested JSON", answer: solved.text, solverUsage, graderUsage: graded.usage };
    return {
      answer: solved.text,
      routing,
      usedSkill: solved.skills.some((s) => s.includes(skillName)),
      references: solved.references,
      turns: solved.turns,
      costUsd: (solved.costUsd ?? 0) + (graded.costUsd ?? 0),
      solverUsage,
      graderUsage: graded.usage,
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

  console.error(`backend: ${backend}${backend === "codex" ? ` (model ${model}, effort ${reasoningEffort}; ${CODEX_DISCOVERY})` : ""}`);
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
    // Routing failures are assessed failures, even though their grader is skipped.
    // Only incomplete calls are unknown and excluded from expectation averages.
    const assessed = mine.filter((x) => x.grades || x.routing?.passed === false);
    const expectations = item.expectations.map((text, i) => ({
      text,
      passed: completed.filter((x) => x.grades[i].passed).length,
      of: assessed.length,
      evidence: completed.map((x) => x.grades[i].evidence),
    }));
    const score = assessed.length ? expectations.reduce((sum, e) => sum + e.passed, 0) / assessed.length : 0;
    // Usage of every call that reached a result, solver and grader, including failed runs.
    const solverRuns = mine.map((x) => x.solverUsage).filter(Boolean);
    const graderRuns = mine.map((x) => x.graderUsage).filter(Boolean);
    const totalRuns = backend === "codex" ? [] : mine.filter((x) => x.solverUsage).map((x) => sumUsage([x.solverUsage, x.graderUsage]));
    return {
      id: item.id,
      prompt: item.prompt,
      errors,
      routing: mine.map((run) => run.routing ?? null),
      routingPassed: mine.every((run) => run.routing?.passed !== false),
      runs: mine.length,
      score,
      total: item.expectations.length,
      usedSkill: backend === "codex" ? mine.filter((x) => x.readStats?.usedSkill).length : completed.filter((x) => x.usedSkill).length,
      references: [
        ...new Set(backend === "codex" ? mine.flatMap((x) => x.readStats?.references ?? []) : completed.flatMap((x) => x.references)),
      ].sort(),
      costUsd: backend === "codex" ? null : mine.reduce((sum, x) => sum + (x.costUsd ?? 0), 0),
      ...(backend === "codex"
        ? { readStats: mine.map((x) => x.readStats ?? null), callMetadata: mine.map((x) => ({ solver: x.solverMetadata, grader: x.graderMetadata })) }
        : {}),
      usage: {
        solverRuns,
        graderRuns,
        perRun:
          backend === "codex"
            ? codexUsageJson([
                { label: "solver", runs: solverRuns },
                { label: "grader", runs: graderRuns },
              ])
            : summarizeRuns(totalRuns),
        sources: backend === "codex" ? mine.flatMap((x) => x.readStats?.reads ?? []) : attributeReads(solverRuns),
      },
      expectations,
      answers: mine.map((x) => x.answer ?? null),
    };
  });

  for (const r of results) {
    const mark = r.errors.length ? "ERROR" : !r.routingPassed ? "ROUTE" : r.score === r.total ? "PASS " : "PART ";
    console.log(
      `${mark} #${String(r.id).padEnd(3)} ${r.score.toFixed(1).padStart(4)}/${r.total}  skill ${r.usedSkill}/${r.runs}  ${r.prompt.slice(0, 70)}`,
    );
    r.routing.forEach((run, index) => {
      if (run && !run.passed) console.log(`        routing run ${index + 1}: missing ${run.missingReferences.join(", ")}`);
    });
    for (const e of new Set(r.errors)) console.log(`        ${e}`);
    for (const e of r.expectations) if (e.of && e.passed < e.of) console.log(`        ✗ ${e.passed}/${e.of}  ${e.text.slice(0, 110)}`);
  }
  const scored = results.filter((r) => r.expectations.some((e) => e.of > 0));
  const sum = (xs, f) => xs.reduce((n, x) => n + f(x), 0);
  console.log(`\nexpectations met: ${sum(scored, (r) => r.score).toFixed(1)}/${sum(scored, (r) => r.total)}`);
  console.log(`evals fully met:  ${scored.filter((r) => !r.errors.length && r.routingPassed && r.score === r.total).length}/${scored.length}`);
  const routingFailures = results.filter((r) => !r.routingPassed);
  console.log(
    `routing failures: ${routingFailures.length} eval(s), ${sum(routingFailures, (r) => r.routing.filter((run) => run?.passed === false).length)} run(s); counted as unmet above.`,
  );
  const incomplete = results.filter((r) => r.errors.length);
  if (incomplete.length)
    console.log(
      `incomplete calls: ${incomplete.length} eval(s), ${sum(incomplete, (r) => r.errors.length)} run(s); excluded from expectation averages and fail the run.`,
    );
  console.log(
    backend === "codex"
      ? "cost: unavailable (Codex CLI reports tokens, not USD; excluded from Claude budgets)"
      : `cost: $${sum(results, (r) => r.costUsd).toFixed(2)}`,
  );

  // Per eval: solver + grader per run. Reads are attributed from the solver only (the grader has no tools).
  const usageRows =
    backend === "codex"
      ? [
          { label: "solver", runs: flat.map((x) => x.solverUsage).filter(Boolean) },
          { label: "grader", runs: flat.map((x) => x.graderUsage).filter(Boolean) },
        ]
      : results.map((r, ei) => ({
          label: `#${r.id}`,
          runs: flat.filter((x) => x.ei === ei && x.solverUsage).map((x) => sumUsage([x.solverUsage, x.graderUsage])),
        }));
  if (backend === "codex") printCodexUsageReport(usageRows);
  else printUsageReport(usageRows);
  const graderShare = backend === "codex" ? null : flat.filter((x) => x.graderUsage).reduce((n, x) => n + x.graderUsage.costUsd, 0);
  if (backend !== "codex") console.log(`\nof which grader calls: $${graderShare.toFixed(3)}`);

  if (jsonOut)
    writeFileSync(
      jsonOut,
      JSON.stringify(
        {
          skill: skillName,
          skillDir,
          model,
          graderModel,
          runs,
          backend,
          ...(backend === "codex" ? { reasoningEffort, graderReasoningEffort, discovery: CODEX_DISCOVERY } : {}),
          usage: { ...(backend === "codex" ? codexUsageJson(usageRows) : usageJson(usageRows)), graderCostUsd: graderShare },
          results,
        },
        null,
        2,
      ) + "\n",
    );
  return results.every((r) => !r.errors.length && r.routingPassed) ? 0 : 1;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main();
