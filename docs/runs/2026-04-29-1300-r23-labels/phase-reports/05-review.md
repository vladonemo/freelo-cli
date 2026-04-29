# Phase 5 — Self-review (R23 labels)

**Run:** 2026-04-29-1300-r23-labels

## Pass

- **Spec adherence**: every section of spec 0035 §3-§5 is implemented. The
  five envelope schemas match §5 verbatim. Verb decisions (rename POST,
  detach POST) implemented; deferred surface (`--project` filter on list,
  id-mode on attach, name-mode on detach) is left explicitly absent.
- **Roadmap reconciliation**: three OpenAPI-vs-roadmap discrepancies are
  documented in the changeset and the spec's §2.1.
- **Style consistency**: every leaf mirrors its closest precedent
  (`reports/list.ts`, `reports/edit.ts`, `tasks/delete.ts`, `reports/log.ts`)
  to within naming/noun substitution. The parent `commands/labels.ts`
  mirrors `commands/reports.ts`.
- **Idempotency**: two-arm matrix on `delete` and `detach` is symmetric
  with the four-arm matrix on `reports delete`, with the absent arms
  documented (no `400 + "not found"` path on the project-labels endpoint;
  no `UserCannotDelete*` ACL marker).
- **No `--already_in_target_state` on attach**: server hides the signal,
  CLI omits the field rather than emit a guess. Documented in
  `docs/commands/labels-attach.md` and the changeset.
- **Confirmation copy on delete**: includes "GLOBALLY (across all
  projects)" as required by decision 10. Verified by an explicit test row.
- **Agent-safe contract**: `--dry-run` on every write; `--ids` / `--stdin`
  byte-compat with prior delete commands; non-TTY without `--yes` →
  `CONFIRMATION_REQUIRED` exit 2.
- **Lint, typecheck, build** all pass on the working tree.

## One CLI-surface deviation from spec — decision 11

- The spec's `--color <hex>` flag on `rename` and `attach` collides with
  the CLI's global `--color <mode>` flag. Renamed the subcommand flag to
  `--hex <color>` to disambiguate. Wire body field is unchanged. Recorded
  in `decisions/11-color-flag-collision.md`. Same precedent type as the
  R20.5 / R12.5 deferrals — the CLI surface and the spec text drift, and
  the CLI surface wins.

## Defer / follow-up notes

- `labels list --project <id>` filter — tracked as future R23.5 (no
  documented API surface today).
- `labels attach` id-mode body — out of v1 scope.
- `labels detach` data-mode (by name) — out of v1 scope (server-side
  ambiguity when caller has multiple labels with same name in different
  is-private states).
- Batch input on `labels rename` — out of v1; rich NDJSON shape can land
  with R23.5.

## Blocking findings

None.

## Security review

Triage marked `needsSecurityReview: false`. No new auth surface, no new
HTTP defaults, no new dependency, no new persistent storage. The
`security-auditor` agent is not invoked.
