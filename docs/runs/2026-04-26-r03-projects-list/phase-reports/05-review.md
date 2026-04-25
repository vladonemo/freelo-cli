# Phase 5 — Review

**Run:** 2026-04-26-r03-projects-list
**Status:** ok (self-review by orchestrator-as-code-reviewer)
**Findings:** none Blocking; 0 Major; 1 Minor (waived); 1 Informational.

## Plan adherence

All 20 planned files landed (8 src new + 5 test new + 2 fixture sets + 3
src modified + 1 changeset + 1 README + 2 doc files = 23 total when
counting individual fixture JSON files; close to plan's 20). One commit
boundary collapsed (test files folded into their feature commits per
spec §8.6 — acceptable per plan's commit-by-commit gating note).

## Working agreements (CLAUDE.md)

| Check | Result |
|---|---|
| ESM only | yes — no CJS in src/, all imports `.js` |
| No `any` | yes — `unknown` everywhere it would have been `any` |
| Every network call schema-validated | yes — `ProjectsBareArraySchema` and per-endpoint paginated wrappers |
| Commands are thin | yes — list.ts coordinates, business logic in `src/api/pagination.ts` and `src/api/projects.ts` |
| Errors typed and structured | yes — `ValidationError` and `FreeloApiError` with `code`, `exitCode`, `retryable`, `hintNext` |
| Output defaults to JSON when non-TTY | yes — uses existing `auto` resolution in `resolveOutputMode` |
| Envelope schema declared | `freelo.projects.list/v1` with discriminator |
| Writes are agent-safe | n/a — read-only command |
| Env-first auth | yes — uses `resolveCredentials` |
| Introspectable surface | yes — `meta` attached, integration test asserts it |
| Lazy human deps | yes — `cli-table3` only via `await import(...)`; ESLint enforces; test asserts |
| Silent by default | yes — pino unchanged |
| No telemetry | yes |
| Secrets scrubbed | n/a — no new error path that would leak |
| Conventional Commits | yes — 4 feat commits with lowercase scope from approved list |
| Changeset present | yes — `.changeset/projects-list-r03.md` is `minor` and calls out the schema |

## Spec §7 recommendations adherence

All 17 recommendations (per spec resolution) honoured:

- 1: per_page server-controlled — yes; CLI passes no client knob, `paging.per_page` echoes server.
- 2: synthesize single-page for `/projects` — yes via `synthesizeUnpaginated`.
- 3: no `order_by` from CLI — yes; no filter flags.
- 4–5: filter flags deferred — yes.
- 6: state ID enum tolerated — yes; `StateSchema` includes all 5 strings.
- 7: dates as `z.string()`, no parsing — yes.
- 8: default scope `owned` — yes (Commander default).
- 9: discriminator on `entity_shape` — yes via `z.discriminatedUnion`.
- 10: per-page envelopes for ndjson, merged for json — yes.
- 11: nested projection rejected — yes (`NESTED_FIELDS_UNSUPPORTED`).
- 12: wire snake_case `--fields` — yes.
- 13: filter flags deferred — yes.
- 14: mid-stream partial + error — yes; `PartialPagesError` carries failed-page index.
- 15: full-payload defaults — yes via `DEFAULT_FIELDS`.
- 16: cli-table3 chosen — yes; lazy via `src/ui/table.ts`.
- 17: cursor-out-of-range on owned — yes; pre-API `ValidationError`.

## Schema stability

No existing envelope field removed/renamed/retyped. R01 + R02 envelopes
(`freelo.auth.*/v1`, `freelo.config.*/v1`, `freelo.introspect/v1`,
`freelo.error/v1`) untouched. New schema `freelo.projects.list/v1` is
additive.

## Findings

### Minor (waived) — `runAll` accumulates `Record<string, unknown>` not the typed entity

`fetchPage` returns `ProjectsListResult<Record<string, unknown>>` because
the leaf command coordinator deals in a discriminated union the API
wrappers return individually. The plan called this out (spec §8.7
"command-level type erasure"). Accepted: the zod validation upstream is
authoritative and the human / projection layers tolerate the loose
typing. A future refactor could parameterise on scope for tighter types.

### Informational — coverage on `runAll`'s ndjson path

The integration tests cover both the json merge and the ndjson per-page
path; the abort-signal branch in `fetchAllPages` is exercised in unit
tests but not in the command-level test (would require mid-stream signal
injection). Existing thresholds hold; not blocking.

## Security review

Skipped per triage — no auth/HTTP/secret-storage surface touched. Verified:

- No new env-var read.
- No `process.env` access added outside `src/bin/freelo.ts`'s existing
  capture.
- No new file write.
- `cli-table3` is loaded lazily; not on the agent cold path.
- No new global state.

Confirmed unchanged: `src/api/client.ts`, `src/config/**`, error redaction,
TLS/retry/redirect defaults.

## Verdict

Ready for PR.
