---
name: ar-dogfood
description: Audiorective repo only — send a fresh subagent that knows nothing but a brief and the `audiorective` consumer skill to build a real page from scratch, and evaluate the toolkit by its friction log. Use after an API or skill change, before a release, after adding a component, or to compare conditions (no toolkit / old / new). Not for trying a feature by hand yourself (`shape:dogfood`).
---

# Fresh-agent dogfood

The **fresh agent** is the measuring instrument: it has never seen the change, the earlier logs or the conversation, so its friction is what a new user's agent will hit. The page it builds is practice and is never committed; the **friction log** is the product.

## Steps

1. **Brief.** Copy [brief-template.md](brief-template.md) to `blueprints/dogfood/<date>-<name>/brief.md` and fill it in: what the page must do in user terms (never API names), a headless contract if results must be checked by code, and acceptance. Reuse an earlier brief unchanged when comparing rounds.
2. **Workspace.** Create a git worktree on a `trial/<name>` branch from the commit under test, outside the main checkout (e.g. `../audiorective-fresh-consumers/<name>`).
3. **Dispatch.** Start a new subagent (never yourself or a forked context) with: the brief path; the worktree; build commands (`pnpm install`, `pnpm -r --filter "./packages/*" run build`); a unique dev-server port and `AGENT_BROWSER_SESSION`; and these rules —
   - start from `skills/audiorective/SKILL.md` and follow its routing; reading package source, `dist/*.d.ts` or tests is allowed but each read is a friction row (which question, which file);
   - read nothing in `blueprints/` except the brief and its own log, and no other demo's implementation;
   - modify nothing under `packages/`, `docs/`, `skills/`; work around gaps in page code;
   - commit nothing; copy page sources to `<log folder>/practice-page/`; screenshots to `<log folder>/shots/` (real `agent-browser click`; absolute paths; `astro dev stop`, not `pkill`).
4. **Collect.** Done when the log has one row per friction (`step | what happened | evidence | attribution`), notably smooth parts, a list of every skill/reference file opened and whether it answered, source reads, and the acceptance results with real command output.
5. **Compare.** Set the log beside the previous round on the same brief: which frictions disappeared, which persist, which are new. Attribute each to API design, docs, skill routing, platform, agent misuse or harness. API-shape frictions go to `ar-affordance`; docs/routing ones to `ar-eval`.
6. **Clean up.** After copying the practice page, remove the worktree and delete the `trial/*` branch.

## Three-way comparison

To judge whether the toolkit helps at all, run the same brief under three conditions in parallel worktrees: no toolkit (raw Web Audio, no repo docs), the old commit, the new commit — plus a fourth agent that writes a hidden acceptance suite against the brief's contract without seeing any implementation (validated on its own reference implementation with mutation checks). Run the identical suite in all three worktrees and compare correctness, time, tokens, tool calls and lines of code.
