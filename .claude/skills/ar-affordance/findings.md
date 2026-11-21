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

### One-shot sounds (done)

Control: grader 100%, but O3 3/3 hand-wrote a `Map<number, Set<Voice>>` per key and O5 produced four hand-made synth shapes in six samples (monkey-patched `start`, offline pre-render, a private `playZap`). Variants differed only in the sound-factory shape: a factory that returns an unconnected voice (`AudioScheduledSourceNode | { output, sources, duration? }`, the toolkit connects/starts/stops/cleans up) beat a factory that plays itself — tied on simple tasks, but with two oscillators and held notes the "plays itself" form pushed stop/cleanup (and monkey patches) back to the caller 3/3. Holding a voice without `duration` for `hit.duration` then releasing removed the remaining `isFinite` checks. Shape: one `Sound = NoteName | AudioBuffer | SoundFactory` accepted by `Sampler`, `PadBank`, sequencer lanes and launcher clips; `trigger(options)` / `noteOn(note, options)` / `noteOff(note, when)` with `{ velocity, when, pitch, offset, duration }`. Real types 21/21, 100%, 0 glue. The expressive build found live `release`, sustain and per-pad/per-note state missing (now params/cells) and a `noteOff` that re-extended released voices; hidden render suite 79/79.

### Recording and playback (done)

Control: `FilePlayer.play()` swallowed autoplay errors (every `catch` dead), mic wiring hand-written 5/6, bar-aligned recording hand-computed every time. Shape: `MicrophoneInput.open` → `mic.connect(recorder)`; recorder and `WavePlayer` are Clock schedulers with `record({ quantize, length })` / `play({ quantize })`; `play()` rejects like `HTMLMediaElement.play()`; cells only. Real types 18/18, 100% (control 93%). Undocumented rejection rules cost 4/6 samples a hand-written state check until one JSDoc line stated them. The expressive loop station found a real bug guess runs could not (an input pulled only while armed gave silently time-compressed takes), plus missing `clip.launch({ at })`, readable/replaceable clip buffers and `overdub`/`punch`; after those, 0 workarounds, hidden suite 31/34 (3 = brief ambiguity).

### MIDI and WebCLAP (done)

Control: 156 lines on average, the highest of any component; 12/12 hand-wrote a note scheduler, 9 converted seconds↔beats, 5 guessed the velocity range. Variants differed only in how notes reach a synth; an instrument object (Sampler-shaped `noteOn`/`noteOff`) tied callbacks but lets toolkit instruments plug in directly, so it won. Shape: `MidiClip` (beats, velocity 0..1) is a Clock scheduler and a launcher `{ scheduler }`; `MidiRecorder` mirrors `AudioRecorder`; `MidiKeyboard.open` with `press`/`release`/`setSustain` for on-screen input; `transform` shared with `StepSequencer`. Real types: 107 lines, 0 glue; two places where the implementation drifted from the decided design (edits from the next window instead of the next pass; `when` takes not cancelled by transport changes) each caused 3/3 hand-written glue until fixed. The expressive build and hidden event-log suite found a launcher that never cut sounding notes, a `Sampler` that ignored earlier cuts, a refresh edge, and stray note-offs; after fixes, 0 workarounds, every undisputed test passing.

### Effects and transport automation (done)

Matched Codex remeasurement (`gpt-6.1-sol`, high reasoning) gives control 16/18 compilation, 107/117 expectations and mean 280 lines; final real types give 18/18, 117/117 and mean 186 lines. All 18 answers were read and separately compiled against the actual package exports. Ambient fixtures need explicit barrel export lists: otherwise private support aliases become accidentally importable. Three E1 answers reached the useful `AnyEffect` name; exporting it while retaining known wet/bypass/status members also removed E5's implicit-any callback failure. Three E4 answers still redundantly set the documented 10 ms smoothing default; that is residual explicit configuration, not a caller-owned smoothing engine.

Shape: every effect owns bypass, ready/status/error and default smoothing; a loading wet arm is muted independently of its dry share, so fully wet returns stay silent. `Ducker.cells.reduction` reports actual wet/bypass output attenuation, not the pre-mix detector. `EffectChain.fromJSON` constructs a separate tolerant snapshot for composition; `await chain.restore` validates and awaits readiness transactionally behind stable I/O, owns cancellation and queued fades, and leaves the playing board unchanged on failure. E5's caller preset validation/switching/fade/timer engines disappeared in all three final samples.

The expressive mixer found 23 lines of beat mapping/window/cancellation around finite automation. Bringing forward `AutomationClip(curve, { target, loop, length })` + `clock.attach` removed them and its duplicate enabled flag. Control transport guesses: 5/6 compiled, 34/36 expectations, mean 202 lines; the owner: 6/6, 36/36, mean 74. The consumer finished 4 built-ins / 8 extensions / 0 workarounds / 0 impossible demands. Independent effects acceptance passed 15/15 ×3; transport product and manual reference 25/25 ×3 with six measured mutations; live preset restoration 12/12 ×3 with six measured mutations. Interrupted morphs required retaining every still-audible branch, rather than disposing the previous fade prematurely.

Public PCM probes found two bugs ordinary tests missed: compensation rewiring jumped by 0.1496, and saved bypass differed from a matching constructor by 0.5313 in its first 256 samples. Native warm-up/crossfade routes reduced the first jump to 0.00129 while keeping settled impulses exactly aligned; detached gate initialization made the second error zero without changing later live bypass fades. Retiming keeps logical solved arrivals distinct from the brief audible phase blend, and cleanup follows audio time even across context suspension.

Targeted functional cases 9/49/52/59/60/77/78/79/80/81, three runs each, scored 144/147 versus 76/147 after the same behavior-preserving rubric corrections on both sides; every per-case mean held or improved. The three remaining misses are loading/error UI coverage in case80, retained as failures. Targeted positive/near-miss trigger queries 11/28 both passed all runs. Actual module caching, native-backed looping players, implicit validated anchors and documented shared refresh must count as delegation, rather than require an agent to reimplement them. Raw grades, corrected rubrics, source hashes and one timeout's explicit replacement lineage remain under `blueprints/probes/affordance-effects/codex-rebase/`. Claude spending remains $16.33 of $30; Codex reports actual tokens and unknown USD, kept separate.

### Cross-phase lessons

- Run the expressive real build right after the first implementation: every phase's build found bugs or missing extension points the guess runs could not.
- When the implementation deviates from the decided design even slightly, guess runs show it as 3/3 hand-written glue — re-verify against the design, not just the old control.
- One rule across components (quantize boundary, cancel-on-transport-exit, `stop` vs `cancel`) — a mismatch found in one component usually exists in its siblings.
- Hidden suites need judgement: separate candidate bugs, suite rules stricter than the brief, and real package bugs before acting.
