# Triage — R06 tasklists show

**Run:** 2026-04-26-1946-r06-tasklists-show
**Tier:** Yellow

## Rationale

Triggers (Yellow per `.claude/docs/autonomous-sdlc.md`):

- New user-visible command (`freelo tasklists show <id>`).
- New envelope schema `freelo.tasklists.show/v1` (additive — no other schema touched).
- Changeset bump = `minor`.
- No auth, config, HTTP-client-defaults, or release-tooling change.
- No new runtime dependencies.
- No breaking change to envelope schemas, exit codes, or flag names.
- No security-sensitive surface (no secret storage, no HTTP defaults).

Excluded from Green: introduces a new public flag (`--with`) and a new public envelope schema, both of which are flagged in `autonomous-sdlc.md` §Risk-tiers as Yellow triggers.

Excluded from Red: no `src/config/` / auth-flow / HTTP-defaults touch, no breaking change, no Critical security concern, scope is precise.

## Route flags

- `needsSecurityReview`: **false** — no auth / HTTP-defaults / secret-storage changes. Read-only command on top of the R01 client.
- `requiresFreeloApi`: **true** — both endpoints (`GET /tasklist/{id}`, `GET /project/{pid}/tasklist/{tid}/assignable-workers`) are documented in `docs/api/freelo-api.yaml` (lines 1264-1288 and 1235-1262 respectively). API-specialist research dispatched in parallel with architect to lock down two non-obvious facts:
  1. `/tasklist/{id}` returns a `TasklistDetail` (OpenAPI :5092-5126) carrying a top-level `project_id` field — confirmed available for the second call without a separate `--project` flag.
  2. `/assignable-workers` returns a **bare `UserBasic[]` array, NOT a paginated wrapper** (OpenAPI :1259-1262). Materially different from R04's `/project/{id}/workers` — no `normalizePaginated` plumbing required for this side-car.
- `preApprovedDeps`: `[]` — no new deps expected.

## Calibration log carry-over (binding for this run)

1. Test phase mandatory; exit-code assertions on every typed error class.
2. `ValidationError` for parser-time validation, not Commander's `InvalidArgumentError`.
3. Run gates AFTER commit on the clean committed tree.
4. Coverage threshold `src/commands/** ≥ 85% branches` enforced by branch protection.
5. CI required-status-check on `main` is active.

## Phase routing

1. Spec — architect + freelo-api-specialist (sequential here, since the API research is small and the architect needs the answer).
2. Plan — architect (append §8 to the spec).
3. Implement — implementer.
4. Test — test-writer.
5. Review — code-reviewer (skip security-auditor per `needsSecurityReview: false`).
6. Document — doc-writer (must run `pnpm fix:readme`).
7. Open PR — `gh pr create` + `gh pr merge --auto --squash`. Branch protection means auto-merge fires only on green CI.

## Pause-worthy

- API research surfaces a contradiction with R04 (e.g. `/tasklist/{id}` does NOT return `project_id`).
- Architect wants Red.
- Coverage drops below threshold; 2 retries can't restore.
- Stuck retry loop on tests (3 retries, same failure).
