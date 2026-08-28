# Review — 2026-08-28-2039-files-delete

**Reviewer:** orchestrator executing the `code-reviewer` mandate inline (sub-agent delegation
unavailable this session — decision 1). **This is a self-review, not an independent one**; weight it
accordingly and lean on the human PR review.

**Verdict:** no Blocking findings outstanding. One Blocking finding was raised and fixed during review
(finding 1). Security auditor **not** invoked — triage set `needsSecurityReview: false` and the diff
touches neither `src/config/` nor auth flows.

## Checklist (`.claude/docs/sdlc.md` §Phase 5)

| Check | Result |
| --- | --- |
| Plan adherence | Pass. Every file in the plan's §9.1/§9.2 tables was created/modified; nothing outside them was touched. |
| No `any` | Pass. `unknown` at boundaries, narrowed via `instanceof` / typeof guards. |
| No un-validated API responses | Pass. `SuccessResponseSchema` parses the 200 body defensively (never surfaced — the endpoint declares no useful 200 fields). |
| No bare `throw new Error` | Pass. `ValidationError` and `FreeloApiError` only; `toBaseError` coerces stray throws. |
| Agent-first output | Pass. `schema: 'freelo.files.delete/v1'` declared via `buildEnvelope`; non-TTY defaults to json; one envelope per item on stdout. |
| Structured errors | Pass. `code` / `exitCode` / `retryable` / `hintNext` all carried; the 404 rewrite preserves every one of them plus `errors[]`, `httpStatus`, `requestId`. |
| Writes are agent-safe | Pass. `--dry-run`, `--ids`, `--stdin`, repeatable positional; non-TTY without `--yes` fails closed with `CONFIRMATION_REQUIRED` exit 2 before any credential resolution. Idempotency path deliberately absent — decision 3, documented in code, spec, docs and changeset. |
| Lazy human deps | Pass. No static import of `@inquirer/prompts` / `ora` / `boxen` / `cli-table3` / `chalk`; the prompt is reached only through `src/lib/confirm.ts`'s existing `await import(...)`. |
| Schema stability | Pass. `freelo.files.delete/v1` is new; no existing envelope field removed, renamed or retyped. Called out in the changeset. |
| Help text + `--introspect` | Pass. Description names all three non-obvious behaviors (both resource kinds, soft-delete, 404-is-an-error). Introspect entry asserted by test. |
| Changeset entry | Pass — `minor`, with the schema addition and the 404 policy called out explicitly. |
| No secrets in fixtures | Pass. Only `sk-test` / `agent@example.cz` placeholders, consistent with sibling suites. |
| Calibration §2 (exit codes) | Pass. Rows asserting exit 2 (`ValidationError`, `ConfirmationError`), 3 (`AUTH_EXPIRED`), 4 (`NOT_FOUND`, `FORBIDDEN`, 5xx), plus `RATE_LIMITED` and `NETWORK_ERROR`. |
| Calibration §4 (new catch arms) | Pass. `rewriteDeleteFileError`'s 404 branch and its pass-through branch, plus both batch per-item catches, each have a dedicated test. |
| Calibration §7 (TTY tests clear `CI`) | Pass. All four TTY-prompt tests save/`delete`/restore `process.env.CI`. |

## Findings

### 1. Blocking (fixed during review) — a test's name claimed something it did not test

`test/commands/files/delete.test.ts` had a row named "deleting the same uuid twice reports the second as
an error (§5.4)" that actually passed **two different** UUIDs. Spec §5.4, the docs page, and the
changeset all assert the no-de-duplication behavior, so it was documented but unproven — exactly the
kind of gap that turns into a regression later.

Fixing it surfaced something more interesting (decision 6): the replacement test asserted two wire
requests and observed four. Investigation showed the doubling is an MSW interception artifact, present
identically on the already-shipped `comments delete` and reproducible with a bare `fetch` and no CLI code
in the path. The command issues one DELETE. The test now asserts the contract at the envelope level —
two input items produce two output envelopes, nothing collapsed — which is both robust and the thing
that actually matters.

### 2. Informational — `UUID_REGEX` now exists twice under `src/commands/files/`

Duplicated from `download.ts` deliberately (decision 4), following the codebase's own precedent of
keeping tiny input parsers local. If a third UUID-taking command appears, extract to `src/lib/` as a
refactor slice with its own tests rather than as a rider on a feature.

### 3. Informational — local full-suite runs are flaky on this machine

The full `pnpm test:cov` run showed 11 failures across 8 files, none in this slice's suite and all in
tests this diff cannot reach (`tasks list` applied_filters, `tasks move` project ids, a `tasks
description` source field). All re-ran green in isolation. The same load sensitivity made the *shipped*
M01 suite time out when run alone. Environmental, not a regression — but it means local green is weaker
evidence here than usual, and CI on the matrix is the authoritative signal.
