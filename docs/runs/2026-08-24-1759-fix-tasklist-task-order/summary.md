# Run summary — 2026-08-24-1759-fix-tasklist-task-order

**Requirement:** issue [#108](https://github.com/vladonemo/freelo-cli/issues/108) — `tasks list`
scoped to one project + tasklist returns tasks in creation order instead of the tasklist's manual /
drag-and-drop board order.
**Tier:** Red (two triggers: the cached OpenAPI contract contradicted the field report, and the
change alters the default observable behavior of an already-released command).
**Outcome:** **PR open, awaiting human review** — https://github.com/vladonemo/freelo-cli/pull/110
**Branch:** `fix/tasklist-task-order` → commit `190eb5f`
**Spec:** `docs/specs/0060-tasklist-task-order.md` (plan appended, checkboxes closed)

## Phases

| # | Phase | Result |
|---|---|---|
| 1 | Triage | Red, `fix`, `allowNetwork: false`, `needsSecurityReview: false`, no new deps |
| 2 | Spec | `0060` — four live hypotheses, three blocking open questions |
| 3 | Plan | Slices 0-3 recorded, every one gated on the §11 resolution |
| 4 | Implement | **Paused** at the gate before any source edit — would have required guessing API behavior |
| — | *(resume)* | Human answered **A**: granted a dedicated test account; live check run out-of-band; all three OQs closed |
| 4b | Implement | `src/api/tasks.ts` + `docs/api/freelo-api.yaml`. 1 retry (lint) |
| 5 | Test | `test/commands/tasks/list.test.ts` — 3 new, 2 extended. 0 retries |
| 6 | Review | No Blocking findings; 3 Informational. Security review not triggered |
| 7 | Document | `docs/commands/tasks-list.md` + changeset (`patch`) |
| 8 | Commit / push / PR | `190eb5f`, PR #110 |
| 9 | Risk gate | Red → **stop**. No auto-merge, no `--auto` flag set |
| 10 | Ship | Not run (`autonomous.autoShip` is false) |

## The decision that mattered

The run paused rather than ship a plausible guess. `freelo-api.yaml` documented `default: priority`
for this endpoint but never said what `priority` sorted by, and Freelo uses the same word for the
unrelated L/M/H `priority_enum` on a task — so the "obvious" fix could have replaced one wrong order
with a different wrong order and closed #108 falsely. One live drag-reorder test settled it:
`priority` is board order. That turned a determinism hedge into a correctness fix and let the
changeset say *fixes #108* honestly.

## Decisions logged

1. `...-1-red-tier-proceed-to-plan.md` — Red tier, but pause at the implement gate, not at intake
2. `...-2-no-speculative-artifacts.md` — write no fixture/handler encoding an unverified hypothesis
3. `...-3-envelope-echo-escalated.md` — escalate the `applied_filters` question rather than decide it
4. `...-4-envelope-user-only-and-partial-supply.md` — §8b (envelope unchanged) + partial supply
   injects nothing
5. `...-5-yaml-annotate-not-correct.md` — annotate the OpenAPI `order_by`, don't "correct" a value
   the experiment confirmed

## Changed files (9 tracked + run artifacts)

`src/api/tasks.ts` · `test/commands/tasks/list.test.ts` · `docs/api/freelo-api.yaml` ·
`docs/commands/tasks-list.md` · `.changeset/empty-hoops-return.md` · `docs/specs/0060-*.md` ·
2 decision records · 4 phase reports.

## Gates

`typecheck` · `lint` · `build` · `check:readme` · `format:check` (for every touched file) — all pass
on the committed tree. `test/commands/tasks/list.test.ts` 46/46.

Full-suite `pnpm test:cov` is red locally with 11 pre-existing, load-induced failures — identical in
count and shape to the docs-only baseline recorded in `pause.md`, on a source tree CI was green on.
Detail in `phase-reports/06-review.md` §Gates. CI on the PR is the authority — and **all 7 checks
passed** on PR #110 (`pnpm test:cov` green on Node 22/24 across ubuntu, macos and windows, so the
coverage thresholds are met too). That settles it: the local failures are this machine, not this
change.

## Carried forward for a human

1. **`/all-tasks` routing fallthrough** (spec §12.1, review Informational 3) — adding any filter to
   the fixed command silently reroutes to an endpoint with no board-order concept. Plausibly the
   real mechanism behind #108. Out of scope by instruction; needs a product decision.
2. **Local test flakiness** — worth its own issue if it reproduces on an idle machine.
3. **Upstream** — the `priority` / `priority_enum` name collision and the absence of any
   reorder-within-tasklist endpoint are still worth raising with Freelo.

## Run mechanics

The resumed session had no sub-agent dispatch tool available, so the orchestrator executed each
remaining phase inline against the corresponding agent's checklist (`implementer`, `test-writer`,
`code-reviewer`, `doc-writer`) rather than delegating. Phase gates, decision logging, and the
artifact set are unchanged; the delegation boundary is the only thing that differs from a normal
run, and it is recorded here so the audit trail isn't misread. Per calibration entry #1, no
remaining phase was skipped. `allowNetwork` was `false` for the entire resumed session — the single
live request was made before it, by the coordinating session, under explicit human grant.
