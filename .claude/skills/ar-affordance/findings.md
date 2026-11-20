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

### Clip launcher (done)

Desire round: `Transport → Track → Clip` objects, `clip.launch({ quantize: "bar" })`, `clip.state` with `"queued" | "playing" | "stopped"`, `clip.cancelQueued()`, `track.stop({ at: "nextBar" })`, `transport.stopAll`, `launchScene`, change events. Control (current `ClipLauncher` + caller-written driver): see conclusion 8.

Variants (guess mode, 3 runs per task, every run read):

|                               | V0 current                 | VL1 objects | VL2 launcher plays                                                  | VL3 hybrid                  |
| ----------------------------- | -------------------------- | ----------- | ------------------------------------------------------------------- | --------------------------- |
| Compile / grader              | 100% / 100%                | 100% / 100% | 100% / 100%                                                         | 100% / 100%                 |
| Mean LOC                      | 66                         | 37          | 36                                                                  | 31                          |
| Hand-written transport driver | 18/18                      | 0           | 0 (but create/attach/start a Clock and resume the context in 15/18) | 0                           |
| Real bugs found by reading    | late stop, unstarted Clock | 0           | 4                                                                   | 1 (`clips[2]` for "clip 2") |

VL3 shape: Web Audio timing on clips and tracks — `clip.start(when)`, `clip.stop(when)`, `track.stop(when)`, `transport.stopAll(when)`, `launchScene(clips, when)` with `when` as audio seconds or a quantize string (`"bar"`, `"2 bars"`, `"beat"`); `clip.cancel()`; `EventTarget` `statechange`; `transport.start()` resumes the context. Lessons: letting the toolkit own playback removed both the driver and the timing-bug class in every variant; a variant that leaves the caller to create and start the clock reintroduces ordering and autoplay bugs; the only VL3 miss repeated the step-index lesson (no "clips[0] is the first clip" hint). Evidence is weak: all variants hit the 100% grader ceiling and defaults differed (VL1 quantized to `"bar"`, VL3 to `"none"`).

Real builds (fresh agent per variant, same brief: 7 tracks × 8 scenes, mixer with two returns; one hidden 48-test render acceptance suite validated by 8 mutations):

|                                    | VL1 objects | VL2 launcher plays | VL3 hybrid |
| ---------------------------------- | ----------- | ------------------ | ---------- |
| Hidden acceptance                  | 48/48       | 48/48              | 48/48      |
| Launcher module / page (excl. CSS) | 348 / 601   | 186 / 999          | 466 / 680  |

All three were timing-correct, so "the toolkit owns playback" is settled. They differed in use: every build lacked a playing clip's start time, every build created its own `Clock` because the variant's transport exposed no position, and the event-based variants could not tell a cancel from a commit. A guess run never surfaced these; only full pages did (hence step 7).

Contextual desire (agents shown the current `Clock` and `StepSequencer` types): 18/18 reused `Clock` with `clock.attach(launcher)` and 0/18 invented a transport, versus a separate `Transport` in the blind round. Names both rounds agreed on: `ClipLauncher`, `launch({ quantize })`, `cancelQueued()`, `launchScene`, `stop` / `stopAll`, `{ buffer, loop }`; the contextual round switched quantize to the sequencer's `"1m"` and state to cells.

VL4 (decision log + both desire rounds + the step-sequencer conventions: `Clock` + `attach`, state in cells with `startsAt` / `startedAt`, cancellable queued stops, `clips[0]` hint, defined stopped-clock behaviour): guess run 100%, 0 launcher bugs, "clip 2" → `clips[1]` 3/3.

Final shape (evolved in place, old driver API removed): `new ClipLauncher({ bass: [clip | null, …] }, { context, quantize, seed, scenes, transform, onSchedule })`; `clock.attach(launcher)` (or `workspace.transport.attach`); clips from `{ buffer }`, a `sound` factory returning an unconnected voice, or `{ scheduler: seq }` (pattern clips routed into the track); `clip.launch({ quantize, legato })`, `cancelQueued()`, `configure(patch: ClipPatch)`, `release()`; options `quantize`, `offsetBeats`, `loop`, `gainDb`, `pitch`, `mode`, `chance`, `follow: { after, next: [{ clip | "stay", weight }] }`, `bpm` + `warp` (default follows the song tempo; `warp: false` opts out); state in read-only cells (`playing`, `queued`, `startsAt`, `startedAt`, `options`); `launchScene(i | clips)`, `stopAll()`; `onSchedule` for hosts such as the DAW Session. Clock gained reset reasons, an attach handle with timeline/state/meter, transport notifications and `handle.cancelFrom(time)`.

Verified on the real package: hidden render suites 48/48 (base) and 83/83 (expressive, 12 features: 0 workaround, 0 impossible); guess runs on the real types 100% base and 96% expressive, at least as guessable as the winning design, no old API or hand-wired driver in any sample. The one type miss — `configure` taking a readonly patch, so step-by-step patches failed to compile — was fixed with a writable `ClipPatch`.

Process lessons from this component:

- The default for a behaviour agents never think to enable must match the musical expectation of the real workflow, not a guess task. The guess suite favoured `warp: false`; a full session view with scene tempo drifted out of time until it followed tempo by default.
- Six rounds were needed because each real build exposed the next layer (missing data → clock/scheduler contract → expressive extension points → defaults). Run the real build early, after the first contextual desire round, not after several guess-only iterations.
- Expressive briefs (features deliberately not designed in advance, each classified built-in / extension / workaround / impossible) are the flexibility test; a hidden render suite whose material encodes position (frequency per beat) checks offsets, legato and loop regions mechanically.

### Core foundation (done)

Control (current core): grader 99/99, yet hand-written teardown (222 lines in C3), three engine start paths, no way to observe a param, invented error types. Both desire rounds asked for `connect`, `dispose`, `AbortSignal` and `subscribe`. Shape adopted: `processor.connect(dest)` returning `dest` (edges join the latency graph), `dispose()` + `[Symbol.dispose]` replacing `destroy()`, engine `resume()` / `suspend()` with `state: ReadonlyCell<AudioContextState>` (no `start()`), `signal` option, `subscribe(listener, { immediate })` on cells and params, `InvalidStateError` after dispose. Real types: 126/129 (98%), mean 81 lines (control teardown task 222 → 182), no old API. A one-line JSDoc ("fires while a scheduled ramp moves the value") removed the grader's and solvers' doubt about observing automation (C5 89% → 94%).
