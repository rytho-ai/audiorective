// Isolated Codex CLI calls for evals. Authentication stays with the installed CLI;
// no user config, project instructions, skills, memories or previous thread is loaded.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TOKEN_FIELDS = ["input_tokens", "cached_input_tokens", "cache_write_input_tokens", "output_tokens", "reasoning_output_tokens"];
const DISABLED_FEATURES = [
  "shell_tool",
  "apps",
  "plugins",
  "hooks",
  "browser_use",
  "computer_use",
  "image_generation",
  "view_image",
  "multi_agent",
  "multi_agent_v2",
  "goals",
  "sleep_tool",
  "skill_search",
  "memories",
];
const UNDER_DEVELOPMENT_WARNING =
  /^Under-development features enabled: (?:skip_host_skill_discovery|omit_skill_descriptions)(?:, (?:skip_host_skill_discovery|omit_skill_descriptions))*\./;
const emptyTokens = () => Object.fromEntries(TOKEN_FIELDS.map((field) => [field, null]));
const tokensFrom = (usage) =>
  Object.fromEntries(TOKEN_FIELDS.map((field) => [field, Number.isInteger(usage?.[field]) && usage[field] >= 0 ? usage[field] : null]));

/**
 * One new, isolated thread. `model` and `reasoningEffort` must be explicit so
 * baseline and candidate do not depend on the maintainer's changing defaults.
 * An optional reader is the only permitted tool server; shell remains disabled.
 * USD is unknown, not zero: this CLI reports actual tokens but no billing field.
 */
