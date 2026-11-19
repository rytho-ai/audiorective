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

It needs the Claude Code CLI on `PATH` and a login. Options: `--runs` (3), `--concurrency` (8), `--timeout` seconds (120), `--json <file>` for machine-readable results, `--limit <n>` for a smoke test. A run that does not complete (a timeout, a missing login, a rate limit) is reported as an error and fails its query rather than counting as a non-trigger, so a broken CLI cannot produce a passing negative set. The exit code is non-zero when any query fails.

Report both directions. A description that fires on everything scores perfectly on the positives and is still wrong, so a change that lifts the should-trigger rate has to hold the shouldn't-trigger rate.

## Running functional evals

`run_functional_evals.mjs` answers every prompt in `evals.json` with `claude -p` from a throwaway project whose `.claude/skills/` holds a dereferenced copy of the skill under test and its sibling skills. The solver can only read (`Skill`, `Read`, `Glob`, `Grep`), so its answer is its final reply. A second `claude -p` call with no tools and no skill grades that reply against the prompt's `expectations`; it is never told which version of the skill produced the answer.

```sh
node evals/run_functional_evals.mjs audiorective --json /tmp/after.json

# the same prompts against another version of the skill (e.g. a checkout of main)
node evals/run_functional_evals.mjs audiorective --skill-dir ../audiorective-main/skills/audiorective --json /tmp/before.json

node evals/run_functional_evals.mjs audiorective --ids 3,16,20 --runs 2 --model sonnet
```

Options: `--skill-dir`, `--ids <a,b,c>`, `--limit <n>`, `--runs` (1), `--concurrency` (4), `--timeout` seconds (600), `--model`, `--grader-model`, `--json <file>`. The report lists each eval's expectations met, whether the skill was opened, and which reference files were read; the JSON also keeps every answer and the grader's evidence. A run that does not complete is reported as an error and excluded from the totals, and the exit code is non-zero.

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
- **guess** gives the solver only the variant's `.d.ts` (`declare module "@audiorective/…"` blocks). The solver's `ts` block is compiled with the repo's TypeScript (`--strict`, `es2022`, bundler resolution, `dom` lib) next to the declarations, then a separate grader, never told which variant it is looking at, scores the code against the expectations and classifies errors as `wrong-name`, `wrong-signature`, `wrong-concept`, `invented-api`, `platform-misuse` or `other`. An `html` block is counted in lines of code and ignored by the compiler.

Options: `--ids T1,T2`, `--runs` (3), `--concurrency` (4), `--timeout` seconds (300), `--model`, `--grader-model`, `--json <file>`, `--md <file>` (desire). The report gives, per task and overall, the compile pass rate, expectations met, mean lines of code (non-blank, non-comment) and error-kind counts; the JSON also keeps every raw reply. A run that does not complete (timeout, login, rate limit, no code block, unparseable grader reply after one retry) is reported as an error, excluded from the totals, and makes the exit code non-zero.

## Maintaining the sets

- When a public API is added or changed, add or update the eval that exercises it in the same change as the docs and `CHANGELOG.md` entry.
- Positive trigger queries should read like real requests — file paths, framework names, a bit of backstory — and cover phrasings that never say "audiorective".
- Negative trigger queries should be near-misses (a Tone.js question that isn't about migrating, a JUCE `AudioProcessor`, an SSR `window is not defined` from another library), not obviously unrelated tasks.
- Expectations must be checkable from the output: name the API, the file, or the structural property, not "the code is good".
- Keep **selection** prompts in `evals.json`: requests that never name a package or API, where the expectations check which capability was chosen. Reuse the wording of a positive trigger query so the same request is tested for triggering and for the choice it leads to.
- Keep **not-applicable** prompts too: requests that resemble a block but do not fit it (many overlapping grains versus the single-playhead `WavePlayer`), where the expected choice is to build on core. Add one whenever a block is added, so a new block is checked for narrowing what agents build.
- Selection expectations accept equivalent wiring ("X, or an equivalent Y"), and check the choice, the behaviour, and that no pass-through wrapper was added. They measure capability selection only; speed and originality need their own tasks and measurements.
