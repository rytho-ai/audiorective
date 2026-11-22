# Affordance findings

What the experiments established, with the evidence. Consult this when designing a variant or arguing for a shape. Append a section per component as it is done. Raw results live in the git-ignored `blueprints/probes/` of the machine that ran them; the numbers below are the summary of record.

Historical experiments without a backend label use Sonnet. Sections labeled Codex use their stated model and isolation; compare controls and candidates within that backend. Guess mode gives only the `.d.ts`; functional mode gives the staged skill. Runs and grading exceptions are recorded per experiment.

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
6. **The engine syntax experiment does not establish a widget winner.** Decorators: correct but ~44 vs ~20 lines. Custom elements: competitive length but `querySelector("#id")` returns `Element` and breaks typing (2/18 compile failures), and settings get split between markup and code. The separate widget comparison below measures views in fixed Vanilla and React hosts.
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

### Widgets (done, with retained acceptance and comparison limits)

Widgets borrow the existing player, curve, level or project owner and manage view resources, coordinate projection and interaction previews. Dragging stays local until one commit; cancellation, external snapshots and unmount discard stale input. Direct reactive `points`, tracked duration/origin/scale, scoped `onCell` effects and public plugin geometry remove synchronization and redraw engines. App layout, labels, badges, history commands and ordinary framework lifecycle code remain normal extensions. Mixer W5 stayed almost the same length (157 to 153 lines) while its handwritten strips/meter engine disappeared: LOC alone misses that improvement.

Matched Codex six-task controls compiled 17/18 and scored 87/96; initial real types compiled 18/18 and scored 93/96. W6 needed truthful JSDoc for existing cancellation, snapshot/focus and keyboard guarantees. A comments-only repair and W6-only follow-up gave 3/3 actual-public compiles and 18/18 expectations. The current cohort is the unchanged 15 answers plus all 3 follow-up answers: 18/18 actual-public compiles, 96/96, no removed API or caller-owned audio, gesture or synchronization engine. Initial failures and all 21 generated answers remain recorded; this is not 18 entirely fresh answers on the latest comments.

The fresh workbench's own 38 assertions missed a real SelectionPlugin bug: previews wrote the shared player selection, Escape did not cancel, and detach abandoned input. Public regressions went red before the fix. The original hidden suite rose 19/34 to 21/34 after the fix, then 22/34 with an explicitly authorized app preview renderer. The separately calibrated corrected suite reaches 33/34 x3; its reference is 34/34 x3 and 23 healthy mutations are caught. The remaining failure demands a Repeat button where the actual native control is a tab; an independent public-DOM diagnostic passes the behavior. Preserve 33/34 and the first source rather than rewriting the suite or presenting the later renderer as first-try success. Current in-scope workaround/impossible counts are zero under the approved correction.

Thirteen functional cases, three answers each, reach 143/168 versus 127/168 under paired common criteria, with every per-case result holding or improving. The cohort uses 36 initial answers plus all 3 case 61 follow-ups after fixing a real documentation error: undo prose showed naked `edit.apply()` instead of an actual history command. Initial raw grades and three rubric corrections remain separate. High functional grades do not prove full TypeScript compilation; retained source-review defects include missing callbacks, a wrong host identifier and typed-array/host annotation errors.

The subsequent fixed-host syntax comparison used the same Codex model (`gpt-6.1-sol`, high), two tasks and three answers per task/condition: 30 solver plus 30 grader calls, all 30 code/HTML/grades read. All compiled and raw graders passed 180/180. An independently frozen browser replay found real failures that those grades missed:

| Host    | Form           | Usable samples | Caller owner/sync/audio/gesture engines | Mean TS+HTML LOC |
| ------- | -------------- | -------------- | --------------------------------------- | ---------------- |
| Vanilla | mount          | 5/6            | 0                                       | 79.00            |
| Vanilla | HTML elements  | 6/6            | 0                                       | 93.17            |
| React   | mount          | 5/6            | 0                                       | 64.17            |
| React   | HTML elements  | 5/6            | 0                                       | 91.67            |
| React   | JSX components | 6/6            | 0                                       | 59.67            |

Three S1 answers set a fixed host height smaller than the widget content, making the waveform intercept ordinary Toggle detail pointer clicks. Keyboard activation still preserves the overview/player; the pointer failures remain failures, with later checks in that stage unmeasured. Original browser replay is 26/30; a documented uniform counter-locator amendment accepts a valid native wrapping-label output and gives 27/30. The original source/results, 17 positive/negative locator controls, calibration attempts and corrected provenance are retained. No answer, CSS, pointer action or behavioral tolerance was repaired. All executed owner/resource/teardown checks pass and page errors are empty; this does not prove collection of every object.

No within-host pair reaches the preregistered two-extra-usable-samples threshold, and no form eliminates an engine the others require. Syntax superiority is inconclusive; LOC is descriptive. All HTML answer blocks are empty: tags were constructed through typed TS/TSX, not a pure-markup setup study. The prepared Chromium/React 19.2.4 host and loaded owners do not establish Vue, Svelte, SSR or fresh-project setup success. React/elements adapters remain local prototypes, with extra shared binding and optional framework typing/packaging costs, not shipped APIs.

