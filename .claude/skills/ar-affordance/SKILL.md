---
name: ar-affordance
description: Audiorective repo only — design or reshape a public @audiorective API so coding agents guess it right from the types alone, then measure that with desire and guess runs (evals/run_guess_evals.mjs). Use when adding or changing an API, when an API is "hard to use" or agents keep hand-writing glue, or for "optimize the launcher/player/…". Not for building apps with audiorective (`audiorective` skill) or general module design.
---

# Agent affordance for audiorective APIs

An API has good **affordance** when an agent with only the `.d.ts` writes correct, short code on the first try. The step sequencer went from ~63 to ~28 lines and from ~84% to 100% correct on guess runs this way. Measure every shape; opinions about what agents "should" find natural are cheap and often wrong.

Commands, flags and output fields live in `evals/README.md`. Experiment files (variants, results) go under the git-ignored `blueprints/probes/affordance-<area>/`.

## Steps

1. **Suite.** Write or extend `evals/affordance/<area>.json`: about six tasks covering the component's core uses, each prompt in the user's words and each expectation describing behaviour, never an API name. Add a deterministic `checks` entry wherever an expectation is mechanically checkable (indices, call shapes); whenever a prompt says "step 7", "clip 2" or "bar 5", add a check for the translated index and mark each variant's base with `// @step-base 0|1`. Done when every core use of the component is a task and no expectation names an API.
2. **Control.** Build `variants/V0-current.d.ts` from the built `dist` declarations (verbatim, real JSDoc, compiles alone) and run guess mode, 3 runs per task. Then read the code of every run: list what agents hand-wired every time and any bug the grader passed. Done when you have the control numbers and a gap list.
3. **Desire.** Run desire mode (no API given), 3 runs per task. Done when you have the clustered shapes, recurring names, units and package names.
4. **Variants.** Write 2–4 `.d.ts` shapes from the desire clusters and the principles below, as `declare module` blocks under the package names the API will really ship with. Keep them fair:
   - identical capabilities, shown in a task × variant parity table;
   - the same dependency modules (`@audiorective/core`, `clock`, …) copied identically into every variant, including the reactive reads (`effect`, `subscribe`) a UI needs;
   - the same defaults, state idiom (cells per AGENTS.md rule 10) and event style in every variant, unless that is the question being tested; change one thing per variant when isolating a question (e.g. 0- vs 1-based steps);
   - at most one short JSDoc line per member, stating what it is plus the hints a reader needs: defaults, units, index base ("clips[0] is the first clip"). No usage examples;
   - similar size; each compiles alone with the repo's tsc (`packages/core/node_modules/.bin/tsc --strict --noEmit --lib es2022,dom --target es2022 --module esnext --moduleResolution bundler`) against a throwaway check file that touches every task's members, deleted afterwards.
     Done when every variant passes the parity table.
5. **Compare.** Guess-run each variant, 3 runs per task (about $0.6 and a minute per variant; variants can run in parallel). Read the code of every run, not only the misses (results JSON: `results[].samples[].ts/html/tsc/grade`): classify each miss (API shape / unrelated / grader error), count the gap-list pieces from step 2 still hand-wired, and note real bugs the grader passed. Rank by correctness, then real bugs, then hand-wired pieces, then lines of code. Done when one shape wins; if variants still tie, add harder tasks or runs before choosing.
6. **Decision log.** Before implementing, list every decision already made for this component (CHANGELOG Unreleased, AGENTS.md design rules, earlier experiment notes, maintainer instructions in the conversation). The implementation keeps all of them or the maintainer explicitly revisits one. A dropped decision caused a regression once: transforms lost their beat mode when a seconds-only design was implemented verbatim.
7. **Implement.** One form only: delete the superseded API instead of keeping both. Migrate every consumer, update docs, CHANGELOG (with an old → new table) and evals in the same branch. Done when the repo's checks and all tests pass.
8. **Verify the real types.** Rebuild the variant from the new `dist` and guess-run it. Done when it scores at least as well as the winning design variant and no run uses a removed API. Then hand the component to `ar-dogfood` and the skill/docs changes to `ar-eval`.

## Principles

The evidence behind each, what agents already know, and per-component results: [findings.md](findings.md). Append to it when a component is done.

- **Mirror what agents already know**, exactly: name, argument order, units, lifecycle, error type. Sources agents know well: Web Audio (`start(when, offset)`, `stop(when)`, `connect`, AudioParam scheduling), `HTMLMediaElement`, DOM (`EventTarget`, `AbortSignal`, `Symbol.dispose`), Tone.js notation (`"16n"`, `"1m"`), React (effect cleanup), musician vocabulary (bars, lanes, velocity 0–1, counting steps from 1). A same-named API with different semantics is a **false affordance** and worse than a new name.
- **Let the shape carry the hint.** Guidance in docs loses to the agent's intuition; guidance in the type wins. Example: steps addressed as `steps[i]` plus the JSDoc "steps[0] is the first step" was 6/6, either alone was ≤4/6.
- **One obvious way.** Two forms of one feature cost agents reading and choice.
- **Progressive disclosure in the API**: a one-liner works with defaults; per-item options, per-step fields and hooks are each one layer down.
- **Compact notation** where agents recognise it (pattern strings, note values, note names); invented notation costs skill lines.
- **Package names agents guess** (`@audiorective/sequencer`, not a category name).
- Decorators and custom elements suit view components, not the audio engine (longer code; DOM typing traps).
