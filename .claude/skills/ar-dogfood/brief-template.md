# Dogfood brief: <what is being built>

A reusable consumer-side brief. A fresh agent builds this page using only the audiorective skill and docs, and logs friction. The page is practice, never committed; the friction log is the product.

## What to build

A browser page that … (describe it as a user would: sounds, controls, behaviour, edge cases such as live edits, tempo changes, stop/cleanup, theme). Never name an audiorective API.

1. …
2. …

## Headless contract (only if results are checked by code)

Export `renderScenario(s: Scenario): Promise<{ … ; audio: AudioBuffer }>` from `<code folder>/contract.ts`, driving the same engine the page uses on an `OfflineAudioContext`. Define every field and the timing semantics a test relies on (start time, units, what counts as an event).

## Acceptance

- Typechecks and lints with the repo's settings.
- An automated check (offline render or browser test) proves: …
- Screenshots: idle and active, desktop and 768 px.

## Friction log (the real deliverable)

Append every friction to `friction-log.md` next to this brief, one row each:
`step | what happened | evidence | attribution (API design / docs / skill routing / platform / agent misuse / harness)`.
Friction includes: a doc or the skill didn't answer and you read package source (name the file); something wrong or misleading; an awkward API or a workaround; a guess; a bug you had to debug (rough tool calls). Note notably smooth parts too. List every skill/reference file you opened, why, and whether it answered. End with: rows by attribution, top 3 frictions, rough effort split.