Paul subsequently stated a preference for Vanilla absent a particular reason. Keep the framework-independent Vanilla `mount` core; framework adapters, when needed, connect the same owners and view lifecycle. This preference is independent of the empirical ranking. Framework integration must retain control identity, focus and active gestures through normal redraws and release only view-owned resources on unmount. The evidence supports these ownership/lifecycle requirements, not a universal declarative-API claim. Method, raw evidence, amendment and root assessment live under ignored `blueprints/probes/affordance-widgets/view-syntax-comparison/` in the development worktree.

### Widgets implementation-review follow-up (2026-11-22)

After meter callbacks sample each animation frame and live invalid lane duration disables rather than throws, extract the current real17a01d5 declarations and run all six tasks anew, three answers each. All18 compile both against the minimal true-declaration fixture and the actual public package entries; original behavior grades96/96. Root read all18 TS/HTML/grades. Official deterministic replay matched raw/applied grades;36 native calls, zero format retries/errors/unknown usage. The earlier mixed15+3 cohort above stays historical rather than being presented as this fresh cohort.

The preregistered varying-input-form count is0/18, below the3/18 threshold for proposing a uniform input contract. Keep current forms: direct owner readables, required tracked getters/data readers, and necessary structure/unit/predicate projections serve different roles. Do not count Channel-to-MixerState or seconds-to-beats projections as identity wrappers. Extra defensive release bookkeeping in one pad answer, library forwarding facades in all three sample-browser answers and coordinate-change gesture rebinds in one arrangement answer remain descriptive scaffolding observations; this result does not mean every line of view glue vanished. Evidence lives in ignored `affordance-widgets/implementation-review/D-root-manual-review.json` and `D-review-conclusion-17a01d5.md` in the development worktree. The syntax/host comparison and its limits remain unchanged.

### Cross-phase lessons

- Run the expressive real build right after the first implementation: every phase's build found bugs or missing extension points the guess runs could not.
- When the implementation deviates from the decided design even slightly, guess runs show it as 3/3 hand-written glue — re-verify against the design, not just the old control.
- One rule across components (quantize boundary, cancel-on-transport-exit, `stop` vs `cancel`) — a mismatch found in one component usually exists in its siblings.
- Hidden suites need judgement: separate candidate bugs, suite rules stricter than the brief, and real package bugs before acting.

### Automation, Clock and cross-component closure (Codex, 2026-11-22)

Matched Codex gpt-6.1-sol/high runs retain one Clock owner, audio-time when, cancel(time), and an awaitable coalesced refresh. The completion-shape comparison tied on its preregistered differences; select the smaller direct Promise by the tie rule, without declaring an empirical winner. Real ClockLab retains its141 frozen checks×3, with20 PCM comparisons each, zero engine workarounds and the ordinary35-line instrument/event adapter. Formal true Clock types compile12/12 and score72/72; the repaired recorder's fresh true-type cohort compiles3/3 against actual packages and scores18/18.

Three independent blind Boolean-name answers each choose muted for Channel and lane:6 observations from3 answers, not6 independent agents. Conditioned historical typed guesses are kept separate. The streaming recorder variants each compile3/3 and score18/18; adopt record({ onChunk }) by the preregistered smaller-public-surface tie rule. Page LOC differences are confounded by UI/storage choices. Remove the old stream entry pair; capture owns serial bounded delivery and drain-before-rejection, while storage finalization remains app-owned. The repaired real consumer retains its frozen12/12 checks×3.

G1 confirms15 repaired findings and2 intended behaviors. Owned watchers outlive the creating effect, command reads stay untracked, state tuples publish in one batch, isolated observer errors stay observable, and branch retirement follows native audio time. The first offline-suspend shaper repair failed composition with a caller's later reservation; reject it and use fixed native handover arms. Full runtime verification is1901/1901,0skip,19 typecheck projects and11 DAW smokes. Browser-only evidence is Chromium; port-level host MIDI evidence and actual plug-in smoke have distinct scopes.

The final functional source audit caught errors that blind graders passed: optional span.dropouts read without a guard, a complete media peak summary nested inside a Float32Array field, and loop-local punch bounds passed as global beats. Correct the reachable reference examples and metadata schema, keep runtime/types unchanged, and rerun only cases34/76 with old answers reused for grading. Common raw results15/18→18/18 and11/15→15/15; the first old score is17/18 under an explicit optional-read clarification, because ignoring optional metadata cannot dereference it. Two original generated long-take controllers run native capture/OPFS/save/reopen/waveform; all three new punch main modules compile, and their original punch bodies pass six native timing/PCM checks with a capture-port double. Neither result claims three complete hardware/UI apps.

Method whitelists also rejected valid native input routing and a documented post-fader meter tap. Keep original grades and separate public type/PCM-backed adjudication; wrong/missing connections and disconnect-all remain failing controls. The initial recorder total is74/84→75/84; an earlier Root78/84 tally was an arithmetic mistake, preserved with a source-file correction. These results support source/PCM inspection alongside grading, not treating every numerical increase as API improvement. The existing Clock start({ atBeat }) form still needs the recorded stage9 canonical-API audit. Full same-backend baseline, DAW and final skill slimming remain pending.

Evidence: development-tree blueprints/probes/affordance-automation-clock/verification-final-prep and blueprints/thoughts/2026-11-22-G1-repair-report.md. The initial117 paired functional sources and6 replacements were all read; the accepted set combines111 unchanged initial sources and6 replacements. No identical-input solver rerolls. Current work uses Codex with no fast override; native USD is unknown and historical Claude spending stays separate.
