# Affordance findings

What the experiments established, with the evidence. Consult this when designing a variant or arguing for a shape. Append a section per component as it is done. Raw results live in the git-ignored `blueprints/probes/` of the machine that ran them; the numbers below are the summary of record.

Measurement for all numbers: Sonnet solver, 3 runs per task, guess mode gives only the `.d.ts`, functional mode gives the skill; graders isolated from personal settings unless noted.

## What agents already know (mirror these)

| Source              | Shapes agents reach for unprompted                                                                                           |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Web Audio           | `start(when, offset)`, `stop(when)`, `connect(node)`, `param.setValueAtTime(v, when)`, resume the context in a click handler |
| DOM                 | `addEventListener` / `EventTarget`, `AbortSignal`, `Symbol.dispose`, 0-based arrays with `[i]`                               |
| Tone.js             | note values `"16n"`, `"1m"`; `Transport`; `Sequence`                                                                         |
| React               | an effect returns its cleanup; state in `useState` (which works against audio-layer state — see below)                       |
| Library conventions | `new X(context, { …options })`, `start` / `stop` / `dispose`, `onX` callbacks, `use(plugin)`                                 |
| Music vocabulary    | step, lane/track, clip, scene, velocity 0–1, swing %, BPM, note names `"C4"`, counting steps and bars from 1                 |
| Package names       | `@audiorective/sequencer` was written 39 times in the step-sequencer desire round; a category name (`blocks`) never          |

What agents do not guess: invented concepts (`start({ atBeat })`, tick windows with `window.own`, `refreshOnEdit`, `setCell`), category package names, and reactive `Cell` state (they default to plain arrays or `useState`).

## Conclusions

1. **Mirroring familiar shapes is the biggest lever.** Step sequencer: platform audio/time shapes + compact notation took guess-mode code from ~63 to ~20–28 lines and correctness from ~84% to 100%.
2. **The shape must carry the hint; docs lose to intuition.** Step-index experiment (T4 + T6, 6 runs each, checked by code):

   | Variant                                         | Correct                                             |
   | ----------------------------------------------- | --------------------------------------------------- |
   | `steps[i]`, no base stated                      | 1/6                                                 |
   | `setStep(index)` + JSDoc "zero-based"           | 4/6                                                 |
   | `steps[i]` + JSDoc "steps[0] is the first step" | 6/6                                                 |
   | 1-based `setStep(step)`                         | 6/6 (also 6/6 under decorators and custom elements) |

   An agent once wrote "index is zero-based" in a comment and then `setStep(7, …)` for step 7. Put the hint in the type; make the natural reading the correct one.

3. **One obvious way.** With two constructor forms, guess runs had 3 recorded error kinds; with one form, 0 and no use of removed APIs.
4. **Compact, recognised notation shortens code without errors**: pattern strings `"X...x..."`, `"16n"`, `"30%"`, note names. Invented notation would cost skill lines instead.
5. **Defaults agents assume**: sequences loop; playback starts from a click; a one-object setup (`new Clock({ context, bpm })` replaced a two-object one in 18/18 runs).
6. **Decorators and custom elements fit views, not the engine.** Decorators: correct but ~44 vs ~20 lines. Custom elements: competitive length but `querySelector("#id")` returns `Element` and breaks typing (2/18 compile failures), and settings get split between markup and code.
7. **A design must keep earlier decisions.** Implementing a seconds-only `transform` verbatim from a design variant dropped the agreed beat mode; eval 69 fell to 1.3/3 until `hit.beat` was added.
8. **Glue the toolkit leaves to agents becomes their bugs.** Clip-launcher control: graders passed 100%, yet every run hand-wrote a 40–70-line transport driver, and reading the code found a late stop in `commit()` and an unstarted second `Clock`. Count hand-wired pieces, not just the grade.

## Measurement lessons

- **LLM graders are unreliable on mechanical facts**: identical off-by-one code graded both pass and fail; markup-based answers failed because the grader could not see the HTML; API defaults counted as missing until the grader saw the `.d.ts`. Use compile results and `checks` first.
- **Single runs mislead**: 6/6 on one run, 4.3/6 on three.
- **Isolate the solver**: with personal settings loaded, the skill competed with ~90 other skills and opened 3 times in 7; isolated, 7/7. Isolation itself did not change the old skill's score (76% vs 73%); the new description did.
- **Where tokens go** (functional evals): ~70% cache writes (Claude Code's fixed ~20k context plus SKILL.md), ~25% output; references are read selectively at ~1–3k tokens each. Shrinking references barely moves cost; shorter generated code does.

## Skill and docs lessons

- Most remaining failures were "didn't reach the guidance", not "couldn't do it": of 55 failed expectation-runs, 27 trigger, 13 docs content, 9 eval wording, 6 routing, 0 API shape.
- A slimmer SKILL.md (11k → 4.6k tokens) matched the full one on correctness (94% vs 96%) and cost 12% less, but only after the guidance its failures pointed to was put on the lean page agents read.
- Runnable examples belong on the page agents always read; when the drum-machine example lived on an advanced page, runs that skipped it failed.
- Reshaping the API plus six targeted fixes took the functional score from 76% to ~96%.

## Per component

### Step sequencer (done)

Shape: `new StepSequencer({ kick: "X...X..." }, { context, onHit, transform, seed })`; `clock.attach(seq)` (or `workspace.transport.attach`); `new Clock({ context, bpm })`; `clock.start(when, offsetBeats)`; `lanes.<name>.steps[i]` (0-based, JSDoc states it); `onHit` returns a cleanup run when a hit is retracted; `transform` moves `hit.beat` (tempo-locked) or `hit.when` (ms); one constructor form; its own package.

### Clip launcher (in progress)

Desire round: `Transport → Track → Clip` objects, `clip.launch({ quantize: "bar" })`, `clip.state` with `"queued" | "playing" | "stopped"`, `clip.cancelQueued()`, `track.stop({ at: "nextBar" })`, `transport.stopAll`, `launchScene`, change events. Control (current `ClipLauncher` + caller-written driver): see conclusion 8.
