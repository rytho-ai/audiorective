// Token and cost accounting shared by the eval runners.
//
// `claude -p --output-format stream-json --verbose` gives us:
//   - every assistant event: message.usage (input / cache creation / cache read / output tokens)
//   - every tool_use block (name, input) and its tool_result (content), so Read results can be sized
//   - for the Skill tool, a synthetic user text block starting "Base directory for this skill: <dir>"
//     that carries the whole SKILL.md body
//   - the final result event: usage (summed), total_cost_usd, num_turns and modelUsage
//     (per model: tokens, costUSD, and the 5m / 1h cache-creation split)
// The CLI reports cost per model, not per token category. Per-category cost is therefore an
// ESTIMATE: tokens x the price table below, rescaled so the categories sum to the CLI's reported
// costUSD for that model (`costScale` records how far the table was from the reported number).

// USD per million tokens. Estimates, last checked 2026-11-20 by fitting the cost the CLI reported
// for claude-sonnet-5-5 runs (input 2, output 10, 1h cache write 4, cache read 0.1 reproduce
// total_cost_usd to the cent). The 5m cache-write price is an assumption (1.25 x input), and the
// other models are unverified; for a model not listed here the sonnet-5-5 row is used and the
// result is rescaled to the reported cost, so only the category shares are approximate.
export const PRICES_PER_MTOK = {
  "claude-sonnet-5-5": { input: 2, cacheWrite5m: 2.5, cacheWrite1h: 4, cacheRead: 0.1, output: 10 },
};
const FALLBACK_PRICE_KEY = "claude-sonnet-5-5";

export const CATEGORIES = ["input", "cacheCreation", "cacheRead", "output"];
export const CATEGORY_LABELS = { input: "input", cacheCreation: "cache write", cacheRead: "cache read", output: "output" };

const emptyTokens = () => ({ input: 0, cacheCreation: 0, cacheRead: 0, output: 0 });
const emptyCost = () => ({ input: 0, cacheCreation: 0, cacheRead: 0, output: 0 });
export const estimateTokens = (chars) => Math.round(chars / 4); // rough: ~4 characters per token

function resultText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((b) => (typeof b?.text === "string" ? b.text : "")).join("");
  return "";
}

