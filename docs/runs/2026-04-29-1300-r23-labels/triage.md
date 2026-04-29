# Triage — R23 `freelo labels`

**Run:** 2026-04-29-1300-r23-labels
**Tier:** Yellow

## Rationale

5 new user-visible commands (`labels list`, `labels rename`, `labels delete`,
`labels attach`, `labels detach`); one destructive (`labels delete`). Additive
surface, no auth/HTTP-defaults change, no envelope-schema break.

Multiple **roadmap-vs-OpenAPI reconciliations** required (precedent: R18, R20):

1. **`labels rename` verb is POST**, not PATCH (yaml :862). Roadmap line listed
   PATCH; OpenAPI is authoritative. Ship POST. Same precedent as R18 `comments
   edit` and R20 `time edit`.
2. **`labels detach` verb is POST**, not DELETE (yaml :991 — operation
   `removeProjectLabelFromProject` is `post:`). Roadmap was wrong; OpenAPI
   wins.
3. **`labels list --project <id>` filter is not implementable** from the
   documented endpoints. `GET /project-labels/find-available` returns the
   caller's globally available labels (their private + public from accessible
   projects), with **no project filter parameter** and **no per-label
   `attached_projects` field** in the response (yaml :5025). Defer the
   `--project` flag — same pattern as R20.5 (`--started-at`) and R12.5
   (`--pairs`). Ship `labels list` without `--project` in v1; track follow-up
   slice R23.5 if/when an API surface materializes.

## Route flags

- `needsSecurityReview`: false (no auth/config touch; no new dep; standard write surface)
- `requiresFreeloApi`: false (OpenAPI is sufficient for the four shipped
  endpoints; the deferred `--project` filter is what would have triggered it)
- `preApprovedDeps`: [] (no new deps expected)

## Risks (handled in spec)

- **`attach` fetch-or-create semantics** — body has `name` + `is_private` +
  optional `color` (data-mode). Server returns success + dedupes by
  (owner, name, is_private). One POST per name; `--name <str>...` repeating
  fans out to N calls.
- **Idempotency on `attach`** — yaml :952 says attaching an
  already-attached label swallows `UniqueConstraintViolationException` and
  returns 200. So `already_in_target_state` is server-implicit; CLI has no
  reliable signal to set the envelope flag. Document this in spec §10
  (decision required: emit `already_in_target_state: false` always, or omit
  the field for `attach`).
- **`detach` 404 = idempotent** (yaml :1005 — `NotFoundException` when label
  is not attached). Mirror the R22 `reports delete` four-arm heuristic
  (404 → `already_in_target_state: true`).
- **`labels delete` is GLOBAL hard delete** (yaml :917). User-facing copy
  must call this out; recommend confirmation message says "delete this
  label across **all** projects".
- **Color validation**: server pattern is `^#[0-9a-fA-F]{6}$` (yaml :895).
  CLI validates client-side and rejects with `ValidationError` (exit 2)
  before wire.

## Slice-vs-split decision

Roadmap line is one slice with 5 commands. R22 just shipped 3 commands at
once successfully (~1700 LOC across 19 files). R23 should fit similar size:

| Command | Pattern reuse | Est. LOC |
|---|---|---|
| `labels list` | mirror `reports list` (no pagination here — flat array) | ~150 |
| `labels rename` | mirror `time edit` (POST + empty-edit rule) | ~250 |
| `labels delete` | mirror `tasks delete` (idempotency + confirm) | ~350 |
| `labels attach` | new pattern: `--name` fan-out × 1-call-per-name | ~300 |
| `labels detach` | mirror `reports delete` minus confirm + idempotent 404 | ~250 |

Total ~1300 LOC + tests + docs. **Within budget.** Ship as one slice. If
implementation runs over budget, split at the boundary `read+rename` (R23a)
vs. `delete+attach+detach` (R23b) — decide during plan, not implement.

## Hard rules acknowledged

- Branch from `main` @ e8abf40.
- No `--ship`. Stop after PR open.
- Run gates on **committed** tree.
- Every typed-error path → exit-code assertion test (Calibration #2).
- New `try/catch` across 3+ files → coverage for each catch arm
  (Calibration #4).
- Don't guess API behavior — `--project` deferred not invented.