export async function callCodex({
  prompt,
  model,
  reasoningEffort,
  systemPrompt = "",
  timeoutMs = 300_000,
  executable = "codex",
  env = process.env,
  reader,
}) {
  if (typeof model !== "string" || !model.trim()) throw new TypeError("Codex eval calls require an explicit model.");
  if (typeof reasoningEffort !== "string" || !reasoningEffort.trim()) throw new TypeError("Codex eval calls require an explicit reasoningEffort.");
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new RangeError("Codex eval timeoutMs must be positive.");
  if (
    reader &&
    (typeof reader.command !== "string" ||
      !reader.command ||
      !Array.isArray(reader.args) ||
      !reader.args.every((arg) => typeof arg === "string") ||
      !Array.isArray(reader.allowedTools) ||
      !reader.allowedTools.length ||
      !reader.allowedTools.every((name) => typeof name === "string" && name))
  )
    throw new TypeError("Codex eval reader requires command, args and a nonempty allowedTools whitelist.");
  const cwd = mkdtempSync(join(tmpdir(), "codex-eval-"));
  const args = [
    "exec",
    "--ignore-user-config",
    "--ignore-rules",
    "--ephemeral",
    "--skip-git-repo-check",
    "--sandbox",
    "read-only",
    "--json",
    "--model",
    model,
    "--config",
    `model_reasoning_effort=${JSON.stringify(reasoningEffort)}`,
    "--config",
    "project_doc_max_bytes=0",
    "--config",
    'web_search="disabled"',
    "--enable",
    "skip_host_skill_discovery",
    "--enable",
    "omit_skill_descriptions",
    ...DISABLED_FEATURES.flatMap((feature) => ["--disable", feature]),
    "--config",
    reader
      ? `mcp_servers={eval_reader={command=${JSON.stringify(reader.command)},args=${JSON.stringify(reader.args)},enabled_tools=${JSON.stringify(reader.allowedTools)},default_tools_approval_mode="approve"}}`
      : "mcp_servers={}",
    "--",
    ...(systemPrompt ? [`${systemPrompt}\n\n${prompt}`] : [prompt]),
  ];
  const childEnv = { ...env };
  delete childEnv.CLAUDECODE;
  delete childEnv.CODEX_THREAD_ID;
  delete childEnv.CODEX_PARENT_THREAD_ID;
  const metadata = {
    backend: "codex",
    model,
    reasoningEffort,
    isolation: "fresh scratch cwd; no user config, rules, project docs, skills, memories or history",
    allowedTools: reader ? reader.allowedTools.map((tool) => `eval_reader.${tool}`) : [],
    readerCalls: [],
    readerErrors: [],
  };
  return await new Promise((resolve) => {
    let child;
    let pending = "";
    let stderr = "";
    let finalText;
    let completed = 0;
    let failure;
    let timedOut = false;
    let timer;
    let tokens = emptyTokens();
    const calls = new Map();
    const reject = (message) => {
      failure ??= message;
      child?.kill("SIGKILL");
    };
    const parseLine = (line) => {
      if (!line.trim()) return;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        reject("Codex emitted invalid JSONL");
        return;
      }
      if (!event || typeof event !== "object" || typeof event.type !== "string") {
        reject("Codex emitted invalid JSONL event");
        return;
      }
      if (event.type === "turn.failed" || event.type === "error") {
        reject(`Codex reported ${event.error?.message ?? event.message ?? JSON.stringify(event.error ?? event)}`);
        return;
      }
      if (event.type === "thread.started") metadata.threadId = event.thread_id;
      if (event.type === "turn.completed") {
        completed++;
        tokens = tokensFrom(event.usage);
        if (completed !== 1) reject("Codex emitted more than one completed turn");
        return;
      }
      if (!String(event.type).startsWith("item.")) return;
      const item = event.item ?? (event.type === "item.error" ? { type: "error", message: event.message ?? event.error?.message } : null);
      if (!item) {
        reject("Codex emitted an item without its type");
        return;
      }
      if (item.type === "error") {
        if (!UNDER_DEVELOPMENT_WARNING.test(item.message ?? "")) reject(`Codex reported ${item.message ?? "an item error"}`);
        return;
      }
      if (item.type === "mcp_tool_call" && reader && item.server === "eval_reader" && reader.allowedTools.includes(item.tool)) {
        if (event.type === "item.completed" && (item.status === "failed" || item.error || item.result?.isError)) {
          metadata.readerErrors.push({ tool: item.tool, arguments: item.arguments ?? {} });
        } else if (event.type === "item.completed") {
          const structured = item.result?.structuredContent ?? item.result?.structured_content;
          const structuredContent =
            structured &&
            Object.fromEntries(
              ["path", "skill", "kind", "bytes", "chars", "resultCount", "filesScanned", "bytesScanned", "charsReturned", "truncated"]
                .filter((key) => Object.hasOwn(structured, key))
                .map((key) => [key, structured[key]]),
            );
          calls.set(item.id ?? metadata.readerCalls.length, {
            tool: item.tool,
            arguments: item.arguments ?? {},
            ...(structuredContent ? { structuredContent } : {}),
          });
          metadata.readerCalls = [...calls.values()];
        }
        return;
      }
      if (item.type !== "agent_message" && item.type !== "reasoning") {
        reject(`Codex isolation violation: unexpected ${item.type ?? "unknown"} item${item.server ? ` (${item.server}.${item.tool})` : ""}`);
        return;
      }
      if (event.type === "item.completed" && item.type === "agent_message" && typeof item.text === "string") finalText = item.text;
    };
    const finish = (code, signal) => {
      clearTimeout(timer);
      if (pending.trim()) parseLine(pending);
      rmSync(cwd, { recursive: true, force: true });
      const usage = {
        backend: "codex",
        tokens,
        costUsd: null,
        turns: completed,
        note: "Actual Codex CLI token fields; input_tokens includes cached input. Missing token fields remain null. USD billing is not reported.",
      };
      if (timedOut) failure = `Codex timed out after ${timeoutMs / 1000}s`;
      else if (!failure && code !== 0) failure = `Codex exited with code ${code}, signal ${signal}${stderr ? `: ${stderr.slice(0, 400)}` : ""}`;
      else if (!failure && completed !== 1) failure = "Codex exited without a completed turn";
      else if (!failure && (tokens.input_tokens === null || tokens.output_tokens === null)) failure = "Codex completed without valid token usage";
      else if (!failure && (finalText === undefined || !finalText.trim())) failure = "Codex completed without a final agent message";
      if (reader && !failure && metadata.readerErrors.length) failure = "Codex eval reader call failed";
      if (reader && !failure && /MCP tool call requires approval[\s\S]*approval policy is never/i.test(finalText ?? ""))
        failure = "Codex eval reader blocked: MCP tool call requires approval, but approval policy is never";
      resolve({ ...(failure ? { error: failure } : { text: finalText }), costUsd: null, usage, metadata });
    };
    try {
      // stdin must be closed: a piped inherited stdin makes `codex exec` wait for EOF.
      child = spawn(executable, args, { cwd, env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
      timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, timeoutMs);
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.on("error", (error) => {
        failure = `could not start Codex: ${error.message}`;
      });
      child.stderr.on("data", (data) => {
        stderr = (stderr + data).slice(-4000);
      });
      child.stdout.on("data", (data) => {
        pending += data;
        let newline;
        while ((newline = pending.indexOf("\n")) !== -1) {
          const line = pending.slice(0, newline);
          pending = pending.slice(newline + 1);
          parseLine(line);
        }
      });
      child.on("close", finish);
    } catch (error) {
      failure = `could not start Codex: ${error.message}`;
      finish(null, null);
    }
  });
}

const sumTokens = (runs) =>
  Object.fromEntries(
    TOKEN_FIELDS.map((field) => [
      field,
      runs.length && runs.every((run) => run.tokens?.[field] !== null && run.tokens?.[field] !== undefined)
        ? runs.reduce((sum, run) => sum + run.tokens[field], 0)
        : null,
    ]),
  );

export function codexUsageJson(rows) {
  const runs = rows.flatMap((row) => row.runs);
  return {
    backend: "codex",
    runs: runs.length,
    tokens: sumTokens(runs),
    costUsd: null,
    note: "Actual Codex CLI tokens; input_tokens includes cached input. USD billing is not reported and is excluded from Claude eval budgets. No price-table estimates.",
    byRole: rows.map(({ label, runs }) => ({ label, calls: runs.length, tokens: sumTokens(runs), costUsd: null })),
  };
}

export function printCodexUsageReport(rows) {
  const usage = codexUsageJson(rows);
  console.log("\nCodex actual tokens by call role (USD billing unavailable; no Claude price estimate):");
  for (const row of usage.byRole.filter((row) => row.calls)) console.log(`${row.label}: ${row.calls} call(s) ${JSON.stringify(row.tokens)}`);
}
