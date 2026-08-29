# Phase reports — 2026-08-29-2050-m06-task-labels-merge

Consolidated into one file rather than one per phase, to stay inside the 25-file budget cap while
keeping the full audit trail. Decisions live in `docs/decisions/2026-08-29-2050-*` (7 of them); the
spec is `docs/specs/0068-m06-task-labels-merge.md`.

---

## Phase 1 — Triage

Tier **Yellow**, on this slice's own signals. Full reasoning in `../triage.md`, including why Green
was unreachable under the rulebook and wrong on the merits.

Route flags: `needsSecurityReview: true` (scoped to the fail-closed confirmation boundary and
secret handling in the new error-rewrite path), `requiresFreeloApi: true`, `allowNetwork: false`,
`preApprovedDeps: []`, `autoShip: false`.

---

## Phase 2 — Spec (contract verification first)

Every roadmap claim was re-derived from `docs/api/freelo-api.yaml` before any design work, per the
instruction to treat the notes as hypotheses. All four behaviour claims hold; two carry nuance the
roadmap did not have; one roadmap statement was corrected outright.

| Claim | Verdict |
|---|---|
| POST /task-labels/merge, `{ from_uuids[], to_uuid }`, both required | confirmed (yaml :2936-2973) |
| Non-owned label answers 404, not 403 | confirmed, and declared by this endpoint's own prose (yaml :2947) even though its responses map lists only 200 |
| Commander-only replacement scope | confirmed verbatim (yaml :2948) |
| Target name/colour taken from to_uuid | confirmed (yaml :2951) |
| Source definitions survive | confirmed (yaml :2952) |
| "a follow-up task-labels delete would be needed" | corrected — no such endpoint exists (decision 7) |

Additional finding not in the requirement: `GET /task-labels/find-available` returns labels usable
across owned AND invited projects (yaml :2847), so `find` is a superset of "labels you own" and can
list a label merge will still 404 on. This changed the wording of the not-found hint (decision 5).

Design questions resolved as decisions 1 and 2 (envelope honesty), 3 (batch surfaces) and 5 (the
find hint). Decisions 4, 6 and 7 came out of the contract read rather than the question list.

No open questions, so no pause.

---

## Phase 3 — Plan

Ten files (spec section Plan). No new dependencies. Single landable slice.

---

## Phase 4 — Implement

Created `src/commands/task-labels/merge.ts` and `src/ui/human/task-labels-merge.ts`; modified
`src/api/task-labels.ts`, `src/api/schemas/task-label.ts`, `src/commands/task-labels.ts`.

`pnpm typecheck` and `pnpm lint` both passed on the first attempt — zero implement retries.

Two doc-comment corrections made in passing in `src/api/task-labels.ts`: the header said "Four
endpoints" while listing five, and claimed every endpoint takes a labels array, which merge
falsifies.

---

## Phase 5 — Test

`test/commands/task-labels/merge.test.ts` — 37 tests, all green. Six MSW factories added to
`taskLabelsHandlers`.

The weighting is deliberate: 10 validation tests and 4 confirmation-gate tests against 5
happy-path tests, because the gate and the input rules are what make an irreversible bulk write
safe.

Calibration compliance:

- Section 2 — every error path with a spec'd exit code asserts it: ValidationError (2) x10,
  ConfirmationError (2) x2, FreeloApiError 401 (3) / 403 (4) / 404 (4) / 500 (4),
  RateLimitedError (6), NetworkError (5).
- Section 7 — all three TTY-prompt tests save and delete `process.env['CI']`, restoring in
  `finally`. Prompt copy is additionally asserted at helper level (`mergeConfirmMessage` unit
  tests) where `isInteractive()` never applies, which is section 7's preferred form.
- Repo caution — wire-body assertions read captured content (`mergeOkCapturing`), never a request
  count.
- Cold start — `beforeAll` imports the CLI once with a 60 s timeout, mirroring
  `test/commands/taskchecks/harness.ts` `warmUpCli`.

Two corrections during the run, both to my spec rather than to the code: RateLimitedError and
NetworkError exit codes were inverted in the spec table (they are 6 and 5, not 5 and 6). Caught by
the first test run and fixed in both places. That is exactly the class of thing calibration
section 2 exists to catch.

Coverage on the new files, measured on the task-labels subset:

```
src/commands/task-labels/merge.ts   97.52 lines | 89.09 branches | 100 funcs
src/ui/human/task-labels-merge.ts     100      |    100         | 100
src/api/schemas/task-label.ts         100      |    100         | 100
```

All above the `src/commands/**` thresholds (90 lines / 85 branches / 90 functions). The remaining
uncovered lines are the `resolveYesFlag` unreachable-root fallback (defensive, matches
`files/delete.ts`). The empty-from branch was uncovered on the first pass and got a test rather
than a waiver.

Retries used: 1 of 8.

---

## Phase 6 — Review

Self-review against `.claude/docs/sdlc.md` Phase 5. No blocking findings.

- No `any`; the wire response is validated by the existing SuccessResponseSchema.
- No bare `throw new Error` — ValidationError, ConfirmationError and FreeloApiError only, each
  carrying code / exitCode / retryable / hintNext.
- Data path routes through `src/ui/envelope.ts` (buildEnvelope) on the live path and the same
  Envelope type on the dry-run path, matching M01/M07.
- Agent-safe write: `--dry-run` present and reaching neither network nor credential store; batch
  input via the repeatable, comma-splitting `--from` (decision 3, deviation logged); non-TTY
  confirmation-required error present and tested.
- No idempotency absorption — deliberate, documented, pinned by a regression test (decision 4).
- Lazy human deps: the human renderer is a pure string builder with no cli-table3 or chalk import,
  so the static import costs the agent cold path nothing. The prompt stays behind the existing lazy
  import in `src/lib/confirm.ts`.
- Schema stability: `freelo.task_labels.merge/v1` is new; nothing existing was touched.
- Help text present; `--introspect` enumerates the command with destructive true (tested).
- Changeset added, with the new schema and the two contract limits called out.
- No secrets in fixtures.

---

## Phase 7 — Security review

Scoped per the triage route flag. No Critical, High or Medium findings.

1. Fail-closed confirmation. Non-TTY without `--yes` throws before credential resolution and before
   any wire call. Verified by a test that registers no MSW handler — with onUnhandledRequest set to
   error, any request would fail the test. Same for the TTY-decline path.
2. `--dry-run` is credential-free: it returns before buildClient, so a preview never reads the
   keychain or env credentials.
3. No secret leakage in the new error path. rewriteMergeError passes rawBody back through the
   FreeloApiError constructor, which scrubs it; hint_next is a static string; no uuid or token is
   logged.
4. No new dependencies, no `src/config/` change, no auth-flow change, no HTTP-client default change.
5. Blast-radius containment is client-side where the contract is silent — the self-merge rejection
   (decision 6) means an undefined destructive operation is never sent.

---

## Phase 8 — Document

`docs/commands/task-labels-merge.md` created, leading with the destructiveness warning and giving
the two invisible contract limits their own section, since neither is discoverable from the
response. Cross-link added from `task-labels-find.md`. `README.md` autogen block regenerated with
`pnpm fix:readme`; `pnpm check:readme` passes. Roadmap M06 marked shipped with the contract
corrections and the open follow-up.
