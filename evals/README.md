# Skill evals

Test sets for the agent skills in [`skills/`](../skills). One directory per skill:

| File                | What it checks                                                                                                             |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `trigger_eval.json` | Whether the skill's `description` makes an agent open the skill for the right requests and leave it alone for near-misses. |
| `evals.json`        | Whether an agent _with_ the skill produces correct output: realistic prompts, each with verifiable expectations.           |

Both files follow the [skill-creator](https://github.com/anthropics/skills/tree/main/skills/skill-creator) schemas, which the ElevenLabs skills repo also uses, so any harness built for that format runs them.

## Running trigger evals

`run_trigger_evals.mjs` sends every query to Claude Code (`claude -p`) from a throwaway project whose `.claude/skills/` holds only the skill under test, so the outcome depends on the description alone. A query counts as triggered when Claude calls the Skill tool for it in at least half of its runs.

```sh
node evals/run_trigger_evals.mjs audiorective
node evals/run_trigger_evals.mjs audio-processor-authoring --runs 5 --json /tmp/authoring.json

# compare against another version of the skill (e.g. a checkout of main)
node evals/run_trigger_evals.mjs audiorective --skill-dir ../audiorective-main/skills/audiorective
```

It needs the Claude Code CLI on `PATH` and a login. Options: `--runs` (3), `--concurrency` (8), `--timeout` seconds (120), `--json <file>` for machine-readable results, `--limit <n>` for a smoke test, `--user-settings` (see Isolation). A run that does not complete (a timeout, a missing login, a rate limit) is reported as an error and fails its query rather than counting as a non-trigger, so a broken CLI cannot produce a passing negative set. The exit code is non-zero when any query fails.

Report both directions. A description that fires on everything scores perfectly on the positives and is still wrong, so a change that lifts the should-trigger rate has to hold the shouldn't-trigger rate.

## Running functional evals

`run_functional_evals.mjs` answers every prompt in `evals.json` with `claude -p` from a throwaway project whose `.claude/skills/` holds a dereferenced copy of the skill under test and its sibling skills. The solver can only read (`Skill`, `Read`, `Glob`, `Grep`), so its answer is its final reply. A second `claude -p` call with no tools and no skill grades that reply against the prompt's `expectations`; it is never told which version of the skill produced the answer.

```sh
node evals/run_functional_evals.mjs audiorective --json /tmp/after.json

# the same prompts against another version of the skill (e.g. a checkout of main)
node evals/run_functional_evals.mjs audiorective --skill-dir ../audiorective-main/skills/audiorective --json /tmp/before.json

node evals/run_functional_evals.mjs audiorective --ids 3,16,20 --runs 2 --model sonnet
```

Options: `--skill-dir`, `--ids <a,b,c>`, `--limit <n>`, `--runs` (1), `--concurrency` (4), `--timeout` seconds (600), `--model`, `--grader-model`, `--json <file>`, `--user-settings` (see Isolation). The report lists each eval's expectations met, whether the skill was opened, and which reference files were read; the JSON also keeps every answer and the grader's evidence. A run that does not complete is reported as an error and excluded from the totals, and the exit code is non-zero.

### Token and cost breakdown

Every functional run records what it spent, per call (solver and grader) and per eval. The report ends with a table per eval (cost, turns, tool calls as mean with min-max over `--runs`, and mean uncached input, cache-write, cache-read and output tokens), the share of cost by token category, and a list of the context loaded by `Skill`/`Read` results: `SKILL.md` (the Skill tool injects it whole) against each reference file, in characters and approximate tokens (characters / 4). The JSON keeps the same data under `usage` (overall: `tokens`, `costUsd`, `categoryCostUsd`, `categoryShare`, `toolCalls`, `sources`, `graderCostUsd`) and per result under `results[].usage` (`solverRuns`, `graderRuns`, `perRun` mean/min/max, `sources`); existing fields are unchanged.

The CLI reports tokens per category and cost per model, not cost per category, so the category costs are estimates: tokens times the price table at the top of `evals/usage.mjs`, rescaled so the categories sum to the CLI's reported `costUSD`. Treat the shares as approximate when the model is not in the table. `run_guess_evals.mjs` prints the same breakdown by call role (solver, grader, cluster). `run_trigger_evals.mjs` stops a run as soon as the skill is called, so it has no result event and records no usage.

Before changing a skill, run the set against the current skill and keep the JSON as the baseline, then run it again after the change with the same `--model`. Answers vary between runs, so treat a single-run drop on one eval as a reason to rerun that eval on both versions (`--ids`, `--runs 3`), not as a regression. Compare against the same prompt without the skill to see what the skill itself contributes (skill-creator's `agents/grader.md` describes that grading pass).

## Running API affordance evals

`run_guess_evals.mjs` measures how well coding agents guess an API's shape. It runs a task suite (`evals/affordance/<area>.json`, with variant-agnostic expectations) in one of two modes. Every call is `claude -p` from an empty throwaway directory with no tools, no skills and a minimal system prompt.

```sh
# what API would an agent reach for with no documentation? Writes a markdown cluster report too.
node evals/run_guess_evals.mjs evals/affordance/step-sequencer.json --mode desire --runs 3 --json /tmp/desire.json --md /tmp/desire.md

# can an agent use a candidate API from its type declarations alone?
node evals/run_guess_evals.mjs evals/affordance/step-sequencer.json --mode guess --variant /path/to/variant.d.ts --runs 3
```

- **desire** asks the solver to invent the API it would expect. There is no compile and no per-run grading; after all runs, one clustering call per task groups the samples by API shape and lists recurring names, signatures, time units, pattern and velocity encodings, and cleanup styles.
  With `--context <file.d.ts>` the solver also sees the toolkit's existing API (other packages) and is asked to invent a NEW package for the task's capability that fits with it; clustering then reports where the invented API reuses existing concepts (such as `Clock`) and where it duplicates them.
- **guess** gives the solver only the variant's `.d.ts` (`declare module "@audiorective/…"` blocks). The solver's `ts` block is compiled with the repo's TypeScript (`--strict`, `es2022`, bundler resolution, `dom` lib) next to the declarations, then a separate grader, never told which variant it is looking at, scores the code against the expectations and classifies errors as `wrong-name`, `wrong-signature`, `wrong-concept`, `invented-api`, `platform-misuse` or `other`. An `html` block is counted in lines of code and ignored by the compiler.

Options: `--ids T1,T2`, `--runs` (3), `--concurrency` (4), `--timeout` seconds (300), `--model`, `--grader-model`, `--json <file>`, `--context <file.d.ts>` (desire), `--md <file>` (desire). The report gives, per task and overall, the compile pass rate, expectations met, mean lines of code (non-blank, non-comment) and error-kind counts; the JSON also keeps every raw reply. A run that does not complete (timeout, login, rate limit, no code block, unparseable grader reply after one retry) is reported as an error, excluded from the totals, and makes the exit code non-zero.

## Optional Codex backend

All three runners default to Claude. To use an authenticated Codex CLI, pin both the model and reasoning effort on every baseline and candidate command:

```sh
node evals/run_guess_evals.mjs evals/affordance/effects.json --backend codex --model gpt-6.1-sol --reasoning-effort high --mode guess --variant /path/to/real.d.ts --runs 3 --json /tmp/codex-guess.json
node evals/run_functional_evals.mjs audiorective --backend codex --model gpt-6.1-sol --reasoning-effort high --ids 13,80,81 --runs 3 --json /tmp/codex-functional.json
node evals/run_trigger_evals.mjs audiorective --backend codex --model gpt-6.1-sol --reasoning-effort high --ids 11,28 --runs 3 --json /tmp/codex-trigger.json
```

Trigger `--ids` are one-based query indices; functional and guess IDs come from their sets. Functional and guess also accept `--grader-model` and `--grader-reasoning-effort`; they default to the pinned solver settings. Codex calls use a fresh ephemeral scratch directory, ignore user config and rules, suppress host skill discovery, and disable shell, browser, apps, plugins, hooks and memory. Guess calls and graders have no tools. `--user-settings` is unavailable for Codex.

Functional solvers receive a read-only MCP server exposing the staged skills' exact descriptions and Markdown bodies/references through `open_skill`, `read_file`, `list_files` and `search`. Trigger solvers receive only the descriptions and `SKILL.md` bodies through `open_skill` and `read_file`. The reader rejects paths outside the staged Markdown, traversal, symlinks and hidden paths. The JSON records successful body reads and reference sizes. A successful target body read counts as opened; listing a catalog does not. This measures Codex's staged MCP discovery, which differs from Claude's native Skill tool. Compare complete baselines and candidates with the same backend, model, reasoning effort, prompts and staging; do not compare these scores directly with historical Claude scores.

Codex JSON stores actual CLI tokens by call role, including cached input and reasoning output when reported. The CLI does not report USD, so `costUsd` is `null`; these calls are excluded from the Claude dollar budget and are never priced using Claude rates. Missing completion, timeout, API failure, malformed output and forbidden tool calls fail the run. Keep the raw result JSON when reviewing scores and generated samples.

## Maintaining the sets

- When a public API is added or changed, add or update the eval that exercises it in the same change as the docs and `CHANGELOG.md` entry.
- Positive trigger queries should read like real requests — file paths, framework names, a bit of backstory — and cover phrasings that never say "audiorective".
- Negative trigger queries should be near-misses (a Tone.js question that isn't about migrating, a JUCE `AudioProcessor`, an SSR `window is not defined` from another library), not obviously unrelated tasks.
- Expectations must be checkable from the output: name the API, the file, or the structural property, not "the code is good".
- Keep **selection** prompts in `evals.json`: requests that never name a package or API, where the expectations check which capability was chosen. Reuse the wording of a positive trigger query so the same request is tested for triggering and for the choice it leads to.
- Keep **not-applicable** prompts too: requests that resemble a block but do not fit it (many overlapping grains versus the single-playhead `WavePlayer`), where the expected choice is to build on core. Add one whenever a block is added, so a new block is checked for narrowing what agents build.
- Selection expectations accept equivalent wiring ("X, or an equivalent Y"), and check the choice, the behaviour, and that no pass-through wrapper was added. They measure capability selection only; speed and originality need their own tasks and measurements.

## Isolation from user settings

The trigger and functional runners start `claude -p` with `--setting-sources project`, so only the throwaway project's own `.claude/` loads. Without it, every run also loads the maintainer's `~/.claude`: installed plugins and their skills (about 90 here, including generic ones such as a music-making skill described as "use whenever audio is to be produced"), user `CLAUDE.md` and auto-memory. Those compete with the skill under test and make its trigger rate depend on the machine: eval 16 (a React drum machine) opened the skill in 3 of 7 solver runs with user settings loaded and 7 of 7 without. Evals must measure the skill, not one person's setup. Pass `--user-settings` to either runner to load user settings again, for example to check how the skill behaves next to your own plugins. (`--setting-sources ""` would also drop the project-staged skill, so it is not used here; the guess runner needs no skills and keeps `""`.)
