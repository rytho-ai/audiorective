---
name: ar-eval
description: Audiorective repo only — measure whether a change to the `audiorective` skill, its docs or an API made agents more correct, and find why expectations fail. Use before/after editing SKILL.md, a description, a reference page or an eval; for A/B comparisons; when a score looks surprising. Uses evals/run_functional_evals.mjs, run_trigger_evals.mjs and run_guess_evals.mjs. Not for designing experiments outside this repo (`shape:probe`).
---

# Measuring the skill

**Correctness decides; tokens and cost are reported beside it.** A shorter skill or doc is kept only if correctness holds. Commands, flags and output fields live in `evals/README.md`; results go under the git-ignored `blueprints/probes/<topic>/`.

## Rules for every measurement

- **Isolated.** Solvers load project settings only (the runners' default `--setting-sources project`). With the maintainer's own settings loaded, the skill competed with ~90 other skills and opened 3 times in 7.
- **Three runs per eval**, judged on the mean. One run reported 6/6 for an eval whose mean was 4.3/6.
- **Deterministic before grader.** Where an expectation is mechanically checkable, a `checks` entry or a compile result overrides the LLM grader, which both missed and invented failures on identical code. Read the code of every surprising pass or fail before believing it.
- **One variable per comparison.** For an A/B, build both variants from the same commit so they differ only in the thing under test (verify with `git diff --stat`), and run them with the same model and runs.
- **Baselines move.** When the runner or the evals change, re-run the baseline before comparing.

## Steps

1. **Pick the evals** the change touches (ids in `evals/audiorective/evals.json`; trigger queries in `trigger_eval.json`). Add an eval for any behaviour the change targets that no eval covers.
2. **Baseline** on the current commit: functional `--runs 3`, plus the trigger runner if the description or routing changes.
3. **Change** on its own branch.
4. **Re-run** with identical settings. Done when you have per-eval means, skill-opened counts, references read and the token breakdown for both.
5. **Explain every failing expectation** in both runs. Classify each into exactly one cause and count them:
   - **trigger** — skill never opened → description;
   - **API affordance** — the natural code is wrong because of the API shape → `ar-affordance`;
   - **routing** — skill opened, right page not reached → SKILL.md tables, where examples live;
   - **docs content** — right page read, it doesn't say it → one sentence on the page agents actually read;
   - **eval wording** — ambiguous or checks something unasked → reword so it checks the same behaviour, and show the maintainer before committing;
   - **model slip** — correct guidance read and ignored → record only.
     Done when every failure has a cause, quoted evidence and a proposed fix ranked by recovered expectation-runs ÷ effort.
6. **Decide.** Keep the change if correctness is not worse; otherwise add back the guidance the failures point to, or revert the change's own commit.
