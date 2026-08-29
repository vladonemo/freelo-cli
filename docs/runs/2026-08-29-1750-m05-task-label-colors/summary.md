# Run summary — 2026-08-29-1750-m05-task-label-colors

**Requirement:** M05 — `freelo task-labels colors` (server-side palette), from
`docs/roadmap-migration-2026-08.md` §M05. Plus a roadmap bookkeeping fix for M02.
**Tier:** **Yellow** (triage; the roadmap guessed Green)
**Mode:** `allowNetwork: false` (MSW only), `autoShip: false`
**Base:** `main` @ `705998c`
**Branch:** `feat/task-label-colors`
**Outcome:** PR open, stopped before merge — the human takes the merge decision.

## Phases run

| Phase | Result |
| --- | --- |
| 0 Bootstrap | run dir + `requirement.md`; no sub-agent tool available, phases run inline (decision 1) |
| 1 Triage | Yellow, `feat`, `requiresFreeloApi: true`, `needsSecurityReview: false`, no new deps |
| 2 Spec | `docs/specs/0067-m05-task-label-colors.md` — contract verified against `docs/api/freelo-api.yaml` before designing |
| 3 Plan | appended to the spec; no new dependencies; 2 planned commits (3 landed) |
| 4 Implement | 5 source files, zero typecheck/lint retries |
| 5 Test | 3 test files (1 new, 2 extended); 1 retry to fix assertions against the wrong stream and the wrong introspect key |
| 6 Review | self-review (no independent reviewer available — see Limitations) |
| 7 Document | `docs/commands/task-labels-colors.md`, README autogen block, changeset, roadmap |

Security review **not** triggered: no `src/config/`, no auth flow, no `src/api/client.ts`, no new
dependency, no secret handling, read-only endpoint.

## Why Yellow and not the Green the roadmap guessed

Three Yellow triggers from `autonomous-sdlc.md` §Risk tiers fire independently: a **new
user-visible command**, a **new envelope schema** (`freelo.task_labels.colors/v1`), and a **`minor`
changeset**. Highest tier wins. This is the same correction the roadmap already recorded for M04 at
line 123 — read-only-ness keeps a slice out of Red, it does not pull it down to Green.

The consequence is load-bearing: Green auto-merges, Yellow stops at an open PR. **No merge was made
autonomously.**

## The design decision

**Alongside, not replace.** The hardcoded `PALETTE` in `src/lib/label-color.ts` remains the sole,
offline validator for `--palette`. Decided on contract evidence, not on the roadmap's
recommendation — the decisive fact is that `TaskLabelColor.display_name` is documented "for display
only; **not accepted as input**" (`docs/api/freelo-api.yaml` :5968), so the server publishes no name
vocabulary a client could adopt. Full argument in spec 0067 §6 and decision 2.

Beyond the slice as written, the envelope carries a `drift` object so the roadmap's stated outcome
("the CLI stops silently drifting") is scriptable rather than dependent on a human comparing two
nine-row tables by eye. Drift is data: exit is 0 either way (decision 3).

## Three contract findings the requirement did not carry

1. The response is `{ colors: TaskLabelColor[] }` with **three** fields per entry — `color`,
   `display_name`, `is_default` — not the "name + hex, if the response provides names" the
   requirement hedged on. Not paginated, takes no parameters.
2. `display_name` is **not accepted as input**. This settles the central design question.
3. The wire sends **lowercase** hex (`#15acc0`); `PALETTE` stores **uppercase** (`#15ACC0`). A
   case-sensitive comparison would have reported all nine colours as drift against a perfectly
   current server (decision 5).

## Decisions made autonomously

1. Orchestrator executes phases inline (no sub-agent tool available)
2. The hardcoded PALETTE stays authoritative; `colors` ships alongside it
3. Drift is reported as data, not as a non-zero exit code
4. Envelope carries `palette_name` as a field distinct from the wire's `display_name`
5. Hex comparison is case-insensitive in both directions

Files: `docs/decisions/2026-08-29-1750-m05-task-label-colors-*.md`.

## Budget

| Resource | Cap | Used |
| --- | --- | --- |
| Wall clock | 30 min | **overrun** — dominated by full `test:cov` runs at ~13 min each |
| Agent invocations | 40 | 0 sub-agents (none available); phases run inline |
| Phase retries | 8 | 1 (test assertions) |
| Files touched | 25 | 24 |

The wall-clock overrun is logged rather than treated as grounds to shortcut the calibration §3 gate
run, per the run brief. M03 decision 7 already argues the 30-minute default is mis-calibrated for
this repo; a single full-suite run costs ~13 minutes on this machine, so any run that executes the
gate honestly exceeds the cap before it starts.

## Limitations — what was not verified

- **No independent code review or security audit.** Phase 5 was a self-review by the same context
  that wrote the code. Weaker than the process intends; called out here rather than papered over.
- **No real API call.** `allowNetwork: false`. The local palette table has still never been compared
  against production — running `freelo task-labels colors` against a real account is the one-command
  way to find out, and needs no code change.
- **No local aggregate coverage number.** `test:cov` bails before the coverage table when any test
  fails, and this machine has a documented set of load-dependent failures. Per-file coverage for the
  new code was measured on a targeted run instead. CI enforces the aggregate.