// Mirrors the stream of one `claude -p` run. Call feed(event) for every parsed JSON line, then
// finish(resultEvent) to get the usage record.
export function createUsageTracker() {
  const pendingReads = new Map(); // tool_use id -> file_path
  const toolCalls = {};
  const reads = []; // { path, chars, via }
  return {
    feed(event) {
      if (event?.type === "assistant" && Array.isArray(event.message?.content)) {
        for (const b of event.message.content) {
          if (b.type !== "tool_use") continue;
          toolCalls[b.name] = (toolCalls[b.name] ?? 0) + 1;
          if (b.name === "Read") pendingReads.set(b.id, String(b.input?.file_path ?? ""));
        }
      } else if (event?.type === "user" && Array.isArray(event.message?.content)) {
        for (const b of event.message.content) {
          if (b.type === "tool_result" && pendingReads.has(b.tool_use_id)) {
            reads.push({ path: pendingReads.get(b.tool_use_id), chars: resultText(b.content).length, via: "Read" });
            pendingReads.delete(b.tool_use_id);
          } else if (b.type === "text" && typeof b.text === "string") {
            const m = /^Base directory for this skill: (.+)\n/.exec(b.text);
            if (m) reads.push({ path: `${m[1]}/SKILL.md`, chars: b.text.length, via: "Skill" });
          }
        }
      }
    },
    finish(result) {
      const modelUsage = result?.modelUsage ?? {};
      const tokens = emptyTokens();
      const categoryCostUsd = emptyCost();
      const models = {};
      let estimated = 0;
      for (const [name, m] of Object.entries(modelUsage)) {
        const t = {
          input: m.inputTokens ?? 0,
          cacheCreation: m.cacheCreationInputTokens ?? 0,
          cacheRead: m.cacheReadInputTokens ?? 0,
          output: m.outputTokens ?? 0,
        };
        const p = PRICES_PER_MTOK[name] ?? PRICES_PER_MTOK[FALLBACK_PRICE_KEY];
        const w1h = m.cacheCreationEphemeral1hInputTokens;
        const w5m = m.cacheCreationEphemeral5mInputTokens;
        const split = w1h != null && w5m != null && w1h + w5m === t.cacheCreation;
        const raw = {
          input: (t.input * p.input) / 1e6,
          cacheCreation: split ? (w1h * p.cacheWrite1h + w5m * p.cacheWrite5m) / 1e6 : (t.cacheCreation * p.cacheWrite5m) / 1e6,
          cacheRead: (t.cacheRead * p.cacheRead) / 1e6,
          output: (t.output * p.output) / 1e6,
        };
        const rawTotal = CATEGORIES.reduce((n, c) => n + raw[c], 0);
        const reported = m.costUSD ?? 0;
        const costScale = rawTotal > 0 && reported > 0 ? reported / rawTotal : 1;
        for (const c of CATEGORIES) {
          tokens[c] += t[c];
          categoryCostUsd[c] += raw[c] * costScale;
        }
        estimated += rawTotal;
        models[name] = { tokens: t, costUsd: reported, costScale, priced: name in PRICES_PER_MTOK };
      }
      // Without modelUsage (older CLI), fall back to the summed usage block and the table.
      if (!Object.keys(modelUsage).length && result?.usage) {
        const u = result.usage;
        tokens.input = u.input_tokens ?? 0;
        tokens.cacheCreation = u.cache_creation_input_tokens ?? 0;
        tokens.cacheRead = u.cache_read_input_tokens ?? 0;
        tokens.output = u.output_tokens ?? 0;
        const p = PRICES_PER_MTOK[FALLBACK_PRICE_KEY];
        categoryCostUsd.input = (tokens.input * p.input) / 1e6;
        categoryCostUsd.cacheCreation = (tokens.cacheCreation * p.cacheWrite5m) / 1e6;
        categoryCostUsd.cacheRead = (tokens.cacheRead * p.cacheRead) / 1e6;
        categoryCostUsd.output = (tokens.output * p.output) / 1e6;
        estimated = CATEGORIES.reduce((n, c) => n + categoryCostUsd[c], 0);
      }
      return {
        tokens,
        costUsd: result?.total_cost_usd ?? 0,
        categoryCostUsd,
        estimatedCostUsd: estimated, // table-only estimate before rescaling, for sanity checks
        models,
        turns: result?.num_turns ?? 0,
        toolCalls,
        reads: reads.map((r) => ({ ...r, estTokens: estimateTokens(r.chars) })),
      };
    },
  };
}

// Sum usage records (solver + grader, or many runs) into one record.
export function sumUsage(records) {
  const out = { tokens: emptyTokens(), costUsd: 0, categoryCostUsd: emptyCost(), turns: 0, toolCalls: {}, reads: [] };
  for (const u of records) {
    if (!u) continue;
    for (const c of CATEGORIES) {
      out.tokens[c] += u.tokens[c];
      out.categoryCostUsd[c] += u.categoryCostUsd[c];
    }
    out.costUsd += u.costUsd;
    out.turns += u.turns;
    for (const [k, v] of Object.entries(u.toolCalls)) out.toolCalls[k] = (out.toolCalls[k] ?? 0) + v;
    out.reads.push(...u.reads);
  }
  return out;
}

export const toolCallCount = (u) => Object.values(u.toolCalls).reduce((n, v) => n + v, 0);
export const totalInputTokens = (u) => u.tokens.input + u.tokens.cacheCreation + u.tokens.cacheRead;

// mean / min / max of a list of numbers.
export function stats(xs) {
  if (!xs.length) return { mean: 0, min: 0, max: 0 };
  return { mean: xs.reduce((a, b) => a + b, 0) / xs.length, min: Math.min(...xs), max: Math.max(...xs) };
}

// Per-run summary rows -> { metric: {mean,min,max} }. `runs` are usage records.
export function summarizeRuns(runs) {
  const per = {
    costUsd: runs.map((u) => u.costUsd),
    turns: runs.map((u) => u.turns),
    toolCalls: runs.map(toolCallCount),
    totalInputTokens: runs.map(totalInputTokens),
  };
  for (const c of CATEGORIES) per[c] = runs.map((u) => u.tokens[c]);
  return Object.fromEntries(Object.entries(per).map(([k, v]) => [k, stats(v)]));
}

// Where did input go? Group Read/Skill results by file (skill-relative path when it lives in a
// staged .claude/skills/ tree), per run averaged so --runs does not inflate the picture.
export function attributeReads(runs) {
  const map = new Map();
  for (const u of runs) {
    for (const r of u.reads) {
      const at = r.path.indexOf("/.claude/skills/");
      const key = at === -1 ? r.path : r.path.slice(at + "/.claude/skills/".length);
      const e = map.get(key) ?? { path: key, reads: 0, chars: 0, estTokens: 0, runsWith: new Set() };
      e.reads++;
      e.chars += r.chars;
      e.estTokens += r.estTokens;
      e.runsWith.add(u);
      map.set(key, e);
    }
  }
  return [...map.values()]
    .map((e) => ({
      path: e.path,
      reads: e.reads,
      runsWith: e.runsWith.size,
      chars: e.chars,
      estTokens: e.estTokens,
      meanCharsPerRun: Math.round(e.chars / (runs.length || 1)),
    }))
    .sort((a, b) => b.chars - a.chars);
}

const usd = (n) => `$${n.toFixed(n < 1 ? 3 : 2)}`;
const k = (n) => (n >= 10000 ? `${(n / 1000).toFixed(0)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n)));
const range = (s, f) => `${f(s.mean)} (${f(s.min)}-${f(s.max)})`;

// Text tables. `rows` = [{ label, runs: [usage records] }].
export function printUsageReport(rows, { title = "Token and cost breakdown" } = {}) {
  const all = rows.flatMap((r) => r.runs);
  if (!all.length) return;
  console.log(`\n${title}  (per run: mean, with min-max in parentheses; tokens are means)`);
  const head = ["eval", "runs", "cost", "turns", "tools", "input", "cache wr", "cache rd", "output"];
  const table = rows
    .filter((r) => r.runs.length)
    .map((r) => {
      const s = summarizeRuns(r.runs);
      return [
        r.label,
        String(r.runs.length),
        range(s.costUsd, usd),
        range(s.turns, (n) => String(Math.round(n))),
        range(s.toolCalls, (n) => String(Math.round(n))),
        k(s.input.mean),
        k(s.cacheCreation.mean),
        k(s.cacheRead.mean),
        k(s.output.mean),
      ];
    });
  const widths = head.map((h, i) => Math.max(h.length, ...table.map((r) => r[i].length)));
  const line = (cells) => cells.map((c, i) => (i === 0 ? c.padEnd(widths[i]) : c.padStart(widths[i]))).join("  ");
  console.log(line(head));
  for (const r of table) console.log(line(r));

  const total = sumUsage(all);
  console.log(
    `\nshare of cost by category (estimated from the price table in evals/usage.mjs, rescaled to the reported total ${usd(total.costUsd)}):`,
  );
  for (const c of CATEGORIES) {
    const share = total.costUsd ? (total.categoryCostUsd[c] / total.costUsd) * 100 : 0;
    console.log(
      `  ${CATEGORY_LABELS[c].padEnd(12)} ${usd(total.categoryCostUsd[c]).padStart(8)}  ${share.toFixed(1).padStart(5)}%   ${k(total.tokens[c]).padStart(7)} tokens`,
    );
  }

  const attrib = attributeReads(all);
  if (attrib.length) {
    console.log(`\ncontext loaded by Skill/Read results (chars; ~tokens = chars/4; per-run mean over ${all.length} run(s)):`);
    for (const a of attrib.slice(0, 15))
      console.log(
        `  ${k(a.meanCharsPerRun).padStart(7)} chars  ~${k(a.meanCharsPerRun / 4).padStart(6)} tok  in ${a.runsWith}/${all.length} runs  ${a.path}`,
      );
    if (attrib.length > 15) console.log(`  ... ${attrib.length - 15} more in the JSON`);
  }
}

// JSON block for --json output.
export function usageJson(rows) {
  const all = rows.flatMap((r) => r.runs);
  const total = sumUsage(all);
  return {
    priceTableUsdPerMTok: PRICES_PER_MTOK,
    note: "category costs are estimates: tokens x price table, rescaled to the CLI's reported per-model costUSD",
    runs: all.length,
    tokens: total.tokens,
    costUsd: total.costUsd,
    categoryCostUsd: total.categoryCostUsd,
    categoryShare: Object.fromEntries(CATEGORIES.map((c) => [c, total.costUsd ? total.categoryCostUsd[c] / total.costUsd : 0])),
    turns: total.turns,
    toolCalls: total.toolCalls,
    sources: attributeReads(all),
  };
}
